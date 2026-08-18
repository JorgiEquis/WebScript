// Implementación mínima del protocolo WebSocket (RFC 6455), desde cero -- Node no trae
// soporte nativo en su módulo "http" (a diferencia de, por ejemplo, Deno), y este
// proyecto no puede instalar dependencias externas (sin acceso a red en este entorno,
// y coherente con la filosofía de cero dependencias que ya tiene el resto del código:
// el parser, la reactividad, el servidor HTTP, todo hecho con los módulos nativos de
// Node). Cubre lo que hace falta para "ws function" y WSON con "via: socket" -- no es
// una implementación completa del RFC (sin fragmentación de mensajes ni control de
// ping/pong explícito más allá de responder), pero sí correcta para el caso normal:
// mensajes de texto completos, uno por frame.

const crypto = require('crypto');

// GUID fijo del RFC 6455 -- se concatena a la clave del cliente y se hace SHA-1 + base64
// para demostrar que el servidor entiende de verdad el protocolo WebSocket (no un
// proxy/caché que reenvía la petición sin más).
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

// Genera una clave de cliente válida (16 bytes aleatorios, base64) -- para cuando ESTE
// proceso actúa como CLIENTE WebSocket (WSON.send con via:"socket").
function generateClientKey() {
  return crypto.randomBytes(16).toString('base64');
}

const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

// Codifica un frame de texto. "masked" debe ser true si quien envía es un CLIENTE
// (obligatorio enmascarar cliente->servidor según el RFC) y false si es el SERVIDOR
// (el servidor NUNCA enmascara sus frames salientes).
function encodeFrame(payloadBuffer, opcode, masked) {
  const len = payloadBuffer.length;
  const maskBit = masked ? 0x80 : 0x00;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, maskBit | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  if (!masked) {
    return Buffer.concat([header, payloadBuffer]);
  }

  const maskKey = crypto.randomBytes(4);
  const maskedPayload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = payloadBuffer[i] ^ maskKey[i % 4];
  }
  return Buffer.concat([header, maskKey, maskedPayload]);
}

function encodeTextFrame(text, masked = false) {
  return encodeFrame(Buffer.from(text, 'utf8'), OPCODE_TEXT, masked);
}

function encodeCloseFrame(masked = false) {
  return encodeFrame(Buffer.alloc(0), OPCODE_CLOSE, masked);
}

// Decodifica UN frame desde el principio de `buffer`. Devuelve
// { opcode, payload, bytesConsumed } si hay un frame completo, o null si hace falta
// esperar a más datos (un mensaje puede llegar repartido en varios paquetes TCP).
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const firstByte = buffer[0];
  const opcode = firstByte & 0x0f;
  const secondByte = buffer[1];
  const masked = !!(secondByte & 0x80);
  let payloadLen = secondByte & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLen = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buffer.length < offset + 8) return null;
    payloadLen = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLen) return null;

  let payload = buffer.subarray(offset, offset + payloadLen);
  if (masked) {
    const unmasked = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      unmasked[i] = payload[i] ^ maskKey[i % 4];
    }
    payload = unmasked;
  } else {
    payload = Buffer.from(payload); // copia -- subarray comparte memoria con el buffer original
  }

  return { opcode, payload, bytesConsumed: offset + payloadLen };
}

module.exports = {
  computeAcceptKey,
  generateClientKey,
  encodeTextFrame,
  encodeCloseFrame,
  decodeFrame,
  OPCODE_TEXT,
  OPCODE_CLOSE,
  OPCODE_PING,
  OPCODE_PONG,
};
