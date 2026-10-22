/**
 * Speech provider selector.
 * Default: local Chinese Whisper (no cloud key).
 * Set SPEECH_PROVIDER=azure to use Azure Speech.
 */
const provider = (process.env.SPEECH_PROVIDER || 'local').toLowerCase();

if (provider === 'azure') {
  module.exports = require('./speech-azure.service');
} else {
  module.exports = require('./local-whisper.service');
}
