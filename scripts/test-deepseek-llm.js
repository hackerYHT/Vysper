require('dotenv').config();
const llm = require('../src/services/llm.service');

(async () => {
  console.log('stats', llm.getStats());
  const test = await llm.testConnection();
  console.log('test', test);
  if (!test.success) process.exit(1);
  const result = await llm.processTextWithSkill(
    '用一句话解释什么是哈希表',
    'dsa',
    [],
    'python'
  );
  console.log('answer:', (result.response || '').slice(0, 300));
  console.log('meta', result.metadata);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
