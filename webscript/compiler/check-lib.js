// check-lib.js — WebScript, v0
//
// El compilador deniega COMPLETAMENTE la modificación de lib/ (sin
// excepción ni flag), comparando contra el hash que `websc init`/`update`
// dejaron grabado en lib/.websc-lock.json al generar el proyecto.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function hashContent(content) {
	return crypto.createHash("sha256").update(content).digest("hex");
}

function hashFile(filePath) {
	return hashContent(fs.readFileSync(filePath));
}

// projectDir: carpeta que contiene lib/ (normalmente la raíz del proyecto,
// hermana de compiler/). Si no hay lib/.websc-lock.json, no hay nada que
// validar (proyecto sin `websc init`, o lib/ no existe todavía).
function validateLibUnmodified(projectDir) {
	const libDir = path.join(projectDir, "lib");
	const lockPath = path.join(libDir, ".websc-lock.json");
	if (!fs.existsSync(lockPath)) return { checked: false };

	const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
	const problems = [];

	for (const [file, expectedHash] of Object.entries(lock)) {
		const filePath = path.join(libDir, file);
		if (!fs.existsSync(filePath)) {
			problems.push(`"lib/${file}" ha desaparecido`);
			continue;
		}
		const actualHash = hashFile(filePath);
		if (actualHash !== expectedHash) {
			problems.push(`"lib/${file}" ha sido modificado`);
		}
	}

	if (problems.length > 0) {
		throw new Error(
			`El compilador no permite tocar los ficheros de lib/: ${problems.join(", ")}. ` +
				"Usa `websc update` para restaurarlo, o copia lo que necesites a un .ws propio " +
				"si hace falta una versión distinta — lib/ no se puede editar."
		);
	}

	return { checked: true, files: Object.keys(lock) };
}

// Usado por websc init/update al generar lib/: hash de cada fichero
// escrito, para poder detectar cambios más adelante.
function buildLock(libDir, files) {
	const lock = {};
	for (const file of files) {
		lock[file] = hashFile(path.join(libDir, file));
	}
	return lock;
}

module.exports = { validateLibUnmodified, buildLock, hashContent, hashFile };
