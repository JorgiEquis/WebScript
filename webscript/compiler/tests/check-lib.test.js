const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { validateLibUnmodified, buildLock } = require("../check-lib");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-checklib-"));
}

test("sin lib/.websc-lock.json, no valida nada (proyecto sin websc init)", () => {
	const dir = tmpDir();
	const result = validateLibUnmodified(dir);
	assert.equal(result.checked, false);
});

test("con lib/ intacto respecto al lock, no lanza", () => {
	const dir = tmpDir();
	const libDir = path.join(dir, "lib");
	fs.mkdirSync(libDir, { recursive: true });
	fs.writeFileSync(path.join(libDir, "Visual.ws"), "contenido original");
	const lock = buildLock(libDir, ["Visual.ws"]);
	fs.writeFileSync(path.join(libDir, ".websc-lock.json"), JSON.stringify(lock));

	assert.doesNotThrow(() => validateLibUnmodified(dir));
});

test("con lib/ modificado respecto al lock, lanza con mensaje claro", () => {
	const dir = tmpDir();
	const libDir = path.join(dir, "lib");
	fs.mkdirSync(libDir, { recursive: true });
	fs.writeFileSync(path.join(libDir, "Visual.ws"), "contenido original");
	const lock = buildLock(libDir, ["Visual.ws"]);
	fs.writeFileSync(path.join(libDir, ".websc-lock.json"), JSON.stringify(lock));

	fs.appendFileSync(path.join(libDir, "Visual.ws"), "\n// manipulado a mano");

	assert.throws(() => validateLibUnmodified(dir), /Visual\.ws.*modificado/);
});

test("con un fichero de lib/ desaparecido, lanza mencionándolo", () => {
	const dir = tmpDir();
	const libDir = path.join(dir, "lib");
	fs.mkdirSync(libDir, { recursive: true });
	fs.writeFileSync(path.join(libDir, "Visual.ws"), "contenido original");
	const lock = buildLock(libDir, ["Visual.ws"]);
	fs.writeFileSync(path.join(libDir, ".websc-lock.json"), JSON.stringify(lock));

	fs.unlinkSync(path.join(libDir, "Visual.ws"));

	assert.throws(() => validateLibUnmodified(dir), /Visual\.ws.*desaparecido/);
});
