const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../parser");
const { classifyWsf } = require("../codegen");

test("clasifica como 'page' si llama a Visual.render()", () => {
	const ast = parse("visual app =\n<div></div>\nVisual.render(app)");
	assert.equal(classifyWsf(ast), "page");
});

test("clasifica como 'library' si no llama a Visual.render() (ej. un componente)", () => {
	const ast = parse("visual contadorItem =\n<div>{props.item.valor}</div>");
	assert.equal(classifyWsf(ast), "library");
});

// Sistema nuevo (sin Visual.ws, aditivo): el HTML suelto (PageDecl) se
// clasifica como página SIN necesidad de Visual.render(). Una `visual`
// única, sin HTML suelto y sin Visual.render(), sigue clasificándose como
// librería (deliberado: src/contador.wsf, del propio proyecto, es
// exactamente ese caso y es un componente reutilizable — ver DISEÑO.md).
test("REGRESIÓN nueva capacidad: HTML suelto (PageDecl) se clasifica como 'page' sin Visual.render()", () => {
	const ast = parse("<div>hola</div>");
	assert.equal(classifyWsf(ast), "page");
});

test("NO REGRESIÓN: una única 'visual', sin HTML suelto y sin Visual.render(), SIGUE siendo 'library' (no cambia con el sistema nuevo)", () => {
	const ast = parse("visual contadorItem =\n<div>{props.item.valor}</div>");
	assert.equal(classifyWsf(ast), "library");
});

test("NO REGRESIÓN: dos o más 'visual', sin HTML suelto y sin Visual.render(), siguen siendo 'library' (patrón de librería de varios componentes)", () => {
	const ast = parse(["visual uno =", "<p>uno</p>", "", "visual dos =", "<p>dos</p>"].join("\n"));
	assert.equal(classifyWsf(ast), "library");
});

test("un PageDecl antes de una 'visual' reutilizable: cada uno se reconoce por separado (el PageDecl es la página; la visual queda disponible para quien la importe)", () => {
	const ast = parse(["<div>página real</div>", "", "visual Reutilizable =", "<span>pieza</span>"].join("\n"));
	assert.deepEqual(
		ast.body.map((n) => n.type + (n.name ? ":" + n.name : "")),
		["PageDecl", "VisualDecl:Reutilizable"]
	);
	assert.equal(classifyWsf(ast), "page");
});

test("NO REGRESIÓN: una 'visual' seguida de HTML suelto AL MARGEN se sigue tratando como un segundo elemento raíz de ESA MISMA visual (ya soportado hoy para varios hermanos), no como un PageDecl nuevo — el orden importa: el HTML suelto debe ir ANTES de cualquier 'visual'", () => {
	const ast = parse(["visual Reutilizable =", "<span>pieza</span>", "<div>también de Reutilizable</div>"].join("\n"));
	const visual = ast.body.find((n) => n.type === "VisualDecl");
	assert.equal(ast.body.some((n) => n.type === "PageDecl"), false);
	assert.deepEqual(visual.html.map((n) => n.name), ["span", "div"]);
});
