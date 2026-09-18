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

Lo que **no** hace todavía el codegen de cliente:
- **Resolución de `import` entre ficheros** — la composición de componentes solo funciona si el `visual` está declarado en el mismo fichero; uno importado desde otro `.wsf` se trata como etiqueta HTML normal.
- **Sin diffing por clave en `for`** (mencionado arriba) ni SSR/SSG real.

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

Lo que **no** hace todavía el servidor:
- **Sin sesión por visitante** — el estado de módulo (`visitasSesion`, etc.) se comparte entre **todas** las peticiones al servidor, no es un contador distinto por cookie de sesión. Sesiones de verdad (aisladas por visitante) siguen pendientes.
- **Sin `useRoute`/GET con SSR** — el servidor solo cubre `WSON.listen()` con POST/PUT/DELETE.
- **El intérprete del cuerpo de `watch()` es "mejor esfuerzo"**: como la API de WSON ya es estática, la mayoría de sentencias son JS casi literal, pero no hay comprobación real de que tengan sentido — es traducción directa, no un intérprete completo de WebScript.
- **No existe el CLI `websc`** (`init`/`update`).

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
│   └── demo-servidor.wsb  — ejemplo autocontenido para probar el servidor real
└── compiler/            — el compilador en sí
    ├── package.json      — script de test + jsdom como devDependency
    ├── lexer.js          — indentación + fusión de líneas multilínea
    ├── html-parser.js    — árbol HTML real (pila de tags) para `visual`
    ├── parser.js         — reconoce las declaraciones del lenguaje
    ├── codegen.js        — clasificación page/library de un .wsf
    ├── codegen-client.js — AST de un visual -> JS de cliente ejecutable (props/slot incluido)
    ├── codegen-server.js — AST de un .wsb -> servidor HTTP real (listen/watch/CSRF/rate limit)
    ├── codegen-dto.js    — AST de un .wson -> clase DTO real con validación de tipos
    ├── resolve-imports.js — resolución de rutas de import (compartida cliente/servidor)
    ├── runtime.js        — runtime reactivo de cliente (Proxy + effect), embebido en el bundle
    ├── wson-runtime.js   — runtime de WSON en servidor (HMAC, AES-256-GCM, envío HTTP real)
    ├── cli.js             — utilidad de línea de comandos
    └── tests/             — suite de tests (node:test + jsdom)
```

## Próximos pasos sugeridos (en orden razonable)

1. **Resolución de `import` en el cliente** — ya funciona en el servidor (`.wson`/`.ws`); falta lo mismo para componentes `.wsf` entre ficheros en el codegen de cliente.
2. **Diffing por clave en `for`** — ahora mismo reconstruye la lista entera en cada cambio.
3. **Sesiones por visitante** — el estado de módulo del servidor ya existe, pero es compartido entre todas las peticiones, no aislado por sesión.
4. **CLI `websc`** — `init` (scaffold + `lib` + compilador vendorizado) y `update`.
