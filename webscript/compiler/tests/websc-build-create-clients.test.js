// `clients` en wconfig.json + `websc build --create-clients` — sincroniza
// los .ws generados a partir de las `online function` de otros servidores
// WebScript, declarados de una vez en vez de recordar cada URL/--out a mano
// con `websc client-generate`. Sin el flag, `websc build` sigue siendo puro
// y sin red, como siempre (NO REGRESIÓN). Con el flag, un remoto que falla
// (no arranca, no responde) escribe una clase VACÍA para ese remoto y el
// build sigue con normalidad — nunca tumba el build entero por un fallo de
// red puntual.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawn } = require("child_process");

const WEBSC_BIN = path.join(__dirname, "../bin/websc.js");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-build-create-clients-"));
}

function runWebsc(args) {
	return execFileSync("node", [WEBSC_BIN, ...args], { encoding: "utf8" });
}

// Mismo patrón que tests/websc-client-generate.test.js: el remoto vive en un
// PROCESO DE VERDAD, aparte — `execFileSync` (usado para invocar `websc
// build`) bloquea por completo este proceso mientras el hijo corre, así que
// un servidor remoto en el MISMO proceso de test se congelaría a sí mismo.
function startRemoteServerProcess(src, dir) {
	fs.writeFileSync(path.join(dir, "__remote.wsb"), src);
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				"-e",
				`
				const { parse } = require(${JSON.stringify(path.join(__dirname, "../parser"))});
				const { createServer } = require(${JSON.stringify(path.join(__dirname, "../codegen-server"))});
				const fs = require("fs");
				const server = createServer(parse(fs.readFileSync(${JSON.stringify(path.join(dir, "__remote.wsb"))}, "utf8")), {}, { baseDir: ${JSON.stringify(dir)} });
				server.listen(0, () => console.log("PUERTO:" + server.address().port));
				`,
			],
			{ stdio: ["ignore", "pipe", "pipe"] }
		);
		child.unref();
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
			const m = out.match(/PUERTO:(\d+)/);
			if (m) resolve({ port: Number(m[1]), stop: () => child.kill("SIGKILL") });
		});
		child.stderr.on("data", (d) => process.stderr.write(`[remoto] ${d}`));
		child.on("error", reject);
	});
}

function proyecto(ficherosSrc, wconfigExtra) {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	for (const [nombre, contenido] of Object.entries(ficherosSrc)) {
		const destino = path.join(dir, "src", nombre);
		fs.mkdirSync(path.dirname(destino), { recursive: true });
		fs.writeFileSync(destino, Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
	if (wconfigExtra) {
		const wconfigPath = path.join(dir, "wconfig.json");
		const wconfig = JSON.parse(fs.readFileSync(wconfigPath, "utf8"));
		Object.assign(wconfig, wconfigExtra);
		fs.writeFileSync(wconfigPath, JSON.stringify(wconfig));
	}
	return dir;
}

test("REGRESIÓN: websc build --create-clients genera el .ws de un remoto real declarado en wconfig.json", async () => {
	const dir = proyecto({});
	const remoto = await startRemoteServerProcess(["online function saludo(nombre)", '\treturn "hola, " + nombre'].join("\n"), dir);
	try {
		const wconfigPath = path.join(dir, "wconfig.json");
		const wconfig = JSON.parse(fs.readFileSync(wconfigPath, "utf8"));
		wconfig.clients = { "src/OtroServidor.ws": `ws://localhost:${remoto.port}/` };
		fs.writeFileSync(wconfigPath, JSON.stringify(wconfig));

		const salida = runWebsc(["build", dir, "--create-clients"]);
		assert.match(salida, /clients: src\/OtroServidor\.ws.*saludo/);

		const contenido = fs.readFileSync(path.join(dir, "src", "OtroServidor.ws"), "utf8");
		assert.match(contenido, /export function saludo\(nombre, opts\)/);
	} finally {
		remoto.stop();
	}
});

test("REGRESIÓN: sin --create-clients, wconfig.json con \"clients\" no toca la red ni genera nada (websc build sigue siendo puro por defecto)", () => {
	const dir = proyecto({ "pagina.wsf": "<p>hola</p>" }, { clients: { "src/OtroServidor.ws": "ws://localhost:1/" } });
	runWebsc(["build", dir]); // si intentara conectar, colgaría o fallaría — el puerto 1 no escucha
	assert.equal(fs.existsSync(path.join(dir, "src", "OtroServidor.ws")), false);
});

test("REGRESIÓN: un remoto que falla (no hay nada escuchando) escribe una clase VACÍA, y el build entero NO se cae", () => {
	const dir = proyecto({ "pagina.wsf": "<p>hola</p>" }, { clients: { "src/OtroServidor.ws": "ws://localhost:1/" } });
	const salida = runWebsc(["build", dir, "--create-clients"]);
	assert.match(salida, /clients: src\/OtroServidor\.ws.*FALLÓ/);
	assert.ok(fs.existsSync(path.join(dir, "dist", "server.js")), "el build siguió y terminó con normalidad");
	const contenido = fs.readFileSync(path.join(dir, "src", "OtroServidor.ws"), "utf8");
	assert.match(contenido, /VACÍO/);
	assert.doesNotMatch(contenido, /export function/);
});

test("dos remotos declarados, uno falla y otro funciona: el que funciona se genera bien, el otro queda vacío, y el build no se detiene en el primer fallo", async () => {
	const dir = proyecto({});
	const remoto = await startRemoteServerProcess(["online function ping()", '\treturn "pong"'].join("\n"), dir);
	try {
		const wconfigPath = path.join(dir, "wconfig.json");
		const wconfig = JSON.parse(fs.readFileSync(wconfigPath, "utf8"));
		wconfig.clients = {
			"src/Roto.ws": "ws://localhost:1/",
			"src/Bueno.ws": `ws://localhost:${remoto.port}/`,
		};
		fs.writeFileSync(wconfigPath, JSON.stringify(wconfig));

		runWebsc(["build", dir, "--create-clients"]);
		assert.match(fs.readFileSync(path.join(dir, "src", "Roto.ws"), "utf8"), /VACÍO/);
		assert.match(fs.readFileSync(path.join(dir, "src", "Bueno.ws"), "utf8"), /export function ping/);
	} finally {
		remoto.stop();
	}
});

test("una página que importa una función de un cliente generado con --create-clients funciona de extremo a extremo", async () => {
	const dir = proyecto({});
	const remoto = await startRemoteServerProcess(["online function doble(x)", "\treturn x * 2"].join("\n"), dir);
	try {
		const wconfigPath = path.join(dir, "wconfig.json");
		const wconfig = JSON.parse(fs.readFileSync(wconfigPath, "utf8"));
		wconfig.clients = { "src/OtroServidor.ws": `ws://localhost:${remoto.port}/` };
		fs.writeFileSync(wconfigPath, JSON.stringify(wconfig));
		runWebsc(["build", dir, "--create-clients"]);

		assert.match(fs.readFileSync(path.join(dir, "src", "OtroServidor.ws"), "utf8"), /export function doble/);
	} finally {
		remoto.stop();
	}
});
