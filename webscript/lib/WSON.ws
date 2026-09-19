// === Núcleo del lenguaje — WebScript ===
// Fichero de `lib`, generado por `websc init`.
// El compilador rechaza cualquier modificación sobre este fichero.

class WSON
	// Campos: from, to, via, content, secret, encrypt, id, createdAt,
	// httpCode, authorization

	static listen(wson)
		// Registra un punto de entrada de tráfico. Se asigna a una
		// `reactive`, procesada en su propio watch().

	static send(instancia)
		// Firma con HMAC-SHA256 si hay `secret`, cifra con AES-256-GCM si
		// `encrypt: true`. Autogenera `id`/`createdAt` (UUID) antes de
		// cifrar si no vienen informados. Devuelve un array de resultados
		// si `to` es un array de destinos. Si hay `authorization`, viaja
		// tal cual como cabecera Authorization (permitido también en
		// cliente, a diferencia de `secret`/`encrypt`).

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

	static query(instancia)
	static params(instancia)

	// get/set <campo>() — respeta el esquema si el WSON es un DTO
	// generado desde un .wson. Toda la API es estática: nunca
	// instancia.metodo(), siempre WSON.metodo(instancia, ...).
