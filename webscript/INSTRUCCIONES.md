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
  - **Otro bug real, encontrado al revisar la misma familia de problemas para `.wsb`**: una función importada de un `.ws` que dependía de una `reactive` "hermana" del mismo fichero (no pedida explícitamente en el `import`) daba un **`ReferenceError` real** al llamarla — a diferencia de `.wsf` (que ya trae *todas* las reactive del fichero importado sin condición, y por eso nunca tuvo este problema), `.ws` solo traía lo que el `import` pedía por nombre. Corregido con el mismo criterio que `.wsf`: se trae toda reactive del `.ws`, la pida o no el `import`. Probado con una función que incrementa y persiste una reactive hermana entre llamadas (`1` → `2`, no solo deja de reventar).
  - **Bug real, más grave, en las tres piezas del cliente a la vez**: una `function` declarada **directamente en el propio `.wsf`** (no importada de un `.ws`) nunca llegaba al bundle en ninguno de los tres sitios donde debía — se llamaba desde un `onclick`/interpolación, pero su definición no viajaba a ningún lado: `ReferenceError` real al hacer clic en el navegador. Los tres puntos afectados y corregidos: (1) el bundle de cliente de la propia página, (2) el SSR (mismo fallo, `renderPageToHTML` también solo miraba funciones importadas), y (3) un componente de un `.wsf` que usa una función de **su propio fichero**, importado por otro `.wsf` — las tres compartían la misma causa: `functionSources` solo se rellenaba desde lo importado de un `.ws`, nunca desde `ast.body.filter(FunctionDecl)` del propio fichero. Corregido en los tres a la vez (los dos primeros comparten código: `codegen-ssr.js` reutiliza `collectImportedPieces` de `codegen-client.js`). Probado con el flujo completo: SSR con la función ya evaluada, hidratación real, y la interactividad posterior reevaluándola con el valor nuevo tras un clic.
  - **Auditoría completa de "¿qué viaja bien entre ficheros?"** (function/var/const/reactive/clase, en las dos direcciones cliente y servidor) — dos bugs más encontrados y corregidos:
    1. **`const`/`var` entre `.wsf`↔`.wsf` y `.wsf`↔`.ws` no viajaban en absoluto** (`ReferenceError` real) — la estructura de resultado del import de cliente (`reactiveInits`/`functionSources`/`visualDecls`/`styleNames`) no tenía ningún hueco para ellos; nunca se recogían. Corregido añadiendo un campo `topLevelInits`, con el mismo criterio de "traer todos, los pida o no el import por nombre".
    2. **Un `var`/`const` importado explícitamente por nombre entre `.wsb`↔`.wsb` se trataba como un valor estático fijo, no como estado de sesión real** — reasignarlo dentro de un `watch()` no persistía entre peticiones de la misma sesión (aunque el import de una `reactive` sí lo hacía correctamente desde la fase anterior). La causa: una rama distinta del código (`bindings[name] = new Function(...)()`, evaluación de una sola vez) manejaba `var`/`const` explícitos, separada de la que ya trataba `reactive` como estado real. Corregido unificando ambas: `var`/`const`/`reactive` explícitos se tratan todos igual (estado real, con su `watch()` y su estado "hermano" si los tiene). Probado con persistencia real entre peticiones (`301` → `302`).
  - **Nueva capacidad, no solo un bug**: un `.wsf` ahora puede importar un DTO de un `.wson` (`import { Persona } from "./persona.wson"`) — antes no soportado en absoluto en cliente (fallaba con un error claro, al menos). La clase se genera como texto JS embebido en el bundle (`genDtoClassSource`, en `codegen-dto.js`), reutilizando `typeMismatch` del propio runtime de cliente para la validación — tanto en el constructor como en cada reasignación posterior, probado con un valor de tipo incorrecto en ambos casos. Un bug de orden real al implementarlo: la clase se insertaba *después* de la línea `createStore(...)` que ya podía necesitarla (`Cannot access 'Persona' before initialization`) — corregido moviéndola antes.
  - **Nueva capacidad: import de paquetes npm reales y de `.js` normal** — `resolveImportPath` (`resolve-imports.js`) ahora también prueba `.js`, y un nuevo `isPackageSpecifier`/`resolvePackage` distingue un specifier de paquete (no empieza por `.` ni `/`) de uno relativo, resolviéndolo con la propia resolución de módulos de Node (`require.resolve` caminando por `node_modules`).
    - **Servidor**: `require()` real en los dos casos, sin ningún riesgo (el código ya corre en Node). Probado con `acorn` (paquete real ya instalado) y `path` (nativo de Node) funcionando dentro de un `watch()`, y de extremo a extremo con `websc build` + `dist/server.js` real.
    - **Cliente, un paquete npm**: **rechazado explícitamente**, con mensaje claro — sin bundler que resuelva las dependencias propias del paquete, incrustar su código a ciegas podría romper el bundle de formas difíciles de prever. Frontera consciente, no una limitación pendiente de cerrar.
    - **Cliente, un `.js` normal**: SÍ soportado — vía de adopción incremental (meter WebScript fichero a fichero en un proyecto Node ya existente). Su código fuente se incrusta tal cual en el bundle, envuelto en un módulo CommonJS aislado (`module.exports`/`exports`) — probado con jsdom real, ejecutándose en el navegador simulado. Si ese `.js` a su vez importara/requiriera otra cosa, eso no se resuelve (sin bundler, solo se admite un fichero suelto).
    - Nueva forma de `import` sin llaves (`import nombre from "ruta"`) — antes solo existía con llaves. Liga el `module.exports` entero a `nombre`, coherente con cómo se consumiría con un `require()` normal; con llaves (`import { a, b } from "ruta"`) desestructura esos nombres del objeto exportado. Aplica igual a `.js` y a `.json` (ya existente desde una fase anterior).
    - Al probarlo con un alias de import (`import { parse as parseJS } from "acorn"`) salió a la luz que el `as` de import **no está soportado en absoluto** (ni antes ni ahora) — el parser no lo reconoce y trata todo el texto como un solo nombre. Limitación real, aparte, no cerrada en esta fase.

Del codegen de cliente, ya resuelto (quedó aquí documentado por los bugs reales que salieron al implementarlo):
- **Diffing por clave real en `for`**: cada elemento se identifica por sí mismo (un objeto por su referencia, un primitivo por su valor — sin necesitar declarar una clave aparte, porque mutar una propiedad no cambia la referencia). Reordenar, añadir o quitar elementos **mueve/reutiliza** los nodos existentes en vez de reconstruir la lista entera — probado marcando un nodo con una propiedad JS y comprobando que sobrevive a `reverse()`, `unshift()` y `splice()`.
  - **Dos bugs reales encontrados en el propio runtime reactivo al implementar esto** (no en el diffing en sí):
    1. El `get()` del `Proxy` envolvía objetos anidados con `reactive()`, pero cuando un método nativo de array (`unshift`/`splice`) leía un elemento ya envuelto y lo reescribía en otra posición, el array de respaldo acababa guardando el *proxy* en vez del objeto original — perdiendo la identidad en el siguiente acceso. Arreglado desenvolviendo (`toRaw`) cualquier valor que ya sea uno de nuestros proxies antes de guardarlo.
    2. `unshift`/`splice` desplazan elementos con **varias** lecturas-y-escrituras internas antes de terminar — cada una disparaba la reactividad a mitad de la operación, con el array en un estado a medias (causaba un `TypeError` real al leer una propiedad de un elemento inexistente en ese instante). Arreglado ejecutando los métodos mutadores de array directamente sobre el array crudo (sin pasar por el `Proxy` en cada paso intermedio) y notificando una única vez, ya terminados.
- **Router de cliente, ahora reactivo de verdad**: antes `Visual.route()` leía `window.location` una sola vez, al arrancar — cambiar de URL sin recargar la página (navegación SPA, atrás/adelante del navegador) no se reflejaba en nada. Ahora:
  - `Visual.route()` lee un estado reactivo interno (`routerState.href`, en `runtime.js`) en vez de `window.location` directamente — queda "trackeado" como cualquier otra propiedad reactiva.
  - `Visual.navigate(url, { replace })` — nueva función expuesta: navega sin recargar la página (`history.pushState`/`replaceState`) y actualiza ese estado interno.
  - El propio atrás/adelante del navegador (`popstate`) también actualiza el estado interno.
  - En el compilador: cualquier `const`/`var` de nivel superior que dependa de `Visual.route()`/`params()`/`query()` (directa o transitivamente, p. ej. `const {id} = Visual.params(screen)` depende de `screen`) pasa a ser una propiedad reactiva de verdad (`state.id`, `state.tab`...), recalculada dentro de un único `effect()` — así cualquier interpolación que la use se actualiza sola. Un `const`/`var` de nivel superior **sin** relación con la ruta se sigue compilando exactamente igual que antes (una sola vez, no reactivo) — sin regresión.
  - Probado con los tres casos reales: `Visual.navigate()` sin recarga, `popstate` real, y el conjunto completo SSR + hidratación + navegación posterior — el nodo del SSR sobrevive a la navegación (se reutiliza, no se recrea).
  - **Ya resuelto**: un `<a href="...">` interno normal ya navega así automáticamente, sin `onclick` — el clic se intercepta solo, con los mismos casos de exclusión que React Router/Vue Router: clic modificado (ctrl/cmd/shift/alt, para abrir en pestaña nueva), botón distinto del izquierdo, `target` que no sea `_self` (`_blank`, etc.), `download`, `rel="external"`, ancla de la propia página (`#seccion`, para que el scroll nativo siga funcionando), y cualquier enlace que no sea del mismo origen (externo, `mailto:`, `tel:`). Probado con los seis casos de exclusión (ninguno se intercepta) y con el flujo completo SSR + hidratación + clic en un enlace normal.
- **Import de `.wsb` no soportado desde el cliente** (no tendría sentido: lógica de servidor).

**SSR** (`codegen-ssr.js`) — genera HTML real en el servidor, sin necesitar un DOM; por petición (dinámico) o de una vez en el build (SSG), según si la página puede variar entre visitantes (ver más abajo):
- Interpolaciones de texto, `if`/`else if`/`else`, `for`, composición de componentes (`props`/`slot`, con el scope del padre respetado), `style` como clase literal, escapado de HTML para evitar inyección.
- `Visual.route()`/`Visual.params()`/`Visual.query()` resueltos contra la URL real de cada petición — probado con dos peticiones a la misma página con distinto `:id` (`/personas/7` vs `/personas/99`), devolviendo HTML distinto cada vez, no cacheado desde el `build`.
- Integrado en `websc build`/`dist/server.js` y en `serve-demo.js`: el HTML que sirven ya no es un `<body>` vacío, es el contenido real renderizado en servidor.
- **Hidratación incremental real** (no *render-then-replace*): los elementos y el texto que el SSR pintó se **reutilizan de verdad** al cargar el cliente — mismo nodo DOM, no uno recreado (probado marcando el nodo con una propiedad JS antes de hidratar y comprobando que sobrevive). Los eventos y las interpolaciones reactivas se enganchan sobre esos mismos nodos.
- **`for` ya se hidrata de verdad** (gracias al diffing por clave): en el primer paso, en vez de reconstruir, hidrata cada elemento existente del SSR uno por uno y los guarda en el mapa de claves — probado marcando un `<li>` del SSR y comprobando que sobrevive tanto a la hidratación como a un `reverse()` posterior.
- **`if`/`else` ya hidrata de verdad, y hace diffing de rama activa**: al hidratar, se identifica qué rama coincide con lo que ya pintó el SSR y se hidratan esos nodos existentes (no se reconstruyen) — igual que el `for`. Y en cualquier cambio posterior (hidratado o no), si la rama que gana sigue siendo la **misma** que antes, no se toca nada — antes cualquier cambio que disparara el `effect()` destruía y reconstruía el contenido aunque la rama ganadora no hubiera cambiado. Solo se reconstruye de verdad al **cambiar** de rama (no hay "identidad" que preservar entre el contenido de una rama y el de otra, son cosas distintas). Probado marcando el nodo del SSR y comprobando que sobrevive tanto a la hidratación como a cambios que no cambian de rama.
- Sin SSR (body vacío salvo el propio `<script>`, distinguido vía `document.currentScript`), se sigue montando desde cero como antes — mismo bundle, sin necesidad de generar dos versiones distintas.
- **Limitaciones que siguen en pie**: el `state` inicial del SSR es un snapshot (se evalúa una vez, sin reactividad en el HTML en sí — no puede haberla, es texto); los manejadores de eventos (`onclick={...}`) se omiten en el HTML del servidor, aparecen solo cuando el cliente hidrata.

**SSG real** (`websc build`, además del SSR dinámico): las dos únicas fuentes de variabilidad por petición que existen hoy son `:params` en la ruta y `Visual.query()` — sin ninguna de las dos, el HTML de una página es el **mismo** para cualquier visitante, así que se genera **una sola vez en el build**, no en cada petición:
- Una página sin `:params` en su patrón y sin ningún uso de `Visual.query()` se detecta automáticamente como estática, se renderiza una vez con `renderPageToHTML()` en `websc build`, y el `.html` resultante se escribe a `dist/` — `dist/server.js` la sirve leyendo ese fichero tal cual, sin volver a parsear ni renderizar nada.
- Una página con `:params` o que use `Visual.query()` sigue con SSR dinámico real, exactamente como antes (necesita la URL exacta de cada petición).
- **Probado de la forma más directa posible**: tras `websc build`, se borra el `.wsf` original de la página estática, y `dist/server.js` la sigue sirviendo correctamente — no depende de él en tiempo de ejecución, a diferencia de la ruta dinámica (que si se le borra el `.wsf` fuente, sí fallaría, porque necesita volver a parsearlo en cada petición).
- El resumen que imprime `websc build` distingue explícitamente `SSG: archivo.html (precalculado en el build)` de `SSR dinámico de archivo.wsf`.

**`Visual.staticPaths(instancia, valores)`** — equivalente al `getStaticPaths()` de Next.js: para una página CON `:params` cuyos valores posibles se conocen de antemano (un blog con tres posts, p. ej.), pre-genera un `.html` real por cada combinación, en vez de SSR dinámico por petición. **Sintaxis final**, tras tres iteraciones (historial más abajo): mismo criterio que `Visual.params()`/`Visual.query()` — la instancia de `Visual.route()` como primer argumento —, y `valores` un array de objetos **ya resuelto en tiempo de compilación**, no una función ni un bloque a ejecutar:
```
const Visual screen = Visual.route('/blog/:slug')
import posts from "./posts.json"
Visual.staticPaths(screen, posts)
```
`import nombre from "ruta"` (sin llaves — nueva forma de `import`, antes solo existía con llaves) liga el contenido **entero** de un `.json` a `nombre`, embebido como `const` literal (JSON válido es JS válido) tanto en el bundle de cliente como en cualquier build. `import { campo } from "ruta"` liga solo esa propiedad. `valores` también puede ser cualquier otro `const`/`var` de nivel superior cuyo valor no dependa de ninguna petición real — no tiene por qué venir de un `.json`. Al ser ya un valor resuelto, no hace falta ningún cuerpo aparte ni esperar nada — ni siquiera entra en juego "Async/await implícito" aquí, a diferencia de las dos iteraciones anteriores. `websc build` genera un `.html` real por cada combinación; la ruta dinámica original sigue registrada como respaldo, por si se visita una combinación que no estaba en la lista.

**Historial de las tres iteraciones** (las dos primeras, ya retiradas del todo — no coexisten con la sintaxis final, se sustituyeron por completo):
1. `Visual.staticPaths(fn)` recibía una función de JS (`() => [...]` o una función nombrada aparte). Bugs reales encontrados: (a) `Visual.ws` no mencionaba `Visual.navigate()`, ya implementado antes — corregido de paso; (b) un cuerpo de flecha multilínea puede no ser JS válido (la fusión de líneas del lexer une varias sentencias sin separador real entre ellas).
2. `Visual.staticPaths(screen)` con su propio cuerpo de bloque, como `watch()` (nuevo tipo de nodo `StaticPathsDecl` en el parser). Resolvía el problema de la flecha multilínea de raíz, pero seguía exigiendo escribir lógica de I/O a mano (`fs`/`JSON.parse`) dentro del bloque.
3. **La actual**: al pedir explícitamente poder escribir `const posts = Visual.staticPaths(screen)`, quedó claro que lo que hacía falta no era un bloque más simple, sino quitar la necesidad de ejecutar nada — `posts` como un valor ya resuelto, típicamente por `import` de un `.json`. Esto retiró `StaticPathsDecl` del parser por completo (vuelve a ser un nodo `Raw`, detectado por regex, igual que `Visual.render(...)`).

Bugs/mejoras que se mantienen vigentes en la sintaxis final:
  - **`require()`/`__dirname` resueltos de verdad contra el propio `.wsf`** (`Module.createRequire()`), no contra `bin/websc.js` — usado si algún `const`/`var` de nivel superior del fichero necesita `require()` él mismo.
  - **Bug real más serio, en `dist/server.js`**: leía **todos** los `.wsf` de golpe al arrancar (incluida la ruta dinámica de respaldo) — si su fuente no existía (p. ej. un despliegue que solo conserva los `.html` ya generados), tumbaba el servidor **entero**, incluidas las páginas ya precalculadas que no lo necesitaban en absoluto. Corregido con carga perezosa y aislada por página: un fuente que falta da un `500` claro **solo en esa ruta**, y el servidor sigue vivo para todo lo demás.
  - Probado de extremo a extremo con la sintaxis final: generación real de los `.html` a partir de un `import` de `.json` (con y sin llaves), las rutas listadas sirviendo sin el `.wsf` **ni el `.json`** fuente, `500` aislado para el fallback si falta el fuente (con el servidor confirmado vivo justo después), y el fallback dinámico renderizando correctamente un valor nuevo cuando el fuente sí existe.

**Servidor** (`codegen-server.js` + `wson-runtime.js`) — ya hay un servidor HTTP real (Node puro, sin framework), probado con peticiones HTTP de verdad, no simuladas:
- `WSON.listen()` + `watch()` con matching real de `to`/`via` (incluida la normalización de `:param` para detectar colisiones entre rutas con distinto nombre de parámetro).
- `httpCode`, `WSON.send()` (responde la petición entrante), `WSON.showContent()` (real: AES-256-GCM) dentro del handler.
- Firma HMAC-SHA256 / verificación / decodificación de JWT con criptografía real (`wson-runtime.js`), no simulada.
- CSRF (cookie de doble envío, comparada contra el token real de la sesión — no solo cookie==header) y rate limiting (`wconfig.json`), aplicados de verdad — probado con peticiones reales, incluida la emisión real de las cookies `wsession`/`wcsrf` (antes nadie las creaba, aunque `checkCsrf` ya las esperaba) y el corte del rate limit.
- **Sesiones por visitante, reales** (`createSessionStore`): cada visitante (identificado por la cookie `wsession`, emitida por el propio servidor la primera vez) tiene su **propia copia** del estado de nivel superior del `.wsb` — no compartida con nadie más. Expiración por inactividad y desalojo LRU configurables (`session-timeout-ms`, `session-max` en `wconfig.json`), cookie `Secure` condicional (activa si `req.socket.encrypted` o `X-Forwarded-Proto: https`). Probado: dos visitantes sin cookie tienen contadores independientes; el mismo visitante (misma cookie) acumula su propio estado a través de varias peticiones.
- **Persistencia en disco, real** (`"session-store": "file"` en `wconfig.json`): un `.json` por sesión en `.sessions/` (en la raíz del proyecto, configurable con `"session-dir"`) — probado matando el servidor de verdad (`kill -9`) y volviéndolo a arrancar, con la misma cookie recuperando exactamente el estado donde se quedó. Por defecto sigue siendo `"memory"` (retrocompatible).
  - **Tres bugs reales encontrados al implementarlo**:
    1. El guardado ocurría **después** de responder (en un `.finally()`, un tick de microtarea más tarde) — si el proceso moría justo tras enviar la respuesta, la mutación de esa petición se perdía pese a que el cliente ya había recibido el valor actualizado. Corregido: se guarda **antes** de escribir la respuesta.
    2. El desalojo LRU comparaba por `Date.now()` — con resolución de milisegundo, sesiones creadas muy rápido pueden empatar, y `fs.readdirSync()` no garantiza ningún orden relacionado con la creación. Corregido con un contador de secuencia monótono aparte del reloj (y que arranca desde el máximo ya usado en disco, para seguir siendo correcto tras un reinicio).
    3. Las sesiones se guardaban dentro de `src/` (reutilizando el mismo `baseDir` que la resolución de `import`) — mezclando datos de sesión con código fuente. Separado: la sesión usa la raíz del proyecto por defecto.
  - **Limitación real, ya resuelta**: ~~sin bloqueo de fichero — dos peticiones concurrentes para la *misma* sesión pueden pisarse entre sí~~. Ahora hay bloqueo real (`acquireFileLock`/`releaseFileLock`): creación atómica de un `.lock` por sesión (con la flag `wx`, falla si ya existe — funciona incluso entre **procesos** distintos, no solo dentro de uno), con espera asíncrona (no bloquea el bucle de eventos) y detección de lock abandonado (si el proceso que lo tenía murió sin liberarlo, se fuerza tras `session-lock-stale-ms`). El bloqueo cubre desde que se lee la sesión hasta que se guarda — antes esa sección crítica no estaba protegida en absoluto. Probado con **20 peticiones concurrentes de verdad** (`Promise.all`, y también con `curl` reales contra un servidor real) para la misma sesión: los valores devueltos son exactamente consecutivos, sin huecos ni repetidos — antes de este arreglo, esto habría perdido incrementos.
- **Persistencia en Redis, real** (`"session-store": "redis"`, `"redis-url"` en `wconfig.json`) — la única de las tres opciones que sirve para compartir sesiones entre **procesos en máquinas distintas** (el backend de fichero solo protege dentro del mismo filesystem). `require("redis")` diferido: es una dependencia **opcional** del paquete (`optionalDependencies`), quien no la use no necesita tenerla instalada. El bloqueo usa `SET NX PX` (mismo patrón base que Redlock, sin la variante multi-nodo/quorum). Probado contra un Redis real instalado en esta misma máquina: `get()`/`create()`/`save()` visibles desde un store completamente distinto (simula otro proceso), `lock()` esperando de verdad a través de la red, y **20 peticiones concurrentes reales** contra un servidor con `session-store: "redis"` sin ninguna pérdida.
  - **Dos bugs reales encontrados al implementarlo**:
    1. `WSON.send()` se llama de forma **síncrona** desde el código generado (WebScript no tiene `await` en su sintaxis), pero guardar en Redis es asíncrono — sin arreglarlo, se habría repetido el bug de "responder antes de guardar" ya corregido para ficheros. Solución: cuando `WSON.send(...)` es la última sentencia de una rama (el caso normal, incluso dentro de `if`/`else`), el compilador ahora emite `return WSON.send(...)`, para que quien llama al handler pueda esperarlo de verdad antes de soltar el bloqueo.
    2. El cliente de Redis reintenta conectar **indefinidamente** por defecto — si Redis está caído de verdad, cualquier petición se habría quedado colgada para siempre. Acotado a unos pocos reintentos con backoff (`redis-connect-timeout-ms`), tras los cuales falla con un error claro.
  - Los tests de Redis (`tests/codegen-session-redis.test.js`) comprueban si hay un Redis real en `localhost:6379` y se saltan solos si no lo hay — no rompen la suite en una máquina sin Redis instalado.
  - **Limitación real y explícita**: el lock es de una única instancia de Redis, no Redlock multi-nodo — si esa instancia de Redis se cae en mitad de una sesión con el lock cogido, no hay quorum que lo detecte. Vale para el caso normal (una instancia de Redis, o una réplica con failover gestionado aparte); no es una garantía de consenso distribuido de verdad.
- **DTOs desde `.wson`** (`codegen-dto.js`): clase real con constructor posicional, validación de tipos en el constructor y en cada `set` posterior, campos opcionales, objetos anidados — probado contra `persona.wson` de verdad.
- **Tipado real de `var`/`const`/`reactive`** (`type-check.js`, compartido con los DTO): antes el tipo declarado (`var integer x`, `reactive string nombre`, `tipo(array)`...) se capturaba en el AST pero no se comprobaba en ningún sitio — cualquier valor colaba. Ahora se valida de verdad en los tres sitios donde se evalúa un valor inicial/asignado:
  - **Cliente**: valor inicial comprobado al montar, **y comprobación continua en cada reasignación** — enganchada directamente al `set()` del `Proxy` reactivo (`createStore(inicial, esquemaDeTipos)`), así que no es solo "al declarar", sigue vigilando mientras la app vive. Probado: `reactive string nombre = 42` se rechaza al montar; `reactive integer contador` reasignado a un string se rechaza en el momento exacto del clic, con el mensaje de error real.
  - **SSR** (`codegen-ssr.js`) y **estado de sesión del servidor** (`instantiateSessionState`): mismo criterio, validado al evaluar el valor inicial.
  - **Bug real encontrado al probar el lado servidor**: una `var` de servidor con tipo mal declarado lanzaba una excepción que escapaba sin control (la resolución de sesión ocurre antes de que empezara ningún `try/catch`) — **tiraba el proceso Node entero** en la primera petición, no solo esa petición. Corregido con una red de seguridad (`catch` adicional) que responde `500` con el mensaje real, sin tirar el servidor.
  - Sin tipo declarado, sigue coliendo cualquier valor — retrocompatible con todo el código ya escrito.
  - **Ya resuelto** (no era un problema específico de `watch()`, sino de que el estado de servidor vivía en un objeto plano sin ningún punto de paso — a diferencia del `Proxy` del cliente, por el que pasa *toda* asignación venga de donde venga): ahora el estado de sesión se envuelve en un `Proxy` ligero (`wrapTypedState`, sin tracking ni effects — el servidor no necesita reactividad, solo que el tipo se siga cumpliendo) antes de pasarlo al handler. Una reasignación con tipo incorrecto se rechaza con `400` sin que el compilador necesite saber dónde ocurre textualmente — probado con la asignación directa en `watch()` y dentro de un `for`, y confirmado que `visitas++` y el guardado en disco (backend de fichero) siguen funcionando con normalidad.

- **Import resuelto de verdad en el servidor** (`resolve-imports.js`): `import { Persona } from "./persona.wson"` dentro de un `.wsb` ya funciona — genera la clase DTO real (`codegen-dto.js`) y la deja en el scope del handler. También resuelve `import { X } from "./archivo.ws"` (funciones y valores exportados). Probado con **`api.wsb` real, tal cual estaba escrito** — lo cual sacó a la luz dos bugs reales que llevaban ahí desde hace muchos turnos, invisibles hasta que se ejecutó de verdad:
- **Import `.wsb` → `.wsb`, como composición de rutas**: un `.wsb` puede exportar una ruta completa (`WSON` + `reactive`/`WSON.listen()` + `watch()`), y otro `.wsb` la importa para que su propio servidor también la sirva — mismo criterio que `.ws` para funciones/valores sueltos. Los imports que esa ruta necesite a su vez (un DTO `.wson`, otra función) se resuelven contra la carpeta del fichero **origen** de la ruta, no la de quien la importa — probado con una cadena real de tres ficheros (`api.wsb` → `personas.wsb` → `persona.wson`). La validación de colisiones de rutas sigue funcionando igual entre una ruta propia y una importada.
  - **Dos bugs reales encontrados y corregidos al implementarlo** (no en el import en sí, en piezas ya existentes):
    1. `extractListeners`/`extractSessionStateDecls` no desenvolvían los nodos `Export` — una ruta (o un `var`/`reactive` de estado) marcada con `export` quedaba **invisible dentro de su propio fichero**, rompiendo la semántica normal de "exportar no oculta el uso local". Corregido: ahora una ruta exportada se sirve igual de bien tanto si nadie la importa como si alguien lo hace.
    2. Al arreglar lo anterior, `websc build` (que combina automáticamente todos los `.wsb` de `src/`) habría empezado a **duplicar** cualquier ruta que un fichero exportara y otro importara. Corregido: `websc build` excluye de la combinación automática cualquier `.wsb` importado explícitamente por otro del mismo proyecto (se sirve solo a través de quien lo importa) — probado de extremo a extremo con `websc init` + `websc build` + `node dist/server.js` real.
  - **Observación, no una limitación nueva**: ni `.ws` ni `.wsb` exigen de verdad la palabra `export` — cualquier declaración de nivel superior es importable esté o no marcada. Ya era así para `.ws` antes de esta fase; no se ha tocado.
  - **Ya resuelto** (y al revisarlo, se confirmó que `.ws` tenía el **mismo bug, peor** — ver más abajo): si la ruta importada dependía de **otra** `var`/`reactive` de nivel superior del fichero origen, ese estado no viajaba con ella. Corregido con el mismo criterio que ya usaba `.wsf` desde el principio (traer **todas** las reactive/estado del fichero origen, no solo lo pedido explícitamente en el `import`) — probado con una `var contadorVisitas` en `usuarios.wsb`, incrementada dentro del `watch()` de una ruta importada, persistiendo correctamente entre peticiones de la misma sesión (`1` → `2`). Se añadió también detección de colisión: si dos ficheros combinados por `import` declaran una `var`/`reactive` con el mismo nombre, ahora da un error claro en vez de mezclarlos en silencio.
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
- **`watch()` ya sirve para cualquier reactive, no solo las atadas a `WSON.listen()`**: antes, `watch(nombre)` sobre una `reactive` normal (`string`/`boolean`/DTO/array) era código muerto — existía en el AST pero `extractListeners` nunca lo veía, así que jamás se compilaba ni se ejecutaba. Ahora:
  - Las `reactive` atadas a `WSON.listen()` siguen exactamente igual (disparadas por una petición HTTP real que encaja con su ruta).
  - **Cualquier otra `reactive`** dispara su `watch()` al reasignarse — típicamente desde dentro de otro `watch()` (incluido el de una ruta), en **cascada** si ese segundo `watch()` reasigna una tercera con su propio `watch()`, todo dentro de la misma petición que arrancó la cadena. Mecanismo: `wrapReactiveState` (extensión de la validación de tipo ya existente) — el mismo punto de paso que ya validaba tipos ahora también dispara watchers.
  - Cruzado entre ficheros: la `reactive` en un `.wsb`, su `watch()` en otro que la importa — funciona tanto si la `reactive` está atada a `WSON.listen()` como si no. Antes esto daba un error explícito ("falta su WSON o su watch()"); ahora el `watch()` de la ruta en el fichero origen es **opcional** — si no está ahí, quien importa puede declarar el suyo propio.
  - Dos `watch()` para la misma `reactive` (posible tras combinar imports) se detectan como colisión, con error claro.
  - **Ya resuelto — "Async/await implícito" (regla del lenguaje, DISEÑO.md) exigía que esto se esperara de verdad, no `fire-and-forget`**: antes, el disparo de un `watch()` en cascada era síncrono — si su cuerpo hacía algo asíncrono, no se esperaba su resultado desde quien lo disparó. Corregido en dos piezas:
    1. **Toda función de `watch()` se compila ahora como `async`** (usando el constructor de `AsyncFunction`, ya que `new Function()` no crea funciones async directamente) — de forma incondicional, no solo las que "se demuestra" que lo necesitan: un `await` dentro de una función sin trabajo async real no cambia su resultado, solo añade un microtask — precio aceptable por no arriesgarse a que una llamada indirecta (a través de una función importada, por ejemplo) se escape de un análisis más fino y vuelva a caer en fire-and-forget.
    2. Dos inyecciones automáticas de `await` en el propio texto compilado, sin que el usuario escriba la palabra en ningún sitio: **`injectAsyncTriggers`** añade `await __trigger("nombre")` justo después de cualquier asignación a una reactive con `watch()` propio (así la cascada se espera de verdad, nivel a nivel); **`injectSendAwait`** convierte cualquier `WSON.send(...)` en `await WSON.send(...)`, esté donde esté en el cuerpo — antes solo se esperaba si era la última sentencia (`markLastSendAsReturned`, ahora retirado por innecesario). `WSON.enqueue()` queda **fuera a propósito**: es fire-and-forget por diseño, esperar sus reintentos con backoff dentro de la misma petición sería contraproducente.
    - **Efecto secundario real encontrado al implementarlo**: el validador estático de referencias no declaradas (`validate-js-body.js`) envolvía el cuerpo a analizar en una función NO async — en cuanto un cuerpo empezó a contener `await` (prácticamente todos, por lo de arriba), esa envoltura dejaba de ser JS válido y la validación se saltaba en silencio para cualquier `watch()` con `WSON.send()`. Corregido envolviendo también en `async function`.
    - Probado con una llamada HTTP real a un servidor lento (300ms): la petición que arrancó la cascada tarda de verdad esos ~300ms en responder (antes tardaba unos pocos ms, sin esperar nada). Confirmado también que `WSON.enqueue()` sigue respondiendo casi al instante (no se le fuerza el `await`), y que un `watch()` en cascada que falla sigue sin tumbar la petición original.
  - **Bug real, más profundo, encontrado al probar el caso de `array`**: `reactive tipo(array) nombre = ...` (y lo mismo para `var`/`const`) **nunca se había reconocido en absoluto** — el paréntesis rompía el regex del parser, y la línea entera caía como texto suelto sin declarar nada. No era un problema de `watch()`, afectaba a **todo el lenguaje** desde siempre. Corregido en los tres (`var`/`const`/`reactive`).
- **El cuerpo de `watch()` sigue siendo "mejor esfuerzo"**: como la API de WSON ya es estática, la mayoría de sentencias son JS casi literal — sigue sin haber comprobación de que las referencias a variables tengan sentido (eso sí seguiría necesitando un análisis propio, no solo mover cuándo se compila), pero los errores de **sintaxis** ya saltan lo antes posible en vez de escondidos hasta la primera petición real (punto 4). No es, ni va a ser, un intérprete completo de WebScript escrito a mano — apoyarse en el motor de JS real (`new Function()`, es decir V8) es lo correcto, no una limitación a cerrar. Dentro de ese margen, cuatro bugs/mejoras reales:
  1. **Un `for`/`while` dentro de `watch()` no ejecutaba su cuerpo — desaparecía en silencio, sin error.** El parser sí conservaba las líneas indentadas como hijos del nodo, pero el generador de código las ignoraba por completo: la cabecera del bucle se emitía sola y lo de dentro nunca llegaba a compilarse. Un `for` que acumulaba algo, sencillamente no acumulaba nada — sin ningún aviso. Corregido: ahora cualquier construcción con cuerpo anidado que el parser no reconozca como nodo propio (no solo `if`/`else`, que ya funcionaban) se compila envolviendo sus hijos como bloque real.
  2. **Al corregir lo anterior, salió a la luz un segundo bug, ya latente desde antes**: la sustitución de estado de servidor (`nombre` → `serverState.nombre`) usaba una comprobación de "esto es la clave de un objeto, no lo toques" que no distinguía saltos de línea — un `{` de apertura de un bloque `for`/`if` en la línea anterior se confundía con el `{` de un objeto literal, y la primera sentencia del cuerpo se quedaba sin sustituir. Con estado real de servidor, eso significaba escribir en una variable local implícita que nunca tocaba la sesión de verdad. Corregido restringiendo esa comprobación a la misma línea.
  - Probado con un `for` que suma sobre una `var` de servidor real, un `if` anidado dentro de un `for`, un `while`, y el caso exacto que disparaba el segundo bug (una clave de objeto con el mismo nombre que la variable de servidor, justo tras el `{` de un bloque).
  3. **La reasignación de una `var`/`reactive` tipada de servidor no revalidaba el tipo** — solo el valor inicial de la sesión. No era un problema específico de `watch()` (una reasignación dentro de un `if`/`for` es igual de válida que una directa): el problema real era que el estado de servidor vivía en un objeto plano, sin ningún punto de paso para TODA asignación — a diferencia del cliente, donde ese punto es el `Proxy` reactivo. Corregido envolviendo el estado de sesión en un `Proxy` ligero (`wrapTypedState`, sin tracking ni effects) antes de pasarlo al handler — así una reasignación incorrecta se rechaza con `400` sin que el compilador necesite saber dónde ocurre textualmente. Probado con la asignación directa y dentro de un `for`; `visitas++` y el guardado en disco siguen funcionando con normalidad.
  4. **Compilación movida a tiempo de arranque, no "un intérprete propio"**: la función de cada ruta se **recompilaba en cada petición** que encajaba con ella — trabajo repetido de balde, y un error de sintaxis real dentro de un `watch()` quedaba escondido hasta que llegaba la primera petición real a esa ruta (`websc build` tampoco lo pillaba con un mensaje útil, solo una traza cruda de Node). Corregido: cada ruta se compila **una sola vez**, al crear el servidor — un error de sintaxis salta inmediatamente al arrancar (o al hacer `websc build`, con un mensaje limpio, sin traza cruda — se añadió un `try/catch` en el propio CLI para eso). **Decisión consciente, no un descuido**: no se ha construido (ni se va a construir) un intérprete propio de WebScript que reimplemente la ejecución de JS a mano — eso sería reimplementar, peor y más despacio, algo que el propio motor de V8 (vía `new Function()`) ya hace correctamente. Lo que sí tiene sentido, y es lo que se ha hecho, es mover ESA compilación (que ya usa V8 de verdad) al momento más temprano posible, para que sus errores salgan cuanto antes.
  5. **Análisis estático real de referencias no declaradas** (`validate-js-body.js`, nuevo módulo — parser JS de verdad vía `acorn`/`acorn-walk`, no regex): antes de compilar cada `watch()`, se comprueba que todo identificador suelto (tras la sustitución de estado) coincida con un parámetro, un nombre importado, algo declarado dentro del propio cuerpo, o un global conocido de JS/Node — si no, casi con toda seguridad es un error tipográfico, y ahora se rechaza con un mensaje claro señalando el nombre exacto, en vez de convertirse en un `ReferenceError` confuso en la primera petición real. Probado sin ningún falso positivo en los patrones legítimos habituales: claves de objeto, destructuring, `for-of` **sin** `let`/`const` (el estilo propio de WebScript), `for` clásico, `catch`, arrow functions, hoisting de funciones, etiquetas con `break`, clases con `new`, template literals. `acorn`/`acorn-walk` pasan a ser dependencias reales del paquete (no opcionales, como sí lo es `redis`) — vendorizadas junto al resto del compilador en `websc init`/`update` (con su propio `node_modules/`, para no depender de que el proyecto haga su propio `npm install`), confirmado con una instalación global real (`npm pack` + `npm install -g`).
    - **Ya resuelto — scope-checking real, no solo un conjunto plano de nombres**: al principio, el validador priorizaba evitar falsos positivos sobre precisión total, y una variable declarada dentro de un `if`/`for` y usada fuera de él no se detectaba como error. Esto no era solo "menos preciso" — una `var`/`const` de WebScript compila SIEMPRE a `let`/`const` de JS (nunca a `var` real, ver `genStatement`), así que ya tenían scope de bloque de verdad en el código generado; ese caso revienta de verdad en tiempo de ejecución (`ReferenceError`), confirmado antes de corregirlo. Reescrito con una clase `Scope` real, encadenada a su padre (igual que el motor de JS), en vez de un `Set` plano de "todo lo declarado en cualquier sitio" — `if`/`for`/`while`/función/`catch`/clase abren su propio scope hijo, con *hoisting* real pero limitado a las sentencias directas de ESE bloque (una función usada antes de "aparecer" más abajo en el mismo bloque sigue sin dar falso positivo). Probado con 10 casos cruzados: 4 que ahora SÍ se detectan (variable de un `if`/`for`/función/`catch` usada fuera de su scope) y 4 que siguen sin falsos positivos (mismo nombre en dos `if` hermanos, variable exterior visible dentro de uno anidado, parámetro visible en un `if` de su propio cuerpo, *hoisting* de función dentro de un bloque) — más el caso específico de WebScript (`for-of` sin `let`): su variable tampoco se escapa fuera del bucle.

Es decir: ya puedes coger un `.wsf` sencillo (con o sin componentes, siempre que estén en el mismo fichero) y ver una página de verdad, interactiva, en el navegador — y un `.wsb` sencillo (autocontenido o con `import`) y tener un servidor HTTP real respondiendo peticiones, con CSRF, rate limiting y sesiones por visitante de verdad.

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

## ¿Se puede usar solo para frontend?

Sí, es un uso normal — no hace falta ningún `.wsb` en el proyecto. `websc build` no exige ninguna API: si `src/` no tiene ningún `.wsb`, simplemente no genera ninguna. Y si la página no tiene `:params` en su ruta ni usa `Visual.query()` (SSG, ver más abajo), el `.html` que sale es **completamente autosuficiente** — probado sirviéndolo con `python3 -m http.server` (ningún runtime propio de por medio) y cargándolo en un navegador simulado real, con la interactividad (clics, reactividad) funcionando igual. Eso significa que se puede desplegar en cualquier hosting estático puro (Netlify, GitHub Pages, S3...), no solo "sin backend propio en el mismo proyecto".

`serve-demo.js` (el atajo rápido de un solo fichero, sin montar un proyecto con `websc init`) también acepta usarse sin `.wsb`: `node serve-demo.js mi-pagina.wsf [puerto]`.

## Base de datos: `.wsdb` (nueva capacidad completa, no un ajuste menor)

> **Nota (vuelta posterior)**: el formato v1 (`-> collection:`, `buildWsdbClass`, `find`/`findOne`/`findById`/`deleteMany`) que se describe en esta sección y en las siguientes **se eliminó** — ver la sección "Eliminación de WSDB v1", al final de este fichero. Lo que sigue es el registro de lo que se hizo en su momento; solo el formato con `-> name:` ("v2") existe hoy.

Nuevo tipo de fichero — colecciones persistentes sobre SQLite real, pensado como el equivalente NoSQL del lenguaje (documentos con esquema validado, no tablas relacionales a mano). Diseño completo en `DISEÑO.md`; aquí el detalle de implementación real:

- **Parser**: `parseWsonMetaLine` (antes solo reconocía `-> content:` como bloque anidado) ahora también reconoce `-> schema:` — mismo formato de campo (`SchemaField`/`ContentSchema`) reutilizado tal cual, sin duplicar la lógica de parseo de tipos. Nuevo `parseWsdbFile`/opción `isWsdbFile` en `parse()`, con su propio tipo de nodo raíz (`WsdbSchema`, para no confundirlo con un `WsonSchema` de mensajería puntual).
- **`codegen-wsdb.js`** (nuevo módulo): `buildWsdbClass(wsdbAst, className, dbPath)` — clase real con closures (mismo estilo que `buildDtoClass`, no texto generado con `new Function`). Reutiliza `validateField` de `codegen-dto.js` tanto en el constructor como en cada reasignación posterior — ni una validación aparte, ni una menos estricta.
- **Motor real: `node-sqlite3-wasm`**, decidido tras comparar explícitamente con `better-sqlite3` (nativo, exige compilación) y `sql.js` (WASM pero sin persistencia incremental — cada escritura reescribe la base entera). Instalado como dependencia real del compilador y **vendorizado** con el mismo mecanismo que `acorn`/`acorn-walk` (`COMPILER_DEPENDENCIES` en `bin/websc.js`) — un proyecto `websc init` nunca necesita `npm install` para usar la base de datos.
  - **Verificado antes de construir nada** (no asumido): persistencia incremental real, escribiendo desde un proceso y leyendo el mismo fichero `.db` desde **otro** proceso distinto, sin cerrar el primero — confirma que escribe a disco de verdad en cada operación, no solo al cerrar la conexión.
  - API síncrona (`db.exec()`/`db.run()`/`db.all()`/`db.get()`, sin promesas) — así que `.save()`/`.find()`/etc. no necesitan "Async/await implícito" en absoluto, a diferencia de `WSON.send()`.
- **Mapeo de tipos**: un campo primitivo (`string`/`integer`/`number`/`boolean`) es una columna SQLite real (`TEXT`/`INTEGER`/`REAL`/`INTEGER` con 0-1) — no un blob JSON. Cualquier otro tipo (`object`, `tipo(array)`) se guarda como `TEXT` con el valor serializado en JSON, deserializado de vuelta al leer.
- **Consultas**: `find(query)`/`findOne(query)`/`count(query)`/`deleteMany(query)` traducen un objeto de consulta a `WHERE` parametrizado real — igualdad directa (`{ campo: valor }`) y operadores de comparación (`{ campo: { gt, gte, lt, lte, ne } }`). Un operador desconocido da un error claro, no un `WHERE` silenciosamente incorrecto.
- **Una única conexión por fichero `.db`**, compartida entre todas las colecciones/tablas que la usen — `.wsdb-data/webscript.db`, junto al proyecto (mismo criterio que `.sessions/`), no configurable todavía en esta primera versión.
- **Cliente**: un `.wsdb` importado desde un `.wsf` se rechaza explícitamente, con mensaje claro (mismo criterio que un paquete de npm) — una base de datos no tiene sentido en el navegador.
- Probado de extremo a extremo: CRUD real vía HTTP (crear, listar, actualizar con `save()` sin duplicar fila, borrar), los cinco operadores de comparación, `findById`/`count`/`deleteMany`, validación de tipo real en constructor y en cada reasignación, persistencia real entre "reinicios" (una segunda clase reconstruida desde cero contra el mismo fichero `.db`, sin nada compartido en memoria), y el flujo completo `websc build` + `dist/server.js` real, confirmando que `node-sqlite3-wasm` viaja vendorizado sin ningún `npm install` del usuario.

### `.wsdb` v2 (`-> name:`) — implementación

Diseño y sintaxis en `DISEÑO.md`. Detalle de implementación:

- **Parser** (`parseWsdbFile`): detecta v2 por la presencia de `-> name:`; si no, parsea exactamente como antes (v1 intacto). Quita comentarios `//` fuera de comillas (`stripWsdbComments` — antes se quedaban pegados al valor: `min` valía `"10 // mínimo"`). Acepta `-> schema` con o sin `:` y campos con o sin `->` delante. `parseWsdbField`: `tipo(números)(modificadores)[/]`, modificadores `primary` y `array`; uno desconocido es error con línea.
- **`Tipo[]`** en `var`/`const`/`reactive` tipadas: alias de `Tipo(array)`, normalizado en el parser (`normalizeArrayType`).
- **`readWsdbV2`** (en `codegen-wsdb.js`): valida toda la declaración al cargar — claves desconocidas, nombre no identificador, `min > max`, `depends` que no sea array de strings (parseado con acorn, no con `eval`), tipos desconocidos, longitud en `boolean`/`object`/arrays, `decimal` sin sus dos números, cero o varias `(primary)`, primary no `integer`/`string`.
- **`buildWsdbV2`**: devuelve `{ Persona, PersonaSchema }`. Valores en un `WeakMap` (las instancias serializan limpias con `toJSON`). Consulta perezosa con un `Proxy` sobre un array que se rellena en el primer acceso (incluido `util.inspect`, para que `console.log` no enseñe `[]`).
- **`wsdb-query.js`** (nuevo, vendorizado y en `files` de `package.json`): `rewriteWhereCalls` (acorn) reescribe el argumento de `.where()`/`.deleteWhere()`; es idempotente y deja tal cual un texto que no sea JS completo. Se aplica en `genStatement` de `codegen-server.js` (envuelto sobre el antiguo, ahora `genStatementRaw`). `__wsq` llega a los `watch()` como una binding más y a las funciones compiladas por closure (`compileFunctionDecl` ya no usa un `new Function` que solo ve globales).
- **`lib/WSSchema.ws` y `lib/WSDB.ws`** (`templates/lib/`): interfaces fijas, plantillas normales de `websc init`/`update` (mismo `LIB_FILES`, mismo lock, nunca parseadas ni ejecutadas — igual que `WSON.ws`/`Visual.ws`). `<Nombre>Schema` "implementa" `WSSchema`; `<Nombre>` "implementa" `WSDB`. **Decisión, corrigiendo un diseño anterior de esta misma fase**: la primera versión generaba un fichero `lib/<Nombre>Schema.ws` por cada `.wsdb` v2 en cada `websc build` — redundante, ya que la API es idéntica para cualquier colección (solo cambian los nombres de campo, que ya se ven en `getSchema()` en tiempo de ejecución). Se sustituyó por estas dos interfaces genéricas, documentadas una sola vez. **Renombrado**: se llamó primero `Schema.ws`/`interface Schema`, y se renombró a `WSSchema.ws`/`interface WSSchema` a petición explícita — mismo criterio de nombres que `WSON`/`WSDB` (el prefijo `WS` distingue las interfaces propias del lenguaje de un `Schema` genérico que el usuario pudiera querer nombrar él mismo en su propio código).
- **`websc build`**: `validateWsdbFiles` (bin/websc.js) seguía necesario sin la generación — parsea y valida TODOS los `.wsdb` del proyecto (v1 y v2, incluida la resolución de `-> depends`) aunque ningún `.wsb` los importe todavía, para que un error de declaración salga en el build. No escribe nada en `lib/`.
- **`-> depends`: actualización en cascada real** (diseño completo en `DISEÑO.md`). `resolveDependsTargets` (nuevo, exportado de `codegen-wsdb.js`) localiza cada `.wsdb` nombrado junto al que declara `depends` (no junto al `.db`), exige que sea v2, y calcula los campos compartidos (mismo nombre + mismo tipo base). Sin ninguno, avisa una vez al cargar. `cascadeUpdate`, llamado desde `Main.save()` solo en la rama de **actualización** (nunca en inserción — no hay "antes"): compara el registro antes/después del `UPDATE` principal; si algún campo compartido cambió, busca en la colección dependiente por los valores ANTERIORES de todos los compartidos a la vez y les aplica los NUEVOS. Cualquier fallo (tabla inexistente, sin coincidencias...) se captura y se avisa por consola — nunca hace fallar el `save()` que lo disparó. No hay cascada en el borrado, ni encadenamiento entre dependencias (un nivel, no transitivo) — ver limitaciones en `DISEÑO.md`.

**Bugs encontrados y corregidos en el formato v1** (antes de empezar el v2):
- **Inyección SQL por clave de consulta**: solo los valores iban parametrizados; `Usuario.find({ "1=1 OR nombre": "x" })` devolvía todas las filas — y `find(req.query)` es un uso natural. Ahora las claves se validan contra `id` + campos del esquema.
- `find({ campo: null })` generaba `campo = NULL` (nunca coincide): ahora `IS NULL`; `{ ne: null }` → `IS NOT NULL`.
- `decimal` no estaba en la lista de primitivos del `.wsdb`: se guardaba como texto JSON y `gt`/`lt` comparaban cadenas (`"100" < "9.5"`). Ahora es columna `REAL`.
- `CREATE TABLE IF NOT EXISTS` no añadía columnas nuevas: un campo añadido al esquema rompía `save()` con "no such column". Resuelto en v2 (ver evolución de esquema en `DISEÑO.md`); v1 no se ha tocado en esto.

**Decisiones tomadas donde la especificación era ambigua**: `save()` es upsert (la especificación decía también "si existe ya ese valor en la primary, falla el insert"; se tomó la regla posterior, más explícita). `delete` se separa en `delete(registro)` y `deleteWhere(condición)` para no tener que reescribir cualquier `.delete(...)` (chocaría con `Map`/`Set`). `deleteWhere()` sin argumento es error; vaciar exige `deleteWhere(true)`.

**Decisiones tomadas al implementar `-> depends`** (especificación abierta a interpretación, confirmada con el usuario): cascada solo en `update` (no en `insert` — no hay estado previo con el que emparejar). Emparejamiento por TODOS los campos compartidos a la vez, en un único `WHERE` (no uno por uno) — significa que un campo con el mismo nombre pero significado distinto en dos colecciones (ver limitación en `DISEÑO.md`) puede impedir el emparejamiento por un campo que sí era el enlace real; se ha dejado así por ser la lectura más literal de "coincida con los valores de los campos compartidos", documentado como limitación conocida en vez de adivinar una regla más permisiva. No hay cascada transitiva (un solo nivel) ni cascada en el borrado — ninguna de las dos se pidió explícitamente.

**Pruebas**: `tests/codegen-wsdb-v2.test.js` (25 tras esta vuelta: cascada real con campos compartidos que sí y que no se propagan, colección dependiente sin campos compartidos, sin tabla todavía, sin coincidencia, `-> depends` a un fichero inexistente o v1, y el caso de coincidencia accidental de nombre documentado como limitación), un test HTTP real de `.wsdb` v2 en `codegen-server-wsb-import.test.js`, y en `websc-build-wsb-import.test.js` uno de `lib/WSSchema.ws`+`lib/WSDB.ws` como plantillas fijas y otro de `websc build` fallando con `-> depends` roto. Verificado además de extremo a extremo a mano: `websc init` + `websc update` + dos `.wsdb` v2 con `-> depends` real entre ellos + `.wsb` con las tres colecciones + `websc build` + `node dist/server.js`, con POST/GET reales por `curl` confirmando la cascada (dos registros con el mismo nombre antiguo se actualizan al nuevo; uno con nombre distinto no se toca) y persistencia tras reiniciar.

### `substituteServerState`: de expresión regular a un parser real (`acorn`)

Un nombre de reactive de servidor (p. ej. `persona`) que coincidiera con una palabra suelta dentro de un string o un template literal del propio `watch()` se corrompía: `"persona creada"` pasaba a `"serverState.persona creada"`, porque la sustitución se hacía con `\bpersona\b` sobre el texto crudo, sin ninguna noción de qué es código y qué es contenido de una cadena. Reescrito con `acorn`/`acorn-walk` (ya vendorizados para `wsdb-query.js`): ahora solo se tocan nodos `Identifier` de verdad, nunca el contenido de un `Literal`/`TemplateElement`.

Al reescribirlo con un parser real aparecieron dos bugs más, ninguno reportado antes, corregidos de paso:
- Una propiedad abreviada usada como VALOR (`{ persona }`, para construir un objeto) se dejaba sin sustituir por la regex antigua — la trataba como si fuera una clave — lo que habría producido un `ReferenceError: persona is not defined` en cuanto se ejecutara. Ahora se expande a `{ persona: serverState.persona }`.
- **El más grave, encontrado con una prueba HTTP real antes de darlo por bueno**: `acorn-walk` enruta el lado izquierdo de una asignación (`persona = valor`) a través de un tipo especial, `VariablePattern`, que por defecto se ignora sin visitor propio — así que en la primera versión de esta reescritura, la reasignación de una reactive (`persona = Persona.save(x)`, el mecanismo que dispara toda la cascada de `watch()`) se quedaba sin sustituir, dejando una referencia rota. Se añadió un visitor explícito para `VariablePattern` que solo actúa cuando el padre es una `AssignmentExpression` y el nodo es su `left` — cualquier otro `VariablePattern` (una declaración `var`/`const`, un parámetro de función, un `catch(e)`) es una variable local nueva, no una reactive, y se deja tal cual.

Se mantiene `substituteServerStateNaive` (la implementación con regex de siempre) como red de seguridad si el cuerpo del `watch()`, ya ensamblado, no llegara a ser JS completo por sí solo — no debería pasar nunca dado cómo lo construye `genHandlerBody`, pero fallar con una sustitución imperfecta es preferible a dejar una referencia sin cualificar en silencio.

**Limitación conocida, sin cambios respecto a la versión con regex** (no es una regresión de esta reescritura): no hay análisis de ámbitos. Si dentro de un `watch()` se declara `const persona = ...` o un parámetro con el mismo nombre que una reactive de servidor, las referencias POSTERIORES a esa variable local también se sustituyen por `serverState.persona` — la regex antigua tenía exactamente el mismo problema. No debería darse en el uso normal del lenguaje, donde una reactive se reasigna con `=`, nunca se redeclara dentro de su propio `watch()`.

**Pruebas**: `tests/codegen-server-substitute-state.test.js` (10 unitarios sobre `substituteServerState` en aislado, cubriendo el bug del string, la reasignación crítica, miembros, claves/valores de objeto — normal y abreviada—, multilínea, declaraciones/parámetros/catch homónimos, desestructuración, etiquetas, y el fallback), más una prueba de integración HTTP real que reproduce el escenario original letra por letra.

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
- Sin `:parámetros` en la ruta y sin usar `Visual.query()`, la página es **SSG** (HTML precalculado una vez, en el propio build) — si no, sigue con SSR dinámico real por petición. Ver la sección de SSR/SSG más abajo.

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

**Ya resuelto — ahora acepta varias páginas y varios `.wsb` de golpe**, sin montar un proyecto entero:
```bash
node serve-demo.js pagina1.wsf pagina2.wsf api1.wsb api2.wsb [puerto]
```
Cada `.wsf` se sirve en su propia ruta real (`routePatternFor`, extraída a `route-pattern.js` — compartida con `bin/websc.js`, mismo criterio que `websc build`: `Visual.route()` si lo declara, si no `/` + su nombre de fichero, incluidos `:params`). Con una sola página, se sirve también en `/` de regalo; con varias, cada una vive solo en su propia ruta — ninguna acapara la raíz. Todos los `.wsb` se combinan en un único handler, igual que ya hacía con uno solo. Un argumento que no sea `.wsf`, `.wsb`, ni un puerto numérico al final, da un error claro.
  - **Bug real al implementarlo**: el mensaje de arranque decía "Páginas" (plural) incluso con una sola página real — porque el alias de conveniencia en `/` añade una SEGUNDA entrada a la lista interna de páginas, y el plural se decidía mirando esa lista (ya con el alias) en vez del número real de ficheros `.wsf` pasados. Corregido.
  - Probado con dos páginas reales (una con `:params`), sirviendo cada una en su ruta; el caso mixto (dos páginas + un `.wsb`); y que ninguna se sirve en `/` cuando hay más de una.
  - **También acepta un directorio entero** (`node serve-demo.js src/ [puerto]`), con el mismo criterio de escaneo que `websc build` — no recursivo, y un `.wsb` importado explícitamente por otro del mismo directorio se excluye (para no duplicar sus rutas). La lógica de exclusión (antes solo en `bin/websc.js`) se extrajo a `discover-files.js` (`findWsfFiles`/`findWsbFiles`), compartida entre los dos — `bin/websc.js` también pasó a usarla, en vez de su copia local. Se puede mezclar un directorio con ficheros sueltos de fuera de él en la misma llamada. Probado apuntando a la propia carpeta `src/` del repo (cinco páginas, dos `.wsb`), con la exclusión de un `.wsb` importado por otro, y con la mezcla de directorio + fichero suelto.

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

## Repaso de los métodos de `WSON` — qué está implementado de verdad

Comprobado uno por uno (no solo "existe en el código", sino probado con llamadas reales):

| Método | Servidor (`.wsb`) | Cliente (`.wsf`) | Estado |
|---|---|---|---|
| `WSON.send(instancia)` | ✅ | ✅ | Real. Envío SALIENTE — lo usa quien invoca, en cualquier contexto (`.wsf`, `function`, dentro o fuera de un `watch()` de ruta). Servidor: `http.request` de Node contra `to`. Cliente: `fetch()` real contra `location.href`. `to` como array: envío paralelo con fallo aislado por destino (probado). Siempre devuelve un WSON (la respuesta), nunca `undefined` — probado también llamándolo desde dentro del `watch()` de una ruta, donde antes de esta vuelta se confundía con "responder la petición entrante" (ver sección de esta vuelta: `WSON.send()`/`WSON.httpSend()`). **Bug real encontrado y corregido** (en su momento): mandaba siempre un `body`, incluso con `via: "GET"` — en cliente esto hacía que `fetch()` lanzara `TypeError` directamente (GET/HEAD no pueden llevar body, lo prohíbe el propio estándar), así que `WSON.send()` con GET **no funcionaba en absoluto**; en servidor (que usa `http.request` de Node, no `fetch`) no reventaba, pero mandaba un body que muchos proxies/balanceadores reales descartan. Corregido en los dos lados: sin body en GET/HEAD, y el `content` se traduce automáticamente a **query string** (`?nombre=Ana&edad=30`) en vez de perderse — probado de extremo a extremo con cliente real (`fetch` de Node) y servidor a servidor, incluida la firma (`secret`) verificando correctamente al firmarse sobre lo que de verdad se manda. Un `:param` en la URL de destino (p. ej. `/usuarios/42`) no tiene mecanismo propio — se construye el string tal cual, funciona igual en cualquier método. |
| `WSON.enqueue(instancia, opts)` | ✅ | ❌ | Real — fire-and-forget con reintento y backoff exponencial, probado con un destino que falla dos veces y entrega a la tercera. **Nunca tuvo test hasta ahora.** No existe en el `WSON` de cliente. |
| `WSON.listen(wson)` | ✅ | N/A | No es una función real en ningún runtime — es un patrón que el **parser** detecta en la propia declaración (`reactive any x = WSON.listen(...)`) y el compilador traduce a registro de ruta real. Llamarlo en cualquier otro contexto no funcionaría (no hay tal función). |
| `WSON.showContent(inst, secreto)` | ✅ | ❌ | Real — descifra si `encrypt`, si no parsea el JSON tal cual. No existe en cliente (el cliente no declara `secret`/`encrypt`, están prohibidos ahí en compilación). |
| `WSON.verify(content, firma, secreto, marca)` | ✅ | ❌ | Real, `timingSafeEqual`, con ventana de validez de 5 min. |
| `WSON.parse(args, headers, secreto, encrypt)` | ✅ (redundante) | ❌ | **Bug real encontrado y corregido**: si había `secret` pero no `encrypt`, intentaba descifrar contenido que solo estaba firmado, y `content` salía `null` siempre. Corregido separando ambos flags. Sigue siendo **redundante en la práctica**: `WSON.listen()` ya hace este mismo trabajo automáticamente sobre cualquier petición entrante, sea o no "WSON de verdad" — no hace falta llamarlo a mano salvo que se quiera parsear algo fuera del flujo de `WSON.listen()`. |
| `WSON.getSignature/getTimestamp/getToken(headers)` | ✅ | ❌ | Reales, ya probados. |
| `WSON.showToken(token)` | ✅ | ❌ | Real — decodifica (no verifica) un JWT, ya probado. |
| `WSON.params(inst)` / `WSON.query(inst)` (renombrados a `WSON.httpParams`/`WSON.httpQuery` — ver sección de esta vuelta, al final de este fichero) | ✅ | N/A | Reales — leen `:params`/query string de la petición actual, dentro de `watch()`. Concepto solo de servidor. `null` si no hay params/query, o si la instancia no viene de una petición HTTP. |
| `WSON.httpSend(peticion, httpCode)` (nuevo — ver sección de esta vuelta) | ✅ | N/A | Real — responde la petición HTTP entrante dentro del `watch()` de una ruta. No devuelve nada. Sustituye al uso de `WSON.send()` para este rol (que antes ignoraba `to` en silencio — bug real, ver sección de esta vuelta). Concepto solo de servidor, solo dentro de una ruta. |

Ningún DTO expone `.send()` como método de instancia — se confirmó que sigue siendo estático (`WSON.send()`), tal como exige el diseño.

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
    ├── codegen-wsdb.js   — AST de un .wsdb -> dos clases reales sobre SQLite (<Nombre> + <Nombre>Schema)
    ├── wsdb-query.js     — condiciones de .where()/.deleteWhere(): reescritura en compilación + traducción a SQL
    ├── codegen-ssr.js    — AST de un visual -> HTML real en servidor (SSR por petición)
    ├── type-check.js     — comprobación de tipo primitivo compartida (DTOs y var/const/reactive tipadas)
    ├── resolve-imports.js — resolución de rutas de import (compartida cliente/servidor)
    ├── index.js          — API programática del paquete (require("websc"))
    ├── package.json      — listo para `npm publish` (nombre, bin, files, licencia; "redis" como optionalDependency)
    ├── README.md         — README del paquete npm (distinto de este fichero)
    ├── LICENSE           — MIT por defecto
    ├── templates/lib/     — plantillas de Visual.ws/WSON.ws vendorizadas DENTRO del paquete
    ├── runtime.js        — runtime reactivo de cliente (Proxy + effect), embebido en el bundle
    ├── wson-runtime.js   — runtime de WSON en servidor (HMAC, AES-256-GCM, envío HTTP real)
    ├── validate-js-body.js — análisis estático real (acorn/acorn-walk) de referencias no declaradas en watch()
    ├── node_modules/     — SOLO las dependencias reales del compilador (acorn, acorn-walk...), vendorizadas aquí junto al resto — un proyecto creado con `websc init` no necesita su propio `npm install` para que el compilador funcione
    ├── check-lib.js      — protege lib/: rechaza compilar si fue modificado
    ├── route-pattern.js  — routePatternFor(), compartida entre bin/websc.js y serve-demo.js
    ├── discover-files.js — findWsfFiles()/findWsbFiles() de un directorio, compartida entre los dos
    ├── bin/
    │   └── websc.js       — CLI real: `init`/`update`/`build`
    ├── cli.js             — utilidad de línea de comandos
    └── tests/             — suite de tests (node:test + jsdom)
```

## Publicar `websc` como paquete real de npm

`compiler/` ya está preparado como paquete instalable: `package.json` con nombre (`websc`), versión, `bin`, `files` (solo lo necesario — sin `tests/`, sin `node_modules/`), `templates/lib/` (vendorizado dentro del propio paquete, no en una carpeta hermana — así funciona igual instalado globalmente que dentro de este repo), `index.js` (API programática), `README.md` propio del paquete, y `LICENSE` (MIT por defecto — cámbiala si quieres otra).

**Lo que ya está probado de verdad, sin publicar nada**: `npm pack` (genera el `.tgz` real) → `npm install -g <tarball>` en un prefix aislado → el comando `websc` **real** (no `node bin/websc.js`) ejecutando `init`/`build` → `node dist/server.js` sirviendo página (con SSR) y API reales. Todo esto como tests permanentes (`tests/websc-package.test.js`).

**Lo que no puedo hacer desde aquí**: publicarlo de verdad al registro público, porque `npm publish` necesita tus credenciales de npm (`npm login`), que no tengo ni debería tener. Cuando quieras publicarlo tú:

```bash
cd compiler
npm view websc          # comprueba que el nombre sigue libre — no pude confirmarlo al 100%
npm login               # con tu cuenta de npm
npm publish
```

A partir de ahí, cualquiera podría hacer `npm install -g websc` de verdad. Si el nombre `websc` ya está cogido para cuando publiques, cambia `"name"` en `package.json` (el binario puede seguir llamándose `websc` aunque el paquete se llame distinto, ajustando el campo `"bin"`).

## Próximos pasos sugeridos

Con los backends de fichero (con bloqueo real) y Redis, quedan resueltos todos los huecos de la lista original de esa fase — incluido compartir sesiones entre réplicas en **máquinas distintas** (`"session-store": "redis"`). Lo único que sigue fuera de alcance ahí: Redlock de verdad (quorum entre varias instancias de Redis, para tolerar la caída de la instancia que tiene el lock) — la implementación actual usa una única instancia, suficiente para el caso normal pero no una garantía de consenso distribuido completa.

## `via: "socket"` — el transporte base (websocket-runtime.js), primera pieza de WSClient/online function

Implementación de WebSocket (RFC 6455) desde cero, sin dependencias — `crypto`+`net`+`tls` del propio Node. Es solo transporte: saludo (servidor aceptando un `upgrade` de `http.Server`, o cliente iniciando la conexión a mano sobre `net`/`tls`) y *framing* (codificar/decodificar mensajes en bytes). No sabe nada de `WSON`, de `online function`, de reconexión ni de idempotencia — eso son capas por encima, todavía sin construir (ver "Próximos pasos" al final de esta sección).

**Verificado, no solo escrito**: el cálculo de `Sec-WebSocket-Accept` coincide exactamente con el vector de prueba oficial de la RFC 6455 (§1.3). Cliente y servidor reales probados hablando entre sí — no una simulación —, incluidos los tres tamaños de longitud de la RFC (7 bits, 16 y 64 extendidos, con mensajes reales de hasta 70.000 bytes), mensajes fragmentados reensamblados, un frame partido entre dos paquetes TCP, `PING`/`PONG` automático, y que una petición HTTP normal convive sin problema con `upgrade` en el mismo `http.Server`.

**Dos bugs graves encontrados y corregidos al revisar el código ya "terminado" (con tests en verde), antes de construir nada encima**:

1. **Un frame mal formado tumbaba el proceso entero, no solo esa conexión.** `_handleFrame`/`_tryReadFrame` lanzaban una excepción síncrona (un `CONTINUATION` suelto sin mensaje fragmentado en curso, o una longitud de 64 bits fuera de rango) dentro del manejador del evento `"data"` del socket — sin nada que la capturase. Confirmado de verdad antes de arreglarlo: un cliente mandando ese frame paraba el servidor con un *stack trace* sin capturar y `exit code 1`, cerrando de paso cualquier otra conexión que el servidor tuviera abierta en ese momento — denegación de servicio real con un solo mensaje. Arreglado envolviendo todo `_onData` en un `try/catch` que nunca deja escapar nada: un frame malo cierra **esa** conexión (`_fail()`, que emite `"error"` — sin lanzar si nadie escucha, al revés que el `EventEmitter` nativo de Node — y hace `socket.destroy()`), nunca el proceso.
2. **Comprobar el tamaño del frame demasiado tarde permitía acumular el búfer sin límite.** La comprobación original miraba `frame.payload.length` una vez el frame ya había llegado entero — pero un atacante puede declarar una longitud enorme en la cabecera y mandar los bytes goteando muy despacio, haciendo crecer `this.buffer` indefinidamente mientras se espera el resto, que nunca termina de llegar. Corregido comprobando la longitud DECLARADA en cuanto se lee la cabecera (`_tryReadFrame`), antes de esperar ni un byte del payload — `maxFrameBytes`, configurable por instancia, 16 MB por defecto.

**Corrección menor de protocolo, de paso**: al recibir un `CLOSE`, el código original cortaba la conexión sin más; la RFC exige devolver un `CLOSE` propio antes de cerrar (si no se había mandado ya uno) — corregido, con test que lo confirma capturando el frame de respuesta a nivel de bytes.

**Pruebas**: `tests/websocket-runtime.test.js` (14 — incluye 3 de regresión específicas para los dos bugs de arriba, verificando explícitamente que el proceso sigue vivo y otras conexiones ajenas al ataque siguen respondiendo con normalidad).

**Sintaxis nueva en `parser.js`**: `online function nombre(params) [-> idempotent]` — extensión de la regla `FunctionDecl` existente (no una regla nueva), con `online`/`idempotent` como campos booleanos en el mismo nodo. Rechaza en el parser (no en tiempo de ejecución) `-> idempotent` en una función sin `online`, y cualquier modificador que no sea `idempotent`.

**Próximos pasos, en orden de dependencia**: `WSClient` (conexión saliente con reconexión) y el comando `websc client-generate` — el resto de esta lista ya está implementado, ver abajo. El diseño completo —por qué cada pieza es como es, las alternativas descartadas (AMQP real, un bróker propio embebido, réplica multi-*master*, descargar código ejecutable) y el porqué— está en `DISEÑO.md`, sección de mensajería.

### El registro de `online function` y el protocolo de llamada — implementados

`extractOnlineFunctions(ast, baseDir)` (`codegen-server.js`) recopila las `online function` propias del `.wsb` y las importadas de un `.ws` — mismo criterio que `WSON.listen()`: si no está importada, no se expone. Rechaza nombres duplicados al cargar (no en silencio). Reutiliza `compileFunctionDecl` tal cual, sin tocarlo.

`wireOnlineFunctionsRpc(server, onlineFunctions)` engancha el protocolo sobre el `via: "socket"` de `websocket-runtime.js`: mensajes JSON de texto, `{type:"reflect"}` → lista de funciones con su firma, `{type:"call", id, name, args, idempotencyKey?}` → `{type:"result"|"error", id, ...}`. El `id` lo pone quien llama y se devuelve tal cual, para poder tener varias llamadas en curso a la vez sobre la misma conexión. La caché de idempotencia es del servidor entero (un `Map`, en memoria — se pierde al reiniciar, limitación conocida, ver abajo), y aplica a **cualquier** llamada que incluya una `idempotencyKey`, sin mirar si la función se declaró `-> idempotent` — el modificador es la promesa hacia quien llama de que repetir es seguro, no una condición para que el mecanismo en sí funcione.

**Bug de integración real, encontrado al verificar con un proyecto compilado de verdad (no solo con tests unitarios)**: `websc build` genera `dist/server.js` con su propio `http.createServer(...)`, construido directamente en la plantilla de `bin/websc.js` — **sin pasar por `createServer()`** de `codegen-server.js`, que es donde vive el enganche de `online function`. Sin arreglar esto, cualquier proyecto real compilado se habría quedado sin la funcionalidad, aunque todos los tests unitarios (que sí usan `createServer()`) pasaran en verde. Corregido añadiendo la misma llamada a `wireOnlineFunctionsRpc()` en la plantilla generada.

**Limitación descubierta, no nueva de esta pieza**: `compileFunctionDecl` compila `function`/`online function` como una función síncrona (`new Function`, no `AsyncFunction`) — a diferencia de `watch()`, que sí es async. Un cuerpo con `await` directo falla al compilar ("await is only valid in async functions..."). Se puede rodear devolviendo una `Promise` construida a mano (`return new Promise(function(resolve){...})`) sin usar la palabra `await` — el despachador de `online function` ya espera (`await target.fn(...)`) lo que sea que devuelva, valor normal o `Promise`. No se ha tocado `compileFunctionDecl` para añadir soporte async general: haría a todas las funciones devolver una `Promise` sin que el código que las llama (en `watch()`, que no inserta `await` automático para llamadas a función arbitrarias, solo para operaciones concretas conocidas) lo espere — cambiaría en silencio el comportamiento de cualquier función existente que alguien use sin `await`. Fuera de alcance de esta pieza; anotado para revisar en el lenguaje en general.

**Pruebas de `online function`**: `tests/codegen-server-online-function.test.js` (9 — registro, colisión de nombres, reflect/call reales por WebSocket, función inexistente, función que lanza, idempotencia con conteo real de ejecuciones, conflicto por llamada concurrente con la misma clave, y que un `.wsb` sin `online function` no engancha ningún `upgrade`). Verificado además de extremo a extremo con un proyecto real: `websc init` + dos `online function` (una `-> idempotent`) + `websc build` + `node dist/server.js`, con un cliente WebSocket real haciendo `reflect`/`call` — incluida la prueba decisiva de idempotencia: la misma clave con argumentos DISTINTOS (`999` en vez de `100`) devuelve el resultado cacheado del primer intento (`100`), no el que saldría de calcular con `999`.

### `WSClient` — implementado

`wsclient-runtime.js`: conexión saliente persistente sobre `websocket-runtime.js`, con reconexión por *backoff* exponencial (mismo criterio que `WSON.enqueue()`) y el protocolo `reflect`/`call` de `online function`. Dos decisiones de diseño, verificadas con pruebas reales, no solo escritas:

- **Ni un plazo ni una conexión perdida certifican nada** (problema de los dos generales, ya discutido): una llamada YA MANDADA cuya conexión se cae a mitad se rechaza con un error explícito ("no se sabe si se llegó a ejecutar") — nunca se reintenta sola. Solo la CONEXIÓN se reconecta por su cuenta; las llamadas en curso, no. Probado cortando el socket de verdad a mitad de una llamada lenta.
- **Una llamada hecha antes de que la conexión esté lista espera en cola**, con su propio `timeoutMs` contando desde que se hizo la llamada (no desde que conecta) — así no hace falta que quien llama maneje un "todavía no" que probablemente se resuelve en milisegundos, pero tampoco espera para siempre si la conexión nunca llega. Bug encontrado y corregido al escribirlo: la primera versión de `_flushQueue()` no marcaba la llamada como "ya mandada" al sacarla de la cola, así que si la conexión volvía a caer justo después de conectar, esa llamada no se habría detectado como "en curso" — quedaba huérfana hasta agotar su propio plazo en vez de fallar con el mensaje correcto de conexión perdida.

**Trampa real al probar la reconexión, que casi da un falso positivo**: `server.close()` de Node NO cierra las conexiones ya establecidas — solo dispensable deja de aceptar nuevas. Una primera versión de la prueba de reconexión "mataba" el servidor con `server.close()` y levantaba otro en el mismo puerto, y el cliente seguía funcionando... porque la conexión socket original, nunca cerrada de verdad, seguía viva y hablando con el código de la instancia vieja, sin que hiciera falta ninguna reconexión real. Corregido probando la reconexión cortando el socket del propio cliente directamente (`client._ws.socket.destroy()`), que sí simula una caída real.

**Pruebas**: `tests/wsclient-runtime.test.js` (7 — cola antes de conectar, `reflect()`, idempotencia a través de `WSClient` con conteo real de ejecuciones, *timeout* sin colgarse, reconexión real tras cortar el socket, rechazo de una llamada en curso al caer la conexión, y `close()` limpiando lo pendiente).

**Pendiente**: el comando `websc client-generate` (genera `OtroServidor.ws` a partir de `reflect()`, una sola vez, nunca en caliente — ver decisiones en `DISEÑO.md`).

### `websc client-generate` — implementado

Conecta de verdad por WebSocket, pide la reflexión, y escribe un `.ws` real —no un `class`/`constructor` (el parser no soporta eso como código ejecutable, solo como prosa dentro de los `.ws` de `lib/`, que nunca se parsean)—, sino `export function <nombre>(...params, opts)` por cada `online function`, cada una llamando a `WSClient.create(url).llamar(...)`. Reescribe el fichero entero en cada ejecución (nunca lo parchea): una función que desaparece del servidor remoto desaparece también al regenerar, sin dejar huérfanos.

**Dos huecos reales del lenguaje, descubiertos al intentar que esto funcionara de verdad, no solo diseñado**:

1. **`compileFunctionDecl` no daba acceso a nada externo dentro de una función normal** — ni `WSON`, ni las declaraciones hermanas del mismo `.ws` (cada una se compila aislada, confirmado leyendo `resolveImports`: ni siquiera un `const` de nivel superior en el mismo fichero es visible desde una función de ese fichero). Sin esto, el código generado no podría ni siquiera nombrar `WSClient`. Arreglado inyectando `WSClient` por *closure*, igual que `__wsq` — sin tocar el resto de funciones del lenguaje ni la interfaz pública de `compileFunctionDecl`.
2. **`WSClient.create()` necesitaba memorizar conexiones por URL.** Como cada función generada llama a `create()` de forma independiente (no hay estado de módulo compartido entre ellas, por el punto anterior), sin memorizar cada llamada habría abierto su propia conexión nueva — desperdiciando la ventaja entera de una conexión persistente, y reiniciando el *backoff* de reconexión en cada uso. `create()` ahora es una fábrica con memoria (por URL); `WSClient.closeAll()` (nuevo, útil también para un apagado ordenado de un servidor real) cierra todas las memorizadas.

**Decisión de diseño corregida sobre la marcha**: la primera versión de `cmdClientGenerate` usaba `WSClient` (con su reintento perpetuo en segundo plano) para conectar — comportamiento correcto para un cliente que vive dentro de un servidor real, pero equivocado para una herramienta de un solo uso: un servidor sin ninguna `online function` (que por diseño no acepta la conexión WebSocket en absoluto, ver más abajo) hacía que el comando esperara 10 segundos completos antes de dar un "sin respuesta" genérico, en vez de fallar al instante con el motivo real. Corregido conectando directo con `websocket-runtime.connect()`, sin la lógica de reintento — un fallo de conexión se informa tal cual, al momento.

**Trampa real al escribir los tests, del mismo estilo que ya salió con `.close()` de un servidor HTTP**: `execFileSync` (usado para invocar el propio comando desde los tests) **bloquea por completo, de forma síncrona, el proceso que lo llama** mientras el hijo corre. La primera versión de los tests alojaba el servidor "remoto" en el MISMO proceso del test — en cuanto se llamaba a `execFileSync`, ese proceso (y su servidor) se congelaba del todo, incapaz de aceptar la conexión del hijo, así que el hijo se quedaba esperando para siempre (`ETIMEDOUT`). Nada que ver con un fallo del propio `client-generate` — confirmado además ejecutándolo a mano desde una terminal normal, donde sí funciona al instante. Corregido lanzando el servidor remoto como un proceso de verdad, aparte (`child_process.spawn`), con `child.unref()` para que un hijo todavía terminando de morir tras `kill()` no le impida terminar al proceso de test.

**Otra fuga real al cerrar la suite del fichero, no relacionada con lo anterior**: las funciones generadas, al llamarse en el propio test, abrían conexiones reales vía `WSClient.create()` que quedaban memorizadas en el *pool* del proceso — correcto en un servidor real de larga vida, pero dejaban sockets abiertos que impedían terminar limpio a un proceso de test de corta vida. Resuelto con el propio `WSClient.closeAll()` recién añadido, llamado explícitamente al final del test.

**Confirmado que un `.wsb` sin ninguna `online function` nunca acepta conexiones WebSocket** (no hay nada que `wireOnlineFunctionsRpc` enganche): intentar `client-generate` contra uno de esos servidores da un 404 de conexión, no un "no expone ninguna función" — ese segundo mensaje de error queda en el código como red de seguridad, pero no es alcanzable con el diseño actual.

**Pruebas**: `tests/websc-client-generate.test.js` (3 — generación real end-to-end con un tercer servidor consumiendo el fichero generado, regeneración completa sin huérfanos al cambiar el servidor remoto, y los tres errores claros). Verificado además a mano por línea de comandos, con tres procesos reales y separados (servidor que expone, `client-generate` generando contra él, y un tercer servidor consumiendo el fichero con `await` e `idempotencyKey`), con el resultado exacto esperado.

### Las `function` del servidor ahora comparten ámbito — antes no podían llamarse entre sí en absoluto

A raíz de construir `client-generate` (que necesitaba que las funciones generadas usaran `WSClient`), se pidió verificar algo más general: si una función puede llamar a otra fuera de un `watch()` — desde otra función, en un `if`/`for`, importada de otro fichero. La comprobación real (no solo lectura de código) encontró **tres fallos reales**, los tres con la misma causa de fondo:

**La causa**: `compileFunctionDecl` compilaba cada `function` con su propio `new Function()`, aislada por completo — sin ver ni a sus hermanas del mismo fichero, ni las declaraciones de nivel superior de un `.wsb`. El lado cliente nunca tuvo este problema porque, ahí, las `function` se concatenan como texto JS normal en un único script (confirmado leyendo `codegen-client.js` y ejecutando de verdad el *bundle* generado en un contexto `vm`, simulando un clic real).

**Los tres fallos encontrados**:
1. **Una función no podía llamar a otra en absoluto**, ni siquiera del mismo fichero — `ReferenceError` real, probado antes de arreglarlo.
2. **`for (item in lista)` como bucle imperativo (dentro de una función/`watch()`) no generaba ningún código** — `codegen-server.js` no tenía NINGÚN caso para el nodo `"For"` en `genStatementRaw` (a diferencia de `codegen-client.js`/`codegen-ssr.js`, que sí lo manejan, pero para un uso completamente distinto: renderizar listas en una plantilla `Visual`, no un bucle imperativo). Caía en el mensaje de "sentencia no reconocida", que genera un **comentario JS** — el cuerpo del bucle no se ejecutaba nunca, sin ninguna excepción ni aviso. El fallo más grave de los tres, por ser completamente silencioso.
3. **Una `function` normal (no `online`) declarada directamente en un `.wsb`, sin pasar por un `.ws` importado, no se procesaba en ningún sitio** — invisible del todo, como si no existiera, para cualquier `watch()` del mismo fichero.

**La corrección**: `compileFunctionBatch(fnNodes, extraBindings)` (nueva, sustituye la implementación de `compileFunctionDecl`, que ahora es un caso particular de un lote de una sola función) compila varias `function` A LA VEZ en un único `new Function()`, como texto JS concatenado — exactamente lo que ya hacía bien el lado cliente. `extraBindings` inyecta valores adicionales (imports ya resueltos, u otras funciones) como parámetros adicionales del lote, por *closure*.

Con esto:
- Al importar de un `.ws`, se compilan TODAS sus `function` juntas (se pidan o no por nombre) — una exportada puede llamar a un *helper* interno sin exportar, y dos exportadas se ven entre sí.
- Las `function` propias de un `.wsb` (antes invisibles) se compilan juntas, con los imports ya resueltos (`importBindings`) inyectados como `extraBindings` — así pueden llamar a algo importado, y se mezclan en `importBindings` para poder usarse desde cualquier `watch()` del fichero, exactamente igual que un import.
- Las `online function` (`extractOnlineFunctions`, reescrita) se compilan igual: las propias del `.wsb` en un lote con acceso a `importBindings` (imports + funciones propias no-`online` ya fusionadas); las importadas de un `.ws`, en un lote con TODAS las funciones de ese fichero (sean `online` o no) — una `online function` puede llamar a otra `online function`, a una función normal, o a algo importado, sin ninguna limitación distinta a una función corriente.

**Semántica de `for (item in lista)` fijada explícitamente** (para que coincida con lo que el lado cliente ya hacía): se compila a `for (const item of lista)` — valores del listado, nunca índices ni claves.

**Caso límite documentado, no resuelto de raíz**: si una `function` del propio `.wsb` tiene el mismo nombre que algo importado, la propia del `.wsb` GANA (el `Object.assign(importBindings, ...)` de las propias se aplica después de resolver los imports) — sin ningún error ni aviso de colisión. Es un comportamiento razonable (lo local prevalece sobre lo importado, como en la mayoría de lenguajes), pero no se ha añadido ninguna detección explícita de este caso; queda documentado con un test que fija el comportamiento real, no como el diseño ideal verificado a propósito.

**Pruebas**: `tests/codegen-server-function-scope.test.js` (6 — el bucle imperativo real, función llamando a otra del mismo fichero, función importada usando if/for con una hermana suya, función propia de un `.wsb` antes invisible ahora funcionando y llamando a algo importado, `online function` llamando a otra `online function` + una normal + una importada a la vez, y el caso límite de colisión de nombres documentado).

### `await` implícito, también en `function`/`online function`

Hasta ahora, "Async/await implícito" solo cubría `watch()` (`WSON.send()` y la cascada de reactives) — `compileFunctionBatch` compilaba `function`/`online function` de forma completamente síncrona, sin soporte de `await` en absoluto en su propio cuerpo. Esto se detectó de verdad al construir los ejemplos de `online function`/`WSClient`: escribir `await calcularImpuesto(...)` funcionaba solo porque el texto que no encaja con ninguna regla del lenguaje se copia casi tal cual (el mismo mecanismo de reserva de otros hallazgos de esta sesión) — no porque `await` fuera sintaxis reconocida.

**La corrección**: `compileFunctionBatch` ahora compila cada función como `async function` (antes: `function` a secas), y `injectAwaitForKnownCalls(bodyText, knownNames)` (nueva, con `acorn`/`acorn-walk`) envuelve con `await` cualquier llamada a un identificador SUELTO —nunca un método (`objeto.algo()`, eso sigue su propio camino: `WSON.send()`, cualquier `.wsdb`)— que esté en `knownNames`: las funciones hermanas del mismo lote, o algo en `extraBindings`/importado. Aplicado en dos sitios:
- Dentro de `compileFunctionBatch` (una función llamando a otra del mismo lote, o a algo inyectado).
- Dentro de `genHandlerBody` (un `watch()` llamando a cualquier import — incluida una función generada por `client-generate` que habla por `WSClient`), con `importNames` como `knownNames`.

Como **todas** las funciones son ahora async, esto es seguro de forma general: esperar (`await`) un valor que no es una promesa no hace nada malo, solo se resuelve en el siguiente tick — así que no hace falta saber de antemano cuáles de las funciones conocidas son "realmente" asíncronas.

**Verificado de extremo a extremo real, con dos servidores separados**: `peticion.content = cobrar(100, { idempotencyKey: "factura-1" })` —sin `await` en ningún sitio del código WebScript— llama de verdad por WebSocket a otro proceso y devuelve `{"importe":100,"total":121}`.

**Trampa real al depurar esto, dos veces**: el primer intento de reproducir el caso pareció colgarse — resultó ser, otra vez, `WSClient.create()` dejando una conexión viva en el *pool* que nadie cerraba (ver la sección de `client-generate` más arriba). El segundo intento dio un *timeout* real de 10 segundos en vez de colgarse — resultó ser un descuido mío al cambiar el puerto del servidor remoto en un fichero de la prueba pero no en el otro (`OtroServidor.ws` seguía apuntando al puerto viejo). Ninguno de los dos era un fallo del `await` implícito en sí — el propio `injectAwaitForKnownCalls` generó el texto correcto (`await cobrar(...)`) las dos veces, confirmado imprimiéndolo antes de seguir buscando.

**Pruebas**: `tests/codegen-server-implicit-await.test.js` (6 — el transformador aislado con llamadas sueltas/a método/anidadas/ya-*awaited*, una `online function` esperando sola el resultado de otra, una `function` normal esperando sola el resultado de una función importada que devuelve una promesa, y el caso real completo de dos servidores con `WSClient` de por medio).

### Revisión: ¿puede una `function`/`watch()` leer una variable o `reactive` de nivel superior?

Se pidió revisar esto explícitamente. Comprobado con código real, no solo lectura:

- **Un `reactive` de nivel superior SÍ se puede leer desde `watch()`** — ya funcionaba (`substituteServerState` lo convierte en `serverState.nombre`). Confirmado con `{"desdeWatch":5}`.
- **Un `var` de nivel superior (no `reactive`) NO se puede leer desde ningún sitio — ni siquiera desde `watch()`.** Confirmado: `{"error":"contadorGlobal is not defined"}`. No hay ningún mecanismo que lo registre como estado de sesión (`extractSessionStateDecls` solo recoge `reactive`) ni que lo sustituya en el texto compilado.
- **Ni un `reactive` ni un `var` de nivel superior se pueden leer desde una `function`/`online function`.** Confirmado con el mismo error. `compileFunctionBatch` no aplica `substituteServerState` a los cuerpos que compila, ni recibe `serverState` como parámetro.

**Por qué esto no se ha arreglado en la misma pasada, a diferencia de los otros hallazgos**: la razón no es solo "falta cablear una sustitución más" — `serverState` se crea DE NUEVO en cada petición, a partir de la sesión del visitante concreto que la hizo (`wrapReactiveState(session.state, ...)`), y se pasa como PARÁMETRO en el momento de invocar, no por *closure* fija en la compilación. Encajar esto en `function`/`online function` exigiría que cualquier llamador supiera pasar el `serverState` correcto en cada invocación — y para una `online function` invocada por un `WSClient` remoto, **no existe ninguna sesión HTTP de la que sacarlo**: la llamada llega por un WebSocket en bruto, sin cookie, sin petición HTTP de por medio. No es una limitación de implementación menor — es una pregunta de diseño real (¿tendría sentido un estado compartido entre sesiones para `online function`, distinto de `reactive`? ¿pasa a ser `var` un estado global de verdad, no por sesión?) que no se ha resuelto todavía, y no se ha intentado un arreglo apresurado para no tomar esa decisión por descuido.

### Estado global compartido para `function`/`online function` (no por sesión)

A petición explícita, tras confirmar que el razonamiento tenía sentido: *"al final es código ejecutándose en mi máquina cuando me llaman, la cual tiene contexto y las variables y reactives están cargadas"*. Un `reactive`/`var` de nivel superior es, para `watch()` de una petición HTTP, estado **por sesión** (una copia propia por visitante — diseño ya existente, sin cambios). Pero una `online function` no tiene ninguna sesión de la que partir: la llama otro servidor por un WebSocket en bruto, sin cookie, sin petición HTTP. Ahora, en vez de no ver nada (el hallazgo del turno anterior), las `function`/`online function` declaradas **directamente en el propio `.wsb`** ven una única instancia compartida de ese mismo estado — la misma para cualquiera que llame, viva mientras el proceso viva.

**Bug real que apareció al implementarlo, encontrado por la propia suite de tests (no a mano)**: la primera versión creaba esa instancia compartida de forma anticipada, al construir el `createRequestHandler` — igual que se haría de forma ingenua. Esto tiró un test que ya existía: *"una var de servidor con tipo mal declarado responde 500 SIN tirar el proceso"*. El motivo: para el estado **por sesión**, esa misma validación de tipo (`instantiateSessionState`) ya está pensada para dispararse de forma perezosa, en la primera petición real de cada sesión, dentro del mismo `try/catch` que atrapa cualquier error de una petición y lo convierte en un 500 — nunca al arrancar el servidor. Crear el estado global de forma anticipada movía esa misma validación a un punto sin ningún `try/catch` alrededor: un `reactive integer visitas = "no soy un entero"` tiraba el arranque entero del servidor, no solo esa función.

**Corregido con creación perezosa y memorizada**: `getGlobalState()` (una función, no un valor) construye la instancia compartida la PRIMERA vez que de verdad hace falta, y la memoriza para las siguientes — igual criterio que ya tenía el estado por sesión, aplicado aquí a una única instancia en vez de una por visitante. `substituteServerState` (la misma función de siempre) se parametrizó para aceptar un nombre de objeto destino distinto de `serverState` — aquí, literalmente el texto `"getGlobalState()"`, así que una referencia a `visitas` se convierte en `getGlobalState().visitas`, llamando a la función memorizada en el momento de usarse, no cerrando sobre un valor ya calculado al compilar.

**Alcance de esta pasada, limitación real, no un descuido**: solo ven este estado global las `function`/`online function` declaradas **directamente en el `.wsb`** — las importadas de un `.ws` aparte, no. El motivo es de orden de cálculo: qué declaraciones cuentan como "estado de sesión" de un `.wsb` (`extractSessionStateDecls`) depende de su AST ya expandido con las rutas que traigan consigo sus propios imports (`resolveImports`) — y `resolveImports` compila las funciones de un `.ws` importado ANTES de que ese cálculo pueda hacerse. Resolverlo del todo para funciones importadas exigiría reestructurar `resolveImports` para diferir su propia compilación de funciones a después de conocer el estado de sesión del `.wsb` que las importa — un cambio mayor, no abordado en esta pasada. *(Resuelto después: ver "Functions importadas de un `.ws` con acceso a `global` y protección", al final de este fichero.)*

**Pruebas**: `tests/codegen-server-global-state.test.js` (5 — persistencia real entre llamadas RPC, el mismo estado compartido entre una `function` normal y una `online function`, `var` además de `reactive`, la regresión de arranque ya corregida con su propio test específico, y que dos servidores distintos tienen cada uno su propia instancia, sin mezclarse). Verificado además a mano: tres llamadas RPC reales seguidas a `incrementar()` devuelven `1, 2, 3` — el estado persiste de verdad entre invocaciones separadas, no se reinicia en cada una.

### `online function` usada en local como una `function` normal — fallo real encontrado y corregido

A petición explícita de validarlo. Confirmado con código real, en dos pasos:

1. **Un `watch()` no podía llamar a una `online function` del mismo `.wsb`** — fallaba al **compilar**: `"calcularImpuesto" no está declarada ni importada, ni es un global conocido`. Las `online function` nunca se fusionaban en `importBindings` (el conjunto de nombres que ve un `watch()`) — solo existían dentro del array separado `onlineFunctions`, usado únicamente para el registro RPC.
2. Arreglado ese primer punto, **una `function` normal seguía sin poder llamar a una `online function`** — esta vez el fallo era en tiempo de EJECUCIÓN (`calcularImpuesto is not defined`), no al compilar, porque las `function` normales no pasan por la comprobación estática de referencias que sí tiene `watch()`. La causa: las `function` propias del `.wsb` se compilaban en un lote (`compileFunctionBatch`) **antes** de extraer las `online function` en otro lote aparte — así que ninguna de las dos podía ver a la otra, según el orden.

**La corrección**: las `function` y `online function` declaradas directamente en un mismo `.wsb` se compilan ahora **en un único lote conjunto** (`compileFunctionBatch(ownFunctionDecls, ...)`, sin distinguir `online` o no en ese momento) — así se ven entre sí sin importar el orden, exactamente igual que ya pasaba entre varias `function` normales. `extractOnlineFunctions` ya no compila nada por su cuenta para las propias del `.wsb`: solo selecciona, de ese mismo lote ya compilado, cuáles llevaban `online` para construir el registro RPC — evitando además compilarlas dos veces. El resultado completo (propias y las importadas de un `.ws`) se fusiona también en `importBindings`, así que **cualquier** `online function` —propia o importada— es utilizable en local exactamente igual que cualquier otra función, además de seguir disponible por RPC para otros servidores. `online` pasó a ser puramente aditivo, como tenía que ser desde el principio.

**Verificado con las tres direcciones a la vez, con código real**: un `watch()` llamando a una `online function`, una `function` normal llamándola, y esa misma `online function` llamando de vuelta a esa `function` normal — y, por separado, que seguía funcionando por RPC desde otro proceso sin ningún cambio.

**Pruebas**: `tests/codegen-server-online-local.test.js` (4 — `watch()` llamando en local, `function` normal llamando en local con ida y vuelta entre las dos, que el RPC sigue intacto, y que una `online function` importada de un `.ws` también es utilizable en local desde quien la importa).

### `global reactive`/`global var`/`global const` — nueva palabra clave, resuelve de raíz el problema de "sesión vs. compartido"

Tras varios turnos de discusión de diseño (ver `DISEÑO.md`), y a raíz de un **bug real descubierto durante la propia discusión** (no antes de empezarla): una `function`/`online function` que tocaba una reactive de nivel superior escribía en silencio en una copia GLOBAL compartida, completamente distinta de la copia por sesión que el `watch()` que la llamaba estaba leyendo — mismo nombre, dos almacenes distintos, sin ningún error. Ejemplo real que lo destapó: `incrementarContador()`, llamada desde `watch(peticion)` (con sesión), subía el contador GLOBAL; el `watch(peticion)` seguía leyendo el de SESIÓN, sin cambios. Confirmado con código antes de tocar nada.

**La decisión, explícitamente pedida así**: una `reactive`/`var`/`const` de nivel superior sigue siendo **por sesión por defecto**, exactamente como siempre — nada se rompe para quien no toque nada nuevo. `global` (nueva palabra clave, va ANTES de `reactive`/`var`/`const`: `global reactive integer x = 0`) marca una declaración como una única instancia compartida por todo el proceso, alcanzable desde cualquier sitio — `watch()`, `function`, `online function` — sin ningún "sabor" que mezclar, porque una reactive es de sesión O global, nunca las dos cosas para el mismo nombre.

**La regla de seguridad nueva, la pieza que arregla el bug de raíz**: una `function`/`online function` que referencia, como identificador suelto, una reactive/var/const de SESIÓN (sin `global`) da un **error claro al compilar** — nunca más un bug silencioso:
```
En function incrementarContador: "contador" es una reactive/var POR SESIÓN — una
function/online function no puede tocarla sin sesión. Decláralo con `global`
(p. ej. "global reactive ...") si quieres compartirla entre cualquiera que llame.
```
(`checkNoSessionOnlyReferences`, con `acorn`/`acorn-walk` — mismo estilo que el resto de análisis estático de esta sesión.)

**`watch()` de una `global reactive` — la pregunta original, ya resuelta**: se compilan reutilizando el MISMO mecanismo que cualquier `function`/`online function` (`compileFunctionBatch`, como una función sintética de cero argumentos) — así heredan gratis la prohibición de tocar sesión, el `await` implícito, y el disparo en cascada de OTROS `watch()` globales. Un `__triggerGlobal` (paralelo a `__trigger`, pero creado UNA VEZ por servidor, no por sesión, ya que el estado global no tiene sesión de la que depender) se inyecta tanto en `function`/`online function` como en cualquier `watch()` de sesión que también quiera tocar una `global reactive` con su propio `watch()`.

**Verificado de extremo a extremo, con números reales**:
- Un `watch(visitasTotales)` (global) saltó exactamente `3` veces tras tres llamadas RPC reales que reasignaban esa reactive — la pregunta que llevaba varios turnos abierta, cerrada con datos, no solo en teoría.
- El bug original (`incrementarContador` escribiendo en el sitio equivocado) ahora es un error de compilación claro, con la solución indicada en el propio mensaje.
- El riesgo de condición de carrera avisado durante el diseño (`saldoCompartido`: dos retiros concurrentes de 10 sobre 100 dan `90`/`90` en vez de `80`/`80`) **sigue existiendo para `global`**, tal como se advirtió — pero ahora es una elección explícita de quien escribe `global`, nunca una sorpresa en una reactive normal.

**`WSON.getSession(peticion)` (propuesta alternativa discutida) no se implementó** — la opción `global` explícita, con sesión como comportamiento por defecto sin cambios, resolvió el mismo problema sin necesitar invertir la relación por defecto entre reactive y sesión, ni añadir una API nueva sobre "la sesión" como concepto.

**Alcance de esta pasada, límite real, no un descuido**: al igual que con el estado global anterior a este rediseño, la comprobación de "no tocar sesión sin `global`" y el acceso a `global reactive` solo se aplican a `function`/`online function` declaradas DIRECTAMENTE en el `.wsb` — las importadas de un `.ws` aparte siguen sin esta protección ni este acceso (mismo problema de orden de cálculo ya documentado). *(Resuelto en la sección siguiente.)*

**Pruebas**: `tests/codegen-server-global-state.test.js` (8, reescrito con `global` explícito — persistencia real entre llamadas, `function` y `online function` compartiendo la misma `global reactive`, `global var`, la regresión de arranque perezoso, independencia entre servidores, el nuevo error claro de compilación tanto para lectura como para reasignación, y que una reactive de sesión normal sigue funcionando exactamente igual sin la palabra `global`).

### Functions importadas de un `.ws` con acceso a `global` y protección — límite anterior resuelto

**El problema, confirmado con código real antes de tocar nada** (con un `.ws` con `export online function incrementar()` que hace `visitasTotales = visitasTotales + 1`):
- **Sin acceso a `global`**: con `global reactive integer visitasTotales = 0` en el `.wsb` que la importa, la llamada RPC fallaba en tiempo de ejecución con `visitasTotales is not defined`.
- **Sin protección**: si esa misma reactive era de SESIÓN (sin `global`), compilaba sin ningún error — exactamente el tipo de fallo silencioso que `global` vino a eliminar, pero todavía abierto por la puerta de los `.ws`.
- **Un tercer fallo, encontrado leyendo el código y confirmado después**: `extractOnlineFunctions` volvía a compilar el `.ws` por su cuenta, así que la MISMA `online function` importada existía en **dos instancias distintas** — la de `importBindings` (llamadas en local) y otra aparte para RPC. Comprobado con `resolveImports(...).bindings.tick !== extractOnlineFunctions(...)[0].fn`.

**La causa, la ya documentada**: las `function` de un `.ws` se compilaban dentro de `resolveImports`, que es el PRIMER paso de `createRequestHandler` — antes de saber qué es `global` y qué es de sesión, porque ese cálculo depende del AST ya expandido con las rutas que traen los propios imports entre `.wsb`, que salen de ese mismo `resolveImports`.

**La corrección — aplazar, no reordenar**: `resolveImports` acepta ahora `{ deferWsFunctions: true }`. Con esa opción, las `function` de un `.ws` no se compilan ahí: se devuelven en `deferredWs` — un lote por fichero (sin repetir aunque el mismo `.ws` aparezca en varias líneas de `import`), con TODAS sus `function` (exportadas o no, para que sigan llamándose entre sí) y los nombres pedidos. El resto de imports (`.wson`, `.wsdb`, `.js`, npm, valores no-función de un `.ws`, rutas de `.wsb`) se resuelve igual que antes, al momento. La opción se propaga a la llamada recursiva de los imports de ruta entre `.wsb`, fusionando sus lotes aplazados — así un `.ws` importado por un `.wsb` cuya ruta importa otro `.wsb` también se beneficia.

`createRequestHandler` compila esos lotes justo después de construir `globalInfo` y **antes** que las `function` propias (para que estas puedan seguir llamándolas), con `compileFunctionBatch(fnDecls, {}, globalInfo, { origin })` — el mismo mecanismo exacto que las propias: acceso a `global` como identificador suelto, disparo del `watch()` de una global reasignada, `await` implícito, y `checkNoSessionOnlyReferences`. El resultado se guarda en `compiledWsFiles` (ruta → funciones) y se le pasa a `extractOnlineFunctions`, que ahora **reutiliza esa misma instancia** para el registro RPC en vez de recompilar — adiós a las dos instancias.

`compileFunctionBatch` tiene un cuarto parámetro opcional, `{ origin }`, que se añade a la etiqueta del error para que diga de dónde viene la función:
```
En function sumarUno (importada de "./contador.ws"): "visitasTotales" es una
reactive/var POR SESIÓN — una function/online function no puede tocarla sin
sesión. Decláralo con `global` (p. ej. "global reactive ...") si quieres
compartirla entre cualquiera que llame.
```

**Compatibilidad**: sin la opción, `resolveImports` sigue compilando al momento, sin estado (el comportamiento de siempre), y devuelve `deferredWs: []`. `extractOnlineFunctions` llamada sin `compiledWsFiles` también recompila como antes. Ningún test previo cambió.

**Semántica elegida (detalle y alternativas en `DISEÑO.md`)**: un identificador suelto de un `.ws` se resuelve contra el `global` del `.wsb` que lo IMPORTA — un `.ws` no tiene estado de servidor propio. Si dos `.wsb` distintos importan el mismo `.ws`, cada uno obtiene su propia instancia de esas funciones, enlazada a su propio estado (probado: un servidor con `visitasTotales = 0` y otro con `= 100` devuelven `1` y `101`).

**Verificado de extremo a extremo** (`npm pack` + `npm install -g`, `websc init`, `websc build`, `node dist/server.js` — ojo: escucha en el puerto de `wconfig.json`, 3000, no en `PORT`): un `.ws` con un helper interno sin exportar que incrementa una `global reactive` del `.wsb`, llamado por una `online function` exportada — tres llamadas RPC reales devuelven `1, 2, 3`, y el `watch()` de esa global se dispara exactamente `3` veces. `websc client-generate` contra ese servidor lista la `online function` importada. Con la reactive cambiada a sesión, `websc build` falla con código de salida 1 y el mensaje de arriba.

**Pruebas**: `tests/codegen-server-ws-import-global.test.js` (11). Los 10 de comportamiento se pasaron también contra el `codegen-server.js` anterior y fallaban los 10 (el 11, de compatibilidad de `resolveImports`, falla allí solo porque `deferredWs` no existía). Cubren: acceso a la global por RPC con persistencia, error al compilar con el fichero de origen en el mensaje, la protección y el acceso también en un helper NO exportado, disparo del `watch()` de una global, la misma instancia para local y RPC, un `watch()` de ruta HTTP escribiendo en la global a través de la función importada, el mismo `.ws` en dos servidores con estados distintos, un `.ws` importado desde dos líneas de `import`, el caso anidado `.wsb` → `.wsb` → `.ws`, y la compatibilidad de `resolveImports` sin aplazar. Suite completa: **446/446** (435 + 11).

**Dos huecos vecinos, encontrados al probar esto, que YA existían antes (verificados contra el código anterior) — no abordados aquí**:
1. **Una `function` importada de otro `.wsb`** (no de un `.ws`) sigue compilándose sola (`compileFunctionDecl`), sin acceso a `global` ni protección: un `.wsb` que importa `sumar` de otro `.wsb`, que toca `misVisitas` (de sesión en el que importa), compila sin error. No es el mismo caso que un `.ws`: esa función viene de un fichero que SÍ puede tener estado de servidor propio, así que "resolver contra el importador" no es obviamente lo correcto — es una pregunta de diseño abierta, no solo de cableado.
2. *(Resuelto en la sección "Los imports de un `.ws`", al final de este fichero.)* **Un `.ws` que a su vez importa algo no lo ve en el servidor**: `usa.ws` con `import { doble } from "./util.ws"` y una función que llama a `doble(...)` falla en ejecución con `doble is not defined`. El lote de un `.ws` se compila sin `extraBindings` — sus propios `import` nunca se resuelven del lado servidor.

### `WSON.httpParams`/`WSON.httpQuery` (antes `WSON.params`/`WSON.query`) y `WSON.httpSend` (antes `WSON.send` como respuesta) — separar responder de invocar

**Motivo, confirmado con un bug real antes de tocar nada, no solo una cuestión de nombres**: `WSON.send` significaba dos cosas según el contexto. Fuera del `watch()` de una ruta (o en cualquier `watch()` de una `reactive` normal), `WSON.send(instancia)` es la llamada saliente de siempre: manda de verdad a `instancia.to`. Pero DENTRO del `watch()` de una ruta (`WSON.listen()`), la implementación de `send` ignoraba `to` por completo y respondía la petición ENTRANTE con el `content`/`httpCode` de lo que se le pasara — sin comprobar si esa instancia tenía un `to` propio hacia otro sistema.

Reproducido contra el código anterior a esta vuelta: un `watch()` de ruta que hacía `WSON.send({ to: "http://otro-sistema/", via: "POST", content: { ping: 1 } })` con intención real de notificar a un tercer sistema **nunca llegaba a su destino** — un servidor externo real con un contador de peticiones recibidas seguía en `0` tras la llamada, mientras el cliente que llamó a la ruta recibía `200 {"ping":1}` como si esa llamada hubiera sido la respuesta. Sin ningún error, sin ningún aviso — el mismo tipo de fallo silencioso que ya motivó el diseño de `global` en una vuelta anterior, esta vez en la API de WSON.

**La corrección — dos nombres para los dos roles, no una detección de intención**:
- **`WSON.send(wson)`**: SIEMPRE la llamada saliente, la usa quien invoca, en cualquier contexto — dentro o fuera de un `watch()` de ruta. Dentro de una ruta, ya no hay ningún `send` local que la sobreescriba: hereda directamente la implementación real de `wson-runtime.js` vía el `...WSON` con el que se construye `localWSON`. Siempre devuelve un WSON (la respuesta de la llamada), nunca `undefined`.
- **`WSON.httpSend(peticion, httpCode)`**: responde la petición HTTP entrante — solo existe dentro de `localWSON` (el `watch()` de una ruta), no en la API base de `WSON`. No devuelve nada. `httpCode` es ahora un argumento explícito (200 por defecto) en vez de una propiedad mutable — el campo `httpCode` desaparece por completo de los WSON (de las dos clases DTO, `codegen-dto.js`, y del objeto `peticion` en `codegen-server.js`).
- **`WSON.httpParams(inst)`/`WSON.httpQuery(inst)`** (antes `WSON.params`/`WSON.query`, sin el prefijo): ahora funciones genéricas en `wson-runtime.js` (llegan a `localWSON` gratis vía `...WSON`, no hace falta redefinirlas por petición), que leen `_params`/`_query` de cualquier instancia. Devuelven **`null`**, no `{}`, tanto si la petición no trae params/query como si la instancia ni siquiera viene de una petición HTTP (algo recibido por una `online function`, un WSON construido a mano para `send()`) — antes ese segundo caso ni se contemplaba, porque `params`/`query` solo existían dentro de `localWSON`, ligadas a una petición real.

`injectSendAwait` (el mecanismo de "async/await implícito" que envuelve `WSON.send(...)` con `await` en cualquier posición del cuerpo) ahora envuelve igual `WSON.httpSend(...)` — ambas son llamadas que hay que esperar de verdad antes de seguir (relevante sobre todo para `httpSend`, que guarda la sesión en `sessionStore` — Redis incluido — antes de escribir la respuesta).

**Verificado de extremo a extremo**: el mismo `watch()` de ruta que antes perdía la llamada saliente, tras el cambio, responde al cliente CON el código pasado (`202`) Y notifica de verdad al servidor externo (contador pasa de `0` a `1`) — las dos cosas conviven sin pisarse.

**Pruebas**: `tests/codegen-server-wson-http-rename.test.js` (9 tests nuevos) — el primero reproduce el bug contra el comportamiento anterior y confirma la corrección; el resto cubren `httpSend` con/sin código explícito, que `httpSend` no devuelve nada (confirmado pasando su resultado por una `global var` y leyéndolo desde otra ruta: `undefined`), que `WSON.send()` saliente sí devuelve algo incluso llamado desde dentro de una ruta, `httpQuery`/`httpParams` con y sin datos (`null` en ambos casos vacíos), `httpParams`/`httpQuery` llamados directamente sobre un objeto sin `_params`/`_query` (`null`, no una excepción), y que `WSON.showContent` sigue intacto en una ruta que ahora usa `httpSend`. Se actualizaron además todos los fixtures existentes (`tests/*.js`) y el proyecto de ejemplo real (`src/api.wsb`, `src/demo-servidor.wsb`) que usaban los nombres antiguos. Suite completa: **455/455** (446 + 9).

**Ficheros de referencia actualizados**: `templates/lib/WSON.ws` y `lib/WSON.ws` (mantenidos idénticos) documentan ahora `httpSend`, `httpParams`/`httpQuery` con la semántica de `null`, y `send` como "siempre devuelve un WSON". Sin campo `httpCode` en la lista de campos del comentario de cabecera.

### Auditoría: toda query de WSDB debe devolver instancias reales del DTO — v2 no lo hacía, y guardar un `select()` parcial podía corromper datos en silencio

**Encargo**: comprobar que toda consulta construida sobre WSDB devuelve un array de instancias del DTO (la clase real, `<Nombre>`), no objetos JSON planos.

**Auditoría, método por método**:
- **v1** (`buildWsdbClass`, formato `-> collection:`): `find`/`findOne`/`findById` ya envuelven cada fila con `rowToInstance` (`Object.create(Collection.prototype)`) — correcto desde siempre, sin cambios.
- **v2** (`buildWsdbV2`, formato `-> name:`): dos puntos SÍ devolvían JSON plano en vez del DTO:
  1. `makeQuery`'s `run()` (usado por `selectAll()` y `select()`) envolvía cada fila con `rowToJson` — un objeto plano, nunca una instancia de `Main`.
  2. `static save(item)` devolvía `rowToJson(row)` — también plano, a diferencia de `.save()` en v1, que devuelve `this` (una instancia real).

**Un matiz importante, encontrado al plantear el arreglo, no una ocurrencia**: `select(...campos)` es una proyección PARCIAL (menos columnas que el esquema completo). Envolver también SUS resultados como instancias completas de `Main` habría sido peligroso: una instancia a la que le faltan campos, pasada a `save()`, sobrescribiría en la base de datos justo esos campos ausentes. Se confirmó el riesgo con código real ANTES de decidir el diseño: con un campo declarado opcional (`edad: integer(5)/`), un `select()` que no pedía `edad` seguido de un `save()` de ese resultado ponía `edad` a `NULL` en la fila real — sin ningún error ni aviso. Esto ya era un bug real del código existente (independiente de cualquier cambio de esta vuelta), solo visible al plantear la pregunta de "¿debería `select()` devolver también el DTO?".

**La corrección, con esa distinción en el centro**:
- `selectAll()` (SELECT completo) → instancias reales de `Main`, mediante una nueva `rowToInstance` (v2) que hace `Object.create(Main.prototype)` y mete el JSON directamente en el `WeakMap` de valores — sin pasar por el constructor, que revalidaría con `checkValueV2` algo que ya viene de la propia base de datos (mismo criterio que `rowToInstance` en v1: validado una vez, al guardar, no hace falta repetirlo en cada lectura).
- `static save(item)` → devuelve `rowToInstance(row)` en vez de `rowToJson(row)` — ahora se puede encadenar el resultado de un `save()` directamente a otro `save()` posterior, o usar sus getters/setters, igual que en v1.
- `select(...campos)` (proyección parcial) → sigue devolviendo JSON plano, pero ahora marcado con un símbolo no enumerable (`PARCIAL`, invisible a `JSON.stringify`/`Object.entries`, solo comprobable por el propio código de `save()`). `static save()` comprueba esa marca ANTES de nada y, si está presente, rechaza con un error claro: *"este registro viene de select() (una proyección parcial) — guardarlo así pisaría con NULL cualquier campo que no se seleccionó"* — en vez de dejar que `new Main(item)` lo acepte en silencio cuando los campos ausentes son opcionales (que es exactamente como se coló el bug).
- `static delete(item)` no necesitó el mismo rechazo: borrar solo necesita la clave primaria, así que un registro parcial de `select()` que SÍ la incluya se puede borrar sin ningún riesgo — se dejó tal cual, con un comentario explicando por qué es un caso distinto de `save()`.

**Verificado de extremo a extremo** (`websc build` + servidor real): un `.wsb` con `Personas.save(...)` y `Personas.selectAll()` confirma `instanceof Personas: true` en las dos rutas HTTP reales, no solo en tests unitarios.

**Pruebas**: `tests/codegen-wsdb-dto-instances.test.js` (7 tests nuevos) — cubren v1 (ya correcto, de control), `selectAll()`/`save()` devolviendo instancias reales en v2, que una instancia de `selectAll()` se puede volver a guardar directamente, el bug de corrupción reproducido contra el código anterior a esta corrección y confirmado arreglado (el dato original sigue intacto tras el intento de guardar el parcial), que `select()` sigue devolviendo JSON plano para el uso normal de lectura, y que `delete()` funciona igual con una instancia completa o un parcial que incluya la primary. Además, se actualizaron dos tests existentes en `tests/codegen-wsdb-v2.test.js` que comprobaban expresamente el comportamiento viejo (`assert.deepEqual` contra un objeto plano) — ahora comprueban `instanceof` y comparan vía `JSON.parse(JSON.stringify(...))`. Suite completa: **462/462** (455 + 7).

**Ficheros de referencia actualizados**: `templates/lib/WSDB.ws` documenta ahora que `save()`/`selectAll()` devuelven instancias reales, y que `select()` devuelve JSON plano a propósito (con el porqué), rechazado explícitamente por `save()`.

### `.after(fn)` en `save()`/`delete()` — hook fire-and-forget, con un bug real encontrado en el camino (no en el propio `.after()`)

**Encargo**: `.after(nombreDeFuncion)` encadenado al final de `save()` o `delete()`, que reciba una `function`/`online function` y ejecute lógica tras la operación.

**El primer diseño no valía para los dos casos por igual, y se comprobó con código real antes de implementarlo**: `save()` siempre devuelve una instancia real (un objeto), así que `.after(fn)` se cuelga de ella sin ningún coste. `delete()`/`deleteWhere()`/`deleteMany()` devuelven un número primitivo — y hacerlos encadenables habría exigido envolver ese número en un objeto, lo que rompe la comprobación `if (Persona.deleteWhere(cond))` para siempre (todo objeto es `truthy` en JS, sin importar su valor real): `!!(new Number(0))` da `true`, confirmado antes de descartar esa vía. La solución: `.after(fn)` como MÉTODO encadenado solo en `save()`; `after` como PARÁMETRO opcional en `delete(item, after)`/`deleteWhere(cond, after)`/`deleteMany(query, after)` (v1) — mismo comportamiento fire-and-forget, sintaxis distinta a propósito, porque el tipo de retorno de cada uno lo exige.

**Implementación**:
- `invokeAfterHook(fn, valor, contexto)`: helper compartido — llama a `fn(valor)`, y si lanza o devuelve una promesa que rechaza, avisa por consola (`console.warn`) sin propagar el error. Un hook roto nunca deshace ni bloquea una operación que ya se completó — mismo criterio que la cascada de `-> depends` (avisa, no falla) y que `WSON.enqueue()` (fire-and-forget por diseño).
- v2: `Main.prototype.after = function(fn) { invokeAfterHook(...); return this; }`, definido una sola vez al construir la clase (no por instancia) — cualquier instancia real (de `save()` o de `selectAll()`) puede usarlo. `static delete(item, after)`/`static deleteWhere(cond, after)` llaman al hook DESPUÉS del `COMMIT` de la transacción, nunca dentro — si el hook falla, la transacción ya está cerrada y no hay nada que revertir.
- v1: `Collection.prototype.after` igual; `delete()` (instancia) ahora hace `return this;` (antes no devolvía nada — nada dependía de ese valor, así que no es un cambio observable) para poder encadenar `.after()`; `static deleteMany(query, after)` con el mismo parámetro opcional.

**Bug real encontrado al construir esto, no relacionado con `.after()` en sí**: `rewriteWhereCalls()` (la función que traduce `s.campo == valor` a SQL real dentro de `.where()`/`.deleteWhere()`) tenía un guard interno que exigía **exactamente un argumento** para disparar la reescritura. Al añadir `after` como segundo argumento de `deleteWhere(cond, after)`, ese guard dejaba de activarse — la condición se colaba tal cual, evaluada como JS normal contra un `FieldRef` (nunca un valor real), siempre `false`, así que `Persona.deleteWhere(condición, after)` no borraba nunca nada, en ningún caso, sin ningún error. Confirmado reproduciendo el fallo contra el código anterior a la corrección: `n2` daba `0` en vez de `1`. Corregido en `wsdb-query.js`: el guard ahora acepta uno O dos argumentos específicamente para `deleteWhere` (nunca para `.where()`, que no tiene segundo parámetro), reescribiendo solo el argumento en la posición 0 y dejando el segundo (el hook) intacto.

**Verificado de extremo a extremo** (`websc build` + servidor real): `Personas.save({...}).after(notificarOnlineFunction)` — una `online function` real, no una `function` normal — se ejecuta tras el `POST`, y `Personas.delete({id}, (n) => {...})` recibe el número de filas borradas en una ruta `DELETE` real.

**Pruebas**: `tests/codegen-wsdb-after-hook.test.js` (11 tests) — cubren `.after()` en v2 (llama con la instancia, encadenado `.after(a).after(b)`, no bloquea con un hook async — online function simulada —, un hook que lanza o rechaza no deshace el `save()`), `delete`/`deleteWhere` en v2 con el parámetro `after` (tipo de retorno sigue siendo `number`, `0` sigue siendo `falsy` de verdad), `.after()` en v1 (tanto en `.save()` como en `.delete()`, que ahora devuelve `this`), `deleteMany(query, after)` en v1, y dos tests específicos para el bug de `rewriteWhereCalls` (uno unitario sobre la función de reescritura, otro de extremo a extremo confirmando que `deleteWhere(condición, after)` sí borra de verdad). Todos se pasaron también contra el código anterior a esta corrección y fallaban donde debían. Suite completa: **473/473** (462 + 11).

**Ficheros de referencia actualizados**: `templates/lib/WSDB.ws` documenta `.after(fn)`, y explica en `delete()`/`deleteWhere()` por qué ahí es un parámetro y no un método encadenado.

### Eliminación de WSDB v1 (`-> collection:`) — un solo formato de `.wsdb`

**Encargo**: eliminar el formato v1, ya que el v2 (`-> name:`) lo cubre por completo.

**Qué se quitó**:
- `codegen-wsdb.js`: `buildWsdbClass` entero (la clase `Collection` con `find`/`findOne`/`findById`/`deleteMany`/`count`, `save()`/`delete()` de instancia y su `after()`), más `buildWhere` y `OPERATORS` (el traductor de objetos de consulta `{ campo: { gt: 18 } }` a `WHERE`), que solo usaba v1. Se quedan los helpers compartidos (`getConnection`, `sqlColumnType`, `toColumnValue`/`fromColumnValue`, `invokeAfterHook`). Exports: ya no salen `buildWsdbClass` ni `buildWhere`.
- `parser.js` (`parseWsdbFile`): ya no hay "detección de v2": el `.wsdb` tiene que declarar `-> name:`. El AST pierde el campo `version: 2` (era la única versión que quedaba, y ya no hay nada que distinguir).
- `codegen-server.js` (`resolveImports`): la rama `else` que llamaba a `buildWsdbClass` desaparece; un `.wsdb` siempre se importa con las dos clases de `-> name:`.
- `bin/websc.js` (`validateWsdbFiles`): quita el `if (ast.version !== 2) continue;` — antes un v1 se saltaba en silencio; ahora falla.
- `resolveDependsTargets`: quita la comprobación "es del formato antiguo" (la hace ya el parser).

**Cómo falla un `.wsdb` antiguo, en cada punto de entrada** (todos con el mismo mensaje de migración, más el contexto de dónde ocurrió):
- Parser: *"este .wsdb usa el formato antiguo ("-> collection:"), que ya no se admite — usa el formato actual: "-> name: 'nombre'" y "-> schema:" ..."*, nombrando lo que ya no existe (`find/findOne/findById/deleteMany`) y por qué cosas se sustituye (`save/selectAll/select/delete/deleteWhere`). Sin `-> name:` ni `-> collection:`, otro error más corto: el nombre es obligatorio.
- Import desde un `.wsb`: prefijado con la ruta del import (`"./viejo.wsdb": este .wsdb usa...`).
- `websc build`: código de salida 1, prefijado con el fichero (`src/viejo.wsdb: ...`). Antes un v1 pasaba esta validación sin más.
- `-> depends` a un `.wsdb` antiguo: `personas.wsdb: "-> depends" nombra "coches", pero "coches.wsdb" no es válido: ...`.

**Bugs/incoherencias encontrados al hacerlo** (no eran de v1 en sí, sino restos que apuntaban a él):
- El error que lanza `save()` al recibir un resultado parcial de `select()` decía *"...vuelve a leerlo completo con `findOne()`/lo que corresponda"* — `findOne` es un método de v1 que en v2 **no existe**, así que el mensaje mandaba al usuario a llamar a algo inexistente. Ahora dice `selectAll()`.
- Comprobando la tabla de migración de `DISEÑO.md` contra código real, dos frases que yo había escrito eran **falsas** y se corrigieron antes de entregar: (1) que la longitud fuera obligatoria en v2 — `string`/`integer`/`decimal` sin longitud se aceptan, y los campos sin `->` también —; (2) que el formato antiguo "no distinguía lecturas parciales de completas" — v1 no tenía lecturas parciales en absoluto.

**Tests**: se borra `tests/codegen-wsdb.test.js` entero (10 tests, todos de `buildWsdbClass`/`buildWhere`). Se quitan los tests v1 de `codegen-wsdb-after-hook.test.js` (2) y `codegen-wsdb-dto-instances.test.js` (1). Se **migran a v2** los que probaban integración real con un `.wsdb` (`codegen-server-wsb-import.test.js` ×2, `websc-build-wsb-import.test.js` ×1, `codegen-client.test.js` ×1, `parser.test.js` ×1, `codegen-wsdb-v2.test.js`: el de `-> depends` y el "decimal como columna numérica / `== null` como `IS NULL`", que cubría en v1 algo que en v2 seguía sin probarse). Se **añaden** 4 tests de rechazo (parser con `-> collection:` con el mensaje completo, parser sin `-> name:`, import desde un `.wsb`, y `websc build` con exit 1 y el fichero nombrado); el de `-> depends` contra un `.wsdb` antiguo no es nuevo, es el existente adaptado al nuevo error con contexto. Cuenta real: 473 − 13 (10 del fichero borrado + 3 v1 de los mixtos) + 4 nuevos = **464/464**, también contando los migrados 1 a 1.

**Verificado de extremo a extremo** (`npm pack` + instalación global + `websc init`/`build` + `node dist/server.js`): un `.wsdb` con `-> name:` responde por HTTP (`POST` → 201 con `save()` devolviendo una instancia real, `GET` con `selectAll().where(s.edad > 18)` devuelve solo lo esperado); y el mismo proyecto con un `.wsdb` de `-> collection:` añadido hace fallar `websc build` con `src/viejo.wsdb: este .wsdb usa el formato antiguo...`.

**Nombres internos que se dejaron**: `buildWsdbV2`, `readWsdbV2`, `checkValueV2`, `sqlColumnDefV2`, `TIPOS_V2` y el fichero `tests/codegen-wsdb-v2.test.js` conservan el sufijo `V2` — un resto histórico ya sin "V1" con el que confundirlo. Renombrarlos toca decenas de sitios (y esta misma documentación histórica) sin cambiar comportamiento; se deja como limpieza opcional.

### Los imports de un `.ws` se resuelven en servidor (`.ws` → `.ws`, `.js`, npm, `.wson`, `.wsdb`, constantes)

**Encargo**: "un `.ws` que importa otro `.ws` falla en servidor".

**El fallo era más amplio de lo anotado, y se comprobó antes de tocar nada**: no fallaba solo `.ws` → `.ws`. Reproducido con cinco escenarios contra el código anterior, los cinco rotos: `.ws` → `.ws` en el mismo directorio (`doble is not defined`), cadena de dos niveles en una subcarpeta (`suma is not defined`), `.ws` → `.js` (`triple is not defined`), `.ws` → `.wson` (`Persona is not defined`), y una constante exportada que usa un import (ni siquiera compilaba). Una sola causa: los `import` de un `.ws` **nunca se resolvían**. `resolveImports` procesaba solo los del `.wsb` raíz, y el lote de function de cada `.ws` se compilaba con `compileFunctionBatch(fnDecls, {}, globalInfo)` — el `{}` eran sus `extraBindings`, siempre vacíos.

**Diseño** (alternativas descartadas y motivos en `DISEÑO.md`, sección "Los imports de un `.ws`"):
- Cada `.ws` tiene un **ámbito de imports privado** (`entry.scope`), resuelto contra SU carpeta.
- Las function entre `.ws` se llaman con **enlace tardío** (`lateBoundWsFunction`): un reenviador que busca el lote ya compilado en `registry.compiled` al llamar. Sin orden topológico, y con ciclos permitidos.
- Un **registro** (`createWsRegistry`) por llamada a `resolveImports` más externa, compartido con las recursivas, guarda un `entry` por `.ws` alcanzable — un `.ws` es un único lote por servidor, aunque lo importen varios (diamante) y aunque lo pida un `.ws` antes que el `.wsb`.

**Cambios**: en `codegen-server.js`, `createWsRegistry`/`getWsEntry`/`compileWsRegistry`/`lateBoundWsFunction`/`wsScopeValues`/`evaluateWsConst` nuevos; `resolveImports` gana las opciones internas `wsRegistry`/`wsScopeOwner` (la recursión de rutas entre `.wsb` comparte el registro, y su bloque de fusión de `deferredWs` desaparece por innecesario); `createRequestHandler` compila el registro entero con `globalInfo` en vez de un bucle sobre `deferredWs`. `resolveImports` sin `deferWsFunctions` (uso directo) también resuelve los imports anidados, compilando al final de la llamada más externa. `resolveImports` devuelve ahora además `wsRegistry`; `deferredWs` se conserva (vacío si no se aplazó, como antes).

**Comportamientos que se decidieron con código real, no por intuición** (cada uno tiene su test):
- **Un ciclo `a` ↔ `b` funciona** (recursión mutua par/impar: `esPar(10)` → `true`). El primer diseño en la cabeza, con referencias directas y orden topológico, habría tenido que prohibirlo.
- **Un diamante comparte instancia**: dos caminos hasta el mismo `.ws` ven el mismo `global` (un contador da 3 y 6 con una instancia; con dos daría 3 y 3).
- **Privacidad**: lo que un `.ws` importa no se filtra al `.wsb` (`marca is not defined` si el `.wsb` la usa sin importarla), y dos ámbitos con el mismo nombre local para cosas distintas no se pisan (`10` frente a `500`).
- **La protección de sesión alcanza a los anidados**, con el error nombrando la cadena: `function toca (importada de "./sesion.ws", a su vez importada por "usasesion.ws")`. La etiqueta de un import directo no cambia.
- **Una `online function` anidada que el `.wsb` no importa por nombre no se expone por RPC** (pero otra del mismo grafo sí puede llamarla).
- **La base de datos de un `.wsdb` importado desde un `.ws` en una subcarpeta cae en la raíz del proyecto**: para eso la ruta ya no usa `dbBaseDir || baseDir` (con `baseDir` = la carpeta del `.ws` anidado habría creado `lib/.wsdb-data`), sino `dbBaseDir || registry.rootBaseDir`. Efecto secundario deliberado: la recursión de rutas entre `.wsb` también queda consistente cuando `dbBaseDir` no se informa (solo ocurre en llamadas directas/tests; `createRequestHandler` siempre lo informa).
- **Un `.ws` no puede importar un `.wsb`** (error explícito): un `.ws` lo usa también el cliente, un `.wsb` es solo de servidor. Antes esa línea se ignoraba en silencio.
- **Una constante en una importación circular da un error que explica la causa** en vez de un `ReferenceError` engañoso (el ámbito estaría a medias).
- **Los errores de un import roto en un `.ws` anidado nombran ese `.ws`** (`mal1.ws: "noExiste" no está exportado en ...`). Lo vi al probar: con un `.wsb` raíz es obvio qué fichero tiene el import roto; con uno anidado, no.

**Verificado de extremo a extremo** (`npm pack` + instalación global + `websc init`/`build` + `node dist/server.js`): un `.wsb` con una ruta `GET /perimetro/:a/:b` que llama a `perimetro()` de `lib/geometria.ws`, que a su vez importa `doble` de `lib/util.ws` — `/perimetro/3/4` → `14`, `/perimetro/10/1` → `22`, con un contador `global` que sube `1`, `2` entre peticiones. Y `websc client-generate` contra ese servidor descubre `areaDoble`, la `online function` de `geometria.ws` cuyo cuerpo depende del import anidado.

**Pruebas**: `tests/codegen-server-ws-nested-imports.test.js` (21 tests nuevos). Los 21 se pasaron también contra el `codegen-server.js` anterior y fallaban los 21. Suite completa: **485/485** (464 + 21).

**Huecos vecinos que se encontraron y NO se abordaron** (comprobados con código, no supuestos):
1. **[RESUELTO en la entrada siguiente]** **El cliente (`.wsf`) tiene el mismo fallo.** `generateClientBundle` copia el nodo de la function que un `.wsf` pide de un `.ws`, pero no lo que ese `.ws` importa: con `usa-cliente.ws` (que importa `doble` de `util.ws`), el bundle define `cuadrupleC` pero no `doble` — `ReferenceError` en el navegador. La solución de servidor no vale tal cual: el bundle es un único texto plano, sin ámbitos ni `require()`, así que habría que decidir cómo se aplanan los `.ws` transitivos (¿con qué renombrado si dos usan el mismo nombre local para cosas distintas?).
2. **[RESUELTO en una entrada posterior]** **Una `function` exportada por un `.wsb` tampoco resuelve los imports de su `.wsb` de origen**: `otro.wsb` importa `doble` de `util.ws` y exporta `usaDoble`; un `.wsb` raíz que importa `usaDoble` y la llama da `doble is not defined`. Se compila sola con `compileFunctionDecl`. Es el mismo "hueco vecino 1" de la sección anterior (que ya no tenía `global` ni protección), con un motivo más. Y la frase de `DISEÑO.md` que decía lo contrario ("resuelto contra su propia carpeta si a su vez importa algo") era falsa para este caso — corregida.
3. **[RESUELTO en una entrada posterior]** **Una constante de un `.ws` no puede referirse a otra constante del mismo `.ws`** (`export const B = A + 1` → `A is not defined`): el ámbito de una constante son los imports de su fichero, no sus hermanas. No lo introduce este cambio (ya era así), pero ahora que hay un ámbito por `.ws` sería una extensión natural.

### Los imports de un `.ws` se resuelven en el cliente (bundle de cliente y SSR)

**Encargo**: "abórdalo" — el hueco vecino 1 de la entrada anterior: el bundle de cliente copiaba la function pedida de un `.ws` pero no lo que ese `.ws` importa.

**El fallo era más amplio, y se midió antes de tocar nada.** Se reprodujo ejecutando el bundle en JSDOM (no comparando texto), con seis escenarios, **los seis rotos**: helper interno del mismo `.ws` (`interno is not defined`), dos líneas de `import` del mismo `.ws` (`dos is not defined`), `.ws` → `.ws`, `.ws` → `.js`, `.ws` → `.wson`, y una `const` de un `.ws` que usa un import. Y en SSR (`renderPageToHTML`) los mismos, más un control que no esperaba: **ni siquiera una `const` de un `.ws` sin anidar** (`{SALUDO}`) funcionaba. Hay cuatro causas distintas, no una:
1. Solo se emitían las function *pedidas por nombre*: los helpers del mismo `.ws` se quedaban fuera.
2. Los imports propios de un `.ws` no se seguían nunca.
3. `visited` saltaba entero cualquier segundo `import` del mismo fichero, perdiendo los nombres de la segunda línea. Comprobado que afecta también a `.js`, `.json` y `.wson` (`y is not defined`, `q is not defined`, `B is not defined`).
4. `export const` y `export reactive` de un `.ws` **nunca llegaban al cliente** (el filtro por tipo no atravesaba el nodo `Export`; el estado inicial del bundle salía vacío). Esto lo descubrí porque el escenario de la `const` seguía fallando después de arreglar los imports.

**La decisión que más pesó, comprobada con código antes de diseñar**: seguir *todos* los imports de un `.ws` (lo obvio, y lo que ya se hace con un `.wsf`) rompería un patrón que **hoy funciona**: un `.ws` mixto, con una function que usa un `.wsdb` (solo de servidor) y otra apta para el navegador, del que el `.wsf` importa solo la segura. Se verificó que hoy da `<x>`. Por eso el trabajo es **dirigido por demanda**: pedir una function trae esa function y lo que ella referencia (análisis de identificadores con `acorn`, sobrestimando a propósito); un import que nada de lo pedido alcanza no se toca. Alternativas descartadas y motivos en `DISEÑO.md`, sección "Los imports de un `.ws` en el cliente".

**Cambios**:
- `codegen-client.js`: `collectImportedPieces` reescrito sobre un estado compartido (`createCollectState`) con `processImport` (por tipo de fichero y por nombre), `loadClientWs` (parseo único + `export` desenvuelto), `requestWsFunction`/`demandFromWs`/`collectWsFileLevel` (la demanda), `referencedNames` (acorn, con escaneo por palabra si no parsea) y `claimName` (colisiones). Exporta `extractBoundNames`.
- `codegen-ssr.js`: `compileFunctionForSSR` ahora recibe un ámbito compartido (objeto sin prototipo, resolución tardía con `with`), `evalTopLevelDecl`, `evalEmbeddedSources` (módulos `.js` y clases `.wson`, tal como viajan al navegador) y `poisonedValue`. `renderPageToHTML` evalúa lo importado en ese ámbito.
- `bin/websc.js`: `resolveTopLevelValue` evalúa cada declaración por separado (ver más abajo por qué).

**Decisiones que se tomaron con código real**:
- **Colisión de nombres = error explícito, solo si interviene un `.ws`**: `"fmt" lo declaran a la vez lib1.ws y lib2.ws: el bundle de cliente es un único ámbito compartido...`. Comprobado antes que dos `const` iguales daban `Identifier 'LIMITE' has already been declared` sin decir dónde. Entre dos `.wsf` no se comprobaba y no se cambia (podría romper proyectos que hoy "funcionan"). El mismo `.ws` por dos caminos no es colisión (una sola definición, verificado contando `function marca` en el bundle).
- **Un nombre solo como propiedad (`o.interno`) no arrastra al helper** (test con el helper y comprobación de que no se emite).
- **SSR tolerante**: SSR ignoraba todo lo importado, así que hay proyectos que renderizan porque nunca lo evaluaban. Una `const` que lee `window` o un `.js` que toca `document` no rompe un render que no lo usa; si la plantilla lo toca, `"ANCHO" no se pudo calcular al renderizar en el servidor (SSR): window is not defined`. El primer mensaje salía anidado y nombraba `__jsmod_0` (un id interno que nadie escribió); ahora conserva solo la causa original.
- **Efecto secundario bueno**: las function *propias* del `.wsf` también pueden llamarse entre sí en SSR (antes cada una veía solo `state`).

**Bugs encontrados en el camino**:
- **Ids `__jsmod_N` duplicados** (bug previo, comprobado contra el código anterior): un componente que importa un `.js` y la raíz que importa otro rompían el bundle entero (`Identifier '__jsmod_0' has already been declared`). El id salía de la longitud de cada resultado parcial; ahora es un contador del recorrido.
- **Una regresión mía, que solo apareció con `websc build` real.** La primera versión pasaba todos los tests y el E2E de SSR, pero `websc build` fallaba con `__jsmod_0 is not defined` en un proyecto que compilaba antes: página con `Visual.staticPaths`, cuyo `.ws` importa un `.js`, con la function usada solo en un `onclick`. Causa: `resolveTopLevelValue` evaluaba todos los `topLevelInits` importados en un único script y no conocía los módulos `.js` embebidos; al seguir los imports de un `.ws` aparecía una `const` ligada a un módulo que ese script no define. Se reescribió para evaluar cada declaración por separado y exigir solo la que liga la variable pedida (lo que su propio comentario decía hacer: "hasta llegar a ella"). La comparación contra el código anterior tuvo un tropiezo que conviene dejar dicho: `websc build` carga el compilador **de su propio paquete global**, no de la copia vendorizada en el proyecto, así que mi primer intento de "probar con el código anterior" cambiando la copia del proyecto no probó nada (ambas ejecuciones usaron el código nuevo). Se rehízo cambiando los ficheros del paquete global.
- **Un test mío que no demostraba lo que decía.** El test de build "una const que no se puede evaluar (usa `window`) no tumba `staticPaths`" pasaba también con el código anterior: usé `export const`, y el código anterior nunca traía las constantes exportadas, así que jamás se evaluaba. Se cambió a una `const` sin `export` y se comprobó que ahora falla antes y pasa después.

**Pruebas**: 41 nuevos. `codegen-client-ws-imports.test.js` (22, ejecutando el bundle en JSDOM), `codegen-ssr-ws-imports.test.js` (14) y `websc-build-ws-imports.test.js` (5, con `websc init`/`build` reales y, el último, `dist/server.js` en marcha). Todos se pasaron contra el código anterior: **fallan 18 de 22, 11 de 14 y 3 de 5**. Los que pasan en ambos son a propósito guardas de no-regresión (el `.ws` mixto, no emitir lo no pedido, la propiedad que no arrastra, la colisión no necesaria, SSR tolerante, el build con la function solo en un `onclick`, el error de una variable de `staticPaths` que no se traga): su función es fallar si alguien lo implementa de forma ingenua, no demostrar el bug. Y uno de simple cobertura de SSR (una `const` propia que usa una function importada directa) que ya funcionaba. Suite completa: **526/526** (485 + 41).

**Verificado de extremo a extremo** (`npm pack` + instalación global + `websc init`/`build` + `node dist/server.js`): `blog.wsf` (con `Visual.staticPaths`) → `lib.ws` → `util.ws` (un helper, y una `export const FACTOR = triple(2)` ligada a un `.js`) más una clase `.wson`. El HTML estático de `/blog/uno` sale `uno:606`; una combinación no listada (`nueva-no-listada`) se sirve por SSR dinámico con el `acorn` vendorizado del proyecto; y cargando esa página servida en JSDOM (hidratación incluida) y pulsando el botón, el `<p>` pasa a `clic:606` sin errores.

**Huecos vecinos que se encontraron y NO se abordaron** (comprobados con código, no supuestos):
1. **[RESUELTO en la entrada siguiente]** **La hidratación falla si una interpolación se renderiza vacía.** `reactive resultado = ""` con `<p>{resultado}</p>`: SSR emite `<p></p>` sin nodo de texto y la hidratación espera uno → `Cannot read properties of null (reading 'nextSibling')`, y el clic no hace nada. Reproducido con el código anterior en una página **sin ningún `.ws`**, así que no es de este cambio. Es probablemente el hallazgo más importante de esta sesión por lo común del patrón (`reactive x = ""`); con un valor inicial no vacío todo funciona.
2. **[RESUELTO en la entrada siguiente]** **Una `reactive` cuyo valor inicial usa una `const` falla al cargar** (`Cannot access 'LIMITE' before initialization`): el estado se crea antes que las constantes. También previo (comprobado con una `const` del propio `.wsf`, sin imports). Con imports de por medio, igual.
3. **[RESUELTO en la entrada siguiente]** **Dos `.wsf` (componentes) con una function del mismo nombre siguen pisándose sin aviso** (la comprobación de colisiones se limitó a los casos donde interviene un `.ws`).
4. Los dos huecos del lado servidor de la entrada anterior siguen abiertos: una `function` exportada por un `.wsb` no resuelve los imports de su `.wsb` de origen, y una constante de un `.ws` no puede referirse a otra del mismo `.ws`.


### La hidratación falla si una interpolación renderiza vacía — hueco vecino de la entrada anterior, resuelto

**Encargo**: "continuar" — seguí con el hueco vecino 1 de la entrada anterior por mi propia cuenta (era el más común y el propio usuario lo confirmó con "si").

**Reproducido antes de tocar nada**: `reactive resultado = ""` con `<p>{resultado}</p>`. SSR renderiza `<p></p>` (un string vacío insertado en HTML no produce ningún nodo — ni siquiera un nodo de texto vacío). La hidratación, que consume incondicionalmente un nodo por cada interpolación (avanza con `nextSibling`), topaba con `null` y lanzaba `Cannot read properties of null (reading 'nextSibling')`; el clic que debía rellenar ese `<p>` no hacía nada. Confirmado en una página **sin ningún `.ws`**: no es un caso raro, es el patrón `reactive x = ""` a secas, con o sin SSR real (probado con JSDOM ejecutando el bundle, no solo comparando texto).

**Diseño** (alternativas descartadas en `DISEÑO.md`, sección "La hidratación de una interpolación que renderiza vacía"): mismo patrón que `if`/`for` ya usaban para el mismo problema de fondo (contenido que puede desaparecer entero). SSR envuelve todo texto DINÁMICO (con `{expr}`) en marcadores de comentario `<!--t-->...<!--/t-->`; la hidratación busca el nodo de texto entre los dos marcadores y, si no está, lo crea ahí mismo antes de seguir. El texto ESTÁTICO no lleva marcadores (su contenido no cambia tras el primer render).

**Cambios**: en `codegen-ssr.js`, `renderGroupSSR` envuelve el resultado de `renderTextSSR` en los marcadores cuando el texto tiene interpolación. En `codegen-client.js`, `genHydrateText` reescrito: para texto dinámico, consume el marcador de apertura, busca (o crea) el nodo de texto, consume el de cierre, y engancha el `effect()` sobre ese nodo — para texto estático, sigue igual que antes (solo avanza el cursor).

**Verificado con ejecución real en JSDOM** (no solo comparación de texto): interpolación vacía con y sin SSR, no vacía, mixta (literal + expr vacío — el conjunto no es vacío pero lleva el marcador igual, por construcción), dos interpolaciones vacías seguidas en el mismo padre (cada una encuentra su propio par de marcadores, no se confunden), y más de un cambio tras la hidratación (no solo el primer clic). Y de extremo a extremo: `npm pack` + instalación global + `websc build` + `node dist/server.js` + JSDOM cargando el HTML servido de verdad — el clic rellena `<p>` con el texto real, sin errores.

**Efecto secundario esperado, no un descuido**: el HTML que produce `renderPageToHTML` cambia para CUALQUIER texto con interpolación, no solo el caso vacío — es inevitable, porque el marcador se decide al compilar la plantilla, no por render (SSR no puede avisar a la función de hidratación, ya compilada, de si esta vez decidió omitirlo). Esto rompió **33 tests existentes** que comparaban el HTML de SSR como string exacto o con una regex que no contemplaba los marcadores — ninguno por una razón real, todos por el cambio de formato. Se corrigieron uno a uno: `codegen-ssr.test.js`, `codegen-router-reactive.test.js`, `type-checking-integration.test.js` (cadenas esperadas actualizadas), `codegen-ssr-ws-imports.test.js` (su extractor de contenido ahora descarta los marcadores antes de comparar), `serve-demo.test.js` y los cinco ficheros `websc-build-*`/`websc-package.test.js` (regex con `(?:<!--t-->)?...(?:<!--\/t-->)?` alrededor del contenido esperado).

**Un tropiezo propio en el camino, que conviene dejar dicho**: al corregir esas regex en un primer intento con un script, escribí el escape del marcador de cierre con doble backslash (`<!--\\/t-->` en vez de `<!--\/t-->`), lo que produjo un `SyntaxError: Invalid regular expression flags` en cinco ficheros de test a la vez. Se detectó al re-ejecutarlos (fallaban el fichero entero, no un test suelto) y se corrigió sustituyendo la secuencia mal escapada. Segunda pasada: se me quedaron sueltas varias ocurrencias con nombres de combinación distintos al primer ejemplo de cada test (`otro-post`, `post-y`, `Persona 99`, `dos:6`, `nueva-no-listada:6`) porque busqué el patrón por su primer valor y no grepeé todas las variantes del mismo `<h1>`/`<p>` en el fichero; se completaron al re-ejecutar y ver qué seguía fallando.

**Pruebas**: `tests/codegen-hydration-empty-text.test.js` (7 nuevos). Contra el código anterior fallan 4 de 7 (vacía con SSR, mixta, dos vacías seguidas, más de un cambio); los otros 3 son guardas de no-regresión (valor no vacío, sin SSR, texto estático) que ya funcionaban. Suite completa: **533/533** (526 + 7).

**Huecos que siguen abiertos** (sin tocar en esta entrada): una `reactive` cuyo valor inicial usa una `const` (`Cannot access ... before initialization`), dos `.wsf` con una function del mismo nombre, y los dos huecos del servidor (function exportada por un `.wsb`, constantes hermanas de un mismo `.ws`).


### Una `reactive` cuyo valor inicial usa una `const` — hueco vecino de dos entradas atrás, resuelto

**Encargo**: "el primer punto" — el primero de los huecos abiertos que quedaron al cerrar la entrada anterior (hidratación con interpolación vacía).

**Reproducido antes de tocar nada, en cliente y en SSR por separado, porque la causa resultó ser DISTINTA en cada uno**:
- **Cliente**: `reactive integer c = LIMITE` con `const LIMITE = 10` daba `Cannot access 'LIMITE' before initialization`. Causa: el bundle emite `const state = createStore({ c: LIMITE })` ANTES de `const LIMITE = 10` — TODA const/var de nivel superior se emitía después de `state`, sin excepción (hacía falta para las que sí leen una reactive vía `state.NOMBRE`). Es una TDZ real de JS. Comprobado que una `reactive` que llama a una `function` NO tenía este problema (`function` se eleva por *hoisting*, invocable desde antes de su posición textual) — así que el hueco era específico de `const`/`var`.
- **SSR**: mucho peor de lo documentado. El valor inicial de una reactive se evaluaba con `new Function('return (' + expr + ')')()`, con CERO ámbito — ni las `function` existían todavía en ese punto. Fallaba con cualquier cosa que no fuera un literal, `LIMITE is not defined` o `doble is not defined` según el caso, sin relación con el orden del código fuente.

**Diseño** (alternativas descartadas en `DISEÑO.md`, sección "Una `reactive` cuyo valor inicial usa una `const`"): las const/var de nivel superior que NO leen ninguna reactive, ni directa ni transitivamente, se adelantan antes de crear `state`/calcular los valores iniciales — mismo criterio en cliente y SSR. El reparto es un punto fijo: una const que referencia por nombre a otra ya marcada "necesita estado" se marca igual, hasta que no cambia nada (cubre cadenas `const B = A + 1` con `A` dependiente de una reactive).

**Cambios**: en `codegen-client.js`, dentro de `generateClientBundle`, `plainTopLevelDecls` se reparte en `preStateDecls`/`postStateDecls`; las primeras se emiten antes de `const state = ...`, las segundas después (como siempre). En `codegen-ssr.js`, `renderPageToHTML` se reordenó por completo: el objeto `state` se crea vacío primero (las function cierran sobre esa referencia, sin problema, porque leen `state.NOMBRE` al LLAMARSE, no al registrarse), se arma el `scope` compartido (módulos `.js`, clases, function), se evalúan las const PRE-estado en ese scope, LUEGO se calcula el valor de cada reactive (ahora con `with(__ssrScope)` sobre el scope ya armado, en vez de `new Function` aislado), y por último las const POST-estado — la tolerancia (importada = no tumba el render; propia = sí propaga) se conserva por procedencia, no por el grupo pre/post.

**Bug real encontrado al implementar (no al reportar), y por qué casi se me escapa**: la primera versión de la clasificación solo miraba si la expresión MENCIONA por nombre una reactive. `const resultado = conBase(1)` no menciona ninguna reactive por nombre — menciona `conBase`, una function — así que se adelantaba igual que las demás. Pero `conBase(x) { return x + base }` lee `base` (una reactive, sustituida a `state.base` al compilar) POR DENTRO; adelantar `resultado` antes de que `state.base` existiera daba `NaN` en vez de `11`. Lo detectó un test propio que ya tenía escrito antes de dar el cambio por terminado (`una const PROPIA del .wsf puede usar una function importada`, de la entrada de los imports de cliente), que empezó a fallar al correr la suite completa. Corregido tratando CUALQUIER llamada a una function de WebScript (propia o importada de un `.ws`) como si necesitara `state` — conservador a propósito, no hay forma de saber si el cuerpo de esa function lee una reactive sin analizarlo. Una llamada a un módulo `.js` embebido o a una clase `.wson` no cuenta (nunca tienen acceso a `state`): verificado que `const TRIPLE_DE_DOS = triple(2)` (de un `.js`, a través de un `.ws`) sí se adelanta con normalidad y una reactive puede usarla.

**Verificado con ejecución real** (JSDOM para cliente, `renderPageToHTML` para SSR): const declarada antes en el código fuente, const declarada DESPUÉS (el orden textual no debería importar y no importa), function llamada desde SSR, una const que sigue leyendo una reactive vía `state` (no regresión), una cadena de tres consts (`A -> B -> reactive`), la cadena que pasa por una llamada a function (`resultado -> derivado`, el bug encontrado), y una const de un `.js` importado a través de un `.ws`. Y de extremo a extremo: `npm pack` + instalación global + `websc build` + `node dist/server.js`, dos veces — una con una const literal, otra con una const que llega de un `.js` a través de un `.ws` — ambas con el HTML estático y el servido mostrando el valor correcto, e hidratando y reaccionando bien al clic.

**Pruebas**: `tests/codegen-reactive-init-const.test.js` (8 nuevos). Contra el código anterior fallan 6 de 8 (los 2 que pasan son guardas de no-regresión que ya funcionaban: la const que lee una reactive, y la llamada-a-function-lee-reactive que ya se había corregido al ajustar `callsRiskyFunction`). Suite completa: **541/541** (533 + 8).

**Huecos que siguen abiertos**: dos `.wsf` con una function del mismo nombre siguen pisándose sin aviso; los dos huecos del servidor de entradas anteriores (function exportada por un `.wsb`, constantes hermanas de un mismo `.ws`).


### Dos `.wsf` con una function del mismo nombre — hueco vecino de tres entradas atrás, resuelto

**Encargo**: "Dos .wsf con una función del mismo nombre siguen pisándose sin aviso / esto" — el tercero de los huecos que quedaron al cerrar la entrada de la hidratación con interpolación vacía.

**Reproducido antes de tocar nada**: `<CompA/>` y `<CompB/>`, cada uno con su propia `function fmt` interna (sin relación entre ellas), importados ambos desde la raíz. Confirmado con ejecución real que el SEGUNDO import siempre gana, PARA LOS DOS COMPONENTES: `CompA` acababa mostrando el `fmt` de `CompB`. En el bundle de cliente el motivo es que `function fmt` se emite dos veces al mismo nivel (JS dejar que la segunda declaración gane, sin error); en SSR es el mismo pisado pero por otro mecanismo (`functions[nombre] = fn` sobrescribe el mapa). Confirmado también que esto estaba deliberadamente exento de la comprobación de colisiones ya existente para un `.ws` — anotado en la propia sesión de aquel arreglo ("Entre dos `.wsf` no se comprobaba y no se cambia (podría romper proyectos que hoy funcionan)").

**Diseño**: mismo criterio que ya tenía la colisión con un `.ws` — se quitó la excepción de `claimName` (`if (!prev.fromWs && !fromWs) return;`) para que cualquier origen distinto colisione, no solo cuando interviene un `.ws`. El mismo fichero alcanzado por dos caminos (diamante) sigue sin ser colisión (ya lo cubría `prev.origin === origin`, sin cambios ahí). Verificado explícitamente que el diamante real (un componente importado directo Y a través de otro que lo envuelve) NO dispara el error, y que se emite una sola vez.

**Bug encontrado al reproducir, MÁS FUNDAMENTAL que el reportado, y que casi hace que la reproducción inicial no funcionara**: al escribir el primer repro con `export function fmt(x)` en ambos componentes, no hubo colisión — ni error, ni pisado visible — porque la function era simplemente INVISIBLE, `fmt is not defined` al llamarla desde la propia plantilla del componente. Causa: `ownFns`/`ownConsts`, al recoger las piezas de un `.wsf` importado, filtraban `targetAst.body` por tipo (`FunctionDecl`, `ConstDecl`) sin desenvolver primero el nodo `Export` que envuelve la declaración — exactamente el mismo bug, en otro sitio del código, que ya se había corregido para un `.ws` (`topDecls` en `loadClientWs`, de la entrada de imports del cliente) pero nunca se replicó aquí. Sin `export`, la function/const sí viajaba (por eso el repro real de la colisión usa funciones SIN `export`). Arreglado con el mismo patrón: `topDecls = targetAst.body.map(n => n.type === "Export" ? n.declaration : n).filter(Boolean)`, usado en vez de `targetAst.body` directamente para `ownFns`/`ownConsts`/reactive/visual/style de un `.wsf` importado.

**Hueco relacionado, encontrado al escribir las pruebas, NO abordado aquí**: una `const` de un componente usada DENTRO de la plantilla de ESE MISMO componente sigue rota en SSR (`TITULO is not defined`), con o sin `export`, y sin relación con nada de esta sesión — reproducido en un componente aislado, sin imports, sin colisión posible. Causa aparente (no arreglada, solo localizada): `renderComponentSSR` construye el `ctx` del hijo con `extraScope: { props }`, que REEMPLAZA por completo el `extraScope` del padre en vez de combinarlo, perdiendo cualquier const de nivel superior en cada nivel de composición. Usar el `const` exportado de un componente desde OTRO fichero (la raíz, o un componente distinto) sí funciona — comprobado, es justo lo que arregla el bug de arriba — el hueco es solo dentro de la propia plantilla del componente que lo declara.

**Cambios**: `codegen-client.js` — `claimName` (quitada la excepción), y el bloque `.wsf` de `processImport` (añadido `topDecls` con el desenvuelto de `Export`, usado por `ownFns`/`ownConsts`/reactive/visual/style en vez de `targetAst.body`).

**Verificado con ejecución real** (JSDOM para cliente, `renderPageToHTML` para SSR, y de extremo a extremo con `websc build` + servidor real): la colisión da el error en cliente y en SSR; tras renombrar uno de los dos, cada componente muestra su propio valor (`A:1` y `B:2`, no los dos `B:2` de antes) tanto en el HTML estático del build como en el servido; una colisión de `const` (no solo `function`) también da error; una colisión entre la propia página y un componente importado también; el diamante real no colisiona y no duplica; `export function` y `export const` de un componente ya no son invisibles.

**Pruebas**: `tests/codegen-client-dup-wsf-names.test.js` (8 nuevos). Contra el código anterior fallan 6 de 8 (los 2 que pasan en ambos son guardas de no-regresión sin `export` ni colisión: renombrar evita el choque, y el diamante ya funcionaba). Suite completa: **549/549** (541 + 8).

**Huecos que siguen abiertos**: la const-dentro-de-su-propio-componente en SSR descrita arriba; los dos huecos del servidor de entradas anteriores (function exportada por un `.wsb`, constantes hermanas de un mismo `.ws`).


### Una const propia de un componente, usada en su propia plantilla — hueco encontrado la entrada anterior, resuelto

**Encargo**: "La const-dentro-de-su-propio-componente en SSR (recién encontrada). está" — el hueco que se encontró (no reportado, no se buscaba) al escribir las pruebas del arreglo de colisión entre dos `.wsf`.

**Reproducido antes de tocar nada**: un componente con `const TITULO = "hola"` y `<span>{TITULO}</span>` en su propia plantilla — `TITULO is not defined` en SSR. El cliente ya funcionaba (confirmado: `hola`), porque el bundle de cliente es un único ámbito plano donde toda const de nivel superior, de cualquier fichero, queda al mismo nivel. Usar `TITULO` desde OTRO fichero (comprobado: la raíz importando `{ TITULO }` directamente del componente) también funcionaba — el hueco era solo dentro de la propia plantilla del componente que la declara.

**Causa, localizada leyendo `renderComponentSSR`**: construye el `ctx` del hijo con `extraScope: { props }` — reemplaza ENTERO el `extraScope` heredado del padre (donde vive `boundTopLevelNames`, el equivalente en SSR del ámbito plano del cliente) en vez de combinarlo. Se pierde en cada nivel de composición. Confirmado que el cuerpo de un `for` ya hacía esto BIEN (`{ ...ctx.extraScope, [item]: valor }`, código ya existente, sin tocar) — el mismo patrón, aplicado aquí.

**Arreglo**: `codegen-ssr.js`, `renderComponentSSR` — `extraScope: { ...ctx.extraScope, props }` en vez de `extraScope: { props }`. `props` va al final para que un `props` heredado de un componente que envuelve a este no se filtre hacia dentro del nivel actual (pisado por el propio).

**Un tropiezo propio al verificar, que casi hace perder tiempo persiguiendo un bug que no existía**: al probar un `for` dentro de un componente (`for (item in props.items)`), un script de prueba propio ESCRIBÍA el fichero `.wsf` de prueba SIN los paréntesis del `for` (`for item in props.items`, sintaxis inválida — la gramática real exige `for (item in lista)`, confirmado contra un test ya existente de la suite). El AST resultante no reconocía la línea como un nodo `For` en absoluto (caía a `Text` plano), dando `item is not defined` — un error de sintaxis en MI prueba, no un bug del compilador. Se confirmó releyendo el AST con el propio parser (`JSON.stringify` del árbol) antes de asumir que era un fallo real, y corrigiendo la sintaxis del fichero de prueba.

**Verificado con ejecución real** (`renderPageToHTML`, y de extremo a extremo con `websc build` + servidor real: un componente `Tarjeta` con `const PREFIJO = "★ "` usada en su propia plantilla, instanciado DOS veces con `props.titulo` distintos — el HTML estático y el servido muestran `★ Primera` y `★ Segunda` correctamente): const propia sola; const propia que usa una function propia; tres niveles de composición, cada uno con su propia const en su propia plantilla; `props` de un padre que NO se filtra a un hijo que no lo declara; una const y un prop con nombres parecidos sin confundirse; un `for` dentro de un componente combinando bien su propia const, `props`, y la variable del `for`.

**Pruebas**: `tests/codegen-ssr-component-own-const.test.js` (8 nuevos). Contra el código anterior fallan 6 de 8 (los 2 que pasan en ambos son guardas de no-regresión: el cliente, que ya funcionaba con su ámbito plano, y que `props` no se filtre a un hijo, que tampoco dependía de este arreglo). Suite completa: **557/557** (549 + 8). Nota sobre el recuento: `npm test` dio un fallo aislado y no reproducible en `codegen-session-redis.test.js` (3/3 al ejecutarlo solo, justo después) — contención de Redis al correr en paralelo con el resto de la suite, no una regresión; se confirmó re-ejecutando la suite completa dos veces seguidas con 557/557 estable.

**Huecos que siguen abiertos**: los dos huecos del servidor de entradas anteriores (function exportada por un `.wsb` no resuelve sus propios imports; constantes hermanas de un mismo `.ws`).


### Constantes hermanas dentro de un mismo `.ws` — hueco de dos entradas atrás, resuelto

**Encargo**: "Continuar" — el otro de los dos huecos del servidor que quedaban abiertos. Elegido por ser el más autocontenido de los dos (el otro, la function exportada por un `.wsb`, tiene una pregunta de diseño abierta sobre contra qué estado compilarla — ver más abajo).

**Reproducido antes de tocar nada**: `valores.ws` con `export const A = 5` y `export const B = A + 1`; un `.wsb` que importa `B` y la sirve — `A is not defined`. También comprobado que una constante que llama a una FUNCTION hermana del mismo fichero (`export const D = doble(21)`, con `doble` declarada ahí mismo) falla igual (`doble is not defined`) — mismo síntoma, pero es un caso distinto, más difícil (ver el límite deliberado más abajo).

**Causa**: `evaluateWsConst` construía el ámbito de una constante solo con `wsScopeValues(registry, entry)` — los IMPORTS de ese `.ws`, nunca sus propias hermanas (otras `const`/`var` del mismo fichero).

**Diseño** (alternativas descartadas y motivos en `DISEÑO.md`, sección "Constantes hermanas dentro de un mismo `.ws`"): una hermana referenciada por nombre en el texto de la expresión (mismo criterio de detección por palabra que ya se usó en el arreglo de `reactive`+`const` del cliente/SSR) se resuelve a través de una función nueva, `getWsConstValue`, que cachea el valor por NOMBRE — una sola evaluación, se pida desde fuera del fichero (vía `import`) o desde una hermana — y detecta un ciclo ENTRE HERMANAS (`const A = B` / `const B = A`, ambas en el mismo `.ws`) con un error explícito que nombra la constante y el fichero. Es un ciclo DISTINTO del que ya existía (importación circular ENTRE FICHEROS, `entry.scopeReady`) — se comprobó que los dos siguen dando su propio error, sin mezclarse.

**Cambios**: `codegen-server.js` — `getWsConstValue` (caché + detección de ciclo) y `siblingConstScope` (nuevos) antes de `evaluateWsConst`; `evaluateWsConst` combina `wsScopeValues` con `siblingConstScope` en el ámbito; el único sitio que llamaba a `evaluateWsConst` directamente (al resolver un `import { X } from "./a.ws"` hacia una constante) se cambió para pasar por `getWsConstValue` también — así CUALQUIER acceso a una constante de un `.ws`, venga de fuera o de una hermana, comparte la misma caché (verificado: dos constantes pedidas juntas que comparten una hermana derivada obtienen la MISMA referencia de objeto, no dos evaluaciones distintas).

**Límite deliberado, no una regresión de este cambio**: una constante que llama a una FUNCTION hermana sigue sin resolverse. Esa function puede tocar `global` (ver la sección de imports del `.ws`, arriba), que en el momento en que se evalúa una constante — durante `resolveImports`, en el arranque del servidor, antes de `createRequestHandler` — todavía no existe; las funciones de un `.ws` se compilan DESPUÉS, cuando ya se sabe qué es `global` y qué es de sesión. Resolverlo exigiría decidir contra qué estado compilar esa function en ese punto — la misma pregunta de diseño abierta que tiene la function exportada por un `.wsb` (el otro hueco que queda).

**Un tropiezo propio al escribir las pruebas, que no llegó a salir del todo**: un primer intento de probar "una hermana compartida se evalúa una sola vez" usaba `var veces = 0` y una constante derivada que hacía `(veces = veces + 1, A + 1)`, esperando que una constante hermana separada (`export const VECES = veces`) reflejara el incremento. No tiene sentido: cada evaluación de una constante es una llamada a `new Function(...)` independiente, con los valores pasados como PARÁMETROS — `veces = veces + 1` dentro de esa función solo reasigna el parámetro local, nunca un estado compartido real. El fallo (`VECES` daba `0`, no `1`) era de la PREMISA del test, no del compilador. Se rehizo comparando la IDENTIDAD de un objeto (misma referencia si se evaluó una vez, referencias distintas si dos) en vez de un contador por efecto lateral — forma correcta de comprobar "una sola evaluación" sin depender de una semántica de mutación que este lenguaje no tiene en este punto.

**Verificado con ejecución real** (`WSClient` sobre un servidor real vía `createServer`, y de extremo a extremo con `npm pack` + instalación global + `websc init`/`build` + `node dist/server.js` + `curl`): cadena de tres constantes (`A=5, B=6, C=60`) servida por una ruta HTTP real (`GET /valor` → `{"valor":60}`); una hermana no exportada que otra sí usa; una hermana que mezcla import + hermana a la vez; una hermana rota que nadie usa no tumba a las demás; el ciclo real entre hermanas da su error propio, distinto del de importación circular entre ficheros (que sigue intacto).

**Pruebas**: `tests/codegen-server-ws-sibling-const.test.js` (9 nuevos). Contra el código anterior fallan 6 de 9 (los 3 que pasan en ambos son guardas de no-regresión: la hermana rota sin usar, el ciclo entre ficheros ya existente, y la function hermana que sigue sin resolverse a propósito). Suite completa: **566/566** (557 + 9), estable en dos ejecuciones seguidas.

**Huecos que siguen abiertos**: una `function` exportada por un `.wsb` no resuelve los imports de su propio `.wsb` de origen — la pregunta de diseño abierta (contra qué estado de servidor compilarla) sigue sin resolver, es el único hueco que queda de todos los anotados en esta serie de sesiones.


### Función exportada por un `.wsb`: qué estado ve — último hueco abierto del proyecto, resuelto

**Encargo**: "Continuar" — el último hueco que quedaba, tras cerrar el de las constantes hermanas de un `.ws` (que ya había dejado anotado como "la misma pregunta de diseño abierta"). A diferencia de las anteriores, esta entrada exigía decidir algo, no solo corregir un cableado — se abordó con una decisión explícita, documentada, no adivinada.

**Reproducido antes de tocar nada, con TRES escenarios, los tres rotos**: una function exportada por `otro.wsb` que llama a `doble` (importada por `otro.wsb` de `util.ws`) — `doble is not defined`; una que llama a un helper interno del MISMO fichero, sin exportar — `interno is not defined`; y una que lee su propia `global var contador` — `contador is not defined`. Los tres con el MISMO mensaje indiferenciado, porque `compileFunctionDecl(decl)` compilaba la function completamente sola (`compileFunctionBatch([fnNode])`, sin `extraBindings` ni `globalInfo`) — ni imports, ni hermanas, ni estado, nada.

**La pregunta de diseño, y la decisión tomada**: un `.ws` nunca tiene estado de servidor propio, así que "contra qué `global` se compila una function importada de un `.ws`" nunca fue ambiguo (siempre el del `.wsb` raíz que arrancó el servidor). Un `.wsb` de origen SÍ puede tener el suyo — así que había que decidir. Se descartó dárselo el `global` del `.wsb` RAÍZ que importa (acoplaría el comportamiento de una function reutilizable a quien la importe, y un nombre coincidente por casualidad resolvería mal en silencio) y también traer consigo el `global` de SU PROPIO fichero (mezclaría el `global` de dos ficheros distintos, con el mismo riesgo de colisión de nombres que ya motivó no aplanar los imports de un `.ws`). Decisión: **nunca ve ningún `global`** — se compila siempre con `globalInfo: null` — y si de verdad lo necesita, es un error EXPLÍCITO al compilar, no un intento de adivinar.

**Diseño** (alternativas descartadas y motivos completos en `DISEÑO.md`, sección "Función exportada por un `.wsb`: qué estado ve"): se resuelve como una entrada más del MISMO registro que ya usan los `.ws` (`getWsEntry`/`compileWsRegistry`) — mismo ámbito privado por fichero, mismo "todas las function del fichero se compilan juntas" (arregla los dos primeros escenarios de golpe). Reglas nuevas, solo para un origen `.wsb`:
- Se compila SIEMPRE sin `global`.
- Si una function ALCANZABLE (la pedida, o lo que ella llama, transitivamente — no todas las del fichero, mismo criterio "una hermana que nadie usa no tumba a las demás" de la entrada anterior) menciona por nombre una `reactive`/`var`/`const` de nivel superior de SU PROPIO fichero, error explícito al compilar, con el nombre de la function, el nombre no disponible, y el motivo.
- Sus imports hacia OTRO `.wsb` no se resuelven (encadenaría la misma ambigüedad un nivel más allá) — se filtran antes de resolver los demás; si una function realmente lo necesita, falla en EJECUCIÓN con "X is not defined", no en silencio.

**Cambios**: `codegen-server.js` — `getWsEntry` generalizado para aceptar también un `.wsb` como `targetPath` (filtra, solo para un origen `.wsb`, sus propios import hacia otro `.wsb` antes de resolver el resto); `compileWsRegistry` distingue el origen por extensión (`.wsb` → `globalInfo: null` + `checkWsbFunctionsDontTouchOwnState` antes de compilar); `checkWsbFunctionsDontTouchOwnState` (nueva) calcula lo alcanzable desde `entry.names` y solo comprueba eso; el bloque `.wsb`-import de `resolveImports`, para `FunctionDecl`, pasa de `compileFunctionDecl(decl)` a `getWsEntry(...)` + `entry.names.add(name)` — mismo cableado final que ya usa un `.ws` (createRequestHandler ya recorre `wsRegistry.list` genéricamente, sin distinguir extensión, así que no hizo falta tocar nada ahí).

**Un tropiezo propio, detectado antes de darlo por bueno**: la primera versión de `checkWsbFunctionsDontTouchOwnState` comprobaba TODAS las function del fichero, no solo las alcanzables — así que pedir SOLO `usaDoble` (que no toca ningún estado) fallaba igual, porque OTRA function del mismo fichero (`usaGlobal`, ni pedida ni llamada) sí lo tocaba. Se detectó reproduciendo cada escenario por separado antes de darlo por terminado, no solo el conjunto; se corrigió calculando el conjunto alcanzable (con la misma cola/BFS por nombre ya usada en otros arreglos de esta serie) antes de comprobar.

**Verificado con ejecución real** (`createServer` + petición HTTP real, y de extremo a extremo con `npm pack` + instalación global + `websc build` + `node dist/server.js` + `curl`): los tres escenarios reproducidos, ya funcionando (import plano, helper hermano) o fallando con el mensaje correcto (global propia); dos function exportadas del mismo fichero llamándose entre sí; una function que SÍ toca su propia global pero que nadie pidió ni se alcanza, sin tumbar a las demás; una cadena `.wsb` → `.wsb` → `.wsb` (compila, pero falla en ejecución con el nombre correcto si de verdad hace falta); dos function del mismo origen, pedidas desde dos rutas distintas del mismo servidor real, cada una con su propio resultado (`{"doble":10,"interno":101}`).

**Pruebas**: `tests/codegen-server-wsb-exported-function.test.js` (8 nuevos). Contra el código anterior fallan 6 de 8 (los 2 que pasan en ambos son guardas de no-regresión: la hermana con estado propio que nadie alcanza, y la cadena a un tercer `.wsb` — que YA fallaba en ejecución con el código anterior, por el mismo motivo de fondo aunque sin la protección explícita). Suite completa: **574/574** (566 + 8), estable en dos ejecuciones seguidas.

**Con esto, no queda ningún hueco conocido abierto en el proyecto** — de todos los anotados a lo largo de esta serie de sesiones (imports de un `.ws` en servidor/cliente/SSR, hidratación con interpolación vacía, reactive+const, dos `.wsf` con nombre duplicado, const propia de un componente en SSR, constantes hermanas de un `.ws`, y este), todos están resueltos.


### HTML suelto en un `.wsf`: página sin `Visual.render()` — sistema nuevo, aditivo (petición grande de Jorge)

**Encargo, en varios mensajes**: Jorge pidió un rediseño grande del sistema de render de `.wsf` — desaparece `Visual.ws` y sus métodos, el render funciona con HTML suelto a nivel de fichero (con `if`/`for`/interpolación funcionando dentro, igual que antes), la ruta sale del nombre del propio fichero (`src/api/listaProductos.wsf` → `/api/listaProductos`), `:param` en el nombre de fichero da acceso a `params.id`, y `query.campo` para la query string. Antes de tocar código, se le devolvió a Jorge un resumen estructurado de lo entendido más tres preguntas concretas (vía `ask_user_input_v0`, dado el tamaño y el riesgo de adivinar mal algo caro de deshacer):
1. ¿Despliegue aditivo (HTML suelto en paralelo al sistema `Visual.ws`, sin tocarlo) o sustitución directa? → **Aditivo primero.**
2. ¿La interpolación pasa a `{{expr}}` doble? → **No, se queda en `{expr}` — no era un cambio real.**
3. ¿Qué hacemos con `Visual.staticPaths()`/`Visual.navigate()`, que no aparecían en la descripción? → **Se les busca un reemplazo equivalente, diseño propuesto por Claude** (pendiente, ver huecos al final).

**Diseño y verificación, resumidos aquí — detalle completo y razonado en `DISEÑO.md`, sección "HTML suelto en un `.wsf`"**:

1. **Parser**: nuevo nodo `PageDecl` — una etiqueta HTML abriendo a nivel superior (`isBareHtmlStart`) se trocea con el MISMO mecanismo plano que ya usaba `visual` (`splitTopLevel`, sin anidar por indentación, hasta la siguiente declaración de nivel superior real). Verificado con el ejemplo real completo de Jorge (`<html>` con `if`/`else`, interpolación, `onclick`) parseando limpio, sin errores.

2. **`codegen-client.js`/`codegen-ssr.js`**: un `PageDecl` se trata como una `visual` más, con nombre interno fijo `__page__` — reutiliza `generateCreateFunction`/`generateHydrateFunction`/`renderElementSSR` TAL CUAL, sin duplicar la compilación de plantillas. **Bug encontrado al verificar de extremo a extremo**: cuando la raíz del HTML suelto es literalmente `<html>` (un documento completo, como en el ejemplo de Jorge), la hidratación fallaba (`Cannot read properties of null`) porque el mecanismo de montaje asumía siempre un FRAGMENTO insertado en `document.body` — un `<html>` no se puede anidar dentro de `<body>`. Arreglado: cuando la raíz es `<html>`, se hidrata directo contra `document.documentElement` (el que el navegador ya parseó), sin intentar insertarlo en ningún sitio.

3. **`classifyWsf` (codegen.js)**: un `PageDecl` clasifica como página sin `Visual.render()`. **Colisión real encontrada y resuelta con una restricción deliberada**: la regla completa de Jorge ("una única `visual` también se auto-renderiza") se probó primero tal cual, y rompió 4 tests existentes — investigando, `src/contador.wsf` (fichero REAL del proyecto, no un test sintético) es exactamente "una única `visual`, sin `Visual.render()`", y es hoy un componente reutilizable que importa `app.wsf`. Como Jorge había elegido "aditivo, no rompas nada", se restringió la regla: SOLO un `PageDecl` auto-renderiza; una `visual` única sin HTML suelto sigue exactamente como hoy (biblioteca si no hay `Visual.render()`). Se lo comuniqué a Jorge explícitamente en el propio turno, con el fichero real como prueba, en vez de aplicar el cambio más amplio en silencio.

4. **Ruta por fichero (`route-pattern.js`)**: extendido `routePatternFor` para aceptar una ruta relativa completa (con subcarpetas) y convertir un `:param` en el NOMBRE DE FICHERO en un segmento dinámico propio (`listaProductos:id` → `/listaProductos/:id`). **Hueco más grande de lo esperado, encontrado al investigar**: `findWsfFiles` (discover-files.js) era completamente PLANA — ni siquiera descubría un `.wsf` en una subcarpeta, con o sin mi cambio. Se hizo recursiva (`findWsbFiles` se dejó plana a propósito, fuera del alcance de esta petición). Cableado en los tres sitios reales que sirven una página: `bin/websc.js` (build estático + la plantilla que genera `dist/server.js`, vía un nuevo campo `newSystemRoute` en `pages.json`) y `serve-demo.js` (su propio escaneo paralelo, con la misma lógica). Nombres de fichero de salida (bundle, `.html`) aplanados con `-` para páginas en subcarpeta o con `:` en el nombre, evitando un choque de nombre latente que ya existía (dos ficheros del mismo nombre en carpetas distintas se habrían pisado el bundle).

5. **`params`/`query` reservados**: implementados en `codegen-ssr.js` (matching real de `requestUrl` contra el patrón) y `codegen-client.js` (mismo cálculo contra `location`, al cargar) — solo se activan cuando el fichero NO tiene ya su propio `Visual.route()` (`hasExplicitRoute`, calculado por quien llama). **Bug encontrado al revisar la clasificación estática/dinámica**: una página nueva sin `:param` pero que usa `{query.algo}` se clasificaba como estática (precalculada una vez, `query` siempre vacío) porque `usesVisualQuery` solo miraba `Visual.query(...)`, no el `query` reservado nuevo — añadido `usesReservedQuery` (comprobación por texto, deliberadamente conservadora: un falso positivo solo hace la página dinámica de más, nunca al revés).

6. **Un tropiezo propio, en `serve-demo.js`**: al renombrar `wsfPaths` a `wsfEntries` para llevar también la ruta relativa, quedó un uso residual de `wsfPaths` sin renombrar en el mensaje de arranque del servidor — `ReferenceError` al arrancar. Lo detectaron los propios tests existentes (`serve-demo.js sin .wsb: ...`) al ejecutar la suite completa, no una prueba nueva.

**Verificado con ejecución real en cada paso** (JSDOM para el bundle de cliente; `websc build` + `dist/server.js` + `curl` real para el pipeline completo; `serve-demo.js` con un directorio real): el ejemplo completo de Jorge (HTML con `<html>`, `if`/`else`, `onclick`) funcionando de extremo a extremo, con el contador subiendo correctamente al hacer clic; una página en `src/api/listaProductos.wsf` sirviéndose en `/api/listaProductos` desde un servidor real; `src/api/producto:id.wsf` sirviéndose en `/api/producto/:id` con `params.id` y `query.orden` correctos, con y sin query string; dos páginas de igual nombre en subcarpetas distintas sin pisarse el bundle; el sistema antiguo (`Visual.route()` explícito) funcionando exactamente igual, sin `params`/`query` de más.

**Pruebas**: 27 nuevas, repartidas en `tests/parser-page-decl.test.js` (7), `tests/codegen.test.js` (5 añadidos a los 2 ya existentes), `tests/codegen-page-decl.test.js` (5), `tests/route-pattern.test.js` (5 añadidos a los 2 ya existentes), `tests/websc-build-page-route.test.js` (5 nuevos, E2E real). Verificadas contra el código anterior a toda esta funcionalidad: 13 de 26 fallan (las etiquetadas "REGRESIÓN nueva capacidad"); las de "NO REGRESIÓN" ya pasaban, correctamente. Suite completa: **601/601** (574 + 27).

**Huecos que quedan abiertos, explícitamente fuera de esta entrada**:
1. `Visual.staticPaths()` sin equivalente en el sistema nuevo — una página con `:param` del sistema nuevo siempre es SSR dinámica, nunca precalculada.
2. `Visual.navigate()` sin equivalente — no hay forma de cambiar de ruta sin recargar para una página del sistema nuevo; `params`/`query` no se recalculan tras una navegación interceptada por el router existente.
3. **[RESUELTO en una entrada posterior]** `visual` importable desde un `.ws` — pedido explícitamente por Jorge, no implementado todavía.


### `visual` importable desde un `.ws` — tercera pieza de la petición grande, resuelta

**Encargo**: "sigue con la tercera" — la última de las tres piezas explícitamente pendientes de la petición del HTML suelto (las otras dos, `staticPaths`/`navigate`, siguen abiertas).

**Reproducido antes de tocar nada**: un `.ws` con `visual Tarjeta = <div class="tarjeta">{props.titulo}</div>`, importada desde un `.wsf` con `<Tarjeta titulo="hola" />`. SSR devolvía literalmente `<Tarjeta titulo="hola" />` como texto sin procesar (la plantilla no reconocía `Tarjeta` como componente); el cliente compilaba sin incluir `create_Tarjeta`. Comprobado primero que la gramática YA admite `VisualDecl` en un `.ws` (el parser no distingue extensión) — el hueco estaba en el import, no en el parseo: `ws.declaredByName.get(name)` SÍ encontraba la visual, pero el bucle por nombre de `processImport` solo hacía algo con `FunctionDecl`, ignorando en silencio cualquier otro tipo.

**Un tropiezo de sintaxis propio, antes de llegar a la reproducción real**: el primer intento escribió `export visual Tarjeta = ...` en el `.ws`, y dio un error de "no está exportado" — confuso, porque parecía que SÍ hacía falta `export`. Investigando, resultó que `export visual` nunca fue sintaxis válida en absoluto (ni antes de esta sesión): `splitTopLevel` reconoce una `visual` por su cabecera literal `visual\s+\w+\s*=`, y una línea que empieza por `export` no encaja ahí — el `export` y el HTML acababan como dos declaraciones sueltas y rotas, no relacionadas. Confirmado que una `visual`, de un `.wsf` o de un `.ws`, NUNCA necesita `export` para ser importable por nombre (mismo criterio ya establecido para las de un `.wsf`) — se corrigió el fichero de prueba quitando el `export`, y ahí sí se reprodujo el hueco real.

**Diseño**: mismo mecanismo dirigido por demanda que ya usan las `function` de un `.ws` (`requestWsFunction`) — nueva `requestWsVisual`, que añade la visual pedida a `result.visualDecls` y demanda, de forma transitiva, lo que su plantilla referencia (otra function/const/visual del MISMO `.ws`, o algo que ese `.ws` importa). Se añadió `ws.visualByName` (nuevo mapa, paralelo a `ws.fnByName`) en `loadClientWs`.

**Un segundo bug propio, encontrado al probar con una visual que usa una function hermana (no al probar el caso simple)**: la primera versión de `requestWsVisual` pasaba `JSON.stringify(visual.html)` a la función de análisis de referencias YA EXISTENTE (`referencedNames`, la que ya usa `requestWsFunction` para el cuerpo de una function — primero intenta `acorn`, solo cae a un escaneo por palabra si `acorn` falla al parsear). El HTML convertido a JSON **parsea perfectamente como JS válido** (es, literalmente, un array de objetos anidados con claves entre comillas) — `acorn` lo acepta sin más, y el recorrido de identificadores nunca encuentra los nombres reales, porque viven dentro de STRINGS (el valor de un nodo `Text`, p. ej. `"{formatear(props.titulo)}"`), no como sintaxis JS de verdad. `acorn` nunca "fallaba" ahí, así que el escaneo de reserva —el que sí habría encontrado "formatear"— nunca se activaba. El caso simple (sin referencias cruzadas) pasaba igualmente, por eso no se detectó hasta probar el caso con una function hermana. Corregido con un escaneo por palabra DIRECTO sobre el texto, sin pasar por `referencedNames` en absoluto.

**Verificado con ejecución real** (JSDOM para SSR y cliente, y de extremo a extremo con `npm pack` + instalación global + `websc build` + `node dist/server.js`, dos instancias de la misma visual con `props.titulo` distintos): visual simple; visual que usa una function Y una const hermanas del mismo `.ws`; el patrón dirigido por demanda de siempre (una visual segura de un `.ws` mixto no arrastra a otra insegura que toque un `.wsdb`; pedir la insegura da el error de siempre, con el `.ws` nombrado); el mismo `.ws` alcanzado por dos caminos (diamante) sin duplicar la definición (`create_Tarjeta` se emite una sola vez); una visual que llama a una function que ese `.ws` importa, a su vez, de un `.js`.

**Pruebas**: `tests/codegen-client-ws-visual.test.js` (7 nuevos). Los 7 fallan contra el código anterior (incluidas las etiquetadas "NO REGRESIÓN": con el código anterior, la capacidad base ni existía, así que ni siquiera esos casos podían pasar). Suite completa: **608/608** (601 + 7).

**[RESUELTO en una entrada posterior]** Huecos que quedaban: `Visual.staticPaths()` y `Visual.navigate()` sin equivalente en el sistema nuevo.


### `goto()` y `params`/`query` reactivos, y `staticPaths` en `wconfig.json` — las dos últimas piezas de la petición grande, resueltas

**Encargo**: "recuérdame que hacía estos métodos" (repasé `Visual.navigate()`/`Visual.staticPaths()` antes de proponer nada) → "sugerencias para una sintaxis compatible con lo nuevo?" (propuse alternativas para las tres piezas, con recomendación) → "Visual.navigate renombramos a goto() y las staticPath quizás podemos meterlas en el wconfig.json" (decisión de Jorge).

**Antes de proponer sintaxis, comprobé algo con código real que cambió el diagnóstico**: `Visual.navigate()` ya es genérico — no depende de `Visual.route()` ni de ningún `screen` — así que YA FUNCIONABA en una página del sistema nuevo, sin ningún cambio (`Visual.navigate('/otra')` dentro de un `onclick`, probado, cambia la URL sin recargar). El hueco real no era "falta navegar sin recargar": era que `params`/`query`, calculadas UNA VEZ al cargar el script, no se actualizaban tras navegar.

**`goto()`**: alias reservado y suelto de `navigate` (`const goto = navigate;` en `runtime.js`, justo después de su definición) — `Visual.navigate` sigue intacto para el sistema antiguo.

**`params`/`query` reactivos — diseño**: en vez de construir un mecanismo nuevo, se reutilizó el YA EXISTENTE para `Visual.route()`/`params()`/`query()` del sistema antiguo (`routeDerivedDecls`/`dependsOnRoute`/un único `effect()` combinado que los recalcula) — se extendió `dependsOnRoute` para que un `const`/`var` que mencione `params`/`query` sueltas (cuando `routePattern` está activo) TAMBIÉN entre en ese mecanismo, en vez de crear un camino paralelo.

**Dos fallos propios, encontrados con ejecución real antes de dar el arreglo por bueno, no al primer intento**:
1. La primerísima versión calculaba `params`/`query` en un `effect()` SEPARADO del que recalcula los derivados (`routeEffectSource`) — probé un `const titulo = "Producto " + params.id` y NO se actualizaba tras `goto()` (se quedaba en el valor inicial), porque vivía en un closure distinto, sin acceso a los `params`/`query` recién calculados en el otro effect. Detectado reproduciendo el caso con una const derivada, no con el caso simple (que sí funcionaba). Corregido fusionando ambos cálculos en un único `effect()`.
2. Antes de esa fusión completa, quedó a medias una edición: `params`/`query` se calculaban en su propio effect colocado DESPUÉS de `topLevelSources` — `Cannot read properties of undefined (reading 'id')`, porque un `const` POST-estado que las usa se evaluaba antes de que el effect las poblara. Al fusionar con `routeEffectSource` (que ya corre antes de `topLevelSources` por diseño) y hacer que cualquier const que las use entre en `routeDerivedDecls` en vez del camino normal, el problema de orden desapareció por construcción, sin tener que razonarlo a mano.

**Un tropiezo de edición propio, ajeno al diseño**: al fusionar los dos bloques de código a mano (varias ediciones seguidas sobre el mismo fichero), quedaron fragmentos de texto huérfanos de una versión anterior (una llave de cierre y un `.join("\n") : "";` sueltos) que rompieron la sintaxis — se dejó anotado explícitamente en la respuesta al usuario en el momento en que se detectó, en vez de intentar seguir editando a ciegas, y se retomó limpiamente en el turno siguiente.

**`staticPaths` en `wconfig.json` — diseño**: sin `screen`, la clave pasa a ser el PATRÓN DE RUTA tal cual (el mismo string que ya calcula `routePatternFor`); el valor, un array de combos inline o la ruta a un `.json` externo con ese array (para no duplicar datos). Se lee en `cmdBuild` (no en `dist/server.js`, que lee `wconfig.json` en tiempo de EJECUCIÓN para otras opciones — generar los `.html` es cosa del build). Implementado como una rama nueva, paralela a la ya existente para `Visual.staticPaths()` del sistema antiguo (mutuamente excluyentes por construcción: una depende de `hasExplicitRoute`, la otra de `!hasExplicitRoute`).

**Verificado con ejecución real** (JSDOM para `goto()`/reactividad, y de extremo a extremo con `websc build` + servidor real para `staticPaths`): `goto()` cambia la URL sin recargar; `params.id` se recalcula solo tras `goto()`; una `const` derivada de `params`/`query` también se recalcula (el bug real); lo mismo tras el atrás/adelante del navegador (`popstate`); `Visual.navigate()` del sistema antiguo intacto; `staticPaths` inline en `wconfig.json` pre-genera un `.html` por combinación; una referencia a un `.json` externo funciona igual; una combinación no listada se sirve por SSR dinámico real con `params` correctos (red de seguridad); sin `staticPaths` en `wconfig.json`, una página con `:param` sigue siendo SSR dinámica de siempre; el sistema antiguo (`Visual.route()` + `Visual.staticPaths()` en el propio fichero) sin relación alguna con la clave nueva.

**Pruebas**: 11 nuevas — `tests/codegen-client-goto-reactive.test.js` (6) y `tests/websc-build-wconfig-staticpaths.test.js` (5, E2E real). 6 de 11 fallan contra el código anterior. Suite completa: **619/619** (608 + 11).

**Con esto, la petición grande del HTML suelto está completa: no queda ninguna de las piezas explícitamente pendientes.**


### `clients` en `wconfig.json` + `websc build --create-clients`

**Encargo**: "y si movemos el comando para construir los WSClients al wconfig.json y se hace en el build?" → se le señaló a Jorge una tensión real antes de implementar: `websc build` es hoy un paso puro y sin red (lee `src/`, escribe `dist/`), y `client-generate` necesita un servidor remoto vivo y alcanzable — meterlo sin más dentro del build lo volvería dependiente de la red y de que un tercero esté arrancado en ese instante. Se propusieron tres formas (A: siempre, en cada build; B: solo si el fichero no existe todavía; C: un comando aparte que lee `wconfig.json`, sin tocar `build`), con recomendación por la C. Jorge eligió la A, con una condición propia que resuelve justo el riesgo señalado: un flag explícito (`--create-clients`, no el comportamiento por defecto) y, si un remoto falla, una clase vacía en vez de tumbar el build entero.

Antes de esto hubo una vuelta de aclaración: "y si movemos el ... a smtp?" (por el hilo anterior sobre correo) — resultó ser una confusión mía al explicar que la arquitectura de un listener SMTP propio se parecería a la de `websocket-runtime.js` ("protocolo TCP crudo escrito a mano"), no una sugerencia de reutilizar el nombre `"socket"` para SMTP. Aclarado sin tocar código.

**Diseño**: se extrajo la lógica de conectar+reflejar+construir el texto del `.ws` (antes solo vivía dentro de `cmdClientGenerate`) a una función compartida, `generateClientContent(url)`, que devuelve `{ cuerpo, nombresFunciones }` o lanza. `websc client-generate` seguía usándola igual (falla rápido, sin cambios de comportamiento — confirmado con su test existente). `websc build`, con `--create-clients`, la llama para cada entrada de `wconfig.json.clients` (`{ "src/OtroServidor.ws": "wss://..." }`) — si tiene éxito, escribe el `.ws` real; si falla (sin conexión, sin respuesta a tiempo, sin `online function` expuestas), escribe una clase VACÍA con un comentario explicando el motivo, y sigue con el siguiente remoto sin abortar el build. Sin el flag, `wconfig.json` puede tener `clients` declarado y no pasa nada — cero llamadas de red, comportamiento idéntico a antes de esta entrada.

**Verificado con ejecución real** (servidores remotos de verdad, como PROCESOS separados — mismo patrón ya establecido en `tests/websc-client-generate.test.js`, necesario porque `execFileSync` bloquea el proceso de test mientras corre `websc build`, así que el remoto no puede vivir en el mismo proceso): un remoto real sincronizado correctamente vía `wconfig.json` + `--create-clients`; sin el flag, `wconfig.json` con `clients` no toca la red ni genera nada; un remoto que falla (puerto sin nada escuchando) escribe una clase vacía y el build entero termina con normalidad; dos remotos declarados, uno roto y otro bueno, el bueno se genera bien y el build no se detiene en el primer fallo; una página que importa una función de un cliente generado así funciona de extremo a extremo.

**Pruebas**: `tests/websc-build-create-clients.test.js` (5 nuevos). 4 de 5 fallan contra el código anterior (el que no falla es el que comprueba que SIN el flag no pasa nada, que ya era cierto por la simple ausencia de la funcionalidad). Suite completa: **624/624** (619 + 5).


### `shared reactive`: diseño en profundidad, y la guarda contra bucle de `watch()` generalizado

**Encargo, en varios mensajes, con mucha discusión de diseño por el camino**: "¿es útil implementar un tipo de variable que tenga dos valores a la vez?" → se investigó qué significaría de verdad ejecutar un `if`/`else` con las dos ramas a la vez (no determinismo, el operador `amb` de McCarthy) y se preguntó por un caso real antes de diseñar nada → "¿no sería útil para paralelismo de datos?" → se distinguió concurrencia de E/S (ya gratis) de paralelismo real de CPU (`worker_threads`, el ya existente `cluster-workers`) y se explicó por qué "dos mundos" no es la herramienta adecuada para eso → "sugerencias para implementar algo que llame la atención" → se propusieron cinco ideas, aprovechando piezas ya construidas del lenguaje; Jorge eligió la 1 (estado compartido en tiempo real).

**El diseño se construyó con VARIAS correcciones en vivo, cada una motivada por una pregunta de Jorge que yo no había pensado del todo**:
1. Jorge señaló que `shared` sobre una `reactive` NORMAL (de sesión) no tiene sentido — cada sesión ya tiene su propia copia aislada. Solo encaja sobre `global reactive`, donde hay un único valor real que compartir.
2. Jorge preguntó cómo se distingue quién es el "host", si WebSocket es bilateral. Se resolvió con el mismo principio ya usado en el proyecto para la réplica multi-*master* (descartada por el teorema CAP): no hay dos dueños — el servidor es la única autoridad, un cliente nunca muta directamente, solo propone.
3. Jorge preguntó por el caso de dos frontales — ya cubierto sin cambios por el diseño anterior (ambos son simétricamente suscriptor y proponente, nunca hablan directo entre sí).
4. Jorge preguntó cómo se define la lista de suscriptores, y si esto extiende `WSClient`. Se precisó: la lista de QUIÉN PUEDE recibir algo es estática (la palabra `shared` en el código, escaneada en compilación); la lista de quién ESTÁ suscrito ahora es, por naturaleza, dinámica (un registro en memoria, poblado por los `subscribe` que van llegando). No es una extensión de `WSClient` — comparten transporte (`websocket-runtime.js`) pero el contrato es distinto (llamada/respuesta frente a suscripción/empuje).
5. Jorge insistió: "¿son sistemas ajenos, o es el mismo proyecto?" — pregunta que yo no había dejado explícita. Aclarado: es el mismo proyecto, un `.wsf` habla con SU PROPIO `.wsb` (mismo origen, sin URL que declarar — igual que ya pasa con cualquier `fetch()` de esa página), no un sistema externo.
6. Jorge propuso simplificar: ¿hace falta `shared` como palabra, o basta con que CUALQUIER reactive importada de un `.wsb` sea bidireccional por defecto? Al comprobarlo con código real salió un hecho que cambiaba la conversación: **hoy un `.wsf` no puede importar NADA de un `.wsb`, ni siquiera algo tan simple como una `reactive` normal** — el mecanismo que la propuesta de Jorge asumía que ya existía, no existe. Jorge, con eso ya claro, decidió mantener `shared` como anotación explícita, y que el import de un `.wsb` solo admita nombres marcados así — cierra de raíz el riesgo de que una escritura accidental sobre un import "normal" mande tráfico de red sin querer.
7. Jorge preguntó por qué `global` "tenía un problema" para esto. Al revisarlo con más cuidado, no lo tiene con un solo proceso — el problema (documentado ya en `DISEÑO.md` para el límite de peticiones) es exclusivo de `cluster-workers` con varios procesos, y no es nuevo: ya existe hoy para cualquier `global reactive`, con o sin `shared`.
8. Jorge preguntó qué pasa si un `watch()` reasigna la MISMA `shared global reactive` que observa — ¿no sería un bucle? Al comprobar la pregunta con código real (`__trigger`/`__triggerGlobal`) salió algo que yo había dado por sentado MAL en una respuesta anterior: dije que una `global reactive` reasignada desde otra parte del servidor no dispara ningún `watch()` hoy. Es FALSO — hay un mecanismo entero, `extractPlainWatches`, que ya generaliza `watch()` a cualquier reactive, no solo a las atadas a rutas, reproducido con código real (una ruta distinta reasigna una `global reactive` y el `watch()` de al lado salta, sin relación con rutas). Correción reconocida explícitamente a Jorge, con el código que lo demuestra.

**El problema real que esa corrección destapó, y que Jorge pidió arreglar aparte, antes de seguir con `shared`**: como `watch()` generalizado es una reescritura de TEXTO en compilación (inyecta `await __trigger("nombre")`/`await __triggerGlobal("nombre")` justo después de cualquier línea que reasigne una reactive con su propio `watch()`), un `watch()` que reasigna la MISMA reactive que observa se inyecta a sí mismo otro disparo — reproducido con código real: `watch(contador) { contador = contador }` revienta la pila (`RangeError: Maximum call stack size exceeded`).

**Arreglo**: dos guardas, en `__trigger` (por sesión) y `__triggerGlobal` (global) — (1) si el valor no cambió de verdad respecto al último disparo atendido, no se llama al `watch()` (mismo criterio que React/Vue); (2) un límite de profundidad (50) como red de seguridad para el caso que la guarda 1 no cubre (un valor que cambia de verdad en cada disparo, sin converger nunca) — da un mensaje claro en vez de `RangeError`.

**Un tropiezo propio al escribir las pruebas, detectado por la propia disciplina del proyecto**: la primera versión de los tests solo comprobaba que la petición HTTP respondiera 200 — y los 5 PASABAN igual contra el código roto (la petición responde bien de todos modos; el `RangeError` queda atrapado en el propio `try/catch` de `__trigger`, y solo se nota en los logs). Se detectó al verificar los tests contra el código anterior (el paso que este proyecto siempre hace antes de dar un test por bueno): los 5 pasaban sin excepción, señal inequívoca de que no probaban nada real. Se rehicieron capturando `console.error` durante la petición. Con eso, 3 de 5 sí fallan contra el código anterior, como corresponde.

**Verificado con ejecución real**: el caso reportado (mismo valor, global y de sesión) ya no revienta la pila; el caso patológico (nunca converge) da el mensaje claro; un `watch()` que corrige una vez hacia un valor distinto (recorte/clamp) sigue funcionando; un `watch()` normal sigue disparándose igual. De paso, confirmado con los mismos tests un detalle de "async/await implícito" que no estaba verificado explícitamente antes: el `await __trigger(...)` inyectado bloquea de verdad las líneas siguientes del mismo `watch()` — el cuerpo de una respuesta construida DESPUÉS de reasignar una reactive con cascada ya ve el valor corregido, no el original.

**Pruebas**: `tests/codegen-server-watch-loop-guard.test.js` (5 nuevos). Suite completa: **629/629** (624 + 5).

**[COMPLETADO en una entrada posterior]** Avance de `shared reactive` en sí: con la guarda ya puesta (necesaria antes de construir el resto, porque el `propose` se apoyará en esta misma infraestructura), se implementó el parser (`shared`/`shared global` como modificador de `reactive`) y la restricción de import `.wsf → .wsb` (solo nombres `shared`, con error específico para cualquier otro — antes bloqueado en bloque sin excepción). Pendiente, sin implementar todavía: que el valor `shared` importado haga algo de verdad en el bundle de cliente; el protocolo de suscripción/difusión por WebSocket; la escritura desde cliente (`propose`); el relevo entre workers por IPC. Detalle de diseño completo, con las alternativas consideradas en cada corrección, en `DISEÑO.md`.


### `shared reactive`: el protocolo completo, de extremo a extremo — cierre de la funcionalidad

**Encargo**: "Continuar, también plantea un código de ejemplo de su uso (el valor actualizado del reactive se manda al cliente por el watch? cuando se actualiza el cliente salta al watch del servidor? existe algún bucle de más?)" — Jorge pidió seguir con la pieza que faltaba (el lado cliente) Y, de paso, que aclarara con ejemplo y preguntas concretas cómo encajaban `watch()`, la difusión y el riesgo de bucle — todo ya resuelto en la entrada anterior sobre la guarda, pero sin haberlo atado explícitamente al diseño de `shared` todavía.

**Respuesta a las tres preguntas, dada ANTES de implementar nada más** (con lo ya verificado en la entrada anterior): el valor se difunde en CUALQUIER reasignación real, tenga o no `watch()` — no "por" el watch(), son dos cosas independientes que cuelgan del mismo punto (`__triggerGlobal`); cuando el cliente actualiza (`propose`), sí salta el `watch()` del servidor, porque la reasignación que hace el runtime con el valor propuesto es indistinguible de cualquier otra para ese mecanismo; y SÍ había un bucle de más — difusión duplicada cuando un `watch()` corrige el valor (ver el bug real, abajo) — detectado precisamente al preparar la respuesta a esta pregunta, probándolo con código real antes de contestar.

**Implementación completa, en orden**:
1. **Protocolo de servidor**: se reutilizó el `upgrade`/despachador que ya existía para `online function` (`wireOnlineFunctionsRpc`, renombrada a `wireWebSocketProtocol` porque ya hace más que eso) — un único WebSocket, dos protocolos por `type` de mensaje (`reflect`/`call` para `online function`; `subscribe`/`propose`/`update` para `shared`). Registro de suscriptores (`Map<nombre, Set<conexión>>`) en el mismo cierre que `getGlobalState()`/`__triggerGlobal`, limpiado solo al cerrarse cada conexión.
2. **`propose`**: el runtime reasigna de verdad (`getGlobalState()[name] = value`) y llama a `__triggerGlobal(name)` — el MISMO camino que cualquier otra reasignación, sin un camino especial. Para que esto funcione incluso SIN ningún `watch()` declarado, hubo que extender qué nombres reciben la inyección de `__triggerGlobal` en compilación (antes solo los que tenían su propio `watch()`) para incluir también cualquier `shared global reactive`.
3. **Lado cliente**: `collectImportedPieces` ya no solo registra la `shared` importada en sus propios metadatos — también la mete en `reactiveInits` (igual que cualquier otra reactive, para que LEERLA use la maquinaria de siempre). `generateClientBundle` emite, una vez por fichero, la conexión WebSocket + suscripción a cada nombre + aplicar cada `update` sobre `state`.
4. **Escritura desde cliente**: en vez de interceptar cada punto de compilación por separado (atributos, eventos, cuerpos de function — con el riesgo real de olvidar alguno), una única pasada de texto (`rewriteSharedAssignments`) sobre el BUNDLE YA ENSAMBLADO, que convierte cualquier `state.nombre = EXPR;` en `__proposeShared("nombre", (EXPR));`.

**Dos bugs reales, encontrados con ejecución real, ninguno en el primer intento**:
1. **Difusión duplicada** — probado con un `watch()` que recorta valores por encima de 10: un `propose` de 999 llegaba como DOS mensajes `update` con el valor 10, no uno. Causa: la difusión no tenía su propia guarda de "¿esto ya se mandó?", así que tanto la reasignación original como la corrección en cascada del `watch()` la disparaban por separado, ambas viendo ya el mismo valor final. Arreglado con un mapa `sharedLastBroadcastValues`, paralelo al que ya existía para `watch()` pero independiente (una `shared` puede no tener ningún `watch()` y aun así necesitar esta guarda).
2. **`substituteReactive` no sustituía dentro de un operador de propagación** — detectado al probar el ejemplo real de la pizarra (`{ ...cursores, yo: {...} }`): la lectura `cursores` dentro del `...` se quedaba sin convertir a `state.cursores`. Causa: la exclusión para no reescribir un acceso a propiedad ya cualificado (`foo.cursores`) miraba "¿hay un punto justo antes?" sin más — y `...cursores` TAMBIÉN tiene un punto justo antes (el último de los tres), así que caía en la misma exclusión por accidente. Es un bug preexistente, sin relación con `shared`, que nunca se había disparado porque nada en la suite combinaba antes una reactive con un spread. Arreglado con una exclusión más precisa (`\w\.` — una LETRA seguida de punto — en vez de "cualquier punto").

**Un despiste propio, no de diseño**: al renombrar `wireOnlineFunctionsRpc`, dejé el `module.exports` apuntando al nombre viejo — el módulo entero fallaba al cargarse (`ReferenceError`), lo que tumbó 75 tests de golpe al ejecutar la suite. Detectado y corregido en el acto.

**Un tropiezo al explorar a mano, ajeno al código**: la primera prueba de dos pestañas con JSDOM se quedó colgada sin dar salida — `server.close()` no cierra las conexiones WebSocket ya abiertas, así que el proceso nunca terminaba por su cuenta. Solucionado añadiendo un `process.exit(0)` explícito en la exploración manual; en los tests de verdad, cada conexión se cierra explícitamente antes de terminar, así que no hizo falta.

**Corrección al diseño original, no solo al código**: se había decidido que `watch()` solo debía dispararse por un `propose` entrante, nunca por "el valor cambió desde cualquier otro sitio" — pensado como salvaguarda contra bucles. Al implementarlo resultó innecesario: `watch()` YA generaliza a cualquier reasignación (descubierto en la entrada anterior), y reutilizar ESE mecanismo tal cual — ya protegido contra bucles — es exactamente lo que hace falta, sin restringir nada más.

**Verificado con ejecución real, de extremo a extremo**: WebSocket real para todo el protocolo de servidor (`subscribe` da el valor actual de inmediato; `propose` llega también a quien lo mandó; un `watch()` que corrige difunde el valor corregido una sola vez; una `shared` sin ningún `watch()` se difunde igual; `online function` y `shared` conviven en la misma conexión); generación de cliente (conexión, suscripción, aplicar `update`, reescritura de una escritura simple y de una escritura-con-lectura-propia); y JSDOM + servidor real con DOS PESTAÑAS INDEPENDIENTES — una hace clic, la otra se entera sola, sin recargar ni tocarla.

**Pruebas**: 17 nuevas — `tests/codegen-server-shared-reactive.test.js` (9), `tests/codegen-client-shared-reactive.test.js` (6), `tests/shared-reactive-e2e.test.js` (2, E2E real con JSDOM). 17 de 19 fallan contra el código anterior (las 2 que no fallan son "NO REGRESIÓN": comprobaban que SIN la funcionalidad no pasaba nada de más, que ya era cierto). Suite completa: **646/646** (629 + 17).

**Con esto, `shared reactive` queda implementado de extremo a extremo.** Límites conocidos, explícitamente sin resolver: el relevo entre workers por IPC (`cluster-workers`); operadores de asignación compuestos (`+=`, `++`) sobre una `shared`; una propuesta mandada antes de que el WebSocket termine de abrirse se pierde en silencio, sin cola ni reintento.
