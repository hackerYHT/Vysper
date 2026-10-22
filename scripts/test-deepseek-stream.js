require('dotenv').config();
const llm = require('../src/services/llm.service');

(async () => {
  let chunks = 0;
  let last = '';
  const result = await llm.processTextWithSkill(
    '用三句话介绍快速排序',
    'dsa',
    [],
    'python',
    {
      onDelta: (delta, full) => {
        chunks += 1;
        last = full;
        process.stdout.write(delta);
      }
    }
  );
  console.log('\n---');
  console.log('chunks', chunks, 'finalLen', result.response.length, 'match', result.response === last.trim() || result.response === last);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
