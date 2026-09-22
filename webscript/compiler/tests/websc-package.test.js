const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawn } = require("child_process");
const net = require("net");
const http = require("http");

const PACKAGE_DIR = path.join(__dirname, "..");

function tmpDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Estos tests instalan el paquete de verdad (npm pack + npm install -g con
// un prefix aislado) y usan el comando `websc` real, no `node bin/websc.js`
// — es la prueba más fiel posible de "esto funcionaría igual instalado
// desde el registro de npm", sin publicar nada de verdad.
test("npm pack + npm install -g: el comando websc real funciona como binario global", { timeout: 60000 }, () => {
	const npmPrefix = tmpDir("websc-npm-prefix-");
	const packDir = tmpDir("websc-pack-");

	const packOutput = execFileSync("npm", ["pack", "--pack-destination", packDir], {
		cwd: PACKAGE_DIR,
		encoding: "utf8",
	});
	const tarballName = packOutput.trim().split("\n").pop();
	const tarballPath = path.join(packDir, tarballName);
	assert.ok(fs.existsSync(tarballPath));

	execFileSync("npm", ["install", "-g", tarballPath, "--prefix", npmPrefix], { encoding: "utf8" });

	const binDir = path.join(npmPrefix, "bin");
	const wsBin = path.join(binDir, "websc");
	assert.ok(fs.existsSync(wsBin), "el binario 'websc' debe existir tras instalar globalmente");

	// `websc` sin subcomando sale con código 1 a propósito (uso incorrecto)
	// — execFileSync lanza en ese caso, así que se captura para leer stdout.
	let output;
	try {
		output = execFileSync(wsBin, [], { encoding: "utf8" });
	} catch (err) {
		output = err.stdout;
	}
	assert.match(output, /websc init/);
});

test(
	"paquete real: websc init + build + servidor funcionan de extremo a extremo, instalado globalmente",
	{ timeout: 60000 },
	async () => {
		const npmPrefix = tmpDir("websc-npm-prefix2-");
		const packDir = tmpDir("websc-pack2-");
		const projectDir = tmpDir("websc-project-");

		const packOutput = execFileSync("npm", ["pack", "--pack-destination", packDir], {
			cwd: PACKAGE_DIR,
			encoding: "utf8",
		});
		const tarballPath = path.join(packDir, packOutput.trim().split("\n").pop());
		execFileSync("npm", ["install", "-g", tarballPath, "--prefix", npmPrefix], { encoding: "utf8" });

		const wsBin = path.join(npmPrefix, "bin", "websc");

		execFileSync(wsBin, ["init", projectDir], { encoding: "utf8" });
		assert.ok(fs.existsSync(path.join(projectDir, "lib", "Visual.ws")));
		assert.ok(fs.existsSync(path.join(projectDir, "compiler", "parser.js")));

		fs.writeFileSync(
			path.join(projectDir, "src", "pagina.wsf"),
			[
				"reactive contador = 0",
				"visual app =",
				'<div id="raiz">',
				"\t<p>Valor: {contador}</p>",
				"</div>",
				"Visual.render(app)",
			].join("\n")
		);

		execFileSync(wsBin, ["build", projectDir], { encoding: "utf8" });
		assert.ok(fs.existsSync(path.join(projectDir, "dist", "server.js")));

		const port = await new Promise((resolve) => {
			const srv = net.createServer();
			srv.listen(0, () => {
				const p = srv.address().port;
				srv.close(() => resolve(p));
			});
		});
		fs.writeFileSync(path.join(projectDir, "wconfig.json"), JSON.stringify({ port }));

		const child = spawn("node", [path.join(projectDir, "dist", "server.js")]);
		try {
			await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("no arrancó a tiempo")), 5000);
				child.stdout.on("data", (chunk) => {
					if (chunk.toString().includes("Servidor en")) {
						clearTimeout(timeout);
						resolve();
					}
				});
				child.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
			});

			const body = await new Promise((resolve) => {
				http.get(`http://localhost:${port}/`, (r) => {
					let out = "";
					r.on("data", (c) => (out += c));
					r.on("end", () => resolve(out));
				});
			});
			assert.match(body, /<div id="raiz"><p>Valor: 0<\/p><\/div>/);
		} finally {
			child.kill();
		}
	}
);

test(
	"paquete real: acorn/acorn-walk (dependencias del compilador) se vendorizan al instalar globalmente, y un typo real se detecta con el binario global",
	{ timeout: 60000 },
	() => {
		const npmPrefix = tmpDir("websc-npm-prefix3-");
		const packDir = tmpDir("websc-pack3-");
		const projectDir = tmpDir("websc-project-typo-");

		const packOutput = execFileSync("npm", ["pack", "--pack-destination", packDir], {
			cwd: PACKAGE_DIR,
			encoding: "utf8",
		});
		const tarballName = packOutput.trim().split("\n").pop();
		execFileSync("npm", ["install", "-g", path.join(packDir, tarballName), "--prefix", npmPrefix], { encoding: "utf8" });
		const wsBin = path.join(npmPrefix, "bin", "websc");

		// Confirma que npm instaló de verdad las dependencias declaradas del
		// compilador — sin esto, cualquier proyecto creado fallaría al
		// compilar con "Cannot find module 'acorn'".
		const vendoredDeps = fs.readdirSync(path.join(npmPrefix, "lib", "node_modules", "websc", "node_modules"));
		assert.ok(vendoredDeps.includes("acorn"));
		assert.ok(vendoredDeps.includes("acorn-walk"));

		execFileSync(wsBin, ["init", projectDir], { encoding: "utf8" });
		fs.writeFileSync(
			path.join(projectDir, "src", "api.wsb"),
			[
				"var contador = 0",
				"",
				"const WSON wsonAlgo =",
				'\t-> to: "/algo"',
				'\t-> via: "GET"',
				"",
				"reactive any peticion = WSON.listen(wsonAlgo)",
				"",
				"watch(peticion)",
				"\tcontadr = contadr + 1", // typo real
				"\tpeticion.content = { contador: contador }",
				"\tWSON.send(peticion)",
			].join("\n")
		);

		assert.throws(
			() => execFileSync(wsBin, ["build", projectDir], { encoding: "utf8" }),
			(err) => {
				assert.equal(err.status, 1);
				assert.match(err.stderr.toString(), /"contadr"/);
				return true;
			}
		);
	}
);
