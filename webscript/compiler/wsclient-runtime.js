// wsclient-runtime.js — WSClient: conexión saliente persistente hacia otro
// servidor WebScript, sobre websocket-runtime.js — con reconexión
// automática (backoff exponencial, igual criterio que WSON.enqueue()) y el
// protocolo de llamada de "online function" (reflect/call — el mismo que
// implementa wireOnlineFunctionsRpc en codegen-server.js).
//
// Decisiones ya cerradas en DISEÑO.md, antes de escribir esto:
// - Ni un plazo agotado ni una conexión perdida certifican si el otro lado
//   llegó a ejecutar la función (problema de los dos generales) — así que
//   NUNCA se reintenta una llamada en curso en automático. Solo la
//   CONEXIÓN se reconecta sola; las llamadas que estuvieran en curso en el
//   momento de la caída se rechazan con un error claro, y es quien llamó
//   quien decide si reintentar — con su propia idempotencyKey si hace
//   falta que sea seguro hacerlo.
// - Una llamada hecha mientras la conexión todavía no está lista (recién
//   creado el WSClient, o a mitad de una reconexión) NO falla al momento:
//   espera, con su propio plazo (el mismo timeoutMs de la llamada, no uno
//   aparte) — así una ráfaga de llamadas justo al arrancar no obliga a
//   quien las hace a manejar un "todavía no" que probablemente se resuelve
//   solo en milisegundos.

const crypto = require("crypto");
const websocket = require("./websocket-runtime");

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_BASE_DELAY_MS = 200;
const MAX_BACKOFF_MS = 30000;

const _pool = new Map(); // urlBase -> WSClient — ver el comentario de create()

class WSClient {
	constructor(urlBase, { baseDelayMs = DEFAULT_BASE_DELAY_MS, headers } = {}) {
		this.urlBase = urlBase;
		this.estaLista = false;
		this._headers = headers;
		this._ws = null;
		this._pending = new Map(); // id -> { resolve, reject, timer, sent }
		this._queued = []; // ids en _pending que no se han mandado todavía (esperando conexión)
		this._baseDelayMs = baseDelayMs;
		this._backoffMs = baseDelayMs;
		this._closed = false;
		this._connect();
	}

	// Cada función generada por `websc client-generate` llama a
	// `WSClient.create(urlBase)` de forma independiente — no hay ningún
	// `const` de módulo compartido al que puedan referirse todas a la vez
	// (ver el comentario en compileFunctionDecl, codegen-server.js: cada
	// función de un .ws se compila aislada de las demás). Así que
	// `create()` hace de fábrica CON MEMORIA: la primera llamada para una
	// URL concreta abre la conexión de verdad; las siguientes, para esa
	// MISMA URL, devuelven la conexión ya abierta — así varias funciones
	// del mismo `OtroServidor.ws` comparten una única conexión persistente
	// en vez de abrir una nueva en cada llamada (que además de
	// desperdiciar la ventaja de una conexión duradera, perdería su
	// backoff de reconexión, reiniciado en cada uso).
	static create(urlBase, opts) {
		let client = _pool.get(urlBase);
		if (!client || client._closed) {
			client = new WSClient(urlBase, opts);
			_pool.set(urlBase, client);
		}
		return client;
	}

	// Cierra TODAS las conexiones salientes abiertas por WSClient.create()
	// en este proceso. Para un apagado ordenado de un servidor real (nada
	// llama a esto automáticamente al reiniciar) y para tests: cada
	// función generada por `websc client-generate` abre su conexión vía
	// create() y la deja memorizada para siempre en el pool — algo
	// correcto en un servidor real de larga vida, pero que en un proceso
	// de corta vida (como un test) deja sockets abiertos que nadie más
	// cierra si no se llama a esto explícitamente.
	static closeAll() {
		for (const client of _pool.values()) client.close();
		_pool.clear();
	}

	_connect() {
		if (this._closed) return;
		websocket
			.connect(this.urlBase, { headers: this._headers })
			.then((ws) => {
				if (this._closed) {
					ws.socket.end();
					return;
				}
				this._ws = ws;
				this.estaLista = true;
				this._backoffMs = this._baseDelayMs; // se reinicia tras una conexión con éxito
				ws.parser.on("message", (msg) => this._onMessage(msg));
				ws.parser.on("close", () => this._onDisconnect());
				ws.parser.on("error", () => {}); // el cierre (arriba) llega igual — esto solo evita que un error sin escuchar sea ruidoso
				this._flushQueue();
			})
			.catch(() => this._scheduleReconnect());
	}

	_flushQueue() {
		const queued = this._queued;
		this._queued = [];
		for (const { id, payload } of queued) {
			const p = this._pending.get(id);
			if (!p) continue; // pudo cancelarse por timeout mientras esperaba en cola
			p.sent = true; // a partir de aquí, si la conexión cae, SÍ cuenta como "en curso" (ver _onDisconnect)
			this._ws.send(JSON.stringify(payload));
		}
	}

	_scheduleReconnect() {
		if (this._closed) return;
		this.estaLista = false;
		setTimeout(() => this._connect(), this._backoffMs);
		this._backoffMs = Math.min(this._backoffMs * 2, MAX_BACKOFF_MS);
	}

	_onDisconnect() {
		this.estaLista = false;
		this._ws = null;
		// Ver el comentario de cabecera: ninguna llamada YA MANDADA puede
		// reintentarse sola. Las que seguían en cola (nunca llegaron a
		// mandarse) sí seguirán esperando la reconexión con normalidad —
		// para esas, "conexión perdida" no aplica, porque nunca llegaron a
		// viajar por ninguna conexión.
		for (const [id, p] of this._pending) {
			if (!p.sent) continue;
			clearTimeout(p.timer);
			this._pending.delete(id);
			p.reject(new Error("WSClient: conexión perdida a mitad de la llamada — no se sabe si el otro lado llegó a ejecutarla"));
		}
		this._scheduleReconnect();
	}

	_onMessage(msg) {
		if (msg.opcode !== websocket.OPCODE.TEXT) return;
		let data;
		try {
			data = JSON.parse(msg.text);
		} catch {
			return; // un mensaje no-JSON del otro lado se ignora, no rompe la conexión
		}
		const id = data.type === "reflect" ? "__reflect__" : data.id;
		const p = this._pending.get(id);
		if (!p) return;
		clearTimeout(p.timer);
		this._pending.delete(id);
		if (data.type === "error") p.reject(new Error(data.message));
		else if (data.type === "reflect") p.resolve(data.functions);
		else p.resolve(data.value);
	}

	// Pide al servidor remoto la lista de sus `online function` — nombre,
	// parámetros, si son idempotent. Es la base de `websc client-generate`
	// (todavía por construir): generar el cliente a partir de esto, en vez
	// de que alguien copie la firma a mano.
	reflect({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
		return this._request("__reflect__", { type: "reflect" }, timeoutMs);
	}

	llamar(name, args, { idempotencyKey, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
		const id = crypto.randomUUID();
		return this._request(id, { type: "call", id, name, args, idempotencyKey }, timeoutMs);
	}

	_request(id, payload, timeoutMs) {
		return new Promise((resolve, reject) => {
			const entry = { resolve, reject, sent: this.estaLista, timer: null };
			entry.timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new Error(`WSClient: sin respuesta en ${timeoutMs}ms — no se sabe si se llegó a ejecutar`));
			}, timeoutMs);
			this._pending.set(id, entry);
			if (this.estaLista) {
				this._ws.send(JSON.stringify(payload));
			} else {
				this._queued.push({ id, payload });
			}
		});
	}

	// Cierra la conexión de verdad y deja de reintentar — para apagar el
	// cliente de forma ordenada (no para un fallo pasajero, para eso ya
	// está la reconexión sola).
	close() {
		this._closed = true;
		if (_pool.get(this.urlBase) === this) _pool.delete(this.urlBase);
		if (this._ws) this._ws.socket.end();
		for (const [id, p] of this._pending) {
			clearTimeout(p.timer);
			p.reject(new Error("WSClient: cerrado mientras la llamada seguía pendiente"));
		}
		this._pending.clear();
	}
}

module.exports = { WSClient };
