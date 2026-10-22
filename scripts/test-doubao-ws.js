/**
 * Minimal Doubao ASR websocket auth + silence smoke test.
 * Usage: node scripts/test-doubao-ws.js
 */
require('dotenv').config();
const { randomUUID } = require('crypto');
const zlib = require('zlib');
const WebSocket = require('ws');

const apiKey = process.env.DOUBAO_ASR_API_KEY;
const resourceId = process.env.DOUBAO_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration';
const url = process.env.DOUBAO_ASR_WS_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

if (!apiKey) {
  console.error('missing DOUBAO_ASR_API_KEY');
  process.exit(1);
}

function header(msgType, flags, serial, comp) {
  return Buffer.from([(0b0001 << 4) | 0b0001, (msgType << 4) | flags, (serial << 4) | comp, 0x00]);
}

function buildFull() {
  const params = {
    user: { uid: 'vysper-test' },
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true }
  };
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(params), 'utf8'));
  const seq = Buffer.alloc(4);
  seq.writeInt32BE(1, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([header(0b0001, 0b0001, 0b0001, 0b0001), seq, size, body]);
}

function buildAudio(pcm, seqNum, last) {
  const body = zlib.gzipSync(pcm);
  const flags = last ? 0b0011 : 0b0001;
  const seq = Buffer.alloc(4);
  seq.writeInt32BE(last ? -seqNum : seqNum, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([header(0b0010, flags, 0b0000, 0b0001), seq, size, body]);
}

function parse(data) {
  const headerSize = (data[0] & 0x0f) * 4;
  const msgType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const compression = data[2] & 0x0f;
  let rest = data.subarray(headerSize);
  if (msgType === 0b1111) {
    const code = rest.readUInt32BE(0);
    const size = rest.readUInt32BE(4);
    let msg = rest.subarray(8, 8 + size);
    if (compression === 0b0001 && msg.length) {
      try {
        msg = zlib.gunzipSync(msg);
      } catch {}
    }
    return { kind: 'ERROR', code, message: msg.toString('utf8') };
  }
  if (msgType === 0b1001) {
    if (flags & 0b0001) rest = rest.subarray(4);
    const size = rest.readUInt32BE(0);
    let body = rest.subarray(4, 4 + size);
    if (compression === 0b0001 && body.length) {
      try {
        body = zlib.gunzipSync(body);
      } catch {}
    }
    return { kind: 'SERVER', payload: body.length ? JSON.parse(body.toString('utf8')) : {} };
  }
  return { kind: 'OTHER', msgType };
}

const ws = new WebSocket(url, {
  headers: {
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': randomUUID(),
    'X-Api-Connect-Id': randomUUID()
  }
});

const timer = setTimeout(() => {
  console.error('TIMEOUT waiting for server');
  ws.close();
  process.exit(1);
}, 15000);

ws.on('open', () => {
  console.log('WS open');
  ws.send(buildFull());
  // ~1s silence then last packet
  const silence = Buffer.alloc(16000 * 2);
  ws.send(buildAudio(silence.subarray(0, 6400), 2, false));
  ws.send(buildAudio(silence.subarray(6400, 12800), 3, false));
  ws.send(buildAudio(silence.subarray(12800), 4, true));
});

ws.on('message', (data) => {
  const parsed = parse(Buffer.from(data));
  console.log('message', JSON.stringify(parsed, null, 2));
  if (parsed.kind === 'ERROR') {
    clearTimeout(timer);
    process.exitCode = 1;
    ws.close();
  }
  if (parsed.kind === 'SERVER') {
    clearTimeout(timer);
    console.log('OK auth + protocol');
    ws.close();
  }
});

ws.on('error', (err) => {
  clearTimeout(timer);
  console.error('WS error', err.message);
  process.exitCode = 1;
});

ws.on('close', (code, reason) => {
  clearTimeout(timer);
  console.log('WS close', code, reason?.toString?.() || '');
});
