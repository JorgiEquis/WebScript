const vscode = require('vscode');

// Documentación mostrada al pasar el ratón por encima de cada palabra clave.
// title = firma que se muestra en un bloque de código; body = explicación.
const DOCS = {
  route: {
    title: 'route("/ruta")',
    body: 'Declara la URL que sirve este archivo. Debe ser la **primera** declaración del archivo. Determina el nombre del HTML compilado (`/` → `index.html`, `/ejemplo` → `ejemplo.html`).',
  },
  reactive: {
    title: 'reactive NOMBRE = valor',
    body: 'Variable **reactiva**. Cualquier `visual` que la use (interpolación, `if`, `for`, binding) se re-renderiza automáticamente cada vez que cambia. Dentro de un `visual`, es estado local por instancia; fuera, es global y compartido.',
  },
  var: {
    title: 'var NOMBRE = valor',
    body: 'Variable **NO reactiva**. Se evalúa una sola vez (al montar el visual, o al cargar el módulo si es global) y nunca dispara ningún re-render, aunque su valor dependa de una `reactive`. Se compila a un `let` de JS normal.',
  },
  style: {
    title: 'style NOMBRE =',
    body: 'Bloque de CSS. Cada línea `-> propiedad: valor` se compila a una declaración dentro de la clase `.NOMBRE`. Se aplica a un `visual` con `-> style: NOMBRE`.',
  },
  visual: {
    title: 'visual NOMBRE =',
    body: 'Componente de UI: plantilla HTML (puede incluir `if`/`for` y otros `visual`) más bindings (`-> style:`, `-> onclick:`, etc). Se compila a `create_NOMBRE(state, effect, props)`. Puede usarse dentro de otro visual como `<NOMBRE />`.',
  },
  render: {
    title: 'render(visual1, visual2, ...)',
    body: 'Monta uno o más `visual` en `#app`, en el orden indicado.',
  },
  server: {
    title: 'server var / server function',
    body: 'Prefijo que marca una declaración como **exclusiva del servidor**: nunca se compila al bundle de cliente, y (salvo `post function`) no puede referenciarse dentro de ningún `visual`.',
  },
  function: {
    title: 'function NOMBRE(params)',
    body: 'Aparece junto a `server` o `post` para declarar un handler que corre en Node. El cuerpo va indentado debajo, sin llaves — es JS "casi crudo".',
  },
  post: {
    title: 'post function NOMBRE(args)',
    body: 'Única por archivo. Corre en el servidor cuando llega un `POST` a la URL de esta ruta. Si se llama desde un `visual` (`await NOMBRE({...})`), el compilador genera automáticamente el `fetch` correspondiente en el cliente — nunca se envía el cuerpo real de la función.',
  },
  import: {
    title: 'import { a, b } from "./archivo.ws"',
    body: 'Trae declaraciones con nombre (`reactive`, `var`, `visual`, `style`, `server var`, `server function`) desde otro `.ws` que **no** tenga `route(...)` ni `render(...)` (un archivo "almacén"). Detecta imports circulares.',
  },
  if: {
    title: 'if (condición)',
    body: 'Renderizado condicional dentro de una plantilla. El cuerpo va indentado debajo, sin llaves. Se re-renderiza automáticamente si la condición depende de una `reactive`.',
  },
  else: {
    title: 'else / else if (condición)',
    body: 'Debe estar **exactamente** a la misma indentación que su `if` — si no, el compilador lo rechaza con un error explícito (antes de esta comprobación, se tragaba en silencio como texto).',
  },
  for: {
    title: 'for (item in lista)',
    body: 'Repite su cuerpo por cada elemento de `lista`. El nombre `item` queda "atado" (scoping real): si coincide con una `reactive`/`var` existente, la del `for` gana dentro del bucle. Reconstruye todos los elementos en cada cambio (sin diffing por clave).',
  },
  in: {
    title: 'for (item in lista)',
    body: 'Separa la variable del bucle de la lista que recorre.',
  },
  updateServer: {
    title: 'updateServer({ campo: valor })',
    body: 'Solo disponible en rutas dinámicas (las que usan `server.NOMBRE`). Hace `POST` al endpoint de datos de la ruta actual (`/<ruta>.server-data.json`), actualiza los `server var` indicados, y devuelve el snapshot actualizado.',
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
