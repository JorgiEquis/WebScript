# websc

Compilador y CLI de **WebScript** — un lenguaje que unifica HTML/CSS/JS de
cliente y un servidor Node en un único proyecto: `reactive`, `visual`
(con composición vía `props`/`slot`), `WSON` (mensajería con firma/cifrado
y `WSON.listen()` como servidor real), SSR con **hidratación incremental
real** (los nodos que ya pintó el servidor se reutilizan, no se tiran).

## Instalación

```bash
npm install -g websc
```

## Uso

```bash
websc init mi-proyecto      # crea un proyecto nuevo
cd mi-proyecto
# ... escribe tu código en src/ ...
websc build .               # compila src/ -> dist/
node dist/server.js         # ejecuta
```

`websc update .` regenera `lib/` y `compiler/` (vendorizados dentro de
cada proyecto) tras actualizar `websc`, sin tocar `src/` ni `wconfig.json`.

## Estado

`0.1.0` — funcional y con tests (parser, codegen de cliente y de
servidor, SSR/hidratación, DTOs, sesiones), pero un lenguaje joven: hay
piezas del diseño pendientes de implementar (diffing de `if`/`else` en
hidratación, persistencia de sesión más allá de memoria, entre otras).

## Uso programático

```js
const websc = require("websc");
const ast = websc.parse(codigoFuente);
```

Ver los ficheros del propio paquete (`parser.js`, `codegen-client.js`,
`codegen-server.js`, `codegen-ssr.js`, `codegen-dto.js`) para la API
completa — `index.js` re-exporta las piezas más usadas.

## Licencia

MIT
