// === WSSchema — WebScript ===
// Fichero de `lib`, generado por `websc init`.
// El compilador rechaza cualquier modificación sobre este fichero.

interface WSSchema
	// La clase <Nombre>Schema de cada .wsdb v2 ("-> name: '<nombre>'")
	// implementa esta interfaz — <Nombre> es la versión con la primera
	// letra en mayúscula del "-> name:" declarado. No se instancia: solo
	// expone este único método estático.

	static getSchema()
		// Devuelve un objeto { campo: 'campo', ... } — una referencia por
		// cada campo del "-> schema" del .wsdb, en el mismo orden — para
		// usar en select(), where(), sortAsc() y sortDesc() de su WSDB
		// asociada (ver WSDB.ws). Cada valor es el propio nombre del
		// campo, pero como referencia — no como texto suelto — para que
		// el compilador pueda distinguir "está comparando un campo" de
		// "está comparando un valor" dentro de where().
