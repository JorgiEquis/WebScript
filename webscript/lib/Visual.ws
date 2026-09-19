// === Núcleo del lenguaje — WebScript ===
// Fichero de `lib`, generado por `websc init`.
// El compilador rechaza cualquier modificación sobre este fichero.

class Visual
	static render(visual)
		// Renderiza `visual` — en cliente monta el DOM, en servidor genera
		// HTML real (SSR/SSG). Solo puede invocarse una vez por frontal.
		// Sin constructor ni instancias: no hay ningún estado propio de
		// Visual que instanciar, siempre opera sobre lo que le pasas.

	static route(patron)
		// Compara `patron` (con :param opcionales) contra la URL actual
		// del navegador. Se declara al principio del script, sin cuerpo.
		// No es reactivo: si la URL cambia sin recargar, no se entera.
		// Sustituye a useRoute(). Devuelve la instancia que se le pasa a
		// params()/query() — no se usa directamente, se guarda en un const:
		//   const Visual screen = Visual.route('/personas/:id')

	static params(instancia)
		// Params de ruta capturados por :segmentos en el patrón de
		// Visual.route(). const {id} = Visual.params(screen)

	static query(instancia)
		// Query string de la URL actual. const {tab} = Visual.query(screen)
