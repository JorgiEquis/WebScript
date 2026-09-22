const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
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

test("REGRESIÓN bug real: WSON.send() con via GET, cliente real (fetch de Node) — antes reventaba siempre (GET no puede llevar body)", async () => {
	const SERVER_SOURCE = [
		"const WSON wsonEco =",
		'\t-> to: "/eco"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonEco)",
		"",
		"watch(peticion)",
		"\tpeticion.content = WSON.query(peticion)",
		"\tWSON.send(peticion)",
	].join("\n");

	const CLIENT_SOURCE = [
		'reactive resultado = ""',
		"",
		"visual app =",
		"<div>",
		'\t<button onclick={WSON.send({ to: "/eco", via: "GET", content: { nombre: "Ana" } }).then(r => resultado = JSON.stringify(r.body))}>Ir</button>',
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
			dom.window.fetch = fetch; // fetch real de Node — este es exactamente el que antes lanzaba TypeError
			let error = null;
			dom.window.onerror = (msg) => { error = msg; };

			const script = dom.window.document.createElement("script");
			script.textContent = bundle;
			dom.window.document.body.appendChild(script);
			if (error) { server.close(); resolveServer(); throw new Error(error); }

			const doc = dom.window.document;
			doc.querySelector("button").dispatchEvent(new dom.window.Event("click"));
			await new Promise((r) => setTimeout(r, 300));

			if (error) { server.close(); resolveServer(); throw new Error(error); }
			assert.deepEqual(JSON.parse(doc.querySelector("p").textContent), { nombre: "Ana" });

			server.close();
			resolveServer();
		});
	});
});

test("REGRESIÓN bug real: una función importada de .ws que depende de una reactive 'hermana' (no exportada explícitamente) funciona, en vez de ReferenceError", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-ws-hermana-"));
	fs.writeFileSync(
		path.join(dir, "util.ws"),
		["reactive contador = 0", "", "export function incrementarYObtener()", "\tcontador = contador + 1", "\treturn contador"].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "app.wsf"),
		[
			'import { incrementarYObtener } from "./util.ws"',
			"",
			"reactive resultado = 0",
			"",
			"visual app =",
			"<div>",
			"\t<button onclick={resultado = incrementarYObtener()}>Sumar</button>",
			"\t<p>{resultado}</p>",
			"</div>",
			"",
			"Visual.render(app)",
		].join("\n")
	);

	const bundle = generateClientBundle(parse(fs.readFileSync(path.join(dir, "app.wsf"), "utf8")), { baseDir: dir });
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	const doc = dom.window.document;
	doc.querySelector("button").dispatchEvent(new dom.window.Event("click"));
	assert.equal(doc.querySelector("p").textContent, "1");
	doc.querySelector("button").dispatchEvent(new dom.window.Event("click"));
	assert.equal(doc.querySelector("p").textContent, "2"); // persiste de verdad, no es un valor perdido
});

test("REGRESIÓN bug real: una function declarada DIRECTAMENTE en el propio .wsf viaja al bundle de cliente (antes solo se traían las importadas de un .ws)", () => {
	const source = [
		"function duplicar(n)",
		"\treturn n * 2",
		"",
		"reactive resultado = 0",
		"",
		"visual app =",
		"<div>",
		"\t<button onclick={resultado = duplicar(21)}>Duplicar</button>",
		"\t<p>{resultado}</p>",
		"</div>",
		"",
		"Visual.render(app)",
	].join("\n");

	const bundle = generateClientBundle(parse(source), {});
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	dom.window.document.querySelector("button").dispatchEvent(new dom.window.Event("click"));
	assert.equal(dom.window.document.querySelector("p").textContent, "42");
});

test("REGRESIÓN bug real: una function del propio .wsf importada por OTRO .wsf (dentro de un componente) también viaja al bundle", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-fn-importada-"));
	fs.writeFileSync(
		path.join(dir, "tarjeta.wsf"),
		[
			"function formatear(n)",
			'\treturn "Valor: " + (n * 2)',
			"",
			"reactive contador = 5",
			"",
			"visual tarjeta =",
			"<div>",
			"\t<p>{formatear(contador)}</p>",
			"</div>",
		].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "app.wsf"),
		['import { tarjeta } from "./tarjeta.wsf"', "", "visual app =", "<div>", "\t<tarjeta />", "</div>", "", "Visual.render(app)"].join(
			"\n"
		)
	);

	const bundle = generateClientBundle(parse(fs.readFileSync(path.join(dir, "app.wsf"), "utf8")), { baseDir: dir });
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	assert.equal(dom.window.document.querySelector("p").textContent, "Valor: 10");
});

test("REGRESIÓN bug real: un const/var declarado en otro .wsf viaja al importarlo (antes no viajaba en absoluto: ReferenceError)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-constvar-wsf-"));
	fs.writeFileSync(
		path.join(dir, "valores.wsf"),
		['const saludo = "hola desde otro fichero"', "var contadorCompartido = 100"].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "app.wsf"),
		[
			'import { saludo, contadorCompartido } from "./valores.wsf"',
			"",
			"visual app =",
			"<div>",
			"\t<p>{saludo}</p>",
			"\t<p>{contadorCompartido}</p>",
			"</div>",
			"",
			"Visual.render(app)",
		].join("\n")
	);

	const bundle = generateClientBundle(parse(fs.readFileSync(path.join(dir, "app.wsf"), "utf8")), { baseDir: dir });
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	const ps = dom.window.document.querySelectorAll("p");
	assert.equal(ps[0].textContent, "hola desde otro fichero");
	assert.equal(ps[1].textContent, "100");
});

test("REGRESIÓN bug real: un const/var declarado en un .ws viaja al importarlo desde un .wsf", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-constvar-ws-"));
	fs.writeFileSync(path.join(dir, "valores.ws"), ['const saludoWs = "hola desde .ws"', "var contadorWs = 200"].join("\n"));
	fs.writeFileSync(
		path.join(dir, "app.wsf"),
		[
			'import { saludoWs, contadorWs } from "./valores.ws"',
			"",
			"visual app =",
			"<div>",
			"\t<p>{saludoWs}</p>",
			"\t<p>{contadorWs}</p>",
			"</div>",
			"",
			"Visual.render(app)",
		].join("\n")
	);

	const bundle = generateClientBundle(parse(fs.readFileSync(path.join(dir, "app.wsf"), "utf8")), { baseDir: dir });
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	const ps = dom.window.document.querySelectorAll("p");
	assert.equal(ps[0].textContent, "hola desde .ws");
	assert.equal(ps[1].textContent, "200");
});

test("REGRESIÓN bug real: un DTO de .wson se puede importar y usar en cliente (con new), antes no soportado en absoluto", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-dto-cliente-"));
	fs.writeFileSync(
		path.join(dir, "persona.wson"),
		['-> from: "app"', '-> to: "/personas"', '-> via: "POST"', "-> content:", "\tnombre: string", "\tedad: integer"].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "app.wsf"),
		[
			'import { Persona } from "./persona.wson"',
			"",
			'reactive persona = new Persona("Ana", 30)',
			"",
			"visual app =",
			"<p>{persona.nombre}</p>",
			"",
			"Visual.render(app)",
		].join("\n")
	);

	const bundle = generateClientBundle(parse(fs.readFileSync(path.join(dir, "app.wsf"), "utf8")), { baseDir: dir });
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	assert.equal(dom.window.document.querySelector("p").textContent, "Ana");

	// La validación de tipo del DTO funciona de verdad en cliente, tanto en
	// el constructor como en una reasignación posterior.
	const errConstructor = dom.window.eval(
		'(() => { try { new Persona("Ana", "no es un entero"); return null; } catch (e) { return e.message; } })()'
	);
	assert.match(errConstructor, /"edad".*integer/);

	const errReasignacion = dom.window.eval(
		'(() => { const p = new Persona("Ana", 30); try { p.edad = "texto"; return null; } catch (e) { return e.message; } })()'
	);
	assert.match(errReasignacion, /"edad".*integer/);
});

test("REGRESIÓN nueva capacidad: import por defecto de un .json embebe su contenido entero como const literal en el bundle", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-json-import-"));
	fs.writeFileSync(path.join(dir, "posts.json"), JSON.stringify([{ slug: "a" }, { slug: "b" }]));
	fs.writeFileSync(
		path.join(dir, "app.wsf"),
		[
			'import posts from "./posts.json"',
			"",
			"visual app =",
			"<p>{posts.length}</p>",
			"",
			"Visual.render(app)",
		].join("\n")
	);

	const bundle = generateClientBundle(parse(fs.readFileSync(path.join(dir, "app.wsf"), "utf8")), { baseDir: dir });
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	assert.equal(dom.window.document.querySelector("p").textContent, "2");
});

test("import { campo } de un .json (con llaves): solo esa propiedad, no el fichero entero", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-json-import-llaves-"));
	fs.writeFileSync(path.join(dir, "datos.json"), JSON.stringify({ posts: [{ slug: "a" }], otraCosa: "x" }));
	fs.writeFileSync(
		path.join(dir, "app.wsf"),
		[
			'import { posts } from "./datos.json"',
			"",
			"visual app =",
			"<p>{posts[0].slug}</p>",
			"",
			"Visual.render(app)",
		].join("\n")
	);

	const bundle = generateClientBundle(parse(fs.readFileSync(path.join(dir, "app.wsf"), "utf8")), { baseDir: dir });
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	assert.equal(dom.window.document.querySelector("p").textContent, "a");
});

test("REGRESIÓN nueva capacidad: un <a href> interno normal (sin onclick) navega sin recargar la página", () => {
	const source = [
		"const Visual screen = Visual.route('/blog/:slug')",
		"const {slug} = Visual.params(screen)",
		"",
		"visual app =",
		"<div>",
		'\t<a href="/blog/otro-post">Ir a otro post</a>',
		"\t<p>{slug}</p>",
		"</div>",
		"",
		"Visual.render(app)",
	].join("\n");

	const bundle = generateClientBundle(parse(source), {});
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
		runScripts: "dangerously",
		url: "http://localhost/blog/mi-primer-post",
	});
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	assert.equal(dom.window.document.querySelector("p").textContent, "mi-primer-post");
	const ev = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
	dom.window.document.querySelector("a").dispatchEvent(ev);

	assert.equal(ev.defaultPrevented, true); // interceptado: no debe recargar
	assert.equal(dom.window.document.querySelector("p").textContent, "otro-post");
	assert.equal(dom.window.location.pathname, "/blog/otro-post");
});

test("la interceptación de enlaces respeta los casos que NO se deben interceptar", () => {
	const source = [
		"visual app =",
		"<div>",
		'\t<a id="externo" href="https://ejemplo.com">Externo</a>',
		'\t<a id="blank" href="/algo" target="_blank">Nueva pestaña</a>',
		'\t<a id="descarga" href="/archivo.pdf" download>Descargar</a>',
		'\t<a id="ancla" href="#seccion">Ancla</a>',
		'\t<a id="mailto" href="mailto:a@b.com">Email</a>',
		"</div>",
		"",
		"Visual.render(app)",
	].join("\n");

	const bundle = generateClientBundle(parse(source), {});
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
		runScripts: "dangerously",
		url: "http://localhost/inicio",
	});
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);

	for (const id of ["externo", "blank", "descarga", "ancla", "mailto"]) {
		const el = dom.window.document.getElementById(id);
		const ev = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
		el.dispatchEvent(ev);
		assert.equal(ev.defaultPrevented, false, `"${id}" no debería interceptarse`);
	}

	const interno = dom.window.document.createElement("a");
	interno.href = "/otra-pagina";
	dom.window.document.body.appendChild(interno);
	const evCtrl = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
	interno.dispatchEvent(evCtrl);
	assert.equal(evCtrl.defaultPrevented, false, "un enlace interno con ctrl+clic no debería interceptarse");
});

test("REGRESIÓN nueva capacidad: import de un .js normal (CommonJS) funciona en cliente, como vía de adopción incremental", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-js-import-"));
	fs.writeFileSync(
		path.join(dir, "utilidades.js"),
		['function saludar(nombre) {', '\treturn "Hola, " + nombre + "!";', "}", "module.exports = { saludar };"].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "app.wsf"),
		[
			'import { saludar } from "./utilidades.js"',
			"",
			'reactive resultado = ""',
			"",
			"visual app =",
			"<div>",
			'\t<button onclick={resultado = saludar("Ana")}>Saludar</button>',
			"\t<p>{resultado}</p>",
			"</div>",
			"",
			"Visual.render(app)",
		].join("\n")
	);

	const bundle = generateClientBundle(parse(fs.readFileSync(path.join(dir, "app.wsf"), "utf8")), { baseDir: dir });
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	dom.window.document.querySelector("button").dispatchEvent(new dom.window.Event("click"));
	assert.equal(dom.window.document.querySelector("p").textContent, "Hola, Ana!");
});

test("import de un paquete npm desde el cliente se rechaza con un mensaje claro (sin bundler, a diferencia del servidor)", () => {
	const source = [
		'import { algo } from "chalk"',
		"",
		"visual app =",
		"<p>hola</p>",
		"",
		"Visual.render(app)",
	].join("\n");

	assert.throws(() => generateClientBundle(parse(source), { baseDir: "/tmp" }), /No se puede importar el paquete "chalk" desde el cliente/);
});

test("REGRESIÓN nueva capacidad: import de un .wsdb desde el cliente se rechaza con un mensaje claro (una base de datos es cosa de servidor)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-wsdb-cliente-"));
	fs.writeFileSync(
		path.join(dir, "usuarios.wsdb"),
		['-> collection: "usuarios"', "-> schema:", "\tnombre: string"].join("\n")
	);
	const source = [
		'import { Usuario } from "./usuarios.wsdb"',
		"",
		"visual app =",
		"<p>hola</p>",
		"",
		"Visual.render(app)",
	].join("\n");

	assert.throws(
		() => generateClientBundle(parse(source), { baseDir: dir }),
		/No se puede importar "\.\/usuarios\.wsdb" desde el cliente/
	);
});
