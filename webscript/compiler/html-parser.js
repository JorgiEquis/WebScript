// html-parser.js — WebScript, v0
//
// Trabaja sobre el texto de cada línea de una plantilla `visual`, con una
// pila de tags abiertos (igual que la versión anterior del lenguaje):
// abrir un tag lo empuja a la pila y lo cuelga del elemento actualmente
// abierto; cerrar un tag comprueba que el nombre coincide con el que hay en
// la cima de la pila y lo desapila. Los nodos de control ya parseados
// (If/ElseIf/Else/For) no abren ni cierran tags por sí mismos: se cuelgan
// donde estén y su propio cuerpo se procesa recursivamente.

// Busca el `>` real que cierra un tag, saltando por encima de cualquier
// `{...}` completo (anidado) y de cadenas entre comillas — para no
// confundirse con un `>` de comparación o una llave interna.
function findTagEnd(text, start) {
	let i = start;
	let braceDepth = 0;
	let inString = null;

	while (i < text.length) {
		const c = text[i];

		if (inString) {
			if (c === "\\") { i += 2; continue; }
			if (c === inString) inString = null;
			i++;
			continue;
		}

		if (c === '"' || c === "'" || c === "`") { inString = c; i++; continue; }
		if (c === "{") { braceDepth++; i++; continue; }
		if (c === "}") { braceDepth--; i++; continue; }
		if (c === ">" && braceDepth === 0) return i;

		i++;
	}
	return -1; // sin cerrar
}

function splitNameAndAttrs(inner) {
	const m = /^(\S+)\s*([\s\S]*)$/.exec(inner.trim());
	if (!m) return { name: inner.trim(), attrsRaw: "" };
	return { name: m[1], attrsRaw: m[2] };
}

// Atributos: `clave`, `clave="texto"`, `clave={expr}` — respeta llaves
// anidadas y comillas dentro de `{expr}`.
function parseAttrs(raw) {
	const s = (raw || "").trim();
	const attrs = [];
	let i = 0;

	while (i < s.length) {
		while (s[i] === " ") i++;
		if (i >= s.length) break;

		const keyStart = i;
		while (i < s.length && s[i] !== "=" && s[i] !== " ") i++;
		const key = s.slice(keyStart, i);

		if (s[i] === "=") {
			i++;
			let value;
			if (s[i] === "{") {
				let depth = 0;
				let j = i;
				do {
					if (s[j] === "{") depth++;
					else if (s[j] === "}") depth--;
					j++;
				} while (j < s.length && depth > 0);
				value = s.slice(i, j);
				i = j;
			} else if (s[i] === '"' || s[i] === "'") {
				const quote = s[i];
				let j = i + 1;
				while (j < s.length && s[j] !== quote) j++;
				value = s.slice(i, j + 1);
				i = j + 1;
			} else {
				let j = i;
				while (j < s.length && s[j] !== " ") j++;
				value = s.slice(i, j);
				i = j;
			}
			attrs.push({ key, value });
		} else {
			attrs.push({ key, value: null }); // atributo booleano, sin valor
		}
	}

	return attrs;
}

// Trocea el texto de una línea en tokens: apertura de tag, cierre,
// autocierre, o texto/interpolación entre tags.
function scanLine(text) {
	const tokens = [];
	let i = 0;

	while (i < text.length) {
		if (text[i] === "<") {
			const end = findTagEnd(text, i + 1);
			if (end === -1) {
				// Tag sin cerrar en esta línea: se deja como texto crudo,
				// pendiente de una fase que una líneas también aquí si hiciera
				// falta (un tag no debería partirse entre líneas en la práctica).
				tokens.push({ kind: "text", value: text.slice(i) });
				break;
			}
			const inner = text.slice(i + 1, end);
			if (inner.startsWith("/")) {
				tokens.push({ kind: "close", name: inner.slice(1).trim() });
			} else if (inner.trim().endsWith("/")) {
				const { name, attrsRaw } = splitNameAndAttrs(inner.trim().slice(0, -1));
				tokens.push({ kind: "selfclose", name, attrs: parseAttrs(attrsRaw) });
			} else {
				const { name, attrsRaw } = splitNameAndAttrs(inner);
				tokens.push({ kind: "open", name, attrs: parseAttrs(attrsRaw) });
			}
			i = end + 1;
		} else {
			let next = text.indexOf("<", i);
			if (next === -1) next = text.length;
			const value = text.slice(i, next);
			if (value.trim() !== "") tokens.push({ kind: "text", value });
			i = next;
		}
	}

	return tokens;
}

// Construye el árbol real a partir de la lista de nodos de la plantilla
// (mezcla de nodos "Raw" con una línea de HTML, y nodos de control ya
// parseados como If/ElseIf/Else/For, cuyo `.body` se procesa recursivamente).
function buildHtmlTree(items) {
	const root = { children: [] };
	const stack = [root];
	const errors = [];

	const top = () => stack[stack.length - 1];

	for (const item of items) {
		if (item.type === "Raw") {
			for (const tok of scanLine(item.text)) {
				if (tok.kind === "open") {
					const el = { type: "Element", name: tok.name, attrs: tok.attrs, children: [], line: item.line };
					top().children.push(el);
					stack.push(el);
				} else if (tok.kind === "selfclose") {
					top().children.push({ type: "Element", name: tok.name, attrs: tok.attrs, children: [], selfClosing: true, line: item.line });
				} else if (tok.kind === "close") {
					if (stack.length <= 1 || top().name !== tok.name) {
						errors.push({ line: item.line, message: `cierre </${tok.name}> no coincide con ${stack.length > 1 ? `<${top().name}>` : "ningún tag abierto"}` });
					} else {
						stack.pop();
					}
				} else if (tok.kind === "text") {
					top().children.push({ type: "Text", value: tok.value, line: item.line });
				}
			}
		} else {
			// Nodo de control ya parseado — no abre/cierra tags, solo se cuelga
			// donde esté y se procesa su cuerpo recursivamente.
			const nested = item.body ? buildHtmlTree(item.body) : { children: [], errors: [] };
			errors.push(...nested.errors);
			top().children.push({ ...item, body: nested.children });
		}
	}

	if (stack.length > 1) {
		for (const el of stack.slice(1)) {
			errors.push({ line: el.line, message: `<${el.name}> sin cerrar` });
		}
	}

	return { children: root.children, errors };
}

module.exports = { buildHtmlTree, scanLine, parseAttrs };
