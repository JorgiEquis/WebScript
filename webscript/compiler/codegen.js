// codegen.js — WebScript, v0
//
// Mismo criterio que la versión anterior del lenguaje (con render()/route()):
// un fichero es "página" si llama a Visual.render(...) a nivel superior, y
// "componente/librería" si no — sin que eso sea un error, es justo lo que
// permite que un .wsf se importe desde otro sin intentar montarse por su
// cuenta. El error real (pendiente de la fase de resolución de imports) es
// el caso contrario: un fichero importado que SÍ tiene Visual.render() —
// eso sí lo convertiría en página y librería a la vez, y debería rechazarse.

function hasVisualRender(ast) {
	return ast.body.some((node) => node.type === "Raw" && /^Visual\.render\(/.test(node.text));
}

function classifyWsf(ast) {
	return hasVisualRender(ast) ? "page" : "library";
}

module.exports = { hasVisualRender, classifyWsf };
