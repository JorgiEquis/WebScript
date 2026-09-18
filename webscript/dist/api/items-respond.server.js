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

// respond(status, cuerpo) -- envuelve la respuesta con un código de estado HTTP
// explícito, en vez del 200 por defecto. Un primitivo con nombre propio, no una
// forma especial en el valor de retorno -- así nunca se confunde con datos reales
// que el usuario devuelva y que casualmente tengan un campo llamado "status".
// Sin "respond()", una get/post/put/delete function sigue respondiendo 200 con el
// valor que devuelva, exactamente igual que siempre -- esto es puramente opcional.
function respond(status, body) { return { __wsHttpResponse: true, status: status, body: body }; }

function createSessionState() {
  let items = []; // server var

  // get function -- corre cuando llega un GET a la URL de la propia ruta.
  // Async: puede hacer "await" a fetch()/http.* para llamar a otros sistemas y esperar
  // su respuesta antes de devolver la suya.
  async function listar(query) {
    return items
  }

  // post function -- corre cuando llega un POST a la URL de la propia ruta.
  // Async: puede hacer "await" a fetch()/http.* para llamar a otros sistemas y esperar
  // su respuesta antes de devolver la suya.
  async function crear(args) {
    if (!args.nombre)
        return respond(400, { error: "falta el nombre" })
    items = [...items, args.nombre]
    return respond(201, { creado: true, total: items.length })
  }

  return {
    get items() { return items; },
    set items(v) { items = v; },
    listar,
    crear,
  };
}

module.exports = { createSessionState };
