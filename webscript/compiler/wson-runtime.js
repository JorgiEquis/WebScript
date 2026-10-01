// wson-runtime.js — WebScript, v0
//
// Implementación real (no simulada) de la API estática de WSON en
// servidor: firma HMAC-SHA256, cifrado AES-256-GCM, envío HTTP real,
// decodificación (no verificación) de JWT. Coherente con DISEÑO.md.
//
// Toda la API es estática — WSON.metodo(instancia, ...), nunca
// instancia.metodo() — según lo decidido en el diseño.

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutos, configurable a futuro

function timingSafeEqualStr(a, b) {
	const bufA = Buffer.from(String(a));
	const bufB = Buffer.from(String(b));
	if (bufA.length !== bufB.length) return false;
	return crypto.timingSafeEqual(bufA, bufB);
}

function sign(content, timestamp, secret) {
	return crypto.createHmac("sha256", secret).update(`${content}.${timestamp}`).digest("hex");
}

function verify(content, signature, secret, timestamp) {
	if (!secret || !signature || !timestamp) return false;
	if (Date.now() - Number(timestamp) > REPLAY_WINDOW_MS) return false; // fuera de ventana
	const expected = sign(content, timestamp, secret);
	return timingSafeEqualStr(expected, signature);
}

// AES-256-GCM: clave derivada del secret con una sal fija distinta a la
// de la firma (scrypt, determinista para que emisor/receptor deriven la
// misma clave a partir del mismo secret).
function deriveKey(secret) {
	return crypto.scryptSync(secret, "wson-encrypt-salt", 32);
}

function encryptContent(content, secret) {
	const iv = crypto.randomBytes(12);
	const key = deriveKey(secret);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(String(content), "utf8"), cipher.final()]);
	const authTag = cipher.getAuthTag();
	// iv + authTag + ciphertext, todo en base64, para viajar como un string.
	return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function showContent(content, secret) {
	if (!secret) return content; // no estaba cifrado
	try {
		const raw = Buffer.from(content, "base64");
		const iv = raw.subarray(0, 12);
		const authTag = raw.subarray(12, 28);
		const encrypted = raw.subarray(28);
		const key = deriveKey(secret);
		const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(authTag);
		const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
		return decrypted.toString("utf8");
	} catch {
		return null; // clave equivocada o contenido manipulado
	}
}

function getSignature(headers) {
	return headers["x-wson-signature"] || null;
}

function getTimestamp(headers) {
	return headers["x-wson-timestamp"] || null;
}

function getToken(headers) {
	const auth = headers["authorization"];
	if (!auth) return null;
	return auth.startsWith("Bearer ") ? auth.slice(7) : auth;
}

// Decodifica (NO descifra, NO verifica) un JWT: base64url de header y
// payload. Un JWT normal no está cifrado, solo codificado y firmado.
function showToken(token) {
	if (!token || typeof token !== "string") return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		const decode = (b64url) => JSON.parse(Buffer.from(b64url, "base64url").toString("utf8"));
		return { header: decode(parts[0]), payload: decode(parts[1]) };
	} catch {
		return null;
	}
}

// `secret` firma (o verifica la firma); `encrypt` es un flag APARTE — solo
// si está activo el content es de verdad ciphertext y hay que descifrarlo.
// Confundir "tiene secret" con "está cifrado" (como hacía una versión
// anterior de esta función) rompe el caso normal, mucho más frecuente,
// de firmar sin cifrar: showContent() intentaría descifrar texto plano y
// devolvería null.
function parse(args, headers, secret, encrypt) {
	const from = headers["x-wson-from"] || null;
	const id = headers["x-wson-correlation-id"] || null;
	const signature = getSignature(headers);
	const timestamp = getTimestamp(headers);

	const rawContent = typeof args === "string" ? args : JSON.stringify(args);
	const signatureValid = secret ? verify(rawContent, signature, secret, timestamp) : null;
	const content = encrypt ? showContent(rawContent, secret) : rawContent;

	return { from, id, content, signatureValid };
}

// Envío HTTP real. `instancia` es un objeto plano con to/via/content y,
// opcionalmente, secret/encrypt/authorization/id/createdAt.
function sendOne(instancia) {
	return new Promise((resolve, reject) => {
		const id = instancia.id || crypto.randomUUID();
		const createdAt = instancia.createdAt || new Date().toISOString();
		const timestamp = Date.now();
		const method = (instancia.via || "POST").toUpperCase();
		// GET/HEAD no llevan body — es HTTP en sí, no una elección nuestra
		// (muchos proxies/balanceadores reales lo descartan o lo rechazan).
		// El `content` de un GET se manda como query string en su lugar,
		// que es la forma estándar de mandar datos en una petición sin body.
		const isBodyless = method === "GET" || method === "HEAD";

		const url = new URL(instancia.to);
		if (isBodyless && instancia.content && typeof instancia.content === "object" && !Array.isArray(instancia.content)) {
			for (const [k, v] of Object.entries(instancia.content)) url.searchParams.set(k, String(v));
		}

		// Sin body, se firma sobre un content vacío — coherente con lo que
		// de verdad llega al otro lado (si se firmara sobre el content
		// completo pero no se mandara, la firma nunca verificaría).
		let bodyContent = isBodyless
			? ""
			: typeof instancia.content === "string"
				? instancia.content
				: JSON.stringify(instancia.content || {});
		if (instancia.encrypt && !isBodyless) {
			if (!instancia.secret) throw new Error("encrypt: true requiere secret");
			bodyContent = encryptContent(bodyContent, instancia.secret);
		}

		const headers = { "Content-Type": "application/json" };
		if (instancia.secret) {
			headers["X-WSON-Signature"] = sign(bodyContent, timestamp, instancia.secret);
			headers["X-WSON-Timestamp"] = String(timestamp);
		}
		if (instancia.from) headers["X-WSON-From"] = instancia.from;
		headers["X-WSON-Correlation-Id"] = id;
		if (instancia.authorization) headers["Authorization"] = instancia.authorization;

		const client = url.protocol === "https:" ? https : http;
		const reqHeaders = isBodyless ? headers : { ...headers, "Content-Length": Buffer.byteLength(bodyContent) };

		const req = client.request(url, { method, headers: reqHeaders }, (res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => resolve({ status: res.statusCode, body: data, id, createdAt }));
		});
		req.on("error", reject);
		if (!isBodyless) req.write(bodyContent);
		req.end();
	});
}

async function send(instancia) {
	if (Array.isArray(instancia.to)) {
		return Promise.all(
			instancia.to.map((to) =>
				sendOne({ ...instancia, to }).catch((err) => ({ status: null, error: err.message }))
			)
		);
	}
	return sendOne(instancia);
}

async function enqueue(instancia, { retries = 3, baseDelayMs = 200 } = {}) {
	// Fire-and-forget real: no se espera a que termine.
	(async () => {
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				await send(instancia);
				return;
			} catch {
				if (attempt === retries) return; // dead letter silencioso (sin history)
				await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
			}
		}
	})();
}

// `httpParams(instancia)`/`httpQuery(instancia)` leen `_params`/`_query` —
// campos que solo existen en la instancia real que crea createRequestHandler
// para una petición HTTP entrante (ver codegen-server.js). Cualquier otro
// caso — un WSON construido a mano para enviarlo con `send()`, un valor
// recibido por una `online function` (sin HTTP detrás), o una petición sin
// :params/query string — no tiene nada que devolver: `null`, nunca `{}`
// silencioso ni un `undefined` que reviente al desestructurar. Genéricas
// aquí (no solo dentro de un `watch()` de ruta) para que decir "esto no es
// una petición HTTP" sea gratis en cualquier sitio, sin duplicar la función.
function httpParams(instancia) {
	const p = instancia && instancia._params;
	return p && Object.keys(p).length > 0 ? p : null;
}

function httpQuery(instancia) {
	const q = instancia && instancia._query;
	return q && Object.keys(q).length > 0 ? q : null;
}

module.exports = {
	send,
	enqueue,
	httpParams,
	httpQuery,
	verify,
	showContent,
	encryptContent,
	sign,
	getSignature,
	getTimestamp,
	getToken,
	showToken,
	parse,
};
