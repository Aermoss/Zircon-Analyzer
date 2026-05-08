const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");
const path = require("path");

function activate(context) {
    const serverOptions = {
        command: "python",
        args: [path.join(__dirname, "server.py")]
    };

    const clientOptions = {
        documentSelector: [{ scheme: "file", language: "zircon" }]
    };

    const client = new LanguageClient("zircon", "Zircon", serverOptions, clientOptions);
    context.subscriptions.push(client.start());
}

function deactivate() {}

module.exports = { activate, deactivate };