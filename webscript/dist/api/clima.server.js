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

// Objeto "http" -- para llamar a OTROS sistemas por HTTP desde una función de
// servidor (a diferencia de post/put/delete function, que sirven peticiones QUE
// LLEGAN a esta ruta; "http" es para las que ESTA ruta hace hacia fuera).
// http.get(url, headers)
// http.post/put/delete(url, body, headers)
// Todas devuelven el cuerpo de la respuesta ya parseado -- JSON si el Content-Type
// o el propio texto lo permiten, o el texto crudo si no es JSON válido.
async function __wsHttpRequest(method, url, body, headers) {
  const opts = { method, headers: Object.assign({}, headers) };
  if (body !== undefined) {
    if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return text; }
}
const http = {
  get: (url, headers) => __wsHttpRequest('GET', url, undefined, headers),
  post: (url, body, headers) => __wsHttpRequest('POST', url, body, headers),
  put: (url, body, headers) => __wsHttpRequest('PUT', url, body, headers),
  delete: (url, body, headers) => __wsHttpRequest('DELETE', url, body, headers),
};

function createSessionState() {

  // get function -- corre cuando llega un GET a la URL de la propia ruta.
  // Async: puede hacer "await" a fetch()/http.* para llamar a otros sistemas y esperar
  // su respuesta antes de devolver la suya.
  async function consultar(query) {
    var datos = await http.get("https://api.ejemplo.com/clima?ciudad=" + query.ciudad, {})
    return { temperatura: datos.temp }
  }

  // post function -- corre cuando llega un POST a la URL de la propia ruta.
  // Async: puede hacer "await" a fetch()/http.* para llamar a otros sistemas y esperar
  // su respuesta antes de devolver la suya.
  async function notificar(args) {
    var resultado = await http.post("https://api.ejemplo.com/webhook", { mensaje: args.texto }, { "Authorization": "Bearer TOKEN" })
    return { enviado: true, respuesta: resultado }
  }

  return {
    consultar,
    notificar,
  };
}

module.exports = { createSessionState };
