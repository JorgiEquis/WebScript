const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findWsfFiles, findWsbFiles } = require("../discover-files");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-discover-"));
}

test("findWsfFiles: encuentra los .wsf de un directorio, no recursivo", () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "a.wsf"), "visual app =\n<p>a</p>");
	fs.writeFileSync(path.join(dir, "b.wsf"), "visual app =\n<p>b</p>");
	fs.writeFileSync(path.join(dir, "c.wsb"), "");
	const encontrados = findWsfFiles(dir).map((f) => path.basename(f)).sort();
	assert.deepEqual(encontrados, ["a.wsf", "b.wsf"]);
});

test("findWsbFiles: excluye un .wsb importado explícitamente por otro del mismo directorio", () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "usuarios.wsb"), "export const WSON w =\n\t-> to: \"/x\"\n\t-> via: \"GET\"");
	fs.writeFileSync(path.join(dir, "api.wsb"), 'import { w } from "./usuarios.wsb"');
	const encontrados = findWsbFiles(dir).map((f) => path.basename(f)).sort();
	assert.deepEqual(encontrados, ["api.wsb"]);
});

test("findWsbFiles: sin ningún import entre ellos, se devuelven todos", () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "a.wsb"), "");
	fs.writeFileSync(path.join(dir, "b.wsb"), "");
	const encontrados = findWsbFiles(dir).map((f) => path.basename(f)).sort();
	assert.deepEqual(encontrados, ["a.wsb", "b.wsb"]);
});
