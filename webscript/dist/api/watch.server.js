'use strict';
// Modo estricto a propósito: sin esto, asignar a un identificador NUNCA declarado
// dentro de una post/put/delete function o server function (ej. un typo, o intentar
// "escribir" sobre un nombre que en realidad es un visual del cliente) crea una
// variable GLOBAL implícita en el proceso Node -- filtrada fuera de cualquier sesión,
// un bug silencioso y de verdad peligroso. Con 'use strict', eso es un ReferenceError
// inmediato y claro en vez de una fuga silenciosa entre sesiones.

// server.js -- variables SOLO de servidor. Este archivo NUNCA se envía al cliente.
// Cada sesión (identificada por cookie, ver site-builder.js) llama a createSessionState()
// UNA vez y se queda con su propia instancia -- el estado NO se comparte entre visitantes.

function createSessionState() {
  let log = []; // server var

  // server reactive -- observables con watch(). Proxy: asignar dispara los
  // watchers registrados para esa variable (NUNCA con el valor inicial, solo en
  // cambios posteriores -- a diferencia de un "effect" del cliente).
  const __watchers = { var1: [] };
  const __serverReactive = new Proxy({ var1: 0 }, {
    set(target, key, value) {
      target[key] = value;
      if (__watchers[key]) __watchers[key].slice().forEach((fn) => fn());
      return true;
    },
  });

  // get function -- corre cuando llega un GET a la URL de la propia ruta.
  // Async: puede hacer "await" a fetch()/http.* para llamar a otros sistemas y esperar
  // su respuesta antes de devolver la suya.
  async function estado(args) {
    return { var1: __serverReactive.var1, log: log }
  }

  // post function -- corre cuando llega un POST a la URL de la propia ruta.
  // Async: puede hacer "await" a fetch()/http.* para llamar a otros sistemas y esperar
  // su respuesta antes de devolver la suya.
  async function actualizar(args) {
    __serverReactive.var1 = args.valor
    return { var1: __serverReactive.var1 }
  }

  // watch(var1) -- corre SOLO en cambios posteriores de "var1", nunca con
  // el valor inicial. Se dispara sin importar cuál get/post/put/delete function fue
  // la que cambió la variable. Siempre async (puede usar "await" dentro sin necesitar
  // ningún prefijo especial) -- nada captura su valor de retorno, así que hacerla
  // async no rompe ningún patrón existente, a diferencia de "function"/"server function".
  __watchers.var1.push(async () => {
    log = [...log, "var1 cambio a " + __serverReactive.var1]
  });

  return {
    get log() { return log; },
    set log(v) { log = v; },
    get var1() { return __serverReactive.var1; },
    set var1(v) { __serverReactive.var1 = v; },
    estado,
    actualizar,
  };
}

module.exports = { createSessionState };
