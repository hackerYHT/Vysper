/**
 * LLM provider selector.
 * Default: deepseek — reuses deepseek-harness (~/.dsh) credentials.
 * Set LLM_PROVIDER=gemini to use Google Gemini.
 */
const provider = (process.env.LLM_PROVIDER || 'deepseek').toLowerCase();

if (provider === 'gemini') {
  module.exports = require('./llm-gemini.service');
} else {
  module.exports = require('./llm-deepseek.service');
}
