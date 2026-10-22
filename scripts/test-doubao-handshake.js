require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');

const out = path.join(__dirname, '..', 'tmp-ws-out.txt');
const log = (msg) => {
  const line = typeof msg === 'string' ? msg : JSON.stringify(msg);
  console.log(line);
  fs.appendFileSync(out, line + '\n');
};

fs.writeFileSync(out, '');

const key = process.env.DOUBAO_ASR_API_KEY;
const resourceIds = [
  process.env.DOUBAO_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration',
  'volc.seedasr.sauc.concurrent',
  'volc.bigasr.sauc.duration',
  'volc.bigasr.sauc.concurrent'
];
const urls = [
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'
];

if (!key) {
  log('missing DOUBAO_ASR_API_KEY');
  process.exit(1);
}

log({ keyPrefix: key.slice(0, 8), keyLen: key.length });

function tryOnce(url, resourceId) {
  return new Promise((resolve) => {
    log(`TRY ${url} resource=${resourceId}`);
    const headers = {
      'X-Api-Key': key,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': randomUUID(),
      'X-Api-Connect-Id': randomUUID(),
      'X-Api-Sequence': '-1'
    };
    const ws = new WebSocket(url, { headers });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try {
        ws.removeAllListeners();
        ws.on('error', () => {});
        if (ws.readyState === WebSocket.OPEN) ws.close();
        else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      } catch {}
      resolve(result);
    };
    const t = setTimeout(() => done({ ok: false, reason: 'timeout' }), 8000);

    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        log({ unexpected: res.statusCode, body: body.slice(0, 600) });
        done({ ok: false, reason: `http ${res.statusCode}`, body });
      });
    });

    ws.on('open', () => {
      log('OPEN ok');
      done({ ok: true, url, resourceId });
    });

    ws.on('error', (e) => {
      log(`ERR ${e.message}`);
      // unexpected-response usually follows; don't settle yet if HTTP body pending
    });

    ws.on('close', (code, reason) => {
      log(`CLOSE ${code} ${reason}`);
      done({ ok: false, reason: `close ${code}` });
    });
  });
}

(async () => {
  for (const url of urls) {
    for (const rid of resourceIds) {
      const r = await tryOnce(url, rid);
      if (r.ok) {
        log({ SUCCESS: r });
        process.exit(0);
      }
    }
  }
  log('ALL_FAILED');
  process.exit(1);
})();
