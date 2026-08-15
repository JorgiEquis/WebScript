#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseProgram } = require('./parser');
const { compile, usesServerData } = require('./compiler');
const { buildSite, buildSingleFileAsSite, serveSite, startServer } = require('./site-builder');
const { renderRouteToHtml, injectIntoShell } = require('./ssr-renderer');

function build(inputFile, outDir) {
  const source = fs.readFileSync(inputFile, 'utf8');
  const ast = parseProgram(source, path.resolve(inputFile));

  const hasRender = ast.body.some(n => n.type === 'RenderCall');

  // Sin render(): archivo "solo backend" -- ni HTML, ni CSS, ni bundle.js, solo
  // server.js (si tiene algo de servidor). Mismo criterio que "site"/"run".
  if (!hasRender) {
    const { server } = compile(ast, { routePath: '/' });
    fs.mkdirSync(outDir, { recursive: true });
    if (server) {
      fs.writeFileSync(path.join(outDir, 'index.server.js'), server);
      console.log(`✔ Compilado "${inputFile}" -> ${outDir}/ (index.server.js -- sin render(), no se generó HTML/CSS/JS)`);
    } else {
      console.log(`✔ Compilado "${inputFile}" -- sin render() y sin nada de servidor, no se generó ningún archivo.`);
    }
    return;
  }

  // Si el archivo usa server.NOMBRE, el bundle necesita el mismo montaje "async +
  // fetch" que usa "site"/"run" -- si no, "server" ni siquiera queda declarado en
  // el bundle y revienta con ReferenceError al cargar.
  const dynamic = usesServerData(ast);
  const { html, css, js, server } = compile(ast, {
    serverDataUrl: dynamic ? '/index.server-data.json' : null,
    routePath: '/',
  });

  // SSG (solo si NO es dinámica -- ver src/ssr-renderer.js para el porqué)
  let finalHtml = html;
  if (!dynamic) {
    const ssr = renderRouteToHtml(ast);
    if (ssr.ok) finalHtml = injectIntoShell(html, ssr.html);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), finalHtml);
  fs.writeFileSync(path.join(outDir, 'styles.css'), css);
  fs.writeFileSync(path.join(outDir, 'bundle.js'), js);

  const files = ['index.html', 'styles.css', 'bundle.js'];
  if (server) {
    fs.writeFileSync(path.join(outDir, 'index.server.js'), server);
    files.push('index.server.js (variables de servidor -- NO se sirve al navegador)');
  }
  if (dynamic) {
    console.log(`  (usa server.X -- necesita servirse por HTTP: "node src/cli.js run ${inputFile} --serve", no abrir el .html directamente)`);
  }

  console.log(`✔ Compilado "${inputFile}" -> ${outDir}/ (${files.join(', ')})`);
}

function site(srcDir, outDir) {
  const { table, skipped } = buildSite(srcDir, outDir);
  printTable(table, skipped, outDir);
}

function printTable(table, skipped, outDir) {
  if (skipped.length > 0) {
    console.log('Omitidos (sin route(...)):');
    skipped.forEach(f => console.log(`  - ${f}`));
    console.log();
  }

  console.log(`✔ Construido en ${outDir}/ -- ${table.length} ruta(s):`);
  const maxRouteLen = Math.max(...table.map(r => r.route.length), 5);
  for (const r of table) {
    const serverTag = r.hasServer ? '  (+server.js)' : '';
    const target = r.apiOnly ? '(solo backend, sin página)' : `${outDir}/${r.html}`;
    console.log(`  ${r.route.padEnd(maxRouteLen)}  ->  ${target}  (${r.file})${serverTag}`);
  }
}

// Comando "todo en uno": detecta solo si `target` es un archivo o un directorio y hace
// lo que corresponda -- compilar un directorio entero (varias rutas, cada .ws declara
// su route(...)) o un solo archivo (siempre servido en "/", como "build"). Con --serve
// además levanta un servidor Node real en el puerto indicado (por defecto 3000).
function run(target, outDir, { serve, port }) {
  const stat = fs.statSync(target);

  if (stat.isDirectory()) {
    if (serve) {
      serveSite(target, outDir, port);
      return;
    }
    const { table, skipped } = buildSite(target, outDir);
    printTable(table, skipped, outDir);
    return;
  }

  const { table } = buildSingleFileAsSite(target, outDir);
  if (serve) {
    startServer(table, outDir, port);
    return;
  }
  printTable(table, [], outDir);
}

function main() {
  const [, , cmd, target] = process.argv;
  const outFlagIndex = process.argv.indexOf('--out');
  const outDir = path.resolve(process.cwd(), outFlagIndex !== -1 ? process.argv[outFlagIndex + 1] : 'dist');

  if (cmd === 'build' && target) {
    build(target, outDir);
  } else if (cmd === 'site' && target) {
    site(path.resolve(process.cwd(), target), outDir);
  } else if (cmd === 'serve' && target) {
    const portFlagIndex = process.argv.indexOf('--port');
    const port = portFlagIndex !== -1 ? parseInt(process.argv[portFlagIndex + 1], 10) : 3000;
    serveSite(path.resolve(process.cwd(), target), outDir, port);
  } else if (cmd === 'run' && target) {
    const portFlagIndex = process.argv.indexOf('--port');
    const port = portFlagIndex !== -1 ? parseInt(process.argv[portFlagIndex + 1], 10) : 3000;
    const serve = process.argv.includes('--serve');
    run(path.resolve(process.cwd(), target), outDir, { serve, port });
  } else {
    console.log('Uso:');
    console.log('  node src/cli.js build <archivo.ws> [--out dist]');
    console.log('  node src/cli.js site <directorio-src> [--out dist]');
    console.log('  node src/cli.js serve <directorio-src> [--out dist] [--port 3000]');
    console.log('  node src/cli.js run <archivo.ws | directorio-src> [--out dist] [--serve] [--port 3000]');
    process.exit(1);
  }
}

main();

