const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { parse } = require("../parser");
const {
	substituteReactive,
	splitInterpolations,
	groupChildren,
	groupSlotContent,
	generateClientBundle,
} = require("../codegen-client");

test("substituteReactive sustituye identificador con límite de palabra", () => {
	assert.equal(substituteReactive("contador + 1", ["contador"]), "state.contador + 1");
});

test("substituteReactive no toca accesos de propiedad (obj.nombre)", () => {
	assert.equal(substituteReactive("props.item.valor", ["valor"]), "props.item.valor");
});

test("substituteReactive no sustituye prefijos parciales (contadorTotal no es contador)", () => {
	assert.equal(substituteReactive("contadorTotal", ["contador"]), "contadorTotal");
});

test("splitInterpolations separa literal e interpolación", () => {
	const parts = splitInterpolations("Valor: {contador} unidades");
	assert.deepEqual(parts, [{ literal: "Valor: " }, { expr: "contador" }, { literal: " unidades" }]);
});

test("splitInterpolations respeta llaves anidadas dentro de la interpolación", () => {
	const parts = splitInterpolations("{f({a: 1})}");
	assert.equal(parts.length, 1);
	assert.equal(parts[0].expr, "f({a: 1})");
});

test("groupChildren agrupa If + ElseIf + Else en un único IfChain", () => {
	const children = [
		{ type: "If", cond: "a" },
		{ type: "ElseIf", cond: "b" },
		{ type: "Else" },
		{ type: "Element", name: "ul" },
	];
	const groups = groupChildren(children);
	assert.equal(groups.length, 2); // IfChain + <ul>
	assert.equal(groups[0].type, "IfChain");
	assert.equal(groups[0].chain.length, 3);
	assert.equal(groups[1].type, "Element");
});

test("groupChildren no fusiona un If con un Element que no sea ElseIf/Else", () => {
	const children = [{ type: "If", cond: "a" }, { type: "Element", name: "ul" }];
	const groups = groupChildren(children);
	assert.equal(groups.length, 2);
	assert.equal(groups[0].chain.length, 1); // If solo, sin arrastrar el <ul>
});

test("groupSlotContent: sin atributo slot va a 'default'", () => {
	const children = [{ type: "Element", name: "ul", attrs: [], children: [] }];
	const groups = groupSlotContent(children);
	assert.equal(groups.default.length, 1);
});

test("groupSlotContent: con slot=\"nombre\" va a ese hueco, no a default", () => {
	const children = [
		{ type: "Element", name: "h3", attrs: [{ key: "slot", value: '"header"' }], children: [] },
		{ type: "Element", name: "ul", attrs: [], children: [] },
	];
	const groups = groupSlotContent(children);
	assert.equal(groups.header.length, 1);
	assert.equal(groups.header[0].name, "h3");
	assert.equal(groups.default.length, 1);
	assert.equal(groups.default[0].name, "ul");
});

test("WSON ad-hoc en un .wsf se traduce a un objeto plano real", () => {
	const source = ['const WSON x =', '\t-> to: "/algo"', '\t-> via: "POST"'].join("\n");
	const bundle = generateClientBundle(parse(source));
	assert.match(bundle, /const x = \{ to: "\/algo", via: "POST", content: \{\} \};/);
});

test("secret en un WSON de cliente se rechaza en compilación", () => {
	const source = ['const WSON x =', '\t-> to: "/algo"', '\t-> via: "POST"', '\t-> secret: "xxx"'].join("\n");
	assert.throws(() => generateClientBundle(parse(source)), /secret\/encrypt no están permitidos en un WSON de cliente/);
});

const { createServer } = require("../codegen-server");

test("integración real de extremo a extremo: clic en el navegador -> fetch real -> servidor HTTP real", async () => {
	const SERVER_SOURCE = [
		'const WSON wsonCrearNota =',
		'\t-> to: "/notas"',
		'\t-> via: "POST"',
		"",
		"reactive any peticion = WSON.listen(wsonCrearNota)",
		"",
		"watch(peticion)",
		"\tvar contenido = WSON.showContent(peticion, null)",
		"\tpeticion.httpCode = 201",
		'\tpeticion.content = { mensaje: "recibido", texto: contenido.texto }',
		"\tWSON.send(peticion)",
	].join("\n");

	const CLIENT_SOURCE = [
		"const WSON wsonCrearNota =",
		'\t-> to: "/notas"',
		'\t-> via: "POST"',
		"",
		'reactive resultado = ""',
		"",
		"visual app =",
		"<div>",
		'\t<button onclick={wsonCrearNota.content = { texto: "hola" }; WSON.send(wsonCrearNota).then(r => resultado = JSON.stringify(r.body))}>Enviar</button>',
		"\t<p>{resultado}</p>",
		"</div>",
		"",
		"Visual.render(app)",
	].join("\n");

	const server = createServer(parse(SERVER_SOURCE), {});

	await new Promise((resolveServer) => {
		server.listen(0, async () => {
			const port = server.address().port;
			const bundle = generateClientBundle(parse(CLIENT_SOURCE));

			const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
				runScripts: "dangerously",
				url: `http://localhost:${port}/`,
			});
			dom.window.fetch = fetch; // fetch real de Node, ninguna simulación
			let error = null;
			dom.window.onerror = (msg) => { error = msg; };

			const script = dom.window.document.createElement("script");
			script.textContent = bundle;
			dom.window.document.body.appendChild(script);
			if (error) { server.close(); resolveServer(); throw new Error(error); }

			const doc = dom.window.document;
			assert.equal(doc.querySelector("p").textContent, "");

			doc.querySelector("button").dispatchEvent(new dom.window.Event("click"));
			await new Promise((r) => setTimeout(r, 300));

			assert.deepEqual(JSON.parse(doc.querySelector("p").textContent), {
				mensaje: "recibido",
				texto: "hola",
			});

			server.close();
			resolveServer();
		});
	});
});
