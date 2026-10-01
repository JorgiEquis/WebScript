// definition.js — WebScript VS Code extension
//
// Ctrl+Click (Ir a definición) para:
// 1. import { A, B } from "./fichero.ext"  — sobre la ruta: abre el
//    fichero; sobre un nombre importado: abre el fichero Y busca su
//    declaración dentro (function/online function, reactive/var/const
//    exportada, o "-> name:" para un .wsdb).
// 2. WSON.<método> / Visual.<método> — abre lib/WSON.ws / lib/Visual.ws
//    del proyecto y busca la línea del método.
// 3. <Coleccion>.<método de WSDB> / <Coleccion>Schema.getSchema() — abre
//    lib/WSDB.ws / lib/WSSchema.ws.
// 4. Una llamada a function suelta — busca su declaración primero en el
//    propio fichero, luego en el resto del proyecto.

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const { WSDB_METHODS } = require("./docs");

const WSDB_METHOD_NAMES = new Set(Object.keys(WSDB_METHODS));
const LIB_FILES = { WSON: "WSON.ws", Visual: "Visual.ws", WSDB: "WSDB.ws", WSSchema: "WSSchema.ws" };

function receiverBefore(lineText, startCol) {
	const before = lineText.slice(0, startCol);
	const m = /([A-Za-z_]\w*)\s*\.\s*$/.exec(before);
	return m ? m[1] : null;
}

// Devuelve el rango del string ("./algo") que contiene `col` en `lineText`,
// si `col` cae dentro de uno que empiece por "./" o "../" (una ruta de
// import relativa) — o null.
function importPathStringAt(lineText, col) {
	const re = /(["'])(\.\.?\/[^"']+)\1/g;
	let m;
	while ((m = re.exec(lineText))) {
		const start = m.index + 1; // tras la comilla
		const end = start + m[2].length;
		if (col >= start && col <= end) return m[2];
	}
	return null;
}

// ¿Está `word` dentro de la lista de nombres de un
// `import { A, B } from "..."` en esta línea, y cuál es la ruta?
function importBindingAt(lineText, word) {
	let m = /^\s*import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/.exec(lineText);
	if (m) {
		const names = m[1].split(",").map((s) => s.trim());
		if (names.includes(word)) return { from: m[2] };
		return null;
	}
	m = /^\s*import\s+(\w+)\s+from\s*["']([^"']+)["']/.exec(lineText);
	if (m && m[1] === word) return { from: m[2] };
	return null;
}

function resolveImportPath(currentFile, importPath) {
	const resolved = path.resolve(path.dirname(currentFile), importPath);
	return fs.existsSync(resolved) ? resolved : null;
}

// Busca la declaración de `name` dentro del texto de un fichero destino,
// según su extensión — devuelve el número de línea (0-based) o null.
function findDeclarationLine(targetPath, name) {
	const ext = path.extname(targetPath);
	const text = fs.readFileSync(targetPath, "utf8");
	const lines = text.split(/\r?\n/);

	if (ext === ".wsdb") {
		// "-> name: 'persona'" genera Persona/PersonaSchema — quita el
		// sufijo "Schema" si lo hay para comparar contra el valor real.
		const base = name.endsWith("Schema") ? name.slice(0, -6) : name;
		const re = /^\s*->\s*name\s*:\s*["']([^"']+)["']/;
		for (let i = 0; i < lines.length; i++) {
			const m = re.exec(lines[i]);
			if (m && m[1].charAt(0).toUpperCase() + m[1].slice(1) === base) return i;
		}
		return null;
	}

	if (ext === ".wson") return null; // esquema puntual, sin nombre propio dentro

	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const patterns = [
		new RegExp(`^\\s*(export\\s+)?online\\s+function\\s+${escaped}\\s*\\(`),
		new RegExp(`^\\s*(export\\s+)?function\\s+${escaped}\\s*\\(`),
		new RegExp(`^\\s*export\\s+const\\s+WSON\\s+${escaped}\\s*=`),
		new RegExp(`^\\s*(export\\s+)?(global\\s+)?(reactive|const|var)\\s+(?:[\\w/]+(?:\\(array\\))?\\s+)?${escaped}\\s*=`),
	];
	for (let i = 0; i < lines.length; i++) {
		if (patterns.some((re) => re.test(lines[i]))) return i;
	}
	return null;
}

async function findLibFile(name) {
	const found = await vscode.workspace.findFiles(`**/lib/${LIB_FILES[name]}`, "**/node_modules/**", 5);
	return found.length > 0 ? found[0] : null;
}

function lineOfMethod(text, methodName) {
	const lines = text.split(/\r?\n/);
	const re = new RegExp(`\\b${methodName}\\s*\\(`);
	for (let i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) return i;
	}
	return 0;
}

async function findFunctionInWorkspace(name) {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^\\s*(export\\s+)?(online\\s+)?function\\s+${escaped}\\s*\\(`);
	const files = await vscode.workspace.findFiles("**/*.{ws,wsb,wsf}", "**/node_modules/**", 300);
	for (const uri of files) {
		let text;
		try {
			text = fs.readFileSync(uri.fsPath, "utf8");
		} catch {
			continue;
		}
		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			if (re.test(lines[i])) return new vscode.Location(uri, new vscode.Position(i, 0));
		}
	}
	return null;
}

async function provideDefinition(document, position) {
	const lineText = document.lineAt(position.line).text;
	const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);

	// 1. Cursor sobre la propia ruta del import.
	const pathHere = importPathStringAt(lineText, position.character);
	if (pathHere) {
		const target = resolveImportPath(document.uri.fsPath, pathHere);
		if (target) return new vscode.Location(vscode.Uri.file(target), new vscode.Position(0, 0));
		return null;
	}

	if (!wordRange) return null;
	const word = document.getText(wordRange);

	// 2. Cursor sobre uno de los nombres importados.
	const binding = importBindingAt(lineText, word);
	if (binding) {
		const target = resolveImportPath(document.uri.fsPath, binding.from);
		if (!target) return null;
		const line = findDeclarationLine(target, word);
		return new vscode.Location(vscode.Uri.file(target), new vscode.Position(line || 0, 0));
	}

	const receiver = receiverBefore(lineText, wordRange.start.character);

	// 3. WSON.<método> / Visual.<método> -> lib/WSON.ws / lib/Visual.ws
	if ((receiver === "WSON" || receiver === "Visual") && LIB_FILES[receiver]) {
		const libUri = await findLibFile(receiver);
		if (!libUri) return null;
		const text = fs.readFileSync(libUri.fsPath, "utf8");
		return new vscode.Location(libUri, new vscode.Position(lineOfMethod(text, word), 0));
	}

	// 4. <Coleccion>.<método WSDB> -> lib/WSDB.ws
	if (receiver && /^[A-Z]/.test(receiver) && WSDB_METHOD_NAMES.has(word)) {
		const libUri = await findLibFile("WSDB");
		if (!libUri) return null;
		const text = fs.readFileSync(libUri.fsPath, "utf8");
		return new vscode.Location(libUri, new vscode.Position(lineOfMethod(text, word), 0));
	}

	// 5. <Coleccion>Schema.getSchema() -> lib/WSSchema.ws
	if (word === "getSchema") {
		const libUri = await findLibFile("WSSchema");
		if (!libUri) return null;
		const text = fs.readFileSync(libUri.fsPath, "utf8");
		return new vscode.Location(libUri, new vscode.Position(lineOfMethod(text, word), 0));
	}

	// 6. Llamada suelta a una function: primero en el propio fichero...
	if (!receiver) {
		const ownLine = findDeclarationLine(document.uri.fsPath, word);
		if (ownLine !== null) return new vscode.Location(document.uri, new vscode.Position(ownLine, 0));
		// ...si no, en el resto del proyecto.
		return findFunctionInWorkspace(word);
	}

	return null;
}

module.exports = { provideDefinition };
