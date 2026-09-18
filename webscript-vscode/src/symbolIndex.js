// symbolIndex.js — indexador ligero por regex, línea a línea.
// No reutiliza el compilador completo (que exige el fichero bien formado
// de principio a fin): el editor necesita responder incluso con código a
// medio escribir, así que aquí basta con reconocer la línea de cabecera
// de cada declaración.

const DECL_PATTERNS = [
	{ re: /^(\s*)(?:export\s+)?reactive\s+(?:\w+\s+)?(\w+)\s*=/, group: 2 },
	{ re: /^(\s*)var\s+(?:[\w/]+\s+)?(\w+)\s*=/, group: 2 },
	{ re: /^(\s*)const\s+(?:WSON\s+)?(?:\w+\s+)?(\w+)\s*=/, group: 2 },
	{ re: /^(\s*)style\s+(\w+)\s*=/, group: 2 },
	{ re: /^(\s*)visual\s+(\w+)\s*=/, group: 2 },
	{ re: /^(\s*)(?:export\s+)?function\s+(\w+)\(/, group: 2 },
];

function buildIndex(text) {
	const lines = text.split(/\r?\n/);
	const symbols = [];

	lines.forEach((line, i) => {
		for (const { re, group } of DECL_PATTERNS) {
			const m = re.exec(line);
			if (m) {
				const name = m[group];
				const character = line.indexOf(name, m[1] ? m[1].length : 0);
				symbols.push({ name, line: i, character: character >= 0 ? character : 0, raw: line });
				break;
			}
		}
	});

	return symbols;
}

function parseImports(text) {
	const lines = text.split(/\r?\n/);
	const imports = [];
	const re = /^\s*import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/;

	for (const line of lines) {
		const m = re.exec(line);
		if (m) {
			imports.push({ names: m[1].split(",").map((s) => s.trim()), path: m[2] });
		}
	}

	return imports;
}

module.exports = { buildIndex, parseImports };
