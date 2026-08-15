# WebScript

Lenguaje que unifica HTML, CSS y JS en un único archivo `.ws`, con reactividad
de primera clase. Compilador escrito en Node.js.

## Filosofía de diseño: control en dos capas, no solo una

Si hay que resumir qué distingue a WebScript de "otro lenguaje que compila
a JS", es esto: **controla cada acción posible, pero en dos capas
distintas, no confundibles entre sí.**

### Capa 1 — En compilación: si no puede funcionar, no compila

No es un sistema de tipos. Es una negativa sistemática a producir un
archivo que **ya se sabe** que va a fallar en cuanto alguien lo use — en
vez de dejarte compilar "bien" y descubrirlo en el navegador o en el
servidor de producción, con un `ReferenceError` críptico. Este patrón no
fue un plan inicial: **emergió** de encontrar, una y otra vez a lo largo
de esta conversación, código que compilaba sin avisos y explotaba en
tiempo de ejecución — y decidir, cada vez, que el compilador tenía que
haberlo visto venir. Ejemplos reales, todos verificados:

- Una `server var`/`server reactive`/`server function` referenciada
  dentro de un `visual` — rechazado, incluso si llega por `import`.
- Una `server var` leída a secas desde una `reactive` de cliente
  (`reactive x = contador` en vez de `server.contador`) — rechazado con
  la forma correcta sugerida, no un `ReferenceError` en el navegador de
  quien use la página.
- `get function` coexistiendo con `render()` en el mismo archivo — dos
  significados de `GET` a la vez, rechazado antes de que sea ambiguo.
- `server function`/`var`/`reactive`/`function` sin ninguna vía real de
  ejecución en una ruta "solo backend" — rechazadas como código muerto de
  raíz, no silenciosamente ignoradas.
- `watch(NOMBRE)` apuntando a algo que no es una `server reactive`
  declarada — rechazado, no un observador que nunca se dispara.
- Un `visual` que se referencia a sí mismo, directa o indirectamente —
  detectado con DFS sobre el grafo de composición, rechazado con el
  camino completo del ciclo.

### Capa 2 — En ejecución: supervisión y orquestación activas, no solo reacción pasiva

Esta es la parte que se queda corta si solo se habla de "rechazar en
compilación" — WebScript también controla activamente **mientras el
proceso está vivo**, no solo antes de arrancar:

- **Reactividad profunda con rastreo por ruta**: mutar `datos.edad = 99`
  o `lista.push(x)` dispara actualizaciones exactas — solo lo que
  realmente depende de ese campo se re-ejecuta, verificado explícitamente
  que un campo hermano nunca leído no dispara nada de más.
- **`watch()`**: supervisión real de un valor de servidor mientras
  cambia — se dispara sin importar cuál de las funciones HTTP fue la que
  lo modificó, nunca con el valor inicial, siempre en cambios
  posteriores.
- **Las cuatro funciones HTTP y `http.*`**: no son solo azúcar sintáctico
  sobre `fetch` — deciden qué verbo dispara qué lógica en el momento real
  de cada petición, con sesiones aisladas por cookie, verificadas con
  servidores reales, no simulados.
- **Diffing por clave en `for`**: no es "volver a pintar todo" en cada
  cambio — decide, nodo por nodo, cuál reutilizar y cuál reconstruir,
  verificado contando cuántos nodos DOM se crean de más (cero, cuando no
  hacen falta).

### El resumen honesto, sin vender de más

Ninguna de las dos capas es una garantía formal como un sistema de tipos
— es disciplina de diseño verificada por dos personas en una sola
conversación muy larga, no por años de producción con miles de usuarios
encontrando los huecos que a nosotros se nos escaparon. Y tiene un coste
real: la superficie de validación no para de crecer (cada función nueva
trajo su propia comprobación de "¿y si esto es inalcanzable?"), y es
deliberadamente lo opuesto al espíritu permisivo de JS. Si tuviera que
venderse en una frase: **WebScript prefiere fallar en compilación antes
que fallar en producción, y cuando algo sí llega a ejecutarse, prefiere
supervisarlo activamente antes que confiar en que el desarrollador lo
haga bien a mano.**

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
sin dependencias que instalar) — **141 tests, 40 suites** a estas alturas
(el número ha ido creciendo turno a turno; ver `tests/` para el desglose
completo, cada archivo nuevo se documenta en su sección correspondiente
más abajo), cubriendo:

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
- **Reactividad profunda** (ver sección dedicada más abajo): mutar
  `lista.push(nuevo)` o `datos.campo = x` sí dispara actualizaciones —
  no hace falta reasignar el array/objeto completo, aunque seguir
  reasignando (`lista = [...lista, nuevo]`) también sigue funcionando
  exactamente igual.

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

**¿Se puede guardar cualquier tipo?** Sí, sin restricción — `reactive`/
`var`/`server var` son JS dinámico por debajo: números, texto, booleanos,
`null`, arrays, objetos anidados con arrays dentro, cualquier combinación.
Verificado con los siete tipos a la vez en una sola página, incluyendo
acceso anidado real (`anidado.usuarios[0].nombre`). El tipado opcional de
abajo no restringe qué tipos existen — solo valida coherencia si decides
anotar uno explícitamente.

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
> que algún día significara algo distinto. Se quitó porque, sin esa pieza
> construida, se comportaba **exactamente igual** que `server var` — dos
> nombres para lo mismo, y el compilador rechazaba `server reactive` con
> un mensaje sugiriendo `server var`. **Ha vuelto** — ver la sección
> dedicada a `watch()` más abajo — porque ahora sí tiene un propósito
> real y distinto: solo las `server reactive` se pueden observar con
> `watch(NOMBRE)`.

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
  `path.resolve` normal de Node — **siempre con `./` o `../` delante**
  (`"./compartido.ws"`, nunca `"compartido.ws"` a secas ni
  `"/compartido.ws"` con barra inicial). Una ruta que empieza por `/` se
  resuelve como ruta **absoluta del sistema de archivos** (busca ese
  archivo desde la raíz del disco, no relativo a tu proyecto) — es el
  comportamiento normal de `path.resolve` de Node, no algo especial de
  WebScript, pero es fácil escribirlo por error esperando que sea
  relativo. Confirmado: `import { x } from "/otro.ws"` falla con "no se
  encuentra el archivo importado" salvo que ese archivo exista
  literalmente en la raíz del sistema.
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
existente (en particular, expresiones como `{ visitas: contador + 1 }`
pasadas a una `post function`, que ya usaban `:` explícito, siguen
compilando exactamente igual que antes).

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

Tiene cuerpo con lógica propia, y el compilador genera automáticamente
el *stub* de cliente con el mismo nombre.

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
  es solo de lectura, `GET`). Si la ruta no tiene ninguna
  `post function`, un `POST` ahí devuelve `405`.
- El valor que devuelve la función (`return {...}`) es la respuesta JSON
  completa — puede devolver cualquier cosa calculada, no solo el estado
  actualizado de una `server var`.
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

## `updateServer` — eliminado, unificado con `post function`

Existió como atajo para "actualizar campos de `server var` sin escribir
ningún código de servidor" (reutilizaba el endpoint de datos de la ruta,
extendido para aceptar `POST`). Se quitó tras comparar directamente el
coste: `post function` puede replicar exactamente el mismo comportamiento
con 3-4 líneas más de servidor, y mantener los dos aumentaba el número de
"sabores" de variable/función de servidor sin una diferencia funcional
grande — la misma clase de simplificación que ya se hizo antes con
`server reactive`/`server var`, aunque aquí la distinción no era
completamente falsa, solo estrecha.

```
server var visitas = 42

post function incrementar(args)
    visitas = visitas + args.cantidad
    return { visitas: visitas }

reactive contadorCliente = server.visitas

visual panel =
<div>
    <p>Visitas: {contadorCliente}</p>
</div>
    -> onclick:
        var r = await incrementar({ cantidad: 1 })
        contadorCliente = r.visitas
```

- Si escribes `updateServer(...)` en un handler (por costumbre, o copiando
  código de antes de este cambio), el compilador lo detecta y da un error
  explícito señalando que se unificó con `post function` — no un
  `ReferenceError` críptico en el navegador.
- El endpoint `/<ruta>.server-data.json` pasó a ser **solo de lectura**
  (`GET`) — un `POST` ahí ahora da `405`. Escribir se hace siempre vía
  `POST` a la URL de la propia ruta, despachado a la `post function`.
- Verificado de extremo a extremo con el mismo patrón de antes (`GET`
  inicial → `POST` a la `post function` → `GET` posterior confirma que
  persiste), y con el endpoint viejo devolviendo `405` como se espera.

**Bug real que encontré cuando SÍ existía `updateServer`** (documentado
aquí porque la lección sigue siendo válida para cualquier caso similar
con `post function`): la detección de "esto es una `reactive`/`server`
referenciada" no distinguía una **clave de objeto literal**
(`{ visitas: x }`) de una referencia real al valor (`visitas` a secas) —
ambas parecían iguales para la regex. Arreglado con una heurística de
contexto (¿precedido de `{`/`,` y seguido de `:`? → es una clave, no una
referencia) en `compiler.js` y `validate.js` — este arreglo se queda,
sigue siendo necesario para cualquier objeto literal que pases a una
`post function`.

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

## WebScript como backend puro: `route()` sin `render()`

Un archivo con `route(...)` pero **sin `render(...)`** se trata como una
ruta "solo backend" — ni HTML, ni CSS, ni `bundle.js`. La propia URL de la
ruta pasa a comportarse como un endpoint JSON:

```
route("/api/contador")

server var total = 0

post function incrementar(args)
    total = total + args.cantidad
    return { total: total }
```

- **`GET /api/contador`** — devuelve el estado actual de sus `server var`
  como JSON (`{"total": 0}`). Si no tiene ninguna `server var`, devuelve
  `{}` sin fallar.
- **`POST /api/contador`** — dispara la `post function`, exactamente igual
  que en una ruta con página (misma sesión por cookie, mismo aislamiento,
  mismos errores contenidos si algo revienta).
- **No se genera ningún `.html`/`.css`/`.bundle.js`** — ni siquiera la
  concha vacía de siempre. Solo `server.js`, si hay algo de servidor que
  compilar.
- Funciona igual en `build` (un solo archivo), `site` y `run` — los tres
  comandos detectan la ausencia de `render()` y aplican el mismo criterio.

Probado de extremo a extremo: `GET` inicial → `{total: 0}`, `POST
{cantidad: 5}` → `{total: 5}`, y un `GET` posterior de la misma sesión
confirma que persiste (`{total: 5}`, no vuelve a `0`).

**Bug real que encontré haciendo esto**: rutas con subcarpetas
(`route("/api/contador")` → `api/contador.server.js`) fallaban con
`ENOENT` al escribir el archivo — el `mkdirSync` de la subcarpeta antes
solo se hacía junto con el `.html`, que en este camino nuevo no existe.
Arreglado creando el directorio explícitamente antes de escribir
`server.js` también en el caso "solo backend".

### `put function` / `delete function` — un verbo HTTP por función

Complementan a `post function`: puede haber **una de cada verbo** por
archivo (post + put + delete a la vez si hace falta), cada una disparada
por su propio verbo HTTP en la **misma URL** de la ruta:

```
route("/api/tareas")

server var tareas = []

post function crear(args)
    tareas = [...tareas, { id: tareas.length, texto: args.texto }]
    return { tareas: tareas }

put function actualizar(args)
    tareas = tareas.map(t => t.id == args.id ? { id: t.id, texto: args.texto } : t)
    return { tareas: tareas }

delete function borrar(args)
    tareas = tareas.filter(t => t.id != args.id)
    return { tareas: tareas }
```

- Antes de esto, solo podía haber **una** `post function` por archivo —
  no había forma de separar "crear" de "borrar" con lógica propia para
  cada una en la misma URL. Ahora sí.
- Mismas reglas que `post function` en todo lo demás: comparten el mismo
  espacio de nombres (colisión real si repites nombre), su nombre SÍ puede
  llamarse desde un `visual` (a diferencia de `server var`/`server
  function`), el compilador genera el *stub* de cliente automáticamente
  (con el verbo HTTP correcto: `PUT`/`DELETE`) solo si de verdad se llama
  desde algún handler, y `PUT`/`DELETE` a una ruta que no tiene esa
  función da `405`.
- Funciona igual en rutas con página y en rutas "solo backend" (sin
  `render()`).
- Probado de extremo a extremo con los tres verbos encadenados sobre la
  misma sesión: `POST` (crear dos tareas) → `PUT` (editar una) → `DELETE`
  (borrar otra) → `GET` final refleja exactamente el resultado esperado
  de las tres operaciones. También probado que el *stub* de cliente
  **solo** se genera para la función que realmente se llama desde un
  handler, igual que ya pasaba con `post function`.

### `get function` — solo en rutas "solo backend" (sin `render()`)

Sustituye el volcado por defecto de las `server var` (que ya hacía `GET`
en una ruta "solo backend") cuando hace falta **calcular** algo en vez de
solo exponer el estado tal cual:

```
route("/api/usuario")

server var nombre = "Jorge"
server var visitas = 100

get function estado(args)
    return { saludo: "Hola, " + (args.nombre || nombre), visitasTotales: visitas * 2 }

post function incrementar(args)
    visitas = visitas + 1
    return { visitas: visitas }
```

**Decisión de diseño importante, que surgió al discutirlo**: `get
function` **no puede coexistir con `render()`** en el mismo archivo — se
rechaza con un `SyntaxError` explícito en tiempo de compilación. La razón:
en un archivo con página, `GET` ya tiene un significado fijo ("servir el
HTML"), y no hay forma sin ambigüedad de decidir si una petición `GET`
debe servir la página o llamar a la función. En vez de que uno gane en
silencio (comportamiento sorprendente y difícil de depurar), se rechaza
de raíz.

- **Los argumentos vienen de la *query string*** (`?nombre=Ana`), no de un
  *body* — un `GET` no lleva cuerpo por convención, y `fetch()` con `GET`
  tampoco permite mandarlo (a diferencia de `post`/`put`/`delete
  function`, que sí reciben `args` del *body* JSON). Los valores llegan
  siempre como **strings** (la *query string* no tiene tipos), a
  diferencia del *body* JSON que sí preserva números/booleanos/objetos.
- **Sin *stub* de cliente**: a diferencia de `post`/`put`/`delete
  function`, no se genera ningún *stub* llamable desde un `visual` —
  no tendría sentido, ya que `get function` solo existe en archivos sin
  `render()`, que nunca generan `bundle.js` (no hay ningún cliente que
  pudiera llamarla).
- Solo puede haber **una** `get function` por archivo, igual que las
  otras tres.
- Probado de extremo a extremo: sin *query string* usa las `server var`
  directamente; con `?nombre=Ana` usa el argumento; y coexistiendo con
  `post function incrementar` en el mismo archivo, ambas funcionan de
  forma independiente sobre la misma sesión.

## Objeto `http`: llamar a OTROS sistemas desde el servidor

Distinto de `post`/`put`/`delete function` (que sirven peticiones que
**llegan** a esta ruta): `http` es para las que **esta ruta hace hacia
fuera**, a APIs externas.

```
http.get(url, headers)
http.post(url, body, headers)
http.put(url, body, headers)
http.delete(url, body, headers)
```

```
get function consultar(query)
    var datos = await http.get("https://api.ejemplo.com/clima?ciudad=" + query.ciudad, {})
    return { temperatura: datos.temp }

post function notificar(args)
    var resultado = await http.post("https://api.ejemplo.com/webhook", { mensaje: args.texto }, { "Authorization": "Bearer TOKEN" })
    return { enviado: true, respuesta: resultado }
```

- Devuelve el cuerpo de la respuesta **ya parseado** — JSON si es JSON
  válido, o el texto crudo si no lo es (sin lanzar error, verificado
  explícitamente con una respuesta `text/plain` real).
- `body`/`headers` son opcionales; si no hay `Content-Type` en las
  cabeceras, se pone `application/json` automáticamente cuando hay `body`.
- Solo se genera en el `server.js` si de verdad se usa (`http.` en algún
  cuerpo) — mismo criterio que los *stubs* de cliente.

### Bug real encontrado montando esto: `await` no funcionaba en ninguna función de servidor

Antes de construir `http`, comprobé si `fetch()` a secas ya funcionaba
dentro de una `post function` (dado que el cuerpo es JS "casi crudo" y
Node ya trae `fetch` global desde la v18) — y encontré que **no**, con un
error real: `"await is only valid in async functions"`. Las cuatro
funciones HTTP (`get`/`post`/`put`/`delete function`) se generaban como
funciones normales, no `async`, así que `await` dentro de ellas ni
siquiera era sintaxis válida. Arreglado haciendo `async` las cuatro, y
actualizando el despachador en `site-builder.js` para `await` su
resultado (necesario porque ahora siempre devuelven una promesa).

**Segundo bug, encontrado al intentar generalizar el arreglo a `server
function` también**: hacerla `async` rompía un patrón que ya
funcionaba y estaba probado — llamarla **sin** `await`, esperando su
valor de vuelta directamente (`doble: duplicar(contador)`). Con
`server function` async, esa llamada pasa a devolver una promesa, no el
número — `duplicar(contador)` sale como `{}` en el JSON en vez de `2`.
Revertido: `server function` se queda **síncrona** a propósito (no puede
usar `await` dentro; si necesitas llamar a otro sistema, hazlo
directamente en una `get`/`post`/`put`/`delete function`, que sí es
`async`). Verificado con un test explícito que confirma que el patrón
`doble: duplicar(contador)` sin `await` sigue devolviendo `2`, no una
promesa.

### Sobrecargas por número de parámetros: *query string* y *headers* en las cuatro

Todas (`get`/`post`/`put`/`delete function`) aceptan parámetros
adicionales según cuántos declares — sin romper nada de lo que ya
funcionaba con uno solo:

```
post function crear(args, query, headers)
    items = [...items, { texto: args.texto, prioridad: query.prioridad || "normal", agente: headers["user-agent"] }]
    return { items: items }

get function listar(query, headers)
    return { total: items.length, filtro: query.filtro || "ninguno", tieneAuth: !!headers["authorization"] }
```

| Parámetros declarados | `get function` | `post`/`put`/`delete function` |
|---|---|---|
| 1 | *query string* (como siempre) | *body* JSON (como siempre) |
| 2 | + cabeceras | + *query string* |
| 3 | — (no aplica, `get` no tiene *body*) | + cabeceras |

- **Retrocompatible al 100%**: con un solo parámetro, el comportamiento es
  exactamente el de antes — probado explícitamente que `?ignorado=si` en
  la URL no se cuela en ningún sitio si la función solo declara `(args)`.
- **El *stub* de cliente nunca cambia de forma**: aunque la función del
  servidor declare `(args, query, headers)`, el *stub* generado para el
  cliente sigue teniendo **un solo parámetro** — `query`/`headers` son
  contexto que solo ve el servidor (de dónde vino la petición, qué
  cabeceras trae), el cliente nunca "manda" cabeceras a mano, el navegador
  ya las pone. Esto necesitó un arreglo: el generador del *stub* usaba
  `fn.params` completo tanto para la firma como para `JSON.stringify(...)`
  — con 3 parámetros eso habría generado
  `JSON.stringify(args, query, headers)`, que NO es "serializa estos tres
  valores", son los argumentos *replacer*/*space* de `JSON.stringify`,
  rompiendo el *body* enviado. Corregido para que `JSON.stringify(...)`
  solo use el primer parámetro (el *body*) — la *query string*, en cambio,
  si es visible para el cliente, ver más abajo.
- Cabeceras y valores de *query string* llegan siempre como **strings**
  (así son en HTTP) — a diferencia del *body* JSON, que si conserva tipos
  reales (números, booleanos, objetos anidados).
- Probado de extremo a extremo: `POST` con los tres a la vez (`body` +
  `?prioridad=alta` + `User-Agent` real) construye el objeto esperado
  exacto; `GET` detecta correctamente la presencia/ausencia de la cabecera
  `Authorization`; y una llamada real desde un `visual` (vía el *stub*
  generado) confirma que la cabecera `User-Agent` del navegador llega
  intacta al servidor sin que el cliente tuviera que hacer nada especial.

## `JSON.stringify`/`JSON.parse` y sus métodos: retrocompatibilidad total

Como WebScript compila a JS "casi crudo" (solo sustituye nombres de
`reactive`/`var`/`server var`), `JSON` es el objeto global de JS de
siempre — no hay ninguna capa propia por encima que pudiera romperlo.
Verificado explícitamente en cliente **y** servidor: `JSON.stringify`,
`JSON.parse`, `.filter()`/`.map()` sobre el resultado, `Object.keys()`, y
el atajo de propiedad (`{ nombre, edad }`) dentro de `JSON.stringify`
(que ya arreglamos hace tiempo) — todo funciona igual.

### ¿Los objetos parseados de JSON son reactivos "por dentro"?

**Sí — reactividad profunda implementada tras esta misma pregunta** (ver
la sección dedicada "Reactividad profunda" más abajo). Mutar una
propiedad anidada, o un índice de array, dispara actualizaciones sin
necesitar reasignar la variable completa:

```
reactive datos = JSON.parse(textoJson)

-> onclick:
    datos.edad = 99                // SÍ actualiza la vista (antes no)
    datos = { ...datos, edad: 99 } // SIGUE funcionando también
```

### Bug real encontrado montando esta prueba: referencias cruzadas entre `reactive`

Al construir el ejemplo (`reactive datos = JSON.parse(textoJson)`, donde
`textoJson` es **otra** `reactive` declarada justo antes) apareció un
`ReferenceError: textoJson is not defined` real. Causa: el objeto inicial
que se le pasa a `createStore({...})` se construía con los valores
**crudos** de cada `reactive.init`, sin pasar por ningún motor de
sustitución — `textoJson` nunca se convertía en nada utilizable.

Y el arreglo no era tan simple como "sustituir a `state.textoJson`" —
en ese punto exacto del código generado, la variable `state` **todavía
no existe** (se está construyendo con esa misma llamada a
`createStore(...)`), así que esa sustitución habría fallado igual, con
un `ReferenceError` distinto (`state is not defined`).

**Solución**: calcular el valor inicial de cada `reactive` en una
variable local previa (`let __init_textoJson = ...`), **en orden de
declaración**, de modo que una `reactive` posterior pueda referenciar el
valor ya calculado de una anterior a través de esa variable local
(`__init_NOMBRE`), no de `state.NOMBRE`. Necesitó una función de
sustitución nueva (`injectVarsAsLocals`, hermana de la que ya existía)
que genera un identificador con guion bajo en vez de un acceso de
propiedad. Aplicado en los dos caminos de montaje (ruta estática y
dinámica), verificado con el código generado exacto y con ejecución
real.

**Límite que queda, documentado a propósito**: solo funcionan las
referencias hacia **atrás** (una `reactive` referenciando a otra
declarada **antes** en el archivo) — una referencia hacia adelante
seguiría sin sustituirse, ya que en JS no se puede usar una variable
`let` antes de declararla. Es un patrón inusual (casi nadie escribe
`reactive a = b` antes de declarar `b`), así que no se resolvió más allá
de dejarlo documentado.

## Reactividad profunda: mutar objetos/arrays anidados también actualiza la vista

Hasta este punto, el sistema reactivo era de **un solo nivel**: solo
`state.NOMBRE = valor` (la reasignación completa) disparaba
actualizaciones. Mutar una propiedad anidada o un índice de array
(`datos.edad = 99`, `lista.push(x)`, `lista[0] = x`) no hacía nada — había
que reasignar siempre (`lista = [...lista, x]`).

Implementado reescribiendo el núcleo de `runtime/reactive.js` (el
*runtime* que se incluye tal cual en cada `bundle.js`) con el mismo
patrón que usa Vue 3 por dentro: cada objeto/array que se lee de una
`reactive` se envuelve en su **propio** `Proxy`, de forma perezosa y
recursiva (solo al acceder, no de golpe), y las dependencias se rastrean
por **ruta completa** (`["datos","edad"]`, no solo `"datos"`) — así, un
efecto que lee `datos.edad` se re-ejecuta cuando cambia `edad`, pero no
cuando cambia un campo hermano que nunca leyó.

```
reactive datos = { nombre: "Ana", edad: 25 }
reactive lista = [1, 2, 3]

-> onclick:
    datos.edad = 99      // ahora SÍ dispara la vista
    lista.push(4)        // ahora SÍ dispara la vista
    lista[0] = 99         // ahora SÍ dispara la vista
```

### El primer diseño estaba mal, y lo descubrí probándolo

Mi primer intento notificaba, al mutar una ruta, tanto la ruta exacta
**como todos sus ancestros** — razonando que así un efecto que lee el
objeto entero (`JSON.stringify(datos)`) también se enteraría de cambios
en sus campos. Probándolo con un caso mínimo (un efecto que solo lee
`datos.edad`, y mutar tanto `edad` como un campo hermano `nombre` que
nunca leyó) aparecieron dos fallos reales:

1. **Doble disparo**: mutar `edad` re-ejecutaba el efecto **dos veces**,
   no una. Causa: leer `datos.edad` registra el efecto en dos niveles a
   la vez (`["datos"]`, el paso intermedio, y `["datos","edad"]`, el
   acceso final) — al notificar también el ancestro, el mismo efecto
   recibía dos avisos por el mismo cambio.
2. **Falso positivo**: mutar `nombre` (que el efecto nunca leyó)
   **también** re-ejecutaba el efecto — porque `nombre` y `edad`
   comparten el mismo ancestro `["datos"]`, y el efecto ya estaba
   suscrito ahí solo por haber pasado por él de camino a `edad`.

**La solución correcta era más simple, no más compleja**: notificar
**solo** la ruta exacta que cambió, nunca los ancestros. El caso
"efecto que lee el objeto entero" no necesita ningún mecanismo especial
— `JSON.stringify(datos)` internamente lee cada propiedad una por una (a
través del mismo `Proxy`), así que ya registra una dependencia fina en
cada una por sí solo. Verificado explícitamente: mutar un campo
individual sí re-ejecuta un efecto basado en `JSON.stringify` del objeto
completo, sin necesitar la lógica de ancestros que causaba los dos fallos
de arriba.

### Segundo bug, más sutil: doble envoltura rompía el *diffing* por clave

Tras arreglar lo anterior, la suite de tests reveló un fallo real en el
`for` con clave (`tests/compiler.test.js`, "diffing por clave: no
reconstruye ítems que no cambiaron") — el mismo test que ya existía desde
que implementamos esa función. Causa: cuando se lee un array ya envuelto
en `Proxy` (ej. dentro de `.slice()`, `.filter()`, `.map()`, o un
`spread`), cada **elemento** que se lee durante esa operación **ya viene
envuelto** — y el método construye su array de salida con esos elementos
ya envueltos dentro. En el siguiente render, al leer ese array de nuevo,
cada elemento (que ya es un `Proxy`) se **volvía a envolver** — un
`Proxy` sobre otro `Proxy`, con una identidad distinta a la de antes,
rompiendo la comparación `entry.item !== item` de la que depende el
*diffing* por clave para decidir si reutilizar un nodo DOM o
reconstruirlo.

**Arreglado** detectando, antes de envolver algo, si **ya es uno de
nuestros propios `Proxy`** (vía un símbolo marcador interno) — si lo es,
se devuelve tal cual, sin volver a envolver. Verificado con el propio
test de *diffing* que había fallado, y con una prueba real de `.push()`
sobre un `for` con clave, confirmando que la lista se actualiza
correctamente sin duplicar ni perder identidad de nodos.

### Garantías verificadas explícitamente

- **Mutación a 3 niveles de profundidad** (`empresa.direccion.ciudad =
  "Valencia"`) dispara la actualización correcta.
- **Reasignación completa sigue funcionando** exactamente igual que
  antes — retrocompatibilidad total con todo el código ya escrito.
- **Identidad estable entre lecturas repetidas**: `state.empresa ===
  state.empresa` y `state.empresa.direccion === state.empresa.direccion`
  dan `true`, tanto en pruebas aisladas del *runtime* como en el
  *pipeline* completo con el `for` con clave.
- **Suite completa**: 121 tests, 0 fallos, tras actualizar dos tests que
  comprobaban el comportamiento **antiguo** (uno legítimamente, ya que
  documentaba justo la limitación que se acaba de resolver).

**Límite que sigue existiendo, ahora más estrecho**: el sistema todavía
no distingue "leer `datos.edad` como valor final" de "leer `datos.edad`
de camino a algo más profundo" en todos los casos imaginables de
identidad tras operaciones que **reconstruyen** objetos (no solo arrays)
combinando código propio con más envolturas manuales — el caso cubierto
y probado es el que de verdad importa en la práctica (arrays vía
`.slice()`/`.filter()`/`.map()`/*spread*, que es como se reasignan
listas en WebScript). Un caso exótico no probado explícitamente: envolver
manualmente un elemento ya reactivo dentro de un objeto **nuevo**
construido a mano campo por campo (no vía *spread*) podría, en teoría,
seguir dando una interacción distinta — no se encontró ningún caso real
así al escribir los ejemplos de esta conversación.

## `server reactive` + `watch()`: observar cambios en el servidor

`server reactive` volvió — pero ahora con un propósito real, distinto de
`server var`, en vez de ser un sinónimo puro (que fue exactamente por lo
que se quitó antes). La diferencia: solo las declaradas `reactive` se
pueden **observar** con `watch(NOMBRE)`:

```
server reactive var1 = 0
server var log = []

watch(var1)
    log = [...log, "var1 cambió a " + var1]

post function actualizar(args)
    var1 = args.valor
    return { var1: var1 }
```

- **Se declara una vez, a nivel de archivo** — se dispara sin importar
  cuál `get`/`post`/`put`/`delete function` fue la que cambió la
  variable. Probado explícitamente: cambiar `var1` desde un `POST` y
  desde un `PUT` distintos, ambos disparan el mismo `watch`.
- **Nunca corre con el valor inicial** — solo en cambios **posteriores**,
  a diferencia de un `effect()` del cliente (que sí corre inmediatamente
  al registrarse). Es el comportamiento estándar de "watch" en cualquier
  framework que lo tenga. Probado explícitamente: el primer `GET` da
  `log: []` vacío, aunque `var1` ya valga `0` desde el arranque.
- **Por qué a nivel de archivo y no dentro de una función concreta**: si
  viviera dentro de una sola `post function`, solo se enteraría de los
  cambios que *esa* función en particular hiciera — tendrías que
  duplicar el mismo bloque en cada función que también toque la
  variable. A nivel de archivo se escribe una vez y cubre todas.
- **Cómo funciona por debajo**: cada `server reactive` se guarda en un
  `Proxy` interno (`__serverReactive`) dentro de `createSessionState()`
  — asignarla dispara los `watch` registrados para ese nombre. Las
  referencias sueltas al nombre, dentro de cualquier cuerpo (`server
  function`, las cuatro HTTP, o el propio `watch`), se sustituyen a
  acceso a través del `Proxy` reutilizando `injectVars` — el mismo motor
  de sustitución que ya usa el cliente, no uno nuevo.
- `watch(NOMBRE)` valida que `NOMBRE` sea una `server reactive` de verdad
  declarada en el archivo — si es una `server var` normal (no
  observable), o un nombre inventado, error explícito en compilación con
  el porqué, no un fallo silencioso.

### Dos bugs reales, preexistentes, encontrados montando esto

Probando `watch()` con un mensaje de texto (`"var1 cambió a " + var1`)
salieron dos bugs del motor de sustitución compartido — **ninguno
introducido por `watch()`**, los dos ya afectaban al cliente normal desde
antes, solo que nunca se habían topado con el patrón exacto que los
revela.

**1. El texto dentro de una cadena se sustituía por error.** `"var1
cambió a " + var1` se convertía en `"__serverReactive.var1 cambió a " +
__serverReactive.var1` — la palabra `var1` **dentro del propio texto**
también se sustituía, corrompiendo el mensaje. Confirmado que esto
también rompía el cliente: `"el contador vale " + contador` se convertía
en `"el state.contador vale " + state.contador`. Arreglado con una
función nueva (`findStringLiteralSpans`) que detecta los tramos de texto
dentro de comillas simples/dobles y los excluye de la sustitución —
respetando `${...}` dentro de un *template literal*, que sí es código de
verdad y sí debe sustituirse.

**2. `${nombre}` de un *template literal* se confundía con un atajo de
objeto.** Al arreglar el primero, apareció este: `` `vale ${contador}` ``
se expandía mal a `` `vale ${contador: state.contador}` `` — la
detección de "esto es un atajo de objeto tipo `{ contador }`" no
distinguía si el `{` que tenía delante era en realidad parte de `${`
(interpolación) o un objeto literal de verdad. Arreglado comprobando
explícitamente ese caso.

Ambos arreglados en `compiler.js` **y** `validate.js` (que reimplementa
esta lógica por separado, a propósito, para no acoplar la validación al
compilador) — y en el camino apareció un tercer fallo, más simple:
`validate.js` usaba una función (`isInsideAnySpan`) que solo existía en
`compiler.js`, tirando un `ReferenceError` real en la validación de
seguridad más importante del lenguaje ("`server var` prohibida en
`visual`"). Arreglado añadiendo la función también ahí.

Verificado con `node --check`-equivalente (ejecución real del bundle) en
ambos casos: el texto sale intacto, la interpolación real sí se
sustituye, y la validación de seguridad volvió a funcionar.

## Bug real encontrado después: el *stub* nunca mandaba la *query string*

Al preguntarme "¿dónde pongo los *query params*?" para llamar desde un
`visual`, descubrí que la respuesta, tal como estaba el código, era
**"en ningún sitio" — el *stub* generado nunca los mandaba**. Aunque `post function
crear(args, query)` declarara un segundo parámetro, el *stub* de cliente
siempre hacía `fetch(routePath, {...})` sin *query string* ninguna —
`query` llegaba vacío `{}` siempre que se llamara desde un `visual`
(mandarlo funcionaba perfectamente si se hacía la petición a mano con
`curl`, que es como lo había probado hasta entonces — el hueco solo se
notaba desde el flujo real de cliente).

**Causa**: cuando decidí que el *stub* solo expusiera el primer parámetro
(razonando que `query`/`headers` son "contexto que solo ve el servidor"),
generalicé mal — esa lógica es correcta para las **cabeceras** (el
navegador ya las pone solo, el cliente nunca las "manda" a mano), pero
**no** para la *query string*, que sí es algo que quien llama elige
explícitamente, como el propio *body*.

**Arreglado**: si la función declara 2+ parámetros, el *stub* ahora expone
`(args, query)` — dos parámetros visibles para el cliente — y construye
la URL con `new URLSearchParams(query).toString()` antes de hacer el
`fetch`. Las cabeceras (tercer parámetro) siguen sin exponerse, esa parte
del razonamiento original sí era correcta.

```
-> onclick:
    var r = await crear({ texto: "nueva" }, { prioridad: "alta" })
```

Verificado en las dos puntas: el `server.js` generado recibe
`query.prioridad === "alta"` de verdad, y — más importante, porque es
justo lo que faltaba antes — el `bundle.js` generado, ejecutado como lo
haría un navegador real, construye la URL `/?prioridad=alta` por su
cuenta al llamar al *stub*, sin que el código del `visual` tuviera que
construir la URL a mano.

## `server function` inalcanzable: rechazada en tiempo de compilación

Un archivo que declara `route(...)` pero no tiene `render(...)` **ni
ninguna función HTTP** (`get`/`post`/`put`/`delete function`), y aun así
declara una `server function`, se rechaza:

```
route("/api/x")

server function duplicar(x)
    return x * 2
```
```
SyntaxError: "server function duplicar" (línea 3) es inalcanzable: este
archivo declara route(...) pero no tiene ninguna función HTTP que pueda
llamarla, y un archivo con route() no se puede importar desde otro.
```

**El razonamiento, con los tres casos límite que se descartaron por el
camino** (los tres verificados con código real, no solo en teoría):

1. **Primer intento, demasiado amplio**: prohibir `server var` **o**
   `server function` sin ninguna función HTTP. Roto de inmediato — un
   archivo con `route()` + solo `server var` (sin ninguna función) **ya
   es un patrón válido y probado**: se sirve su estado por `GET`
   automáticamente (el volcado por defecto de "WebScript como backend
   puro", más arriba). `server var` sola SÍ es alcanzable — leíble — así
   que no puede prohibirse.
2. **Segundo intento, seguía siendo demasiado amplio**: prohibir `server
   function` sin ninguna función HTTP, sin más. También roto — un
   archivo **sin `route()`** (una librería pensada para `import`, como
   `compartido.ws` en los ejemplos) legítimamente no tiene ninguna
   función HTTP propia: la función espera a que **otro** archivo la
   importe y la llame. Ese es justo el patrón que ya usa
   `examples/demo-import/`.
3. **Versión final**: la prohibición solo aplica cuando el archivo **sí**
   declara `route()` — ahí, y solo ahí, la función es de verdad
   inalcanzable, porque no hay ninguna HTTP function propia que la llame
   Y un archivo con `route()` no se puede importar desde otro (ya estaba
   validado desde mucho antes). Los cuatro casos límite (inalcanzable con
   `route()`, `server var` sola con `route()`, librería sin `route()`, y
   con al menos una función HTTP) se probaron explícitamente y se
   comportan como se espera.

## `import` de `server var`/`server function`: ya funcionaba, verificado a fondo

Antes de tocar nada, se comprobó si `import { nombre } from "./lib.ws"`
ya soportaba traer `server var`/`server function` de otro archivo —
**sí, ya funcionaba**, sin necesitar ningún cambio. El mecanismo de
`import` copia cualquier nodo con nombre sin distinguir su tipo, así que
ya alcanzaba a estos dos sin querer. Verificado con **cinco** escenarios
reales antes de darlo por bueno:

1. Importar y usar `server var`/`server function` dentro de una `post
   function` — funciona, con el estado incrementándose correctamente.
2. Un `server var` importado **sí** se detecta como prohibido si se
   referencia dentro de un `visual` — la validación de seguridad no tiene
   ningún hueco por el lado de `import`.
3. El patrón legítimo `reactive x = server.nombreImportado` para leer en
   cliente — funciona igual que si estuviera declarado localmente.
4. Colisión de nombres (importar `contador` y también declararlo
   localmente) — detectada, mismo error de siempre.
5. **Independencia entre rutas**: dos rutas distintas que importan el
   mismo `server var` mantienen cada una su propio estado — probado
   incrementando una en +10 y la otra en +1, confirmando que no se
   contaminan entre sí (coherente con el modelo de sesiones: cada archivo
   compila su propio `createSessionState()`, `import` solo copia la
   declaración, no crea una referencia compartida en tiempo de
   ejecución).

## Bug real: `reactive x = servervar` (a secas) compilaba y explotaba en el navegador

Surgió al discutir si `watch()` debería pedir `server.NOMBRE` en vez de
`NOMBRE` a secas. La respuesta a esa pregunta concreta fue que no —
dentro del propio `server.js` (en `post`/`put`/`delete`/`server
function`, y `watch()`), las `server var`/`server reactive` siempre se
referencian a secas, nunca con `server.`; meter el prefijo ahí sería
inconsistente con el resto del archivo (`watch(server.var1)` seguido de
`whisper("..." + var1)` **sin** el prefijo dentro, la misma variable).

Pero la pregunta llevó a comprobar algo que nunca se había probado: ¿qué
pasa si te **olvidas** del `server.` donde sí hace falta — al leer una
`server var` en una `reactive` de **cliente**?

```
server var contador = 100

reactive x = contador   // se olvidó el "server."
```

**Compilaba sin ningún aviso**, y explotaba en el navegador con
`ReferenceError: contador is not defined` — `contador` (una `server var`)
nunca llega al `bundle.js`, así que la referencia a secas queda apuntando
a nada. Confirmado que **no era específico del `import`** — pasaba
exactamente igual con una `server var` declarada localmente, sin
importar nada de por medio. La validación de "prohibido en visuales" solo
revisaba plantillas/*bindings*/`reactive` locales **dentro** de un
`visual` — nunca el valor inicial de una `reactive`/`var` **global**.

**Arreglado** extendiendo la misma validación a las declaraciones
globales: si el valor inicial de cualquier `reactive`/`var` a nivel de
archivo referencia una `server var`/`server reactive`/`server function` a
secas, error explícito en compilación señalando el `server.NOMBRE`
correcto — en vez de un `ReferenceError` críptico en el navegador de
quien use la página. Verificado que la forma correcta
(`reactive x = server.contador`) sigue compilando sin ningún falso
positivo, tanto local como importada.

## Las cuatro funciones HTTP deben devolver siempre algo

Comprobé primero si esto era necesario o solo preferencia de estilo:
**sin ningún `return`, el compilador no revienta hoy** — el despachador
convierte `undefined` en `null` y responde `200` igualmente. No es un
*crash*, pero es exactamente el tipo de sorpresa silenciosa que hemos ido
cerrando en todo este proyecto: el desarrollador se olvida de un
`return` y el cliente recibe `null`, sin ningún aviso de que faltaba
algo.

```
post function incrementar(args)
    contador = contador + 1
    // sin return -- el cliente recibía "null", sin saber que faltaba algo
```

**Arreglado** con una comprobación superficial, no un análisis de flujo
real: se rechaza si el cuerpo de una `get`/`post`/`put`/`delete function`
no contiene **ningún** `return` en absoluto, o si tiene un `return` **sin
valor** (`return;`, que devuelve `undefined` explícitamente — igual de
silencioso que no tener ninguno). `return null`/`return {}` a propósito
siguen permitidos, porque ahí sí hay un valor explícito, aunque sea
"vacío".

**Límite reconocido a propósito**: no detecta el caso más sutil de
"algunas ramas de un `if` devuelven y otras no" — eso necesitaría
análisis real de flujo de código, no una heurística de texto. Verificado
que el caso legítimo (`if`/`else` donde **ambas** ramas sí devuelven)
compila sin ningún falso positivo.

**Bug lateral que salió al implementar esto**: un test existente
(`tests/server.test.js`, "resiliencia ante un `server.js` roto")
verificaba que una `post function` con JS **sintácticamente inválido**
seguía dando un `500` limpio sin tumbar el proceso — pero esa función de
prueba nunca tenía `return`, así que la nueva validación la atrapaba en
**compilación**, antes de llegar al escenario de fallo en **ejecución**
que el test quería probar. Arreglado añadiendo un `return` al cuerpo roto
sin quitarle lo que lo hacía inválido como JS (la sintaxis rota sigue
ahí, delante del `return`) — el test sigue verificando exactamente lo
mismo que antes, solo que ahora pasa primero por la nueva validación sin
que esta se interponga.

## `async` opcional en `function`/`server function`; `watch()` siempre `async`

Pregunta que lo motivó: si `http.*` necesita `await`, y `function`/`server
function`/`watch()` son síncronas por defecto, ¿cómo iban a poder usar
`http.*`, `fetch`, o una dependencia asíncrona de Node (como el driver de
`sqlite`)? Confirmado con código real: los tres daban `SyntaxError:
await is only valid in async functions`.

**No era tan simple como "hacerlas todas `async`"** — ya nos habíamos
topado con esto exacto al construir `watch()`: hacer `server function`
siempre `async` rompía un patrón **ya en uso**, llamarla sin `await`
esperando el valor de vuelta directo (`duplicar(contador)` como número,
no como una Promise).

**Matiz importante que surgió discutiéndolo**: las cuatro funciones HTTP
nunca tuvieron este problema porque, desde el principio, quien las llama
**ya estaba diseñado para esperar un valor async** (el *stub* de cliente
usa `.then()`, el despachador usa `await`) — el riesgo de romper algo
solo existe donde ya había una llamada **síncrona** capturando el valor
directamente. Y ni siquiera ahí aplica siempre: una función **void** (sin
valor de retorno que le importe a nadie) puede hacerse `async` sin ningún
riesgo, igual que `watch()`.

**Solución implementada**, con esos dos matices en cuenta:

- **`watch()` pasa a ser siempre `async`**, sin necesitar ningún prefijo
  — nada captura su valor de retorno, así que no había ningún patrón que
  romper.
- **`function`/`server function` ganan un prefijo `async` OPCIONAL**,
  igual que en JS de verdad — por defecto siguen siendo síncronas
  (retrocompatibilidad total), y con `async function`/`async server
  function` delante, pueden usar `await` dentro, a cambio de que quien
  las llame también necesite `await`.

```
async function llamarFuera(url)
    var r = await fetch(url)
    return r

async server function consultarDB()
    var fila = await db.get("SELECT * FROM tabla")
    return fila
```

Verificado de extremo a extremo con servidor real (contra un "sistema
externo" simulado, no solo compilación): una `post function` (ya siempre
`async`) llama con `await` a una `async server function` que a su vez usa
`await http.get(...)` — la respuesta llega correcta. Y, más importante
para no repetir el error anterior, verificado que la versión **sin**
`async` (`server function duplicar(x) { return x * 2 }`, llamada sin
`await`) **sigue devolviendo el número directo**, no una Promise —
retrocompatibilidad confirmada con ejecución real, no solo revisando el
código generado.

## `watch()` anidado dentro de otro bloque: rechazado, redundante y roto a la vez

Pregunta que lo motivó: ¿debería `watch()` poder anidarse dentro de una
`function`/`if`/`for`? Lo probé en tres sitios distintos antes de decidir
nada:

```
server function foo()
    watch(var1)          // dentro de otra función
        whisper("cambio")

post function usar(args)
    if (args.activar)
        watch(var1)       // dentro de un if
            whisper("nested")
```

**Los dos casos compilaban "sin error" y reventaban en producción** con
`500: "watch is not defined"`. Causa: `watch` solo se reconoce como
declaración de **nivel superior** del archivo — dentro del cuerpo de
cualquier función (que se trata como JS "casi crudo"), el texto
`watch(var1)` no se interpreta como la construcción especial, se
sustituye `var1` → `__serverReactive.var1` igual que cualquier otra
referencia, y queda como una llamada normal a una función `watch` que no
existe en ese ámbito.

**Tercer caso, cualitativamente distinto**: dentro de un `for` de
**plantilla** (en un `visual`), `watch(item)\n    whisper("x")` ni
siquiera se interpreta como código — se convierte en **texto literal**
en la página (`document.createTextNode("watch(item)whisper(\"x\")")`),
sin ningún aviso.

**Arreglado** para los dos primeros casos (los que de verdad revientan):
se rechaza en compilación si el cuerpo de cualquier
`server`/`post`/`put`/`delete`/`get function` — o de otro `watch` —
contiene `watch(` en su texto. El mensaje explica las dos razones a la
vez: no funcionaría (no se reconoce ahí, sería un `ReferenceError`), y
aunque funcionara sería redundante (`watch(NOMBRE)` a nivel de archivo
ya se dispara sin importar cuál función cambió la variable). Verificado
con cuatro casos: dentro de una `server function`, dentro de un `if`
dentro de una `post function`, dentro de otro `watch` (con el mensaje
mostrando correctamente `"watch(a)"`, no el nombre interno del nodo), y
confirmando que el patrón **legítimo** (`if`/`for` **dentro** del propio
cuerpo de un `watch`, sin ningún `watch` anidado ahí dentro) sigue
funcionando exactamente igual que antes.

**Bug lateral que encontré arreglando el mensaje de error**: para que el
error dijera `"watch(a)"` en vez de `"WatchDecl a"`, añadí `WatchDecl` al
diccionario de etiquetas legibles (`LABELS`) — pero ese mismo diccionario
también se usaba como filtro para decidir qué nodos participan en la
detección de colisión de nombres (`ast.body.filter(n => LABELS[n.type])`).
Al añadir `WatchDecl` ahí, se coló también en esa detección, dando un
falso `"Nombre duplicado"` entre una `server reactive` y su propio
`watch()` — la misma variable, marcada como si colisionara consigo
misma. Arreglado usando el conjunto correcto (`SHARED_NAMESPACE`) para
ese filtro en vez del diccionario de etiquetas, que son dos cosas
distintas aunque se parecían lo suficiente para confundirlas. Cubierto
con un test de regresión explícito.

## Bug real: `var`/`reactive` (cliente) en una ruta "solo backend" eran inertes y silenciosas

Pregunta que lo destapó: en un archivo puramente de servidor (con
`route()`, sin `render()`), ¿da igual declarar `var` que `server var`?

**No — y era otro caso del mismo patrón**: compilaba sin ningún aviso, y
solo revienta cuando alguien la usa de verdad.

```
route("/api/x")

var x = 5   // se compila al bundle.js...

post function leer(args)
    return { valor: x }   // ...que en una ruta "solo backend" NUNCA se escribe a disco
```

`POST /api/x` daba `500: "x is not defined"` — `var x = 5` se compila
como código de **cliente** (`bundle.js`), y una ruta "solo backend" (con
`route()` pero sin `render()`) nunca escribe ese archivo a disco, se
descarta entero. `x` no existe en ningún sitio real: ni en `server.js`
(`var`/`reactive` nunca se compilan ahí), ni en un `bundle.js` que nadie
sirve.

**Arreglado** con el mismo criterio que ya usamos para "`server function`
inalcanzable": se rechaza en compilación cualquier `reactive`/`var`
declarada en un archivo que tiene `route()` pero no `render()`, con un
mensaje que señala la alternativa correcta (`server var`/`server
reactive`) o añadir un `visual` + `render(...)` si el archivo debería
tener página. Una librería **sin** `route()` (pensada para `import`)
queda exenta, como siempre — ahí sí es un patrón legítimo declarar
`reactive`/`var` para que otro archivo con página los importe.

## `function` — el equivalente de cliente a `server function`

Pregunta que lo motivó: si `var`/`reactive` tienen su pareja de servidor
(`server var`/`server reactive`), ¿por qué no hay un `function` de
cliente, análogo a `server function`? Antes de implementarlo comprobé si
hacía falta de verdad, o si `var NOMBRE = (params) => valor` ya cubría lo
mismo — y encontré una diferencia real, no solo de estilo: **el valor de
un `var` tiene que caber en una sola línea** (`^var\s+...\s*=\s*(.+)$` en
el parser captura todo lo que hay después del `=` hasta el final de esa
misma línea). Confirmado con código real: un `var duplicar = (x) => {`
seguido de más líneas indentadas revienta con `SyntaxError`, "no se
reconoce la instrucción". No hay forma de escribir una función de
cliente reutilizable con **varias sentencias** sin `function`.

```
reactive base = 10

function calcularConBase(x)
    var resultado = x + base
    if (resultado > 20)
        return "alto: " + resultado
    else
        return "bajo: " + resultado
```

- Mismo patrón exacto que `server function`: cuerpo indentado en varias
  líneas, reutilizando `collectIndentedBody` (así que hereda gratis el
  arreglo de indentación relativa legible que ya hicimos para `watch()`).
- Compila a una `function` normal de JS (no una `const` con flecha) a
  nivel superior del `bundle.js` — con *hoisting*, así que se puede
  llamar desde cualquier sitio (otro `var`, un `handler`, otra
  `function`) sin importar el orden de declaración en el archivo.
- Su cuerpo pasa por el mismo motor de sustitución que cualquier otro
  código de cliente — una `reactive` referenciada dentro se convierte en
  `state.NOMBRE`, verificado con un caso real (`base` dentro de
  `calcularConBase` se sustituye correctamente, y el `if`/`else` interno
  se ejecuta con la lógica esperada: `calcularConBase(15)` con `base=10`
  da `"alto: 25"`, no un resultado a medias).
- Comparte el mismo espacio de nombres que `reactive`/`var`/`visual`/etc
  — colisión real si repites nombre.
- **Misma protección que `var`/`reactive`** contra el bug que acabamos de
  cerrar: una `function` declarada en una ruta "solo backend" (con
  `route()` pero sin `render()`) se rechaza en compilación, sugiriendo
  `server function` en su lugar — en vez de compilar en silencio y
  explotar con `ReferenceError` en cuanto alguien la llame.

## `import` transitivo + `whisper()` + `if`/`for` dentro de `watch()`

Tres preguntas en una, todas verificadas con código real:

### Bug real, serio: `import` no traía dependencias transitivas

```
// otro.ws
server reactive var1 = 0

server function updateVar()
    var1++

watch(var1)
    whisper("Actualizado " + var1)
```
```
// un.ws
import { updateVar } from "./otro.ws"
```

Importar **solo** `updateVar` (sin pedir explícitamente `var1`) daba
`500: "var1 is not defined"` en tiempo real — `updateVar` se copiaba tal
cual, pero `var1` (de la que depende) nunca llegaba a existir en el
archivo importador. **Confirmado que esto ya era un bug antes de
`watch()`**, probándolo primero con `server var`/`server function`
normales, sin nada nuevo de por medio — nunca se había probado este
patrón exacto (importar una función sin importar también lo que
necesita).

**Arreglado de raíz**: `import` ahora resuelve **dependencias
transitivas** automáticamente — al pedir `updateVar`, escanea su cuerpo
en busca de qué otros nombres declarados en el mismo archivo usa, y los
trae también, recursivamente. Con una regla extra para `watch()`:
**`watch` no se puede pedir por nombre explícitamente** (no tiene un
nombre propio, observa una variable ajena) — pero si esa variable se
importa (directa o transitivamente), su `watch()` viene con ella
automáticamente, para que el comportamiento sea el mismo que usarla
localmente en el archivo original. Verificado de extremo a extremo con
servidor real: `POST` a una ruta que solo importa `updateVar` incrementa
`var1` **y** dispara el `watch` asociado.

### `whisper()` — equivalente a `console.log()`, sin capacidad nueva

Antes de añadirlo, comprobé si `console.log()` ya funcionaba directamente
dentro de un `watch()` (dado que los cuerpos son JS "casi crudo") — sí,
sin necesitar nada nuevo. `whisper(...)` es una envoltura fina,
generada **solo si se usa** (mismo criterio que `http`), pensada
únicamente para que el vocabulario del lenguaje quede coherente (`http`,
`watch`, `server reactive`, `whisper`) — no añade ninguna capacidad real
sobre `console.log()`.

### `if`/`for` dentro de `watch()`: se comportan normal, verificado con lógica real

No es el `if`/`for` de plantilla (eso solo existe dentro de un `visual`)
— dentro de `watch()` son control de flujo JS normal, con llaves o sin
ellas, igual que en cualquier `post`/`put`/`delete`/`server function`.
Probado con lógica real (no solo que compile): un `watch(contador)` con
un `if`/`else` que clasifica par/impar y un `for` que acumula una suma —
tras `contador = 3` da `mensajes: ["impar: 3"]` y `suma: 3` (`0+1+2`);
tras subir a `contador = 4`, añade `"par: 4"` y `suma` sube a `9`
(`3 + 0+1+2+3`) — las cifras cuadran exactamente con lo esperado.

**Detalle de legibilidad que arreglé de paso**: el código generado para
CUALQUIER cuerpo de función (no solo `watch`, también
`post`/`put`/`delete`/`get`/`server function` — un bug preexistente en
los tres, no nuevo) perdía toda la indentación interna, aplanando
`if`/`else`/`for` a una sola columna. Seguía siendo JS **válido**
(confirmado con `node --check`, JS no depende de la indentación para
nada) y la lógica funcionaba correctamente incluso así — pero era
difícil de leer. Arreglado con un `collectIndentedBody()` compartido que
preserva la indentación **relativa** interna, en vez de aplanar todo con
`.trim()`.

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
protección CSRF en los endpoints `POST` (`post function`)
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

## Limitaciones actuales (auditoría completa, verificada contra el código)

Recopilación de todo lo que sigue sin resolver a día de hoy — cada punto
comprobado contra el código real antes de escribirlo aquí, no copiado de
memoria de menciones anteriores en este documento. Organizado por
categoría, de más a menos probable que te sorprenda.

### Lenguaje / plantillas

- **No puedes mezclar texto literal con `{expr}` dentro de un mismo
  atributo.** `class="btn-{tipo}"` NO interpola — se queda literalmente
  como el string `"btn-{tipo}"`, llaves incluidas. Verificado de nuevo
  ahora mismo: el atributo generado es exactamente ese texto sin tocar.
  Solo funciona si el atributo es *enteramente* la expresión
  (`value={contador}` o `value="{contador}"`).
- **Solo hay un `<slot />` "por defecto"** — no hay *slots* con nombre
  (`<slot name="header"/>`) para pasar varios huecos distintos a un mismo
  `visual` hijo. (Nota: la composición con *slot* y *children* sí está
  soportada tanto en cliente como en SSR — la limitación es
  específicamente que no hay más de un hueco por componente.)
- Un `visual` compila a un único elemento raíz — si el resultado no es
  exactamente un elemento (varios nodos hermanos, o un `if`/`for` suelto
  en la raíz), se envuelve automáticamente en un `<div>`, sin forma de
  evitarlo.
- `for` sin `by` usa el índice como clave — correcto siempre, pero pierde
  el beneficio de reutilización de nodos si la lista se reordena o
  inserta en medio (usa `for (item in lista by item.id)` para eso).

### Motor de sustitución de identificadores (sin Acorn instalado)

Estas cuatro solo aplican al motor de respaldo por regex — **con Acorn
instalado y verificado, se resuelven solas**, porque el AST sí hace
seguimiento de ámbitos real:

- Tras un *destructuring* (`const { contador } = obj`), una referencia
  **posterior** a `contador` en el mismo bloque se sigue sustituyendo por
  `state.contador` en vez de resolver a la variable local — el motor de
  regex no rastrea que esa línea creó una variable que hace *shadowing*.
- Dentro de un *destructuring* con valor por defecto
  (`const { contador = otraReactive } = obj`), ese valor por defecto NO
  se sustituye si referencia otra `reactive`.
- **Referencias hacia adelante entre `reactive` no funcionan** — solo
  hacia atrás. `reactive a = b` seguido de `reactive b = 5` da
  `ReferenceError: b is not defined` (verificado ahora mismo); al revés
  (`reactive b = 5` antes que `reactive a = b`) sí funciona. Es un patrón
  inusual, pero es una limitación real y no se ha resuelto — arreglarlo
  necesitaría reordenar declaraciones automáticamente según sus
  dependencias, más trabajo del que parece a primera vista.
- Un *destructuring* dentro de una **asignación** sin declarar
  (`({ contador } = obj)`, sin `const`/`let`/`var` delante) no se maneja
  como caso especial — puede comportarse de forma distinta a lo esperado.

**Pendiente real, no solo teórico**: Acorn se implementó pero **nunca se
ha podido probar con la librería de verdad instalada** — este entorno no
tiene acceso a red para hacer `npm install acorn`. Todo lo anterior
asume que Acorn, una vez instalado, se comporta como está razonado — si
lo instalas y algo de esto no se resuelve como se espera, sería la
primera señal de un bug en `src/js-analyzer.js` que nadie ha detectado
aún.

### Servidor

- **`server function` es siempre síncrona** — no puede usar `await`
  dentro (a diferencia de `get`/`post`/`put`/`delete function`, que sí
  son `async`). Si necesitas llamar a otro sistema (`http.*`/`fetch`),
  hazlo directamente en una de las cuatro HTTP, no en un `server
  function`. Decisión deliberada: hacerla `async` rompía el patrón de
  llamarla sin `await` esperando su valor de vuelta directo, que ya
  estaba en uso.
- **Sin protección CSRF** en los endpoints `POST`/`PUT`/`DELETE` — un
  sitio malicioso podría, en teoría, disparar esas peticiones
  aprovechando la cookie de sesión del navegador de la víctima.
- **Sin límite de tasa** (*rate limiting*) contra abuso o DoS.
- **Sesiones solo en memoria**: no hay expiración, ni límite de cuántas
  se guardan — un servidor de producción de verdad necesitaría expirar
  sesiones viejas o mover el estado a algo compartido (Redis, base de
  datos) en vez de un `Map` en memoria del proceso Node. Tampoco
  comparten estado entre varias instancias del proceso (sin *sticky
  sessions* o un almacén externo, escalar horizontalmente rompería la
  consistencia).
- La cookie de sesión es `HttpOnly` pero no `Secure` (no fuerza HTTPS) —
  pensado para desarrollo local, no para producción tal cual.
- `watch()`: el sistema todavía no distingue "leer `datos.edad` como
  valor final" de "leer `datos.edad` de camino a algo más profundo" en
  todos los casos imaginables de identidad tras operaciones que
  reconstruyen objetos combinando código propio con más envolturas
  manuales — el caso cubierto y probado (arrays vía
  `.slice()`/`.filter()`/`.map()`/*spread*) es el que de verdad importa
  en la práctica.

### Experiencia de desarrollo / build

- **No existe un modo `dev` con recarga en caliente** — cada cambio
  implica recompilar y recargar a mano. Sí existe SSG/SSR (contenido real
  desde el primer HTML), pero no *hot reload* del propio proceso de
  desarrollo.
- **Sin minificación** del `bundle.js`/CSS generado — ni básica ni real.
- **Sin sistema de tipos real** — el tipado opcional (`reactive number x
  = 5`) es una anotación validada superficialmente en compilación (solo
  si el valor inicial es un literal simple), no inferencia ni
  propagación de tipos a través del código.

### Lo que NO es una limitación, aunque lo parezca a primera vista

Para que no se lea como más incompleto de lo que es — estas cosas
**sí funcionan**, verificadas explícitamente en algún momento de esta
conversación, y a veces se asumen rotas por analogía con frameworks
similares: reactividad profunda en objetos/arrays anidados (`.push()`,
mutación de propiedades), `JSON.stringify`/`parse` y sus métodos, *query
string* y cabeceras en las cuatro funciones HTTP, `import` de `server
var`/`server function`/`server reactive` (incluyendo dependencias
transitivas), composición de `visual` con *slot* y *children* (cliente y
SSR), SSG/SSR con *fallback* seguro, y protección explícita contra path
traversal y fuga de variables globales.

