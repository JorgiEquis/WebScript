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

	static navigate(url, opciones)
		// Navega sin recargar la página (SPA) — history.pushState() (o
		// replaceState() con { replace: true }). Lo que dependa de
		// Visual.route()/params()/query() se actualiza solo, sin que haga
		// falta recargar. No intercepta clics en <a> automáticamente —
		// hay que llamarlo explícitamente (p. ej. desde un onclick).

	static staticPaths(instancia, valores)
		// Solo tiene efecto en páginas con :params en su Visual.route().
		// Mismo criterio que params()/query(): la instancia de
		// Visual.route() como primer argumento. `valores` es un array de
		// objetos YA RESUELTO en tiempo de compilación — uno por cada
		// combinación de :params a pre-renderizar como .html real,
		// típicamente importado de un .json (import posts from
		// "./posts.json"), aunque puede ser cualquier const/var de nivel
		// superior cuyo valor no dependa de ninguna petición real. Al ser
		// ya un valor resuelto, no hace falta escribir ninguna lógica
		// aparte ni esperar nada. La ruta dinámica sigue registrada como
		// respaldo, por si se visita una combinación que no estaba en la
		// lista.
		//   const Visual screen = Visual.route('/blog/:slug')
		//   import posts from "./posts.json"
		//   Visual.staticPaths(screen, posts)
