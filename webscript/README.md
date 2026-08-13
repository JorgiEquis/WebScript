# WebScript

Lenguaje que unifica HTML, CSS y JS en un único archivo `.ws`, con reactividad
de primera clase. Compilador escrito en Node.js.

## Uso

```bash
node src/cli.js build examples/contador.ws --out dist
```

Esto genera `dist/index.html`, `dist/styles.css` y `dist/bundle.js`. Abre
`index.html` en el navegador.

## Tests

```bash
npm test
```

Corre la suite completa con el *test runner* nativo de Node (`node:test`,
sin dependencias que instalar) — **58 tests, 17 suites**, cubriendo:

- **`tests/parser.test.js`** — todas las declaraciones (`reactive`, `var`,
  `style`, `visual`, `route`, `server var`, `server function`,
  `post function`, `import`), `if`/`for`, comentarios, y los errores
  esperados (indentación de `else`, imports circulares, `route()` fuera
  de sitio...).
- **`tests/validate.test.js`** — colisiones de nombre entre espacios
  (compartido vs. `style` separado), recursión de visuales (directa e
  indirecta), la restricción de `server var`/`server function` en
  visuales y su única excepción (`post function`).
- **`tests/html-parser.test.js`** — interpolaciones con llaves anidadas,
  *template literals*, normalización de espacios.
- **`tests/compiler.test.js`** — **ejecuta bundles reales** contra un mock
  de DOM (`tests/helpers/dom-mock.js`, aislado por test con
  `vm.createContext`): reactividad, `if`/`for`, diffing por clave
  (comprobando reutilización real de nodos, no solo el resultado visual),
  estado local vs. global, *destructuring*/atajos de objeto.
- **`tests/server.test.js`** — arranca un servidor HTTP real en un puerto
  efímero y usa `fetch` nativo: `post function`, sesiones aisladas por
  cookie, persistencia de `server var`.

Esta suite formaliza en tests permanentes todo lo que fui comprobando a
mano a lo largo de esta conversación — incluida la limitación real del
motor de respaldo (sin Acorn) que salió al escribirla: tras un
*destructuring*, una referencia posterior en el mismo bloque no hace
*shadowing* correctamente (`tests/compiler.test.js`, comprueba ambos
comportamientos según si Acorn está disponible o no).

## Sintaxis (v0.1)

### `reactive` — variables reactivas
```
reactive contador = 0
```
Cualquier `visual` que use `contador` en una interpolación `{contador}` o en
un handler se re-vincula automáticamente cuando la variable cambia.

### `style` — bloques CSS
```
style boton =
    -> background-color: blue
    -> color: white
```
Cada `-> propiedad: valor` es una línea CSS literal. Se compila a una clase
`.boton { ... }`.

### `visual` — bloques HTML
```
visual contadorBtn =
<button>
    Clicks: {contador}
</button>
    -> style: boton
    -> onclick:
        contador++
```
- Todo lo que va **antes** de la primera línea `->` es la plantilla HTML
  (soporta anidamiento, atributos, `{expr}` de interpolación en texto y
  atributos).
- Las líneas `->` después de la plantilla son **bindings** sobre el elemento
  raíz:
  - `-> style: NOMBRE` añade la clase CSS del `style` correspondiente.
  - `-> onXXX:` (p. ej. `onclick`, `onchange`, `onkeyup`) seguido de un bloque
    indentado define el handler; dentro puedes usar directamente las
    variables `reactive` (se compilan a `state.variable`).
  - Cualquier otro `-> atributo: valor` se compila a `setAttribute`.

### Estado local por instancia (lo que separa esto de React de verdad)

Una `reactive` declarada **dentro** de un `visual`, justo después del `=`,
es privada de esa instancia — no de la clase de visual, sino de cada
llamada concreta a `create_X(...)`:

```
visual contadorLocal =
    reactive contador = 0
<button>
    Clicks: {contador}
</button>
    -> style: boton
    -> onclick:
        contador++

visual app =
<div>
    <contadorLocal />
    <contadorLocal />
</div>
```

Cada `<contadorLocal />` genera internamente su propio `createStore(...)` —
dos Proxys distintos, dos contadores independientes, aunque comparten la
misma función `create_contadorLocal`. Esto NO es azúcar sintáctico sobre
React: en el modelo de React, `useState` vive ligado a la posición del
componente en el árbol de fibra y React se encarga de la identidad entre
renders; aquí no hay árbol de fibra ni re-renders — el store se crea una
vez, en el closure de esa llamada a `create_contadorLocal`, y vive mientras
el elemento exista en el DOM.

Una `reactive` declarada a nivel de archivo (fuera de cualquier `visual`)
sigue siendo **global** y se comparte entre todos los visuales, como antes.
Puedes mezclar ambas en el mismo `visual`: el compilador detecta, por cada
expresión, si depende de estado local, global o ambos, y genera el/los
`effect()` correspondientes (mira `injectVars`/`emitReactive` en
`compiler.js` si quieres ver el detalle).

### `if` / `else if` / `else` y `for`

Condición entre paréntesis, cuerpo por indentación (igual que todo lo demás
en WebScript — sin delimitadores de cierre):

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

- El cuerpo puede tener varias líneas, varios tags, `{interpolaciones}`, e
  incluso otro `if`/`for` anidado (con más indentación) — no hay límite,
  porque reutiliza el mismo mecanismo de indentación que `visual`/`style`.
- Un `if`/`for` puede vivir **dentro** de un tag abierto (ej. un `<div>` que
  se cierra después del bloque) — el parser mantiene la pila de tags
  correctamente a través del bloque de control.
- Si la condición (o la lista) depende de una `reactive` (local o global),
  el bloque entero se **re-renderiza** cada vez que cambia: se marca su
  posición con un nodo comentario invisible ("ancla") y, en cada disparo del
  `effect`, se borra lo que había ahí y se reconstruye desde cero justo en
  esa posición — nada de virtual DOM, es sustitución directa de un tramo
  concreto del árbol.
- `for` **sí hace diffing por clave** (ver sección dedicada más abajo) —
  reutiliza nodos DOM existentes en vez de reconstruir toda la lista en
  cada cambio.
- Para mutar una `reactive` que es un array, reasigna el array completo
  (`lista = [...lista, nuevo]`), no uses `.push()` — el sistema reactivo
  solo detecta el `set` de la propiedad completa, no mutaciones internas.

## `for` con clave: diffing real, no reconstrucción completa

```
for (item in lista)              // sin clave -- usa el índice como clave
for (item in lista by item.id)   // con clave -- recomendado para listas que
                                  // se reordenan, insertan o eliminan en medio
```

Por cada elemento de la lista, se guarda un `Map<clave, {item, nodos}>` que
**persiste entre renders** (vive fuera del `effect`, en el closure). En
cada cambio:

- Si la clave ya existía **y** el ítem es el mismo objeto (`===`) que la
  vez anterior → se reutiliza el nodo DOM tal cual, sin tocarlo.
- Si la clave existe pero el ítem cambió → se reconstruye solo ese ítem
  (no toda la lista).
- Si una clave ya no está en la lista nueva → se elimina su nodo.
- El orden final se aplica encadenando inserciones (`insertBefore` en
  cadena, no con una única referencia fija) — necesario para que la
  reutilización no desordene los elementos que ya estaban posicionados.

**Sin `by`**, se usa el índice como clave — sigue siendo correcto (nunca
muestra datos equivocados), pero pierde el beneficio de reutilización si
la lista se reordena o se inserta/elimina en medio (los índices de todo lo
que viene después cambian, así que ya no "coinciden" con el elemento
correcto). **Con `by`**, la clave es estable independientemente de la
posición, así que insertar/eliminar en cualquier punto reutiliza
correctamente el resto.

Verificado con instrumentación real (contando cuántos nodos DOM se crean
de más, no solo mirando el resultado): añadir un elemento a una lista de 2
crea exactamente **1** nodo de texto nuevo, no 3; y al eliminar el primero
de una lista con clave, los elementos restantes son literalmente **los
mismos objetos DOM** de antes (`===`), no copias — solo se reposicionan.

**Bug real que encontré implementando esto**: mi primer intento reutilizaba
un único punto de inserción fijo (`anchor.nextSibling`, calculado una vez)
para insertar todos los nodos del render — eso funcionaba bien cuando
todos los nodos eran nuevos (como en `if`), pero al reutilizar nodos ya
posicionados de un render anterior, el orden salía mal (`pera, kiwi,
manzana` en vez de `manzana, pera, kiwi`). El algoritmo correcto encadena
cada inserción a partir de la anterior (`insertBefore` relativo al último
nodo colocado, no a una referencia fija), recalculando la posición en cada
paso — el mismo patrón que usan Vue/Svelte para reconciliar listas con
clave.

### Segunda ronda de bugs: `if` anidado dentro de `for`

Preguntando si un `if` dentro de un `for` podía usarse para simular "el
servidor manda contenido nuevo" (ver más abajo, "por qué una `post
function` no puede redefinir un `visual`"), encontré dos bugs reales
encadenados, los dos en el mismo sitio:

1. **`TypeError` real al reordenar**: un `if` anidado dentro de un `for`
   devuelve un *fragmento* temporal (su propio contenedor). El algoritmo
   de diffing por clave guardaba esa referencia para poder reutilizarla en
   renders futuros — pero un fragmento se **vacía** la primera vez que se
   inserta (sus hijos se mueven de verdad al árbol real, el fragmento en
   sí queda sin `parentNode`). Reutilizarlo en un render posterior era un
   no-operación sin forma de saber "cuánto avanzar" al reordenar.
   **Arreglado aplanando el fragmento a sus nodos reales en el momento de
   construir cada ítem** — así siempre se rastrean nodos de verdad, nunca
   un contenedor ya vacío.
2. **Tras arreglar eso, el orden seguía saliendo mal** (`2,1,0` en vez de
   `0,1,2`). La investigación llevó hasta algo inesperado: **mi propio
   mock de pruebas nunca había implementado `.previousSibling`** — una
   propiedad estándar de cualquier DOM real que el código generado sí
   necesitaba para un intento de arreglo intermedio. Al ser `undefined`,
   la lógica de "avanzar la posición" nunca avanzaba.

**La solución final resultó más simple que mis primeros intentos**: como
ahora los fragmentos anidados se aplanan a nodos reales al construir cada
ítem, ya no hace falta ningún truco de inferencia de posición mirando el
DOM después de insertar — basta con encadenar directamente sobre el nodo
que se acaba de insertar (`__after = n`), sin necesidad de recalcular nada
más. Verificado con un caso real: un `feed` que crece con cada click,
donde cada elemento decide su propia estructura interna vía `if`/`else if`
según su tipo — el orden se mantiene correcto tras varias inserciones
sucesivas, y hay un test permanente (`tests/compiler.test.js`,
"if anidado dentro de for") que lo cubre.

### Tipos: string, integer, double, boolean, operaciones, concatenación

No hace falta ninguna sintaxis nueva — como las expresiones se compilan como
JS "casi crudo" (solo con sustitución de identificadores reactivos), todo
esto **ya funciona** directamente:

```
reactive nombre = "Jorge"
reactive edad = 25
reactive precio = 19.99
reactive activo = true

visual resumen =
<div>
    <p>Hola {nombre}, tienes {edad} años</p>
    <p>Total: {(precio * 3).toFixed(2)}</p>
    if (activo)
        <p>Cuenta activa</p>
    else
        <p>Cuenta inactiva</p>
</div>
```

- **Operaciones aritméticas** (`precio * cantidad`, `edad + 1`) y
  **comparaciones** (`edad >= 18`) funcionan igual dentro de `if`/`for` que
  en cualquier interpolación.
- **Concatenación**: no hace falta operador especial — mezclar texto
  literal e interpolaciones en el mismo texto (`Hola {nombre}, tienes
  {edad} años`) ya concatena todo junto.
- **Métodos nativos de JS pasan intactos**: `{(precio * cantidad).toFixed(2)}`
  funciona tal cual, porque `.toFixed` no coincide con ningún nombre
  `reactive`, así que el compilador no lo toca. Útil para redondear
  `double`s (recuerda que son floats de JS: `19.99 * 5` puede dar
  `99.94999999999999`, no un bug, es representación binaria estándar —
  usa `.toFixed(n)` para mostrarlo bien).
- **Tipado opcional y superficial** (ver sección dedicada más abajo):
  `reactive number edad = 25` — comprobado solo cuando el valor inicial es
  un literal simple, sin sistema de tipos real detrás.

(Nota histórica: al probar esto encontré y arreglé un bug real de espaciado
en `parseTextNode` — `.trim()` se comía los espacios entre texto literal e
interpolaciones, `"Hola {nombre}"` renderizaba `"HolaJorge"` sin espacio.
Corregido normalizando solo el espacio "estructural", de indentación.)

### Tipado opcional (`reactive`/`var`)

```
reactive string nombre = "Jorge"
reactive number edad = 25
reactive boolean activo = true
var number iva = 21
```

- **Opcional**: `reactive nombre = "Jorge"` (sin tipo) sigue funcionando
  exactamente igual que siempre — nada de esto rompe compatibilidad.
- **Solo `reactive`/`var`** — `visual`/`style` no llevan tipo, mantienen su
  propia palabra clave tal cual (decisión explícita: un `visual` no es un
  valor escalar, es un bloque estructural completo con su propia gramática;
  forzarlo al mismo esquema `var TIPO nombre` habría añadido una capa de
  indirección sin ganar claridad).
- **Funciona igual en variables locales** de un `visual`
  (`reactive number contador = 0` dentro de un `visual`).
- **Comprobación superficial, no un sistema de tipos real**: solo se valida
  cuando el valor inicial es un literal simple (`"texto"`, `5`, `true`). Si
  el valor es una expresión (`precio * 1.21`, una llamada a función, otra
  variable...) no se comprueba nada — no hay inferencia de tipos, fingir
  que sí la hay sería peor que no comprobar. El compilador **no genera
  ningún código distinto** según el tipo declarado — es pura anotación,
  validada una vez en compilación, cero coste ni cambio en el `bundle.js`
  resultante.
- Tipos reconocidos: `string`, `number`, `boolean`.

**Por qué `reactive`/`var` se quedan como palabras clave separadas, en vez
de colapsar todo en `var`/`const`**: la distinción reactivo/no-reactivo es
la más importante que tiene el lenguaje (dispara o no un re-render), y
usar `const` para "reactivo" habría chocado con lo que cualquiera que sepa
JS espera de esa palabra — en JS `const` significa "no se puede
reasignar", y las variables reactivas de WebScript se reasignan
constantemente (`contador++`). Mantener `reactive` como su propia palabra
clave evita esa confusión, justo para el público que más la notaría.

### `server var` — variables SOLO de servidor

Variables que **nunca** se compilan a `bundle.js` y que **no pueden usarse
dentro de ningún `visual`** — el compilador lo valida y rechaza el archivo
si lo intentas.

```
server var contador
server var num1 = 100
```

> **Nota**: existió también `server reactive` como variante, con la idea de
> que algún día significara algo distinto (por ejemplo, empujar la
> actualización a los clientes conectados en tiempo real vía WebSocket). Se
> quitó porque, sin esa pieza construida, se comportaba **exactamente
> igual** que `server var` — dos nombres para lo mismo. Si escribes
> `server reactive NOMBRE`, el compilador te lo dice explícitamente y te
> sugiere `server var NOMBRE`. El día que haya push real en tiempo real,
> puede volver con semántica propia.

- Solo a nivel de archivo (no hay `server` local dentro de un `visual` —
  no tendría sentido, un `visual` siempre se compila a cliente).
- El valor inicial es opcional: `server var contador` arranca en
  `undefined`, igual que un `let` sin inicializar. Con `= valor`
  (`server var limite = 100`) se inicializa como cualquier otra declaración.
- Se compila a un archivo **separado**, `server.js`, que expone las
  variables mediante getters/setters (`module.exports = { get contador()
  {...}, set contador(v) {...} }`). Este archivo no forma parte de lo que
  sirves al navegador.
- **Persiste mientras el proceso Node esté vivo**: es lo único en
  WebScript que sobrevive entre peticiones separadas — probado con
  `post function` acumulando un contador a través de varios `POST`
  distintos (`5` → `8` → `18`). Una variable declarada dentro de una
  `post function` (sin `server var`) se reinicializa en cada llamada y
  nunca acumula nada — lo comprobé a propósito para confirmarlo.
- **Restricción activa, no solo documental**: si un `visual` referencia una
  `server var` en cualquier sitio — interpolación, atributo, condición de
  `if`, iterable de `for`, handler, o incluso en sus `reactive`/`var`
  locales — el compilador lanza un `SyntaxError` señalando el visual y el
  nombre en conflicto, antes de generar nada.
- Comparte espacio de nombres con `reactive`/`var`/`visual`/`post function`
  (no puedes repetir un nombre entre cliente y servidor, para evitar
  ambigüedad al leer el archivo).

### `var` — variables NO reactivas

Igual que `reactive`, pero se evalúa **una sola vez** — al crear el `visual`
(si es local) o al cargar el archivo (si es global). Si cambia una
`reactive` de la que depende, **no se recalcula ni re-renderiza nada**:

```
reactive precioBase = 100
var iva = precioBase * 0.21    // se calcula UNA vez con el valor inicial de precioBase

visual panel =
<div>
    <p>Precio base: {precioBase}</p>
    <p>IVA (fijo): {iva}</p>
</div>
```

Si luego `precioBase` cambia (por ejemplo con `precioBase = precioBase +
10` en un handler), `Precio base` se actualiza en pantalla pero `IVA` se
queda congelado en el valor con el que se calculó la primera vez. Útil para
cálculos que no necesitan re-renderizar la UI — validaciones, transformaciones
puntuales, valores derivados que solo importan en el momento de la carga,
lógica de servidor/preparación de datos que no debería disparar reactividad.

- **Global** (`var` fuera de cualquier `visual`): se compila a un `let` de
  JS a nivel de módulo, justo después del store global. Puede leer
  `reactive` globales (se sustituyen por `state.X` igual que en cualquier
  otra expresión).
- **Local** (`var` dentro de un `visual`, después de las `reactive`
  locales si las hay): se compila a un `let` dentro de `create_NOMBRE(...)`,
  evaluado una vez por instancia. Puede leer tanto `reactive` locales
  (`localState.X`) como globales (`state.X`).
- Por debajo es un `let`, no un `const` real de JS — si lo reasignas dentro
  de un handler (`etiqueta = "otra cosa"`), no lanza error, simplemente
  cambia la variable en memoria sin que se refleje en el DOM (porque nada
  la está observando con `effect`). Es "no reactiva" en el sentido de "no
  dispara renderizado", no en el sentido de "inmutable".

### Jerarquía / composición de `visual`

Un `visual` puede usar otro `visual` como si fuera un tag más dentro de su
plantilla — el compilador detecta que el nombre coincide con un `visual`
declarado y, en vez de crear un elemento HTML, llama a su función
`create_NOMBRE(...)`:

```
visual panelTarjeta =
<div>
    <h3>{props.titulo}</h3>
    <slot />
</div>
    -> style: tarjeta

visual app =
<panelTarjeta titulo="Panel de control">
    <contadorBtn />
</panelTarjeta>
```

- **Props**: los atributos que le pones al tag-componente (`titulo="..."`)
  llegan como un objeto `props` al `visual` referenciado. Dentro de su
  plantilla se leen como `{props.titulo}`, y en los bindings/handlers también
  puedes usar `props.algo` directamente (no se reescribe, solo los nombres
  `reactive` se sustituyen por `state.X`).
- **`<slot />`**: marcador especial dentro del `visual` hijo — ahí se insertan
  los hijos que el que lo usa puso entre `<panelTarjeta>...</panelTarjeta>`.
  Si el hijo no tiene ningún `<slot />`, cualquier contenido pasado entre
  etiquetas simplemente se ignora.
- El estado `reactive` sigue siendo **global**: un `visual` anidado varios
  niveles adentro puede leer/escribir la misma variable `reactive` y todo se
  mantiene sincronizado, porque todos comparten el mismo `state` (Proxy) y el
  mismo sistema de `effect`.
- No hay chequeo de recursión: un `visual` que se referencia a sí mismo
  (directa o indirectamente) generará un bucle infinito en tiempo de
  ejecución — es responsabilidad de quien escribe el `.ws`, de momento.

### `render(...)`
```
render(
    contadorBtn
)
```
Monta uno o más `visual` en `#app`.

## Métodos de array/string/number

Como las expresiones son JS real (con sustitución de nombres), cualquier
método nativo funciona tal cual. Comprobado con código real, ejecutado, no
solo compilado:

- **Array**: `.length`, `.map()`, `.filter()`, `.reduce()`, `.join()`,
  `.includes()` — en interpolaciones y como iterable de `for`
  (`for (n in numeros.filter(x => x > 2))`).
- **String**: `.toUpperCase()`, `.split()` (incluso indexado después,
  `.split(" ")[0]`), `.trim()`, `.slice()`, `.includes()`, encadenados
  (`.trim().slice(0, 5)`).
- **Number**: `.toFixed()`, `.toString()`, `Math.round()`.
- **Reasignación con spread** (`lista = [...lista, "c"]`) sigue
  disparando la reactividad del `for` correctamente.

**Bug real que encontré probando esto**: los *template literals* de JS
(`` `Hola ${nombre}` ``) dentro de una interpolación `{}` de WebScript se
rompían. El motivo: el código que separaba texto de `{expr}` usaba un
regex que para en la **primera** `}` que encuentra — y un template literal
con `${...}` tiene una `}` de más antes de la que realmente cierra la
interpolación de WebScript. El resultado no era un error, era JS inválido
generado en silencio (`` `Hola ${state.nombre; }); ``, con la plantilla
cortada a la mitad).

Arreglado sustituyendo el regex por un escáner manual (`html-parser.js`)
que cuenta profundidad de llaves real y respeta comillas/*backticks* —
mismo arreglo aplicado también a los atributos con `{expr}` (`parseAttrs`
tenía el mismo problema: `<div data-info="{JSON.stringify({a: 1})}">`
también se cortaba en la primera `}` interna).

## `import` — archivos sin `render()` como almacén compartido

Un `.ws` sin `render()` (ni `route()`) no es una página — es un almacén de
declaraciones que otros archivos pueden importar por nombre:

```
// compartido.ws (sin route, sin render -- es una librería)
style botonPrimario =
    -> background-color: #2563eb
    -> color: white

visual encabezado =
<h1>
    Sitio de ejemplo
</h1>

server function calcularIva(precio)
    return precio * 1.21
```

```
// pagina.ws
route("/")

import { botonPrimario, encabezado, calcularIva } from "./compartido.ws"

visual paginaPrincipal =
<div>
    <encabezado />
</div>
    -> style: botonPrimario

render(
    paginaPrincipal
)
```

- Se puede importar cualquier declaración con nombre: `reactive`, `var`,
  `visual`, `style`, `server var`, `server function` (incluso `post
  function`, aunque no tiene mucho sentido fuera de su propia ruta).
- **El archivo importado no puede tener `route(...)` ni `render(...)`** —
  eso lo convertiría en una página, no en un almacén. Error claro si lo
  intentas.
- La resolución de imports pasa **antes** de la validación de nombres
  duplicados: si importas algo que choca con un nombre ya declarado en tu
  propio archivo, es el mismo error de siempre (nombre duplicado, con
  líneas de ambos sitios).
- **Detecta imports circulares** (A importa B que importa A, directa o
  indirectamente) y falla con un mensaje claro en vez de colgarse en un
  bucle infinito.
- Las rutas son relativas al archivo que hace el `import`, resueltas con
  `path.resolve` normal de Node.
- Un archivo librería que use `server function`/`server var` internamente
  sigue siendo invisible al cliente igual que si estuvieran en el mismo
  archivo — la restricción de "prohibido en visuales" se aplica sobre el
  árbol ya fusionado, así que no hay forma de esquivarla importando.
- `site`/`serve` ya omitían (con aviso) los `.ws` sin `route()` al escanear
  un directorio — eso es exactamente lo que hace que un archivo librería no
  se intente compilar como página por su cuenta, solo se usa vía `import`.

**Bug real que encontré haciendo esto** (no relacionado con imports en sí,
pero lo destapó): el detector de "dónde termina la plantilla de un
`visual`" solo reconocía `reactive`/`style`/`visual`/`render(` como señal
de que empezaba la siguiente declaración de nivel superior. Cualquier cosa
más nueva (`server`, `post function`, `import`, `route(`, e incluso `var`
suelta) que apareciera justo después de un `visual` sin bindings de por
medio se tragaba en silencio como si fuera texto HTML del visual anterior
— sin error, resultado simplemente incorrecto. Arreglado ampliando la
lista de palabras clave reconocidas como límite.

## Cuatro correcciones (indentación, scoping de `for`, recursión, llamadas a función)

**1. Fuga de indentación fuera de `if`/`for`**: comprobado, **no hay fuga real** —
lo que está dentro de un `if`/`for` se queda dentro, lo que está fuera (misma
columna que el `if`/`for`) queda fuera. Sí encontré un bug cosmético relacionado:
aparecían nodos de texto `" "` (un espacio suelto) justo dentro y justo después
de cada bloque de control. Causa: cuando `if`/`for` corta la plantilla en varios
tramos de HTML, el primer tramo tras el corte es a veces una única línea sin
ningún `\n` propio delante — así que su indentación no se reconocía como
"estructural" (la regla necesitaba un salto de línea de referencia). Arreglado
en `template-parser.js` anteponiendo un `\n` a cada tramo antes de tokenizarlo.

**2. `for` con nombre de variable igual a una `reactive`**: antes colisionaba de
verdad (`for (contador in lista)` con `reactive contador` existente hacía que
`{contador}` dentro del bucle leyera `state.contador`, no el elemento actual).
Ahora hay *scoping* real: `ctx.boundNames` marca qué nombres están "atados" por
el ámbito léxico del `for`, y esos SIEMPRE ganan sobre cualquier
`reactive`/local con el mismo nombre — igual que en cualquier lenguaje con
scopes de verdad. Probado: `for (contador in lista)` con `reactive contador =
100` ahora imprime los elementos reales de `lista`, no `100` repetido.

**3. Un `visual` no puede llamarse a sí mismo**: nueva validación construye el
grafo de "qué visual usa a cuál otro" (recorriendo cada plantilla en busca de
tags-componente) y busca ciclos con DFS. Detecta tanto auto-referencia directa
(`<arbol/>` dentro de `visual arbol`) como indirecta (`a` usa `b`, `b` usa `a`
— el mensaje de error muestra el camino completo, `a -> b -> a`). Reutilizar el
mismo visual varias veces SIN que haya ciclo (ej. `<hoja/>` dos veces dentro de
`rama`) sigue funcionando normal, no se confunde con recursión.

**4. Llamar funciones igual que en JS, normales y de servidor**: confirmado con
código ejecutado de verdad — múltiples parámetros, parámetros por defecto
(`function calcularConDefecto(precio, descuento = 0.1)`), funciones de servidor
llamándose entre sí (`sumar` llamada desde dentro de `postController`), y
funciones normales de cliente (`var doble = (x) => x*2`, incluso con
`function(x) {...}` en vez de arrow) — todo funciona idéntico a JS, sin
sorpresas. No hizo falta ningún arreglo aquí, ya funcionaba bien.

## Motor de análisis JS: Acorn (opcional, con respaldo automático)

`npm install acorn` en la carpeta del proyecto activa un motor de análisis
basado en un parser JS real (`src/js-analyzer.js`), en vez de las
heurísticas de regex que existían hasta ahora. Resuelve de raíz toda la
familia de bugs que fuimos parcheando caso por caso (claves de objeto,
*destructuring*, atajos, *scoping* de funciones anidadas) porque un AST
distingue estas cosas por construcción, no por adivinar con patrones de
texto.

- **Sin `acorn` instalado, o si un fragmento no logra parsear**: cae
  automáticamente al motor de regex de siempre — mismo comportamiento
  que ya tenías, sin sorpresas, sin romper nada.
- **Con `acorn` instalado**: cada expresión/bloque de código se parsea de
  verdad y se recorre el AST con *scoping* real — parámetros de función,
  variables `let`/`const` internas, `catch (e)`, todo se excluye
  correctamente de la sustitución sin necesitar reglas especiales para
  cada caso.

**No pude probar esto contra `acorn` de verdad en este entorno** (sin
acceso a red aquí, no hay forma de instalarlo) — lo escribí razonando con
cuidado sobre la spec de ESTree/Acorn, pero necesita tu confirmación.
Después de `npm install acorn`, compara:

```bash
node -e "console.log(require('./src/js-analyzer').isAvailable())"
# debe decir "true"

node src/cli.js run examples/demo-rutas/src --out /tmp/verificacion
# recompila todo el sitio de ejemplo -- compara contra tu propia copia
# de referencia si quieres estar seguro de que nada cambió de comportamiento
```

Y en particular, vale la pena volver a probar los casos que arreglamos a
mano con regex (`const { contador } = obj`, `{ contador }` como atajo de
construcción) para confirmar que el AST los resuelve igual o mejor.

## Comentarios

```
// Esto es un comentario -- solo de línea completa (no al final de una
// línea con código, para no arriesgarse a comerse un "//" que sea parte
// de una URL u otra cadena dentro de una expresión)
reactive contador = 0
```

Funcionan tanto entre declaraciones de nivel superior como dentro de una
plantilla (`visual`). Se ignoran por completo al parsear, no generan nada
en la salida.

## Cómo funciona el compilador

1. **Parser línea por línea** (`src/parser.js`) — sensible a indentación,
   reconoce `reactive`, `style`, `visual`, `render(...)` y arma un AST.
2. **Mini-parser HTML** (`src/html-parser.js`) — convierte el fragmento de
   plantilla en un árbol de nodos (`element` / `text` / `interpolation`).
3. **Compilador** (`src/compiler.js`) — recorre el AST y genera:
   - `styles.css` a partir de los `style`.
   - `bundle.js`: incluye el runtime reactivo + una función
     `create_NOMBRE(state, effect)` por cada `visual`, que construye el DOM
     con `document.createElement` y registra `effect()` para cada
     interpolación reactiva.
   - `index.html`: esqueleto con `<div id="app">` y el script.
4. **Runtime** (`src/runtime/reactive.js`) — un store basado en `Proxy`:
   al hacer `get` dentro de un `effect`, se suscribe la variable; al hacer
   `set`, se disparan los efectos suscritos. Es un sistema de señales
   minimalista (similar en espíritu a Vue 3 / Solid), sin virtual DOM:
   solo el nodo de texto/atributo afectado se actualiza.

##### `server function` — helper de servidor invisible al cliente

A diferencia de `post function` (única por archivo, expuesta como endpoint
`POST`, con *stub* generado en el cliente), `server function` es un helper
normal: puedes tener **varias por archivo**, y **nunca se expone al
cliente** — ni endpoint HTTP propio, ni stub, ni aparece en
`module.exports` de `server.js`.

```
server var totalConIva = 0

server function calcularIva(precio)
    return precio * 1.21

post function postController(args)
    var conIva = calcularIva(args.precio)
    totalConIva = totalConIva + conIva
    return { conIva: conIva, totalConIva: totalConIva }
```

- Solo es llamable desde **otro código de servidor del mismo archivo** —
  típicamente desde dentro de una `post function`. Como ambas se compilan
  al mismo módulo `server.js`, la llamada es JS normal, sin nada especial:
  funciona por estar en el mismo scope, no hace falta ningún mecanismo de
  importación.
- **Prohibida en cualquier `visual`**, igual que `server var` — el
  compilador la trata exactamente igual a efectos de esa restricción (antes
  de generar nada, si algún visual la referencia, error claro con el
  nombre y el tipo).
- Comprobado con `curl`: llamar directamente a un endpoint con su nombre
  (`POST /calcularIva`) da `404` — no existe ninguna forma de invocarla
  desde fuera del propio `server.js`.
- Comparte el mismo espacio de nombres que `reactive`/`var`/`visual`/
  `server var`/`post function` (nombres únicos en todo el archivo), pero
  al contrario que `post function`, no hay límite de cuántas puede haber.

## ¿WebScript es retrocompatible con JS?

No es un superset de JS — no puedes coger un `.js` y renombrarlo a `.ws`.
Comprobado con código real:

- **Nivel superior del archivo**: solo se reconocen las palabras clave de
  WebScript (`route`, `reactive`, `var`, `style`, `visual`, `server var`,
  `server function`, `post function`, `render`). Una `function foo() {}`
  suelta ahí da `SyntaxError` explícito.
- **Dentro de una expresión** (el valor de un `reactive`/`var`, incluida
  una función-expresión: `var doble = (x) => x * 2`): JS real, sin
  restricciones — y se llama exactamente igual que en JS. Comprobado:
  `{doble(contador)}` en una plantilla y `contador = doble(contador)` en
  un handler funcionan idénticos a JS puro.
- **Dentro de un bloque de código** (`onclick:`, `post function`, `server
  function`): también JS real, admite declarar una `function` ahí dentro,
  bucles, condicionales — es "casi crudo", con sustitución de
  identificadores reactivos y nada más.

Así que la respuesta corta es: **JS real dentro de las rendijas donde se
espera una expresión o un bloque de código, pero no como lenguaje
completo a nivel de archivo.**

### *Destructuring* y atajos de objeto: dos bugs reales que encontré

Al comprobar hasta dónde llega esta compatibilidad con JS "puro" dentro de
un `onclick`, encontré dos casos que generaban JS **inválido**:

**1. Destructuring corto** (`const { contador } = obj`): la sustitución de
nombres convertía esto en `const { state.contador } = obj` —
`SyntaxError` real, confirmado con `node --check`. La causa: mi
heurística de "esto es una clave, no una referencia" solo reconocía el
patrón `clave: valor` (con dos puntos); el *destructuring* corto no lleva
dos puntos, así que se colaba como si fuera una referencia normal a
sustituir. Arreglado detectando el tramo completo `const/let/var { ... }`
como zona excluida — dentro de un patrón de *destructuring*, nada se
toca.

**2. Atajo de objeto al construir uno** (`{ contador }` para crear
`{contador: valorActual}`): mismo síntoma, `{ state.contador }` tampoco es
sintaxis de atajo válida. Aquí la sustitución simple no basta — hay que
**expandir** a la forma explícita. Ahora `{ contador }` se compila a
`{ contador: state.contador }`, preservando el significado exacto en vez
de solo evitar el error.

Ambos verificados con `node --check` sobre el bundle generado (no solo
"compila sin tirar error en WebScript", sino "el JS resultante realmente
parsea"), y contra el resto de ejemplos para confirmar que no rompí nada
existente (en particular, `updateServer({ visitas: contador + 1 })`, que
ya usaba `:` explícito, sigue compilando exactamente igual que antes).

**Límite que queda, documentado a propósito, con el motor de respaldo
(regex, sin Acorn instalado)**: tras un *destructuring* (`const {
contador } = obj`), cualquier referencia **posterior** a `contador` en el
mismo bloque se sigue sustituyendo por `state.contador` — el motor de
regex no sabe que esa línea creó una variable local que hace *shadowing*
del resto del bloque. Encontrado escribiendo la suite de tests
(`tests/compiler.test.js`), que comprueba explícitamente los dos
comportamientos según el motor activo. **Con Acorn instalado, esto se
resuelve correctamente** — el AST sí hace seguimiento de ámbitos real,
`contador` tras el destructuring correctamente se resuelve a la variable
local, no a la reactive. Es la clase de bug que motivó añadir Acorn en
primer lugar.

**Límite que queda, documentado a propósito**: dentro de un patrón de
*destructuring* con valor por defecto (`const { contador = otraReactive }
= obj`), ese valor por defecto NO se sustituye — quedaría sin resolver si
referencia otra `reactive`. Es un caso raro (poco común escribir eso
dentro de un handler), y resolverlo bien necesitaría distinguir "estamos
en la parte de patrón" de "estamos en la parte de valor por defecto"
dentro del mismo `{...}`, que ya empieza a pedir un parser JS real en vez
de una heurística de texto.

## `post function` — endpoint de servidor con lógica real, llamable desde el cliente

Complementa a `updateServer` (que solo hace "actualizar campos a lo bruto"):
`post function` tiene cuerpo con lógica propia, y el compilador genera
automáticamente el *stub* de cliente con el mismo nombre.

```
server var totalPedidos = 0

post function postController(args)
    totalPedidos = totalPedidos + args.cantidad
    return { totalPedidos: totalPedidos, mensaje: "Pedido registrado" }

visual formulario =
<div>
    <p>Total: {total}</p>
</div>
    -> onclick:
        var resultado = await postController({ cantidad: 5 })
        total = resultado.totalPedidos
```

- Solo puede haber **una** `post function` por archivo.
- Su cuerpo corre en Node. Dentro, las `server var` del
  mismo archivo se leen y escriben **directamente, sin prefijo** (a
  diferencia del cliente, que necesita `server.NOMBRE`) — el cuerpo se
  inserta tal cual dentro de una función normal en `server.js`, en el mismo
  scope donde esas variables ya están declaradas.
- **A diferencia de `server var`, su nombre SÍ puede
  usarse dentro de un `visual`** — es justo el punto: el compilador detecta
  la llamada (`postController(...)`) en un handler y genera automáticamente
  un `fetch` equivalente en el cliente, con el mismo nombre. Si nadie la
  llama, no se genera ningún stub de más.
- El servidor responde a `POST` en la **URL de la propia ruta**
  (`POST /formulario`), no en `/formulario.server-data.json` (ese endpoint
  sigue siendo exclusivo de `updateServer`). Si la ruta no tiene ninguna
  `post function`, un `POST` ahí devuelve `405`.
- El valor que devuelve la función (`return {...}`) es la respuesta JSON
  completa — no está limitado a solo actualizar `server var`
  como `updateServer`; puede devolver cualquier cosa calculada.
- Probado de extremo a extremo con `curl`: dos `POST` seguidos acumularon
  correctamente (`5` → `8`), un `GET` normal a la misma URL siguió sirviendo
  el HTML de siempre, y un `POST` a una ruta sin `post function` devolvió
  `405`.

## Leer un `<input>` y mandarlo con un botón separado

Patrón completo cliente → servidor: dos `visual` distintos (uno con el
`<input>`, otro con el `<button>`), unidos por una `reactive` compartida:

```
reactive texto = ""

visual campoTexto =
<input placeholder="Escribe algo">
    -> oninput:
        texto = event.target.value

visual botonEnviar =
<button>
    Enviar
</button>
    -> onclick:
        var r = await postController({ texto: texto })

visual pagina =
<div>
    <campoTexto />
    <botonEnviar />
</div>
```

- El `<input>` actualiza `texto` en cada pulsación (`oninput`), y como
  `texto` es `reactive`, cualquier otro `visual` que la lea (como
  `botonEnviar`, al montar el `onclick`) ve siempre el valor más reciente
  — no hace falta pasar el valor entre visuales manualmente.
- **Bug real que encontré y arreglé al comprobar esto**: los handlers
  (`onclick`, `oninput`, etc.) no recibían el objeto `event` — la función
  generada era `() => {...}`, sin parámetro. `event.target.value` habría
  dependido del `window.event` heredado de navegadores antiguos (poco
  fiable, no funciona en todos los contextos). Ahora es
  `(event) => {...}`, con `event` disponible de verdad en cualquier
  handler.
- Probado de extremo a extremo con un servidor real: simulé escribir en
  el input (`event.target.value`) y hacer click en el botón por separado
  — el servidor acumuló los mensajes correctamente (`total: 1` → `total: 2`
  en envíos sucesivos).

## `updateServer({...})` — mutar servidor desde un handler de cliente (sin `server function`)

En vez de inventar un endpoint por función, se reutiliza el mismo endpoint
de datos de la ruta (`/<baseName>.server-data.json`), extendido para
aceptar `POST`:

```
server var visitas = 42
reactive contadorCliente = server.visitas

visual panel =
<div>
    <p>Visitas: {contadorCliente}</p>
</div>
    -> onclick:
        contadorCliente = await updateServer({ visitas: contadorCliente + 1 }).then(s => s.visitas)
```

- `updateServer({...})` es una función reconocida por el compilador (no
  hay que declararla) — solo aparece si la ruta es dinámica (usa
  `server.X` en algún sitio). Hace `POST` al endpoint de datos de esa
  misma ruta, y el handler que la use se compila automáticamente como
  `async` — puedes escribir `await` tú mismo o dejar que el compilador lo
  añada, detecta si ya está para no duplicarlo.
- El servidor (`serveSite` en `site-builder.js`) solo acepta, del `POST`,
  las claves que **ya existen** como `server var` en ese
  archivo — cualquier clave inventada se ignora en silencio, no se crean
  variables de servidor nuevas desde el cliente. Lo comprobé mandando una
  clave falsa por `POST`: se descartó sin error, sin aparecer en la
  respuesta.
- El nuevo valor **persiste** en el proceso Node — un `GET` posterior
  devuelve el valor actualizado, no el original. Sigue siendo estado
  compartido entre todas las visitas (misma limitación de siempre: no hay
  sesiones).
- `server var` siguen siendo necesarias como concepto
  aparte de esto: representan estado que **persiste entre peticiones y se
  comparte entre visitantes** (como `visitas`) — algo distinto de "calcular
  algo al vuelo con datos que manda el cliente", que es lo que resuelve
  `updateServer`. No se sustituyen entre sí, resuelven necesidades
  distintas.

**Bug real que encontré haciendo esto funcionar**: la detección de "esto
es una `reactive`/`server` referenciada" no distinguía una **clave de
objeto literal** (`{ visitas: x }`) de una referencia real al valor
(`visitas` a secas) — ambas parecían iguales para la regex. Esto rompía
justo `updateServer({ visitas: ... })`. Arreglado con una heurística de
contexto (¿precedido de `{`/`,` y seguido de `:`? → es una clave, no una
referencia) en `compiler.js` y `validate.js`.

## HTML dinámico: leer datos de servidor desde el cliente

Para que una página lea un valor de `server var` sin
romper el aislamiento (nunca se envía el código de servidor al bundle), se
usa `server.NOMBRE` — con punto, nunca a pelo:

```
server var visitas = 42

reactive contadorCliente = server.visitas

visual panel =
<div>
    <p>Visitas iniciales del servidor: {contadorCliente}</p>
</div>
```

- `server.NOMBRE` es el único camino permitido para tocar un valor de
  servidor desde código que compila a cliente — la restricción de
  `validate.js` ya lo distinguía sin cambios: bloquea `contador` a pelo,
  pero `server.contador` (acceso con punto) queda fuera de esa regla porque
  técnicamente es una propiedad de otro objeto, no una referencia directa.
- Solo tiene sentido usarlo para dar el **valor inicial** a una `reactive`/
  `var` de cliente (`reactive contadorCliente = server.visitas`) o para
  mostrar un dato de servidor una sola vez en una plantilla. A partir de
  ahí, `contadorCliente` es 100% reactivo normal — el `+1` del botón nunca
  vuelve a tocar el servidor.
- Si el archivo usa `server.X` en cualquier sitio, el compilador marca esa
  ruta como **dinámica**: el `bundle.js` generado hace
  `await fetch("/<ruta>.server-data.json")` **antes** de crear el store y
  montar nada. Las rutas que NO usan `server.X` no pagan ningún coste
  extra: siguen montándose de forma síncrona, exactamente igual que antes.

### `node src/cli.js serve <src> [--out dist] [--port 3000]`

Nuevo comando: además de compilar el sitio (como `site`), levanta un
servidor Node real (`http` nativo, sin dependencias) que:
- Sirve cada ruta y sus `.html`/`.css`/`.bundle.js`.
- Para las rutas dinámicas, expone `GET /<baseName>.server-data.json`,
  que `require()` el `<baseName>.server.js` generado y devuelve sus
  valores actuales como JSON.

**Sesiones por usuario** (ya implementado, ver más abajo): cada visitante
tiene su propia copia de las `server var` — no se pisan entre sí.

También sigue faltando la otra mitad: **mutar** una `server var`
desde el cliente (algo tipo `server function` que el cliente pueda llamar).
De momento `server.NOMBRE` es solo de **lectura** en la carga inicial.

## Sesiones: estado de servidor por usuario, no compartido

Cada `server var`/`server function`/`post function` ahora vive dentro de
`createSessionState()` en `server.js` — una función **fábrica**, no
variables sueltas a nivel de módulo. El servidor HTTP (`site-builder.js`)
identifica a cada visitante con una cookie (`wsid`, generada la primera vez
que llega si no la tiene) y mantiene una instancia de estado **por sesión**:

```js
// server.js generado
function createSessionState() {
  let totalConIva = 0; // server var -- una copia distinta por sesión
  function postController(args) { ... }
  return { get totalConIva() {...}, set totalConIva(v) {...}, postController };
}
module.exports = { createSessionState };
```

Probado con dos "visitantes" distintos (`curl` con jarras de cookies
separadas): uno acumuló `242` (dos compras de 100), el otro se quedó en
`60.5` (una compra de 50), sin contaminarse en ningún momento — y cada uno
mantuvo su propio valor en peticiones sucesivas. Sin cookies persistentes
(cada petición "un visitante nuevo"), cada `POST` arranca de cero, como
sería de esperar.

**Limitaciones que quedan, a propósito**:
- **No hay expiración de sesiones** ni límite de cuántas se guardan en
  memoria — para un servidor de verdad en producción, esto necesitaría
  expirar sesiones viejas o mover el estado a algo compartido (Redis, base
  de datos) en vez de un `Map` en memoria del proceso Node.
- La cookie es `HttpOnly` pero no `Secure` (no fuerza HTTPS) — pensado para
  desarrollo local, no para desplegar tal cual a producción.

## `run` — comando único: archivo o directorio, con o sin servidor

```
node src/cli.js run RUTA [--out CARPETA_SALIDA] [--serve] [--port NUMERO]
```

> **`<...>`/`[...]` en cualquier documentación (aquí y en cualquier README)
> son notación, no texto a copiar.** `<...>` = obligatorio, `[...]` =
> opcional. En una terminal real, sobre todo en `zsh` (el shell por
> defecto en macOS), escribir corchetes literales como `[--serve]` puede
> hacer que el propio shell lo interprete como un patrón de comodín y
> falle ANTES de llegar a ejecutar node (`no matches found: [--serve]`).
> Copia siempre los ejemplos de abajo, con rutas y flags reales, sin
> corchetes ni signos `<>`.

Ejemplo real y copiable, usando este mismo repositorio como referencia:
```bash
node src/cli.js run examples/contador.ws --out dist
node src/cli.js run examples/demo-rutas/src --out dist --serve --port 3000
```

Detecta solo si `RUTA` es un archivo o un directorio y hace lo que
corresponda, sin que tengas que acordarte de si toca `build`, `site` o
`serve`:

- **Archivo suelto** (`.ws`): se compila como una única ruta en `/` —
  mismo resultado que `build`, pero con la opción extra de `--serve` (algo
  que `build` no tiene). Si el archivo tiene `post function`/`server var`,
  funcionan igual que en un sitio normal (`route(...)` que declare el
  archivo, si tiene alguno, se ignora — siempre se sirve en `/`, para que
  el comportamiento sea consistente y predecible).
- **Directorio**: se comporta como `site` (varias rutas, cada `.ws`
  declara su propio `route(...)` — si el directorio no tiene NINGÚN
  archivo con `route(...)`, no se construye ninguna ruta, solo avisa cuáles
  se omitieron), con la misma opción de `--serve`.
- **`--serve`**: si se pasa, levanta el servidor Node real (`serve`) en
  vez de solo escribir los archivos. Sin `--serve`, solo compila (como
  `site`/`build`).
- **`--port`**: opcional, **por defecto `3000`** — probado explícitamente
  sin pasar la flag, confirma que arranca ahí.

Más ejemplos probados de extremo a extremo:
```bash
# un archivo con post function, servido en / con servidor real
node src/cli.js run pagina.ws --out dist --serve --port 3991

# un directorio con varias rutas, servidor en el puerto por defecto (3000)
node src/cli.js run src/ --out dist --serve

# solo compilar un directorio, sin levantar nada
node src/cli.js run src/ --out dist
```

Por debajo reutiliza exactamente la misma maquinaria que `build`/`site`/
`serve` (que se mantienen disponibles tal cual, sin cambios, para cuando
quieras ser explícito sobre cuál usar) — `site-builder.js` se separó en
piezas reutilizables (`discoverRoutes`, `compileRoutes`, `startServer`)
para que un archivo suelto pudiera tratarse como "un sitio de una sola
ruta" sin duplicar lógica.

## Por qué una `post function` no puede redefinir un `visual`

Pregunta concreta que surgió: ¿se puede hacer que una `post function`
"sobrescriba" un `visual` ya declarado y lo re-renderice con otra
estructura?

```
visual app =
<div>hola</div>

post function llamada(args)
    app = <div>adios</div>
```

**No, y no por una limitación arbitraria — por tres razones estructurales,
confirmadas ejecutando el código real:**

1. `<div>adios</div>` no es sintaxis JS. Dentro de una `post function` el
   cuerpo se trata como JS "casi crudo" sin validar — el `server.js`
   resultante tiene un `SyntaxError: Unexpected token '<'` de verdad,
   confirmado con `node --check`.
2. `app` (el `visual`, compilado a `bundle.js`) y `app` (un identificador
   suelto dentro de la `post function`, compilada a `server.js`) no tienen
   ninguna relación — son archivos y tiempos de ejecución distintos.
   Asignar algo a ese nombre en el servidor no toca el visual aunque
   compilara.
3. Aunque el servidor SÍ mande una cadena de HTML como dato (`return {
   html: "<div>...</div>" }`), el cliente nunca la interpreta como
   estructura — las interpolaciones usan `textContent`, así que aparece
   como texto literal (`"<div>...</div>"` visible tal cual), nunca como
   elementos reales. Esto es a propósito, es la misma protección que evita
   XSS en el resto del lenguaje.

**El patrón correcto para lo que probablemente se busca**: el servidor
decide **qué rama** de una estructura ya compilada se muestra, vía
`if`/`else if`/`else` combinado con el resultado de una `post function` —
eso sí crea elementos DOM reales, verificado con
`tags reales creados: ["div"]` en vez de un nodo de texto suelto.

### Bug real encontrado de paso: un `server.js` roto tumbaba el proceso entero

Probando esto descubrí que `getSessionState(...)` (que internamente hace
`require()` sobre el `server.js` compilado) se llamaba en dos sitios
**fuera** de cualquier `try/catch` — así que un archivo con JS inválido no
solo hacía fallar esa petición, **tumbaba el proceso Node entero**,
dejando de responder a todas las rutas, no solo a la rota. Arreglado
envolviendo ambos puntos de entrada; verificado que ahora una petición
rota devuelve `500` con el mensaje de error, y el servidor **sigue
respondiendo** normalmente a la siguiente petición.

### Bug real encontrado de paso (otro más): asignar a un nombre no
declarado filtraba una variable global entre sesiones

Siguiente pregunta natural: ¿y si en vez de sintaxis HTML se asigna un
valor JS normal a un nombre que coincide con un `visual`
(`app = "nuevo valor"` dentro de una `post function`)? Eso **sí** es JS
válido — compila y ejecuta sin error. Pero como `app` nunca se declaró
con `let`/`const`/`var` en ese ámbito, y `server.js` corría **sin** modo
estricto, JS creaba una **variable global implícita** en el proceso Node
(`global.app`) — filtrada fuera de cualquier sesión, contaminando el
proceso entero, justo el tipo de fuga que las sesiones por cookie estaban
pensadas para evitar.

Arreglado añadiendo `'use strict';` al principio de todo `server.js`
generado. Con eso, la misma asignación pasa de "fuga silenciosa" a
`ReferenceError: app is not defined` inmediato y claro — capturado por el
mismo `try/catch` de antes, así que sigue sin tumbar el servidor, solo
falla esa petición con un mensaje explícito. Verificado explícitamente que
`global.app` ya no existe después del intento.

**Nota**: en ninguno de los dos casos (sintaxis HTML inválida, o
asignación JS válida a un nombre no declarado) el `visual` del cliente se
vio afectado en absoluto — la respuesta a la pregunta original
("¿se pueden sobrescribir visuales?") sigue siendo, con toda firmeza, que
no.

## SSG / SSR: HTML real en vez de una concha vacía

Hasta ahora, toda ruta mandaba `<div id="app"></div>` vacío — el
contenido real solo aparecía cuando el JS del navegador se ejecutaba. Eso
es malo para SEO, primera pintura, y cualquiera sin JS. Implementado en
dos niveles según el tipo de ruta, sin tocar el bundle de cliente en
ningún caso (sigue reconstruyendo todo desde cero al cargar — sin
hidratación, opción "B" de las que planteamos):

**SSG (rutas estáticas, sin `server.X`)** — se renderiza **una sola vez,
en tiempo de compilación** (`build`/`site`/`run`), con los valores
literales iniciales. Cero servidor en tiempo de ejecución — el `.html`
resultante ya trae el contenido real, servible desde cualquier hosting
estático o abrible directamente, exactamente como antes.

**SSR real (rutas dinámicas, con `server var`)** — se renderiza **en cada
petición**, con los valores actuales de la sesión de quien la pide.
Probado de extremo a extremo: `GET` inicial trae `Visitas: 100` ya
renderizado (no una concha vacía esperando un `fetch`); tras subirlo a
`250` por `POST`, el **siguiente** `GET` de la misma sesión ya trae `250`
— no cacheado, fresco cada vez.

### Cómo funciona por debajo (`src/ssr-renderer.js`)

Recorre el mismo árbol de plantilla que usa el compilador de cliente, pero
en vez de generar `document.createElement(...)`, evalúa cada expresión
de verdad (`new Function(...nombres, "return (" + expr + ")")`) contra un
"scope" con los valores ya conocidos, y construye un string de HTML
directamente.

- **XSS**: como aquí se construye HTML a mano (a diferencia del cliente,
  que usa `textContent` y el navegador escapa solo), cualquier valor
  interpolado se escapa explícitamente. Probado con
  `reactive nombre = '<script>alert(1)</script>'` — el resultado contiene
  `&lt;script&gt;`, nunca una etiqueta ejecutable real.
- **Fallback seguro, siempre**: si cualquier expresión falla al evaluarse
  en Node (el caso típico: usa `document`/`window`, que no existen fuera
  del navegador), se aborta el intento entero y se sirve la concha vacía
  de siempre — la página **nunca queda peor** que antes de tener SSR/SSG,
  el cliente la rellena vía JS como ya hacía. Probado explícitamente con
  `reactive x = document.title` y con `reactive ancho = window.innerWidth`
  — ninguno de los dos rompe el build, ambos caen limpio.
- **`<slot />` y composición con children SÍ están soportados** — el
  contenido pasado entre `<componente>...</componente>` se renderiza en
  el scope del **padre** (no del hijo que lo recibe, igual que en cliente)
  y se pasa como HTML ya resuelto; `<slot/>` del hijo lo inserta tal cual.
  Probado: un `<panel titulo="{titulo}"><boton/><p>extra</p></panel>`
  compone correctamente, y una `reactive` del padre referenciada dentro
  del contenido pasado (`<tarjeta><p>{contador}</p></tarjeta>`) se
  resuelve con el valor del padre, no del hijo.
- Los `-> onclick:`/handlers no se incluyen en el HTML servido (no hay
  forma de que un atributo HTML lleve JS de WebScript tal cual) — la
  interactividad sigue llegando enteramente del `bundle.js`, como siempre.

## Seguridad: path traversal encontrado y arreglado (serio, no cosmético)

Al revisar qué más hacía falta, se me ocurrió comprobar algo que nunca
habíamos probado en toda la conversación: si el servidor HTTP (`serve`/
`run --serve`) protegía correctamente los límites de la carpeta que sirve.
**No lo hacía.**

```bash
curl "http://localhost:3000/..%2f..%2f..%2f..%2fetc%2fpasswd"
# devolvía el contenido real de /etc/passwd
```

Dos puntos vulnerables, los dos en `site-builder.js`:

1. **Servido de estáticos**: `path.join(outDir, urlPath)` no comprueba que
   el resultado siga dentro de `outDir` — con suficientes `../` (o su
   versión codificada `%2f`, que además esquiva la normalización que hace
   `curl` por su cuenta) se puede leer cualquier archivo del sistema que el
   proceso Node tenga permiso de leer.
2. **Más grave todavía**: el endpoint `/<ruta>.server-data.json` extraía el
   `baseName` directamente de la URL y lo pasaba a `require()` sin validar
   nada. Esto no es solo lectura de archivos — si un `.server.js` (o
   cualquier `.js`) existiera en la ruta resultante del *traversal*,
   `require()` lo **ejecutaría como código** dentro del proceso del
   servidor. Path traversal con potencial de ejecución de código, no solo
   fuga de información.

**Arreglado con el mismo principio en los dos sitios**: validar contra una
lista blanca conocida ANTES de tocar el sistema de archivos, nunca confiar
en normalizar la ruta después.
- Estáticos: se comprueba que la ruta resuelta (`path.resolve`) siga
  empezando por `outDir` antes de servir nada.
- Endpoint de datos: el `baseName` extraído de la URL se valida contra la
  tabla de rutas ya compiladas (`table`) — si no corresponde a ninguna
  ruta real conocida, `404` inmediato, sin construir ninguna ruta de
  archivo ni acercarse a `require()`.

Verificado con el mismo ataque que lo encontró (ya no funciona, `404` en
vez de filtrar datos) y con tests permanentes
(`tests/security.test.js`) que reproducen ambos vectores para que no
puedan volver a colarse sin que la suite lo note.

**Lo que esto NO cubre** (para ser honesto sobre el alcance): no hay
protección CSRF en los endpoints `POST` (`post function`/`updateServer`)
— un sitio malicioso podría, en teoría, disparar esas peticiones
aprovechando la cookie de sesión del navegador de la víctima. Tampoco hay
límite de tasa (*rate limiting*) contra abuso/DoS. Ninguno de los dos
estaba en el alcance de esta revisión puntual — quedan como pendientes
conocidos si el servidor de desarrollo llegara a usarse en un contexto más
expuesto que "en tu máquina, para probar".

## Servir páginas dinámicas: nunca abrir el `.html` directamente

Si una página usa `server.NOMBRE` o llama a una `post function`, el
navegador necesita hablar por HTTP con un servidor real — `fetch()` no
funciona sobre `file://` (abrir el `.html` con doble-click), es una
restricción de seguridad del propio navegador, no algo que WebScript pueda
evitar. El error que da el navegador en ese caso es bastante críptico
(`Cross origin requests are only supported for HTTP...`), así que ahora
WebScript da un aviso propio y más claro:

- Si la página necesita el `fetch` inicial (usa `server.X` para el valor
  de arranque de una `reactive`), y se abre con `file://`, en vez de
  reventar en silencio muestra un mensaje visible en la propia página
  explicando qué pasa y qué comando usar.
- Si solo se llama a una `post function` desde un handler (sin usar
  `server.X` al montar), el error aparece al hacer click, con el mismo
  mensaje explicando el problema.

**Bug real que encontré arreglando esto**: el comando `build` de un solo
archivo (`node src/cli.js build archivo.ws`) nunca activaba el modo
"dinámico" aunque el archivo usara `server.X` — el bundle generado
resultaba en `ReferenceError: server is not defined` al cargar, siempre,
incluso sirviéndolo por HTTP correctamente. La causa: solo `site`/`run`
calculaban si una página necesitaba el `fetch` inicial; `build` nunca lo
comprobaba. Arreglado — `build` ahora también lo detecta, y si el archivo
lo necesita, avisa en la consola qué comando usar para servirlo
correctamente. De paso, el `server.js` que genera `build` pasó a llamarse
`index.server.js`, para ser consistente con el nombre que ya usaba `run`
en modo de un solo archivo.

Correcto:
```bash
node src/cli.js run archivo.ws --serve --port 3000
# abrir http://localhost:3000/  (no doble-click al .html)
```

## Rutas y sitios multi-página

Para construir un sitio con varias páginas en vez de un único archivo,
cada `.ws` que sea una página declara su ruta con `route(...)` **como
primera línea del archivo**:

```
route("/")
```
```
route("/ejemplo")
```

```bash
node src/cli.js site examples/site/src --out dist
```

- Escanea recursivamente el directorio dado, parsea cada `.ws`, y junta
  los que tienen `route(...)`. Los que no lo tienen se omiten (con aviso)
  en vez de romper el build — útil más adelante para piezas compartidas
  sin página propia.
- El nombre del HTML de salida se deriva de la ruta, no del nombre del
  archivo: `route("/")` → `index.html`, `route("/ejemplo")` →
  `ejemplo.html`, `route("/blog/post")` → `blog/post.html` (con
  subcarpetas). Cada ruta también genera su propio CSS y JS con el mismo
  nombre base (`ejemplo.css`, `ejemplo.bundle.js`), y su `server.js` si
  declara variables de servidor -- así no colisionan entre páginas.
- **Rutas duplicadas entre archivos distintos** son un error de
  compilación (`SyntaxError`, con ambos archivos implicados), no un aviso.
- **`route(...)` debe ser la primera declaración del archivo** — si va
  después de cualquier otra cosa (`reactive`, `style`, etc.), también es
  error de compilación.
- El modo de un solo archivo (`node src/cli.js build archivo.ws --out dist`,
  el que ya existía) no cambia: sigue generando siempre `index.html` /
  `styles.css` / `bundle.js`, sin necesidad de `route(...)`.
- **Todavía es solo para HTML estático** — cada página es independiente,
  sin layout compartido entre rutas, sin navegación entre ellas más allá de
  los `<a>` que escribas tú mismo, y sin ningún tipo de enrutamiento del
  lado del servidor (nginx/Node) todavía — eso serviría los `.html`
  generados como archivos estáticos normales.

Implementado en `src/site-builder.js` (escaneo + tabla de rutas) y el
comando `site` de `src/cli.js`.

## Validación de nombres duplicados

El compilador rechaza (con `SyntaxError` y número de línea) los nombres
repetidos que de verdad causan bugs en tiempo de ejecución:

- **`reactive` + `var` + `visual` comparten un mismo espacio de nombres** y
  deben ser únicos entre sí en todo el archivo. Repetir un nombre aquí
  causaba (antes de esta validación): claves de objeto duplicadas
  (`{contador: 0, contador: 5}` → JS se queda con la última en silencio),
  `var` que queda como código muerto si coincide con una `reactive`, o un
  `visual` completo pisado sin aviso por otro con el mismo nombre.
- Lo mismo aplica **dentro de cada `visual`**: sus `reactive`/`var` locales
  deben ser únicas entre sí.
- **`style` tiene su propio espacio, separado**: dos `style` con el mismo
  nombre siguen bloqueados (sería CSS duplicado, casi seguro un error), pero
  un `style` SÍ puede compartir nombre con un `visual`/`reactive`/`var` sin
  problema — nunca colisionan de verdad (una clase CSS y un identificador
  JS no se confunden). Por ejemplo, `style boton` + `visual boton` que use
  `-> style: boton` es un patrón normal y sigue funcionando.
- **El *shadowing* de una `reactive` local sobre una global con el mismo
  nombre SÍ está permitido** — son ámbitos distintos y es un patrón legítimo
  en cualquier lenguaje (la local gana dentro de su `visual`). Nota menor:
  esto genera un `effect()` global redundante además del `localEffect()`
  correcto, por una imprecisión en la detección de dependencias que no
  tiene en cuenta el *shadowing* — no afecta al resultado (el valor mostrado
  y su reactividad son correctos), solo genera algo de código de más.

Implementado en `src/validate.js`, llamado al final de `parseProgram`.

## Limitaciones actuales (verificadas contra el código, no de memoria)

**Plantillas / HTML**
- Un `visual` compila a un único elemento raíz. Si el resultado no es
  exactamente un elemento (varios nodos hermanos, o un `if`/`for` suelto en
  la raíz), se envuelve automáticamente en un `<div>` — no se puede evitar.
- **No puedes mezclar texto literal con `{expr}` dentro de un mismo
  atributo.** `class="btn-{tipo}"` NO interpola — se queda literalmente como
  el string `"btn-{tipo}"`, llaves incluidas. Solo funciona si el atributo
  es *enteramente* la expresión: `value={contador}` o `value="{contador}"`
  (con o sin comillas, da igual, pero sin texto alrededor).
- Solo hay un `<slot />` "por defecto" — no hay slots nombrados
  (`<slot name="header"/>`) para pasar varios huecos distintos a un mismo
  visual hijo.

**`if` / `for`**
- `else`/`else if` deben estar exactamente a la **misma indentación** que
  su `if`. **Ya no falla en silencio**: si queda más o menos indentado, el
  compilador lanza un `SyntaxError` con la línea, la columna real y la
  columna esperada, en vez de tragárselo como texto HTML dentro de la rama
  anterior.
- El nombre de la variable de un `for (item in lista)` **sí tiene scoping
  real** ahora: si coincide con una `reactive`/local existente, la del
  `for` gana dentro del bucle (no colisiona). Comprobado con
  `for (contador in lista)` cuando ya existe `reactive contador`.
- `for` **sí hace diffing por clave** (`for (item in lista by item.id)`) —
  reutiliza nodos DOM existentes en vez de reconstruir toda la lista.
  Sin `by`, usa el índice como clave (correcto, pero menos eficiente al
  reordenar/insertar en medio).
- Para mutar una `reactive` que es un array, hay que reasignar el array
  completo (`lista = [...lista, nuevo]`); `.push()` no dispara reactividad
  porque el Proxy solo detecta el `set` de la propiedad completa.

**Composición de `visual`**
- Un `visual` **no puede referenciarse a sí mismo**, ni directa
  (`<arbol/>` dentro de `visual arbol`) ni indirectamente (A usa B, B usa
  A) — el compilador detecta el ciclo con DFS sobre el grafo de
  composición y lo rechaza con un error que muestra el camino completo.

**General**
- Las expresiones dentro de `{}` y de los bloques de código son JS "tal
  cual" con sustitución de identificadores por regex — no hay un parser de
  JS real, así que expresiones muy complejas (destructuring, funciones
  flecha inline, etc.) podrían no sustituirse bien o colisionar con nombres
  de variables reactivas usados como propiedades de otro objeto.
- No existe aún un modo `dev` con recarga en caliente (solo `build`
  estático).

Estas son las siguientes piezas naturales a construir o arreglar cuando
quieras seguir ampliando el lenguaje — por orden de "sorpresa silenciosa"
antes que por dificultad: el `else` mal indentado y el scoping de `for` son
los dos que más te van a morder sin avisar.
