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
| `WSON.send(instancia)` | ✅ | ✅ | Real. Servidor: guarda sesión + responde HTTP. Cliente: `fetch()` real contra `location.href`. `to` como array: envío paralelo con fallo aislado por destino (probado). **Bug real encontrado y corregido**: mandaba siempre un `body`, incluso con `via: "GET"` — en cliente esto hacía que `fetch()` lanzara `TypeError` directamente (GET/HEAD no pueden llevar body, lo prohíbe el propio estándar), así que `WSON.send()` con GET **no funcionaba en absoluto**; en servidor (que usa `http.request` de Node, no `fetch`) no reventaba, pero mandaba un body que muchos proxies/balanceadores reales descartan. Corregido en los dos lados: sin body en GET/HEAD, y el `content` se traduce automáticamente a **query string** (`?nombre=Ana&edad=30`) en vez de perderse — probado de extremo a extremo con cliente real (`fetch` de Node) y servidor a servidor, incluida la firma (`secret`) verificando correctamente al firmarse sobre lo que de verdad se manda. Un `:param` en la URL de destino (p. ej. `/usuarios/42`) no tiene mecanismo propio — se construye el string tal cual, funciona igual en cualquier método. |
| `WSON.enqueue(instancia, opts)` | ✅ | ❌ | Real — fire-and-forget con reintento y backoff exponencial, probado con un destino que falla dos veces y entrega a la tercera. **Nunca tuvo test hasta ahora.** No existe en el `WSON` de cliente. |
| `WSON.listen(wson)` | ✅ | N/A | No es una función real en ningún runtime — es un patrón que el **parser** detecta en la propia declaración (`reactive any x = WSON.listen(...)`) y el compilador traduce a registro de ruta real. Llamarlo en cualquier otro contexto no funcionaría (no hay tal función). |
| `WSON.showContent(inst, secreto)` | ✅ | ❌ | Real — descifra si `encrypt`, si no parsea el JSON tal cual. No existe en cliente (el cliente no declara `secret`/`encrypt`, están prohibidos ahí en compilación). |
| `WSON.verify(content, firma, secreto, marca)` | ✅ | ❌ | Real, `timingSafeEqual`, con ventana de validez de 5 min. |
| `WSON.parse(args, headers, secreto, encrypt)` | ✅ (redundante) | ❌ | **Bug real encontrado y corregido**: si había `secret` pero no `encrypt`, intentaba descifrar contenido que solo estaba firmado, y `content` salía `null` siempre. Corregido separando ambos flags. Sigue siendo **redundante en la práctica**: `WSON.listen()` ya hace este mismo trabajo automáticamente sobre cualquier petición entrante, sea o no "WSON de verdad" — no hace falta llamarlo a mano salvo que se quiera parsear algo fuera del flujo de `WSON.listen()`. |
| `WSON.getSignature/getTimestamp/getToken(headers)` | ✅ | ❌ | Reales, ya probados. |
| `WSON.showToken(token)` | ✅ | ❌ | Real — decodifica (no verifica) un JWT, ya probado. |
| `WSON.params(inst)` / `WSON.query(inst)` | ✅ | N/A | Reales — leen `:params`/query string de la petición actual, dentro de `watch()`. Concepto solo de servidor. |

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
    ├── codegen-wsdb.js   — AST de un .wsdb -> clase de colección real (save/find/findOne/delete, sobre SQLite real)
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
