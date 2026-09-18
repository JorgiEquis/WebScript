// WebScript Runtime — sistema reactivo con reactividad PROFUNDA (estilo Vue 3): no
// solo la reasignación completa de una reactive dispara actualizaciones, también mutar
// una propiedad anidada (datos.edad = 99) o un índice de array (lista[0] = x, lista.push(x)).
//
// Cómo funciona: cada valor objeto/array que se lee de una reactive se envuelve en su
// PROPIO Proxy, recursivamente y de forma perezosa (solo al acceder, no de golpe). Las
// dependencias se rastrean por RUTA completa (ej. ["datos","edad"], no solo "datos"),
// así que un efecto que lee state.datos.edad se re-ejecuta cuando cambia edad, pero NO
// cuando cambia un campo hermano que nunca leyó.
//
// Al escribir en una ruta, se notifica SOLO esa ruta exacta -- nunca sus ancestros (ver
// el porqué, detallado, en trigger() más abajo: notificar ancestros parecía necesario
// para que un efecto que lee el objeto entero se enterase de cambios en sus campos,
// pero causaba disparos de más y falsos positivos con campos hermanos nunca leídos).
//
// Se incluye tal cual en el bundle final que corre en el navegador.

function createStore(initial) {
  const subscribers = new Map(); // pathKey (string) -> Set<effectFn>
  let currentEffect = null;
  const proxyCache = new WeakMap(); // objeto/array crudo -> su Proxy reactivo (misma identidad siempre en reads repetidos)
  const REACTIVE_MARKER = Symbol('webscript-reactive');

  function pathKey(path) {
    return JSON.stringify(path);
  }

  function track(path) {
    if (!currentEffect) return;
    const key = pathKey(path);
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key).add(currentEffect);
  }

  function trigger(path) {
    // SOLO la ruta exacta que cambió -- NO sus ancestros. Podría parecer que hace
    // falta notificar también el ancestro para que un efecto que lee el objeto entero
    // (ej. JSON.stringify(datos)) se entere de cambios en sus campos -- pero ESE caso
    // ya queda cubierto solo, porque JSON.stringify internamente lee cada propiedad
    // una por una (a través de este mismo Proxy), registrando ya una dependencia fina
    // en cada una. Notificar ancestros además de eso causaba disparos de más: leer
    // datos.edad registra el efecto TANTO en ["datos"] (paso intermedio) como en
    // ["datos","edad"] (acceso final) -- si además se notifica el ancestro al cambiar
    // "edad", el mismo efecto se dispara dos veces, y cambiar un campo HERMANO
    // (ej. "nombre", que el efecto nunca leyó) también lo disparaba por error, ya que
    // ambos comparten el mismo ancestro ["datos"].
    const key = pathKey(path);
    if (subscribers.has(key)) {
      // Copiar antes de iterar -- un efecto podría, indirectamente, añadir o quitar
      // suscriptores mientras se ejecuta (ej. un "if" que deja de leer algo).
      Array.from(subscribers.get(key)).forEach((fn) => fn());
    }
  }

  function isWrappable(value) {
    return value !== null && typeof value === 'object';
  }

  function wrap(target, path) {
    if (!isWrappable(target)) return target;
    // Si "target" YA es uno de nuestros propios Proxies reactivos (ej. un elemento que
    // vino de leer un array ya envuelto, y luego se guardó tal cual en un array nuevo
    // vía .slice()/.filter()/.map()/spread), NO volver a envolverlo -- envolver un
    // Proxy sobre otro Proxy rompe la identidad estable (===) entre renders, que es
    // justo de lo que depende el diffing por clave del "for" para reutilizar nodos.
    if (target[REACTIVE_MARKER]) return target;
    if (proxyCache.has(target)) return proxyCache.get(target);

    const proxy = new Proxy(target, {
      get(obj, key) {
        if (key === REACTIVE_MARKER) return true;
        // Los símbolos (ej. Symbol.iterator, usado por el spread y "for...of") pasan
        // directos, sin rastrear ni envolver -- son mecanismo interno de JS, no datos.
        if (typeof key === 'symbol') return obj[key];
        track(path.concat(key));
        return wrap(obj[key], path.concat(key));
      },
      set(obj, key, value) {
        obj[key] = value;
        trigger(path.concat(key));
        return true;
      },
      deleteProperty(obj, key) {
        const existed = key in obj;
        delete obj[key];
        if (existed) trigger(path.concat(key));
        return true;
      },
    });
    proxyCache.set(target, proxy);
    return proxy;
  }

  const store = wrap({ ...initial }, []);

  function effect(fn) {
    const prev = currentEffect;
    currentEffect = fn;
    fn();
    currentEffect = prev;
  }

  return { store, effect };
}


// ---- visuales compilados (cada uno crea su propio estado LOCAL si declara "reactive" interno) ----
function create_paginaDinamica(state, effect, props = {}) {
  const __el0 = document.createElement("div");
  __el0.setAttribute("class", "boton");
  __el0.addEventListener("click", async (event) => {
    var r = await incrementar({ cantidad: 1 })
        state.contadorCliente = r.visitas
  });
  const __el1 = document.createElement("h1");
  const __el2 = document.createTextNode("Ruta dinamica");
  __el1.appendChild(__el2);
  __el0.appendChild(__el1);
  const __el3 = document.createElement("p");
  const __el4 = document.createTextNode("Visitas segun el servidor: ");
  __el3.appendChild(__el4);
  const __el5 = document.createTextNode('');
  effect(() => { __el5.textContent = state.contadorCliente; });
  __el3.appendChild(__el5);
  __el0.appendChild(__el3);
  return __el0;
}



let server = {};
let state, effect;
function __wsGetCsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)wcsrf=([^;]+)/);
  return m ? m[1] : '';
}


// Llama a "post function incrementar" en el servidor -- POST a la URL de esta
// misma ruta.
// Si no se compiló dentro de un sitio con rutas (ej. "build" de un solo archivo), usa
// la URL actual de la página como respaldo.
async function incrementar(args) {
  if (location.protocol === 'file:') {
    throw new Error('"incrementar" necesita un servidor -- abre esta página vía http://, no como archivo local (file://). Usa: node src/cli.js run <carpeta> --serve');
  }
  var __url = "/dinamica";
  return fetch(__url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebScript-CSRF': __wsGetCsrfToken() },
    body: JSON.stringify(args || {}),
  }).then(r => r.json());
}

async function __wsInit() {
  if (location.protocol === 'file:') {
    document.getElementById('app').innerHTML =
      '<div style="font-family: sans-serif; padding: 24px; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; margin: 24px;">' +
      '<strong>Esta página necesita un servidor.</strong><br>Usa <code>server var</code>/<code>post function</code>, ' +
      'así que no funciona abriendo el archivo directamente (protocolo file://). ' +
      'Levanta el servidor con <code>node src/cli.js run &lt;carpeta&gt; --serve</code> y abre ' +
      '<code>http://localhost:3000' + "/dinamica" + '</code> en el navegador.' +
      '</div>';
    return;
  }

  server = await fetch("/dinamica.server-data.json").then(r => r.json());

  let __init_contadorCliente = server.visitas;
  const store = createStore({
  contadorCliente: __init_contadorCliente
  });
  state = store.store;
  effect = store.effect;




  const app = document.getElementById('app');
  app.appendChild(create_paginaDinamica(state, effect, {}));
}

document.addEventListener('DOMContentLoaded', () => { __wsInit(); });
