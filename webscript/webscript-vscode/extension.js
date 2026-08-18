const vscode = require('vscode');

// Documentación mostrada al pasar el ratón por encima de cada palabra clave.
// title = firma que se muestra en un bloque de código; body = explicación.
const DOCS = {
  route: {
    title: 'route("/ruta") / route("/ruta/:parametro")',
    body: 'Declara la URL que sirve este archivo. Debe ser la **primera** declaración del archivo. Con `render(...)` en el mismo archivo, determina el nombre del HTML compilado (`/` → `index.html`, `/ejemplo` → `ejemplo.html`). **Sin** `render(...)`, es una ruta "solo backend" -- ni HTML, ni CSS, ni `bundle.js`: la URL responde como endpoint JSON puro (`GET` devuelve el estado, o el resultado de `get function` si existe; `POST`/`PUT`/`DELETE` disparan la función de ese verbo).\n\nUn segmento que empieza por `:` (ej. `:id` en `/monedas/:id`) es un **parámetro dinámico** -- encaja con cualquier valor en esa posición de la URL, leíble dentro de cualquier get/post/put/delete function con `params()`. Una ruta **literal** siempre gana sobre una dinámica que también encajaría (`/monedas/nuevo` nunca se confunde con `:id="nuevo"` si ambas rutas existen). Cada nombre de parámetro debe ser único dentro de la misma ruta.',
  },
  params: {
    title: 'params()',
    body: 'Los parámetros dinámicos de la propia URL (los segmentos `:algo` de `route("/monedas/:id")`), como un objeto -- `const {id} = params()`. Disponible en cualquier `get`/`post`/`put`/`delete function`, sin importar cuántos parámetros nombrados declare esa función (`args`, `args, query`, o ninguno) -- no hace falta declarar nada extra a mano. En una ruta sin ningún `:`, devuelve `{}`. Su análoga para la *query string* (`?a=1`) en páginas con `render()` es `query()`.',
  },
  headers: {
    title: 'headers() -- dentro de una ws function',
    body: 'Las cabeceras HTTP del *handshake* que abrió la conexión WebSocket -- `headers()[\'x-wson-signature\']`, o mejor, `WSON.getSignature(headers())`. Válidas para TODA la conexión (una conexión WS no tiene cabeceras por mensaje, solo las del *handshake* inicial que se negoció una vez). Necesarias para `WSON.parse(args, headers(), secreto)` dentro de una `ws function` -- sin esto, `secret`/`from`/`id` de un `WSON.send(..., via: "socket")` no tendrían forma de leerse en el receptor. En las cuatro funciones HTTP normales (`post`/`put`/`delete`/`get function`), las cabeceras se reciben como un parámetro normal (`headers`), no como esta función -- esta es específica de `ws function`.',
  },
  query: {
    title: 'query()',
    body: 'La *query string* de la propia URL (`?a=1&b=2`), como objeto -- `query().page`. A diferencia de `server.NOMBRE`, **no necesita ningún fetch asíncrono** -- ya está disponible de forma síncrona en el navegador. Disponible en `reactive`/`var`/`const` globales o locales de un `visual`, en plantillas, y en manejadores `onclick={...}`. **Fuerza que la página se renderice fresca en el servidor en cada petición** (no se puede fijar una vez en tiempo de compilación, como sí se hace con SSG normalmente) -- la SSR real usa la *query string* de la petición actual, coherente con lo que el cliente calcula después al hidratar. Convive sin problema con `server.NOMBRE` en la misma página.',
  },
  reactive: {
    title: 'reactive [tipo] NOMBRE = valor',
    body: 'Variable **reactiva**. Cualquier `visual` que la use (interpolación, `if`, `for`, binding) se re-renderiza automáticamente cada vez que cambia. Dentro de un `visual`, es estado local por instancia; fuera, es global y compartido. **Reactividad profunda**: mutar una propiedad anidada (`datos.campo = x`) o un índice de array (`lista.push(x)`) también dispara actualizaciones, no hace falta reasignar. El tipo (`string`/`number`/`boolean`) es opcional, y solo se comprueba si el valor inicial es un literal simple.',
  },
  var: {
    title: 'var [tipo] NOMBRE = valor',
    body: 'Variable **NO reactiva**. Se evalúa una sola vez (al montar el visual, o al cargar el módulo si es global) y nunca dispara ningún re-render, aunque su valor dependa de una `reactive`. Se compila a un `let` de JS normal. Su valor debe caber en **una sola línea** -- para un helper con varias sentencias, usa `function` en su lugar.',
  },
  const: {
    title: 'const [tipo] NOMBRE = valor / server const NOMBRE = valor',
    body: 'Valor **fijo e inmutable**. Igual que `var`/`server var` (no reactivo, evaluado una sola vez), pero además se compila a un `const` **real** de JS, no a un `let` -- reasignarlo lanza un `TypeError: Assignment to constant variable.` real del motor de JavaScript, no algo que WebScript detecte y rechace a mano. **Nunca puede ser `reactive`** -- no existe `const reactive`, son dos conceptos que no tiene sentido combinar. `server const` **exige** un valor inicial (a diferencia de `server var`/`server reactive`, no puede arrancar en `undefined` -- nunca podría recibir uno después).',
  },
  function: {
    title: 'function NOMBRE(params)',
    body: 'Helper de **cliente** con cuerpo en varias líneas (equivalente a `server function`, pero compila a `bundle.js`). A diferencia de `var NOMBRE = (params) => valor`, sí admite varias sentencias, `if`/`for` internos, etc. Se declara como `function` normal de JS (con *hoisting*), así que se puede llamar sin importar el orden de declaración. Siempre puede usar `await` dentro (`fetch`, u otra `function` que lo necesite) sin declarar nada especial -- el compilador detecta solo cuáles funciones de verdad necesitan compilarse `async` (análisis de punto fijo: las que llaman directa o transitivamente a algo asíncrono), dejando el resto como funciones normales, seguras de llamar desde cualquier sitio (una interpolación de plantilla, por ejemplo). Nunca hace falta escribir `await` al llamarlas tampoco.',
  },
  style: {
    title: 'style NOMBRE =',
    body: 'Bloque de CSS. Cada línea `-> propiedad: valor` se compila a una declaración dentro de la clase `.NOMBRE`. El nombre del `style` ES literalmente el nombre de la clase CSS -- se aplica a un elemento con `class={NOMBRE}`, directamente en la etiqueta.',
  },
  visual: {
    title: 'visual NOMBRE =',
    body: 'Componente de UI: plantilla HTML (puede incluir `if`/`for` y otros `visual`). **Cualquier nodo** de la plantilla (no solo la raíz) puede tener sus propios atributos en línea -- `class={expr}` (cualquier expresión, no solo un nombre de `style`) y `onXXX={código}` (`onclick`, `oninput`, etc, con el mismo motor de detección de `async`/RPC que las funciones HTTP). Se compila a `create_NOMBRE(state, effect, props)`. Puede usarse dentro de otro visual como `<NOMBRE />`. No puede referenciarse a sí mismo, ni directa ni indirectamente (se detecta y rechaza en compilación).',
  },
  onXXX: {
    title: 'onclick={código} / onXXX={código}',
    body: 'Manejador de evento en línea, directamente en la etiqueta -- en **cualquier** nodo de la plantilla, no solo la raíz del `visual`. Dentro puedes usar las `reactive`/`var` directamente (se sustituyen a `state.NOMBRE`), y llamar a un `post`/`put`/`delete function` sin `await` -- el compilador lo detecta y lo añade automáticamente. Para varias sentencias, el código puede ocupar varias líneas dentro de las mismas llaves. Nunca se incluye en el HTML servido por SSR/SSG -- solo se conecta cuando el `bundle.js` monta en el navegador.',
  },
  render: {
    title: 'render(visual1, visual2, ...)',
    body: 'Monta uno o más `visual` en `#app`, en el orden indicado.',
  },
  server: {
    title: 'server var / server reactive / server function',
    body: 'Prefijo que marca una declaración como **exclusiva del servidor**: nunca se compila al bundle de cliente, y (salvo `post`/`put`/`delete`/`get function`) no puede referenciarse dentro de ningún `visual` -- ni siquiera si llega por `import`. `server reactive` es observable con `watch(NOMBRE)`; `server var` no. `server function` siempre puede usar `await` dentro (`fetch`, `http.*`, u otra `function`/`server function`) sin declarar nada especial -- el compilador detecta solo, con un análisis de punto fijo sobre el grafo de llamadas, cuáles funciones de verdad necesitan compilarse `async` (las que llaman directa o transitivamente a algo asíncrono) y deja el resto como funciones normales. Nunca hace falta escribir `await` al llamarlas tampoco -- se inserta solo.',
  },
  watch: {
    title: 'watch(NOMBRE)',
    body: 'Corre en el **servidor** cuando `NOMBRE` (una `server reactive`, nunca una `server var` normal) cambia de valor -- **nunca** con el valor inicial, solo en cambios posteriores. Se declara una vez, a nivel de archivo, y se dispara sin importar cuál `get`/`post`/`put`/`delete function` fue la que cambió la variable. **Solo existe a nivel superior del archivo** -- anidarlo dentro de otra función, `if` o `for` no se reconoce como la construcción especial (se trata como una llamada normal a una función `watch` inexistente) y el compilador lo rechaza explícitamente, además de ser redundante. Siempre puede usar `await http.*`/`fetch`/otra función dentro, sin declarar nada especial -- se inserta solo donde haga falta.',
  },
  wson: {
    title: 'wson NOMBRE = ... / wson NOMBRE = expresión',
    body: 'Estructura de datos para describir un mensaje saliente a otro sistema: `from` (opcional, mensaje anónimo si se omite), `to` (obligatorio -- por ahora solo URLs; email/teléfono están pensados pero no implementados, necesitarían un servicio real conectado), `via` (opcional, `"POST"` por defecto; también `"PUT"`/`"DELETE"`), `content` (obligatorio), `secret` (opcional, **SOLO en `server wson`** -- rechazado en compilación en un `wson` de cliente), `encrypt` (opcional, boolean, **necesita `secret`** -- cifra `content` con AES-256-GCM antes de mandarlo, también solo en `server wson`), `id` (opcional -- id de correlación explícito; si no se pone, `WSON.send()` genera uno nuevo en cada llamada, sin guardarlo en el objeto). **Declararlo NUNCA envía nada por sí solo** -- ninguna declaración de nivel superior de WebScript tiene efectos secundarios por el hecho de declararse. Hace falta llamar a `WSON.send(nombre)` explícitamente para enviarlo de verdad. Mismo patrón sintáctico que `style` (cabecera con `=` vacío, `->` indentados debajo). `server wson` es exclusivo del servidor -- ni se compila al cliente ni se puede referenciar en un `visual`, igual que `server var`/`server reactive`. **Dos formas de declararlo**: el bloque `->` de siempre (un literal escrito a mano), o `wson NOMBRE = expresión` (todo en una línea, como `var`/`reactive`) -- para cuando el valor YA es un WSON en tiempo de ejecución, ej. `server wson msg = WSON.parse(args, headers, secreto)` dentro de un `post function`. Las mismas validaciones de seguridad (secret/encrypt solo en servidor, sin referenciar server var desde cliente) aplican a las dos formas.',
  },
  WSON: {
    title: 'WSON.send / WSON.enqueue / WSON.verify / WSON.showContent / WSON.parse / WSON.history / WSON.getSignature',
    body: '`WSON.send(wson)` envía un objeto WSON (`{ from?, to, via?, content, secret?, encrypt?, id? }`) al sistema que indique `to` -- o a VARIOS a la vez si `to` es un array (en paralelo, cada uno con su propio éxito/error, sin que el fallo de uno tumbe a los demás; devuelve un array de resultados en ese caso, un único resultado si `to` es un string). `via` admite `"POST"`/`"PUT"`/`"DELETE"` (HTTP, destino URL) o `"SOCKET"` (WebSocket, destino `ws://...` -- conecta como cliente, manda `content` como un mensaje, espera una respuesta, cierra -- mismo patrón "un envío = una respuesta" que las otras vías). `from` viaja como cabecera `X-WSON-From` (o mensaje inicial en el caso de socket). Con `secret`, firma automáticamente (HMAC-SHA256) lo que de verdad se manda. Con `encrypt: true` (necesita `secret`), cifra `content` con AES-256-GCM antes de mandarlo. Manda un id de correlación (`X-WSON-Correlation-Id`), nuevo en cada llamada salvo que el `wson` ya traiga `id`. Registra automáticamente el envío en `WSON.history()`, con reintentos/backoff y `deadLetter` funcionando igual sin importar la vía. Async siempre. En cliente, sin firma/cifrado/historial (rechazado en compilación); en servidor, con todo si el `wson` los tiene.\n\n`WSON.verify(payload, cabeceraFirma, secreto, marcaDeTiempo)` -- SOLO servidor -- comprueba la firma Y la frescura. La marca de tiempo es **obligatoria** (protección contra reenvió/replay) -- sin ella, o fuera de la ventana de validez (`wson-replay-window-ms` en `wconfig.json`, 5 min por defecto), se rechaza aunque la firma sea matemáticamente correcta. La marca se firma JUNTO con el contenido (no aparte), así que no se puede alargar la validez de un mensaje capturado reescribiéndola sin más. Comparación de la firma en **tiempo constante** (`crypto.timingSafeEqual`).\n\n`WSON.showContent(payload, secreto)` -- SOLO servidor -- descifra, o devuelve el payload tal cual si no estaba cifrado. `null` si falla.\n\n`WSON.parse(payload, headers, secreto?)` -- SOLO servidor -- el punto de entrada natural en el receptor: lee `from`/`id` de las cabeceras, y con `secreto` también verifica y descifra, todo en una llamada -- devuelve `{ from, id, content, signatureValid, replayDetected }`. `replayDetected: true` si este mismo `id` ya se había recibido antes (reutiliza `WSON.history()` para comprobarlo) -- un mensaje reenviado DENTRO de la ventana de validez sigue siendo detectado, aunque `signatureValid` sea `true` (el mensaje no se alteró, solo se repitió). Registra automáticamente la recepción en `WSON.history()`. El resultado conceptualmente ES un WSON -- decláralo con la palabra clave `wson`, no `var`: `server wson msg = WSON.parse(args, headers, secreto)`.\n\n`WSON.history(filtros?)` -- SOLO servidor -- almacén en un FICHERO real (JSONL, junto al server.js) -- sobrevive a reiniciar el proceso, confirmado con dos procesos Node separados. **Compartido por todo el proceso** (no por sesión). Filtros opcionales: `{ direction, from, to, id, deadLetter }`. Sin límite de entradas (a diferencia de la versión en memoria anterior) -- sin rotación de logs implementada, puede crecer sin freno en un proceso muy longevo.\n\n`WSON.send` admite también `retries`/`retryDelayMs` -- reintenta con backoff exponencial si el destino falla (red o `4xx`/`5xx`, o si no responde por WebSocket). Al agotar los intentos, queda registrado en el historial con `deadLetter: true`.\n\n`WSON.enqueue(wson)` -- versión NO bloqueante de `send`: devuelve el id de correlación al instante, sin esperar a que el envío (con sus reintentos) termine -- pasa en segundo plano; consulta el resultado después con `WSON.history()`.\n\n`WSON.getSignature(headers)` -- SOLO servidor -- atajo por `headers[\'x-wson-signature\']`, sin transformar el valor -- sigue siendo el segundo argumento que espera `WSON.verify()` tal cual.\n\n`WSON.getTimestamp(headers)` -- SOLO servidor -- atajo por `headers[\'x-wson-timestamp\']`, análogo a `getSignature` -- el cuarto argumento que espera `WSON.verify()`.',
  },
  ws: {
    title: 'ws function NOMBRE(args)',
    body: 'Corre en el servidor por cada **mensaje** que llega por una conexión WebSocket a esta ruta (no por cada conexión -- una conexión persiste y puede traer muchos mensajes a lo largo del tiempo). `args` es el mensaje entrante ya parseado (`JSON.parse`); lo que devuelva se manda de vuelta por la MISMA conexión, como el siguiente mensaje. Solo puede haber una por archivo, mismo criterio que `post`/`put`/`delete`/`get function`. Siempre `async`. Comparte sesión (`server var`/`server reactive`) con las peticiones HTTP normales de la misma ruta -- el *handshake* de WebSocket ES una petición HTTP de verdad, y puede llevar la cookie de sesión. `params()`/`headers()` funcionan de forma parecida a las HTTP normales -- `headers()` da las cabeceras del *handshake* inicial (válidas para TODA la conexión, no por mensaje), necesarias para `WSON.parse(args, headers(), secreto)` dentro de una `ws function`. Necesita `"ws-port"` configurado en `wconfig.json` -- puerto separado del HTTP normal (no soportado junto con `cluster-workers` > 1 todavía). Un error dentro de la función no tumba la conexión: se manda como mensaje de error, y la conexión sigue viva para el siguiente mensaje.',
  },
  post: {
    title: 'post function NOMBRE(args, query?, headers?)',
    body: 'Corre en el servidor cuando llega un `POST` a la URL de esta ruta. Si se llama desde un `visual`, el compilador genera automáticamente el `fetch` correspondiente en el cliente (con `query` incluido si se declara un segundo parámetro) -- nunca se envía el cuerpo real de la función. Solo puede haber una por archivo. Siempre `async` (puede usar `await` sin ningún prefijo especial), pero **debe devolver siempre algo** -- sin `return`, o con un `return` sin valor, el compilador lo rechaza (antes, sin este aviso, el cliente recibía `null` en silencio). Responde `200` por defecto -- usa `respond(status, cuerpo)` para un código explícito (`400`, `201`, etc).',
  },
  respond: {
    title: 'respond(status, cuerpo)',
    body: 'Envuelve la respuesta de una `get`/`post`/`put`/`delete function` con un código de estado HTTP explícito, en vez del `200` por defecto -- `return respond(400, { error: "..." })`. Primitivo con nombre propio, no una forma especial en el valor de retorno (evita confundirse con datos reales que tengan un campo llamado `status`). Sin `respond()`, una función sigue respondiendo `200` con lo que devuelva, exactamente igual que siempre -- es puramente opcional. Se genera en `server.js` solo si de verdad se usa.',
  },
  put: {
    title: 'put function NOMBRE(args, query?, headers?)',
    body: 'Igual que `post function`, pero corre en un `PUT`. Puede coexistir con `post`/`delete`/`get function` en el mismo archivo -- cada verbo dispara la suya en la misma URL. Igual que `post function`: siempre `async`, y debe devolver siempre algo.',
  },
  delete: {
    title: 'delete function NOMBRE(args, query?, headers?)',
    body: 'Igual que `post function`, pero corre en un `DELETE`. Siempre `async`, y debe devolver siempre algo.',
  },
  get: {
    title: 'get function NOMBRE(query, headers?)',
    body: 'Corre en un `GET` a esta ruta. **Solo válido en un archivo sin `render()`** (una ruta "solo backend") -- en un archivo con página, `GET` ya significa "servir el HTML", así que coexistir sería ambiguo y el compilador lo rechaza. Sus argumentos vienen de la *query string*, no de un body (un GET no lleva cuerpo). Nunca genera stub de cliente. Siempre `async`, y debe devolver siempre algo, igual que las otras tres.',
  },
  http: {
    title: 'http.get/post/put/delete(url, body?, headers?)',
    body: 'Para llamar a **otros sistemas** por HTTP desde el servidor -- distinto de `post`/`put`/`delete`/`get function`, que sirven peticiones que **llegan** a esta ruta. Devuelve el cuerpo de la respuesta ya parseado (JSON si es válido, texto si no). Solo se genera en `server.js` si de verdad se usa.',
  },
  whisper: {
    title: 'whisper(...)',
    body: 'Equivalente a `console.log(...)` en el servidor. Nombre propio para que encaje con el resto del vocabulario del lenguaje (`http`, `watch`, `server reactive`) -- no añade ninguna capacidad nueva.',
  },
  import: {
    title: 'import { a, b } from "./archivo.ws"',
    body: 'Trae declaraciones con nombre (`reactive`, `var`, `function`, `visual`, `style`, `server var`, `server reactive`, `server function`) desde otro `.ws` que **no** tenga `route(...)` ni `render(...)` (un archivo "almacén"). Resuelve dependencias **transitivas** automáticamente -- si importas una función que usa otra declaración, esa también se trae. Si importas una `server reactive`, su `watch()` asociado viaja con ella. Detecta imports circulares. Las rutas son siempre relativas (`./archivo.ws`) -- una ruta con `/` inicial se resuelve como ruta absoluta del sistema de archivos, no relativa al proyecto.',
  },
  if: {
    title: 'if (condición)',
    body: 'Renderizado condicional dentro de una plantilla (o control de flujo JS normal dentro de un handler/función). El cuerpo va indentado debajo, sin llaves. Se re-renderiza automáticamente si la condición depende de una `reactive`.',
  },
  else: {
    title: 'else / else if (condición)',
    body: 'Debe estar **exactamente** a la misma indentación que su `if` -- si no, el compilador lo rechaza con un error explícito (línea, columna real y columna esperada), en vez de tragárselo en silencio.',
  },
  for: {
    title: 'for (item in lista [by clave])',
    body: 'Repite su cuerpo por cada elemento de `lista`. El nombre `item` tiene *scoping* real: si coincide con una `reactive`/`var` existente, la del `for` gana dentro del bucle. **Hace diffing por clave**: reutiliza nodos DOM existentes en vez de reconstruir toda la lista en cada cambio. Con `by clave` (ej. `by item.id`), la clave es estable independientemente de la posición -- sin ella, usa el índice (correcto, pero menos eficiente al reordenar/insertar en medio).',
  },
  in: {
    title: 'for (item in lista)',
    body: 'Separa la variable del bucle de la lista que recorre.',
  },
  by: {
    title: 'for (item in lista by clave)',
    body: 'Clave estable para el diffing del `for` -- reutiliza el nodo DOM existente si la clave ya existía y el ítem no cambió (comparado por identidad), en vez de reconstruirlo.',
  },
};

function activate(context) {
  const provider = vscode.languages.registerHoverProvider('webscript', {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/);
      if (!range) return undefined;
      const word = document.getText(range);
      // Coincidencia exacta primero; si no, "onclick"/"oninput"/etc caen todos en la
      // misma entrada compartida "onXXX" (el patrón /^on[a-z]+$/ cubre cualquier evento,
      // sin tener que enumerar cada nombre posible uno por uno).
      const entry = DOCS[word] || (/^on[a-z]+$/.test(word) ? DOCS.onXXX : undefined);
      if (!entry) return undefined;

      const md = new vscode.MarkdownString();
      md.appendCodeblock(entry.title, 'webscript');
      md.appendMarkdown(entry.body);
      return new vscode.Hover(md, range);
    },
  });

  context.subscriptions.push(provider);
}

function deactivate() {}

module.exports = { activate, deactivate };
