// hover.js — WebScript VS Code extension
//
// Muestra info al pasar el ratón sobre: WSON.<método>, Visual.<método>,
// <Coleccion>.<método de WSDB> (save/selectAll/select/delete/deleteWhere/
// after), <Coleccion>Schema.getSchema(), el nombre de un namespace suelto
// (WSON, Visual...), y palabras clave del lenguaje (reactive, global,
// watch, visual, online, function, import, export, style).

const vscode = require("vscode");
const { WSON_METHODS, VISUAL_METHODS, WSDB_METHODS, WSSCHEMA_METHODS, NAMESPACES, KEYWORDS } = require("./docs");

const WSDB_METHOD_NAMES = new Set(Object.keys(WSDB_METHODS));

function receiverBefore(lineText, startCol) {
	// Nombre inmediatamente antes de un "." que precede a startCol —
	// para "Persona.save(" con el cursor en "save", devuelve "Persona".
	const before = lineText.slice(0, startCol);
	const m = /([A-Za-z_]\w*)\s*\.\s*$/.exec(before);
	return m ? m[1] : null;
}

function buildHover(entry) {
	const md = new vscode.MarkdownString();
	md.appendCodeblock(entry.signature, "webscript");
	md.appendMarkdown(entry.doc);
	md.isTrusted = false;
	return new vscode.Hover(md);
}

function provideHover(document, position) {
	const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
	if (!wordRange) return null;

	const word = document.getText(wordRange);
	const lineText = document.lineAt(position.line).text;
	const receiver = receiverBefore(lineText, wordRange.start.character);

	if (receiver === "WSON" && WSON_METHODS[word]) return buildHover(WSON_METHODS[word]);
	if (receiver === "Visual" && VISUAL_METHODS[word]) return buildHover(VISUAL_METHODS[word]);

	if (word === "getSchema") return buildHover(WSSCHEMA_METHODS.getSchema);

	// Heurística para WSDB: un receptor con mayúscula inicial (convención
	// de clase de colección/DTO) seguido de un método conocido de la
	// interfaz WSDB. No podemos saber con certeza en el editor si
	// "Persona" es de verdad una clase de un .wsdb sin resolver el
	// import — pero la combinación (Mayúscula).(save|selectAll|...) es
	//lo bastante específica para no dar falsos positivos molestos.
	if (receiver && /^[A-Z]/.test(receiver) && WSDB_METHOD_NAMES.has(word)) {
		return buildHover(WSDB_METHODS[word]);
	}
	// .after(...) encadenado sobre cualquier cosa (p. ej. tras
	// selectAll()[0] o el resultado de otro .save()) — mismo criterio,
	// sin exigir receptor con mayúscula porque puede venir de una
	// expresión, no de un identificador simple.
	if (word === "after" && lineText.slice(0, wordRange.start.character).trimEnd().endsWith(".")) {
		return buildHover(WSDB_METHODS.after);
	}

	if (!receiver && NAMESPACES[word]) {
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${word}**\n\n${NAMESPACES[word]}`);
		return new vscode.Hover(md);
	}

	if (!receiver && KEYWORDS[word]) return buildHover(KEYWORDS[word]);

	return null;
}

module.exports = { provideHover };
