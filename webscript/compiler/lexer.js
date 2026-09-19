// lexer.js — WebScript, v0
//
// No tokeniza carácter a carácter: WebScript es indentación-significativa
// (como Python), así que la unidad útil aquí es la "línea lógica": su nivel
// de indentación (nº de tabs/espacios al principio) y su texto ya sin ese
// espacio. La jerarquía real (qué línea es hija de cuál) la construye
// buildTree() a partir de esta lista plana.

// Cuenta el balance de ([{ }]) de una línea, ignorando lo que esté dentro
// de comillas (simples, dobles o backtick) y cortando en un comentario "//"
// que no esté dentro de una cadena.
function bracketDelta(text) {
	let depth = 0;
	let inString = null;

	for (let i = 0; i < text.length; i++) {
		const c = text[i];

		if (inString) {
			if (c === "\\") { i++; continue; } // carácter escapado, se salta
			if (c === inString) inString = null;
			continue;
		}

		if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
		if (c === "/" && text[i + 1] === "/") break; // comentario: resto ignorado

		if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) depth--;
	}

	return depth;
}

// Une líneas consecutivas en una sola mientras la anterior deje paréntesis,
// corchetes o llaves sin cerrar — para que una llamada repartida en varias
// líneas (habitual en JS) se trate como una única expresión, no como si las
// líneas siguientes fueran hijas de la primera en el árbol de indentación.
function mergeContinuations(lines) {
	const merged = [];
	let pendingDepth = 0;

	for (const line of lines) {
		if (pendingDepth > 0 && merged.length > 0) {
			merged[merged.length - 1].text += " " + line.text;
		} else {
			merged.push({ ...line });
		}
		pendingDepth = Math.max(0, pendingDepth + bracketDelta(line.text));
	}

	return merged;
}

function tokenize(source) {
	const rawLines = source.split(/\r?\n/);
	const lines = [];

	rawLines.forEach((raw, i) => {
		const lineNumber = i + 1;
		const trimmed = raw.trim();

		// Línea en blanco, o comentario de línea completa: fuera.
		if (trimmed === "" || trimmed.startsWith("//")) return;

		// Indentación: contamos tabs; 4 espacios cuentan como 1 tab,
		// para tolerar ficheros que usen espacios en vez de tabs.
		const leading = raw.match(/^[\t ]*/)[0];
		const indent =
			(leading.match(/\t/g) || []).length +
			Math.floor((leading.match(/ /g) || []).length / 4);

		lines.push({ indent, text: trimmed, line: lineNumber });
	});

	return mergeContinuations(lines);
}

// Convierte la lista plana de líneas en un árbol: cada línea guarda sus
// líneas hijas (las siguientes con indentación estrictamente mayor, hasta
// que aparece una de indentación igual o menor).
function buildTree(lines) {
	const root = { children: [] };
	const stack = [{ indent: -1, node: root }];

	for (const line of lines) {
		const node = { ...line, children: [] };

		while (stack[stack.length - 1].indent >= line.indent) {
			stack.pop();
		}

		stack[stack.length - 1].node.children.push(node);
		stack.push({ indent: line.indent, node });
	}

	return root.children;
}

module.exports = { tokenize, buildTree, mergeContinuations, bracketDelta };
