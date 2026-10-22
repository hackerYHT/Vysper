/**
 * Speech provider selector.
 * Default: local Chinese Whisper (no cloud key).
 * SPEECH_PROVIDER=doubao → 豆包流式 ASR
 * SPEECH_PROVIDER=azure  → Azure Speech
 */
const provider = (process.env.SPEECH_PROVIDER || 'local').toLowerCase();

if (provider === 'doubao') {
  module.exports = require('./speech-doubao.service');
} else if (provider === 'azure') {
  module.exports = require('./speech-azure.service');
} else {
  module.exports = require('./local-whisper.service');
}
