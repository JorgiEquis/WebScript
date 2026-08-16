# WebScript Language Support (VS Code)

Resaltado de sintaxis, snippets y ayuda contextual (hover) para archivos
`.ws` de WebScript.

## Qué incluye

- **Icono de archivo** (`icons/ws-icon.svg`/`ws-icon-light.svg`): un
  monograma "WS" morado (`#7c3aed`, el mismo color usado en varios
  ejemplos del propio proyecto), con variante clara y oscura según el
  tema de VS Code — igual que hacen los archivos `.js`/`.ts`. Aparece en
  el explorador de archivos y en las pestañas sin necesitar instalar un
  tema de iconos completo. También sirve como icono de la propia
  extensión en el *marketplace*.

- **Resaltado de sintaxis** (`syntaxes/webscript.tmLanguage.json`):
  - Palabras clave: `route`, `reactive`, `var`, `function`, `style`,
    `visual`, `render`, `server var`, `server reactive`, `server wson`,
    `server function`, `watch`, `get`/`post`/`put`/`delete function`,
    `http`, `whisper`, `WSON`, `wson`, `import`/`from`, `if`/`else`/`else if`, `for`/`in`/`by`.
  - Anotaciones de tipo opcionales (`reactive number x`/`var string y`)
    resaltadas aparte.
  - Nombres de declaración resaltados como funciones/variables
    (`visual NOMBRE`, `reactive NOMBRE`, etc).
  - Tags HTML (`<div>`, `<Componente />`) y sus atributos, incluyendo
    atributos en línea (`onclick={código}`, `class={expr}`) en
    **cualquier** nodo de la plantilla, no solo la raíz.
  - Interpolaciones `{...}`, con anidamiento real (`{ JSON.stringify({a:1}) }`
    resalta bien) y soporte para *template literals* con `${...}` dentro.
  - Bloques `-> propiedad: valor` de `style`/`wson` (`from`/`to`/`via`/
    `content`), con la clave resaltada aparte de la flecha.
  - Comentarios `//` de línea completa.
  - Cadenas (`"`, `'`, backtick) y números.

- **Snippets** (`snippets/webscript.json`): escribe `visual`, `visualb`,
  `for`, `forby`, `if`, `servervar`, `serverreactive`, `watch`, `wson`,
  `serverwson`, `wsonsend`, `postfunction`, `getfunction`,
  `httpget`/`httppost`/`httpput`/`httpdelete`, `whisper`, `import`, etc.
  y pulsa Tab para expandir la plantilla correspondiente.

- **Hover** (`extension.js`): pasa el ratón por encima de cualquier
  palabra clave (`route`, `reactive`, `var`, `function`, `style`,
  `visual`, `server`, `watch`, `wson`, `WSON`, `get`/`post`/`put`/`delete`,
  `http`, `whisper`, `import`, `if`, `for`, `by`, `onclick`/cualquier
  `onXXX`...) para ver su firma y una descripción de qué hace,
  directamente en el editor.

## Instalación (modo desarrollo, sin publicar)

**Opción A — copiar a la carpeta de extensiones de VS Code:**

```bash
# macOS / Linux
cp -r webscript-vscode ~/.vscode/extensions/webscript-language-0.2.0

# Windows (PowerShell)
Copy-Item -Recurse webscript-vscode "$env:USERPROFILE\.vscode\extensions\webscript-language-0.2.0"
```

Reinicia VS Code (o `Developer: Reload Window` desde la paleta de comandos)
y abre cualquier archivo `.ws`.

**Opción B — modo "Extension Development Host" (para ir iterando):**

1. Abre la carpeta `webscript-vscode/` en VS Code.
2. Pulsa `F5` (o "Run > Start Debugging"). Se abre una segunda ventana de
   VS Code con la extensión cargada.
3. Abre cualquier `.ws` en esa segunda ventana.

**Opción C — empaquetar como `.vsix` e instalarlo:**

```bash
npm install -g @vscode/vsce
cd webscript-vscode
vsce package
code --install-extension webscript-language-0.2.0.vsix
```

## Notas

- El compilador de WebScript ahora sí soporta comentarios `//` (de línea
  completa, tanto entre declaraciones como dentro de una plantilla) — se
  añadió expresamente para que esta extensión no mintiera resaltando algo
  que el compilador no entendería.
- El resaltado del contenido dentro de `{...}` es aproximado (reconoce
  cadenas, números, unas pocas palabras clave y nombres de función), no un
  parser de JS completo — para expresiones muy complejas puede no colorear
  cada pieza con precisión, pero no rompe nada.
- `updateServer` existió y se quitó (unificado con `post function`) —
  esta extensión ya no lo menciona en ningún sitio, para no documentar
  algo que el compilador rechaza.
