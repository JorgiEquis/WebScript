// extension.js — WebScript Language Support, v0
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const { buildIndex, parseImports } = require("./symbolIndex");
const { KEYWORD_DOCS } = require("./docs");

const SELECTOR = { language: "webscript" };
const WORD_RE = /[\w.]+/;

function resolveImportPath(fromDir, importPath) {
	const candidates = [importPath, importPath + ".wsf", importPath + ".wsb", importPath + ".ws", importPath + ".wson"];
	for (const c of candidates) {
		const full = path.resolve(fromDir, c);
		if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
	}
	return null;
}

function activate(context) {
	context.subscriptions.push(
		vscode.languages.registerHoverProvider(SELECTOR, {
			provideHover(document, position) {
				const range = document.getWordRangeAtPosition(position, WORD_RE);
				if (!range) return;

				const word = document.getText(range);
				const simple = word.split(".").pop();

				const doc = KEYWORD_DOCS[word] || KEYWORD_DOCS[simple];
				const local = buildIndex(document.getText()).find((s) => s.name === simple);

				if (!doc && !local) return;

				const md = new vscode.MarkdownString();
				if (doc) md.appendMarkdown(doc);
				if (doc && local) md.appendMarkdown("\n\n---\n\n");
				if (local) md.appendMarkdown(`**Declarado en esta línea (${local.line + 1}):**\n\n\`\`\`\n${local.raw.trim()}\n\`\`\``);

				return new vscode.Hover(md, range);
			},
		})
	);

	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider(SELECTOR, {
			provideDefinition(document, position) {
				const range = document.getWordRangeAtPosition(position, WORD_RE);
				if (!range) return null;

				const word = document.getText(range).split(".").pop();
				const text = document.getText();

				// 1. ¿Está declarado en este mismo fichero?
				const local = buildIndex(text).find((s) => s.name === word);
				if (local) {
					return new vscode.Location(document.uri, new vscode.Position(local.line, local.character));
				}

				// 2. ¿Viene de un import? Resolver el fichero y buscar ahí.
				const imports = parseImports(text);
				const fromImport = imports.find((imp) => imp.names.includes(word));
				if (!fromImport) return null;

				const fromDir = path.dirname(document.uri.fsPath);
				const targetPath = resolveImportPath(fromDir, fromImport.path);
				if (!targetPath) return null;

				if (targetPath.endsWith(".wson")) {
					// Un .wson no tiene dentro una línea "class NombreDTO" — el
					// DTO completo ES el fichero, así que apunta al principio.
					return new vscode.Location(vscode.Uri.file(targetPath), new vscode.Position(0, 0));
				}

				const targetText = fs.readFileSync(targetPath, "utf8");
				const targetSymbol = buildIndex(targetText).find((s) => s.name === word);

				return new vscode.Location(
					vscode.Uri.file(targetPath),
					targetSymbol ? new vscode.Position(targetSymbol.line, targetSymbol.character) : new vscode.Position(0, 0)
				);
			},
		})
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
