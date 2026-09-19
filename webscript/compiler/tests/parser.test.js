const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../parser");

test("reactive/var/const con y sin tipo", () => {
	const ast = parse('reactive contador = 0\nvar Persona p1 = new Persona()\nconst pi = 3.14');
	assert.equal(ast.body[0].type, "ReactiveDecl");
	assert.equal(ast.body[0].varType, null);
	assert.equal(ast.body[1].type, "VarDecl");
	assert.equal(ast.body[1].varType, "Persona");
	assert.equal(ast.body[2].type, "ConstDecl");
	assert.equal(ast.body[2].name, "pi");
});

test("reactive detecta WSON.listen()", () => {
	const ast = parse("reactive any peticion = WSON.listen(wsonPost)");
	assert.equal(ast.body[0].isListen, true);
});

test("style parsea sus propiedades ->", () => {
	const ast = parse("style boton =\n\t-> background-color: blue\n\t-> color: white");
	assert.equal(ast.body[0].type, "StyleDecl");
	assert.equal(ast.body[0].body.length, 2);
	assert.equal(ast.body[0].body[0].key, "background-color");
	assert.equal(ast.body[0].body[0].value, "blue");
});

test(".wson: campo opcional y objeto anidado (regresión bug real)", () => {
	const source = [
		"-> to: \"/personas\"",
		"-> content:",
		"\tnombre: string",
		"\taltura: decimal/",
		"\tdireccion:",
		"\t\tnumero: integer",
	].join("\n");
	const ast = parse(source, { isWsonFile: true });
	const content = ast.fields.find((f) => f.type === "ContentSchema");

	const altura = content.fields.find((f) => f.name === "altura");
	assert.equal(altura.optional, true);
	assert.equal(altura.fieldType, "decimal");

	const direccion = content.fields.find((f) => f.name === "direccion");
	assert.equal(direccion.fieldType, "object");
	assert.equal(direccion.fields[0].name, "numero");
});

test("expresión multilínea no se rompe en sentencias sueltas (regresión bug real)", () => {
	const source = [
		"watch(x)",
		"\tvar nueva = new Persona(",
		"\t\tcontenido.nombre,",
		"\t\tcontenido.altura",
		"\t)",
	].join("\n");
	const ast = parse(source);
	const watch = ast.body[0];
	assert.equal(watch.type, "WatchDecl");
	assert.equal(watch.body.length, 1); // una única VarDecl, no 4 nodos sueltos
	assert.equal(watch.body[0].type, "VarDecl");
	assert.match(watch.body[0].expr, /new Persona\(.*contenido\.altura.*\)/);
});

test("if/elseif/else guardan su cuerpo como array bajo 'body' (regresión bug real)", () => {
	const source = [
		"watch(x)",
		"\tif (a == 0)",
		"\t\tvar r = 1",
		"\telse",
		"\t\tvar r = 2",
	].join("\n");
	const ast = parse(source);
	const ifNode = ast.body[0].body[0];
	assert.equal(Array.isArray(ifNode.body), true);
	assert.equal(ifNode.body[0].type, "VarDecl");
	// No debe colarse como propiedades "0", "1"... del propio nodo If.
	assert.equal(ifNode["0"], undefined);
});

test("visual: HTML no se anida por indentación sino por tags (regresión bug real)", () => {
	const source = [
		"visual contador =",
		"<div>",
		"\t<button>Sumar</button>",
		"</div>",
	].join("\n");
	const ast = parse(source);
	const visual = ast.body[0];

	assert.equal(visual.type, "VisualDecl");
	assert.equal(visual.htmlErrors.length, 0);
	assert.equal(visual.html.length, 1); // un solo <div> raíz
	assert.equal(visual.html[0].name, "div");
	assert.equal(visual.html[0].children[0].name, "button");
});

test("visual: 'reactive' dentro ya no está soportada (estado local por instancia eliminado)", () => {
	const source = ["visual x =", "\treactive n = 0", "<div></div>"].join("\n");
	const ast = parse(source);
	const visual = ast.body[0];

	assert.equal(visual.htmlErrors.length, 1);
	assert.match(visual.htmlErrors[0].message, /reactive.*visual.*no está soportada/);
});

test("visual: props en un tag-componente se capturan como atributos normales", () => {
	const source = ["visual app =", "<contadorItem item={item} />"].join("\n");
	const ast = parse(source);
	const el = ast.body[0].html[0];

	assert.equal(el.name, "contadorItem");
	assert.equal(el.selfClosing, true);
	assert.equal(el.attrs[0].key, "item");
	assert.equal(el.attrs[0].value, "{item}");
});

test("visual: el atributo slot=\"nombre\" en contenido pasado a un componente se captura tal cual (routing es cosa del codegen)", () => {
	const source = [
		"visual app =",
		"<tarjeta>",
		'\t<h3 slot="header">Personas</h3>',
		"\t<ul></ul>",
		"</tarjeta>",
	].join("\n");
	const ast = parse(source);
	const tarjeta = ast.body[0].html[0];

	const h3 = tarjeta.children[0];
	assert.equal(h3.attrs.find((a) => a.key === "slot").value, '"header"');

	const ul = tarjeta.children[1];
	assert.equal(ul.attrs.length, 0); // sin slot -> va al slot por defecto
});

test("Visual.render(...) no se traga como parte de la plantilla anterior (regresión bug real)", () => {
	const source = ["visual app =", "<div></div>", "Visual.render(app)"].join("\n");
	const ast = parse(source);

	assert.equal(ast.body.length, 2);
	assert.equal(ast.body[0].type, "VisualDecl");
	assert.equal(ast.body[1].type, "Raw");
	assert.equal(ast.body[1].text, "Visual.render(app)");
});

test("Visual.route() se parsea como un const normal (var+expr), sin sintaxis especial", () => {
	const ast = parse("const Visual screen = Visual.route('/personas/:id')");
	const decl = ast.body[0];
	assert.equal(decl.type, "ConstDecl");
	assert.equal(decl.varType, "Visual");
	assert.equal(decl.name, "screen");
	assert.equal(decl.expr, "Visual.route('/personas/:id')");
});

test("desestructuración en const: const {id} = Visual.params(screen)", () => {
	const ast = parse("const {id} = Visual.params(screen)");
	const decl = ast.body[0];
	assert.equal(decl.type, "ConstDecl");
	assert.equal(decl.name, "{id}");
	assert.equal(decl.expr, "Visual.params(screen)");
});

test("desestructuración en var, con varios nombres", () => {
	const ast = parse("var {id, nombre} = obtenerDatos()");
	assert.equal(ast.body[0].name, "{id, nombre}");
});

test("import con varios nombres", () => {
	const ast = parse('import { A, B } from "./archivo.ws"');
	assert.deepEqual(ast.body[0].names, ["A", "B"]);
	assert.equal(ast.body[0].from, "./archivo.ws");
});

test("function con parámetros tipados y sin tipar (mezcla permitida)", () => {
	const ast = parse("function saluda(string nombre, edad)\n\treturn nombre");
	const fn = ast.body[0];

	assert.equal(fn.type, "FunctionDecl");
	assert.deepEqual(fn.params[0], { paramType: "string", name: "nombre" });
	assert.deepEqual(fn.params[1], { paramType: null, name: "edad" });
});
