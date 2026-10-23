const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const zlib = require('zlib');
const recorder = require('node-record-lpcm16');
const WebSocket = require('ws');
const logger = require('../core/logger').createServiceLogger('SPEECH_DOUBAO');

/**
 * Doubao (Volcengine) streaming ASR via WebSocket binary protocol.
 * Docs: https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI
 *
 * Matches local/azure speech contract: startRecording / stopRecording / cancelRecording / getStatus
 * + events: recording-started, recording-stopped, interim-transcription, transcription, status, error
 */
class DoubaoSpeechService extends EventEmitter {
  constructor() {
    super();
    this.apiKey = process.env.DOUBAO_ASR_API_KEY || process.env.DOUBAO_API_KEY || '';
    this.resourceId =
      process.env.DOUBAO_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration';
    this.wsUrl =
      process.env.DOUBAO_ASR_WS_URL ||
      'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
    this.sampleRate = 16000;
    // ~200ms PCM @ 16kHz mono s16le
    this.chunkBytes = Math.floor(this.sampleRate * 2 * 0.2);
    this.hotwords = (process.env.DOUBAO_ASR_HOTWORDS || 'Agent,Kubernetes,Istio,DeepSeek,Whisper')
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean);

    this.isRecording = false;
    this.isTranscribing = false;
    /** When true, ignore finalize and never emit transcription */
    this.discardRequested = false;
    this.recording = null;
    this.ws = null;
    this.sessionStartTime = null;
    this.seq = 1;
    this.pcmBuffer = Buffer.alloc(0);
    this.latestText = '';
    this.finalEmitted = false;
    this.awaitingFinal = null;
    this.sendQueue = [];
    this.wsReady = false;

    this.initialize();
  }

  initialize() {
    if (!this.apiKey) {
      logger.error('Doubao ASR API key missing (DOUBAO_ASR_API_KEY)');
      return;
    }
    logger.info('Doubao ASR ready', {
      resourceId: this.resourceId,
      wsUrl: this.wsUrl
    });
  }

  get isInitialized() {
    return !!this.apiKey;
  }

  startRecording() {
    if (!this.isInitialized) {
      this.emit('error', '豆包语音未初始化，请配置 DOUBAO_ASR_API_KEY');
      return;
    }
    if (this.isRecording || this.isTranscribing) {
      logger.warn('Recording or transcription already in progress');
      return;
    }

    try {
      this.discardRequested = false;
      this.sessionStartTime = Date.now();
      this.seq = 1;
      this.pcmBuffer = Buffer.alloc(0);
      this.latestText = '';
      this.finalEmitted = false;
      this.awaitingFinal = null;
      this.sendQueue = [];
      this.wsReady = false;

      this._connectWs();

      this.recording = recorder.record({
        sampleRateHertz: this.sampleRate,
        threshold: 0,
        verbose: false,
        recordProgram: 'sox',
        silence: '10.0s'
      });

      this.recording.stream().on('data', (chunk) => {
        if (!this.isRecording) return;
        this.pcmBuffer = Buffer.concat([this.pcmBuffer, Buffer.from(chunk)]);
        // Only flush after full-client-request (seq=1). Building packets earlier
        // burns sequence numbers and triggers Doubao:
        // autoAssignedSequence (1) mismatch sequence in request (N)
        if (this.wsReady) {
          this._flushAudioChunks(false);
        }
      });

      this.recording.stream().on('error', (error) => {
        logger.error('Microphone stream error', { error: error.message });
        this.emit('error', `麦克风采集失败: ${error.message}`);
        this._cleanupSession();
      });

      this.isRecording = true;
      this.emit('recording-started');
      this.emit('status', '正在录音（豆包识别）…');
      logger.info('Doubao recording started');
    } catch (error) {
      logger.error('Failed to start Doubao recording', { error: error.message });
      this.isRecording = false;
      this._cleanupSession();
      this.emit('error', `无法开始录音: ${error.message}`);
    }
  }

  stopRecording() {
    if (!this.isRecording) return;

    this.isRecording = false;
    this._stopCaptureOnly();
    this.emit('recording-stopped');
    this.emit('status', '录音结束，正在获取豆包识别结果…');
    this.isTranscribing = true;

    const minBytes = this.sampleRate * 2 * 0.3;
    if (this.pcmBuffer.length < minBytes && this.seq <= 1 && !this.latestText) {
      // Never sent audio (too short) — still need to close cleanly
      logger.warn('Audio too short for Doubao ASR', { bytes: this.pcmBuffer.length });
      this.emit('status', '录音过短，未识别');
      this.isTranscribing = false;
      this._cleanupSession();
      return;
    }

    this._flushAudioChunks(true)
      .then(() => this._waitForFinalText(5000))
      .then((text) => {
        if (this.discardRequested) return;
        const cleaned = (text || this.latestText || '').trim();
        if (cleaned && !this.finalEmitted) {
          this.finalEmitted = true;
          logger.info('Doubao transcription', {
            text: cleaned,
            durationMs: Date.now() - this.sessionStartTime
          });
          this.emit('interim-transcription', cleaned);
          this.emit('transcription', cleaned);
          this.emit('status', '豆包转写完成');
        } else if (!cleaned) {
          this.emit('status', '未识别到有效语音');
        }
      })
      .catch((error) => {
        if (this.discardRequested) return;
        logger.error('Doubao transcription failed', { error: error.message });
        this.emit('error', `豆包转写失败: ${error.message}`);
      })
      .finally(() => {
        this.isTranscribing = false;
        this._cleanupSession();
      });
  }

  /**
   * Abort recording without emitting a transcription (Esc).
   */
  cancelRecording() {
    if (!this.isRecording && !this.isTranscribing) return;
    this.discardRequested = true;
    this.finalEmitted = true; // block late finals
    this.isRecording = false;
    this.isTranscribing = false;
    if (this.awaitingFinal) {
      try {
        this.awaitingFinal.resolve('');
      } catch {
        /* ignore */
      }
      this.awaitingFinal = null;
    }
    this._stopCaptureOnly();
    this.emit('recording-stopped');
    this.emit('interim-transcription', '');
    this._cleanupSession();
    logger.info('Doubao recording cancelled (discard)');
  }

  _connectWs() {
    const headers = {
      'X-Api-Key': this.apiKey,
      'X-Api-Resource-Id': this.resourceId,
      'X-Api-Request-Id': randomUUID(),
      'X-Api-Connect-Id': randomUUID(),
      'X-Api-Sequence': '-1'
    };

    const ws = new WebSocket(this.wsUrl, { headers });
    this.ws = ws;

    ws.on('open', () => {
      logger.info('Doubao ASR websocket open');
      try {
        // Must be the first sequenced frame (seq=1) when X-Api-Sequence: -1
        this.seq = 1;
        this.sendQueue = [];
        ws.send(this._buildFullClientRequest());
        this.wsReady = true;
        this._flushAudioChunks(false);
      } catch (error) {
        logger.error('Failed to send full client request', { error: error.message });
        this.emit('error', `豆包建连失败: ${error.message}`);
      }
    });

    ws.on('message', (data) => {
      try {
        const parsed = this._parseServerMessage(Buffer.from(data));
        if (parsed.kind === 'ERROR') {
          logger.error('Doubao ASR server error', {
            code: parsed.code,
            message: parsed.message
          });
          this.emit('error', `豆包识别错误(${parsed.code}): ${parsed.message}`);
          if (this.awaitingFinal) {
            this.awaitingFinal.reject(new Error(parsed.message));
            this.awaitingFinal = null;
          }
          return;
        }
        if (parsed.kind !== 'SERVER') return;

        const text = this._extractText(parsed.payload);
        if (text) {
          this.latestText = text;
          if (!this.discardRequested) {
            this.emit('interim-transcription', text);
          }
        }

        // Last server response after negative-seq audio packet
        if (parsed.flags & 0b0010 || parsed.flags & 0b0011) {
          if (this.awaitingFinal) {
            this.awaitingFinal.resolve(this.latestText);
            this.awaitingFinal = null;
          }
        }
      } catch (error) {
        logger.warn('Failed to parse Doubao ASR message', { error: error.message });
      }
    });

    ws.on('error', (error) => {
      logger.error('Doubao ASR websocket error', { error: error.message });
      this.emit('error', `豆包连接错误: ${error.message}`);
      if (this.awaitingFinal) {
        this.awaitingFinal.reject(error);
        this.awaitingFinal = null;
      }
    });

    ws.on('close', (code, reason) => {
      logger.info('Doubao ASR websocket closed', {
        code,
        reason: reason?.toString?.() || ''
      });
      this.wsReady = false;
      if (this.awaitingFinal) {
        this.awaitingFinal.resolve(this.latestText);
        this.awaitingFinal = null;
      }
    });
  }

  _buildRequestParams() {
    const request = {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      // Two-pass on async endpoint: faster interim + more accurate finals
      enable_nonstream: true,
      result_type: 'full'
    };

    if (this.hotwords.length) {
      request.corpus = {
        context: JSON.stringify({
          hotwords: this.hotwords.map((word) => ({ word }))
        })
      };
    }

    return {
      user: { uid: 'vysper' },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: this.sampleRate,
        bits: 16,
        channel: 1
      },
      request
    };
  }

  _header(msgType, flags, serial, comp) {
    return Buffer.from([
      (0b0001 << 4) | 0b0001, // version 1, header size 4
      (msgType << 4) | flags,
      (serial << 4) | comp,
      0x00
    ]);
  }

  _buildFullClientRequest() {
    const body = zlib.gzipSync(Buffer.from(JSON.stringify(this._buildRequestParams()), 'utf8'));
    const parts = [
      this._header(0b0001, 0b0001, 0b0001, 0b0001),
      Buffer.alloc(4),
      Buffer.alloc(4),
      body
    ];
    parts[1].writeInt32BE(this.seq, 0); // sequence starts at 1
    parts[2].writeUInt32BE(body.length, 0);
    this.seq += 1;
    return Buffer.concat(parts);
  }

  _buildAudioPacket(pcmChunk, isLast) {
    const body = zlib.gzipSync(pcmChunk);
    let flags = 0b0001;
    let seq = this.seq;
    if (isLast) {
      flags = 0b0011;
      seq = -seq;
    }
    const parts = [
      this._header(0b0010, flags, 0b0000, 0b0001),
      Buffer.alloc(4),
      Buffer.alloc(4),
      body
    ];
    parts[1].writeInt32BE(seq, 0);
    parts[2].writeUInt32BE(body.length, 0);
    this.seq += 1;
    return Buffer.concat(parts);
  }

  _sendOrQueue(buf) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.wsReady) {
      this.ws.send(buf);
    } else {
      this.sendQueue.push(buf);
    }
  }

  async _flushAudioChunks(isLast) {
    while (this.pcmBuffer.length >= this.chunkBytes) {
      const chunk = this.pcmBuffer.subarray(0, this.chunkBytes);
      this.pcmBuffer = this.pcmBuffer.subarray(this.chunkBytes);
      this._sendOrQueue(this._buildAudioPacket(chunk, false));
    }

    if (!isLast) return;

    // Send remainder (or empty last packet if nothing left)
    const rem = this.pcmBuffer;
    this.pcmBuffer = Buffer.alloc(0);
    this._sendOrQueue(this._buildAudioPacket(rem.length ? rem : Buffer.alloc(0), true));
  }

  _waitForFinalText(timeoutMs) {
    if (this.latestText && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
      return Promise.resolve(this.latestText);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.awaitingFinal = null;
        resolve(this.latestText);
      }, timeoutMs);
      this.awaitingFinal = {
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      };
    });
  }

  _parseServerMessage(data) {
    const headerSize = (data[0] & 0x0f) * 4;
    const msgType = data[1] >> 4;
    const flags = data[1] & 0x0f;
    const compression = data[2] & 0x0f;
    let rest = data.subarray(headerSize);

    if (msgType === 0b1111) {
      const code = rest.readUInt32BE(0);
      const size = rest.readUInt32BE(4);
      let msg = rest.subarray(8, 8 + size);
      if (compression === 0b0001 && msg.length) {
        try {
          msg = zlib.gunzipSync(msg);
        } catch {
          /* keep raw */
        }
      }
      return {
        kind: 'ERROR',
        code,
        flags,
        message: msg.toString('utf8')
      };
    }

    if (msgType === 0b1001) {
      let seq = null;
      if (flags & 0b0001) {
        seq = rest.readInt32BE(0);
        rest = rest.subarray(4);
      }
      const size = rest.readUInt32BE(0);
      let body = rest.subarray(4, 4 + size);
      if (compression === 0b0001 && body.length) {
        try {
          body = zlib.gunzipSync(body);
        } catch {
          /* keep raw */
        }
      }
      let payload = {};
      if (body.length) {
        payload = JSON.parse(body.toString('utf8'));
      }
      return { kind: 'SERVER', seq, flags, payload };
    }

    return { kind: 'OTHER', msgType, flags };
  }

  _extractText(payload) {
    if (!payload || !payload.result) return '';
    const result = payload.result;
    if (typeof result.text === 'string' && result.text.trim()) {
      return result.text.trim();
    }
    // Some payloads return result as array
    if (Array.isArray(result) && result[0]?.text) {
      return String(result[0].text).trim();
    }
    return '';
  }

  _stopCaptureOnly() {
    if (this.recording) {
      try {
        this.recording.stop();
      } catch (error) {
        logger.error('Error stopping recorder', { error: error.message });
      }
      this.recording = null;
    }
  }

  _cleanupSession() {
    this._stopCaptureOnly();
    this.wsReady = false;
    this.sendQueue = [];
    this.pcmBuffer = Buffer.alloc(0);
    if (this.ws) {
      try {
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close();
        }
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  getStatus() {
    return {
      isRecording: this.isRecording,
      isTranscribing: this.isTranscribing,
      isInitialized: this.isInitialized,
      provider: 'doubao',
      resourceId: this.resourceId,
      sessionDuration: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0
    };
  }

  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, message: 'Doubao ASR API key missing' };
    }
    return { success: true, message: 'Doubao ASR configured' };
  }
}

module.exports = new DoubaoSpeechService();
