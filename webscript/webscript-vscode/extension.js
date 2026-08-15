const vscode = require('vscode');

// Documentación mostrada al pasar el ratón por encima de cada palabra clave.
// title = firma que se muestra en un bloque de código; body = explicación.
const DOCS = {
  route: {
    title: 'route("/ruta")',
    body: 'Declara la URL que sirve este archivo. Debe ser la **primera** declaración del archivo. Con `render(...)` en el mismo archivo, determina el nombre del HTML compilado (`/` → `index.html`, `/ejemplo` → `ejemplo.html`). **Sin** `render(...)`, es una ruta "solo backend" -- ni HTML, ni CSS, ni `bundle.js`: la URL responde como endpoint JSON puro (`GET` devuelve el estado, o el resultado de `get function` si existe; `POST`/`PUT`/`DELETE` disparan la función de ese verbo).',
  },
  reactive: {
    title: 'reactive [tipo] NOMBRE = valor',
    body: 'Variable **reactiva**. Cualquier `visual` que la use (interpolación, `if`, `for`, binding) se re-renderiza automáticamente cada vez que cambia. Dentro de un `visual`, es estado local por instancia; fuera, es global y compartido. **Reactividad profunda**: mutar una propiedad anidada (`datos.campo = x`) o un índice de array (`lista.push(x)`) también dispara actualizaciones, no hace falta reasignar. El tipo (`string`/`number`/`boolean`) es opcional, y solo se comprueba si el valor inicial es un literal simple.',
  },
  var: {
    title: 'var [tipo] NOMBRE = valor',
    body: 'Variable **NO reactiva**. Se evalúa una sola vez (al montar el visual, o al cargar el módulo si es global) y nunca dispara ningún re-render, aunque su valor dependa de una `reactive`. Se compila a un `let` de JS normal. Su valor debe caber en **una sola línea** -- para un helper con varias sentencias, usa `function` en su lugar.',
  },
  function: {
    title: 'function NOMBRE(params)',
    body: 'Helper de **cliente** con cuerpo en varias líneas (equivalente a `server function`, pero compila a `bundle.js`). A diferencia de `var NOMBRE = (params) => valor`, sí admite varias sentencias, `if`/`for` internos, etc. Se declara como `function` normal de JS (con *hoisting*), así que se puede llamar sin importar el orden de declaración. **Síncrona por defecto** -- no puede usar `await` dentro. Con `async function` delante, sí puede (`fetch`, etc.), pero entonces quien la llame también necesita `await`, o recibirá una Promise en vez del valor.',
  },
  style: {
    title: 'style NOMBRE =',
    body: 'Bloque de CSS. Cada línea `-> propiedad: valor` se compila a una declaración dentro de la clase `.NOMBRE`. Se aplica a un `visual` con `-> style: NOMBRE`.',
  },
  visual: {
    title: 'visual NOMBRE =',
    body: 'Componente de UI: plantilla HTML (puede incluir `if`/`for` y otros `visual`) más bindings (`-> style:`, `-> onclick:`, etc). Se compila a `create_NOMBRE(state, effect, props)`. Puede usarse dentro de otro visual como `<NOMBRE />`. No puede referenciarse a sí mismo, ni directa ni indirectamente (se detecta y rechaza en compilación).',
  },
  render: {
    title: 'render(visual1, visual2, ...)',
    body: 'Monta uno o más `visual` en `#app`, en el orden indicado.',
  },
  server: {
    title: 'server var / server reactive / server function',
    body: 'Prefijo que marca una declaración como **exclusiva del servidor**: nunca se compila al bundle de cliente, y (salvo `post`/`put`/`delete`/`get function`) no puede referenciarse dentro de ningún `visual` -- ni siquiera si llega por `import`. `server reactive` es observable con `watch(NOMBRE)`; `server var` no. `server function` es **síncrona por defecto** (no puede usar `await` dentro) -- con `async server function` delante, sí puede, pero rompe el patrón de llamarla sin `await` esperando el valor directo, así que solo úsalo si de verdad lo necesitas.',
  },
  watch: {
    title: 'watch(NOMBRE)',
    body: 'Corre en el **servidor** cuando `NOMBRE` (una `server reactive`, nunca una `server var` normal) cambia de valor -- **nunca** con el valor inicial, solo en cambios posteriores. Se declara una vez, a nivel de archivo, y se dispara sin importar cuál `get`/`post`/`put`/`delete function` fue la que cambió la variable. **Solo existe a nivel superior del archivo** -- anidarlo dentro de otra función, `if` o `for` no se reconoce como la construcción especial (se trata como una llamada normal a una función `watch` inexistente) y el compilador lo rechaza explícitamente, además de ser redundante. **Siempre `async`**, sin necesitar ningún prefijo -- puede usar `await http.*`/`fetch` dentro sin más, ya que nada captura su valor de retorno (a diferencia de `function`/`server function`, donde hacerla async siempre rompería llamadas existentes sin `await`).',
  },
  post: {
    title: 'post function NOMBRE(args, query?, headers?)',
    body: 'Corre en el servidor cuando llega un `POST` a la URL de esta ruta. Si se llama desde un `visual`, el compilador genera automáticamente el `fetch` correspondiente en el cliente (con `query` incluido si se declara un segundo parámetro) -- nunca se envía el cuerpo real de la función. Solo puede haber una por archivo. Siempre `async` (puede usar `await` sin ningún prefijo especial), pero **debe devolver siempre algo** -- sin `return`, o con un `return` sin valor, el compilador lo rechaza (antes, sin este aviso, el cliente recibía `null` en silencio).',
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
      const entry = DOCS[word];
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
