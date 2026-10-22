const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const logger = require('../core/logger').createServiceLogger('LLM_DEEPSEEK');
const config = require('../core/config');
const { promptLoader } = require('../../prompt-loader');

/**
 * DeepSeek chat backend — reuses the same API key configured for
 * deepseek-harness (~/.dsh/.credentials.yaml → DEEPSEEK_API_KEY).
 */
class DeepSeekLLMService {
  constructor() {
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    this.apiKey = null;
    this.baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    this.model = process.env.DEEPSEEK_MODEL || config.get('llm.deepseek.model') || 'deepseek-flash';
    this.initializeClient();
  }

  initializeClient() {
    this.apiKey = this.resolveApiKey();

    if (!this.apiKey) {
      logger.warn('DeepSeek API key not found', {
        hint: 'Set DEEPSEEK_API_KEY, or configure it in deepseek-harness (~/.dsh/.credentials.yaml)'
      });
      this.isInitialized = false;
      return;
    }

    this.isInitialized = true;
    logger.info('DeepSeek LLM client ready', {
      model: this.model,
      baseUrl: this.baseUrl,
      keySource: this._keySource
    });
  }

  resolveApiKey() {
    if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) {
      this._keySource = 'env';
      return process.env.DEEPSEEK_API_KEY.trim();
    }

    const fromDsh = this.readKeyFromDshCredentials();
    if (fromDsh) {
      this._keySource = 'dsh-credentials';
      return fromDsh;
    }

    this._keySource = 'none';
    return null;
  }

  readKeyFromDshCredentials() {
    try {
      const credPath = path.join(
        process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
        '.credentials.yaml'
      );
      if (!fs.existsSync(credPath)) return null;

      const text = fs.readFileSync(credPath, 'utf8');
      const match = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
      if (!match) return null;

      const value = match[1].trim();
      if (/^sk-/.test(value)) return value;
      return null;
    } catch (error) {
      logger.debug('Failed reading dsh credentials', { error: error.message });
      return null;
    }
  }

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null, options = {}) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure DEEPSEEK_API_KEY (same as deepseek-harness).');
    }

    const startTime = Date.now();
    this.requestCount++;
    const onDelta = typeof options.onDelta === 'function' ? options.onDelta : null;

    try {
      const messages = this.buildChatMessages(text, activeSkill, programmingLanguage, {
        intelligent: false,
        historyLimit: 15
      });
      const response = onDelta
        ? await this.chatCompletionsStream(messages, onDelta)
        : await this.chatCompletions(messages);

      logger.logPerformance('DeepSeek text processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: response.length,
        requestId: this.requestCount,
        streamed: !!onDelta
      });

      return {
        response,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          provider: 'deepseek',
          model: this.model,
          usedFallback: false,
          streamed: !!onDelta
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('DeepSeek processing failed', {
        error: error.message,
        activeSkill,
        requestId: this.requestCount
      });

      if (config.get('llm.deepseek.fallbackEnabled') !== false) {
        return this.generateFallbackResponse(text, activeSkill);
      }
      throw error;
    }
  }

  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null, options = {}) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure DEEPSEEK_API_KEY (same as deepseek-harness).');
    }

    const startTime = Date.now();
    this.requestCount++;
    const onDelta = typeof options.onDelta === 'function' ? options.onDelta : null;

    try {
      const messages = this.buildChatMessages(text, activeSkill, programmingLanguage, {
        intelligent: true,
        historyLimit: 10
      });
      const response = onDelta
        ? await this.chatCompletionsStream(messages, onDelta)
        : await this.chatCompletions(messages);

      return {
        response,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          provider: 'deepseek',
          model: this.model,
          usedFallback: false,
          isTranscriptionResponse: true,
          streamed: !!onDelta
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('DeepSeek transcription processing failed', {
        error: error.message,
        requestId: this.requestCount
      });

      if (config.get('llm.deepseek.fallbackEnabled') !== false) {
        return this.generateIntelligentFallbackResponse(text, activeSkill);
      }
      throw error;
    }
  }

  buildChatMessages(text, activeSkill, programmingLanguage, options = {}) {
    const { intelligent = false, historyLimit = 15 } = options;
    const messages = [];
    const sessionManager = require('../managers/session.manager');

    let systemPrompt = '';
    if (intelligent) {
      systemPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
      if (sessionManager?.getSkillContext) {
        const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
        if (skillContext?.skillPrompt) {
          systemPrompt = `${skillContext.skillPrompt}\n\n${systemPrompt}`;
        }
      }
    } else if (sessionManager?.getSkillContext) {
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      systemPrompt = skillContext?.skillPrompt || '';
    }

    if (!systemPrompt) {
      const components = promptLoader.getRequestComponents(
        activeSkill,
        text,
        [],
        programmingLanguage
      );
      systemPrompt = components.skillPrompt || `You are an interview assistant in ${activeSkill} mode. Answer clearly and practically.`;
    }

    messages.push({ role: 'system', content: systemPrompt });

    if (sessionManager?.getConversationHistory) {
      const history = sessionManager.getConversationHistory(historyLimit) || [];
      for (const event of history) {
        if (!event?.content || event.role === 'system') continue;
        const content = String(event.content).trim();
        if (!content) continue;
        messages.push({
          role: event.role === 'model' || event.role === 'assistant' ? 'assistant' : 'user',
          content
        });
      }
    }

    const userContent = intelligent
      ? String(text || '').trim()
      : this.formatUserMessage(text, activeSkill);

    if (!userContent) {
      throw new Error('Empty user message');
    }

    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  formatUserMessage(text, activeSkill) {
    return `Context: ${activeSkill.toUpperCase()} analysis request\n\nText to analyze:\n${text}`;
  }

  getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) {
    if (activeSkill === 'normal' || activeSkill === 'general') {
      return `# 普通语音问答

你是通用 AI 助手。用户通过语音提问，你必须用简体中文直接回答（禁止繁体字）。
像正常聊天一样回应，不要套面试模板，不要用英文固定套话。
问什么答什么；身份类问题可简短自我介绍为 Vysper 助手。`;
    }

    let prompt = `# 面试语音助手（当前技能：${activeSkill.toUpperCase()}）

你是 Vysper 面试助手，正在帮助用户准备/应对 ${activeSkill.toUpperCase()} 相关面试。
必须使用简体中文回答（禁止繁体字），简洁、可直接口述。`;

    if (programmingLanguage) {
      prompt += `\n写代码时优先使用 ${programmingLanguage.toUpperCase()}。`;
    }

    prompt += `

## 回复规则

1. **身份/元问题**（如「你是谁」「你能做什么」）：用一两句中文说明你是面试助手，当前模式是 ${activeSkill}，并邀请用户提出具体题目。
2. **寒暄**（如「你好」「在吗」）：简短中文回应，例如「在的，把 ${activeSkill} 题目说出来就行。」
3. **与 ${activeSkill} 相关的问题或追问**：给出完整、可落地的详细回答（可分点、举例）。
4. **明显无关的闲聊**：简短提醒回到 ${activeSkill}，不要用英文套话。

不要回复英文固定句 "Yeah, I'm listening..."。`;

    return prompt;
  }

  _requestUrl() {
    return new URL(
      '/chat/completions',
      this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`
    );
  }

  _requestOptions(url, bodyLength) {
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Length': bodyLength,
        Accept: 'application/json'
      },
      timeout: config.get('llm.deepseek.timeout') || 60000
    };
  }

  chatCompletions(messages) {
    const maxTokens = config.get('llm.deepseek.maxTokens') || 2048;
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: 0.7,
      max_tokens: maxTokens,
      stream: false
    });

    const url = this._requestUrl();

    return new Promise((resolve, reject) => {
      const req = https.request(
        this._requestOptions(url, Buffer.byteLength(body)),
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              if (res.statusCode < 200 || res.statusCode >= 300) {
                reject(new Error(`DeepSeek HTTP ${res.statusCode}: ${data.slice(0, 400)}`));
                return;
              }
              const parsed = JSON.parse(data);
              const text = parsed?.choices?.[0]?.message?.content;
              if (!text || !String(text).trim()) {
                reject(new Error('Empty response from DeepSeek'));
                return;
              }
              resolve(String(text).trim());
            } catch (error) {
              reject(new Error(`Failed to parse DeepSeek response: ${error.message}`));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`DeepSeek request timeout (>${config.get('llm.deepseek.timeout') || 60000}ms)`));
      });
      req.on('error', (error) => reject(error));
      req.write(body);
      req.end();
    });
  }

  /**
   * Stream chat completions (SSE). Invokes onDelta(delta, fullText) for each token.
   * Resolves with the full assembled response.
   */
  chatCompletionsStream(messages, onDelta) {
    const maxTokens = config.get('llm.deepseek.maxTokens') || 2048;
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: 0.7,
      max_tokens: maxTokens,
      stream: true
    });

    const url = this._requestUrl();

    return new Promise((resolve, reject) => {
      let fullText = '';
      let buffer = '';
      let settled = false;

      const finish = (err, text) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(text);
      };

      const req = https.request(
        {
          ...this._requestOptions(url, Buffer.byteLength(body)),
          headers: {
            ...this._requestOptions(url, Buffer.byteLength(body)).headers,
            Accept: 'text/event-stream'
          }
        },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let errBody = '';
            res.on('data', (c) => {
              errBody += c;
            });
            res.on('end', () => {
              finish(new Error(`DeepSeek HTTP ${res.statusCode}: ${errBody.slice(0, 400)}`));
            });
            return;
          }

          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buffer += chunk;
            const parts = buffer.split('\n');
            buffer = parts.pop() || '';

            for (const line of parts) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue;
              if (!trimmed.startsWith('data:')) continue;

              const payload = trimmed.slice(5).trim();
              if (payload === '[DONE]') continue;

              try {
                const parsed = JSON.parse(payload);
                const delta = parsed?.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;
                  try {
                    onDelta(delta, fullText);
                  } catch (cbErr) {
                    logger.debug('onDelta callback error', { error: cbErr.message });
                  }
                }
              } catch {
                // Incomplete JSON line — ignore
              }
            }
          });

          res.on('end', () => {
            const text = fullText.trim();
            if (!text) {
              finish(new Error('Empty streamed response from DeepSeek'));
              return;
            }
            finish(null, text);
          });

          res.on('error', (error) => finish(error));
        }
      );

      req.on('timeout', () => {
        req.destroy();
        finish(new Error(`DeepSeek stream timeout (>${config.get('llm.deepseek.timeout') || 60000}ms)`));
      });
      req.on('error', (error) => finish(error));
      req.write(body);
      req.end();
    });
  }

  generateFallbackResponse(text, activeSkill) {
    const fallbackResponses = {
      dsa: '这看起来像数据结构/算法题。先拆分问题，再选合适算法与数据结构。',
      'system-design': '系统设计题请从需求、容量、可用性、扩展性与权衡入手。',
      programming: '编程题请先确认需求与边界条件，再给出清晰实现。',
      default: 'DeepSeek 暂时不可用。请检查 DEEPSEEK_API_KEY（与 deepseek-harness 相同配置）。'
    };

    return {
      response: fallbackResponses[activeSkill] || fallbackResponses.default,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true,
        provider: 'deepseek'
      }
    };
  }

  generateIntelligentFallbackResponse(text, activeSkill) {
    const textLower = String(text || '').toLowerCase();
    const identityHints = ['你是谁', '你谁', 'who are you', '介绍一下你'];
    if (identityHints.some((x) => textLower.includes(x))) {
      return {
        response: `我是 Vysper 面试助手，当前是 ${activeSkill.toUpperCase()} 模式。把具体题目发给我即可。`,
        metadata: {
          skill: activeSkill,
          processingTime: 0,
          requestId: this.requestCount,
          usedFallback: true,
          isTranscriptionResponse: true,
          provider: 'deepseek'
        }
      };
    }

    const questionIndicators = ['how', 'what', 'why', '?', '怎么', '什么', '如何', '为什么'];
    const seemsLikeQuestion = questionIndicators.some((x) => textLower.includes(x));

    const response = seemsLikeQuestion
      ? `我这边暂时连不上 DeepSeek。听起来像是 ${activeSkill} 相关问题，请稍后再试或检查 API Key。`
      : `在的，把 ${activeSkill} 相关题目说出来就行。`;

    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true,
        isTranscriptionResponse: true,
        provider: 'deepseek'
      }
    };
  }

  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized' };
    }

    try {
      const start = Date.now();
      const response = await this.chatCompletions([
        { role: 'user', content: 'Reply with exactly: OK' }
      ]);
      return {
        success: true,
        response: response.slice(0, 50),
        latency: Date.now() - start,
        provider: 'deepseek',
        model: this.model
      };
    } catch (error) {
      return { success: false, error: error.message, provider: 'deepseek' };
    }
  }

  async checkNetworkConnectivity() {
    return {
      tests: [
        {
          name: 'DeepSeek API',
          host: new URL(this.baseUrl).hostname,
          success: this.isInitialized
        }
      ]
    };
  }

  updateApiKey(newApiKey) {
    process.env.DEEPSEEK_API_KEY = newApiKey;
    this.isInitialized = false;
    this.initializeClient();
    logger.info('DeepSeek API key updated and client reinitialized');
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate:
        this.requestCount > 0
          ? ((this.requestCount - this.errorCount) / this.requestCount) * 100
          : 0,
      provider: 'deepseek',
      model: this.model,
      keySource: this._keySource,
      config: config.get('llm.deepseek')
    };
  }
}

module.exports = new DeepSeekLLMService();
