// La hidratación de un texto dinámico ({expr}) fallaba si SSR lo renderizaba
// VACÍO (p. ej. `reactive resultado = ""`): un string vacío insertado en HTML
// no produce ningún nodo, así que el cursor de hidratación (que consume un
// nodo por cada interpolación) topaba con `null` en el siguiente hermano —
// `Cannot read properties of null (reading 'nextSibling')` — y el clic que
// debía rellenar ese texto no hacía nada. Reproducido con el código anterior
// en una página SIN ningún `.ws`: no es un caso raro ni ligado a la vuelta
// anterior, es el patrón `reactive x = ""` a secas.
//
// El arreglo: SSR envuelve todo texto DINÁMICO en marcadores de comentario
// `<!--t-->...<!--/t-->` (mismo patrón que ya usaban `if`/`for` en este
// compilador para el mismo problema de fondo — contenido que puede
// desaparecer entero). La hidratación busca el nodo de texto entre esos dos
// comentarios y, si no está (contenido vacío), lo crea ahí mismo. El texto
// ESTÁTICO no lleva marcadores: su contenido no cambia tras el primer
// render, así que no hay nada que la hidratación deba reenganchar.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM, VirtualConsole } = require("jsdom");
const { parse } = require("../parser");
const { generateClientBundle } = require("../codegen-client");
const { renderPageToHTML } = require("../codegen-ssr");

// Monta `ssrHtml` (vacío si no hay SSR) en JSDOM, inyecta el bundle, hace
// clic en el botón y devuelve { errores, textoTrasClic }.
function montar(wsf, { conSSR }) {
	const ast = parse(wsf);
	const ssrHtml = conSSR ? renderPageToHTML(ast, {}) : "";
	const bundle = generateClientBundle(ast, {});
	const dom = new JSDOM(`<!DOCTYPE html><html><body>${ssrHtml}</body></html>`, { runScripts: "dangerously", virtualConsole: new VirtualConsole() });
	const errores = [];
	dom.window.addEventListener("error", (e) => errores.push(e.error ? e.error.message : e.message));
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	const boton = dom.window.document.querySelector("button");
	if (boton && !errores.length) boton.dispatchEvent(new dom.window.Event("click"));
	return { ssrHtml, errores, doc: dom.window.document };
}

function paginaTexto(valorInicial) {
	return [`reactive resultado = ${valorInicial}`, "", "visual app =", "<div>", "\t<button onclick={resultado = 'pulsado'}>ok</button>", "\t<p>{resultado}</p>", "</div>", "", "Visual.render(app)"].join("\n");
}

test("REGRESIÓN: una interpolación que SSR renderiza vacía se hidrata sin error, y sigue reactiva tras el clic", () => {
	const { ssrHtml, errores, doc } = montar(paginaTexto('""'), { conSSR: true });
	assert.equal(ssrHtml, "<div><button>ok</button><p><!--t--><!--/t--></p></div>");
	assert.deepEqual(errores, []);
	assert.equal(doc.querySelector("p").textContent, "pulsado");
});

test("NO REGRESIÓN: la misma página con un valor inicial NO vacío se sigue hidratando igual", () => {
	const { errores, doc } = montar(paginaTexto('"inicial"'), { conSSR: true });
	assert.deepEqual(errores, []);
	assert.equal(doc.querySelector("p").textContent, "pulsado");
});

test("NO REGRESIÓN: sin SSR (modo creación, sin marcadores) una interpolación vacía sigue funcionando", () => {
	const { errores, doc } = montar(paginaTexto('""'), { conSSR: false });
	assert.deepEqual(errores, []);
	assert.equal(doc.querySelector("p").textContent, "pulsado");
});

test("una interpolación MIXTA (literal + expr vacío) no necesita el marcador para tener contenido, pero lo lleva igual y se hidrata bien", () => {
	const wsf = ['reactive nombre = ""', "", "visual app =", "<div>", "\t<button onclick={nombre = 'Ana'}>ok</button>", "\t<p>Hola, {nombre}!</p>", "</div>", "", "Visual.render(app)"].join("\n");
	const { ssrHtml, errores, doc } = montar(wsf, { conSSR: true });
	assert.equal(ssrHtml, "<div><button>ok</button><p><!--t-->Hola, !<!--/t--></p></div>");
	assert.deepEqual(errores, []);
	assert.equal(doc.querySelector("p").textContent, "Hola, Ana!");
});

test("dos interpolaciones vacías seguidas, hermanas, se hidratan cada una en su propia posición (no se confunden los marcadores)", () => {
	const wsf = ['reactive a = ""', 'reactive b = ""', "", "visual app =", "<div>", "\t<button onclick={a = 'A'; b = 'B'}>ok</button>", "\t<p>{a}</p><p>{b}</p>", "</div>", "", "Visual.render(app)"].join("\n");
	const { errores, doc } = montar(wsf, { conSSR: true });
	assert.deepEqual(errores, []);
	const ps = doc.querySelectorAll("p");
	assert.equal(ps[0].textContent, "A");
	assert.equal(ps[1].textContent, "B");
});

test("un texto ESTÁTICO (sin interpolación) no lleva marcadores — no los necesita, su contenido no cambia", () => {
	const wsf = ["visual app =", "<p>fijo</p>", "", "Visual.render(app)"].join("\n");
	const ast = parse(wsf);
	const ssrHtml = renderPageToHTML(ast, {});
	assert.equal(ssrHtml, "<p>fijo</p>");
});

test("el efecto sigue reaccionando a MÁS de un cambio tras la hidratación (no es solo el primer clic)", () => {
	const wsf = ['reactive contador = ""', "", "visual app =", "<div>", "\t<button onclick={contador = (contador === '' ? 1 : contador + 1)}>ok</button>", "\t<p>{contador}</p>", "</div>", "", "Visual.render(app)"].join("\n");
	const { errores, doc } = montar(wsf, { conSSR: true });
	assert.deepEqual(errores, []);
	assert.equal(doc.querySelector("p").textContent, "1");
	doc.querySelector("button").dispatchEvent(new doc.defaultView.Event("click"));
	assert.equal(doc.querySelector("p").textContent, "2");
});
