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

function parse(args, headers, secret) {
	const from = headers["x-wson-from"] || null;
	const id = headers["x-wson-correlation-id"] || null;
	const signature = getSignature(headers);
	const timestamp = getTimestamp(headers);

	const rawContent = typeof args === "string" ? args : JSON.stringify(args);
	const signatureValid = secret ? verify(rawContent, signature, secret, timestamp) : null;
	const content = secret ? showContent(rawContent, secret) : rawContent;

	return { from, id, content, signatureValid };
}

// Envío HTTP real. `instancia` es un objeto plano con to/via/content y,
// opcionalmente, secret/encrypt/authorization/id/createdAt.
function sendOne(instancia) {
	return new Promise((resolve, reject) => {
		const id = instancia.id || crypto.randomUUID();
		const createdAt = instancia.createdAt || new Date().toISOString();
		const timestamp = Date.now();

		let bodyContent = typeof instancia.content === "string" ? instancia.content : JSON.stringify(instancia.content || {});
		if (instancia.encrypt) {
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
		if (instancia.httpCode) headers["X-WSON-Http-Code-Hint"] = String(instancia.httpCode); // informativo, no cifrado

		const url = new URL(instancia.to);
		const client = url.protocol === "https:" ? https : http;
		const method = instancia.via || "POST";

		const req = client.request(
			url,
			{ method, headers: { ...headers, "Content-Length": Buffer.byteLength(bodyContent) } },
			(res) => {
				let data = "";
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () => resolve({ status: res.statusCode, body: data, id, createdAt }));
			}
		);
		req.on("error", reject);
		req.write(bodyContent);
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

module.exports = {
	send,
	enqueue,
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
