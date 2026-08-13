const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseFragment } = require('../src/html-parser');

describe('html-parser: interpolación con llaves anidadas', () => {
  test('template literal con ${} dentro de {} no se corta', () => {
    const [p] = parseFragment('<p>{`Hola ${nombre}, bienvenido`}</p>');
    const interp = p.children.find(c => c.type === 'interpolation');
    assert.equal(interp.expr, '`Hola ${nombre}, bienvenido`');
  });

  test('objeto anidado en una interpolación no se corta', () => {
    const [p] = parseFragment('<p>{JSON.stringify({ a: 1, b: 2 })}</p>');
    const interp = p.children.find(c => c.type === 'interpolation');
    assert.equal(interp.expr, 'JSON.stringify({ a: 1, b: 2 })');
  });

  test('atributo con llaves anidadas no se corta', () => {
    const [div] = parseFragment('<div data-info="{JSON.stringify({ a: 1 })}">x</div>');
    assert.equal(div.attrs['data-info'], '{JSON.stringify({ a: 1 })}');
  });
});

describe('html-parser: normalización de espacios', () => {
  test('espacio real entre texto e interpolación se conserva', () => {
    const [p] = parseFragment('<p>Hola {nombre}, tienes {edad} años</p>');
    const texts = p.children.filter(c => c.type === 'text').map(c => c.value);
    assert.deepEqual(texts, ['Hola ', ', tienes ', ' años']);
  });

  test('indentación estructural (con salto de línea) se colapsa a nada', () => {
    const [button] = parseFragment('<button>\n    Clicks: {contador}\n</button>');
    const texts = button.children.filter(c => c.type === 'text').map(c => c.value);
    assert.deepEqual(texts, ['Clicks: ']);
  });
});

describe('html-parser: atributos', () => {
  test('atributo booleano (sin valor)', () => {
    const [input] = parseFragment('<input disabled>');
    assert.equal(input.attrs.disabled, true);
  });

  test('atributo con comillas simples y dobles', () => {
    const [div] = parseFragment(`<div class="a" data-x='b'>x</div>`);
    assert.equal(div.attrs.class, 'a');
    assert.equal(div.attrs['data-x'], 'b');
  });
});
