# WebScript Language Support (VS Code)

Resaltado de sintaxis, snippets y ayuda contextual (hover) para archivos
`.ws` de WebScript.

## Qué incluye

- **Resaltado de sintaxis** (`syntaxes/webscript.tmLanguage.json`):
  - Palabras clave: `route`, `reactive`, `var`, `style`, `visual`, `render`,
    `server var`, `server function`, `post function`, `import`/`from`,
    `if`/`else`/`else if`, `for`/`in`.
  - Nombres de declaración resaltados como funciones/variables
    (`visual NOMBRE`, `reactive NOMBRE`, etc).
  - Tags HTML (`<div>`, `<Componente />`) y sus atributos.
  - Interpolaciones `{...}`, con anidamiento real (`{ JSON.stringify({a:1}) }`
    resalta bien) y soporte para *template literals* con `${...}` dentro.
  - Bindings `-> style:`, `-> onclick:`, etc, con la clave resaltada aparte
    de la flecha.
  - Comentarios `//` de línea completa.
  - Cadenas (`"`, `'`, `` ` ``) y números.

- **Snippets** (`snippets/webscript.json`): escribe `visual`, `for`, `if`,
  `servervar`, `postfunction`, `import`, etc. y pulsa Tab para expandir la
  plantilla correspondiente.

- **Hover** (`extension.js`): pasa el ratón por encima de cualquier palabra
  clave (`route`, `reactive`, `var`, `style`, `visual`, `server`, `post`,
  `import`, `if`, `for`, `updateServer`...) para ver su firma y una
  descripción de qué hace, directamente en el editor.

## Instalación (modo desarrollo, sin publicar)

**Opción A — copiar a la carpeta de extensiones de VS Code:**

```bash
# macOS / Linux
cp -r webscript-vscode ~/.vscode/extensions/webscript-language-0.1.0

# Windows (PowerShell)
Copy-Item -Recurse webscript-vscode "$env:USERPROFILE\.vscode\extensions\webscript-language-0.1.0"
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
code --install-extension webscript-language-0.1.0.vsix
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
