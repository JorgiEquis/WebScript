// route-pattern.js — WebScript, v0
//
// Patrón de ruta de una página: el de su Visual.route() tal cual (con
// :params si los tiene — el matching real, por petición, lo hace
// compileRoutePatternClient) si lo declara; si no, "/" + su propio nombre
// de fichero. Compartido entre bin/websc.js (websc build) y
// serve-demo.js (varias páginas de golpe, sin montar un proyecto entero).

function routePatternFor(ast, baseName) {
	const routeDecl = ast.body.find(
		(n) => (n.type === "ConstDecl" || n.type === "VarDecl") && /^Visual\.route\(/.test(n.expr)
	);
	if (routeDecl) {
		const m = /^Visual\.route\(\s*['"]([^'"]+)['"]\s*\)$/.exec(routeDecl.expr);
		if (m) return m[1];
	}
	return `/${baseName}`;
}

module.exports = { routePatternFor };
