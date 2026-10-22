require('dotenv').config();
const fs = require('fs');
const out = [];
try {
  out.push('start');
  const s = require('../src/services/local-whisper.service');
  out.push(JSON.stringify(s.getStatus(), null, 2));
  s.testConnection().then((r) => {
    out.push(JSON.stringify(r));
    fs.writeFileSync('/tmp/tw-ok.txt', out.join('\n'));
    console.log(out.join('\n'));
  }).catch((e) => {
    out.push(String(e));
    fs.writeFileSync('/tmp/tw-ok.txt', out.join('\n'));
    console.error(e);
    process.exit(1);
  });
} catch (e) {
  out.push(e && e.stack ? e.stack : String(e));
  fs.writeFileSync('/tmp/tw-ok.txt', out.join('\n'));
  console.error(e);
  process.exit(1);
}
