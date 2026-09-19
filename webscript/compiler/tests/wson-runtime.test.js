const { test } = require("node:test");
const assert = require("node:assert/strict");
const WSON = require("../wson-runtime");

test("sign/verify: firma correcta se verifica", () => {
	const secret = "clave";
	const content = JSON.stringify({ a: 1 });
	const ts = Date.now();
	const firma = WSON.sign(content, ts, secret);
	assert.equal(WSON.verify(content, firma, secret, ts), true);
});

test("sign/verify: contenido manipulado no se verifica", () => {
	const secret = "clave";
	const content = JSON.stringify({ a: 1 });
	const ts = Date.now();
	const firma = WSON.sign(content, ts, secret);
	assert.equal(WSON.verify(content + "x", firma, secret, ts), false);
});

test("sign/verify: fuera de la ventana de validez (5 min) se rechaza", () => {
	const secret = "clave";
	const content = "hola";
	const tsViejo = Date.now() - 10 * 60 * 1000;
	const firma = WSON.sign(content, tsViejo, secret);
	assert.equal(WSON.verify(content, firma, secret, tsViejo), false);
});

test("encryptContent/showContent: cifrar y descifrar da el original", () => {
	const secret = "clave-compartida";
	const original = JSON.stringify({ nombre: "Ana" });
	const cifrado = WSON.encryptContent(original, secret);
	assert.equal(WSON.showContent(cifrado, secret), original);
});

test("showContent: secret equivocado devuelve null, no lanza excepción", () => {
	const cifrado = WSON.encryptContent("hola", "clave-buena");
	assert.equal(WSON.showContent(cifrado, "clave-mala"), null);
});

test("showContent: sin secret, devuelve el content tal cual (no estaba cifrado)", () => {
	assert.equal(WSON.showContent("texto plano", null), "texto plano");
});

test("getSignature/getTimestamp/getToken leen las cabeceras esperadas", () => {
	const headers = {
		"x-wson-signature": "abc",
		"x-wson-timestamp": "123",
		authorization: "Bearer eltoken",
	};
	assert.equal(WSON.getSignature(headers), "abc");
	assert.equal(WSON.getTimestamp(headers), "123");
	assert.equal(WSON.getToken(headers), "eltoken");
});

test("showToken: decodifica un JWT sin verificar la firma", () => {
	const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ sub: "123" })).toString("base64url");
	const jwt = `${header}.${payload}.firma-no-verificada`;
	const decoded = WSON.showToken(jwt);
	assert.deepEqual(decoded.payload, { sub: "123" });
});

test("showToken: con un string que no es un JWT devuelve null", () => {
	assert.equal(WSON.showToken("no-es-un-jwt"), null);
});
