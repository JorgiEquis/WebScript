// docs.js — WebScript VS Code extension
//
// Documentación mostrada en el hover. Todo lo de aquí describe el
// comportamiento REAL del compilador (verificado contra codegen-server.js,
// codegen-wsdb.js, wson-runtime.js, runtime.js y lib/*.ws) — no es una
// aproximación genérica de "cómo debería funcionar un lenguaje así".

const WSON_METHODS = {
	listen: {
		signature: "WSON.listen(wson)",
		doc: "Registra un punto de entrada de tráfico HTTP. Se asigna a una `reactive`, procesada en su propio `watch()`. No es una función real en ningún runtime — es un patrón que el parser detecta en la propia declaración.",
	},
	send: {
		signature: "WSON.send(instancia)",
		doc: "Envío **SALIENTE** — lo usa quien invoca, en cualquier contexto (`.wsf`, `function`, dentro o fuera de un `watch()` de ruta). Firma con HMAC-SHA256 si hay `secret`, cifra con AES-256-GCM si `encrypt: true`. **Siempre devuelve un WSON** (la respuesta), nunca `undefined`. `to` como array: envío paralelo, fallo aislado por destino. Distinto de `WSON.httpSend()`, que responde la petición entrante.",
	},
	httpSend: {
		signature: "WSON.httpSend(peticion, httpCode?)",
		doc: "Responde la petición HTTP **ENTRANTE** — solo tiene sentido dentro del `watch()` de una ruta (`WSON.listen()`). **No devuelve nada.** `httpCode` es un argumento explícito (200 por defecto) — no una propiedad del WSON.",
	},
	httpParams: {
		signature: "WSON.httpParams(instancia)",
		doc: "Params de ruta (`:id`) de la petición HTTP actual. `null` si la petición no trae params, o si la instancia no viene de una petición HTTP en absoluto.",
	},
	httpQuery: {
		signature: "WSON.httpQuery(instancia)",
		doc: "Query string de la petición HTTP actual. `null` si no hay query string, o si la instancia no viene de una petición HTTP en absoluto.",
	},
	showContent: {
		signature: "WSON.showContent(instancia, secreto)",
		doc: "Descifra el `content` si el WSON venía con `encrypt: true`; si no, parsea el JSON tal cual llegó.",
	},
	enqueue: {
		signature: "WSON.enqueue(instancia, opciones?)",
		doc: "Fire-and-forget a propósito: reintentos con backoff exponencial, *dead letter* silencioso si se agotan. Nunca se espera (queda fuera del \"async/await implícito\").",
	},
	verify: {
		signature: "WSON.verify(content, firma, secreto, marca)",
		doc: "Verifica una firma HMAC-SHA256, con ventana de validez de 5 minutos (`timingSafeEqual`).",
	},
	getSignature: { signature: "WSON.getSignature(headers)", doc: "Lee la cabecera `X-WSON-Signature`." },
	getTimestamp: { signature: "WSON.getTimestamp(headers)", doc: "Lee la cabecera `X-WSON-Timestamp`." },
	getToken: { signature: "WSON.getToken(headers)", doc: "Lee el token `Authorization: Bearer ...`." },
	showToken: {
		signature: "WSON.showToken(token)",
		doc: "Decodifica (**NO** descifra ni verifica) un Bearer/JWT: separa y decodifica en base64url cabecera y payload.",
	},
	parse: {
		signature: "WSON.parse(args, headers, secreto)",
		doc: "Redundante en la práctica: `WSON.listen()` ya hace este mismo trabajo automáticamente sobre cualquier petición entrante.",
	},
};

const VISUAL_METHODS = {
	render: { signature: "Visual.render(visual)", doc: "Monta la plantilla en el DOM. SSR/SSG: el servidor devuelve HTML real desde la primera petición." },
	route: {
		signature: "Visual.route(patron)",
		doc: "Enruta la página actual contra `patron` (con `:params`). Devuelve `{ pattern, matched, params, query }`.",
	},
	params: { signature: "Visual.params(instancia)", doc: "Params de ruta de CLIENTE (la página actual) — distinto de `WSON.httpParams`, que es de una petición de servidor." },
	query: { signature: "Visual.query(instancia)", doc: "Query string de CLIENTE (la página actual) — distinto de `WSON.httpQuery`, que es de servidor." },
	navigate: { signature: "Visual.navigate(ruta)", doc: "Navega a otra ruta del lado cliente, sin recargar la página." },
};

const WSDB_METHODS = {
	save: {
		signature: "<Coleccion>.save(item)",
		doc: "**Método de la interfaz WSDB** (ver `lib/WSDB.ws`). INSERT o UPDATE según exista ya un registro con esa clave primaria. Devuelve una **instancia real** de la colección (encadenable con `.after(fn)`), nunca un objeto plano. Rechaza con un error explícito un `item` que venga de `select()` (proyección parcial).",
	},
	selectAll: {
		signature: "<Coleccion>.selectAll()",
		doc: "**Método de la interfaz WSDB.** `SELECT *`, perezoso (no toca la base hasta usar el resultado). Devuelve instancias reales, usables con `.save()`/`.delete()`. Encadenable: `.where(...)`, `.sortAsc(...)`, `.sortDesc(...)`.",
	},
	select: {
		signature: "<Coleccion>.select(...campos)",
		doc: "**Método de la interfaz WSDB.** Proyección PARCIAL — devuelve JSON plano a propósito (nunca instancias): guardarlo con `.save()` se rechaza, porque pisaría con NULL los campos no seleccionados.",
	},
	delete: {
		signature: "<Coleccion>.delete(item, after?)",
		doc: "**Método de la interfaz WSDB.** Borra por clave primaria. Devuelve un número primitivo (0 o 1) — a propósito, para que `if (...)` siga funcionando. `after` es un parámetro opcional (fire-and-forget), no un `.after()` encadenado.",
	},
	deleteWhere: {
		signature: "<Coleccion>.deleteWhere(condicion, after?)",
		doc: "**Método de la interfaz WSDB.** Borra por condición (misma sintaxis que `.where()`). Sin argumento es un error — vaciar la colección entera exige `deleteWhere(true)` explícito.",
	},
	after: {
		signature: "<instancia>.after(fn)",
		doc: "**Método de la interfaz WSDB**, encadenado tras `save()`. Llama a `fn(instancia)` — fire-and-forget: si `fn` lanza o rechaza, se avisa por consola sin deshacer el `save()`. Devuelve la instancia, así que `.after(a).after(b)` encadena. `fn` puede ser una `function` o una `online function`.",
	},
};

const WSSCHEMA_METHODS = {
	getSchema: {
		signature: "<Coleccion>Schema.getSchema()",
		doc: "**Método de la interfaz WSSchema** (ver `lib/WSSchema.ws`). Devuelve referencias a campo (`{ nombre: 'nombre', edad: 'edad', ... }`) para construir condiciones en `.where()`/`.deleteWhere()`.",
	},
};

const NAMESPACES = {
	WSON: "Mensajería tipada: HTTP entrante/saliente (`WSON.listen`/`WSON.send`/`WSON.httpSend`), firma/cifrado, WebSocket (`online function`/`WSClient`). Ver `lib/WSON.ws`.",
	Visual: "Vista de cliente: montaje, enrutado, SSR/SSG. Ver `lib/Visual.ws`.",
	WSDB: "Interfaz que implementa la clase de datos de cada `.wsdb` (`save`, `selectAll`, `select`, `delete`, `deleteWhere`, `after`). Ver `lib/WSDB.ws`.",
	WSSchema: "Interfaz que implementa la clase `<Nombre>Schema` de cada `.wsdb` v2 (`getSchema`). Ver `lib/WSSchema.ws`.",
	WSClient: "Conexión saliente persistente a otro servidor WebScript (RPC sobre WebSocket a una `online function`), con reconexión y *backoff*.",
};

const KEYWORDS = {
	reactive: {
		signature: "reactive [tipo] nombre = expr",
		doc: "Variable reactiva de nivel superior — dispara su `watch()` propio al reasignarse. Atada a `WSON.listen()` se dispara con cada petición HTTP que encaje con su ruta.",
	},
	global: {
		signature: "global reactive|var|const ...",
		doc: "Una única instancia compartida entre TODAS las sesiones/llamadas — no por visitante. Sin `global`, `reactive`/`var`/`const` de nivel superior son siempre por sesión. Una `function`/`online function` que toca una reactive de sesión sin `global` da un error claro al compilar.",
	},
	watch: {
		signature: "watch(nombre)\\n\\t...",
		doc: "Observa una `reactive` de nivel superior. Se dispara al reasignarla (o, si está atada a `WSON.listen()`, con cada petición HTTP real que encaje). Se espera de verdad (\"async/await implícito\"), aunque no sea la última sentencia.",
	},
	visual: {
		signature: "visual nombre = <html>...</html>",
		doc: "Declara una vista de cliente (`.wsf`). Se renderiza con `Visual.render(nombre)`. La plantilla NO se anida por indentación — se reconoce por las propias etiquetas de apertura/cierre.",
	},
	online: {
		signature: "online function nombre(params)",
		doc: "Expone la función también por RPC sobre WebSocket (registro + protocolo `reflect`/`call`), además de seguir siendo llamable en local como una `function` normal — `online` es puramente aditivo. Admite `-> idempotent`.",
	},
	function: {
		signature: "function nombre(params)",
		doc: "Función de servidor (`.wsb`) o compartida (`.ws`). Compilada siempre como `async` — nunca hace falta escribir `await` para llamarla (\"async/await implícito\").",
	},
	import: {
		signature: 'import { A, B } from "./fichero.ext"',
		doc: "Importa de otro `.ws`/`.wsb`/`.wson`/`.wsdb`/`.json`/paquete de npm. Ctrl+Click sobre el nombre importado va a su declaración; sobre la ruta, abre el fichero.",
	},
	export: {
		signature: "export <declaración>",
		doc: "Marca la declaración como importable desde otro fichero.",
	},
	style: {
		signature: "style nombre = ...",
		doc: "Bloque de estilos de un `.wsf`, con propiedades `-> clave: valor`.",
	},
};

module.exports = { WSON_METHODS, VISUAL_METHODS, WSDB_METHODS, WSSCHEMA_METHODS, NAMESPACES, KEYWORDS };
