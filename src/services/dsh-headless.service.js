/**
 * Run deepseek-harness headless agent against a workspace directory.
 * Uses: dsh --profile headless --json "<task>"
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../core/logger').createServiceLogger('DSH');

const DEFAULT_HARNESS = path.join(os.homedir(), 'PythonProjects', 'deepseek-harness');
const DEFAULT_TIMEOUT_MS = Number(process.env.DSH_TIMEOUT_MS || 5 * 60 * 1000);

class DshHeadlessService {
  constructor() {
    this.activeChild = null;
    this.sessionId = null;
    this.cancelRequested = false;
  }

  isAvailable(options = {}) {
    try {
      this.resolveLaunch(options);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Prefer explicit bin, then PATH `dsh`, then local harness build / pnpm script.
   */
  resolveLaunch(options = {}) {
    const harnessDir = options.harnessDir
      || process.env.DSH_HARNESS_DIR
      || (fs.existsSync(DEFAULT_HARNESS) ? DEFAULT_HARNESS : null);

    if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) {
      return { command: process.env.DSH_BIN, argsPrefix: [], harnessDir };
    }

    const pathDsh = this.findOnPath('dsh');
    if (pathDsh) {
      return { command: pathDsh, argsPrefix: [], harnessDir };
    }

    if (harnessDir) {
      const builtBin = path.join(harnessDir, 'apps', 'cli', 'lib', 'bin.js');
      const srcBin = path.join(harnessDir, 'apps', 'cli', 'src', 'bin.ts');
      const node = this.findOnPath('node') || process.env.NODE_BINARY || 'node';

      if (fs.existsSync(builtBin)) {
        return { command: node, argsPrefix: [builtBin], harnessDir };
      }

      const pnpm = this.findOnPath('pnpm');
      if (pnpm && fs.existsSync(srcBin)) {
        // pnpm --dir <harness> dsh …  while child cwd = workspace
        return {
          command: pnpm,
          argsPrefix: ['--dir', harnessDir, 'dsh'],
          harnessDir
        };
      }
    }

    throw new Error(
      '找不到 dsh。请安装 dsh、或设置 DSH_BIN / DSH_HARNESS_DIR（指向 deepseek-harness 仓库）'
    );
  }

  findOnPath(bin) {
    try {
      const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim().split(/\r?\n/)[0];
      return out && fs.existsSync(out) ? out : null;
    } catch {
      return null;
    }
  }

  clearSession() {
    this.sessionId = null;
  }

  cancel() {
    this.cancelRequested = true;
    if (this.activeChild && !this.activeChild.killed) {
      try {
        this.activeChild.kill('SIGTERM');
      } catch (_) { /* ignore */ }
      try {
        this.activeChild.kill('SIGKILL');
      } catch (_) { /* ignore */ }
    }
    this.activeChild = null;
  }

  buildTaskPrompt(question) {
    return [
      '你是基于当前工作区代码的助手。请按需查阅仓库文件后回答。',
      '默认只读分析，不要修改文件、不要提交 git，除非用户明确要求。',
      '回答必须使用简体中文（Simplified Chinese），禁止使用繁体字。',
      '回答尽量简洁、结构化。',
      '',
      '用户问题：',
      String(question || '').trim()
    ].join('\n');
  }

  /**
   * @param {string} question
   * @param {object} options
   * @param {string} options.workspacePath
   * @param {string} [options.harnessDir]
   * @param {boolean} [options.continueSession]
   * @param {function} [options.onEvent] - raw NDJSON event
   * @param {function} [options.onProgress] - (text) accumulated answer so far
   * @param {function} [options.onStatus] - (message) status / tool updates
   * @param {number} [options.timeoutMs]
   */
  async ask(question, options = {}) {
    const workspacePath = options.workspacePath;
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      throw new Error(`工作区目录不存在: ${workspacePath || '(空)'}`);
    }

    const launch = this.resolveLaunch(options);
    const task = this.buildTaskPrompt(question);
    const args = [
      ...launch.argsPrefix,
      '--profile', 'headless',
      '--json'
    ];

    if (options.continueSession !== false && this.sessionId) {
      args.push('--session-id', this.sessionId);
    }

    args.push(task);

    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    logger.info('Starting dsh headless', {
      command: launch.command,
      workspacePath,
      harnessDir: launch.harnessDir,
      sessionId: this.sessionId,
      timeoutMs
    });

    // Kill any previous run, then start a fresh cancellable request
    if (this.activeChild) {
      try { this.activeChild.kill('SIGTERM'); } catch (_) { /* ignore */ }
      this.activeChild = null;
    }
    this.cancelRequested = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let accumulatedText = '';
      let finalText = '';
      let lastError = null;

      const child = spawn(launch.command, args, {
        cwd: workspacePath,
        env: {
          ...process.env,
          // Prefer user's harness home credentials
          DSH_HOME: process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.activeChild = child;

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeChild === child) this.activeChild = null;
        if (err) reject(err);
        else resolve(result);
      };

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
        finish(new Error(`dsh 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);

      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          logger.debug('Non-JSON dsh stdout line', { line: trimmed.slice(0, 200) });
          return;
        }

        if (typeof options.onEvent === 'function') {
          try { options.onEvent(event); } catch (_) { /* ignore */ }
        }

        switch (event.type) {
          case 'session':
            if (event.sessionId || event.id) {
              this.sessionId = event.sessionId || event.id;
            }
            break;
          case 'status': {
            const msg = [event.phase, event.reason, event.message]
              .filter(Boolean)
              .join(' ') || 'running';
            if (typeof options.onStatus === 'function') options.onStatus(String(msg));
            break;
          }
          case 'tool_call': {
            const name = event.name || event.tool || event.toolName || 'tool';
            if (typeof options.onStatus === 'function') {
              options.onStatus(`调用工具: ${name}`);
            }
            break;
          }
          case 'text': {
            const chunk = event.text || event.content || '';
            if (chunk) {
              // Each text event is a committed assistant block — append.
              accumulatedText = accumulatedText
                ? `${accumulatedText}\n${chunk}`
                : chunk;
              if (typeof options.onProgress === 'function') {
                options.onProgress(accumulatedText);
              }
            }
            break;
          }
          case 'final': {
            finalText = event.text || event.content || event.answer || accumulatedText || '';
            break;
          }
          case 'error': {
            lastError = new Error(event.message || event.error || 'dsh error');
            break;
          }
          default:
            break;
        }
      };

      child.stdout.on('data', (buf) => {
        stdoutBuf += buf.toString('utf8');
        const parts = stdoutBuf.split(/\r?\n/);
        stdoutBuf = parts.pop() || '';
        for (const line of parts) handleLine(line);
      });

      child.stderr.on('data', (buf) => {
        const s = buf.toString('utf8');
        stderrBuf += s;
        // Surface reasoning / diagnostics as status when useful
        const lines = s.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          if (line.startsWith('dsh:') && typeof options.onStatus === 'function') {
            options.onStatus(line.replace(/^dsh:\s*/, '').slice(0, 200));
          }
        }
      });

      child.on('error', (err) => {
        finish(new Error(`无法启动 dsh: ${err.message}`));
      });

      child.on('close', (code) => {
        if (stdoutBuf.trim()) handleLine(stdoutBuf);

        const answer = (finalText || accumulatedText || '').trim();
        const cancelled = this.cancelRequested;

        if (cancelled) {
          finish(null, {
            response: answer ? `${answer}\n\n（已中断）` : '（已中断）',
            metadata: {
              provider: 'dsh-headless',
              workspacePath,
              sessionId: this.sessionId,
              exitCode: code,
              processingTime: null,
              usedFallback: false,
              streamed: true,
              cancelled: true
            }
          });
          return;
        }

        if (code !== 0 && !answer) {
          const detail = lastError?.message
            || stderrBuf.split(/\r?\n/).filter(l => l.includes('dsh:')).slice(-3).join(' ')
            || stderrBuf.slice(-500)
            || `exit ${code}`;
          finish(new Error(`dsh 失败: ${detail}`));
          return;
        }

        if (!answer && lastError) {
          finish(lastError);
          return;
        }

        finish(null, {
          response: answer || '（dsh 未返回文本）',
          metadata: {
            provider: 'dsh-headless',
            workspacePath,
            sessionId: this.sessionId,
            exitCode: code,
            processingTime: null,
            usedFallback: false,
            streamed: true,
            cancelled: false
          }
        });
      });
    });
  }
}

module.exports = new DshHeadlessService();
