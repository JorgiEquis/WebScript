// Una constante exportada por un `.ws` (o cualquier `const`/`var` de ese
// fichero) no podía referirse a otra constante DEL MISMO `.ws`: el ámbito
// de una constante eran solo los imports de su fichero, nunca sus hermanas
// — `export const B = A + 1` (con `A` también declarada en ese `.ws`) daba
// `A is not defined`, aunque las dos estuvieran en el mismo sitio.
// Reproducido contra el código anterior antes de corregirlo: los tests
// marcados REGRESIÓN fallan allí.
//
// Diseño (ver DISEÑO.md): una constante hermana referenciada por nombre se
// resuelve (y se cachea) a través de `getWsConstValue`, de forma recursiva
// — cubre cadenas (`C` usa `B`, `B` usa `A`) — con detección de ciclo entre
// hermanas (error explícito, no una recursión infinita). Una constante que
// llama a una FUNCTION hermana del mismo `.ws` sigue sin resolverse (esa
// function puede tocar `global`, que en este punto del arranque todavía no
// existe) — es un límite conocido, deliberado, no una regresión de este
// cambio.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parse } = require("../parser");
const { createServer, resolveImports } = require("../codegen-server");
const { WSClient } = require("../wsclient-runtime");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-ws-sibling-const-"));
}

function crear(dir, ficheros) {
	for (const [nombre, contenido] of Object.entries(ficheros)) {
		const destino = path.join(dir, nombre);
		fs.mkdirSync(path.dirname(destino), { recursive: true });
		fs.writeFileSync(destino, Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
}

async function conServidor(dir, src, fn) {
	const server = createServer(parse(src), {}, { baseDir: dir });
	await new Promise((resolve) => server.listen(0, resolve));
	const client = new WSClient(`ws://localhost:${server.address().port}/`);
	try {
		await fn(client, server);
	} finally {
		client.close();
		server.close();
	}
}

function compilar(dir, src) {
	return createServer(parse(src), {}, { baseDir: dir });
}

test("REGRESIÓN (el caso reportado): una constante de un .ws puede referirse a otra constante del mismo .ws", async () => {
	const dir = tmpDir();
	crear(dir, { "valores.ws": ["export const A = 5", "export const B = A + 1"] });
	await conServidor(dir, ['import { B } from "./valores.ws"', "", "online function leer()", "\treturn B"].join("\n"), async (c) => {
		assert.equal(await c.llamar("leer", []), 6, "antes: A is not defined");
	});
});

test("REGRESIÓN: una cadena de tres constantes hermanas (C usa B, B usa A) se resuelve en orden", async () => {
	const dir = tmpDir();
	crear(dir, { "valores.ws": ["export const A = 5", "export const B = A + 1", "export const C = B * 10"] });
	await conServidor(dir, ['import { C } from "./valores.ws"', "", "online function leer()", "\treturn C"].join("\n"), async (c) => {
		assert.equal(await c.llamar("leer", []), 60);
	});
});

test("REGRESIÓN: una constante hermana no exportada también se resuelve (el import solo pide la que la usa)", async () => {
	const dir = tmpDir();
	crear(dir, { "valores.ws": ["const INTERNA = 100", "export const PUBLICA = INTERNA + 1"] });
	await conServidor(dir, ['import { PUBLICA } from "./valores.ws"', "", "online function leer()", "\treturn PUBLICA"].join("\n"), async (c) => {
		assert.equal(await c.llamar("leer", []), 101);
	});
});

test("una constante hermana que a su vez usa lo que el .ws importa (mezcla de hermana + import)", async () => {
	const dir = tmpDir();
	crear(dir, {
		"ayuda.js": "module.exports = { triple: (x) => x * 3 };",
		"valores.ws": ['import { triple } from "./ayuda.js"', "", "export const A = triple(2)", "export const B = A + 1"],
	});
	await conServidor(dir, ['import { B } from "./valores.ws"', "", "online function leer()", "\treturn B"].join("\n"), async (c) => {
		assert.equal(await c.llamar("leer", []), 7);
	});
});

test("NO REGRESIÓN: una constante hermana que nadie usa, y que está rota, no tumba a las demás", async () => {
	const dir = tmpDir();
	crear(dir, { "valores.ws": ["export const ROTA = noExiste()", "export const SANA = 42"] });
	await conServidor(dir, ['import { SANA } from "./valores.ws"', "", "online function leer()", "\treturn SANA"].join("\n"), async (c) => {
		assert.equal(await c.llamar("leer", []), 42);
	});
});

test("REGRESIÓN: un ciclo real entre constantes hermanas (A usa B, B usa A) da un error explícito, no una recursión infinita", () => {
	const dir = tmpDir();
	crear(dir, { "valores.ws": ["export const A = B + 1", "export const B = A + 1"] });
	assert.throws(() => compilar(dir, 'import { A } from "./valores.ws"'), /"A" de .*valores\.ws: depende circularmente de otra constante del mismo \.ws/);
});

test("NO REGRESIÓN: el ciclo ENTRE FICHEROS (importación circular ya existente) sigue dando su propio error, sin relación con el de hermanas", () => {
	const dir = tmpDir();
	crear(dir, {
		"k1.ws": ['import { K2 } from "./k2.ws"', "", "export const K1 = 1"],
		"k2.ws": ['import { K1 } from "./k1.ws"', "", "export const K2 = 2"],
	});
	assert.throws(() => compilar(dir, 'import { K1 } from "./k1.ws"'), /importación circular.*constante no se puede evaluar/s);
});

test("una constante que llama a una FUNCTION hermana del mismo .ws sigue sin resolverse (límite conocido, no una regresión de este cambio)", () => {
	const dir = tmpDir();
	crear(dir, { "valores.ws": ["function doble(x)", "\treturn x * 2", "", "export const D = doble(21)"] });
	assert.throws(() => compilar(dir, 'import { D } from "./valores.ws"'), /doble is not defined/);
});

test("una hermana derivada compartida por dos const pedidas juntas se evalúa UNA sola vez (misma referencia de objeto, no dos evaluaciones distintas)", () => {
	const dir = tmpDir();
	crear(dir, { "contador.ws": ["export const A = { n: 5 }", "export const B = A", "export const C = A"] });
	const ast = parse(['import { B, C } from "./contador.ws"', "", "online function leer()", "\treturn [B, C]"].join("\n"));
	const result = resolveImports(ast, dir, dir, {});
	assert.equal(result.bindings.B, result.bindings.C, "B y C deberían ser la MISMA referencia — A se evaluó una sola vez, no dos");
});
