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

Se mantiene `useRoute('/getEjemplo')` para las llamadas al servidor.

`query()` y `params()` (globales, sin `WSON.` delante) están disponibles en rutas GET que renderizan un `visual` con parámetros en la URL (`:id`) — es la contraparte de `WSON.query()`/`WSON.params()`, que solo aplican dentro de un handler de `WSON.listen()`.

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
	// llamar a WSON.send(respuesta) aquí responde la petición entrante
	// (no es una llamada saliente nueva); ni httpCode ni send() son
	// obligatorios — sin ellos, se responde 200 por defecto
```

`WSON.listen(wson)` lee la estructura del WSON y valida que `via` (method) y `to` coincidan con la petición entrante:

- **`to`**: endpoint + params de ruta (`/getEjemplo/:id`). Cualquier segmento `:algo` se trata como comodín a efectos de matching y de la validación de colisiones — el nombre del parámetro no importa, solo su posición en la ruta. Se captura con `WSON.params(peticion)` dentro del `watch()`.
- **`via`**: method (POST, PUT, DELETE). Para GET, el script se ejecuta tal cual; si no se llama a `WSON.send()` al final, se devuelve por defecto un JSON `{status: OK}`.
- La **query string no forma parte de `to`** — no identifica una ruta distinta, solo filtra/parametriza la misma ruta.
- **`WSON.query(peticion)`** y **`WSON.params(peticion)`**: única vía de acceso a query string y params de ruta dentro del `watch()` — estáticos, como toda la API de `WSON`; se les pasa la instancia recibida. No hay inyección automática de esos valores en el content del WSON.
- **El descifrado no es automático** — si el WSON recibido está cifrado, hay que llamar a `WSON.showContent()` explícitamente dentro del `watch()`.

**Validación:** no pueden registrarse dos `WSON.listen()` con el mismo endpoint + method — se valida en compilación para evitar colisiones silenciosas. Rutas con params dinámicos (`/ruta/:id` vs `/ruta/:otroNombre`) deben normalizarse para detectar la colisión aunque el texto no coincida.

Cada petición entrante se compara contra **todos** los `WSON.listen()` registrados, por `via` y `to` — de ahí que el WSON ad-hoc usado para escuchar deba compartir exactamente el mismo `to`/`via` que el `.wson` del DTO que se espera recibir: es lo que hace que un `Persona` enviado con `to: "/personas"` acabe disparando el `listen()` que escucha justo en `/personas`.

**Reactividad:** un WSON puede ser reactivo y capturar su contenido con `watch`, tanto en front como en back.

## POO: clases núcleo

- **`Visual.ws`** y **`WSON.ws`**: clases núcleo del runtime, invocables tanto de forma estática (`Visual.render(visual)`) como por instancia (`new Visual().render()`). `Visual.ws` es responsable también de SSR/SSG — el servidor devuelve HTML real desde la primera petición, no una concha vacía que rellena el cliente.
- Los DTOs generados desde `.wson` heredan siempre de `WSON` (`extends WSON`), sin herencia DTO-a-DTO.
- `WSON.ws` expone getters/setters genéricos para todos los campos definidos en el esquema; **el setter respeta la validación de tipo del esquema**, incluso al sobreescribir.
- `WSON.ws` autogenera un `id` en formato **UUID**, **en el momento de `.send()`** (no en la construcción), y ese campo es de solo lectura incluso vía el setter genérico.
- `httpCode` es un campo opcional que solo aplica si el WSON se envía por HTTP. Viaja **fuera del bloque cifrado** — no es información confidencial, así que no necesita descifrado previo para aplicar el código de estado. Si se informa y el envío es por WebSocket, se ignora en runtime con warning en compilación/dev. Sustituye por completo al antiguo `respond(status, cuerpo)`, que desaparece.

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
- **`to`/`via` son un destino real**, no solo metadata descriptiva: cuando se envía una instancia con `WSON.send()`, viaja de verdad a ese endpoint por ese method. Si coincide con el `to`/`via` de un `WSON.listen()` propio (mismo valor), el envío se recibe a sí mismo — así es como un `.wsf` habla con su propio `.wsb` sin ningún mecanismo especial: simplemente `to` apunta a la ruta de tu propio backend.

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

## Seguridad: CSRF

Protección con cookie de doble envío (`wcsrf` + cabecera `X-WebScript-CSRF`), verificada en tiempo constante. La primera petición de una sesión completamente nueva no exige el token (una sesión recién creada no es algo que un atacante pueda secuestrar).

**Alcance:** CSRF solo se comprueba en peticiones que ya traen cookie de sesión de WebScript (en la práctica, llamadas desde `.wsf` propio o entre sistemas que también son WebScript y comparten ese mecanismo de sesión). Un sistema externo que no usa WebScript no tiene esa cookie, así que no pasa por la comprobación — su autenticidad depende de `secret`/`encrypt` de WSON si la necesita. Es una separación por diseño: **CSRF protege sesiones de navegador**, **la firma/cifrado de WSON protege autenticidad entre sistemas** — no se sustituyen entre sí, y un sistema no-WebScript sencillamente no entra en el primer mundo.

## Cluster

`cluster-workers`: varios procesos Node reales con sesiones pegajosas. Cada worker cuenta el rate limit por su cuenta — con N workers, el límite efectivo para una IP insistente puede llegar a ser hasta N veces el valor configurado.

## Proyectos backend puro

Un proyecto puede tener solo ficheros `.wsb` y ningún `.wsf` — sirviendo solo API, sin ninguna vista.

## WSON: seguridad y transporte (heredado de la versión anterior)

Campos adicionales de un WSON, más allá de `from`/`to`/`via`/`content`:

- **`secret`**: clave para firmar. Solo permitido en un WSON de servidor — rechazado en compilación si aparece en uno de cliente (el secreto quedaría expuesto en el bundle del navegador).
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
- `useRoute('/getEjemplo')` se mantiene enfocado en GET / renderizar visual; WSON es el mecanismo para el resto de comunicación cliente-servidor dentro del proyecto.
- Firma/cifrado siguen siendo necesarios (y obligatorios por las reglas de arriba) para comunicación **entre sistemas distintos**, no dentro del mismo proyecto.

## CLI: `websc update`

Además de `websc init`, se implementará `websc update` para actualizar un proyecto existente a una nueva versión de WebScript (regenerando `lib` y el compilador vendorizados) sin tocar el código propio del usuario.

## Control de versiones

`.gitignore` por defecto en proyectos generados por `init`, ignorando `lib` y el compilador vendorizado (tratados como regenerables vía `websc update`, similar a `node_modules`).

## Pendiente de definir

- **WebSocket** (`via: "socket"`): queda dormido por ahora, fuera del alcance de esta reescritura.
