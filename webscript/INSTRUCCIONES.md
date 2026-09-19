# Cómo probar esto

## Requisitos

Node.js (v18 o superior). El compilador en sí no tiene dependencias — pero
la suite de tests sí necesita una (`jsdom`, para simular un navegador real
al probar el JS generado), así que hay que instalarla antes:

```bash
cd compiler
npm install
```

## Qué es esto hoy — y qué NO es todavía

Ya no es solo un parser: además de convertir un fichero en AST, **genera JS de cliente ejecutable de verdad** para un `.wsf` (`codegen-client.js`) — probado de extremo a extremo con `jsdom` simulando clics reales (`tests/codegen-integration.test.js`).

Lo que ya funciona en el JS generado:
- `reactive` global, con su store basado en `Proxy` (`runtime.js`) y reactividad profunda (objetos/arrays anidados).
- Interpolaciones de texto y de atributo (`{expr}`), con actualización dirigida (sin reconstruir toda la página).
- Eventos (`onclick={...}` → `addEventListener`).
- `if`/`else if`/`else` reactivo (con doble marcador de posición, para no borrar hermanos que vengan después en el mismo padre — bug real que apareció y se corrigió por el camino, ver el test de regresión).
- `for` reactivo (reconstruye la lista entera en cada cambio — **sin** diffing por clave todavía, aunque sí está en el diseño).
- **Composición de componentes (`props`/`slot`)**: un tag que coincide con un `visual` declarado en el mismo fichero genera una llamada real a `create_OTRO(props, slots)`; `props` se construye desde los atributos, y el contenido pasado se genera en el scope del padre y se reparte por `slot="nombre"` (o al `<slot />` por defecto) — probado con `jsdom` (`src/demo-composicion.wsf`).

- **Import resuelto de verdad en el cliente** (mismo `resolve-imports.js` que el servidor): `import { contadorItem } from "./contador.wsf"` genera de verdad la llamada al componente (antes se trataba como una etiqueta HTML normal), e `import { formatearNombre } from "./utils.ws"` inyecta la función real en el bundle. Probado con **`app.wsf` real** — sacó a la luz otro bug que llevaba ahí desde que existe el codegen: `class={contenedor}` (un `style`) se evaluaba como si `contenedor` fuera una variable JS (`ReferenceError: contenedor is not defined`), en vez de compilarse a la clase CSS literal que es por diseño. Corregido.

Lo que **no** hace todavía el codegen de cliente:
- **Sin diffing por clave en `for`** — reconstruye la lista entera en cada cambio.
- **Import de `.wsb` no soportado desde el cliente** (no tendría sentido: lógica de servidor).

**SSR** (`codegen-ssr.js`) — ya genera HTML real en el servidor, por petición (no precalculado), sin necesitar un DOM:
- Interpolaciones de texto, `if`/`else if`/`else`, `for`, composición de componentes (`props`/`slot`, con el scope del padre respetado), `style` como clase literal, escapado de HTML para evitar inyección.
- `Visual.route()`/`Visual.params()`/`Visual.query()` resueltos contra la URL real de cada petición — probado con dos peticiones a la misma página con distinto `:id` (`/personas/7` vs `/personas/99`), devolviendo HTML distinto cada vez, no cacheado desde el `build`.
- Integrado en `websc build`/`dist/server.js` y en `serve-demo.js`: el HTML que sirven ya no es un `<body>` vacío, es el contenido real renderizado en servidor.
- **Hidratación incremental real** (no *render-then-replace*): los elementos y el texto que el SSR pintó se **reutilizan de verdad** al cargar el cliente — mismo nodo DOM, no uno recreado (probado marcando el nodo con una propiedad JS antes de hidratar y comprobando que sobrevive). Los eventos y las interpolaciones reactivas se enganchan sobre esos mismos nodos.
- **Limitación real y explícita**: los bloques `if`/`for` **sí se reconstruyen** al hidratar (no se reutiliza su contenido interno nodo a nodo) — se localizan gracias a marcadores (`<!--if-->`/`<!--for-->`) que el SSR deja, con anidamiento correcto, pero dentro de esos marcadores es un reemplazo local, no una reutilización. Todo lo que esté **fuera** de un `if`/`for` (incluido el contenido pasado a un `<slot />`) sí se reutiliza de verdad.
- Sin SSR (body vacío salvo el propio `<script>`, distinguido vía `document.currentScript`), se sigue montando desde cero como antes — mismo bundle, sin necesidad de generar dos versiones distintas.
- **Limitaciones que siguen en pie**: el `state` inicial del SSR es un snapshot (se evalúa una vez, sin reactividad en el HTML en sí — no puede haberla, es texto); los manejadores de eventos (`onclick={...}`) se omiten en el HTML del servidor, aparecen solo cuando el cliente hidrata.

**Servidor** (`codegen-server.js` + `wson-runtime.js`) — ya hay un servidor HTTP real (Node puro, sin framework), probado con peticiones HTTP de verdad, no simuladas:
- `WSON.listen()` + `watch()` con matching real de `to`/`via` (incluida la normalización de `:param` para detectar colisiones entre rutas con distinto nombre de parámetro).
- `httpCode`, `WSON.send()` (responde la petición entrante), `WSON.showContent()` (real: AES-256-GCM) dentro del handler.
- Firma HMAC-SHA256 / verificación / decodificación de JWT con criptografía real (`wson-runtime.js`), no simulada.
- CSRF (cookie de doble envío, solo si hay sesión de navegador) y rate limiting (`wconfig.json`), aplicados de verdad — probado con peticiones reales, incluidos los 4 casos de CSRF y el corte del rate limit.
- **DTOs desde `.wson`** (`codegen-dto.js`): clase real con constructor posicional, validación de tipos en el constructor y en cada `set` posterior, campos opcionales, objetos anidados — probado contra `persona.wson` de verdad.

- **Import resuelto de verdad en el servidor** (`resolve-imports.js`): `import { Persona } from "./persona.wson"` dentro de un `.wsb` ya funciona — genera la clase DTO real (`codegen-dto.js`) y la deja en el scope del handler. También resuelve `import { X } from "./archivo.ws"` (funciones y valores exportados). Probado con **`api.wsb` real, tal cual estaba escrito** — lo cual sacó a la luz dos bugs reales que llevaban ahí desde hace muchos turnos, invisibles hasta que se ejecutó de verdad:
  - `new Persona(...)` en `api.wsb` se saltaba el campo `edad` (desplazaba todo lo demás una posición) — corregido.
  - `WSON.showContent()` intentaba descifrar con AES-GCM aunque `encrypt` no estuviera activado (solo había `secret`, que es para firmar) — corregido para que respete el flag `encrypt` de verdad.
- **Estado de módulo del servidor**: un `var`/`reactive`/`const` de nivel superior en el `.wsb` (como `visitasSesion` en `api.wsb`) ya es una variable real, persistente entre peticiones — no una sesión por visitante todavía, pero sí estado de servidor de verdad, no simulado.
- **Errores de validación del DTO devuelven 400**, no 500 — un tipo de campo incorrecto es un error del cliente, no del servidor.

**CLI `websc`** (`bin/websc.js` + `check-lib.js`) — ya es real, probado sobre carpetas de verdad, con tres comandos: `init`, `update`, y `build` (compila `src/` a `dist/`: un `.html` autocontenido por página + un `server.js` standalone que combina todos los `.wsb`):
- `websc init <carpeta>`: crea `src/`, `lib/` (con `.websc-lock.json`, el hash de cada fichero), `wconfig.json`, `.gitignore`, y **vendoriza el compilador completo** en `compiler/` — cada proyecto lleva su propia copia, como se decidió en `DISEÑO.md`.
- `websc update <carpeta>`: regenera `lib/` y `compiler/`, sin tocar `src/` ni `wconfig.json`.
- **`lib/` protegido de verdad**: `cli.js` (el compilador vendorizado) comprueba el hash de `lib/` contra el lock antes de compilar nada — si alguien lo edita a mano, el compilador se niega a compilar con un mensaje claro, en vez de compilar silenciosamente con un núcleo alterado.

Nota sobre este repo en concreto: el `.gitignore` que tenía antes ignoraba `lib/` y `compiler/` — correcto para un proyecto generado por `websc init` (donde son vendorizados), pero **incorrecto aquí**, donde `compiler/` es nuestro código real, no vendorizado. Ya corregido — este repo solo ignora `node_modules/`. La plantilla de `.gitignore` que `websc init` instala en un proyecto **nuevo** sigue ignorando `lib/`/`compiler/`, con razón, porque ahí sí son regenerables.

Lo que **no** hace todavía el servidor:
- **Sin sesión por visitante** — el estado de módulo (`visitasSesion`, etc.) se comparte entre **todas** las peticiones al servidor, no es un contador distinto por cookie de sesión. Sesiones de verdad (aisladas por visitante) siguen pendientes.
- **Sin `useRoute`/GET con SSR** — el servidor solo cubre `WSON.listen()` con POST/PUT/DELETE.
- **El intérprete del cuerpo de `watch()` es "mejor esfuerzo"**: como la API de WSON ya es estática, la mayoría de sentencias son JS casi literal, pero no hay comprobación real de que tengan sentido — es traducción directa, no un intérprete completo de WebScript.

Es decir: ya puedes coger un `.wsf` sencillo (con o sin componentes, siempre que estén en el mismo fichero) y ver una página de verdad, interactiva, en el navegador — y un `.wsb` sencillo (autocontenido) y tener un servidor HTTP real respondiendo peticiones, con CSRF y rate limiting de verdad.

## Generar y probar un bundle de cliente

Solo para `.wsf` **sin componentes** (la composición aún no está en el codegen — ver limitaciones arriba). Con `src/demo-contador.wsf`:

```bash
cd compiler
node -e "
const fs = require('fs');
const { parse } = require('./parser');
const { generateClientBundle } = require('./codegen-client');
const ast = parse(fs.readFileSync('../src/demo-contador.wsf', 'utf8'));
fs.writeFileSync('/tmp/bundle.js', generateClientBundle(ast));
"
```

Esto genera `/tmp/bundle.js`: un fichero JS autocontenido (runtime reactivo incluido) que puedes meter en un `<script>` de cualquier HTML y abrir en un navegador de verdad — botones, `if`/`else`, `for`, todo funcional.

## Usar el CLI `websc`

```bash
cd compiler
node bin/websc.js init /ruta/a/mi-proyecto-nuevo
node bin/websc.js update /ruta/a/mi-proyecto-nuevo   # tras un cambio en el compilador
```

El proyecto generado es autocontenido: `mi-proyecto-nuevo/compiler/cli.js` ya lleva su propia copia del compilador, sin depender de este repo.

## Compilar y ejecutar (de verdad, en dos pasos)

Esto es lo que faltaba: un paso de **compilar** que deja ficheros reales en disco, y un paso de **ejecutar** aparte — no un script que hace las dos cosas de una vez.

```bash
# 1. Crear un proyecto (si no tienes uno ya)
cd compiler
node bin/websc.js init /ruta/a/mi-proyecto

# 2. Poner tu código en mi-proyecto/src/ (.wsf, .wsb, .ws, .wson)

# 3. COMPILAR: genera mi-proyecto/dist/ — un .html por cada página, y un server.js
node bin/websc.js build /ruta/a/mi-proyecto

# 4. EJECUTAR: un proceso aparte, ya sin depender del compilador para nada más
#    que levantar el servidor (dist/server.js sí usa el compilador vendorizado
#    en tiempo de arranque, para procesar los .wsb — pero ya no hace falta
#    volver a compilar nada a mano)
cd /ruta/a/mi-proyecto
node dist/server.js
```

Abre `http://localhost:3000/` (o el puerto de tu `wconfig.json`).

**Cómo decide `websc build` qué URL sirve cada página:**
- Si el `.wsf` declara `Visual.route('/ruta/literal')` (sin `:parámetros`), se sirve exactamente ahí.
- Si no declara `Visual.route()`, o su ruta lleva `:parámetros` (no es un path de fichero válido), se sirve en `/nombre-del-fichero` (p. ej. `app.wsf` → `/app`).
- Si ninguna página reclama `/`, la primera se sirve también ahí de regalo, para que la raíz nunca dé 404 por descuido.
- Un `.wsf` "library" (sin `Visual.render()`) no genera página propia — solo se usa como import de otras.

Todos los `.wsb` de `src/` se combinan en el mismo servidor (validando que no colisionen rutas entre sí, igual que dentro de un único fichero).

**Probado de verdad**: `websc init` → copiar `app.wsf`/`contador.wsf`/`utils.ws`/`api.wsb`/`persona.wson` → `websc build` → `node dist/server.js` → `curl` a la página (bundle con `create_app`/`create_contadorItem`/`formatearNombre` presentes) y a `POST /personas` (DTO real importado desde `persona.wson`, con su validación).

## Alternativa rápida para un solo fichero de cada (sin proyecto completo)

Si solo quieres probar un `.wsf` y un `.wsb` sueltos sin montar un proyecto con `websc init`, `serve-demo.js` hace lo mismo en un único comando (compila y sirve a la vez, sin dejar nada en disco):

## Probar de extremo a extremo en un navegador real (página + API)

Hasta hace poco, `WSON.send()` desde un `.wsf` no estaba implementado en el
runtime de cliente — cualquier página que lo usara fallaría con
`WSON is not defined` en el navegador. Ya está resuelto: `runtime.js`
incluye un `WSON.send()` real (`fetch()`), y `codegen-client.js` traduce
los WSON ad-hoc de un `.wsf` a objetos JS reales (rechazando `secret`/
`encrypt` en compilación, como estaba decidido mucho antes de que
existiera código para comprobarlo).

`src/demo-cliente-servidor.wsf` (un botón que manda un WSON) + `src/demo-servidor.wsb` (lo recibe) es el par que demuestra esto. Para probarlo en un navegador **de verdad** hace falta servir la página y la API desde el **mismo origen** — si no, el navegador bloquea el `fetch()` por CORS (nuestro servidor no manda cabeceras CORS). Para eso está `serve-demo.js`:

```bash
cd compiler
node serve-demo.js ../src/demo-cliente-servidor.wsf ../src/demo-servidor.wsb 3000
```

Abre `http://localhost:3000/` en tu navegador, pulsa "Enviar", y el párrafo de debajo del botón se rellena con la respuesta real del servidor — puedes verlo también en la pestaña Red/Network del navegador: una petición `POST` de verdad a `/notas`.

Con cualquier otro par de ficheros (los tuyos), el mismo script sirve de plantilla:

```bash
node serve-demo.js /ruta/a/tu/pagina.wsf /ruta/a/tu/api.wsb [puerto]
```

Limitación: solo sirve **un** `.wsf` como página (en `/`) — si tu proyecto tiene varias páginas con rutas distintas (`Visual.route()` por cada una), usa `websc build` + `dist/server.js` en su lugar (sí soporta varias páginas, cada una con SSR real por su propio patrón de ruta).

## Levantar el servidor de demo

**Con `import` real** (`src/api.wsb`, importa `Persona` desde `persona.wson`):

```bash
cd compiler
node -e "
const { parse } = require('./parser');
const { createServer } = require('./codegen-server');
const fs = require('fs');
const path = require('path');
const ast = parse(fs.readFileSync('../src/api.wsb', 'utf8'));
createServer(ast, {}, { baseDir: path.resolve('../src') }).listen(3000, () => console.log('escuchando en :3000'));
"
```

```bash
curl -X POST http://localhost:3000/personas -H "Content-Type: application/json" -d '{"nombre":"Ana","edad":30,"altura":1.7,"mayorEdad":true,"direccion":{"numero":5,"calle":"Mayor"},"listaPropiedades":["coche"]}'
```

**Autocontenido, sin `import`** (`src/demo-servidor.wsb`):

```bash
cd compiler
node -e "
const { parse } = require('./parser');
const { createServer } = require('./codegen-server');
const fs = require('fs');
const ast = parse(fs.readFileSync('../src/demo-servidor.wsb', 'utf8'));
createServer(ast, { port: 3001 }).listen(3001, () => console.log('escuchando en :3001'));
"
```

```bash
curl -X POST http://localhost:3001/notas -H "Content-Type: application/json" -d '{"texto":"Hola WebScript"}'
```

## Tests

```bash
cd compiler
npm test
```

Corre la suite completa con el test runner nativo de Node (`node:test`,
sin dependencias que instalar) — 28 tests, cubriendo lexer, html-parser,
parser y codegen. Varios son regresión directa de bugs reales encontrados
mientras se construía (spread de `body` como array, expresiones
multilínea sin fusionar, HTML anidado por tags en vez de por indentación,
`Visual.render()` engullido por la plantilla anterior).

Si `npm test` no está disponible, el equivalente directo es:

```bash
node --test tests/*.test.js
```

(`node --test tests/` a secas falla en algunas versiones de Node — usa
siempre el patrón con `*.test.js`.)

## Probar el parser contra los ejemplos

Desde la carpeta `compiler/`:

```bash
cd compiler
node cli.js ../src/persona.wson
node cli.js ../src/contador.wsf
node cli.js ../src/app.wsf
node cli.js ../src/api.wsb
```

Cada comando imprime el AST del fichero como JSON por la salida
estándar. Para guardarlo en un fichero en vez de verlo por pantalla:

```bash
node cli.js ../src/app.wsf > app.ast.json
```

Para probar tu propio fichero, cualquier ruta vale:

```bash
node cli.js /ruta/a/tu/fichero.wsf
```

## Estructura del paquete

```
webscript-ejemplo/
├── DISEÑO.md          — especificación acordada del lenguaje (fuente de verdad)
├── INSTRUCCIONES.md   — este fichero
├── wconfig.json        — config de ejemplo (puerto, rate limit, stylesheets)
├── .gitignore
├── lib/                 — clases núcleo del lenguaje (protegidas, no editables)
│   ├── Visual.ws
│   └── WSON.ws
├── src/                 — código de ejemplo
│   ├── persona.wson
│   ├── utils.ws
│   ├── contador.wsf
│   ├── app.wsf
│   ├── api.wsb
│   ├── demo-contador.wsf  — ejemplo autocontenido para probar el codegen de cliente
│   ├── demo-composicion.wsf — ejemplo con props/slot (composición de componentes)
│   ├── demo-servidor.wsb  — ejemplo autocontenido para probar el servidor real
│   └── demo-cliente-servidor.wsf — botón que manda un WSON real al servidor
└── compiler/            — el compilador en sí
    ├── serve-demo.js     — sirve página + API en el mismo origen (probar en navegador real)
    ├── package.json      — script de test + jsdom como devDependency
    ├── lexer.js          — indentación + fusión de líneas multilínea
    ├── html-parser.js    — árbol HTML real (pila de tags) para `visual`
    ├── parser.js         — reconoce las declaraciones del lenguaje
    ├── codegen.js        — clasificación page/library de un .wsf
    ├── codegen-client.js — AST de un visual -> JS de cliente ejecutable (props/slot incluido)
    ├── codegen-server.js — AST de un .wsb -> servidor HTTP real (listen/watch/CSRF/rate limit)
    ├── codegen-dto.js    — AST de un .wson -> clase DTO real con validación de tipos
    ├── codegen-ssr.js    — AST de un visual -> HTML real en servidor (SSR por petición)
    ├── resolve-imports.js — resolución de rutas de import (compartida cliente/servidor)
    ├── runtime.js        — runtime reactivo de cliente (Proxy + effect), embebido en el bundle
    ├── wson-runtime.js   — runtime de WSON en servidor (HMAC, AES-256-GCM, envío HTTP real)
    ├── check-lib.js      — protege lib/: rechaza compilar si fue modificado
    ├── bin/
    │   └── websc.js       — CLI real: `init`/`update`/`build`
    ├── cli.js             — utilidad de línea de comandos
    └── tests/             — suite de tests (node:test + jsdom)
```

## Próximos pasos sugeridos (en orden razonable)

1. **Diffing por clave en `for`** — ahora mismo reconstruye la lista entera en cada cambio, y también es la reconstrucción que ocurre al hidratar un `for` (ver limitación de hidratación arriba); resolver esto de paso mejoraría también la hidratación de listas.
2. **Sesiones por visitante** — el estado de módulo del servidor ya existe, pero es compartido entre todas las peticiones, no aislado por sesión.
3. **Publicar `websc` de verdad** (`npm link` o publicarlo en un registro) para poder usarlo como `websc init` en vez de `node bin/websc.js init`.
