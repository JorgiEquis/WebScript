// serve-demo.js — WebScript, v0
//
// Sirve el bundle de cliente (compilado desde un .wsf) y la API (compilada
// desde un .wsb) en el MISMO servidor — necesario para probar en un
// navegador real sin toparse con CORS. Uso:
//
//   node serve-demo.js <fichero.wsf> <fichero.wsb> [puerto]
//
// Ejemplo:
//   node serve-demo.js ../src/demo-cliente-servidor.wsf ../src/demo-servidor.wsb 3000

const fs = require("fs");
const path = require("path");
const http = require("http");
const { parse } = require("./parser");
const { generateClientBundle } = require("./codegen-client");
const { createRequestHandler } = require("./codegen-server");
const { renderPageToHTML } = require("./codegen-ssr");

const [, , wsfPath, wsbPath, portArg] = process.argv;
if (!wsfPath || !wsbPath) {
	console.error("Uso: node serve-demo.js <fichero.wsf> <fichero.wsb> [puerto]");
	process.exit(1);
}

const port = Number(portArg) || 3000;
const wsfBaseDir = path.dirname(path.resolve(wsfPath));

const clientAst = parse(fs.readFileSync(wsfPath, "utf8"), {});
const bundle = generateClientBundle(clientAst, { baseDir: wsfBaseDir }); // no depende de la petición, se cachea una vez

const serverAst = parse(fs.readFileSync(wsbPath, "utf8"), {});
const apiHandler = createRequestHandler(serverAst, {}, { baseDir: path.dirname(path.resolve(wsbPath)) });

const server = http.createServer((req, res) => {
	if (req.method === "GET" && req.url.split("?")[0] === "/") {
		// SSR real, en cada petición — si la página usa Visual.route() con
		// :params, esto es lo que hace que salga el valor correcto según la
		// URL exacta pedida, no uno precalculado de antes.
		const ssrHtml = renderPageToHTML(clientAst, { baseDir: wsfBaseDir, requestUrl: req.url });
		const html = `<!DOCTYPE html>\n<html lang="es">\n<head><meta charset="UTF-8"><title>WebScript</title></head>\n<body>${ssrHtml}<script>${bundle}</script></body>\n</html>\n`;
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(html);
		return;
	}
	apiHandler(req, res);
});

server.listen(port, () => {
	console.log(`Página + API en http://localhost:${port}/`);
	console.log(`  GET  /            -> la página compilada de ${path.basename(wsfPath)}`);
	console.log(`  resto de rutas    -> la API compilada de ${path.basename(wsbPath)}`);
});
