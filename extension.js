const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");
const path = require("path");

function activate(context) {
    const serverOptions = {
        command: "python",
        args: [path.join(__dirname, "server.py")]
    };

    const outputChannel = vscode.window.createOutputChannel("Zircon Analyzer");

    const clientOptions = {
        documentSelector: [{ scheme: "file", language: "zircon" }],
        outputChannel: outputChannel
    };

    const client = new LanguageClient("zircon-analyzer", "Zircon Analyzer", serverOptions, clientOptions);
    context.subscriptions.push(client.start());
}

function deactivate() {}

module.exports = { activate, deactivate };