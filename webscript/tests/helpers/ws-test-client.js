const net = require('net');
const crypto = require('crypto');

// Cliente WebSocket mínimo, SOLO para tests -- construido con "net" a mano, sin
// depender de ninguna librería externa (no hay ninguna disponible/instalable en este
// entorno) ni de src/ws-protocol.js (para probar el servidor de forma independiente
// de la implementación concreta que usa, no acoplada a sus mismos helpers).
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  const maskKey = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, masked]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLen = buffer.readUInt16BE(offset); offset += 2;
  } else if (payloadLen === 127) {
    if (buffer.length < offset + 8) return null;
    payloadLen = Number(buffer.readBigUInt64BE(offset)); offset += 8;
  }
  if (buffer.length < offset + payloadLen) return null;
  return { opcode, payload: Buffer.from(buffer.subarray(offset, offset + payloadLen)), bytesConsumed: offset + payloadLen };
}

function connectWs(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, 'localhost', () => {
      const key = crypto.randomBytes(16).toString('base64');
      const extraHeaders = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        extraHeaders + `\r\n`
      );
    });

    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    const messageListeners = [];
    let setCookieHeader = null;
    let statusLine = null;

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headerText = buffer.subarray(0, headerEnd).toString('utf8');
        statusLine = headerText.split('\r\n')[0];
        const cookieMatch = headerText.match(/Set-Cookie: ([^\r\n]+)/i);
        if (cookieMatch) setCookieHeader = cookieMatch[1];
        buffer = buffer.subarray(headerEnd + 4);
        handshakeDone = true;
        if (!/101/.test(statusLine)) {
          reject(new Error(`Handshake falló: ${statusLine}`));
          return;
        }
        resolve({
          send: (obj) => socket.write(encodeTextFrame(JSON.stringify(obj))),
          onMessage: (cb) => messageListeners.push(cb),
          close: () => socket.end(),
          setCookieHeader: () => setCookieHeader,
          socket,
        });
      }
      if (handshakeDone) {
        let frame;
        while ((frame = decodeFrame(buffer)) !== null) {
          buffer = buffer.subarray(frame.bytesConsumed);
          if (frame.opcode === 0x1) {
            messageListeners.forEach(cb => cb(JSON.parse(frame.payload.toString('utf8'))));
          }
        }
      }
    });
    socket.on('error', reject);
  });
}

module.exports = { connectWs };
