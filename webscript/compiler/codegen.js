// codegen.js — WebScript, v0
//
// Sistema ANTIGUO (Visual.render() explícito): un fichero es "página" si
// llama a Visual.render(...) a nivel superior, y "componente/librería" si
// no — sin que eso sea un error, es justo lo que permite que un .wsf se
// importe desde otro sin intentar montarse por su cuenta.
//
// Sistema NUEVO, ADITIVO (HTML suelto, sin Visual.ws): sin ninguna llamada
// a Visual.render(), un fichero también es "página" si tiene HTML suelto
// (un PageDecl — ver parser.js) o EXACTAMENTE una `visual` declarada; en
// ese caso se renderiza implícitamente, sin llamada explícita. Un PageDecl
// SIEMPRE es la página si está presente (aunque el fichero también declare
// `visual` reutilizables para que otros los importen). Sin PageDecl, DOS O
// MÁS `visual` sin Visual.render() se tratan como librería, NO como error:
// es exactamente el patrón ya existente de un fichero que declara varios
// componentes reutilizables para que otros los importen, y no se quería
// romper ese caso (aditivo de verdad). El error explícito de "no se sabe
// cuál renderizar" que describe DISEÑO.md solo se lanza cuando alguien
// intenta renderizar ESE fichero como página con dos o más `visual` y sin
// PageDecl que desempate — ver generateClientBundle/renderPageToHTML.
function hasVisualRender(ast) {
	return ast.body.some((node) => node.type === "Raw" && /^Visual\.render\(/.test(node.text));
}

// El nodo que se renderiza implícitamente como página bajo el sistema
// nuevo, o null si no aplica. SOLO un PageDecl (HTML suelto) cuenta —
// deliberadamente NO una `visual nombre = ` única sin HTML suelto, aunque
// esa regla también se describió: un fichero real del propio proyecto
// (src/contador.wsf) es exactamente "una única `visual`, sin
// Visual.render()", y hoy es un componente reutilizable que importa
// app.wsf — auto-renderizarlo como página propia rompería el build real.
// Aditivo de verdad significa que el estilo antiguo (`visual` + opcional
// Visual.render()) no cambia de comportamiento en NINGÚN caso, ni siquiera
// en el borde de una sola `visual`.
function findImplicitPageTarget(ast) {
	return ast.body.find((n) => n.type === "PageDecl") || null;
}

function classifyWsf(ast) {
	if (hasVisualRender(ast)) return "page";
	return findImplicitPageTarget(ast) ? "page" : "library";
}

module.exports = { hasVisualRender, classifyWsf, findImplicitPageTarget };
