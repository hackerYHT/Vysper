require('dotenv').config();

console.log('SPEECH_PROVIDER=', process.env.SPEECH_PROVIDER);
console.log('has DOUBAO_ASR_API_KEY=', !!process.env.DOUBAO_ASR_API_KEY);

const speech = require('../src/services/speech.service');
console.log('status=', speech.getStatus());

speech
  .testConnection()
  .then((r) => {
    console.log('testConnection=', r);
  })
  .catch((e) => {
    console.error('testConnection failed', e);
    process.exitCode = 1;
  });
