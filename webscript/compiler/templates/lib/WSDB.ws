// === WSDB — WebScript ===
// Fichero de `lib`, generado por `websc init`.
// El compilador rechaza cualquier modificación sobre este fichero.

interface WSDB
	// La clase <Nombre> de cada .wsdb v2 ("-> name: '<nombre>'") implementa
	// esta interfaz — <Nombre> es la versión con la primera letra en
	// mayúscula del "-> name:" declarado. Solo tiene sentido en servidor
	// (importado desde un .wsb): un .wsdb importado desde un .wsf se
	// rechaza explícitamente.

	constructor(json)
		// Un objeto con los campos del esquema (los que falten, si son
		// opcionales — con "/" —, quedan a null). Valida tipo y longitud
		// de cada uno, igual que un DTO de .wson — y también en cada
		// reasignación posterior (instancia.campo = valor).

	after(fn)
		// Se llama tras save()/delete() con la propia instancia (ya
		// guardada o ya borrada) — fire-and-forget: si fn lanza o
		// rechaza, se avisa por consola y NO deshace ni bloquea la
		// operación, que ya se completó. Devuelve la instancia (no lo
		// que devuelva fn), así que .after(a).after(b) encadena las
		// dos. fn puede ser una function o una online function.

	static save(item)
		// item puede ser una instancia (new <Nombre>(json)) o un objeto
		// plano — save() valida igual en los dos casos, salvo que sea
		// un resultado de select() (ver más abajo), que se rechaza con
		// un error claro. INSERT o UPDATE según exista ya un registro
		// con esa clave primaria (el campo declarado (primary) en el
		// esquema). Devuelve el registro tal como ha quedado guardado,
		// como una instancia real de <Nombre> — no un objeto plano —
		// así que se puede volver a pasar tal cual a otro save()
		// posterior o usar directamente sus getters/setters.
		//
		// Si el .wsdb declara "-> depends: [...]", una actualización (no
		// una inserción) intenta propagarse a cada colección nombrada:
		// busca en ella, por los campos que comparte con esta (mismo
		// nombre y tipo) y sus valores ANTERIORES, el o los registros
		// correspondientes, y les aplica los valores NUEVOS de esos
		// mismos campos — una actualización en cascada simulada, no una
		// clave foránea real. Si la colección nombrada no comparte ningún
		// campo, o la actualización no encuentra ningún registro al que
		// aplicarse, se avisa por consola en vez de fallar el save().

	static selectAll()
	static select(...campos)
		// `campos`: referencias de <Nombre>Schema.getSchema() (ver
		// WSSchema.ws). selectAll() es SELECT * — select() solo esos
		// campos. Las dos devuelven una consulta encadenable:
		//
		//   .where(condición)     — comparaciones (> >= < <= == != === !==),
		//                            && || ! y paréntesis, mezclando campos
		//                            del esquema y valores/variables normales
		//   .sortAsc(campo)        — encadenable entre sí
		//   .sortDesc(campo)
		//
		// La consulta es perezosa: no toca la base de datos hasta que se
		// usa el resultado (su longitud, un índice, recorrerla...) — así
		// que encadenar .where()/.sortAsc()/.sortDesc() antes de usarla
		// no hace ninguna consulta de más.
		//
		// selectAll() (todas las columnas) devuelve un array de
		// instancias reales de <Nombre> — usables tal cual con
		// save()/delete(), igual que si vinieran de new <Nombre>(...).
		// select(...campos) (una proyección PARCIAL) devuelve en cambio
		// un array de objetos JSON planos, deliberadamente NO
		// instancias: a un registro al que le faltan campos no
		// seleccionados no se le puede hacer pasar por completo — si se
		// intenta guardar igualmente con save(), se rechaza con un
		// error claro en vez de sobrescribir esos campos con NULL en
		// silencio.

	static delete(item)
		// Borra un único registro por su clave primaria — item puede ser
		// una instancia o un objeto con ese campo. Devuelve cuántos se
		// han borrado (0 o 1) — un número primitivo, siempre, para que
		// `if (Coleccion.delete(...))` siga significando "se borró
		// algo" de verdad. Por eso NO se encadena con .after() (eso
		// exigiría envolver el número en un objeto, que en JS es
		// siempre "truthy" incluso representando 0): admite en su
		// lugar un segundo argumento opcional, `after(fn)`, con la
		// misma semántica fire-and-forget que el método .after() de
		// arriba — se llama con el número de filas borradas.
		//   Coleccion.delete(item, (n) => { ... })

	static deleteWhere(condicion)
		// Borra todos los registros que cumplan `condicion` (misma
		// sintaxis que where()). Sin argumento es un error — para vaciar
		// la colección entera hay que pedirlo explícitamente:
		// deleteWhere(true). Devuelve cuántos se han borrado. Admite
		// igual que delete() un segundo argumento opcional, `after(fn)`.
