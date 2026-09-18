'use strict';
// Modo estricto a propósito: sin esto, asignar a un identificador NUNCA declarado
// dentro de una post/put/delete function o server function (ej. un typo, o intentar
// "escribir" sobre un nombre que en realidad es un visual del cliente) crea una
// variable GLOBAL implícita en el proceso Node -- filtrada fuera de cualquier sesión,
// un bug silencioso y de verdad peligroso. Con 'use strict', eso es un ReferenceError
// inmediato y claro en vez de una fuga silenciosa entre sesiones.

// server.js -- variables SOLO de servidor. Este archivo NUNCA se envía al cliente.
// Cada sesión (identificada por cookie, ver site-builder.js) llama a createSessionState()
// UNA vez y se queda con su propia instancia -- el estado NO se comparte entre visitantes.

// WSON.send(wson) -- envía un objeto WSON ({ from?, to, via?, content, secret?,
// encrypt?, id? }) al sistema (o SISTEMAS, si "to" es un array) que indique "to".
// Es SOLO envío -- construir el WSON (server wson NOMBRE = ...) nunca envía nada por
// sí solo, siempre hace falta llamar a WSON.send() explícitamente. "via" es opcional
// (por defecto POST); "from" es opcional (mensajes anónimos, y viaja como cabecera
// "X-WSON-From" para que el receptor sepa quién lo mandó). De momento SOLO admite "to"
// como URL (o array de URLs) con via POST/PUT/DELETE -- enviar a un email o número de
// teléfono está pensado pero no implementado todavía (necesita conectar un servicio
// real de correo/SMS, algo que no se puede montar ni probar sin credenciales reales).
//
// VARIOS DESTINOS: si "to" es un array, se manda a todos EN PARALELO y se devuelve un
// array de resultados en el mismo orden -- el fallo de UNO no tumba a los demás (cada
// entrada del array indica su propio éxito/error). Con "to" como string de siempre,
// se sigue devolviendo un único resultado, sin cambios.
//
// FIRMA: si el WSON tiene "secret", se firma automáticamente (HMAC-SHA256 de lo que
// de verdad se manda -- el content cifrado, si lo está, o el content tal cual si no)
// y se manda como cabecera "X-WSON-Signature: sha256=<hex>". El secreto en sí nunca
// viaja por la red. WSON.verify(payload, cabeceraFirma, secreto), en el receptor, hace
// la comprobación inversa -- con comparación en tiempo constante
// (crypto.timingSafeEqual), para no filtrar el secreto por temporización.
//
// CIFRADO OPCIONAL: con "encrypt: true" (necesita "secret" también, como clave), el
// "content" se cifra con AES-256-GCM (cifrado AUTENTICADO -- confidencialidad y
// detección de manipulación en un solo paso, no dos por separado) antes de mandarlo.
// La clave de cifrado se deriva del secreto con una sal distinta a la que usa la
// firma, para no reutilizar la misma clave cruda en dos construcciones criptográficas
// distintas. Sistemas que NO son WebScript nunca podrán descifrarlo sin conocer el
// secreto -- por diseño, ya que es justo el punto de cifrarlo. WSON.showContent(
// payload, secreto), en el receptor, descifra -- o si el mensaje no estaba cifrado,
// lo devuelve tal cual, para no obligar al receptor a ramificar su propio código según
// si el emisor cifró o no. Si el descifrado falla (clave equivocada, o manipulado),
// devuelve null -- comprobable con "if (!resultado)", sin necesitar try/catch.
//
// ID DE CORRELACIÓN: automático por envío (no se guarda en el objeto "wson" -- si lo
// hiciera, reenviar el MISMO objeto reutilizaría el mismo id, que sería incorrecto),
// mandado como cabecera "X-WSON-Correlation-Id". Si el propio wson ya trae "id", se
// respeta ese en vez de generar uno nuevo.
//
// WSON.parse(payload, headers, secreto?) -- en el receptor, hace de una vez lo que si
// no serían tres pasos sueltos (leer "from"/"id" de las cabeceras + WSON.verify() +
// WSON.showContent()): devuelve { from, id, content, signatureValid }. Sin "secreto",
// no intenta verificar ni descifrar -- "content" es el payload tal cual, "signatureValid"
// queda "undefined" (ni verdadero ni falso: sencillamente no se comprobó).
//
// WSON.history(filtros?) -- almacén en un FICHERO real (JSONL, una línea JSON por
// evento), junto al propio server.js -- sobrevive a reiniciar el proceso, a
// diferencia del array en memoria que tenía antes (que se perdía sin remedio).
// WSON.send() registra cada envío (incluso los que fallan, con el error incluido),
// WSON.parse() registra cada recepción -- ambos automáticamente, sin llamada aparte.
// Formato JSONL elegido porque se puede AÑADIR una línea sin reescribir el fichero
// entero (mucho más barato que ir regrabando un array JSON completo en cada evento),
// y porque se puede inspeccionar con herramientas normales (cat, tail, grep) sin
// necesitar nada especial. Sin límite de entradas (a diferencia del tope de 1000 que
// tenía la versión en memoria) -- el fichero puede crecer sin freno en un proceso muy
// longevo; no hay rotación de logs implementada, queda documentado como límite
// conocido, no resuelto aquí.
//
// WSON.getSignature(headers) -- atajo para no tener que recordar el nombre exacto de
// la cabecera ("x-wson-signature", en minúsculas) -- devuelve el mismo valor que ya
// espera WSON.verify() como segundo argumento, sin transformarlo, para que sigan
// siendo componibles: WSON.verify(payload, WSON.getSignature(headers), secreto).
function __wsonDeriveKey(secret, salt) {
  return require('crypto').createHash('sha256').update(secret + ':' + salt).digest();
}
const __wsonHistoryFile = (() => {
  const p = require('path');
  const configurado = null;
  if (!configurado) return p.join(__dirname, 'wson-history.jsonl');
  return p.isAbsolute(configurado) ? configurado : p.join(__dirname, configurado);
})();
const __WSON_REPLAY_WINDOW_MS = 300000;
function __wsonRecord(entry) {
  const line = JSON.stringify(Object.assign({ timestamp: Date.now() }, entry)) + '\n';
  try {
    require('fs').appendFileSync(__wsonHistoryFile, line);
  } catch (e) {
    // Si por lo que sea no se puede escribir (permisos, disco lleno...), no se tumba
    // la petición por esto -- el registro es un extra, nunca algo crítico para poder
    // responder. Se avisa por consola, nada más.
    console.error('WSON: no se pudo escribir en el historial (' + __wsonHistoryFile + '): ' + e.message);
  }
}
function __wsonWsEncodeFrame(payloadBuffer) {
  // Frame de CLIENTE -- el enmascarado es obligatorio en esta dirección (RFC 6455).
  const len = payloadBuffer.length;
  const maskKey = require('crypto').randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payloadBuffer[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, masked]);
}
function __wsonWsDecodeFrame(buffer) {
  // Frame de SERVIDOR -- nunca enmascarado (el servidor no enmascara sus respuestas).
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
const WSON = {
  send: async (wson) => {
    const via = (wson.via || 'POST').toUpperCase();
    if (via !== 'POST' && via !== 'PUT' && via !== 'DELETE' && via !== 'SOCKET') {
      throw new Error('WSON.send(): via "' + wson.via + '" no soportado todavía -- POST/PUT/DELETE/SOCKET por ahora (email y teléfono, pendientes de conectar un servicio real).');
    }
    const crypto_ = require('crypto');
    let payload = wson.content;
    if (wson.encrypt) {
      const key = __wsonDeriveKey(wson.secret, 'wson-encrypt');
      const iv = crypto_.randomBytes(12);
      const cipher = crypto_.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(wson.content), 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      payload = {
        __wsonEncrypted: true,
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        authTag: authTag.toString('base64'),
      };
    }
    const correlationId = wson.id || crypto_.randomUUID();
    const headers = { 'X-WSON-Correlation-Id': correlationId };
    if (wson.from) headers['X-WSON-From'] = wson.from;
    if (wson.secret) {
      const timestamp = Date.now();
      headers['X-WSON-Timestamp'] = String(timestamp);
      const sig = crypto_.createHmac('sha256', wson.secret).update(JSON.stringify(payload) + '.' + timestamp).digest('hex');
      headers['X-WSON-Signature'] = 'sha256=' + sig;
    }
    async function __wsonFetchOnce(url) {
      const opts = { method: via, headers: Object.assign({}, headers) };
      if (payload !== undefined) {
        if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(payload);
      }
      const res = await fetch(url, opts);
      const text = await res.text();
      let parsed; try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
      if (!res.ok) {
        const err = new Error('WSON.send(): el destino respondió ' + res.status + (res.statusText ? (' ' + res.statusText) : ''));
        err.status = res.status;
        err.body = parsed;
        throw err;
      }
      return parsed;
    }
    async function __wsonSocketSendOnce(destino) {
      return await new Promise((resolve, reject) => {
        const net_ = require('net');
        let urlObj;
        try { urlObj = new URL(destino); } catch (e) { reject(new Error('WSON.send(): "' + destino + '" no es una URL válida para via:"socket" (se espera algo como ws://host:puerto/ruta).')); return; }
        const wsPort = urlObj.port || 80;
        const wsPath = urlObj.pathname + urlObj.search;
        const socket = net_.connect(wsPort, urlObj.hostname, () => {
          const clientKey = crypto_.randomBytes(16).toString('base64');
          const extraHeaders = Object.keys(headers).map((k) => k + ': ' + headers[k] + '\r\n').join('');
          socket.write(
            'GET ' + wsPath + ' HTTP/1.1\r\n' +
            'Host: ' + urlObj.hostname + ':' + wsPort + '\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: ' + clientKey + '\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            extraHeaders +
            '\r\n'
          );
        });
        let handshakeDone = false;
        let buffer = Buffer.alloc(0);
        const timeoutId = setTimeout(() => {
          socket.destroy();
          reject(new Error('WSON.send(): tiempo de espera agotado esperando respuesta por WebSocket de \"' + destino + '\"'));
        }, 10000);
        socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (!handshakeDone) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            buffer = buffer.subarray(headerEnd + 4);
            handshakeDone = true;
            socket.write(__wsonWsEncodeFrame(Buffer.from(JSON.stringify(payload), 'utf8')));
          }
          if (handshakeDone) {
            const decoded = __wsonWsDecodeFrame(buffer);
            if (decoded) {
              clearTimeout(timeoutId);
              socket.end();
              let parsed;
              try { parsed = JSON.parse(decoded.payload.toString('utf8')); } catch (e) { parsed = decoded.payload.toString('utf8'); }
              resolve(parsed);
            }
          }
        });
        socket.on('error', (e) => { clearTimeout(timeoutId); reject(e); });
      });
    }
    async function __sendOne(destino) {
      const maxAttempts = 1 + (wson.retries || 0);
      const baseDelay = wson.retryDelayMs || 500;
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const result = via === 'SOCKET' ? await __wsonSocketSendOnce(destino) : await __wsonFetchOnce(destino);
          __wsonRecord({ direction: 'sent', from: wson.from, to: destino, via: via, content: wson.content, id: correlationId, attempts: attempt });
          return result;
        } catch (e) {
          lastError = e;
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1)));
          }
        }
      }
      __wsonRecord({ direction: 'sent', from: wson.from, to: destino, via: via, content: wson.content, id: correlationId, error: lastError.message, attempts: maxAttempts, deadLetter: true });
      throw lastError;
    }
    if (Array.isArray(wson.to)) {
      const results = await Promise.allSettled(wson.to.map((destino) => __sendOne(destino)));
      return results.map((r) => (r.status === 'fulfilled' ? r.value : { error: true, message: r.reason.message }));
    }
    return await __sendOne(wson.to);
  },
  enqueue: (wson) => {
    const correlationId = wson.id || require('crypto').randomUUID();
    WSON.send(Object.assign({}, wson, { id: correlationId })).catch(() => {});
    return correlationId;
  },
  verify: (payload, signatureHeader, secret, timestamp) => {
    if (!signatureHeader || timestamp === undefined || timestamp === null) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > __WSON_REPLAY_WINDOW_MS) return false;
    const expected = 'sha256=' + require('crypto').createHmac('sha256', secret).update(JSON.stringify(payload) + '.' + ts).digest('hex');
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return require('crypto').timingSafeEqual(a, b);
  },
  showContent: (payload, secret) => {
    if (!payload || typeof payload !== 'object' || !payload.__wsonEncrypted) return payload;
    try {
      const key = __wsonDeriveKey(secret, 'wson-encrypt');
      const crypto_ = require('crypto');
      const iv = Buffer.from(payload.iv, 'base64');
      const authTag = Buffer.from(payload.authTag, 'base64');
      const decipher = crypto_.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch (e) {
      return null;
    }
  },
  parse: (payload, headers, secret) => {
    const from = headers ? headers['x-wson-from'] : undefined;
    const id = headers ? headers['x-wson-correlation-id'] : undefined;
    let content = payload;
    let signatureValid;
    let replayDetected = false;
    if (secret) {
      const timestamp = headers ? headers['x-wson-timestamp'] : undefined;
      signatureValid = WSON.verify(payload, headers ? headers['x-wson-signature'] : undefined, secret, timestamp);
      content = WSON.showContent(payload, secret);
      if (id && signatureValid) {
        const previos = WSON.history({ direction: 'received', id: id });
        if (previos.length > 0) replayDetected = true;
      }
    }
    __wsonRecord({ direction: 'received', from: from, content: content, id: id, signatureValid: signatureValid, replayDetected: replayDetected });
    return { from: from, id: id, content: content, signatureValid: signatureValid, replayDetected: replayDetected };
  },
  history: (filtros) => {
    let entries = [];
    try {
      const raw = require('fs').readFileSync(__wsonHistoryFile, 'utf8');
      entries = raw.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch (e) { return null; }
      }).filter((e) => e !== null);
    } catch (e) {
      entries = []; // el fichero no existe todavía (nada se ha enviado/recibido aún)
    }
    let results = entries;
    if (filtros) {
      if (filtros.direction) results = results.filter((e) => e.direction === filtros.direction);
      if (filtros.from) results = results.filter((e) => e.from === filtros.from);
      if (filtros.to) results = results.filter((e) => e.to === filtros.to);
      if (filtros.id) results = results.filter((e) => e.id === filtros.id);
      if (filtros.deadLetter) results = results.filter((e) => e.deadLetter === true);
    }
    return results.slice();
  },
  getSignature: (headers) => (headers ? headers['x-wson-signature'] : undefined),
  getTimestamp: (headers) => (headers ? headers['x-wson-timestamp'] : undefined),
};

function createSessionState() {

  // wson -- estructura de datos para describir un mensaje saliente (from/to/via/content). Declararla NO envía nada -- hace falta llamar a WSON.send(NOMBRE) explícitamente.
  let sender = { from: "servicio-de-pagos", to: ["http://ejemplo-a.invalido/recibir", "http://ejemplo-b.invalido/recibir"], content: "pago confirmado", secret: "clave-compartida" }; // server wson

  // get function -- corre cuando llega un GET a la URL de la propia ruta.
  // Async: puede hacer "await" a fetch()/http.* para llamar a otros sistemas y esperar
  // su respuesta antes de devolver la suya.
  async function verHistorial(query) {
    return { historial: WSON.history() }
  }

  // post function -- corre cuando llega un POST a la URL de la propia ruta.
  // Async: puede hacer "await" a fetch()/http.* para llamar a otros sistemas y esperar
  // su respuesta antes de devolver la suya.
  async function disparar(args) {
    var r = await WSON.send(sender)
    return { resultados: r }
  }

  return {
    verHistorial,
    disparar,
  };
}

module.exports = { createSessionState };
