// extension.js — WebScript VS Code extension
const vscode = require("vscode");
const { provideHover } = require("./hover");
const { provideDefinition } = require("./definition");

const SELECTOR = { language: "webscript" };

function activate(context) {
	context.subscriptions.push(vscode.languages.registerHoverProvider(SELECTOR, { provideHover }));
	context.subscriptions.push(vscode.languages.registerDefinitionProvider(SELECTOR, { provideDefinition }));
}

function deactivate() {}

module.exports = { activate, deactivate };
