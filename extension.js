const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");
const path = require("path");

function activate(context) {
    const serverModule = path.join(__dirname, "server.py");

    const serverOptions = {
        command: "python",
        args: [serverModule]
    };

    const clientOptions = {
        documentSelector: [{ scheme: "file", language: "divine" }]
    };

    const client = new LanguageClient("divineLanguageServer", "Divine Language Server", serverOptions, clientOptions);
    context.subscriptions.push(client.start());
}

function deactivate() {}

module.exports = { activate, deactivate };