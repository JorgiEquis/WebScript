// === Núcleo del lenguaje — WebScript ===
// Fichero de `lib`, generado por `websc init`.
// El compilador rechaza cualquier modificación sobre este fichero.

class WSON
	// Campos: from, to, via, content, secret, encrypt, id, createdAt,
	// authorization

	static listen(wson)
		// Registra un punto de entrada de tráfico. Se asigna a una
		// `reactive`, procesada en su propio watch().

	static send(instancia)
		// Envío SALIENTE — lo usa quien invoca (un .wsf hablando con
		// cualquier backend, o un .wsb/function hablando con otro sistema).
		// Firma con HMAC-SHA256 si hay `secret`, cifra con AES-256-GCM si
		// `encrypt: true`. Autogenera `id`/`createdAt` (UUID) antes de
		// cifrar si no vienen informados. Devuelve un array de resultados
		// si `to` es un array de destinos. Si hay `authorization`, viaja
		// tal cual como cabecera Authorization (permitido también en
		// cliente, a diferencia de `secret`/`encrypt`). Siempre devuelve un
		// WSON — nunca `undefined`, para que su resultado se pueda
		// encadenar como cualquier otro valor.

	static httpSend(peticion, httpCode)
		// Responde una petición HTTP ENTRANTE — lo usa quien fue invocado,
		// dentro del watch() de una ruta (WSON.listen()). No devuelve nada.
		// `httpCode` es un argumento explícito (por defecto 200) — no una
		// propiedad del WSON. Distinto de `send()`: uno contesta, el otro
		// llama — nunca la misma llamada sirve para las dos cosas.

	static enqueue(instancia)
		// Fire-and-forget: reintentos con backoff exponencial,
		// dead letter si se agotan.

	static verify(content, firma, secreto, marca)
	static showContent(content, secreto)
	static getSignature(headers)
	static getTimestamp(headers)
	static getToken(headers)
	static showToken(token)
		// Decodifica (NO descifra) un Bearer/JWT: separa y decodifica en
		// base64url cabecera y payload para ver sus claims. No requiere
		// secreto porque un JWT normal no está cifrado, solo codificado y
		// firmado. No verifica nada — decodificar no es lo mismo que
		// confiar en el contenido; verificar la firma queda pendiente.
	static parse(args, headers, secreto)

	static httpQuery(instancia)
	static httpParams(instancia)
		// Query string / params de ruta de la petición HTTP actual. `null`
		// si la petición no tiene params/query, o si la instancia no viene
		// de una petición HTTP en absoluto (p. ej. algo recibido por una
		// online function, o un WSON construido a mano) — nunca `{}` ni
		// un valor que reviente al desestructurar.

	// get/set <campo>() — respeta el esquema si el WSON es un DTO
	// generado desde un .wson. Toda la API es estática: nunca
	// instancia.metodo(), siempre WSON.metodo(instancia, ...).
