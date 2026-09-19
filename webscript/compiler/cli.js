#!/usr/bin/env node
// cli.js — WebScript compiler, v0
// Uso: node cli.js <fichero.wsf|.wsb|.ws|.wson>

const fs = require("fs");
const path = require("path");
const { parse } = require("./parser");
const { classifyWsf } = require("./codegen");
const { validateLibUnmodified } = require("./check-lib");

const file = process.argv[2];
if (!file) {
	console.error("Uso: node cli.js <fichero>");
	process.exit(1);
}

// lib/ es hermano de compiler/ en un proyecto generado por `websc init` —
// si existe un lock ahí, se valida antes de compilar nada. Sin lock (no es
// un proyecto generado, o no hay lib/), no hay nada que comprobar.
try {
	validateLibUnmodified(path.resolve(__dirname, ".."));
} catch (err) {
	console.error(err.message);
	process.exit(1);
}

const source = fs.readFileSync(file, "utf8");
const isWsonFile = path.extname(file) === ".wson";

const ast = parse(source, { isWsonFile });
console.log(JSON.stringify(ast, null, 2));

// Un .wsf es "page" si llama a Visual.render(...), "library" si no — sin
// que eso sea un error, es la marca de que está pensado para importarse.
if (path.extname(file) === ".wsf") {
	console.error(`\n(${path.basename(file)}: ${classifyWsf(ast)})`);
}
