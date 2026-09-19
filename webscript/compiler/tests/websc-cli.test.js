const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const WEBSC_BIN = path.join(__dirname, "../bin/websc.js");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-cli-"));
}

function runWebsc(args) {
	return execFileSync("node", [WEBSC_BIN, ...args], { encoding: "utf8" });
}

test("websc init genera src/, lib/ (con lock) y compiler/ vendorizado", () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);

	assert.ok(fs.existsSync(path.join(dir, "src")));
	assert.ok(fs.existsSync(path.join(dir, "lib", "Visual.ws")));
	assert.ok(fs.existsSync(path.join(dir, "lib", "WSON.ws")));
	assert.ok(fs.existsSync(path.join(dir, "lib", ".websc-lock.json")));
	assert.ok(fs.existsSync(path.join(dir, "compiler", "parser.js")));
	assert.ok(fs.existsSync(path.join(dir, "wconfig.json")));
	assert.ok(fs.existsSync(path.join(dir, ".gitignore")));
});

test("websc init no sobreescribe una carpeta ya existente y no vacía", () => {
	const dir = path.join(tmpDir(), "proyecto");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "algo.txt"), "ya había algo aquí");

	assert.throws(() => runWebsc(["init", dir]));
});

test("el compilador vendorizado por websc init compila un fichero real", () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(path.join(dir, "src", "prueba.wsf"), "reactive x = 1");

	const output = execFileSync("node", [path.join(dir, "compiler", "cli.js"), path.join(dir, "src", "prueba.wsf")], {
		encoding: "utf8",
	});
	assert.match(output, /"type": "ReactiveDecl"/);
});

test("el compilador vendorizado rechaza compilar si lib/ fue modificado a mano", () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(path.join(dir, "src", "prueba.wsf"), "reactive x = 1");
	fs.appendFileSync(path.join(dir, "lib", "Visual.ws"), "\n// manipulado");

	assert.throws(() => {
		execFileSync("node", [path.join(dir, "compiler", "cli.js"), path.join(dir, "src", "prueba.wsf")], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	}, /Command failed/);
});

test("websc update restaura lib/ y deja src/ intacto", () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(path.join(dir, "src", "prueba.wsf"), "reactive x = 1");
	fs.appendFileSync(path.join(dir, "lib", "Visual.ws"), "\n// manipulado");

	runWebsc(["update", dir]);

	assert.equal(fs.readFileSync(path.join(dir, "src", "prueba.wsf"), "utf8"), "reactive x = 1");

	const output = execFileSync("node", [path.join(dir, "compiler", "cli.js"), path.join(dir, "src", "prueba.wsf")], {
		encoding: "utf8",
	});
	assert.match(output, /"type": "ReactiveDecl"/);
});

test("websc update en una carpeta que no es un proyecto WebScript falla claramente", () => {
	const dir = tmpDir();
	assert.throws(() => runWebsc(["update", dir]));
});
