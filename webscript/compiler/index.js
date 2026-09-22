// index.js — API pública del paquete, para quien haga `require("websc")` en
// vez de (o además de) usar el CLI `websc`.

const { parse } = require("./parser");
const { classifyWsf } = require("./codegen");
const { generateClientBundle } = require("./codegen-client");
const { createServer, createRequestHandler } = require("./codegen-server");
const { buildDtoClass } = require("./codegen-dto");
const { renderPageToHTML } = require("./codegen-ssr");

module.exports = {
	parse,
	classifyWsf,
	generateClientBundle,
	createServer,
	createRequestHandler,
	buildDtoClass,
	renderPageToHTML,
};
