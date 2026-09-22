const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createStore, effect, toRaw } = require("../runtime");

test("effect() corre inmediatamente al crearse", () => {
	let ejecutado = false;
	effect(() => { ejecutado = true; });
	assert.equal(ejecutado, true);
});

test("effect() vuelve a correr cuando cambia una propiedad que leyó", () => {
	const state = createStore({ n: 0 });
	let visto = null;
	effect(() => { visto = state.n; });
	state.n = 5;
	assert.equal(visto, 5);
});

test("reactividad profunda en objetos anidados dentro de un array", () => {
	const state = createStore({ items: [{ valor: 0 }] });
	let vistos = 0;
	effect(() => { vistos = state.items[0].valor; });
	state.items[0].valor = 5;
	assert.equal(vistos, 5);
});

test("REGRESIÓN bug real: unshift no debe perder la identidad de los objetos ya existentes", () => {
	const state = createStore({ items: [{ texto: "uno" }, { texto: "dos" }] });
	const unoAntes = state.items[0];

	state.items.unshift({ texto: "cero" });

	assert.deepEqual(state.items.map((i) => i.texto), ["cero", "uno", "dos"]);
	assert.equal(state.items[1], unoAntes); // misma referencia proxy, no una nueva
});

test("REGRESIÓN bug real: splice no debe perder la identidad de los objetos que quedan", () => {
	const state = createStore({ items: [{ texto: "uno" }, { texto: "dos" }, { texto: "tres" }] });
	const unoAntes = state.items[0];
	const tresAntes = state.items[2];

	state.items.splice(1, 1); // quita "dos"

	assert.deepEqual(state.items.map((i) => i.texto), ["uno", "tres"]);
	assert.equal(state.items[0], unoAntes);
	assert.equal(state.items[1], tresAntes);
});

test("REGRESIÓN bug real: los mutadores de array notifican una sola vez, con el array ya terminado de mover", () => {
	const state = createStore({ items: [1, 2, 3] });
	let ejecuciones = 0;
	effect(() => {
		ejecuciones++;
		void state.items.length; // se suscribe a length
	});
	ejecuciones = 0; // ignorar la ejecución inicial del propio effect()

	state.items.unshift(0);

	assert.equal(ejecuciones, 1); // no una vez por cada desplazamiento interno
});

test("toRaw devuelve el objeto original a partir de su proxy", () => {
	const original = { a: 1 };
	const state = createStore({ obj: original });
	assert.equal(toRaw(state.obj), original);
});

test("toRaw sobre un valor no reactivo lo devuelve tal cual", () => {
	assert.equal(toRaw(5), 5);
	assert.equal(toRaw("texto"), "texto");
	assert.equal(toRaw(null), null);
});
