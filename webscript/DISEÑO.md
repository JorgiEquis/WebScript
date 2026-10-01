# WebScript

WebScript es un lenguaje de programación que unifica el desarrollo de HTML/CSS/JS sobre Node.js, con tipado, reactividad y un sistema propio de mensajería estructurada (WSON).

Esta versión introduce una reescritura importante centrada en potenciar la programación orientada a objetos y separar de forma explícita front-end y back-end.

## Estructura de ficheros

| Extensión | Propósito |
|---|---|
| `.wsf` | WebScript Front — visuales, estilos, lógica de cliente |
| `.wsb` | WebScript Back — lógica de servidor, recepción de peticiones |
| `.ws`  | Lógica compartida entre front y back (no se ejecuta directamente ni en `.wsf` ni en `.wsb`); se consume mediante `import`/`export` nativo de JS |
| `.wson` | Definición de esquemas DTO basados en WSON |

## Front-end (.wsf)

Define visuales y estilos:

```
visual app1 = <div class=estilo>Hola<button onclick=sendInfo()>Pulsa</button></div>

style estilo = -> background-color: blue
			   -> color: red
```

Renderizado mediante `Visual.render(app1)`, que solo puede invocarse una vez por frontal. Un `.wsf` que lo llama es una **página**; uno que no, es un **componente/librería** pensado para importarse desde otro `.wsf` — la misma distinción que ya existía con `render()`/`route()`, solo que ahora la marca es `Visual.render()`. No es un error carecer de él, es lo que permite que `contador.wsf` (por ejemplo) sea un componente reutilizable en vez de una página suelta.

`class={estilo}` acepta cualquier expresión, no solo referencias estáticas a un `style` — el nombre de un `style` ya es literalmente su clase CSS, así que no hace falta ningún *lookup* en tiempo de ejecución.

**`Visual.route(patron)`/`Visual.params(instancia)`/`Visual.query(instancia)`**: sustituyen a `useRoute()`. Misma API estática que `WSON` — instancia como argumento, nunca `instancia.metodo()`:

```
const Visual screen = Visual.route('/personas/:id')
const {id} = Visual.params(screen)
const {tab} = Visual.query(screen)
```

`Visual.route()` se declara al principio del script, sin cuerpo — solo compara el patrón contra la URL actual. Es reactivo: si la URL cambia (por `Visual.navigate()` o por el atrás/adelante del navegador), `id`/`tab`/cualquier cosa derivada de `Visual.route()` se actualiza sola, sin recargar la página — es una declaración puramente de cliente, independiente de si hay un `WSON.listen()` sirviendo esa misma URL en el `.wsb` (no se validan cruzadas entre sí, ver más abajo).

**`Visual.navigate(url, opts)`**: navega sin recargar la página — `history.pushState()` (o `replaceState()` con `{ replace: true }`) más lo necesario para que `Visual.route()`/`params()`/`query()` se actualicen solos donde se usen. Un `<a href="...">` interno normal (mismo origen, sin `target`/`download`/`rel="external"`, ni ancla `#` de la propia página) ya navega así automáticamente, sin `onclick` — el clic se intercepta solo. `Visual.navigate()` sigue haciendo falta para navegar de forma programática (fuera de un clic en un enlace).

**`Visual.staticPaths(instancia, valores)`**: solo tiene efecto en páginas con `:params` en su `Visual.route()`. Mismo criterio que `Visual.params()`/`Visual.query()` — la instancia de `Visual.route()` como primer argumento. `valores` es un array de objetos **ya resuelto en tiempo de compilación**, uno por cada combinación de `:params` a pre-renderizar como `.html` real — típicamente importado de un `.json`:

```
const Visual screen = Visual.route('/blog/:slug')
import posts from "./posts.json"
Visual.staticPaths(screen, posts)
```

`import nombre from "ruta"` (sin llaves) liga el contenido **entero** de un `.json` a `nombre` — se embebe como `const` literal en tiempo de compilación (JSON válido es JS válido), tanto en el bundle de cliente como en cualquier build; no es un `require()` en tiempo de ejecución. `import { campo } from "ruta"` (con llaves) liga solo esa propiedad del objeto JSON. Dado que `valores` es un valor ya resuelto (no una función a ejecutar), no hace falta ningún cuerpo aparte ni esperar nada — ni siquiera entra en juego "Async/await implícito" aquí. `websc build` se ejecuta una sola vez, en Node, y genera un `.html` real por cada combinación; la ruta dinámica original sigue registrada como respaldo, por si se visita una combinación que no estaba en la lista — así una página nueva, aún no incluida en el build, sigue respondiendo por SSR en vez de dar un 404 sorpresa.

## Control de flujo en `visual`: `if`/`for`

Condición entre paréntesis, cuerpo por indentación, sin delimitadores de cierre — igual que el resto del lenguaje:

```
if (contador == 0)
	<p>Aun no hay clicks</p>
else if (contador < 3)
	<p>Vas por buen camino</p>
else
	<p>Ya son muchos clicks</p>

for (fruta in lista)
	<li>{fruta}</li>
```

- Si la condición (o la lista) depende de una `reactive`, el bloque se re-renderiza solo en esa posición del árbol (sustitución directa, sin virtual DOM) cada vez que cambia.
- `for` hace diffing por clave — reutiliza nodos DOM existentes en vez de reconstruir toda la lista en cada cambio.
- Puede anidarse sin límite, y vivir dentro de un tag abierto que se cierra después del bloque.
- **Reactividad profunda**: mutar una propiedad anidada (`datos.campo = x`) o un array (`.push()`, `.filter()`, spread) dispara la actualización igual que reasignar la variable entera — no hace falta reconstruir el objeto/array completo para que se entere.

## Composición de `visual`: `props` y `<slot />`

Un `visual` puede usarse como tag dentro de otro — el compilador detecta que el nombre coincide con un `visual` declarado y, en vez de crear un elemento HTML, lo instancia:

```
visual panelTarjeta =
<div class={tarjeta}>
	<h3>{props.titulo}</h3>
	<slot />
</div>

visual app =
<panelTarjeta titulo="Panel de control">
	<contador />
</panelTarjeta>
```

- **`props`**: los atributos puestos en el tag-componente (`titulo="..."`) llegan como objeto `props` al `visual` referenciado — `{props.titulo}` en la plantilla, `props.algo` también en bindings/handlers.
- **`<slot />`**: marcador dentro del `visual` hijo donde se inserta lo que el que lo usa puso entre sus etiquetas de apertura/cierre. El contenido pasado se resuelve en el **scope del padre**, no del hijo que lo recibe — si dentro lleva una interpolación (`<tarjeta><p>{contador}</p></tarjeta>`), `contador` se busca en las variables del padre, no en las del hijo. Soportado tanto en cliente como en SSR/SSG.
- **Slots con nombre**: `<slot name="header" />` define un hueco con nombre; en el contenido pasado, un hijo de nivel superior con el atributo `slot="header"` va a ese hueco en concreto. Cualquier contenido pasado **sin** atributo `slot` cae en el `<slot />` sin nombre — el "por defecto". Si el hijo no define ningún `<slot />` en absoluto, cualquier contenido pasado (con o sin nombre) se ignora.

```
visual tarjeta =
<div class={estiloTarjeta}>
	<header><slot name="header" /></header>
	<div class={cuerpo}><slot /></div>
</div>

visual app =
<tarjeta>
	<h3 slot="header">Personas</h3>
	<ul>
		for (p in personas)
			<li>{p.nombre}</li>
	</ul>
</tarjeta>
```

Aquí `<h3 slot="header">` va al hueco `header`; la `<ul>` (sin `slot`) va al hueco por defecto.
- **No hay estado local por instancia** — todo `reactive` es global. El caso de "una lista con estado independiente por elemento" (una tarea marcable, un contador por tarjeta) se resuelve guardando ese estado **dentro del propio dato** (`item.completada`, no en un array paralelo indexado por posición), y pasando el elemento como prop:

```
reactive contadores = [{ valor: 0 }, { valor: 0 }]

visual contadorItem =
<div>
	<button onclick={props.item.valor++}>Sumar</button>
	<p>{props.item.valor}</p>
</div>

for (item in contadores)
	<contadorItem item={item} />
```

Mutar `props.item.valor` muta el objeto compartido dentro de `contadores` — la reactividad profunda ya lo detecta, y el diffing por clave del `for` mantiene cada instancia asociada a su elemento aunque la lista se reordene (el estado viaja pegado al dato, no a una posición).

## Async/await implícito

Nunca hace falta escribir `async`/`await` en ningún cuerpo de función. El compilador detecta, con un algoritmo de punto fijo sobre el grafo de llamadas, qué funciones necesitan ser asíncronas (las que llaman directa o transitivamente a algo que sí lo es) y compila el resto como funciones normales — seguras de usar dentro de interpolaciones sin devolver una promesa sin resolver.

## Back-end (.wsb)

Se eliminan las declaraciones `server function`, `http function` y `ws function`. Toda entrada de tráfico pasa por `WSON.listen()`, asignado a una `reactive` que se procesa en su propio `watch()`:

```
const WSON wsonPost = -> to: xxxx -> from: yyyy ...
reactive any respuesta = WSON.listen(wsonPost)

watch(respuesta)
	// se ejecuta con cada petición entrante que coincide con wsonPost
	// si el content venía cifrado: WSON.showContent(respuesta, secreto)
	// WSON.httpSend(respuesta, código) responde la petición entrante —
	// no es una llamada saliente nueva (eso es WSON.send, sin "http");
	// ni el código ni httpSend() son obligatorios — sin él, 200 por defecto
```

`WSON.listen(wson)` lee la estructura del WSON y valida que `via` (method) y `to` coincidan con la petición entrante:

- **`to`**: endpoint + params de ruta (`/getEjemplo/:id`). Cualquier segmento `:algo` se trata como comodín a efectos de matching y de la validación de colisiones — el nombre del parámetro no importa, solo su posición en la ruta. Se captura con `WSON.httpParams(peticion)` dentro del `watch()`.
- **`via`**: method — GET, POST, PUT o DELETE, todos tratados igual: pasan por `watch()`, y si no se llama a `WSON.httpSend()` al final, se responde 200 por defecto. GET ya no tiene un caso especial ("ejecutar el script tal cual") — se unificó bajo `WSON.listen()`, lo cual lo mete gratis en la misma validación de colisión de rutas que el resto de métodos (antes, un GET vía `useRoute()` y un `WSON.listen()` con la misma URL nunca se comparaban entre sí).
- La **query string no forma parte de `to`** — no identifica una ruta distinta, solo filtra/parametriza la misma ruta.
- **`WSON.httpQuery(peticion)`** y **`WSON.httpParams(peticion)`**: única vía de acceso a query string y params de ruta dentro del `watch()` — estáticos, como toda la API de `WSON`; se les pasa la instancia recibida. `null` si la petición no trae params/query, o si la instancia ni siquiera viene de una petición HTTP — nunca un `{}` silencioso que esconda la diferencia entre "no hay" y "no aplica". No hay inyección automática de esos valores en el content del WSON. (Antes se llamaban `WSON.params`/`WSON.query`, sin el prefijo `http` — ver sección "`WSON.httpSend`..." más abajo para el motivo del rename.)
- **Al lado contrario, enviando**: `GET`/`HEAD` no llevan body (lo prohíbe HTTP en sí) — si `WSON.send(instancia)` se llama con `via: "GET"` (o `"HEAD"`) y `content` es un objeto, se codifica automáticamente como query string sobre `to` en vez de perderse. Un `:param` en `to` no tiene mecanismo propio de sustitución — se construye el string ya resuelto antes de enviarlo, igual para cualquier `via`.
- **El descifrado no es automático** — si el WSON recibido está cifrado, hay que llamar a `WSON.showContent()` explícitamente dentro del `watch()`.

### `watch()` no es exclusivo de `WSON.listen()`

`watch(nombre)` observa **cualquier** `reactive` de nivel superior de un `.wsb` — `string`, `boolean`, un DTO, `tipo(array)`... no solo las atadas a `WSON.listen()`. La diferencia es solo **qué la dispara**:

- Una `reactive` atada a `WSON.listen()` se dispara por una petición HTTP real que encaje con su ruta (como hasta ahora).
- Cualquier otra `reactive` se dispara al **reasignarla**, venga de donde venga esa asignación — típicamente desde dentro de otro `watch()` (incluido el de una ruta). Si ese segundo `watch()` reasigna a su vez una tercera `reactive` con su propio `watch()`, se encadena — todo dentro de la misma petición que arrancó la cascada.

```
reactive boolean activo = false
var vecesActivado = 0

watch(activo)
	vecesActivado = vecesActivado + 1

const WSON wsonActivar = -> to: "/activar" -> via: "GET"
reactive any peticion = WSON.listen(wsonActivar)

watch(peticion)
	activo = true          // dispara watch(activo) en cascada
	peticion.content = { vecesActivado: vecesActivado }
	WSON.httpSend(peticion)
```

La `reactive` observada y su `watch()` pueden vivir en ficheros distintos — al importar una de otro `.wsb`, su `watch()` (si lo tiene en el fichero origen) viaja con ella; si no lo tiene, quien la importa puede declarar su propio `watch()` para ella en su lugar.

**Coherente con "Async/await implícito"** (más arriba): el disparo de un `watch()` de una `reactive` sin `WSON.listen()` SÍ se espera de verdad, sin que el usuario escriba `await` en ningún sitio — reasignar una `reactive` con `watch()` propio inyecta, en el propio código compilado, un `await` a la función que dispara ese `watch()`; si ese `watch()` reasigna otra con su propio `watch()`, se encadena, cada nivel esperando de verdad al siguiente. Un `WSON.send()`/`WSON.httpSend()` también se esperan aunque no sean la última sentencia del cuerpo — antes solo se esperaba si era la última. `WSON.enqueue()` es la única excepción, y a propósito: es fire-and-forget por diseño (esperar sus reintentos con backoff dentro de la misma petición sería contraproducente). Un `watch()` que falla no tumba la petición que arrancó la cascada — se registra, no se propaga.

**Validación:** no pueden registrarse dos `WSON.listen()` con el mismo endpoint + method — se valida en compilación para evitar colisiones silenciosas. Rutas con params dinámicos (`/ruta/:id` vs `/ruta/:otroNombre`) deben normalizarse para detectar la colisión aunque el texto no coincida.

Cada petición entrante se compara contra **todos** los `WSON.listen()` registrados, por `via` y `to` — de ahí que el WSON ad-hoc usado para escuchar deba compartir exactamente el mismo `to`/`via` que el `.wson` del DTO que se espera recibir: es lo que hace que un `Persona` enviado con `to: "/personas"` acabe disparando el `listen()` que escucha justo en `/personas`.

**Reactividad:** un WSON puede ser reactivo y capturar su contenido con `watch`, tanto en front como en back.

## POO: clases núcleo

- **`Visual.ws`** y **`WSON.ws`**: clases núcleo del runtime, invocables tanto de forma estática (`Visual.render(visual)`) como por instancia (`new Visual().render()`). `Visual.ws` es responsable también de SSR/SSG — el servidor devuelve HTML real desde la primera petición, no una concha vacía que rellena el cliente.
- Los DTOs generados desde `.wson` heredan siempre de `WSON` (`extends WSON`), sin herencia DTO-a-DTO.
- `WSON.ws` expone getters/setters genéricos para todos los campos definidos en el esquema; **el setter respeta la validación de tipo del esquema**, incluso al sobreescribir.
- `WSON.ws` autogenera un `id` en formato **UUID**, **en el momento de `.send()`** (no en la construcción), y ese campo es de solo lectura incluso vía el setter genérico.
- Sin campo `httpCode`: el código de estado HTTP se pasa como argumento explícito a `WSON.httpSend(wson, httpCode)`, no como propiedad mutable del WSON (ver sección siguiente). Sustituye por completo al antiguo `respond(status, cuerpo)`, que desaparece.

### `WSON.httpSend(wson, httpCode)` — separado de `WSON.send(wson)`

`WSON.send` tenía dos significados distintos según dónde se llamara: fuera de una ruta, "manda esto hacia `to`"; dentro del `watch()` de una ruta (`WSON.listen()`), "responde la petición entrante" — ignorando por completo `to`, aunque la instancia pasada tuviera uno propio. El mismo nombre, dos comportamientos, elegidos solo por el contexto en que aparecía.

**El bug real que esto escondía**: dentro del `watch()` de una ruta, un `WSON.send({ to: "http://otro-sistema/", ... })` genuino — pensado como llamada saliente de verdad, para notificar a un tercer sistema mientras se responde al cliente — nunca llegaba a su destino. Se resolvía como "responder la petición actual" con ese `content`, y el `to` se ignoraba en silencio; no había ningún error, ni un log, solo una petición que nunca salió. Reproducido contra el código anterior a este cambio antes de tocar nada: un servidor externo real con un contador de peticiones recibidas seguía en `0` tras la llamada.

**La corrección**: dos nombres para los dos roles.
- **`WSON.send(wson)`**: SIEMPRE la llamada saliente — la usa quien invoca, esté donde esté (`.wsf`, `function`, `watch()` de ruta o no). Siempre devuelve un WSON (la respuesta), nunca `undefined`.
- **`WSON.httpSend(wson, httpCode)`**: responde la petición HTTP entrante — solo tiene sentido dentro del `watch()` de una ruta (`WSON.listen()`), no existe fuera de ese contexto. No devuelve nada. `httpCode` es un argumento explícito (200 por defecto), no una propiedad del WSON.

Con los dos separados, un mismo `watch()` puede responder al cliente Y notificar a otro sistema sin que uno se coma al otro — cada llamada hace lo que su nombre dice, sin depender de en qué watch() se escriba.

Alternativa descartada: mantener un único `send()` y decidir su comportamiento inspeccionando si `to` coincide con el propio `WSON.listen()` de la ruta. Se descartó porque sigue siendo el mismo nombre para dos operaciones con contratos distintos (una devuelve algo, la otra no; una acepta cualquier `to`, la otra lo ignora), y porque un `to` que por casualidad no coincida con nada dejaría el comportamiento indefinido en vez de ser un error claro.

## Definición de DTOs (.wson)

El esquema se define dentro del bloque `content`, manteniendo el formato original de metadata (`->` al inicio de línea, `:` como separador clave-valor/tipo en todos los niveles):

```
-> from: "sistema"
-> to: "http://.../recibir"
-> via: "POST"
-> content:
	nombre: string
	edad: integer
	altura: decimal/
	mayorEdad: boolean
	direccion:
		numero: integer
		calle: string
	listaPropiedades: string(array)
```

- `/` al final de un tipo marca el campo como **opcional**.
- `object` anidado se declara por indentación, sin necesidad de la palabra clave (ver `direccion`).
- `tipo(array)` indica una lista de ese tipo (ver `listaPropiedades`).
- El content se parsea como JSON.
- **`to`/`via` son un destino real**, no solo metadata descriptiva: cuando se envía una instancia con `WSON.send()` (nunca `WSON.httpSend()`, que no mira `to` en absoluto — responde la petición actual), viaja de verdad a ese endpoint por ese method. Si coincide con el `to`/`via` de un `WSON.listen()` propio (mismo valor), el envío se recibe a sí mismo — así es como un `.wsf` habla con su propio `.wsb` sin ningún mecanismo especial: simplemente `to` apunta a la ruta de tu propio backend.

Instanciación desde `.ws`, `.wsf` o `.wsb`, **posicional**:

```
var Persona persona1 = new Persona(nombre, altura, mayorEdad, direccion, listaPropiedades)
```

Esta forma posicional es solo para DTOs generados desde un `.wson`. Un WSON declarado directamente en código, sin fichero `.wson` detrás, usa el bloque `->` en su lugar (ver sección de WSON más abajo).

## Tipado

Formato general:

```
var Clase/tipo nombre
```

Aplica tanto a clases definidas por el usuario como a tipos primitivos (`string`, `integer`, `decimal`, `boolean`...).

**Parámetros de función**: el mismo formato, por parámetro — opcional, se pueden mezclar tipados y sin tipar en la misma función:

```
function printHola(string arg1)
	return arg1

function saluda(string nombre, edad)
	return nombre
```

## Contenedores de lógica (.ws)

Los ficheros `.ws` (distintos de `.wsf`/`.wsb`) sirven como contenedor de funciones y variables reactivas que no pertenecen ni al front ni al back. Se importan y exportan con la sintaxis nativa de JS.

Las clases núcleo del propio lenguaje (`Visual.ws`, `WSON.ws`) viven en una carpeta `lib` normal dentro de cada proyecto — no es una ubicación especial ni protegida a nivel de sistema de ficheros, se referencian con import estándar como cualquier otro `.ws`.

**Protección de `lib`:** el compilador deniega **completamente** la modificación de estos ficheros (en vez de cifrarlos), comparando contra lo generado originalmente por el CLI, sin excepción ni flag para saltarse la validación. Mantiene el código legible y evita la complejidad de un cifrado/descifrado en cada carga.

**Un `.wsf` puede importar un DTO de un `.wson`** (`import { Persona } from "./persona.wson"`) igual que un `.wsb` — la clase se genera como texto JS embebido en el bundle (no la clase de Node que usa el servidor, que depende de `require()`), reutilizando `typeMismatch` del propio runtime de cliente para la validación. Mismo límite que cualquier `reactive` de tipo objeto en cliente: un campo anidado de tipo `object` no se valida en profundidad.

## Import de paquetes npm y de `.js` normal

Un specifier de `import` que no empiece por `.` ni `/` (`import { algo } from "chalk"`) se trata como un paquete de npm real (o nativo de Node, `"path"`, `"fs"`...) — se resuelve con la propia resolución de módulos de Node (camina por `node_modules` hacia arriba desde el fichero), no con las extensiones propias del lenguaje.

- **En servidor** (`.wsb`, y en las funciones que un `.wsb` importa de un `.ws`): es un `require()` real, sin ningún riesgo — Node ya sabe resolverlo, y el código corre en Node de todas formas.
- **En cliente** (`.wsf`): **rechazado explícitamente**, con un mensaje claro — no hay ningún bundler que resuelva las propias dependencias transitivas del paquete, e incrustar su código a ciegas podría producir un bundle roto de formas difíciles de prever. No es una limitación temporal a ignorar: es una frontera consciente entre "esto es seguro" (servidor) y "esto podría romperse en silencio" (cliente).

**Un `.js` normal, ya existente** (sin sus propias dependencias externas) sí se puede importar desde cualquiera de los dos lados — es la vía de adopción incremental: meter WebScript fichero a fichero dentro de un proyecto Node ya existente, sin reescribirlo todo de golpe. En servidor es un `require()` real; en cliente, su código fuente se incrusta tal cual en el bundle, envuelto en un módulo CommonJS aislado (`module.exports`/`exports`) — si ese `.js` a su vez importara o requiriera otra cosa, eso no se resuelve (sin bundler, solo se admite un fichero suelto).

`import nombre from "ruta"` (sin llaves) liga el `module.exports` **entero** a `nombre` — pensado para un paquete/fichero cuyo export es un único valor (`module.exports = fn`), coherente con cómo se consumiría con un `require()` normal. `import { a, b } from "ruta"` (con llaves) desestructura esos nombres del objeto exportado — pensado para un export con varias cosas (`module.exports = { a, b }`).

## Import entre `.wsb` (composición de rutas)

Un `.wsb` puede importar de otro `.wsb`, con el mismo `import`/`export` nativo de JS que ya usan los `.ws`. Dos casos:

- **Función o valor exportado**: se trae tal cual. Ver "Función exportada por un `.wsb`: qué estado ve" más abajo para lo que puede y no puede usar en su propio cuerpo.
- **Una ruta completa**: si lo que se exporta es una `reactive` que hace `WSON.listen(...)`, se trae consigo su `WSON` — quien la importa la sirve como si estuviera escrita ahí mismo. Su `watch()` viaja con ella SI lo tiene en el fichero origen (es opcional: quien importa puede declarar el suyo propio para esa misma `reactive` en su lugar — ver la sección de `watch()` generalizado, más arriba). Lo que esa ruta importada necesite (un DTO `.wson`, otra función) se resuelve contra la carpeta del fichero **origen** de la ruta, no la de quien la importa — así una ruta reutilizable no depende de dónde acabe usándose. El resto de estado de nivel superior del fichero origen (y los `watch()` de ese estado) viaja también, sin condición.

`export` no oculta nada dentro de su propio fichero: una ruta exportada se sigue sirviendo igual si nadie la importa, exactamente como en JS exportar algo no le impide seguir funcionando localmente.

### Función exportada por un `.wsb`: qué estado ve (resuelto)

Antes, una `function` exportada por un `.wsb` se compilaba SOLA y AISLADA — sin ver ni los imports de su propio fichero de origen (`doble is not defined` si usaba algo que ese `.wsb` importa) ni sus hermanas del mismo fichero (otro helper interno, u otra function exportada). No era un simple descuido de cableado: un `.wsb` de origen SÍ puede tener estado de servidor propio (`global`, sesión, rutas), así que "contra qué estado se compila" era una pregunta de diseño abierta — a diferencia de un `.ws`, que nunca tiene estado propio y por tanto no tenía esa ambigüedad.

**Diseño**: se resuelve como una entrada más del MISMO registro que ya usan los `.ws` (`getWsEntry`/`compileWsRegistry`, ver "Los imports de un `.ws`" más abajo) — mismo ámbito privado por fichero (resuelto contra la carpeta del `.wsb` de origen), mismo "todas las function del fichero se compilan juntas" (una exportada puede llamar a una hermana sin exportar, o a otra exportada). La diferencia con un `.ws` está en tres reglas nuevas, específicas de un origen `.wsb`:
- **Se compila SIEMPRE sin `global`** — nunca con el del `.wsb` raíz que importa, ni con uno inventado para el de origen. Darle el del raíz sería arbitrario y, peor, podría "funcionar" por casualidad si coincide un nombre, resolviendo mal en silencio.
- **Si una function ALCANZABLE (la pedida, o lo que ella llama, transitivamente) menciona por nombre una `reactive`/`var`/`const` de nivel superior de SU PROPIO fichero, es un error explícito al compilar** — la pregunta de diseño sigue sin resolverse, así que se rechaza con un mensaje claro (qué function, qué nombre, por qué) en vez de dejar que llegue a un `ReferenceError` confuso en producción. Solo se comprueban las alcanzables, no todas las del fichero — una hermana rota (que toca su propio estado) que nadie pidió ni se alcanza no tumba a las demás, mismo criterio que ya se aplicó a las constantes hermanas de un `.ws`.
- **Sus imports hacia OTRO `.wsb` no se resuelven** — encadenar otro `.wsb` reintroduciría la misma ambigüedad un nivel más allá. Se filtran esos import antes de resolver los demás (los normales — `.ws`, `.js`, `.wson`, `.wsdb`, un paquete — sí se resuelven con normalidad); si una function realmente lo necesita, falla en EJECUCIÓN con "X is not defined", tan claro como cualquier otro nombre sin resolver — no compila mal ni intenta una recursión silenciosa hacia el estado de un tercer servidor.

Alternativas consideradas:
1. **Compilarla con el `global` del `.wsb` RAÍZ que la importa** (tratarla como si estuviera escrita ahí) — descartada: acoplaría el comportamiento de una function reutilizable a quien la importe cada vez, y un nombre que coincida por casualidad con una `global` del raíz resolvería sin avisar, de forma potencialmente incorrecta.
2. **Traer consigo el estado `global` de su propio fichero de origen** (splicing, como ya se hace con una ruta completa importada) — descartada por ahora: mezclaría el `global` de DOS ficheros distintos en un mismo servidor, con el riesgo de colisión de nombres que ya motivó descartar el aplanado de imports de un `.ws` (ver esa sección). Es la opción más parecida a "resolver el hueco del todo", pero exige antes decidir esa colisión — dejado documentado como el siguiente paso natural si hiciera falta.
3. **Prohibir compilar del todo una function exportada que toque su propio estado, en vez de comprobarlo solo en lo alcanzable** — descartada: rompería innecesariamente un `.wsb` que exporta una mezcla de funciones (algunas con estado propio, otras sin él), igual que se descartó para las constantes hermanas de un `.ws`.


## CLI (`websc init`)

Comando para generar un proyecto WebScript desde cero, incluyendo:
- La carpeta `lib` con las clases núcleo del lenguaje
- El compilador
- El resto de dependencias necesarias de WebScript

## Constantes

Se mantienen sin cambios: `const`.

## Eliminado en esta versión

- `WSON.history()` (incluida la detección de duplicados por id que dependía de él — ver más abajo)
- Declaraciones `server function`, `http function`, `ws function`
- Los bloques con nombre `server:` / `cliente:` (sustituidos por la separación `.wsf` / `.wsb`)

## Configuración de proyecto

`wconfig.json` se mantiene, con estas claves por ahora:

```json
{
	"port": 3000,
	"rate-limit-max": 300,
	"rate-limit-window-ms": 60000,
	"stylesheets": ["https://cdn.jsdelivr.net/npm/bootstrap@5/dist/css/bootstrap.min.css"]
}
```

- **`port`**: 3000 por defecto si no se informa.
- **`rate-limit-max`** / **`rate-limit-window-ms`**: límite de peticiones por IP en una ventana fija. `rate-limit-max: 0` desactiva el límite (para quien prefiera ponerlo delante, en un proxy real).
- **`stylesheets`**: hojas de estilo externas (Bootstrap y similares) a incluir en el proyecto.

## Sesiones

El estado por visitante vive en los `var`/`reactive` declarados dentro de un `.wsb` — ya no hace falta el prefijo `server`, lo da la propia extensión del fichero. Expiran por inactividad, con un límite máximo de sesiones y desalojo LRU, y cookie `Secure` condicional (activa si el servidor está detrás de un proxy con terminación TLS real).

## Base de datos: `.wsdb`

Un nuevo tipo de fichero, paralelo a `.wson` pero para colecciones persistentes (no mensajes puntuales) — mismo formato de líneas `-> clave: valor`, con `-> schema:` en vez de `-> content:` para el esquema de campos. Cabecera (`-> name:`, `min`/`max`/`depends`), campos con longitud y clave primaria, y una API de consulta propia del lenguaje: todo detallado en la subsección siguiente. Un `.wsdb` genera dos clases (`<Nombre>` y `<Nombre>Schema`), y el import las pide por ese nombre exacto. El constructor y cada reasignación posterior (`persona.edad = "texto"`) validan el tipo declarado, reutilizando la misma `validateField` de los DTO — no es una capa aparte, es la misma validación del resto del lenguaje.

**Solo tiene sentido en servidor.** Un `.wsdb` importado desde un `.wsf` se rechaza explícitamente, con mensaje claro — el navegador no tiene forma segura de hablar con una base de datos directamente (mismo criterio que un paquete de npm en cliente).

**Motor: SQLite real, compilado a WebAssembly (`node-sqlite3-wasm`), no un binario nativo.** La alternativa obvia, `better-sqlite3`, exige compilación nativa (rompe "todo vendorizado, cero instalación"). La alternativa WASM más conocida, `sql.js`, no sirve para esto: no tiene persistencia incremental en disco — cada escritura exige serializar y reescribir la base de datos **entera**, un coste que crece con el tamaño total de la base, no con el cambio. `node-sqlite3-wasm` resuelve las dos cosas a la vez: es WASM puro (nada que compilar, vendorizable tal cual, sin binarios por plataforma) y tiene una VFS real que traduce el acceso a fichero de SQLite a `fs` de Node — persistencia incremental de verdad, confirmada escribiendo desde un proceso y leyendo el mismo fichero desde OTRO proceso sin cerrar el primero.

Cada campo del esquema es una columna SQLite real (no un blob JSON) — un tipo primitivo (`string`/`integer`/`decimal`/`boolean`) mapea a su columna nativa; cualquier otro tipo (`object`, `tipo(array)`) se guarda como `TEXT` con el valor en JSON. Una única conexión por fichero de base de datos, compartida entre todas las colecciones que la usen (varias tablas en un mismo fichero `.wsdb-data/webscript.db`, junto al proyecto — no configurable todavía, fijo y sencillo en esta primera versión).

### `-> name`, dos clases, y consultas con condiciones reales

Límites de registros, longitudes, clave primaria y una API de consulta propia del lenguaje:

```
// personas.wsdb
-> name: 'persona'
-> min: 10                            // mínimo de registros (opcional)
-> max: 20                            // máximo de registros (opcional)
-> depends: ['coches', 'trabajadores']// (opcional; ver "pendiente" abajo)
-> schema
     -> idPerson: integer(10)(primary) // longitud; clave primaria
     -> edad: integer(5)
     -> nombre: string(40)/            // "/" = opcional, igual que en .wson
     -> mayor: boolean                 // boolean no admite longitud
     -> altura: decimal(2,3)           // 2 dígitos enteros, 3 decimales
```

`-> name: 'persona'` genera **dos clases**, y el import tiene que pedirlas por ese nombre exacto:

- **`Persona`** — datos: `new Persona(json)`, `Persona.save()`, `selectAll()`, `select()`, `delete()`, `deleteWhere()`.
- **`PersonaSchema`** — `PersonaSchema.getSchema()` devuelve `{ idPerson: 'idPerson', nombre: 'nombre', ... }`: referencias a campo para las consultas.

Ninguna de las dos clases genera un fichero propio en `lib/` — su API es la misma para cualquier colección, así que se documenta una sola vez con dos interfaces fijas (plantillas de `websc init`/`update`, protegidas por el mismo lock que `WSON.ws`/`Visual.ws`): `Persona` **implementa** `WSDB` (`lib/WSDB.ws`: `save`, `selectAll`, `select`, `delete`, `deleteWhere`) y `PersonaSchema` **implementa** `WSSchema` (`lib/WSSchema.ws`: `getSchema`). Lo único que cambia entre un `.wsdb` y otro son sus campos concretos — la forma de la API no.

```
import { Persona, PersonaSchema } from "./personas.wsdb"

const PersonaSchema personaSchema = PersonaSchema.getSchema()

const Persona[] todas    = Persona.selectAll()                       // SELECT * -> instancias reales de Persona
const nombres            = Persona.select(personaSchema.nombre)      // SELECT nombre -> JSON plano (proyección parcial, ver más abajo)
const Persona[] filtro   = Persona.selectAll()
	.where((personaSchema.edad > 10 && personaSchema.nombre != 'Juan') || personaSchema.mayor)
	.sortAsc(personaSchema.nombre)                                   // y/o .sortDesc(...)

const Persona guardada = Persona.save(new Persona(json))   // INSERT o UPDATE según la primary — devuelve una instancia real
Persona.delete(guardada)                                    // por clave primaria
Persona.deleteWhere(personaSchema.edad < 18)                // por condición
```

**`.where()` es una condición real, no un valor.** Evaluado como JS normal, `personaSchema.edad > 10` sería `"edad" > 10` — `false` — antes de llegar a `where()`. Por eso el compilador reescribe el argumento de `.where()` y `.deleteWhere()` en tiempo de compilación: cada comparación (`> >= < <= == != === !==`), `&&`, `||` y `!` pasa a un helper que, **si hay una referencia a campo implicada**, construye la condición SQL (parametrizada); si no la hay, devuelve exactamente lo mismo que la expresión JS original, cortocircuito incluido. Así se pueden mezclar variables normales (`personaSchema.edad > minimo`) y un `.where()` de cualquier otra librería no cambia de comportamiento. Reglas de traducción: `== null` → `IS NULL`; un campo suelto (`|| personaSchema.mayor`) solo vale para `boolean` (en otro tipo es un error: se pide comparación explícita); los strings entre comillas son siempre valores, nunca nombres de campo.

**`selectAll()`/`save()` devuelven instancias reales de `Persona`** — usables tal cual con `.save()`/`.delete()` posteriores, o para leer/escribir sus campos con los getters/setters del propio DTO, sin reconstruirlas a mano. `select(...campos)` (una proyección PARCIAL, menos columnas que el esquema completo) devuelve en cambio **JSON plano a propósito, nunca instancias**: una instancia a la que le faltan campos, si se guardara con `save()`, sobrescribiría esos campos ausentes con `NULL` en la base de datos real — confirmado con un caso real antes de decidir esto: un campo opcional ausente de la proyección se guardaba como `NULL` en silencio. `save()` rechaza explícitamente un resultado de `select()` con un error claro si se intenta, en vez de dejar que ocurra sin avisar. `delete()` sí admite un parcial de `select()` sin problema, siempre que incluya la clave primaria — borrar no escribe columnas, así que no hay nada que se pueda pisar. La consulta es perezosa en los dos casos: `selectAll()`/`select()` no lanzan nada hasta que se usa el resultado (su `length`, un índice, `map`, `JSON.stringify`...), así que encadenar `.where()`/`.sortAsc()`/`.sortDesc()` antes de usarlo no recorre antes la tabla entera.

**`save()` es upsert por clave primaria.** Exactamente un campo `(primary)`, `integer` o `string`. Un `integer(primary)/` (opcional) se autonumera si no se informa.

**Longitudes**: `string(n)` = caracteres; `integer(n)` = dígitos; `decimal(e,d)` = dígitos enteros y decimales — ojo: distinto del `DECIMAL(p,s)` de SQL, donde el primer número es la precisión total. Un decimal se **redondea** a sus decimales (como en SQL) en vez de rechazarse — en coma flotante `0.1 + 0.2` no es `0.3`, y exigir igualdad exacta haría fallar valores legítimos. Se valida en el constructor y en cada reasignación.

**`min`/`max`**: `max` impide insertar (actualizar sí se puede); `min` impide un borrado que dejaría menos registros (dentro de una transacción: o se borra todo lo pedido o nada).

### `.after(fn)` tras `save()`, `after` como parámetro en `delete()`/`deleteWhere()` — no la misma sintaxis, a propósito

`save()` admite encadenar `.after(fn)` (`Persona.save(x).after(fn)`) porque siempre devuelve una instancia real — un objeto, así que añadirle un método más no cambia nada de lo que ya se puede hacer con lo que devuelve. `fn` se llama con la propia instancia guardada, fire-and-forget: si lanza o rechaza, se avisa por consola y NO deshace ni bloquea el `save()`, que ya se completó. Devuelve la instancia (no lo que devuelva `fn`), así que `.after(a).after(b)` encadena las dos. `fn` puede ser una `function` o una `online function` — no hace falta nada especial para eso: `online` es aditivo, se sigue comportando como una función normal en local.

`delete()`/`deleteWhere()` reciben en cambio `after` como un **segundo argumento**, no un método encadenado — y la razón no es solo estilo. Estos métodos devuelven un número primitivo (cuántos registros se borraron), a propósito, para que `if (Persona.deleteWhere(cond))` siga significando "se borró algo". Envolver ese número en un objeto para poder colgarle un `.after()` lo haría **`truthy` siempre**, incluso con 0 registros borrados — en JS todo objeto es verdadero en un `if`, sin importar lo que devuelva su `valueOf()`. Confirmado con código real antes de descartarlo: `!!(new Number(0))` es `true`. Es el mismo tipo de trampa silenciosa que ya se ha evitado antes en el lenguaje (el estado global sin `global` explícito, `select()` haciéndose pasar por un DTO completo) — aquí se evita no forzando la sintaxis de encadenado donde el tipo de retorno no lo permite sin coste.

**Nota de implementación real, encontrada al construir esto**: `rewriteWhereCalls()` (la reescritura de `.where()`/`.deleteWhere()` a SQL) tenía un guard que exigía EXACTAMENTE un argumento para reescribir la condición — al añadir `after` como segundo argumento de `deleteWhere()`, la condición dejaba de reescribirse y se evaluaba como JS normal contra un `FieldRef`, siempre falsa. Corregido para admitir uno o dos argumentos en `deleteWhere()` específicamente (`.where()` sigue exigiendo exactamente uno, no tiene segundo parámetro). Detalle y tests en `INSTRUCCIONES.md`.

**Evolución de esquema**: un campo nuevo en el `.wsdb` se añade como columna a la tabla existente. Un campo obligatorio nuevo sobre una tabla con datos es un error explicado (no hay valor posible para las filas existentes).

**`-> depends`: actualización en cascada simulada (no una clave foránea real).** Al declarar `-> depends: ['coches', 'trabajadores']` en `personas.wsdb`, cada `Persona.save()` que sea una **actualización** (no una inserción — no hay "antes" contra el que buscar) intenta propagarse a `coches.wsdb` y `trabajadores.wsdb`:

1. Por cada dependencia, se calculan los **campos compartidos**: los que tienen el mismo nombre Y el mismo tipo base en las dos colecciones (la longitud/opcionalidad no hace falta que coincidan). Sin ningún campo compartido, la cascada nunca podría hacer nada — se avisa una vez, al cargar el `.wsdb`.
2. Si al menos un campo compartido ha cambiado de valor (comparando el registro **antes** y **después** del `UPDATE`), se busca en la colección dependiente el o los registros cuyos campos compartidos coincidan con los valores **anteriores** — y a esos se les aplican los valores **nuevos** de esos mismos campos, en una única sentencia `UPDATE ... WHERE campo1 = ? AND campo2 = ? ...` (todos los compartidos a la vez, no uno por uno).
3. Si ningún registro coincide, o la colección dependiente falla por cualquier motivo (su tabla no existe todavía, un tipo incompatible...), se avisa por consola (`console.warn`) y el `save()` de la colección principal **se completa igualmente** — la cascada nunca hace fallar la operación que la disparó.

Es una simulación deliberadamente simple, sin integridad referencial real: no hay bloqueo, ni transacción conjunta con la colección principal, ni cascada en el borrado (`delete()`/`deleteWhere()` no propagan nada todavía), ni encadenamiento — si `coches.wsdb` tuviera a su vez su propio `-> depends`, guardar una `Persona` NO dispara una segunda cascada a través de `coches`; solo se cascada un nivel, hacia las colecciones nombradas directamente.

**Limitación real a tener en cuenta al diseñar los esquemas**: el emparejamiento es por nombre + tipo, sin ningún control semántico. Si `coches.wsdb` tuviera su propio campo `nombre` (el del coche, no el del dueño), coincidiría igualmente por nombre+tipo con el `nombre` de `persona` y entraría en el `WHERE` combinado de la cascada — con lo que un cambio de nombre de una persona podría dejar de encontrar sus coches (porque el `nombre` del coche no coincide con el de la persona), aunque el verdadero enlace (`idPerson`) sí sería válido por sí solo.

**La forma de evitarlo es de diseño de esquema, no de código**: nombrar cada campo por lo que representa, no por su tipo genérico — `nombrePersona` en `persona` y también en `trabajador` (si de verdad hay que sincronizarlos), y `nombreCoche` en `coche` en vez de un `nombre` ambiguo repetido en las tres. Así, compartir nombre+tipo entre dos `.wsdb` deja de ser un accidente y pasa a ser exactamente la señal que activa la cascada: cada campo que se llama igual en dos colecciones nombradas en `-> depends` es una decisión consciente de que esas dos cosas deben ir enlazadas o sincronizadas, nunca una coincidencia. Esta disciplina de nombres — más específicos que genéricos — es la recomendación general para cualquier `.wsdb` que participe en `-> depends`, no un caso especial.

## Seguridad: CSRF

Protección con cookie de doble envío (`wcsrf` + cabecera `X-WebScript-CSRF`), verificada en tiempo constante. La primera petición de una sesión completamente nueva no exige el token (una sesión recién creada no es algo que un atacante pueda secuestrar).

**Alcance:** CSRF solo se comprueba en peticiones que ya traen cookie de sesión de WebScript (en la práctica, llamadas desde `.wsf` propio o entre sistemas que también son WebScript y comparten ese mecanismo de sesión). Un sistema externo que no usa WebScript no tiene esa cookie, así que no pasa por la comprobación — su autenticidad depende de `secret`/`encrypt` de WSON si la necesita. Es una separación por diseño: **CSRF protege sesiones de navegador**, **la firma/cifrado de WSON protege autenticidad entre sistemas** — no se sustituyen entre sí, y un sistema no-WebScript sencillamente no entra en el primer mundo.

### Formato antiguo `-> collection:` — eliminado

El primer formato de `.wsdb` (`-> collection: "usuarios"`, con `new Usuario(...).save()`, `find({ edad: { gt: 18 } })`, `findOne`, `findById`, `deleteMany`) convivió un tiempo con el actual y se ha eliminado: hoy todo `.wsdb` declara `-> name:`.

**Por qué**: el formato nuevo cubre todo lo que hacía el antiguo (guardar, consultar, borrar) y más (límites, longitudes, clave primaria propia, `-> depends`, condiciones reales en vez de objetos de consulta), así que mantener los dos duplicaba código, tests y documentación sin dar nada a cambio. Además el formato antiguo tenía las dos costuras más incómodas: sus consultas eran objetos (`{ "campo": valor }`) cuyas CLAVES llegaban al SQL — hubo que parchear una inyección real con una lista de columnas permitidas — mientras que en el actual una condición se construye siempre desde referencias a campo (`personaSchema.edad > 18`), sin ninguna clave de texto libre.

**Qué pasa con un `.wsdb` antiguo**: se rechaza con un error que dice cómo migrarlo, tanto al parsearlo como al importarlo desde un `.wsb`, al validarlo con `websc build` (falla con código de salida 1 nombrando el fichero) o al nombrarlo en un `-> depends`. Sin `-> name:` (y sin `-> collection:`) el error es otro, más corto: el nombre es obligatorio.

| Formato antiguo | Formato actual |
|---|---|
| `-> collection: "usuarios"` | `-> name: 'usuario'` |
| campos `nombre: string` | igual de válido (la flecha `->` es opcional); ahora además admite longitud, p. ej. `nombre: string(40)` |
| `id` autogenerado, implícito | `id` declarado: `-> id: integer(10)(primary)/` (la `/` final lo hace opcional al guardar, y entonces se autogenera; sin ella, hay que informarlo) |
| `import { Usuario } from ...` (nombre libre) | `import { Usuario, UsuarioSchema } from ...` (nombre = el de `-> name:`, capitalizado) |
| `new Usuario(...).save()` | `Usuario.save({ ... })` |
| `Usuario.find({ edad: { gt: 18 } })` | `Usuario.selectAll().where(schema.edad > 18)` |
| `findOne(...)` / `findById(id)` | `selectAll().where(schema.id == id)[0]` |
| `usuario.delete()` / `Usuario.deleteMany(query)` | `Usuario.delete(usuario)` / `Usuario.deleteWhere(condición)` |

Alternativas consideradas: (1) dejar el formato antiguo como obsoleto, con un aviso al usarlo — descartada, porque obliga a mantener todo su código y sus tests indefinidamente para un formato que nadie debería seguir usando; (2) migrar automáticamente en memoria un `-> collection:` al formato nuevo — descartada, porque las dos APIs de consulta no se corresponden una a una (un objeto `{ edad: { gt: 18 } }` no se traduce a una condición sobre `personaSchema` sin adivinar la longitud de cada campo y su clave primaria), y una migración a medias que "casi funciona" es justo el tipo de fallo silencioso que se evita en el resto del lenguaje. Un error explícito, con la tabla de arriba a mano, es más honesto.

**Nota**: los nombres internos del compilador que llevan el sufijo `V2` (`buildWsdbV2`, `readWsdbV2`...) son un resto histórico de cuando convivían los dos formatos; se dejaron tal cual para no tocar decenas de sitios sin necesidad, y ya no hay ningún "V1" con el que confundirlos.

## Cluster

`cluster-workers`: varios procesos Node reales con sesiones pegajosas. Cada worker cuenta el rate limit por su cuenta — con N workers, el límite efectivo para una IP insistente puede llegar a ser hasta N veces el valor configurado.

## Proyectos backend puro

Un proyecto puede tener solo ficheros `.wsb` y ningún `.wsf` — sirviendo solo API, sin ninguna vista.

## WSON: seguridad y transporte (heredado de la versión anterior)

Campos adicionales de un WSON, más allá de `from`/`to`/`via`/`content`:

- **`secret`**: clave para firmar. Solo permitido en un WSON de servidor — rechazado en compilación si aparece en uno de cliente (el secreto quedaría expuesto en el bundle del navegador). Implementado en `codegen-client.js`: un WSON ad-hoc de `.wsf` con `secret`/`encrypt: true` hace fallar la compilación con un error explícito.
- **`encrypt: true`**: requiere `secret` (validado en compilación). Cifrado AES-256-GCM (autenticado: detecta manipulación en el mismo paso que descifra), con la clave derivada del secret usando una sal distinta a la de la firma.
- **`id`**: de correlación, se genera en cada `.send()` si no se informa a mano (formato UUID), **antes de cifrar** — viaja dentro del payload cifrado si `encrypt: true`. Si el objeto se reutiliza en varias llamadas, cada envío tiene el suyo propio.
- **`createdAt`**: igual que `id` — se autogenera en `WSON.ws` en el momento de `.send()`, de solo lectura.
- **`to` como array**: varios destinos, envío en paralelo, fallo aislado por destino, resultado como array en el mismo orden.
- **`authorization`**: token a mandar tal cual como cabecera `Authorization`, pensado para autenticar contra APIs de terceros (no-WebScript) que no entienden la firma HMAC propia de WSON. A diferencia de `secret`/`encrypt`, **sí se permite tanto en cliente como en servidor** — es justo para eso. Caso de uso típico en `.wsb`: un backend que hace de *middleware*, recibiendo un `Authorization` (Bearer/JWT) de fuera para inspeccionarlo antes de reenviar o decidir algo. Aviso en cliente: lo que pongas ahí queda expuesto en el bundle del navegador, igual que cualquier API key metida a mano en JS de cliente; WebScript no puede protegerlo, solo documentarlo.

**Firma y verificación:**
- `WSON.send(instancia)` firma automáticamente si hay `secret` — HMAC-SHA256, cabecera `X-WSON-Signature`. El secreto nunca viaja por la red. Estático, como toda la API de `WSON` — nunca `instancia.send()`.
- `WSON.verify(content, firma, secreto, marca)` — comparación en tiempo constante (`crypto.timingSafeEqual`), no `===`.
- `WSON.showContent(content, secreto)` — descifra; devuelve el mensaje tal cual si no estaba cifrado, y `null` (no excepción) si falla la clave o hubo manipulación.
- `WSON.getSignature(headers)` / `WSON.getTimestamp(headers)` / `WSON.getToken(headers)` — atajos para extraer esas cabeceras.
- `WSON.showToken(token)` — **decodifica** (no descifra) un Bearer/JWT: separa y decodifica en base64url la cabecera y el payload para ver sus claims. Un JWT normal no está cifrado, solo codificado y firmado — leer el payload no requiere secreto. **Importante:** decodificar no es verificar — el contenido puede haber sido manipulado si no se comprueba la firma por separado. `WSON.showToken()` no valida nada, solo deja ver qué hay dentro; verificar la firma del JWT queda pendiente, es una pieza distinta de esta.
- `WSON.parse(args, headers, secreto)` — punto de entrada único en el receptor: verifica firma, descifra si hacía falta, expone `from`/`id`/`content`/`signatureValid`.
- Cabeceras: `X-WSON-Signature`, `X-WSON-From`, `X-WSON-Correlation-Id`, marca de tiempo, `Authorization`.

**Protección contra replay (una sola capa en esta versión):**
- La marca de tiempo se firma junto con el content (`content + '.' + timestamp`), no aparte. Ventana de validez configurable (5 min por defecto). Fuera de ventana, se rechaza aunque la firma sea correcta.
- **Sin detección de duplicados exactos** — dependía de `WSON.history()`, que se elimina en esta versión. Un mensaje reenviado dentro de la ventana de validez con firma y marca correctas se acepta de nuevo. Retroceso consciente frente a la versión anterior.

**Envío no bloqueante:**
- `WSON.enqueue(instancia)` — encola el envío y devuelve al instante, reutilizando `WSON.send()` con sus reintentos (backoff exponencial). Tras agotarlos se marca como *dead letter*, pero sin quedar registrado en ningún sitio consultable (sin `WSON.history()`).

**Toda la API de `WSON` es estática** (`WSON.metodo(instancia, ...)`, nunca `instancia.metodo()`) — incluye `send`/`enqueue`/`query`/`params`, no solo `verify`/`showContent`/`parse`. Que el argumento sea realmente de tipo `WSON` (o una clase que extienda de `WSON`, como un DTO) se valida **en compilación**, no en runtime — coherente con el resto de validaciones del lenguaje (colisión de rutas en `listen()`, `secret` rechazado en cliente).

## Comunicación dentro del mismo proyecto (.wsf → .wsb)

Un `.wsf` puede enviar un WSON por HTTP a su propio `.wsb` (mismo proyecto), o a cualquier sistema externo — `to` en un WSON de cliente no está restringido a rutas del propio proyecto: WebScript puede usarse como herramienta puramente de frontend, sin necesitar nunca un `.wsb` propio, hablando directo con APIs de terceros.

**CORS sigue aplicando igual** — es una restricción del navegador, no una regla de WebScript. Si el sistema externo no autoriza el origen del `.wsf` (`Access-Control-Allow-Origin`), el `fetch()` generado falla, sin excepción posible desde el lenguaje.

En el caso del propio proyecto:

- **No es obligatorio firmar ni cifrar** (`secret`/`encrypt`) — se mantiene HTTP simple, protegido solo por lo que ya proteja el transporte (HTTPS) y la sesión, no por el mecanismo de autenticidad de WSON.
- El cliente puede **enviar** WSON al backend, pero **no recibir** — no hay `WSON.listen()` en el front.
- `useRoute()` ya no existe — `Visual.route()` cubre el enrutado de cliente, y `WSON.listen()` con `via: GET` cubre servir datos por GET, unificado con el resto de métodos.
- Firma/cifrado siguen siendo necesarios (y obligatorios por las reglas de arriba) para comunicación **entre sistemas distintos**, no dentro del mismo proyecto.

## CLI: `websc update`

Además de `websc init`, se implementará `websc update` para actualizar un proyecto existente a una nueva versión de WebScript (regenerando `lib` y el compilador vendorizados) sin tocar el código propio del usuario.

## Control de versiones

`.gitignore` por defecto en proyectos generados por `init`, ignorando `lib` y el compilador vendorizado (tratados como regenerables vía `websc update`, similar a `node_modules`).

## Mensajería remota: `via: "socket"`, `online function`, `WSClient`

### `via: "socket"` — implementado como transporte base

Lo que en la revisión anterior de este documento decía *"queda dormido por ahora"* ya tiene una primera pieza real: `websocket-runtime.js`, WebSocket (RFC 6455) escrito desde cero sobre `crypto`/`net`/`tls` — sin ningún paquete de npm, ni vendorizado ni opcional. Es solo transporte (saludo + *framing*); todavía no hay nada por encima que use WSON o `watch()` sobre esta conexión. Detalle de implementación y de los bugs que aparecieron al revisarlo en `INSTRUCCIONES.md`.

### `online function` — la lógica nunca cruza la red

```
online function cobrar(monto) -> idempotent
	...

online function consultarSaldo(idCuenta)
	...
```

`online` marca una función para exponerla a otros servidores WebScript; `-> idempotent` (solo válido junto a `online`) declara que repetirla con la misma clave de idempotencia da el mismo resultado, nunca el efecto duplicado. Ya soportado por el parser. Lo que viaja por la red al consumirla desde otro servidor es solo la firma (nombre, parámetros, si es `idempotent`) y, en cada llamada, sus argumentos y el resultado — **nunca el cuerpo de la función**, que se ejecuta únicamente en el servidor que la declaró.

### `WSClient` — implementado

- **El contrato se obtiene por reflexión, nunca se copia a mano.** El consumidor pregunta al servidor remoto qué `online function` expone (nombre, parámetros, `idempotent`), y con eso se genera la clase cliente — igual que gRPC con la reflexión de su servidor. Copiarlo a mano reabriría el riesgo de que el esquema se desincronice en silencio, el mismo motivo por el que `.wsdb` usa reflexión (`getSchema()`) en vez de que el consumidor redeclare los campos.
- **Generación explícita, nunca en caliente.** El cliente (`OtroServidor.ws`) se escribe una vez, con `websc client-generate` (ya implementado, ver `INSTRUCCIONES.md`) o declarado en `wconfig.json` y sincronizado con `websc build --create-clients` (ver la subsección siguiente) — nunca se sobreescribe solo al conectar. Sobreescribir métodos en caliente rompería la garantía que mantiene todo el lenguaje: lo que hay en el fichero es lo que se ejecuta, siempre — nunca algo que cambia según el momento en que llegó una conexión. El código generado es `export function`, no `class`/`constructor` — el parser no soporta eso como código real, solo como prosa dentro de los `.ws` de `lib/`.
- **Ni un plazo de espera ni una conexión perdida certifican que la llamada no se ejecutó.** Es el problema de los dos generales: quien llama nunca puede distinguir con certeza "el mensaje no llegó" de "llegó, se ejecutó, y se perdió la respuesta" — ninguna de las dos señales (agotar un plazo, que la conexión se caiga) aporta esa certeza, se comprobó explícitamente para las dos. La única solución real es la que ya usa Stripe: una clave de idempotencia por llamada, para que repetirla sea siempre seguro pase lo que pase con el intento anterior — de ahí `-> idempotent`.
- **`WSQueue` (colas duraderas entre servidores, aparcado, sin sintaxis aún)**: reutilizaría `.wsdb`/SQLite para persistir (cero instalación, igual que `.wsdb`) y `watch()` para el *dispatch* — funcionaría ya para procesos en la misma máquina; entre máquinas distintas necesita `via: "socket"` para empuje real. La idempotencia del lado que consume se resolvería con un *insert* que falle si la clave ya existe (el mismo patrón descartado en su día para `.wsdb.save()` en general, pero que aquí es exactamente lo que hace falta).

### `clients` en `wconfig.json` + `websc build --create-clients` (implementado)

`websc client-generate <url> --out <fichero>` sigue existiendo tal cual, sin cambios, pero además se puede declarar de una vez en `wconfig.json`:

```json
{
  "clients": {
    "src/OtroServidor.ws": "wss://otroservidor.com/"
  }
}
```

La clave es la ruta de salida (relativa a la raíz del proyecto); el valor, la URL `wss://`/`ws://`. `websc build` **no toca esta clave por defecto** — hace falta el flag explícito `--create-clients`. Sin él, el build sigue siendo exactamente lo que era: puro, determinista, sin red. Es una decisión deliberada, no solo comodidad: a diferencia de todo lo demás que hace `websc build` (leer `src/`, escribir `dist/`), sincronizar un cliente exige que el servidor remoto esté arrancado y sea alcanzable EN ESE MOMENTO — meterlo en el camino por defecto habría hecho que cualquier build normal pudiera fallar por una razón ajena al propio proyecto (el remoto caído, sin red en el CI...).

**Un fallo de un remoto concreto no tumba el build entero.** Si no se puede conectar, no responde a tiempo, o no expone ninguna `online function`, se escribe una clase VACÍA (sin funciones, con un comentario explicando qué pasó) para ESE remoto, y el build sigue con el resto — mismo espíritu que ya tiene el resto del build (un `.wsf` roto no impide compilar los demás). Quien importe una función de esa clase vacía se entera con el error de siempre ("X no está exportado"), más específico y accionable que un fallo de red genérico en mitad del build.

Implementación: se extrajo la lógica de conectar+reflejar+construir el texto del `.ws` (antes solo dentro de `cmdClientGenerate`) a una función compartida, `generateClientContent(url)` — `websc client-generate` sigue fallando rápido (lanza si algo va mal, es una herramienta de un solo uso), y `websc build --create-clients` captura ese mismo fallo por cada entrada de `wconfig.json` y decide qué hacer sin abortar el resto.

Alternativas consideradas (con Jorge, antes de implementar):
1. **Meterlo en el camino por defecto de `websc build`** (sin flag) — descartada: acopla cualquier build a que un tercero esté disponible en ese instante, incluso para quien no ha tocado nada del proyecto.
2. **Solo generarlo si el fichero de salida no existe todavía** — descartada a favor de esta (la elegida): no recoge cambios del contrato remoto en builds sucesivos sin borrar el fichero a mano primero.
3. **Un comando aparte (`websc client-sync`), sin tocar `build` en absoluto** — descartada a favor del flag: Jorge prefirió mantenerlo dentro de `build` para no tener un paso adicional que recordar ejecutar.

### Alternativas consideradas y descartadas, con el motivo

- **`via: "amqp"` contra un RabbitMQ externo**: el CLIENTE (`amqplib`) sí sería vendorizable de verdad (cero dependencias transitivas, cero binarios nativos, comprobado instalándolo) — pero el bróker en sí no existe como paquete de npm real (se buscó; el único candidato se declara a sí mismo no apto para uso real). Java sí tiene bróker embebibles reales (Apache ActiveMQ/Qpid) — confirma que no es imposible en principio, solo que nadie lo ha construido para Node.
- **Réplica multi-*master* (dos servidores "dueños" de los mismos datos)**: descartada. El teorema CAP obliga a elegir entre bloquear un lado durante una desconexión o aceptar conflictos reales — no hay una tercera vía, ni con "commits", ni con ningún otro mecanismo. Si hiciera falta en el futuro, la respuesta seria son los CRDT, y solo para los campos cuyo tipo de dato encaje con esa fusión automática, nunca para un campo genérico.
- **Descargar y ejecutar código de otro servidor** (al estilo del *codebase* de Java RMI): descartado por el riesgo de ejecución remota de código que tuvo ese mecanismo en la práctica (fue la configuración por defecto durante años, con explotación fiable documentada). Lo que sí se mantiene, y no tiene ese riesgo, es descargar **metadata** (firma de una función, esquema de un `.wsdb`) para generar código localmente — nunca lógica ejecutable ajena.
- **Conexión directa de un servidor a la base de datos de otro** (compartiendo credenciales): descartada — es el antipatrón de "base de datos compartida" bien documentado en arquitectura de software, y además una credencial no se puede revocar con la misma facilidad con la que se revoca acceso a una API. Resuelto en su lugar con una réplica local alimentada por eventos.


## Estado por sesión vs. estado global — `global reactive`/`global var`/`global const`

Toda `reactive`/`var`/`const` de nivel superior de un `.wsb` fue, desde el principio, estado **por sesión** — una copia propia por visitante. Al añadir `online function`/`WSClient` (mensajería entre servidores), surgió una pregunta real: una `online function`, llamada por otro servidor sin ninguna sesión HTTP detrás, ¿puede tocar ese mismo estado? La respuesta, construida sin pensarlo del todo a fondo, fue: sí, todas las `function`/`online function` ven una única instancia compartida de todo el estado de nivel superior. Esto escondía un bug real: **la misma reactive, llamada desde una `function` o desde un `watch()` de sesión, resultaba ser dos almacenes distintos**, sin ningún error — una `function` llamada desde un `watch()` de sesión escribía en la copia compartida, no en la de esa sesión.

### Las tres opciones consideradas

1. **Global por defecto, sesión explícita** (`WSON.getSession(peticion)`, propuesta durante la discusión): coherente con cómo Node.js trata sus variables de módulo — una única instancia, siempre. Descartada por dos motivos de peso: (a) es un cambio de comportamiento por defecto — cualquier proyecto que ya usara `reactive` esperando aislamiento por visitante (un carrito de la compra, por ejemplo) se rompería en silencio, compartiendo sus datos entre TODOS los visitantes; (b) abre la puerta, por defecto, a condiciones de carrera reales en CUALQUIER reactive, no solo en las que alguien decida compartir a propósito — demostrado con código real: dos "retiros" concurrentes de 10 sobre un saldo de 100 acababan en 90/90 en vez de 80/80 (el clásico *lost update*), porque nada protege una lectura-modificación-escritura sobre una variable module-level de Node compartida entre peticiones concurrentes.
2. **Arreglar solo el enrutado** (que una `function` llamada desde una sesión opere sobre la copia de esa sesión, heredando el contexto): arregla el síntoma del bug encontrado, pero no resuelve la pregunta de fondo sobre qué pasa cuando de verdad no hay sesión (una llamada RPC), ni evita el riesgo de "dos sabores mezclados en el mismo `watch()`" que motivó toda esta discusión.
3. **Alcance explícito en la propia declaración** (`global reactive`/`global var`/`global const`, la elegida): una reactive normal sigue siendo por sesión, sin ningún cambio de comportamiento para nadie. Compartir de verdad es un acto explícito y a propósito — y, como consecuencia directa, **nunca hay ambigüedad sobre qué `watch()` debe correr ni con qué contexto**: una reactive es de sesión o es `global`, nunca las dos cosas, así que su `watch()` tampoco tiene "sabores" que mezclar. El riesgo de condición de carrera de la opción 1 sigue existiendo — pero solo para quien escribe `global` a propósito, sabiendo lo que implica, nunca como sorpresa en el estado por defecto.

### Por qué la 3 y no la 1, en una frase

La 1 le quita a todo el mundo, por defecto, una protección que hoy sale gratis, para ganar coherencia con Node. La 3 mantiene la protección por defecto y hace que perderla sea una decisión visible, buscada, y con su propio nombre en el código — el mismo principio que ya sigue el resto del lenguaje con `-> secret`/`-> encrypt` en WSON, o `-> idempotent` en `online function`: las garantías fuertes son la norma; renunciar a alguna se escribe, no se hereda por accidente.

### `global` y las function importadas de un `.ws`: se resuelven contra quien las importa

Una `function`/`online function` importada de un `.ws` sigue exactamente la misma regla que una declarada en el propio `.wsb`: un identificador suelto que coincide con una `global` del `.wsb` que la IMPORTA es esa global; uno que coincide con una reactive/var de sesión es un error al compilar. Un `.ws` no tiene estado de servidor propio (es lógica compartida, sin front ni back), así que el único estado que puede tener sentido es el de quien lo usa. Si dos `.wsb` importan el mismo `.ws`, cada uno obtiene sus propias instancias de esas funciones, enlazadas a su propio estado.

Alternativas consideradas:
1. **Exigir que el `.ws` declare lo que espera** (algo como una lista de `global` requeridas en el propio `.ws`): más explícito, pero añade sintaxis nueva para un caso que el compilador ya puede comprobar solo — y, sobre todo, la parte peligrosa (tocar una reactive de SESIÓN) ya es un error al compilar sin ella. Queda como posible mejora si el enlace implícito resulta confuso en proyectos grandes.
2. **Dejar los `.ws` sin acceso a `global`** (el estado anterior): obligaba a mover a mano al `.wsb` cualquier función que necesitara estado compartido, y — peor — dejaba sin protección justo a las funciones importadas, reabriendo por la puerta de atrás el mismo fallo silencioso que `global` vino a eliminar.

Detalle de implementación (qué se compila, cómo se detecta el uso indebido de una reactive de sesión, el mecanismo `__triggerGlobal`, y cómo se aplaza la compilación de un `.ws` hasta conocer el estado) en `INSTRUCCIONES.md`.

### Los imports de un `.ws`: ámbito privado, enlace tardío entre `.ws`

Un `.ws` puede importar de otro `.ws`, de un `.js`, de un paquete npm, de un `.wson` o de un `.wsdb`, igual que un `.wsb`. Antes esos `import` no se resolvían en servidor: cualquier llamada a algo importado dentro de un `.ws` fallaba en ejecución con `X is not defined`, y una constante exportada que usara un import ni compilaba. Las reglas:

- **El ámbito de imports de un `.ws` es PRIVADO.** Se resuelve contra la carpeta de ese `.ws` (no la del `.wsb` que lo importa: un paquete instalado solo bajo `lib/` se encuentra desde un `.ws` de `lib/`) y solo lo ve ese `.ws`. Que `a.ws` importe `marca` de `c.ws` no hace que el `.wsb` que importa `a.ws` vea `marca`.
- **Las function entre `.ws` se enlazan de forma tardía.** Una function que un `.ws` importa de otro `.ws` se llama a través de un reenviador que busca el lote ya compilado en el momento de la llamada, no al compilar. Consecuencias: no hace falta ordenar los lotes entre sí, y dos `.ws` que se importan mutuamente (recursión mutua, un caso legítimo) funcionan.
- **Un `.ws` es UN lote por servidor**, alcance quien lo alcance, compilado contra el `global` del `.wsb` raíz (misma regla que ya tenían los `.ws` directos, ver sección anterior). Si `a.ws` y `b.ws` importan `c.ws`, los tres ven una única instancia de `c.ws` y, por tanto, el mismo estado global. Dos servidores distintos sobre el mismo grafo de `.ws` tienen estados independientes.
- **Una constante exportada se evalúa una vez, con el ámbito de su `.ws` a la vista.** Si se pide mientras ese mismo `.ws` aún está resolviendo sus propios imports (importación circular), da un error que explica la causa en vez de un `ReferenceError` engañoso: el ámbito estaría a medias.
- **Un `.ws` no puede importar un `.wsb`.** Un `.ws` es lógica compartida que también usa el cliente, y un `.wsb` es solo de servidor — importarlo rompería el bundle del navegador. Error explícito al compilar.
- **Solo se exponen por RPC las `online function` que el `.wsb` importa por nombre.** Una `online function` de un `.ws` anidado que el `.wsb` no importa sigue siendo interna: las de su ámbito la pueden llamar, pero no existe para un cliente RPC (mismo criterio que `WSON.listen()`, que tampoco se descubre solo).
- **La base de datos de un `.wsdb` importado desde un `.ws` en una subcarpeta cae siempre en la raíz del proyecto** (`.wsdb-data/`), nunca junto al `.ws`.

Alternativas consideradas:
1. **Ordenar los lotes (orden topológico) y pasar referencias directas** — descartada: obliga a ordenar y, sobre todo, obliga a prohibir los ciclos, que aquí son legítimos (recursión mutua entre dos ficheros), para resolver un problema que el enlace tardío no tiene.
2. **Volcar los imports de un `.ws` en el ámbito del `.wsb` raíz** (aplanado, como ya se hace con las rutas que se importan entre `.wsb`) — descartada. Con una ruta tiene sentido porque su `watch()` se compila *dentro* del ámbito del importador; una function de un `.ws` no. Aplanar filtraría nombres al `.wsb`, haría chocar dos `.ws` que usan el mismo nombre local para cosas distintas, y haría que el significado de un `.ws` dependiera de quién lo importe.
3. **Concatenar el texto de los `.ws` importados dentro del que los importa** — descartada: pierde el ámbito por fichero y duplica un mismo `.ws` (y su estado) según cuántos lo importen.

### Constantes hermanas dentro de un mismo `.ws` (resuelto)

El ámbito de una constante exportada por un `.ws` eran solo los imports de su propio fichero — nunca sus hermanas del mismo fichero. `export const B = A + 1`, con `A` declarada en el mismo `.ws`, daba `A is not defined` aunque las dos estuvieran juntas.

**Diseño**: una constante hermana referenciada por nombre en el texto de la expresión se resuelve a través de `getWsConstValue`, que cachea el valor por nombre (una sola evaluación, se pida desde fuera del fichero vía `import` o desde una hermana) y detecta un ciclo ENTRE HERMANAS (`const A = B` / `const B = A`, ambas en el mismo `.ws`) con un error explícito que nombra la constante y el fichero, en vez de una recursión infinita o un `ReferenceError` que no explica la causa — distinto del error de importación circular ENTRE FICHEROS que ya existía (`entry.scopeReady`), que sigue igual y no se toca. El reparto es recursivo y cubre cadenas (`C` usa `B`, `B` usa `A`); una hermana que nadie usa, y que está rota, no tumba a las demás (solo se evalúa si el texto de la expresión la menciona).

**Límite deliberado, no una regresión**: una constante que llama a una FUNCTION hermana del mismo `.ws` (`export const D = doble(21)`, con `doble` una `function` del mismo fichero) sigue sin resolverse (`doble is not defined`). Esa function puede tocar `global` (ver "Los imports de un `.ws`" arriba), que en el momento en que se evalúa una constante (durante `resolveImports`, en el arranque) todavía no existe — se compila más tarde, cuando `createRequestHandler` ya sabe qué es `global` y qué es de sesión. Resolverlo exigiría decidir contra qué estado compilar esa function en ese punto — la misma pregunta de diseño abierta que tiene la function exportada por un `.wsb` (ver la limitación de más abajo, en la sección de imports del `.wsf`).

Alternativas consideradas:
1. **Incluir SIEMPRE todas las hermanas en el ámbito, se usen o no** — descartada: una hermana rota (import inexistente, error de sintaxis en su expresión) tumbaría a todas las demás del fichero aunque ninguna la usara.
2. **Compilar las funciones del `.ws` ANTES de evaluar sus constantes, para que una constante también pueda llamar a una function hermana** — descartada por ahora: exige decidir contra qué `global`/sesión compilar esas funciones en un punto donde ese estado aún no existe (se construye más tarde, a partir del `.wsb` raíz). Sin resolver esa pregunta de diseño, sería compilarlas con un estado falso o inventado.

**Esto es solo el lado servidor.** El cliente tiene un modelo distinto (un único ámbito, no uno por fichero) y se resuelve en la sección siguiente.

### Los imports de un `.ws` en el cliente: un único ámbito, dirigido por demanda

El servidor da a cada `.ws` su ámbito privado. El cliente no puede: el bundle es **un único texto con un único ámbito** — las plantillas y los `onclick` llaman a las function por su nombre a nivel superior, una `var` mutable de un `.ws` debe verse actualizada desde fuera, y `reactive` es global por diseño. Trasladar el modelo del servidor habría sido cambiar el contrato de todo `.wsf`. Así que el cliente sigue siendo plano, y las reglas nuevas son las que hacen que un modelo plano no falle en silencio:

- **Pedir una function de un `.ws` trae esa function y todo lo que ella referencia**, de forma transitiva: otras function del mismo `.ws` (helpers, exportados o no) y los nombres que ese `.ws` importa (que se piden a su fichero de origen, solo esos). Antes solo viajaba la function pedida; un helper del mismo fichero, o cualquier cosa importada, daba `X is not defined` en el navegador.
- **Es dirigido por demanda, y esto es lo que más pesó en el diseño.** Un import que nada de lo pedido alcanza no se toca nunca. Un `.ws` compartido con el servidor suele mezclar una function que usa un `.wsdb` (solo de servidor) con otras aptas para el navegador; ese patrón funciona hoy en el cliente mientras solo se pidan las seguras, y seguir *todos* los imports de un `.ws` lo habría roto. Si lo pedido sí alcanza un `.wsdb` o un paquete npm, el error de siempre sale, ahora nombrando el `.ws`.
- **De un `.ws` visitado se siguen trayendo siempre todas sus `reactive` y `const`/`var`** (como antes: pueden ser estado compartido que sus function usan sin nombrarlo en el import), y con ellas lo que referencian. Ahora también las **exportadas** (`export const`, `export reactive`): el filtro por tipo no atravesaba el nodo `Export` y nunca llegaban al cliente.
- **El análisis de referencias sobrestima a propósito.** Usa `acorn` sobre el JS que se emite; cuenta como referencia cualquier identificador con el nombre de un candidato, aunque un local lo esconda; ignora propiedades (`o.interno`) y declaraciones; si un fragmento no se puede parsear, escanea por palabra. Traer de más es una function sin usar; traer de menos es un `ReferenceError` en el navegador.
- **Una colisión de nombres es un error explícito, si interviene un `.ws`**: `"fmt" lo declaran a la vez lib1.ws y lib2.ws: el bundle de cliente es un único ámbito compartido...`. Entre dos `.wsf` no se comprobaba antes y no se cambia. El mismo `.ws` alcanzado por dos caminos no es una colisión: se emite una vez. Un nombre repetido en un `.ws` que nada de lo pedido alcanza no se emite y no molesta.
- **Cada nombre se registra aunque su fichero ya esté visitado.** El `visited` anterior saltaba el import entero al ver el fichero por segunda vez, así que `import { a } from "x.js"` y luego `import { b } from "x.js"` perdían `b` (igual con `.ws`, `.json` y `.wson`). Los ids de los módulos `.js` embebidos ahora son únicos por recorrido.

**SSR ve lo mismo que el bundle.** Antes compilaba cada function aislada (solo veía `state`) e ignoraba por completo las `const`/`var`, clases `.wson` y módulos `.js` importados. Ahora todo comparte un ámbito, con enlace tardío (las function pueden llamarse entre sí, y las propias del `.wsf` también). Lo importado que no se puede calcular en servidor (una `const` que lee `window`, un `.js` que toca `document`) **no rompe un render que no lo usa**, y si la plantilla lo toca da un error con la causa real. La tolerancia no es un adorno: SSR ignoraba todo lo importado, así que hay proyectos que renderizan solo porque nunca lo evaluaban.

Alternativas consideradas:
1. **Seguir todos los imports de un `.ws`, como se hace con un `.wsf`** — descartada: rompe el `.ws` mixto descrito arriba, que hoy funciona (comprobado con código antes de decidir).
2. **Emitir todas las function de un `.ws` importado** — descartada: engorda el bundle y crea colisiones falsas por nombres que nadie usa (dos librerías con una `formatear` cada una, de las que solo se usa otra cosa).
3. **Un ámbito por `.ws` también en el cliente** (cada `.ws` como una clausura, como hace el servidor, o renombrando identificadores) — descartada por ahora. Una clausura obligaría a exponer cada `var` mutable con getters (enlace vivo) y a reescribir cómo las plantillas resuelven nombres; renombrar exige análisis de ámbitos de verdad (el mismo límite que ya tiene `substituteServerState`). Si las colisiones resultan frecuentes en proyectos reales, es el siguiente paso; el error explícito las hace visibles en vez de silenciosas.
4. **Política "gana el último" / "gana el propio" para las colisiones** — descartada: es exactamente el fallo silencioso que este proyecto evita. Solo se conserva para `reactive`, donde el estado compartido por nombre es la intención.
5. **En SSR, evaluar lo importado sin tolerancia** — descartada: rompería páginas que hoy renderizan.
6. **En `resolveTopLevelValue` (el `posts` de `Visual.staticPaths`), mantener un único script con todas las declaraciones** — descartada: un `.ws` puede arrastrar una `const` ligada a un módulo `.js` o a algo solo de navegador, y un único script hacía que cualquiera de ellas tumbara el build aunque no tuviera relación con `posts`. Ahora cada declaración se evalúa por separado y solo se exige que salga bien la que liga la variable pedida. Este caso se descubrió con un `websc build` real: la primera versión de este cambio lo rompía.

**Límites conocidos**:
- El análisis sobrestima: un local con el nombre de un import puede traer de más, y con ello una colisión o un error de `.wsdb` que un análisis de ámbitos completo evitaría. No se ha visto en la práctica.

Detalle de implementación y pruebas en `INSTRUCCIONES.md`.

### Dos `.wsf` con una function del mismo nombre (resuelto), y un hueco encontrado al verificarlo

Dos componentes (`.wsf`) que declaraban una `function`/`const` interna con el mismo nombre se pisaban en silencio: el bundle de cliente emitía `function fmt` dos veces (JS deja que la segunda declaración gane) y SSR sobrescribía `functions[nombre]` de la misma forma — cuál "ganaba" dependía solo del orden de los `import`, y ganaba para los DOS componentes por igual, no solo para el que declaró la versión perdedora (comprobado: `<CompA/><CompB/>`, cada uno con su propio `fmt`, los dos acababan mostrando el valor de `fmt` de `CompB`). Esto estaba deliberadamente exento de la comprobación de colisiones que ya existía para un `.ws` (ver la sección de imports del cliente, más arriba) — "podría romper proyectos que hoy funcionan" fue la razón dada entonces. Ahora tiene el mismo criterio: `claimName` ya no distingue si alguno de los dos orígenes es un `.ws` o un `.wsf` — cualquier colisión de nombre entre dos orígenes distintos (dos componentes, o un componente y la propia página) es un error explícito que nombra los dos ficheros, salvo el mismo fichero alcanzado por dos caminos (diamante), que sigue sin ser colisión.

**Bug encontrado al reproducir, más fundamental que el reportado**: una `export function`/`export const` dentro de un `.wsf` componente era completamente INVISIBLE — ni siquiera llegaba a compararse para una colisión, `fmt is not defined` al usarla. Causa: el nodo `Export` que envuelve la declaración no se desenvolvía en el punto donde se recogen las piezas de un `.wsf` importado (`ownFns`/`ownConsts` filtraban `targetAst.body` por tipo directamente). Es el mismo bug, en otro sitio, que ya se había corregido para un `.ws` (`topDecls` en `loadClientWs`) — aquí nunca se había aplicado. Sin `export`, la function/const sí viajaba con normalidad; por eso el caso reportado (la colisión) solo se reproducía con funciones SIN `export`, y hubo que arreglar el desenvuelto aparte para que `export function fmt` incluso llegara a *colisionar* en vez de desaparecer sin más.

**Hueco relacionado, encontrado al escribir las pruebas — resuelto en la sección siguiente**: una `const`/`var` de nivel superior de un componente, usada dentro de la plantilla de ese mismo componente, estaba rota en SSR. Ver "Una const propia de un componente, usada en su propia plantilla" más abajo.

Alternativas para la colisión, consideradas y descartadas:
1. **Mantener la exención entre dos `.wsf` "por si acaso rompe algo"** — descartada: es exactamente el pisado silencioso que el proyecto evita en cualquier otro sitio, y ya se había decidido cerrar este hueco.
2. **Un ámbito por componente** (en vez de un único ámbito plano) — descartada por el mismo motivo que para los `.ws`: exigiría renombrar identificadores o exponer cada función como propiedad de un objeto por componente, reescribiendo cómo las plantillas resuelven nombres. Fuera de alcance de este arreglo puntual.

### Una const propia de un componente, usada en su propia plantilla (resuelto)

Una `const`/`var` de nivel superior de un `.wsf` componente, usada dentro de la plantilla de ESE MISMO componente, daba `X is not defined` en SSR — con o sin `export`, sin relación con ninguna colisión ni con imports. Usarla desde OTRO fichero (la página raíz, u otro componente) sí funcionaba, porque esa vía no pasa por `renderComponentSSR`.

**Causa**: `renderComponentSSR` construía el `ctx` del hijo con `extraScope: { props }`, que REEMPLAZABA por completo el `extraScope` heredado del padre (donde vive toda const de nivel superior — el modelo es un único ámbito plano, igual que en el bundle de cliente) en vez de combinarlo. Se perdía en cada nivel de composición. Las `function` no tenían este problema (viven en `ctx.functions`, que sí sobrevive al hacer spread de `ctx`). El cuerpo de un `for` ya combinaba correctamente (`{ ...ctx.extraScope, [item]: valor }`) — el mismo patrón, aplicado aquí: `extraScope: { ...ctx.extraScope, props }`, con `props` al final para que un `props` heredado de un componente que envuelve a este no se filtre hacia dentro (pisado por el `props` propio del nivel actual).

Verificado con ejecución real (`renderPageToHTML`, y de extremo a extremo con `websc build` + servidor real): const propia sola, const propia que usa una function propia, tres niveles de composición cada uno con su propia const, `props` de un padre que NO se filtra a un hijo que no lo declara, una const y un prop con nombres parecidos sin confundirse, y un `for` dentro de un componente combinando bien su propia const, `props`, y la variable del propio `for`.

### La hidratación de una interpolación que renderiza vacía (resuelto)

Una interpolación de texto (`{expr}`) cuyo valor SSR calculaba como `""` no dejaba ningún nodo en el HTML — un string vacío insertado ahí no produce nada, no un nodo de texto vacío. La hidratación, en cambio, consume incondicionalmente un nodo del DOM por cada interpolación (avanza el cursor con `nextSibling`); sin ese nodo, topaba con `null` y lanzaba `Cannot read properties of null (reading 'nextSibling')` — el clic que debía rellenar ese texto no hacía nada. Reproducido con una página sin ningún `.ws`: es el patrón `reactive x = ""` a secas, no un caso raro.

**La solución sigue el patrón que `if`/`for` ya usaban para el mismo problema de fondo** (contenido que puede desaparecer entero): SSR envuelve todo texto DINÁMICO en marcadores de comentario, `<!--t-->...<!--/t-->`. La hidratación busca el nodo de texto entre esos dos marcadores y, si no está (contenido vacío), lo crea ahí mismo antes de seguir. El texto ESTÁTICO (sin `{expr}`) no lleva marcadores: su contenido nunca cambia tras el primer render, así que no hay nada que reenganchar.

### Una `reactive` cuyo valor inicial usa una `const` (resuelto)

`reactive integer c = LIMITE` con `const LIMITE = 10` fallaba siempre, por motivos distintos en cliente y en servidor:
- **Cliente**: el bundle emitía `const state = createStore({ c: LIMITE })` ANTES de `const LIMITE = 10` — todas las const/var de nivel superior se emitían después de `state`, sin excepción, porque las que SÍ leen una reactive (vía `state.NOMBRE`) necesitan `state` ya creado. Es una TDZ real de JS (`Cannot access 'LIMITE' before initialization`), no un error del compilador. Una `reactive` que llamaba a una `function` no tenía este problema: las `function` se elevan (*hoisting*) y ya eran invocables desde antes de su posición textual — solo hacía falta resolver el caso de `const`/`var`.
- **Servidor (SSR)**: peor — el valor inicial de cada reactive se evaluaba con `new Function('return (' + expr + ')')()`, sin ningún ámbito, ni siquiera las `function` existían todavía en ese punto. Fallaba con cualquier cosa que no fuera un literal.

**Diseño**: las const/var de nivel superior que NO leen ninguna reactive, ni de forma directa ni transitiva (a través de otra que sí lo hace), se adelantan antes de crear `state`/calcular los valores iniciales — con el mismo criterio en el bundle de cliente y en SSR. Una que SÍ lee una reactive se queda donde estaba (después), sin cambios. El reparto es un punto fijo simple: una const que referencia por nombre a otra ya marcada "necesita estado" también se marca así, y así sucesivamente, hasta que no cambia nada — cubre cadenas (`const B = A + 1` con `A` dependiente de una reactive).

**Bug real encontrado al implementar, no al reportar**: la primera versión solo miraba si la expresión MENCIONA por nombre una reactive — `const resultado = conBase(1)` no menciona ninguna reactive por nombre (menciona `conBase`, una function), así que se adelantaba igual que las demás. Pero `conBase` internamente lee una reactive (`function conBase(x) { return x + base }`, con `base` sustituida a `state.base` al compilar) — adelantar `resultado` antes de que `state.base` existiera daba `NaN` en vez del valor real, confirmado con código. Cualquier llamada a una function DE WEBSCRIPT (propia del `.wsf`, o importada de un `.ws`) se trata ahora, a propósito, como si necesitara `state` — no hay forma de saber si su cuerpo lee una reactive sin analizarlo, y es más seguro que adivinar. Una llamada a un módulo `.js` embebido o a una clase `.wson` (`new Persona(...)`) NO cuenta: esas nunca tienen acceso a `state` (JS aislado, sin closure sobre él), así que una `const TRIPLE_DE_DOS = triple(2)` que venga de un `.js` sí se adelanta con normalidad.

Alternativas consideradas:
1. **Reordenar topológicamente todas las const/var según sus dependencias reales (análisis de ámbitos completo)** — descartada por ahora: mismo límite que ya tiene `substituteServerState`/el análisis de referencias del cliente; el reparto pre/post-estado con punto fijo cubre el caso real sin ese coste.
2. **Tratar toda llamada a function como segura si "parece pura" (sin acceder a identificadores sueltos)** — descartada: exige el mismo análisis de cuerpo de function que se quiere evitar, y una function seguramente cambia de "pura" a "no pura" según lo que otro cambio del proyecto le añada, sin que el compilador se entere.
3. **Duplicar la evaluación de una const usada por una reactive (una copia antes, otra después)** — descartada: si la const tiene efectos observables (poco probable pero posible con una function con logging, por ejemplo) los duplicaría; el reparto pre/post no repite ninguna evaluación.

Alternativas consideradas:
1. **Una interpolación vacía se rellena en SSR con un espacio o un carácter invisible** — descartada: contaminaría `textContent` para quien lo lea (comparaciones, longitud de cadena) con un carácter que el propio valor de la reactive nunca tuvo.
2. **La hidratación detecta "faltan nodos" comparando cuántos hijos tiene el padre contra los que esperaba** — descartada: no dice DÓNDE falta el nodo si hay más de un hueco posible en el mismo padre (el caso de "dos interpolaciones vacías seguidas", que si no fuera por el marcador sería indistinguible de una sola).
3. **Marcar solo el caso vacío detectado en tiempo de compilación** — inviable: el marcador se genera una vez, al compilar la plantilla; si SSR pudiera decidir por render si lo necesita o no, la función de hidratación (compilada una sola vez) no sabría cuál de los dos formatos esperar.

**Efecto en el HTML de SSR**: cualquier texto con interpolación ahora lleva los marcadores, no solo el caso vacío — es inevitable dado el punto 3 anterior. No cambia lo que ve el usuario (los comentarios no son visibles), pero sí el string exacto que produce `renderPageToHTML`; los tests que comparaban ese string literal se actualizaron.

## HTML suelto en un `.wsf`: página sin `Visual.render()` (sistema nuevo, ADITIVO)

Hasta ahora, la única forma de que un `.wsf` fuera una página era envolver su HTML en `visual nombre = <html>` y llamar a `Visual.render(nombre)` explícitamente; la ruta salía de `Visual.route('/patrón')`, y los parámetros/query de `Visual.params(screen)`/`Visual.query(screen)`.

Ahora, ADEMÁS (la clase `Visual` y todos sus métodos SIGUEN existiendo, intactos, sin cambios de comportamiento en ningún fichero que ya los use), un `.wsf` puede escribir su HTML SUELTO, directamente a nivel de fichero, sin envolverlo en nada:

```
const productos = ["manzana", "pera"]

<ul>
	for (p in productos)
		<li>{p}</li>
</ul>
```

`if`/`else`/`for`, interpolación (`{expr}`) y eventos (`onclick={...}`) funcionan exactamente igual que ya funcionaban dentro de un `visual` — es el MISMO motor de plantillas (`buildHtmlTree`, `parseTemplateSequence`, `genElement`/`renderElementSSR`...), reutilizado tal cual, no uno duplicado. Las declaraciones (`const`/`reactive`/`var`/`function`) siguen fuera del HTML, en cualquier orden respecto a él (antes o después).

**El HTML suelto se guarda como un nodo nuevo, `PageDecl`** (parser.js) — se detecta por línea (`isBareHtmlStart`, una etiqueta abriendo a nivel superior) exactamente con el mismo mecanismo de trocado plano que ya usaba `visual` (`splitTopLevel`: no se anida por indentación, se consume hasta la siguiente declaración de nivel superior real). En `codegen-client.js`/`codegen-ssr.js`, un `PageDecl` se trata como una `visual` más con un nombre interno fijo (`__page__`) — así reutiliza `generateCreateFunction`/`generateHydrateFunction`/`renderElementSSR` sin tocarlos.

**Un HTML suelto puede ser un documento completo** (`<html><head>...</head><body>...</body></html>`) o un simple fragmento (`<div>...</div>`, como ya podía ser una `visual`). Cuando la raíz es literalmente `<html>`, la hidratación no intenta insertarlo dentro de `document.body` (no tiene sentido, y el navegador reordenaría un `<html>` anidado) — hidrata directamente contra `document.documentElement`, el que el propio navegador ya parseó de la respuesta del servidor. No se genera camino de creación sin SSR para este caso (una página así no tiene sentido sin servirla ya completa).

### Qué decide si un `.wsf` es "página" ahora (`classifyWsf`, en `codegen.js`)

1. **`Visual.render(x)` explícito** → página, sistema antiguo, sin cambios.
2. Si no, **un `PageDecl` (HTML suelto) presente** → página, se renderiza implícito, sin llamada.
3. Si no, **cero o dos-o-más `visual` declaradas** → librería (sin cambios respecto a hoy).

**Deliberadamente NO incluido: una única `visual`, sin HTML suelto y sin `Visual.render()`, auto-renderiza.** Aunque encaja con la idea general ("si solo hay una, se renderiza esa"), un fichero REAL del propio proyecto (`src/contador.wsf`) es exactamente ese patrón — una única `visual`, sin `Visual.render()` — y es un componente reutilizable que importa `app.wsf`. Auto-renderizarlo como página propia habría roto ese fichero real. Aditivo de verdad significa que el estilo antiguo (`visual` + opcional `Visual.render()`) no cambia de comportamiento en NINGÚN caso, ni siquiera en el borde de una sola `visual`. El error "no se sabe cuál renderizar" (dos o más `visual`, sin HTML suelto, sin `Visual.render()`) solo se lanza si alguien intenta renderizar ESE fichero como página de todos modos (llamando a `generateClientBundle`/`renderPageToHTML` directamente sobre ese AST) — `classifyWsf` lo clasifica como librería, sin error, para el flujo normal de `websc build`.

### Ruta por fichero (sin `Visual.route()`)

La ruta de una página del sistema nuevo sale de su propia ruta de fichero, relativa a `src/`: `api/listaProductos.wsf` → `/api/listaProductos` (`route-pattern.js`, `routePatternFor`). `Visual.route()` sigue ganando siempre si está presente — sin cambios.

Un segmento de ruta con `:` en el nombre de FICHERO marca un parámetro dinámico: `listaProductos:id.wsf` → `/listaProductos/:id` (como un segmento nuevo, no sufijado al mismo). Un segmento que es SOLO el parámetro (`:id.wsf`) no añade ningún literal delante (`/:id`). Solo se admite un nivel de anidamiento dinámico por convención de NOMBRE DE FICHERO en esta primera versión — una carpeta con `:` en su propio nombre (`blog/:slug/comentarios.wsf`) no se ha implementado.

**`findWsfFiles` (discover-files.js) ahora recorre subcarpetas** — antes era plana (ni siquiera descubría un `.wsf` en una subcarpeta). `findWsbFiles` sigue plana, sin cambios — no se ha tocado el descubrimiento de `.wsb`, fuera del alcance de esta petición.

**Nombres de fichero de salida** (bundle, `.html`): para un fichero suelto en `src/` sin `:` en el nombre, igual que siempre (compatibilidad total — antes nadie podía tener uno con `:`, así que no hay nada que preservar ahí). Para uno en una subcarpeta, o con `:param` en el nombre, se aplana con `-` (`api/producto:id` → `api-producto-id`) — evita tanto el choque entre dos páginas de igual nombre en carpetas distintas (un bug latente que ya existía, arreglado de paso) como un `:` suelto en el nombre del fichero de salida.

### `params`/`query`, nombres reservados

`params.campo` (segmentos dinámicos de la ruta) y `query.campo` (query string de la petición) están disponibles directamente en cualquier expresión de una página del sistema nuevo — sin `Visual.params(screen)`/`Visual.query(screen)`. Calculados:
- **SSR** (`renderPageToHTML`, con `routePattern` pasado por quien llama): matching real de `requestUrl` contra el patrón, vía `compileRoutePatternClient` (ya existente en `runtime.js`).
- **Cliente** (`generateClientBundle`, con `routePattern` pasado por quien llama): `params`/`query` son REACTIVOS de verdad (no un cálculo de una sola vez) — ver la sección siguiente.

**Solo se activan si el fichero NO tiene ya su propio `Visual.route()`** — quien llama (`bin/websc.js`, `serve-demo.js`) calcula `hasExplicitRoute` y solo pasa `routePattern` cuando es `false`. Una página del sistema antiguo sigue exactamente igual, sin `params`/`query` reservados de más (evita colisión con un nombre propio que el fichero ya use).

**Un descuido real que se encontró y se corrigió**: una página nueva SIN `:param` en la ruta pero que usa `{query.algo}` en su HTML se clasificaba como estática (precalculada una sola vez en el build, con `query` siempre vacío) porque la detección de "esta página usa la query" (`usesVisualQuery`) solo miraba `Visual.query(...)`, no el `query` reservado nuevo. Se añadió `usesReservedQuery` (comprobación deliberadamente conservadora, por texto) para cubrir este caso — un falso positivo solo hace que la página sea dinámica en vez de precalculada (siempre correcto, solo menos óptimo); un falso negativo habría servido una query siempre vacía (bug real).

Cableado en los TRES sitios que renderizan una página: `websc build` (build estático y el `dist/server.js` que genera, vía el campo `newSystemRoute` en `pages.json`) y `serve-demo.js` (SSR real por petición, sin distinción estático/dinámico).

### Límites conocidos de esta primera versión (deliberados, seguimiento pendiente)

- Solo un nivel de anidamiento dinámico por convención de nombre de fichero (no de carpeta).

### `goto()` y `params`/`query` reactivos (resuelto)

`Visual.navigate()` ya era genérico — no depende de `Visual.route()` ni de ninguna instancia de ruta — así que, comprobado con código real, **ya funcionaba en una página del sistema nuevo sin ningún cambio**. El hueco real no era "falta navegar sin recargar": era que `params`/`query`, calculados una sola vez al cargar el script (`const params = {...}`), no se actualizaban tras navegar.

**`goto(url, opts)`**: alias reservado y suelto de `Visual.navigate()` — mismo criterio que `params`/`query`, sin el prefijo `Visual.`. Es literalmente la misma función (`const goto = navigate;` en `runtime.js`); `Visual.navigate` sigue existiendo, sin cambios, para el sistema antiguo.

**`params`/`query` reactivos**: en vez de una `const` calculada una vez, se tratan como `Visual.route()`/`params()`/`query()` del sistema antiguo — se reutiliza el MISMO mecanismo ya existente (`routeDerivedDecls`/`dependsOnRoute`/el `effect()` combinado que los recalcula): cualquier `const`/`var` de nivel superior que mencione `params`/`query` por nombre (cuando `routePattern` está activo) entra en ese mecanismo, no en el camino normal de una vez — así que también se recalcula sola. `params`/`query` en sí se calculan al PRINCIPIO de ese mismo `effect()`, como locals normales (no como `state.params`/`state.query` reescritos), para que una `const` derivada las vea por closure normal de JS sin reescritura de por medio.

**Dos fallos encontrados al implementar, con ejecución real antes de darlo por bueno**:
1. La primera versión ponía el cálculo de `params`/`query` en un `effect()` SEPARADO del que recalcula los derivados (`routeEffectSource`) — un `const titulo = "Producto " + params.id` no se actualizaba tras `goto()`, porque vivía en un closure distinto sin acceso a los `params`/`query` recién calculados. Se corrigió fusionando ambos en un único `effect()`.
2. Antes de esa fusión, hacía falta que `params`/`query` estuvieran pobladas ANTES que cualquier const POST-estado que dependiera de ellas — la primera colocación (después de `topLevelSources`) daba `Cannot read properties of undefined`. Al fusionar con `routeEffectSource` (que ya se ejecuta antes de `topLevelSources`) y hacer que un `const` que las use entre en `routeDerivedDecls` en vez de en el camino normal, el problema desapareció por diseño — ya no hace falta razonar sobre el orden manualmente.

Verificado con ejecución real (JSDOM): `goto()` cambia la URL sin recargar; `params.id` se recalcula solo tras `goto()`; una `const` derivada de `params`/`query` también se recalcula; lo mismo tras el atrás/adelante del navegador (`popstate`); sin `routePattern`, no se emite ningún código de `params`/`query`; `Visual.navigate()` del sistema antiguo sigue funcionando exactamente igual.

### `staticPaths` en `wconfig.json` (resuelto)

Sin `screen`/`Visual.route()` en el sistema nuevo, no hay a qué instancia atar `Visual.staticPaths(screen, valores)`. Se movió a `wconfig.json`, leído por `websc build` (no por `dist/server.js` en tiempo de ejecución, que lee `wconfig.json` para otras opciones — generar los `.html` precalculados es cosa del build):

```json
{
  "staticPaths": {
    "/blog/entrada/:slug": [{ "slug": "primer-post" }, { "slug": "segundo-post" }]
  }
}
```

La clave es el PATRÓN DE RUTA tal cual (el mismo string que ya calcula `routePatternFor`). El valor es un array de combos inline, o una ruta (relativa a la raíz del proyecto) a un `.json` con ese array — para no duplicar datos ya existentes dentro de `wconfig.json`. Mismo comportamiento que el sistema antiguo en todo lo demás: se genera un `.html` real por combinación, y la ruta dinámica se queda registrada como red de seguridad (una combinación no listada se sirve por SSR real, no un 404).

Mutuamente excluyente con el sistema antiguo por construcción: solo se consulta `wconfig.json` cuando el fichero NO tiene ya su propio `Visual.route()` (mismo `routePatternForNewSystem` que ya decide si se pasan `params`/`query`).

Verificado con ejecución real (`websc build` + servidor real): combos inline; combos desde un `.json` externo; una combinación no listada servida por SSR dinámico real con `params` correctos; sin `staticPaths` en `wconfig.json`, una página con `:param` sigue siendo SSR dinámica de siempre; el sistema antiguo (`Visual.route()` + `Visual.staticPaths()` en el propio fichero) sin relación alguna con esta clave nueva.

### `visual` importable desde un `.ws` (resuelto)

Hoy un `.ws` se parsea con la misma gramática que un `.wsf` (`VisualDecl` es sintácticamente válido ahí), pero el import de un `.ws` nunca recogía ni exponía ese `VisualDecl` — `ws.declaredByName.get(name)` lo encontraba, pero el bucle por nombre de `processImport` solo hacía algo si `decl.type === "FunctionDecl"`; para una `VisualDecl` no pasaba nada, así que `<Tarjeta/>` se renderizaba como una etiqueta HTML desconocida en vez de como el componente.

**Diseño**: mismo mecanismo, dirigido por demanda, que ya usan las `function` de un `.ws` (`requestWsFunction`) — nueva `requestWsVisual`, que añade la visual pedida a `result.visualDecls` y, de forma transitiva, demanda lo que su propia plantilla referencia (otra function/const/visual del MISMO `.ws`, o algo que ese `.ws` importa). Ninguna `visual`, de un `.ws` o de un `.wsf`, necesita `export` para ser importable por nombre — mismo criterio que ya tenía un `.wsf`.

**Un fallo en el primer intento, encontrado al verificar con una visual que usa una function hermana**: la detección de qué referencia una visual usaba `JSON.stringify(visual.html)` pasado a `referencedNames` (el análisis de referencias ya existente, que primero intenta `acorn` y solo cae al escaneo por palabra si `acorn` falla al parsear). El problema: el HTML convertido a JSON **parsea como JS válido** (es, literalmente, un array de objetos anidados) — así que `acorn` lo acepta sin más, y el recorrido de identificadores nunca encuentra los nombres reales, porque están dentro de STRINGS (el valor de un nodo `Text`, p. ej. `"{formatear(props.titulo)}"`), no como sintaxis JS de verdad. `acorn` nunca "fallaba" ahí, así que el escaneo de reserva nunca se activaba. Se corrigió con un escaneo por palabra DIRECTO sobre el texto, sin pasar por `referencedNames`.

Verificado con ejecución real (SSR y cliente vía JSDOM, y de extremo a extremo con `websc build` + servidor real, dos instancias de la misma visual con `props` distintos): visual simple; visual que usa una function Y una const hermanas del mismo `.ws`; el patrón "dirigido por demanda" ya establecido (una visual seguridad de un `.ws` mixto no arrastra a otra insegura que toque un `.wsdb`, y si se pide la insegura, el error de siempre nombra el `.ws`); el mismo `.ws` alcanzado por dos caminos (diamante) sin duplicar la definición; una visual que llama a una function que ese `.ws` importa de un `.js`.


## `watch()` generalizado: cualquier reactive, no solo rutas (ya existía, documentado aquí)

`watch()` nunca estuvo limitado a una reactive atada a `WSON.listen()` — eso solo decide CÓMO llega el primer disparo (una petición HTTP real). Cualquier OTRA reactive con su propio `watch()` también se dispara, sin relación con rutas: el compilador reescribe el texto de cualquier función/`watch()` que reasigne una reactive con `watch()` propio, inyectando un `await __trigger("nombre")` (de sesión) o `await __triggerGlobal("nombre")` (global) justo después de esa línea, en el propio código generado — no es un motor de reactividad en tiempo de ejecución (como el `Proxy`/`effect()` del cliente), es una transformación en tiempo de COMPILACIÓN. Confirmado con código real: una ruta `/subir` que reasigna `global reactive contador` dispara el `watch(contador)` de al lado, sin que ese `watch()` tenga ninguna `WSON.listen()` propia.

### El bucle que esto permite, y las dos guardas

Como es una reescritura textual (no un `Proxy` con seguimiento de dependencias), un `watch()` que reasigna la MISMA reactive que observa inyecta OTRO `__trigger`/`__triggerGlobal` justo ahí — y si no hay nada que lo pare, se dispara a sí mismo sin fin. Reproducido con código real antes de corregirlo: `watch(contador) { contador = contador }` ya bastaba para reventar la pila (`RangeError: Maximum call stack size exceeded`) — la petición que lo disparó respondía bien de todos modos (el error ocurre dentro del propio `try/catch` de `__trigger`/`__triggerGlobal`, que lo atrapa y deja seguir el código siguiente), pero quedaba un error silencioso en los logs y la cascada nunca hacía lo que el `watch()` pretendía.

Dos guardas, en `__trigger` (por sesión, con alcance de una sola petición) y `__triggerGlobal` (global, compartida por todo el proceso):
1. **Si el valor no cambió de verdad respecto al último disparo atendido, no se llama al `watch()`** — mismo criterio que ya usa cualquier motor reactivo (React, Vue) para esto mismo. Cubre el caso típico: una corrección/normalización que, aplicada dos veces, da lo mismo (recortar a un máximo, por ejemplo — la segunda vez ya no hay nada que recortar). La comparación es por `===` (igualdad de referencia para objetos, no profunda) — deliberado: una comparación profunda sería mucho más cara, y ningún motor reactivo mayoritario la hace por defecto tampoco.
2. **Un límite de profundidad en cascada (50 niveles)**, como red de seguridad para el caso que la guarda 1 NO cubre — un valor que cambia de verdad en cada disparo, sin converger nunca (p. ej. `contador = contador + 1` sin ninguna condición de parada dentro de su propio `watch()`). Sin esto, ese caso seguiría reventando la pila; con esto, da un mensaje claro y accionable ("posible bucle — se superaron 50 disparos en cascada sin converger") en vez de un `RangeError` opaco.

**Un tropiezo propio al escribir las pruebas, que casi deja tests inútiles**: la primera versión de los tests solo comprobaba que la petición HTTP siguiera respondiendo con 200 — y PASABAN igual con el código roto, porque la petición responde bien de todas formas (el `RangeError` queda atrapado y solo se nota en los logs). Detectado al verificar los tests contra el código anterior (práctica habitual en este proyecto): pasaban los cinco, sin excepción — una señal clara de que no estaban probando nada real. Se rehicieron capturando `console.error` durante la petición y comprobando su contenido, no solo el código de estado.

Verificado con ejecución real: el caso reportado (mismo valor, global y de sesión) ya no revienta la pila; el caso patológico (valor que nunca converge) da el mensaje claro en vez de `RangeError`; un `watch()` que corrige una vez hacia un valor distinto (patrón de recorte) sigue funcionando sin bloquearse; un `watch()` normal, sin reasignarse a sí mismo, sigue disparándose igual que siempre.

## `shared reactive` — implementado

Una `reactive`/`global reactive` marcada `shared` se puede importar desde un `.wsf` (antes, cualquier import de un `.wsb` desde un `.wsf` estaba bloqueado en bloque, sin excepción — confirmado con código real antes de empezar) — el valor se sigue en vivo por WebSocket, y una escritura desde el cliente se manda como propuesta al servidor en vez de mutar localmente.

```
// servidor.wsb
shared global reactive cursores = {}

watch(cursores)
	if (Object.keys(cursores).length > 50)
		console.log("demasiados cursores activos")
```

```
// pizarra.wsf
import { cursores } from "./servidor.wsb"

<div>
	<p>Cursores conectados: {Object.keys(cursores).length}</p>
	<button onclick={cursores = { ...cursores, yo: { x: 10, y: 20 } }}>
		marcar mi posición
	</button>
</div>
```

### Diseño final (con una corrección importante respecto a lo discutido al principio)

- `shared` es una anotación explícita en la declaración, no inferida de `global` — así la ÚNICA forma de que algo de un `.wsb` cruce hacia un `.wsf` es que ya esté marcado a propósito. El import de un `.wsf` hacia un `.wsb` solo admite nombres `shared`; cualquier otro (function, reactive normal, const, algo inexistente) da un error específico.
- El registro de qué es `shared` en un `.wsb` es un escaneo en tiempo de compilación (mismo patrón que ya arma la tabla de rutas), no un fichero de configuración aparte.
- Un cliente nunca muta la reactive directamente — propone un cambio (`{ type: "propose", name, value }`); el servidor reasigna de verdad con ese valor, y SOLO esa reasignación real cuenta.
- **Corrección respecto al diseño inicial**: se había dicho que `watch()` solo debía dispararse por un evento entrante (un `propose`), nunca porque "el valor cambió desde cualquier otro sitio". Al implementarlo, esto resultó innecesario Y equivocado: `watch()` YA generaliza a cualquier reasignación de una `global reactive`, venga de donde venga (`extractPlainWatches`, ver la sección de arriba) — y es precisamente ESE mecanismo, ya existente y ya protegido contra bucles, el que se reutiliza tal cual. No hace falta (ni se intentó) restringir cuándo se dispara `watch()` para una `shared` — se dispara exactamente igual que para cualquier otra `global reactive`.
- La difusión a los clientes suscritos es INDEPENDIENTE de `watch()`: ocurre en CUALQUIER reasignación real de la `shared` (un `propose` aceptado, o código del servidor en cualquier otro sitio), tenga o no un `watch()` declarado. Si hay un `watch()` y corrige el valor, lo que se difunde es el valor YA corregido, nunca el propuesto tal cual — el `watch()` corre primero, la difusión después, dentro de la MISMA `__triggerGlobal` que ya dispara el `watch()`.
- Con `cluster-workers` (varios procesos), una `global reactive` no `shared` ya tiene hoy la misma grieta que el límite de peticiones por IP (`## Cluster`): cada worker cuenta por su cuenta. Para una `shared global reactive` esto se hereda tal cual, sin agravarlo — **el relevo entre workers por IPC sigue sin implementar**, ver límites al final.

### Protocolo (una única conexión WebSocket, compartida con `online function`)

Mismo `upgrade`, mismo despachador por `type` de mensaje que ya usaba `online function` (`wireWebSocketProtocol` — renombrada desde `wireOnlineFunctionsRpc`, porque ya hace más que eso):

```
{ type: "subscribe", name }
  -> { type: "update", name, value }   (inmediato, con el valor actual, y de nuevo cada vez que cambie)
{ type: "propose", name, value }
  -> (nada directamente — si se acepta, llega como un "update" más, igual que a cualquier otro suscrito;
      el servidor nunca "confirma" la propuesta en sí, solo difunde el valor real una vez aplicado)
```

El registro de suscriptores (`Map<nombre, Set<conexión>>`) vive en el mismo cierre que `getGlobalState()`/`__triggerGlobal` — compartido por todo el proceso, igual que el resto del estado global. Se limpia solo al cerrarse cada conexión (verificado: de 1 suscriptor a 0 tras desconectar, sin fuga de memoria).

### Un bug real encontrado al probarlo con un `watch()` que corrige: difusión duplicada

La primera versión difundía el valor DOS veces cuando un `watch()` corregía un `propose` — una desde quien causó el cambio original (que sigue ejecutando DESPUÉS de que el `watch()` en cascada ya terminó y ya difundió el valor corregido) y otra desde la propia corrección. Mismo valor final, mandado dos veces seguidas. Arreglado con una guarda de "¿esto ya se difundió?" — un mapa `sharedLastBroadcastValues`, PARALELO al que ya existía para `watch()` pero independiente de él (una `shared` puede no tener ningún `watch()`, y aun así necesita esta guarda si varias reasignaciones en cascada settlean en el mismo valor final).

### Un bug real encontrado al compilar el cliente: `substituteReactive` no sustituía dentro de un spread

`{ ...cursores, yo: {...} }` — la lectura `cursores` dentro del `...` no se convertía a `state.cursores`. Causa: la exclusión de `substituteReactive` para no reescribir un acceso a propiedad ya cualificado (`foo.cursores` no debe volverse `foo.state.cursores`) miraba "¿hay un punto justo antes?" — y el operador de propagación (`...cursores`) también TERMINA en un punto justo antes del nombre, así que caía en la misma exclusión por accidente. Arreglado con una exclusión más precisa: solo bloquea si lo que precede es una LETRA seguida de un punto (`\w\.`, un acceso a propiedad de verdad), no cualquier punto suelto. Es un bug preexistente, sin relación con `shared` en sí — simplemente nunca se había ejercitado antes (nada en la suite existente combinaba una reactive con el operador de propagación).

### Escritura desde cliente: reescritura de texto, no interceptación en el motor reactivo

`cursores = EXPR` se compila igual que cualquier otra reactive (`substituteReactive` la convierte en `state.cursores = EXPR`, para que las LECTURAS — incluida cualquiera dentro de `EXPR`, como `...cursores` — usen la maquinaria de siempre). Una pasada aparte, `rewriteSharedAssignments`, sobre el BUNDLE YA ENSAMBLADO COMPLETO (no en cada punto de compilación por separado — atributos, eventos, cuerpos de function — para no arriesgarse a olvidar alguno), convierte cualquier `state.nombre = EXPR;` en `__proposeShared("nombre", (EXPR));`. Limitación deliberada: solo cubre `=` simple; un operador compuesto (`+=`, `++`...) sobre una `shared` no se reescribe todavía.

### Verificado con ejecución real

Protocolo de servidor con conexiones WebSocket reales (`subscribe` manda el valor actual de inmediato; `propose` llega también a quien lo mandó, no solo a los demás; un `watch()` que corrige difunde el valor corregido, una sola vez; una `shared` sin ningún `watch()` se difunde igual; `online function` y `shared reactive` conviven en la misma conexión). Generación de cliente (la conexión, la suscripción, el manejo de `update`, la reescritura de una escritura simple y de una escritura-con-lectura-propia). Y de extremo a extremo con JSDOM + servidor real: **dos pestañas independientes, una hace clic y la otra se entera sola, sin recargar ni tocarla** — y un `watch()` que corrige en el servidor se refleja en el cliente con el valor ya corregido.

### Límites conocidos, explícitamente no implementados

1. **Relevo entre workers por IPC** para `cluster-workers` — una `shared global reactive` en un despliegue con varios procesos puede desincronizarse entre workers, igual que ya le pasa hoy a cualquier `global reactive` sin `shared`.
2. **Operadores de asignación compuestos** (`+=`, `++`, `--`) sobre una `shared` no se reescriben a `propose` — solo `=` simple.
3. **Una propuesta mandada antes de que la conexión WebSocket termine de abrirse se pierde en silencio** — sin cola de reintento ni aviso. Un reintento o una cola de propuestas pendientes queda para una vuelta futura.

Detalle completo de la discusión de diseño (incluida la corrección sobre "dos mundos a la vez" en un `if`/`else`, y la corrección sobre si `watch()` ya cubre esto automáticamente) en `INSTRUCCIONES.md`.
