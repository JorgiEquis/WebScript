const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../parser");
const { renderPageToHTML } = require("../codegen-ssr");

function ssr(sourceLines, opts) {
	return renderPageToHTML(parse(sourceLines.join("\n")), opts);
}

test("interpolación de texto simple", () => {
	const html = ssr(["reactive nombre = \"Ana\"", "visual app =", "<p>Hola {nombre}</p>", "Visual.render(app)"]);
	assert.equal(html, "<p>Hola Ana</p>");
});

test("escapa HTML en el contenido interpolado (sin inyección)", () => {
	const html = ssr(["reactive x = '<script>malo</script>'", "visual app =", "<p>{x}</p>", "Visual.render(app)"]);
	assert.ok(!html.includes("<script>malo</script>"));
	assert.ok(html.includes("&lt;script&gt;"));
});

test("if/else if/else: solo se renderiza la rama que cumple", () => {
	const html = ssr([
		"reactive contador = 2",
		"visual app =",
		"<div>",
		"\tif (contador == 0)",
		"\t\t<p>cero</p>",
		"\telse if (contador < 3)",
		"\t\t<p>pocos</p>",
		"\telse",
		"\t\t<p>muchos</p>",
		"</div>",
		"Visual.render(app)",
	]);
	assert.equal(html, "<div><!--if--><p>pocos</p><!--/if--></div>");
});

test("for: renderiza todos los elementos de la lista", () => {
	const html = ssr([
		'reactive frutas = ["a", "b", "c"]',
		"visual app =",
		"<ul>",
		"\tfor (f in frutas)",
		"\t\t<li>{f}</li>",
		"</ul>",
		"Visual.render(app)",
	]);
	assert.equal(html, "<ul><!--for--><li>a</li><li>b</li><li>c</li><!--/for--></ul>");
});

test("style: el nombre se compila a clase literal, no se evalúa como variable", () => {
	const html = ssr([
		"style caja = -> color: red",
		"visual app =",
		"<div class={caja}></div>",
		"Visual.render(app)",
	]);
	assert.equal(html, '<div class="caja"></div>');
});

test("eventos (onclick) se omiten en SSR, sin comportamiento posible", () => {
	const html = ssr(["reactive n = 0", "visual app =", "<button onclick={n++}>x</button>", "Visual.render(app)"]);
	assert.ok(!html.includes("onclick"));
	assert.equal(html, "<button>x</button>");
});

test("composición: props se pasan al componente y slot recibe contenido del padre", () => {
	const html = ssr([
		'reactive titulo = "Panel"',
		"visual tarjeta =",
		"<div><h3>{props.t}</h3><slot /></div>",
		"visual app =",
		"<tarjeta t={titulo}><p>contenido</p></tarjeta>",
		"Visual.render(app)",
	]);
	assert.equal(html, "<div><h3>Panel</h3><p>contenido</p></div>");
});

test("Visual.route()/params()/query() se resuelven contra requestUrl, no window.location", () => {
	const html = ssr(
		[
			"const Visual screen = Visual.route('/personas/:id')",
			"const {id} = Visual.params(screen)",
			"const {tab} = Visual.query(screen)",
			"visual app =",
			"<p>{id}-{tab}</p>",
			"Visual.render(app)",
		],
		{ requestUrl: "/personas/42?tab=datos" }
	);
	assert.equal(html, "<p>42-datos</p>");
});

test("sin Visual.render(), devuelve string vacío (no es una página)", () => {
	const html = ssr(["visual comp =", "<div></div>"]);
	assert.equal(html, "");
});
