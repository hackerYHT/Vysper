const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const recorder = require('node-record-lpcm16');
const logger = require('../core/logger').createServiceLogger('SPEECH_LOCAL');
const { toSimplified } = require('../utils/zh-simplify');

/**
 * Local speech-to-text via whisper.cpp (no cloud key).
 * Accuracy for CN+EN tech terms comes from a larger model (medium), not post-hoc dictionaries.
 */
class LocalWhisperSpeechService extends EventEmitter {
  constructor() {
    super();
    this.isRecording = false;
    this.recording = null;
    this.sessionStartTime = null;
    this.audioFilePath = null;
    this.pcmChunks = [];
    this.isTranscribing = false;

    this.whisperBin = process.env.WHISPER_BIN || 'whisper-cli';
    // auto: better for Chinese + English proper nouns (Istio, Kubernetes, …)
    this.language = process.env.WHISPER_LANGUAGE || 'auto';
    // Bias decoder toward Simplified Chinese (Whisper often emits 繁体 otherwise)
    this.initialPrompt = process.env.WHISPER_INITIAL_PROMPT
      || '以下是简体中文的内容。';
    this.modelPath = this.resolveModelPath();
    this.sampleRate = 16000;
    // Decoding quality (whisper.cpp beam search)
    this.beamSize = Number(process.env.WHISPER_BEAM_SIZE || 5);
    this.bestOf = Number(process.env.WHISPER_BEST_OF || 5);

    this.initialize();
  }

  resolveModelPath() {
    if (process.env.WHISPER_MODEL_PATH) {
      return path.resolve(process.env.WHISPER_MODEL_PATH);
    }
    const modelsDir = path.join(__dirname, '../../models');
    // Prefer medium when available (much better on English loanwords)
    const medium = path.join(modelsDir, 'ggml-medium.bin');
    const small = path.join(modelsDir, 'ggml-small.bin');
    if (fs.existsSync(medium)) return medium;
    return small;
  }

  initialize() {
    const binOk = this.commandExists(this.whisperBin);
    const modelOk = fs.existsSync(this.modelPath);

    if (!binOk) {
      logger.error('whisper-cli not found. Install with: brew install whisper-cpp');
      this.emit('error', '本地语音未就绪：未找到 whisper-cli，请先 brew install whisper-cpp');
      return;
    }

    if (!modelOk) {
      logger.error('Whisper model missing', { modelPath: this.modelPath });
      this.emit(
        'error',
        `本地语音未就绪：缺少模型文件 ${this.modelPath}。请下载 ggml-small.bin 到 models/`
      );
      return;
    }

    logger.info('Local Whisper Chinese STT ready', {
      bin: this.whisperBin,
      model: this.modelPath,
      language: this.language
    });
    this.emit('status', '本地中文语音识别已就绪');
  }

  commandExists(cmd) {
    try {
      const { execSync } = require('child_process');
      execSync(`which ${cmd}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  get isInitialized() {
    return this.commandExists(this.whisperBin) && fs.existsSync(this.modelPath);
  }

  startRecording() {
    if (!this.isInitialized) {
      this.emit('error', '本地语音未初始化，请检查 whisper-cli 与模型文件');
      return;
    }

    if (this.isRecording || this.isTranscribing) {
      logger.warn('Recording or transcription already in progress');
      return;
    }

    try {
      this.sessionStartTime = Date.now();
      this.pcmChunks = [];
      this.audioFilePath = path.join(
        os.tmpdir(),
        `vysper-whisper-${Date.now()}.wav`
      );

      this.recording = recorder.record({
        sampleRateHertz: this.sampleRate,
        threshold: 0,
        verbose: false,
        recordProgram: 'sox',
        silence: '10.0s'
      });

      this.recording.stream().on('data', (chunk) => {
        if (this.isRecording) {
          this.pcmChunks.push(Buffer.from(chunk));
        }
      });

      this.recording.stream().on('error', (error) => {
        logger.error('Microphone stream error', { error: error.message });
        this.emit('error', `麦克风采集失败: ${error.message}`);
        this._stopCaptureOnly();
      });

      this.isRecording = true;
      this.emit('recording-started');
      this.emit('status', '正在录音（本地中文识别）…');
      logger.info('Local recording started', { audioFilePath: this.audioFilePath });
    } catch (error) {
      logger.error('Failed to start local recording', { error: error.message });
      this.isRecording = false;
      this.emit('error', `无法开始录音: ${error.message}`);
    }
  }

  stopRecording() {
    if (!this.isRecording) {
      return;
    }

    this.isRecording = false;
    this._stopCaptureOnly();

    this.emit('recording-stopped');
    this.emit('status', '录音结束，正在本地转写中文…');

    const pcm = Buffer.concat(this.pcmChunks);
    this.pcmChunks = [];
    const wavPath = this.audioFilePath;

    // Accidental toggle / too short
    const minBytes = this.sampleRate * 2 * 0.4;
    if (pcm.length < minBytes) {
      logger.warn('Audio too short, skipping transcription', { bytes: pcm.length });
      this.emit('status', '录音过短，未识别');
      this._cleanupTempFile();
      return;
    }

    this.isTranscribing = true;
    Promise.resolve()
      .then(() => {
        this.writeWavFile(wavPath, pcm, this.sampleRate);
        return this.transcribeFile(wavPath);
      })
      .then((text) => {
        if (text && text.trim()) {
          const cleaned = text.trim();
          logger.info('Local Chinese transcription', {
            text: cleaned,
            durationMs: Date.now() - this.sessionStartTime
          });
          this.emit('interim-transcription', cleaned);
          this.emit('transcription', cleaned);
          this.emit('status', '本地转写完成');
        } else {
          this.emit('status', '未识别到有效语音');
        }
      })
      .catch((error) => {
        logger.error('Local transcription failed', { error: error.message });
        this.emit('error', `本地转写失败: ${error.message}`);
      })
      .finally(() => {
        this.isTranscribing = false;
        this._cleanupTempFile();
      });
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

  _cleanupTempFile() {
    if (this.audioFilePath && fs.existsSync(this.audioFilePath)) {
      try {
        fs.unlinkSync(this.audioFilePath);
      } catch (error) {
        logger.debug('Temp wav cleanup failed', { error: error.message });
      }
    }
    this.audioFilePath = null;
  }

  writeWavFile(filePath, pcmData, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmData.length;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    fs.writeFileSync(filePath, Buffer.concat([header, pcmData]));
  }

  transcribeFile(wavPath) {
    return new Promise((resolve, reject) => {
      const args = [
        '-m', this.modelPath,
        '-l', this.language,
        '-f', wavPath,
        '-bs', String(this.beamSize),
        '-bo', String(this.bestOf),
        '-nt',
        '-np'
      ];
      if (this.initialPrompt) {
        args.push('--prompt', this.initialPrompt);
      }

      logger.info('Running whisper-cli', {
        model: path.basename(this.modelPath),
        language: this.language,
        beamSize: this.beamSize,
        hasPrompt: !!this.initialPrompt
      });

      const child = spawn(this.whisperBin, args, {
        env: process.env
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('转写超时（>120s）'));
      }, 180000);

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `whisper-cli 退出码 ${code}`));
          return;
        }

        let text = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('['))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        // Drop common subtitle-style hallucinations (not term dictionaries)
        const junkPatterns = [
          /^字幕由Amara\.org社区提供$/,
          /^谢谢观看$/,
          /^请不吝点赞$/,
          /^订阅明镜与点点栏目$/
        ];
        if (junkPatterns.some((re) => re.test(text.replace(/\s+/g, '')))) {
          logger.warn('Discarding likely hallucinated transcription', { text });
          text = '';
        }

        // Whisper frequently emits Traditional Chinese — normalize to Simplified
        if (text) {
          const simplified = toSimplified(text);
          if (simplified !== text) {
            logger.debug('Converted transcription to Simplified Chinese', {
              before: text.slice(0, 80),
              after: simplified.slice(0, 80)
            });
          }
          text = simplified;
        }

        resolve(text);
      });
    });
  }

  getStatus() {
    return {
      isRecording: this.isRecording,
      isTranscribing: this.isTranscribing,
      isInitialized: this.isInitialized,
      provider: 'local-whisper',
      language: this.language,
      modelPath: this.modelPath,
      sessionDuration: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0
    };
  }

  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, message: 'Local Whisper not initialized' };
    }
    return { success: true, message: 'Local Chinese Whisper ready' };
  }
}

module.exports = new LocalWhisperSpeechService();
