# WebScript para VS Code

Soporte de lenguaje para WebScript (`.wsf`, `.wsb`, `.ws`, `.wson`, `.wsdb`):

- **Resaltado de sintaxis**: `import`/`export`, `visual`/`style`, `reactive`/`global`/`var`/`const`, `watch(...)`, `function`/`online function`, metadatos `-> clave: valor`, tipos (`string`, `integer`, `decimal`, `boolean`, `object`, `any`), namespaces (`WSON`, `Visual`, `WSDB`, `WSSchema`, `WSClient`), y las etiquetas HTML/interpolación `{expr}` dentro de un `visual`.
- **Información al pasar el ratón** sobre `WSON.*`, `Visual.*`, los métodos de la interfaz WSDB (`save`, `selectAll`, `select`, `delete`, `deleteWhere`, `after`) y `getSchema()`, y sobre palabras clave del lenguaje.
- **Ir a definición (Ctrl+Click / Cmd+Click)**:
  - sobre la ruta de un `import` → abre el fichero;
  - sobre un nombre importado → abre el fichero y salta a su declaración (`function`, `online function`, `reactive`/`var`/`const` exportada, o la línea `-> name:` de un `.wsdb`);
  - sobre `WSON.método` / `Visual.método` → abre `lib/WSON.ws` / `lib/Visual.ws` del proyecto;
  - sobre `<Coleccion>.método` (WSDB) / `getSchema()` → abre `lib/WSDB.ws` / `lib/WSSchema.ws`;
  - sobre una llamada suelta a una `function` → busca su declaración en el propio fichero y, si no está, en el resto del proyecto.

## Probarlo

Abre la carpeta `sample/` de esta misma extensión (`api.wsb` + `saludo.ws`) para ver todo funcionando de inmediato: pasa el ratón sobre `WSON.httpSend`/`WSON.httpParams`, y haz Ctrl+Click sobre `saludar` o sobre `"./saludo.ws"`.

## Cómo importarla

Ver las instrucciones que te dio Claude junto con esta extensión (o `CHANGELOG.md`/la conversación) para las dos formas de cargarla: sin empaquetar (`--extensionDevelopmentPath`) o instalada de verdad (`.vsix` con `vsce`).

## Límites conocidos

- El resaltado es una gramática TextMate (por patrones de texto), no un analizador real — cubre la sintaxis normal, pero no es tan preciso como el propio compilador ante casos raros.
- El hover para métodos de WSDB (`Persona.save(...)`) usa una heurística (receptor con mayúscula inicial + nombre de método conocido) — no resuelve el import de verdad para confirmar que `Persona` es realmente una clase de un `.wsdb`.
- "Ir a definición" para un `.wson` abre el fichero en la línea 0 (un esquema no tiene un nombre propio dentro que buscar).
- Los saltos a `lib/WSON.ws` / `lib/Visual.ws` / `lib/WSDB.ws` / `lib/WSSchema.ws` solo funcionan si esos ficheros existen en el proyecto abierto (los genera `websc init`/`update`).
