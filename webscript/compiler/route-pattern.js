// route-pattern.js — WebScript, v0
//
// Patrón de ruta de una página. Dos fuentes, en este orden:
// 1. Su `Visual.route('/patrón')` tal cual, si lo declara (con :params si
//    los tiene — el matching real, por petición, lo hace
//    compileRoutePatternClient).
// 2. Si no, la ruta SALE DE LA RUTA DEL PROPIO FICHERO (sistema nuevo,
//    aditivo, sin Visual.ws): `api/listaProductos.wsf` → `/api/listaProductos`.
//    Un segmento con `:` en el nombre de fichero marca un parámetro
//    dinámico — `listaProductos:id.wsf` → `/listaProductos/:id` (el
//    parámetro se obtiene dentro con `params.id`, nombre reservado). Si el
//    segmento es SOLO el parámetro (`:id.wsf`), no añade ningún literal
//    delante — `/:id`, sin más.
//
// Compartido entre bin/websc.js (websc build) y serve-demo.js (varias
// páginas de golpe, sin montar un proyecto entero).

function expandSegment(segment) {
	const idx = segment.indexOf(":");
	if (idx === -1) return [segment];
	const literal = segment.slice(0, idx);
	const param = segment.slice(idx + 1);
	return literal ? [literal, `:${param}`] : [`:${param}`];
}

// `relativePathNoExt` es la ruta del fichero relativa a `src/`, SIN la
// extensión `.wsf` y con `/` como separador — para un fichero suelto en la
// raíz de `src/` es simplemente su nombre, igual que antes.
function routePatternFor(ast, relativePathNoExt) {
	const routeDecl = ast.body.find(
		(n) => (n.type === "ConstDecl" || n.type === "VarDecl") && /^Visual\.route\(/.test(n.expr)
	);
	if (routeDecl) {
		const m = /^Visual\.route\(\s*['"]([^'"]+)['"]\s*\)$/.exec(routeDecl.expr);
		if (m) return m[1];
	}
	const segments = relativePathNoExt.split("/").flatMap(expandSegment);
	return `/${segments.join("/")}`;
}

module.exports = { routePatternFor };
