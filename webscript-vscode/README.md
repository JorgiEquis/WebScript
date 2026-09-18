# WebScript Language Support (VS Code)

Soporte de lenguaje para WebScript (`.wsf`, `.wsb`, `.ws`, `.wson`):

- **Resaltado de sintaxis**: palabras clave (`reactive`, `var`, `const`,
  `style`, `visual`, `watch`, `if`/`else`/`for`, `import`/`export`...),
  tipos (`string`, `number`, `decimal`, `object`, `array`...), `WSON`/
  `Visual` y sus métodos, la flecha `->` de metadata, tags HTML e
  interpolaciones `{}` dentro de `visual`, cadenas, números y comentarios.
- **Descripciones al pasar el ratón** (*hover*): sobre cualquier palabra
  clave del lenguaje (qué hace `watch`, qué es `secret`, qué devuelve
  `WSON.showContent`...) y, si el símbolo está declarado en el propio
  fichero, la línea exacta donde se declaró.
- **Ir a definición** (Ctrl+Click / F12): salta a donde se declaró un
  `reactive`/`var`/`const`/`style`/`visual`/`function` — dentro del mismo
  fichero, o siguiendo un `import { X } from "./otro.wsf"` hasta el
  fichero correcto. Un `import` desde un `.wson` salta al principio de
  ese fichero (el DTO completo es el propio fichero, no una línea suelta
  dentro de él).

## Cómo probarla

**Opción A — modo desarrollo (la más rápida para iterar):**

1. Abre esta carpeta (`webscript-vscode/`) en VS Code.
2. Pulsa `F5` (o "Run and Debug" → "Run Extension"). Se abre una segunda
   ventana de VS Code ("Extension Development Host") con la extensión ya
   cargada.
3. En esa segunda ventana, abre la carpeta `webscript-ejemplo/` (el
   proyecto de ejemplo) y abre `src/app.wsf` o cualquier otro fichero.

**Opción B — instalarla de verdad, empaquetada:**

```bash
npm install -g @vscode/vsce
cd webscript-vscode
vsce package
```

Esto genera un `.vsix`. En VS Code: `Ctrl+Shift+P` → "Extensions: Install
from VSIX..." → selecciona el fichero generado.

## Qué falta (siguiente fase razonable)

- El indexador de símbolos es por regex, línea a línea — no reutiliza el
  compilador real (`webscript-ejemplo/compiler`), así que no valida nada,
  solo ubica declaraciones. Integrarlo con el AST del compilador daría
  diagnósticos reales (errores de tags sin cerrar, colisiones de rutas en
  `WSON.listen()`, etc.) directamente en el editor.
- Sin autocompletado todavía.
- Sin "buscar todas las referencias" (solo ir a la declaración, no al
  revés).
