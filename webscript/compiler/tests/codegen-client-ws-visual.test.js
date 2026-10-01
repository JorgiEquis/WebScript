// Una `visual nombre = ` declarada en un `.ws` (sin `export`, igual que ya
// ocurre para la de un `.wsf` — nunca lo necesitó) es importable desde
// cualquier `.wsf`, igual que si viniera de otro `.wsf`. Antes, aunque la
// gramática ya admitía un VisualDecl dentro de un `.ws` (se parsea igual de
// bien), el mecanismo de import lo encontraba (`ws.declaredByName`) pero no
// hacía NADA con él — ni error, ni se añadía a `result.visualDecls` — así
// que `<Tarjeta/>` se renderizaba como una etiqueta HTML desconocida en vez
// de como el componente.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { JSDOM, VirtualConsole } = require("jsdom");
const { parse } = require("../parser");
const { generateClientBundle } = require("../codegen-client");
const { renderPageToHTML } = require("../codegen-ssr");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-ws-visual-"));
}

function crear(dir, ficheros) {
	for (const [nombre, contenido] of Object.entries(ficheros)) {
		fs.writeFileSync(path.join(dir, nombre), Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
}

function ejecutarCliente(dir, wsf) {
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	const bundle = generateClientBundle(parse(wsf), { baseDir: dir });
	const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, { runScripts: "dangerously", virtualConsole: new VirtualConsole() });
	let error = null;
	dom.window.addEventListener("error", (e) => {
		error = e.message;
	});
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);
	return { html, doc: dom.window.document, bundle };
}

test("REGRESIÓN: una visual de un .ws se renderiza como componente, no como etiqueta desconocida — SSR", () => {
	const dir = tmpDir();
	crear(dir, { "piezas.ws": ["visual Tarjeta =", '<div class="tarjeta">{props.titulo}</div>'] });
	const wsf = ['import { Tarjeta } from "./piezas.ws"', "", '<Tarjeta titulo="hola" />'].join("\n");
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	assert.match(html, /<div class="tarjeta">(?:<!--t-->)?hola/);
	assert.doesNotMatch(html, /<Tarjeta/);
});

test("REGRESIÓN: lo mismo, ejecutado de verdad en el cliente (hidratación real)", () => {
	const dir = tmpDir();
	crear(dir, { "piezas.ws": ["visual Tarjeta =", '<div class="tarjeta">{props.titulo}</div>'] });
	const wsf = ['import { Tarjeta } from "./piezas.ws"', "", '<Tarjeta titulo="hola" />'].join("\n");
	const { doc } = ejecutarCliente(dir, wsf);
	assert.equal(doc.querySelector(".tarjeta").textContent, "hola");
});

test("REGRESIÓN: la visual de un .ws puede usar una function Y una const hermanas del MISMO .ws", () => {
	const dir = tmpDir();
	crear(dir, {
		"piezas.ws": ["function formatear(x)", '\treturn "★ " + x', "", "const PREFIJO_CONST = 'fijo: '", "", "visual TarjetaCompleja =", "<div>", "\t<span>{formatear(props.titulo)}</span>", "\t<span>{PREFIJO_CONST}</span>", "</div>"],
	});
	const wsf = ['import { TarjetaCompleja } from "./piezas.ws"', "", '<TarjetaCompleja titulo="hola" />'].join("\n");
	const { doc } = ejecutarCliente(dir, wsf);
	const spans = doc.querySelectorAll("span");
	assert.equal(spans[0].textContent, "★ hola");
	assert.equal(spans[1].textContent, "fijo: ");
});

test("NO REGRESIÓN (dirigido por demanda): una visual seguridad no arrastra a otra insegura del mismo .ws que usa un .wsdb", () => {
	const dir = tmpDir();
	crear(dir, {
		"personas.wsdb": ["-> name: 'persona'", "-> schema:", "\t-> id: integer(10)(primary)/", "\t-> nombre: string(40)"],
		"mixto.ws": ['import { Persona } from "./personas.wsdb"', "", "function usaWsdb()", "\treturn Persona.selectAll()", "", "visual Segura =", "<p>segura</p>", "", "visual Insegura =", "<p>{usaWsdb()}</p>"],
	});
	const wsf = ['import { Segura } from "./mixto.ws"', "", "<Segura />"].join("\n");
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	assert.match(html, /segura/);
});

test("...y si se pide la visual insegura, el error de .wsdb en el cliente nombra el .ws (mismo criterio que ya existía para function)", () => {
	const dir = tmpDir();
	crear(dir, {
		"personas.wsdb": ["-> name: 'persona'", "-> schema:", "\t-> id: integer(10)(primary)/", "\t-> nombre: string(40)"],
		"mixto.ws": ['import { Persona } from "./personas.wsdb"', "", "function usaWsdb()", "\treturn Persona.selectAll()", "", "visual Insegura =", "<p>{usaWsdb()}</p>"],
	});
	const wsf = ['import { Insegura } from "./mixto.ws"', "", "<Insegura />"].join("\n");
	assert.throws(() => generateClientBundle(parse(wsf), { baseDir: dir }), /mixto\.ws: No se puede importar "\.\/personas\.wsdb" desde el cliente/);
});

test("NO REGRESIÓN (diamante): la misma visual de un .ws alcanzada por dos caminos distintos se emite una sola vez", () => {
	const dir = tmpDir();
	crear(dir, { "piezas.ws": ["visual Tarjeta =", '<div class="tarjeta">{props.titulo}</div>'] });
	crear(dir, { "envuelveA.wsf": ['import { Tarjeta } from "./piezas.ws"', "", "visual EnvuelveA =", '<div><Tarjeta titulo="viaA" /></div>'] });
	const wsf = ['import { Tarjeta } from "./piezas.ws"', 'import { EnvuelveA } from "./envuelveA.wsf"', "", '<div><Tarjeta titulo="directo" /><EnvuelveA /></div>'].join("\n");
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	assert.match(html, /directo/);
	assert.match(html, /viaA/);
	const bundle = generateClientBundle(parse(wsf), { baseDir: dir });
	assert.equal((bundle.match(/function create_Tarjeta\b/g) || []).length, 1);
});

test("una visual de un .ws puede a su vez llamar a una function importada por ese .ws de un .js", () => {
	const dir = tmpDir();
	crear(dir, {
		"ayuda.js": "module.exports = { triple: (x) => x * 3 };",
		"piezas.ws": ['import { triple } from "./ayuda.js"', "", "visual Multiplicada =", "<p>{triple(props.valor)}</p>"],
	});
	const wsf = ['import { Multiplicada } from "./piezas.ws"', "", "<Multiplicada valor={7} />"].join("\n");
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	assert.match(html, /21/);
});
