const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const http = require("http");
const { parse } = require("../parser");
const { generateClientBundle } = require("../codegen-client");
const { renderPageToHTML } = require("../codegen-ssr");
const { createServer } = require("../codegen-server");

function mountAndCaptureError(bundle) {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => {
		error = msg;
	};
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	return { dom, error };
}

test("cliente: valor inicial que no coincide con el tipo declarado se rechaza al montar", () => {
	const source = ["reactive string nombre = 42", "visual app =", "<p>{nombre}</p>", "Visual.render(app)"].join("\n");
	const bundle = generateClientBundle(parse(source), {});
	const { error } = mountAndCaptureError(bundle);
	assert.match(error, /"nombre"/);
	assert.match(error, /string/);
});

test("cliente: valor inicial que SÍ coincide con el tipo declarado monta sin error", () => {
	const source = ['reactive string nombre = "Ana"', "visual app =", "<p>{nombre}</p>", "Visual.render(app)"].join("\n");
	const bundle = generateClientBundle(parse(source), {});
	const { error, dom } = mountAndCaptureError(bundle);
	assert.equal(error, null);
	assert.equal(dom.window.document.querySelector("p").textContent, "Ana");
});

test("cliente: reasignar con un tipo incorrecto se rechaza en el momento del clic, no al montar", () => {
	const source = [
		"reactive integer contador = 0",
		"visual app =",
		'<button onclick={contador = "no soy un entero"}>Romper</button>',
		"<p>{contador}</p>",
		"Visual.render(app)",
	].join("\n");
	const bundle = generateClientBundle(parse(source), {});
	const { dom, error: errorAlMontar } = mountAndCaptureError(bundle);
	assert.equal(errorAlMontar, null); // montaje inicial correcto

	let errorTrasClic = null;
	dom.window.onerror = (msg) => {
		errorTrasClic = msg;
	};
	dom.window.document.querySelector("button").dispatchEvent(new dom.window.Event("click"));
	assert.match(errorTrasClic, /"contador"/);
	assert.match(errorTrasClic, /integer/);
});

test("cliente: reasignar con un tipo correcto no lanza, y el valor se actualiza", () => {
	const source = [
		"reactive integer contador = 0",
		"visual app =",
		"<button onclick={contador = 5}>Cambiar</button>",
		"<p>{contador}</p>",
		"Visual.render(app)",
	].join("\n");
	const bundle = generateClientBundle(parse(source), {});
	const { dom, error } = mountAndCaptureError(bundle);
	assert.equal(error, null);

	dom.window.document.querySelector("button").dispatchEvent(new dom.window.Event("click"));
	assert.equal(dom.window.document.querySelector("p").textContent, "5");
});

test("cliente: sin tipo declarado, cualquier valor pasa (retrocompatible)", () => {
	const source = ["reactive contador = 0", "visual app =", "<p>{contador}</p>", "Visual.render(app)"].join("\n");
	const bundle = generateClientBundle(parse(source), {});
	const { dom, error } = mountAndCaptureError(bundle);
	assert.equal(error, null);
	dom.window.eval('state.contador = "cualquier cosa";');
	assert.equal(dom.window.document.querySelector("p").textContent, "cualquier cosa");
});

test("SSR: valor inicial que no coincide con el tipo declarado lanza al renderizar", () => {
	const source = ["reactive decimal precio = \"gratis\"", "visual app =", "<p>{precio}</p>", "Visual.render(app)"].join("\n");
	assert.throws(() => renderPageToHTML(parse(source), {}), /"precio"/);
});

test("SSR: valor inicial correcto no lanza", () => {
	const source = ["reactive decimal precio = 9.99", "visual app =", "<p>{precio}</p>", "Visual.render(app)"].join("\n");
	const html = renderPageToHTML(parse(source), {});
	assert.equal(html, "<p>9.99</p>");
});

// --- Servidor: además de validar, comprueba que NO tira el proceso -------

function get(port, path) {
	return new Promise((resolve, reject) => {
		http.get(`http://localhost:${port}${path}`, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode, body }));
		}).on("error", reject);
	});
}

test("servidor real: una var de servidor con tipo mal declarado responde 500 SIN tirar el proceso", async () => {
	const source = [
		'var integer visitas = "no soy un entero"',
		"",
		"const WSON wsonVisita =",
		'\t-> to: "/visita"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonVisita)",
		"",
		"watch(peticion)",
		"\tWSON.send(peticion)",
	].join("\n");

	const server = createServer(parse(source), {});
	try {
		await new Promise((resolve, reject) => {
			server.listen(0, resolve);
			server.on("error", reject);
		});
		const port = server.address().port;

		const res = await get(port, "/visita");
		assert.equal(res.status, 500);
		assert.match(JSON.parse(res.body).error, /"visitas"/);

		// El proceso sigue vivo: una segunda petición también responde
		// (antes de este arreglo, la primera ya habría tirado el proceso).
		const res2 = await get(port, "/visita");
		assert.equal(res2.status, 500);
	} finally {
		server.close();
	}
});

test("servidor real: una var de servidor con tipo bien declarado funciona con normalidad", async () => {
	const source = [
		"var integer visitas = 0",
		"",
		"const WSON wsonVisita =",
		'\t-> to: "/visita"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonVisita)",
		"",
		"watch(peticion)",
		"\tvisitas++",
		"\tpeticion.content = { visitas: visitas }",
		"\tWSON.send(peticion)",
	].join("\n");

	const server = createServer(parse(source), {});
	try {
		await new Promise((resolve, reject) => {
			server.listen(0, resolve);
			server.on("error", reject);
		});
		const port = server.address().port;

		const res = await get(port, "/visita");
		assert.equal(res.status, 200);
		assert.deepEqual(JSON.parse(res.body), { visitas: 1 });
	} finally {
		server.close();
	}
});
