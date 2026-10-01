// parser.js — WebScript, v0
//
// Recorre el árbol de líneas del lexer y reconoce, por patrón de texto, las
// declaraciones de nivel superior del lenguaje. Todo lo que no reconoce
// (una etiqueta HTML dentro de un `visual`, una sentencia JS suelta dentro
// de un `watch`, etc.) se queda como nodo "Raw" — es la frontera real de
// este primer corte: estructura del árbol resuelta, contenido de cada nodo
// pendiente de un parser dedicado por contexto (HTML, expresiones JS...).

const TOP_LEVEL_RE = [
	/^import\b/,
	/^export\b/,
	/^style\s+\w+\s*=/,
	/^visual\s+\w+\s*=/,
	/^reactive\b/,
	/^var\b/,
	/^const\b/,
	/^watch\(/,
	/^function\b/,
	/^Visual\.render\(/,
];

function isTopLevelBoundary(text) {
	return TOP_LEVEL_RE.some((re) => re.test(text));
}

// A diferencia de todo lo demás, la plantilla de un `visual` NO se anida
// por indentación (el `<div>` va al margen, igual que la propia cabecera
// `visual nombre =`) — se reconoce por tags abrir/cerrar. Por eso el
// `visual` se trocea aparte de la indentación genérica: se consumen líneas
// hasta la siguiente declaración de nivel superior real, no hasta que baje
// la indentación.
function splitTopLevel(lines) {
	const chunks = [];
	let i = 0;

	while (i < lines.length) {
		const header = lines[i];
		let j = i + 1;

		// El HTML SUELTO de un .wsf (la página, sin envolver en `visual
		// nombre = `) se trocea EXACTAMENTE igual que un `visual`: no se
		// anida por indentación, se reconoce por tags abrir/cerrar, y se
		// consumen líneas hasta la siguiente declaración de nivel superior
		// real. Es lo que permite escribir `if`/`for`/`else` al margen,
		// mezclado con las etiquetas, tal como ya podía hacerse dentro de
		// un `visual`.
		if (/^visual\s+\w+\s*=/.test(header.text) || isBareHtmlStart(header.text)) {
			while (j < lines.length && !(lines[j].indent === header.indent && isTopLevelBoundary(lines[j].text))) {
				j++;
			}
		} else {
			while (j < lines.length && lines[j].indent > header.indent) {
				j++;
			}
		}

		chunks.push({ header, rest: lines.slice(i + 1, j) });
		i = j;
	}

	return chunks;
}

// Una línea que abre una etiqueta HTML/JSX a nivel superior (`<html>`,
// `<div>`, `<Componente />`...) — la señal de que el fichero usa HTML
// SUELTO como página, en vez de envolverlo en `visual nombre = `. Una
// etiqueta de CIERRE suelta (`</div>` sin apertura) no cuenta como inicio:
// se deja caer al camino normal, que la rechazará con un error de sintaxis
// claro en vez de tragársela como si fuera el arranque de la página.
function isBareHtmlStart(text) {
	return /^<[A-Za-z]/.test(text);
}

// Dentro de la plantilla, si/for SÍ vuelven a usar indentación para acotar
// su propio cuerpo (eso no ha cambiado) — solo las líneas HTML sueltas se
// tratan como una secuencia plana, sin anidar por indentación.
function collectIndented(lines, start, parentIndent) {
	const body = [];
	let j = start;
	while (j < lines.length && lines[j].indent > parentIndent) {
		body.push(lines[j]);
		j++;
	}
	return { body, next: j };
}

function parseTemplateSequence(lines) {
	const items = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		let m;

		if ((m = /^if\s*\((.*)\)$/.exec(line.text))) {
			const { body, next } = collectIndented(lines, i + 1, line.indent);
			items.push({ type: "If", cond: m[1], body: parseTemplateSequence(body), line: line.line });
			i = next;
		} else if ((m = /^else if\s*\((.*)\)$/.exec(line.text))) {
			const { body, next } = collectIndented(lines, i + 1, line.indent);
			items.push({ type: "ElseIf", cond: m[1], body: parseTemplateSequence(body), line: line.line });
			i = next;
		} else if (/^else$/.test(line.text)) {
			const { body, next } = collectIndented(lines, i + 1, line.indent);
			items.push({ type: "Else", body: parseTemplateSequence(body), line: line.line });
			i = next;
		} else if ((m = /^for\s*\((\w+)\s+in\s+(.*)\)$/.exec(line.text))) {
			const { body, next } = collectIndented(lines, i + 1, line.indent);
			items.push({ type: "For", item: m[1], list: m[2], body: parseTemplateSequence(body), line: line.line });
			i = next;
		} else {
			items.push({ type: "Raw", text: line.text, line: line.line });
			i++;
		}
	}

	return items;
}

function parseVisualChunk(header, rest) {
	const { buildHtmlTree } = require("./html-parser");
	const m = /^visual\s+(\w+)\s*=\s*(.*)$/.exec(header.text);
	const name = m[1];
	const inline = m[2] || null;

	// Ya no existe estado local por instancia: una `reactive` dentro de un
	// `visual` es un error de diseño, no una declaración válida — el caso
	// que cubría (estado propio por elemento de una lista) se resuelve con
	// `props` + guardando el estado dentro del propio dato.
	const reactiveInside = inline ? [] : rest.filter((l) => /^reactive\b/.test(l.text));
	const templateLines = inline ? rest : rest.filter((l) => !/^reactive\b/.test(l.text));

	const templateItems = inline
		? [{ type: "Raw", text: inline, line: header.line }]
		: parseTemplateSequence(templateLines);

	const html = buildHtmlTree(templateItems);
	const errors = html.errors.concat(
		reactiveInside.map((l) => ({
			line: l.line,
			message: "una 'reactive' dentro de un visual ya no está soportada (no hay estado local por instancia) — usa una reactive global y pásala como prop",
		}))
	);

	return { type: "VisualDecl", name, html: html.children, htmlErrors: errors, line: header.line };
}

// El HTML SUELTO de la página (sin `visual nombre = `): la propia línea de
// cabecera YA es contenido HTML de verdad (`<html>`, `<div>`...), a
// diferencia de un `visual` donde la cabecera es solo la declaración — así
// que aquí se antepone a `rest` antes de construir la secuencia de
// plantilla. Mismo criterio que un `visual` para todo lo demás: una
// `reactive` mezclada con el HTML es un error (debe ir fuera), y el árbol
// se construye con el mismo `buildHtmlTree`.
function parsePageChunk(header, rest) {
	const { buildHtmlTree } = require("./html-parser");
	const allLines = [header, ...rest];

	const reactiveInside = allLines.filter((l) => /^reactive\b/.test(l.text));
	const templateLines = allLines.filter((l) => !/^reactive\b/.test(l.text));

	const templateItems = parseTemplateSequence(templateLines);
	const html = buildHtmlTree(templateItems);
	const errors = html.errors.concat(
		reactiveInside.map((l) => ({
			line: l.line,
			message: "una 'reactive' mezclada con el HTML suelto de la página no está soportada — declárala fuera, antes o después del HTML",
		}))
	);

	return { type: "PageDecl", html: html.children, htmlErrors: errors, line: header.line };
}

// "Persona[]" es un alias de "Persona(array)" en una declaración tipada —
// se normaliza aquí para que el resto del compilador solo vea una forma.
function normalizeArrayType(t) {
	if (!t) return null;
	return t.endsWith("[]") ? `${t.slice(0, -2)}(array)` : t;
}

const RULES = [
	{
		type: "Import",
		re: /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']$/,
		build: (m) => ({ names: m[1].split(",").map((s) => s.trim()), from: m[2] }),
	},
	{
		// import por defecto (sin llaves) — pensado sobre todo para JSON,
		// donde no tiene sentido desestructurar por nombre: `import posts
		// from "./posts.json"` — el contenido entero del fichero queda
		// ligado a `posts`.
		type: "Import",
		re: /^import\s+(\w+)\s+from\s*["']([^"']+)["']$/,
		build: (m) => ({ names: [m[1]], from: m[2], isDefault: true }),
	},
	{
		// export delante de cualquier otra declaración: se re-parsea el resto
		// y se marca como exportada.
		type: "Export",
		re: /^export\s+(.+)$/,
		build: (m, node) => {
			const inner = parseNode({ ...node, text: m[1] });
			return { declaration: inner };
		},
	},
	{
		type: "StyleDecl",
		re: /^style\s+(\w+)\s*=\s*(.*)$/,
		build: (m) => ({ name: m[1], inline: m[2] || null }),
		body: (node) => node.children.map(parsePropertyLine),
	},
	{
		type: "WsonInlineDecl",
		// const WSON nombre = ...   (WSON declarado en código, no en un .wson)
		re: /^const\s+WSON\s+(\w+)\s*=\s*(.*)$/,
		build: (m) => ({ name: m[1] }),
		body: (node) => node.children.map(parseWsonMetaLine),
	},
	{
		type: "ReactiveDecl",
		re: /^(shared\s+)?(global\s+)?reactive\s+(?:([\w/]+(?:\(array\)|\[\])?)\s+)?(\w+)\s*=\s*(.*)$/,
		build: (m) => ({
			shared: !!m[1],
			global: !!m[2],
			varType: normalizeArrayType(m[3]),
			name: m[4],
			expr: m[5],
			isListen: /^WSON\.listen\(/.test(m[5]),
		}),
	},
	{
		type: "VarDecl",
		re: /^(global\s+)?var\s+(?:([\w/]+(?:\(array\)|\[\])?)\s+)?(\{[^}]*\}|\w+)\s*=\s*(.*)$/,
		build: (m) => ({ global: !!m[1], varType: normalizeArrayType(m[2]), name: m[3], expr: m[4] }),
	},
	{
		type: "ConstDecl",
		re: /^(global\s+)?const\s+(?:([\w/]+(?:\(array\)|\[\])?)\s+)?(\{[^}]*\}|\w+)\s*=\s*(.*)$/,
		build: (m) => ({ global: !!m[1], varType: normalizeArrayType(m[2]), name: m[3], expr: m[4] }),
	},
	{
		type: "WatchDecl",
		re: /^watch\((\w+)\)$/,
		build: (m) => ({ target: m[1] }),
		body: (node) => node.children.map(parseNode),
	},
	{
		type: "If",
		re: /^if\s*\((.*)\)$/,
		build: (m) => ({ cond: m[1] }),
		body: (node) => node.children.map(parseNode),
	},
	{
		type: "ElseIf",
		re: /^else if\s*\((.*)\)$/,
		build: (m) => ({ cond: m[1] }),
		body: (node) => node.children.map(parseNode),
	},
	{
		type: "Else",
		re: /^else$/,
		build: () => ({}),
		body: (node) => node.children.map(parseNode),
	},
	{
		type: "For",
		re: /^for\s*\((\w+)\s+in\s+(.*)\)$/,
		build: (m) => ({ item: m[1], list: m[2] }),
		body: (node) => node.children.map(parseNode),
	},
	{
		type: "FunctionDecl",
		re: /^(online\s+)?function\s+(\w+)\(([^)]*)\)(?:\s*->\s*(\w+))?$/,
		build: (m) => {
			if (m[4] && m[4] !== "idempotent") {
				throw new Error(`function ${m[2]}: modificador desconocido "-> ${m[4]}" (solo se admite "-> idempotent", y solo en "online function")`);
			}
			if (m[4] && !m[1]) {
				throw new Error(`function ${m[2]}: "-> idempotent" solo tiene sentido en una "online function" (esta no lleva "online")`);
			}
			return { name: m[2], params: splitParams(m[3]), online: !!m[1], idempotent: m[4] === "idempotent" };
		},
		body: (node) => node.children.map(parseNode),
	},
];

function splitParams(s) {
	return s
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => {
			// "string arg1" -> tipado; "arg1" a secas -> sin tipo (sigue
			// siendo válido, el tipado en parámetros es opcional).
			const m = /^([\w/]+)\s+(\w+)$/.exec(p);
			if (m) return { paramType: m[1], name: m[2] };
			return { paramType: null, name: p };
		});
}

// Líneas hijas de un `style`: "-> propiedad: valor"
function parsePropertyLine(node) {
	const m = /^->\s*([\w-]+)\s*:\s*(.+)$/.exec(node.text);
	if (!m) return { type: "Raw", text: node.text, line: node.line };
	return { type: "Property", key: m[1], value: m[2], line: node.line };
}

// Líneas hijas de un WSON ad-hoc, de un fichero .wson, o de un fichero
// .wsdb: "-> clave: valor", con soporte especial para "-> content:" (WSON)
// o "-> schema:" (WSDB) cuyo cuerpo es el esquema de campos (anidado por
// indentación, sin flecha) — mismo formato de campo en los dos casos.
function parseWsonMetaLine(node) {
	const m = /^->\s*(\w+)\s*:\s*(.*)$/.exec(node.text);
	if (!m) return { type: "Raw", text: node.text, line: node.line };

	if ((m[1] === "content" || m[1] === "schema") && m[2] === "") {
		return {
			type: "ContentSchema",
			fields: node.children.map(parseSchemaField),
			line: node.line,
		};
	}
	return { type: "MetaField", key: m[1], value: m[2], line: node.line };
}

// Líneas del esquema dentro de "content:" en un .wson: "campo: tipo",
// con anidamiento para objetos.
function parseSchemaField(node) {
	const m = /^(\w+)\s*:\s*(.*)$/.exec(node.text);
	if (!m) return { type: "Raw", text: node.text, line: node.line };

	const [, name, rawType] = m;
	const optional = rawType.endsWith("/");
	const type = optional ? rawType.slice(0, -1) : rawType;

	if (node.children.length > 0) {
		// "object" implícito: hay subcampos anidados. El tipo tras ":" puede
		// venir vacío ("direccion:") o, en teoría, ausente del todo.
		return {
			type: "SchemaField",
			name,
			fieldType: "object",
			optional,
			fields: node.children.map(parseSchemaField),
			line: node.line,
		};
	}
	return { type: "SchemaField", name, fieldType: type, optional, line: node.line };
}

// Fichero .wson "puro": empieza directamente con líneas "-> clave: valor" a
// nivel raíz, sin un "const WSON nombre =" delante.
function parseWsonFile(topLevelNodes) {
	return { type: "WsonSchema", fields: topLevelNodes.map(parseWsonMetaLine) };
}

// Fichero .wsdb: mismo formato de líneas "-> clave: valor" que un .wson,
// con cabecera ("-> name:", min/max/depends), "-> schema" con o sin ":",
// campos con o sin "->" delante, y tipos con longitud/clave primaria —
// integer(10)(primary), decimal(2,3)... Tiene su propio tipo de nodo raíz
// (WsdbSchema) — para que codegen-wsdb.js lo reconozca sin confundirlo con
// un DTO de mensajería puntual.
//
// Solo existe este formato. El anterior ("-> collection:", con find/
// findOne/findById/deleteMany) se eliminó — se rechaza aquí con un error
// que dice cómo migrarlo, en vez de interpretarlo a medias en silencio.
function parseWsdbFile(topLevelNodes) {
	const nodes = topLevelNodes.map(stripWsdbComments);
	const hasName = nodes.some((n) => /^->\s*name\s*:/.test(n.text));
	if (!hasName) {
		if (nodes.some((n) => /^->\s*collection\s*:/.test(n.text))) {
			throw new Error(
				'este .wsdb usa el formato antiguo ("-> collection:"), que ya no se admite — ' +
					'usa el formato actual: "-> name: \'nombre\'" y "-> schema:" con los campos ' +
					"(p. ej. \"id: integer(10)(primary)/\"). Se importa con las dos clases que genera " +
					'(<Nombre> y <Nombre>Schema) y se consulta con save/selectAll/select/delete/deleteWhere ' +
					"en vez de find/findOne/findById/deleteMany. Ver DISEÑO.md, sección .wsdb."
			);
		}
		throw new Error('este .wsdb no declara "-> name: \'nombre\'" — es obligatorio (da nombre a las clases <Nombre> y <Nombre>Schema)');
	}

	const fields = nodes.map((node) => {
		if (/^->\s*schema\s*:?\s*$/.test(node.text)) {
			return { type: "ContentSchema", fields: node.children.map(parseWsdbField), line: node.line };
		}
		return parseWsonMetaLine(node);
	});
	return { type: "WsdbSchema", fields };
}

// Quita comentarios "// ..." de una línea de .wsdb (y de sus hijas), sin
// tocar un "//" que esté dentro de comillas — p. ej. una URL en un valor.
function stripWsdbComments(node) {
	let out = "";
	let quote = null;
	const t = node.text;
	for (let i = 0; i < t.length; i++) {
		const c = t[i];
		if (quote) {
			if (c === quote && t[i - 1] !== "\\") quote = null;
		} else if (c === '"' || c === "'" || c === "`") {
			quote = c;
		} else if (c === "/" && t[i + 1] === "/") {
			break;
		}
		out += c;
	}
	return { ...node, text: out.trim(), children: (node.children || []).map(stripWsdbComments) };
}

// Campo de un esquema .wsdb v2: "[->] nombre: tipo(args)(modificadores)[/]"
//   integer(10)(primary)  -> longitud 10, clave primaria
//   decimal(2,3)          -> 2 dígitos enteros, 3 decimales
//   string(40)/           -> longitud máxima 40, opcional
//   string(array)         -> igual que en .wson
// Los números van en su propio paréntesis; los modificadores (primary,
// array) en el suyo — el orden entre paréntesis no importa.
function parseWsdbField(node) {
	const text = node.text.replace(/^->\s*/, "");
	const m = /^(\w+)\s*:\s*(.*)$/.exec(text);
	if (!m) {
		throw new Error(`Línea ${node.line} del .wsdb: se esperaba "nombre: tipo", encontrado "${node.text}"`);
	}
	const [, name, rawTypeFull] = m;
	let rawType = rawTypeFull.trim();
	const optional = rawType.endsWith("/");
	if (optional) rawType = rawType.slice(0, -1).trim();

	if (node.children.length > 0) {
		return { type: "SchemaField", name, fieldType: "object", optional, fields: node.children.map(parseSchemaField), line: node.line };
	}

	const tm = /^(\w+)((?:\s*\([^)]*\))*)$/.exec(rawType);
	if (!tm) {
		throw new Error(`Línea ${node.line} del .wsdb: tipo no válido "${rawTypeFull.trim()}" en el campo "${name}"`);
	}
	const base = tm[1];
	let size = null;
	let primary = false;
	let isArray = false;
	for (const [, inner] of tm[2].matchAll(/\(([^)]*)\)/g)) {
		const content = inner.trim();
		if (content === "primary") primary = true;
		else if (content === "array") isArray = true;
		else if (/^\d+(\s*,\s*\d+)?$/.test(content)) {
			if (size) throw new Error(`Línea ${node.line} del .wsdb: el campo "${name}" declara la longitud dos veces`);
			size = content.split(",").map((n) => parseInt(n.trim(), 10));
		} else {
			throw new Error(`Línea ${node.line} del .wsdb: modificador desconocido "(${content})" en el campo "${name}" (se admite una longitud, "primary" o "array")`);
		}
	}
	return {
		type: "SchemaField",
		name,
		fieldType: isArray ? `${base}(array)` : base,
		optional,
		size,
		primary,
		line: node.line,
	};
}

function parseNode(node) {
	for (const rule of RULES) {
		const m = rule.re.exec(node.text);
		if (!m) continue;
		const built = rule.build(m, node);
		const bodyResult = rule.body ? rule.body(node) : null;
		// Si el cuerpo es un array (If/For/watch/...), va bajo la clave
		// "body"; si ya es un objeto con sus propias claves (style, visual,
		// wson ad-hoc), se mezcla tal cual.
		const bodyProps = Array.isArray(bodyResult)
			? { body: bodyResult }
			: bodyResult || {};
		return { type: rule.type, ...built, ...bodyProps, line: node.line };
	}
	// No reconocida: nodo crudo (HTML, sentencia JS suelta, etc.), con sus
	// hijos también parseados por si son control de flujo o más HTML.
	return {
		type: "Raw",
		text: node.text,
		children: node.children.map(parseNode),
		line: node.line,
	};
}

function parse(source, { isWsonFile = false, isWsdbFile = false } = {}) {
	const { tokenize, buildTree } = require("./lexer");

	if (isWsonFile) {
		const tree = buildTree(tokenize(source));
		return parseWsonFile(tree);
	}
	if (isWsdbFile) {
		const tree = buildTree(tokenize(source));
		return parseWsdbFile(tree);
	}

	const lines = tokenize(source);
	const chunks = splitTopLevel(lines);

	const body = chunks.map(({ header, rest }) => {
		if (/^visual\s+\w+\s*=/.test(header.text)) {
			return parseVisualChunk(header, rest);
		}
		if (isBareHtmlStart(header.text)) {
			return parsePageChunk(header, rest);
		}
		return parseNode({ ...header, children: buildTree(rest) });
	});

	return { type: "Program", body };
}

module.exports = { parse };
