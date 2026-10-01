// De extremo a extremo: servidor real (createServer), SSR real
// (renderPageToHTML), bundle real ejecutado en JSDOM con WebSocket real —
// dos "pestañas" (dos ventanas JSDOM independientes, cada una con su propia
// conexión) para confirmar que una se entera sola de lo que hace la otra,
// sin recargar ni tocarla directamente.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { JSDOM, VirtualConsole } = require("jsdom");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");
const { generateClientBundle } = require("../codegen-client");
const { renderPageToHTML } = require("../codegen-ssr");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-shared-e2e-"));
}

function crear(dir, ficheros) {
	for (const [nombre, contenido] of Object.entries(ficheros)) {
		fs.writeFileSync(path.join(dir, nombre), Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
}

async function conServidorYPestanas(dir, wsbFile, wsfFile, fn) {
	const wsbAst = parse(fs.readFileSync(path.join(dir, wsbFile), "utf8"));
	const wsfAst = parse(fs.readFileSync(path.join(dir, wsfFile), "utf8"));
	const server = createServer(wsbAst, {}, { baseDir: dir });
	await new Promise((resolve, reject) => {
		server.listen(0, resolve);
		server.on("error", reject);
	});
	const port = server.address().port;
	const html = renderPageToHTML(wsfAst, { baseDir: dir });
	const bundle = generateClientBundle(wsfAst, { baseDir: dir });

	function abrirPestana() {
		const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
			runScripts: "dangerously",
			virtualConsole: new VirtualConsole(),
			url: `http://localhost:${port}/pagina`,
		});
		const script = dom.window.document.createElement("script");
		script.textContent = bundle;
		dom.window.document.body.appendChild(script);
		return dom;
	}

	// `process.exit` NUNCA se llama aquí — a diferencia de la exploración
	// manual, el test runner necesita que el proceso siga vivo para el
	// resto de la suite. `server.close()` basta porque aquí SÍ se cierran
	// las conexiones de cada pestaña explícitamente antes de terminar
	// (ver el "finally" de cada test) — fue justo la falta de ese cierre
	// explícito lo que colgaba el proceso al explorar esto a mano.
	try {
		await fn({ port, abrirPestana });
	} finally {
		server.close();
	}
}

test("REGRESIÓN nueva capacidad, de extremo a extremo: dos pestañas, una hace clic y la otra se entera SOLA, sin recargar ni tocarla", async () => {
	const dir = tmpDir();
	crear(dir, { "servidor.wsb": "shared global reactive cursores = {}" });
	crear(dir, {
		"pagina.wsf": [
			'import { cursores } from "./servidor.wsb"',
			"",
			"<div>",
			"\t<p>Cursores conectados: {Object.keys(cursores).length}</p>",
			"\t<button onclick={cursores = { ...cursores, yo: { x: 10, y: 20 } }}>marcar</button>",
			"</div>",
		],
	});
	await conServidorYPestanas(dir, "servidor.wsb", "pagina.wsf", async ({ abrirPestana }) => {
		const a = abrirPestana();
		const b = abrirPestana();
		try {
			await new Promise((r) => setTimeout(r, 300));
			assert.equal(a.window.document.querySelector("p").textContent, "Cursores conectados: 0");
			assert.equal(b.window.document.querySelector("p").textContent, "Cursores conectados: 0");

			a.window.document.querySelector("button").dispatchEvent(new a.window.Event("click"));
			await new Promise((r) => setTimeout(r, 400));

			assert.equal(a.window.document.querySelector("p").textContent, "Cursores conectados: 1");
			assert.equal(b.window.document.querySelector("p").textContent, "Cursores conectados: 1", "B no tocó nada — se enteró sola por la difusión del servidor");
		} finally {
			a.window.close();
			b.window.close();
		}
	});
});

test("REGRESIÓN: un watch() que valida/corrige en el servidor se refleja en el cliente con el valor YA corregido", async () => {
	const dir = tmpDir();
	crear(dir, {
		"servidor.wsb": ["shared global reactive contador = 0", "", "watch(contador)", "\tif (contador > 10)", "\t\tcontador = 10"],
	});
	crear(dir, {
		"pagina.wsf": [
			'import { contador } from "./servidor.wsb"',
			"",
			"<div>",
			"\t<p>Valor: {contador}</p>",
			"\t<button onclick={contador = 999}>proponer 999</button>",
			"</div>",
		],
	});
	await conServidorYPestanas(dir, "servidor.wsb", "pagina.wsf", async ({ abrirPestana }) => {
		const win = abrirPestana();
		try {
			await new Promise((r) => setTimeout(r, 300));
			win.window.document.querySelector("button").dispatchEvent(new win.window.Event("click"));
			await new Promise((r) => setTimeout(r, 400));
			assert.equal(win.window.document.querySelector("p").textContent, "Valor: 10", "el cliente ve el valor corregido por el servidor, no el 999 propuesto");
		} finally {
			win.window.close();
		}
	});
});
