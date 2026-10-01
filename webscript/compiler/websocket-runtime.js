// websocket-runtime.js — WebSocket propio de WebScript (RFC 6455), sin
// dependencias — solo `crypto`, `net`, `tls`, `http` del propio Node.
//
// Es transporte puro: sabe hacer el saludo (como servidor que acepta un
// `upgrade`, o como cliente que lo inicia) y trocear bytes en *frames* —
// nada sabe aquí de `WSON`, de `online function`, de reconexión con
// backoff, ni de idempotencia. Eso vive en capas por encima (wsclient-
// runtime.js), igual que TCP no sabe nada de AMQP.
//
// Verificado contra el vector de prueba oficial de la RFC 6455 (§1.3):
// con Sec-WebSocket-Key "dGhlIHNhbXBsZSBub25jZQ==" da como resultado
// "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" — coincide exactamente.

const crypto = require("crypto");
const net = require("net");
const tls = require("tls");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function acceptKeyFor(clientKey) {
	return crypto.createHash("sha1").update(clientKey + GUID).digest("base64");
}

// --- Codificación de un frame ------------------------------------------

// `mask`: true para cliente→servidor (RFC 6455 lo exige), false para
// servidor→cliente (el servidor NUNCA enmascara, es parte del protocolo).
function encodeFrame(payload, { opcode = OPCODE.TEXT, mask = false, fin = true } = {}) {
	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
	const len = data.length;

	let header;
	if (len < 126) {
		header = Buffer.alloc(2);
		header[1] = len;
	} else if (len <= 0xffff) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		// BigInt para los 8 bytes de longitud extendida — un mensaje de
		// más de 65535 bytes es un caso real (una respuesta grande), no
		// solo teórico, y writeUInt32BE a secas no cubriría más de 4 GB
		// de forma correcta si algún día hiciera falta.
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);

	if (!mask) return Buffer.concat([header, data]);

	header[1] |= 0x80;
	const maskKey = crypto.randomBytes(4);
	const masked = Buffer.alloc(len);
	for (let i = 0; i < len; i++) masked[i] = data[i] ^ maskKey[i % 4];
	return Buffer.concat([header, maskKey, masked]);
}

// --- Decodificación: un parser con estado, alimentado por el socket ----
//
// Un frame puede llegar troceado entre varios eventos "data" del socket
// (TCP no respeta los límites de mensaje), así que se acumula en un
// buffer propio y se van extrayendo frames completos según se pueda.
// Los `PING` se responden solos con un `PONG` (parte obligatoria del
// protocolo); todo lo demás se entrega tal cual a quien use este parser.
class FrameParser {
	constructor(socket, { maxFrameBytes = 16 * 1024 * 1024 } = {}) {
		this.socket = socket;
		this.buffer = Buffer.alloc(0);
		this.maxFrameBytes = maxFrameBytes;
		this.handlers = { message: [], close: [], error: [] };
		this._fragments = null; // { opcode, chunks: [] } — mensaje fragmentado en curso
		socket.on("data", (chunk) => this._onData(chunk));
		socket.on("error", (err) => this._emit("error", err));
		socket.on("close", () => this._emit("close"));
		// Cuando el otro lado manda FIN (cierre TCP normal, sin pasar por un
		// frame CLOSE de WebSocket — puede pasar, no todo el mundo cierra
		// "bien"), hay que cerrar también este lado explícitamente. Node no
		// lo hace solo en todos los casos (depende de si el socket de
		// partida tenía allowHalfOpen), y sin esto el socket se queda medio
		// abierto — vivo para el sistema operativo aunque ya no sirva para
		// nada, lo que mantiene el proceso despierto indefinidamente.
		socket.on("end", () => socket.end());
	}

	on(event, fn) {
		if (!this.handlers[event]) throw new Error(`FrameParser: evento desconocido "${event}"`);
		this.handlers[event].push(fn);
		return this;
	}

	once(event, fn) {
		const wrapper = (...args) => {
			this.handlers[event] = this.handlers[event].filter((h) => h !== wrapper);
			fn(...args);
		};
		return this.on(event, wrapper);
	}

	_emit(event, ...args) {
		for (const fn of this.handlers[event]) fn(...args);
	}

	_onData(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		// Cualquier frame mal formado (un CONTINUATION suelto, una longitud
		// disparatada, lo que sea) NUNCA debe lanzar desde aquí — esto corre
		// dentro de un manejador del evento "data" del socket; una excepción
		// sin capturar en ese punto no es "esta conexión falla", es "el
		// proceso entero de Node se cae", tumbando de paso cualquier otra
		// conexión que el servidor tuviera abierta. Un cliente que manda
		// basura solo puede perder SU propia conexión.
		try {
			for (;;) {
				const frame = this._tryReadFrame();
				if (!frame) return; // no hay un frame completo todavía — esperar más "data"
				this._handleFrame(frame);
			}
		} catch (err) {
			this._fail(err.message);
		}
	}

	// Cierra la conexión de forma ordenada tras un error de protocolo —
	// nunca deja el error sin manejar ni mantiene el socket a medias.
	// A diferencia del EventEmitter nativo de Node (que revienta si nadie
	// escucha "error"), aquí "nadie escuchando" es seguro por defecto: la
	// conexión se cierra igual, solo que sin que nadie se entere del
	// motivo — nunca hace caer el proceso por descuido de quien lo usa.
	_fail(message) {
		this._emit("error", new Error(`WebSocket: ${message}`));
		this.socket.destroy();
	}

	// Devuelve { fin, opcode, payload } y consume esos bytes de this.buffer,
	// o `null` si aún no hay suficientes bytes para un frame completo.
	_tryReadFrame() {
		const buf = this.buffer;
		if (buf.length < 2) return null;

		const fin = (buf[0] & 0x80) !== 0;
		const opcode = buf[0] & 0x0f;
		const masked = (buf[1] & 0x80) !== 0;
		let len = buf[1] & 0x7f;
		let offset = 2;

		if (len === 126) {
			if (buf.length < offset + 2) return null;
			len = buf.readUInt16BE(offset);
			offset += 2;
		} else if (len === 127) {
			if (buf.length < offset + 8) return null;
			const big = buf.readBigUInt64BE(offset);
			if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame declara un tamaño no representable");
			len = Number(big);
			offset += 8;
		}
		// Se comprueba en cuanto se conoce la longitud DECLARADA, no cuando
		// ya haya llegado entera — si no, un frame que promete un tamaño
		// enorme y manda los bytes goteando muy despacio haría crecer este
		// búfer sin límite mientras se espera el resto, para siempre.
		if (len > this.maxFrameBytes) throw new Error(`frame de ${len} bytes supera el máximo permitido (${this.maxFrameBytes})`);

		let maskKey = null;
		if (masked) {
			if (buf.length < offset + 4) return null;
			maskKey = buf.subarray(offset, offset + 4);
			offset += 4;
		}

		if (buf.length < offset + len) return null; // el payload todavía no ha llegado entero

		let payload = buf.subarray(offset, offset + len);
		if (masked) {
			const unmasked = Buffer.alloc(len);
			for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
			payload = unmasked;
		} else {
			payload = Buffer.from(payload); // copia — subarray comparte memoria con this.buffer, que se reasigna a continuación
		}

		this.buffer = buf.subarray(offset + len);
		return { fin, opcode, payload };
	}

	_handleFrame({ fin, opcode, payload }) {
		if (opcode === OPCODE.PING) {
			this.socket.write(encodeFrame(payload, { opcode: OPCODE.PONG, mask: this.isClient }));
			return;
		}
		if (opcode === OPCODE.PONG) return; // sin acción — basta con que la conexión siga viva
		if (opcode === OPCODE.CLOSE) {
			// El protocolo exige devolver un CLOSE antes de cortar, si
			// todavía no se había mandado uno propio — sin esto, la otra
			// parte no tiene forma de distinguir un cierre limpio de la
			// conexión cortándose sin más.
			if (!this._closeSent) {
				this._closeSent = true;
				this.socket.write(encodeFrame(payload, { opcode: OPCODE.CLOSE, mask: this.isClient }));
			}
			this.socket.end();
			return;
		}

		// Mensaje fragmentado: opcode real solo en el primer frame (CONTINUATION en los siguientes).
		if (opcode === OPCODE.CONTINUATION) {
			if (!this._fragments) throw new Error("frame de continuación sin un mensaje fragmentado en curso");
			this._fragments.chunks.push(payload);
			if (!fin) return;
			const full = Buffer.concat(this._fragments.chunks);
			const finishedOpcode = this._fragments.opcode;
			this._fragments = null;
			this._deliver(finishedOpcode, full);
			return;
		}
		if (!fin) {
			this._fragments = { opcode, chunks: [payload] };
			return;
		}
		this._deliver(opcode, payload);
	}

	_deliver(opcode, payload) {
		this._emit("message", { opcode, payload, text: opcode === OPCODE.TEXT ? payload.toString("utf8") : null });
	}
}

// --- Servidor: aceptar un `upgrade` de http.Server ----------------------
//
// `req`/`socket`/`head` son exactamente los argumentos del evento
// "upgrade" de un http.Server normal — esto no crea ningún servidor
// propio, se engancha al que ya existe.
function acceptUpgrade(req, socket, head) {
	const key = req.headers["sec-websocket-key"];
	if (req.headers["upgrade"]?.toLowerCase() !== "websocket" || !key) {
		socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		return null;
	}
	const accept = acceptKeyFor(key);
	socket.write(
		["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n")
	);
	const parser = new FrameParser(socket);
	parser.isClient = false; // el servidor nunca enmascara sus frames salientes
	if (head && head.length) socket.unshift(head); // bytes que ya hubieran llegado junto al handshake
	return { socket, parser, send: (data) => socket.write(encodeFrame(data, { mask: false })) };
}

// --- Cliente: iniciar la conexión hacia un servidor WebSocket -----------
//
// Sin ninguna librería HTTP de cliente — el handshake de WebSocket es, en
// sí mismo, solo texto plano sobre el socket antes de que empiecen los
// frames, así que se escribe a mano sobre `net`/`tls` directamente.
function connect(urlString, { headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		let url;
		try {
			url = new URL(urlString);
		} catch {
			reject(new Error(`WebSocket: URL no válida "${urlString}"`));
			return;
		}
		if (url.protocol !== "ws:" && url.protocol !== "wss:") {
			reject(new Error(`WebSocket: esquema no soportado "${url.protocol}" (usa ws:// o wss://)`));
			return;
		}
		const isSecure = url.protocol === "wss:";
		const port = url.port ? Number(url.port) : isSecure ? 443 : 80;
		const key = crypto.randomBytes(16).toString("base64");

		const socket = isSecure ? tls.connect({ host: url.hostname, port, servername: url.hostname }) : net.connect({ host: url.hostname, port });
		let settled = false;
		const fail = (err) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(err);
		};
		socket.on("error", fail);

		socket.once("connect", () => {
			const path = url.pathname + url.search || "/";
			const reqHeaders = {
				Host: url.host,
				Upgrade: "websocket",
				Connection: "Upgrade",
				"Sec-WebSocket-Key": key,
				"Sec-WebSocket-Version": "13",
				...headers,
			};
			const lines = [`GET ${path} HTTP/1.1`, ...Object.entries(reqHeaders).map(([k, v]) => `${k}: ${v}`), "", ""];
			socket.write(lines.join("\r\n"));
		});

		// El handshake es texto HTTP normal, línea a línea, ANTES de que
		// empiecen los frames binarios — se lee a mano hasta la línea en
		// blanco que cierra las cabeceras, y lo que sobre después de esa
		// línea son ya bytes de frames (poco probable en la respuesta del
		// saludo, pero hay que contarlo).
		let headerBuf = Buffer.alloc(0);
		function onHandshakeData(chunk) {
			headerBuf = Buffer.concat([headerBuf, chunk]);
			const idx = headerBuf.indexOf("\r\n\r\n");
			if (idx === -1) return;
			socket.removeListener("data", onHandshakeData);

			const headerText = headerBuf.subarray(0, idx).toString("latin1");
			const rest = headerBuf.subarray(idx + 4);
			const [statusLine, ...headerLines] = headerText.split("\r\n");
			const statusMatch = /^HTTP\/1\.1 (\d+)/.exec(statusLine);
			const status = statusMatch ? Number(statusMatch[1]) : 0;
			const respHeaders = {};
			for (const line of headerLines) {
				const i = line.indexOf(":");
				if (i === -1) continue;
				respHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
			}

			if (status !== 101) {
				fail(new Error(`WebSocket: el servidor respondió ${status || "sin código HTTP válido"} en vez de 101`));
				return;
			}
			const expected = acceptKeyFor(key);
			if (respHeaders["sec-websocket-accept"] !== expected) {
				fail(new Error("WebSocket: Sec-WebSocket-Accept no coincide — el servidor no completó el saludo correctamente"));
				return;
			}

			settled = true;
			const parser = new FrameParser(socket);
			parser.isClient = true; // el cliente SIEMPRE enmascara sus frames salientes (obligatorio en la RFC)
			if (rest.length) socket.unshift(rest);
			resolve({ socket, parser, send: (data) => socket.write(encodeFrame(data, { mask: true })) });
		}
		socket.on("data", onHandshakeData);
	});
}

module.exports = { acceptUpgrade, connect, encodeFrame, FrameParser, OPCODE, acceptKeyFor };
