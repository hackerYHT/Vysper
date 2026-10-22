/**
 * Convert Traditional Chinese → Simplified Chinese.
 * Whisper / some LLMs often emit 繁体; we normalize to 简体 for UI + downstream prompts.
 */
let converter = null;

function getConverter() {
  if (converter) return converter;
  try {
    const OpenCC = require('opencc-js');
    // twp: Taiwan phrases → Mainland (軟體→软件, 網路→网络)
    converter = OpenCC.Converter({ from: 'twp', to: 'cn' });
  } catch (error) {
    converter = null;
  }
  return converter;
}

function toSimplified(text) {
  if (!text || typeof text !== 'string') return text;
  const convert = getConverter();
  if (!convert) return text;
  try {
    return convert(text);
  } catch {
    return text;
  }
}

module.exports = { toSimplified };
