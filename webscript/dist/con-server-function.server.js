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
  let totalConIva = 0; // server var

  // server function -- helper de servidor, NO se expone al cliente ni tiene
  // endpoint propio. Esta no usa nada asíncrono
  // (fetch/http.*/WSON.send/otra function que lo necesite) -- nunca hace falta
  // declarar "async" a mano, ni tampoco "await" al llamarla: si resulta ser
  // asíncrona, el compilador ya insertó el "await" que hiciera falta en quien la llama.
  function calcularIva(precio) {
    return precio * 1.21
  }

  // post function -- corre cuando llega un POST a la URL de la propia ruta.
  // Async: puede hacer "await" a fetch()/http.* para llamar a otros sistemas y esperar
  // su respuesta antes de devolver la suya.
  async function postController(args) {
    var conIva = calcularIva(args.precio)
    totalConIva = totalConIva + conIva
    return { conIva: conIva, totalConIva: totalConIva }
  }

  return {
    get totalConIva() { return totalConIva; },
    set totalConIva(v) { totalConIva = v; },
    postController,
  };
}

module.exports = { createSessionState };
