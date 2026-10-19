import * as vscode from "vscode";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const HOVER_MAP: Record<string, string> = {
    bool: "Boolean value", char: "32-bit Unicode scalar value",
    i8: "8-bit signed integer", i16: "16-bit signed integer", i32: "32-bit signed integer",
    i64: "64-bit signed integer", i128: "128-bit signed integer", isize: "Pointer-sized signed integer",
    u8: "8-bit unsigned integer", u16: "16-bit unsigned integer", u32: "32-bit unsigned integer",
    u64: "64-bit unsigned integer", u128: "128-bit unsigned integer", usize: "Pointer-sized unsigned integer",
    f32: "32-bit floating-point number", f64: "64-bit floating-point number"
};

const KEYWORDS = [
    "if", "else", "for", "while", "loop", "match", "return", "break", "continue",
    "let", "mut", "const", "volatile", "fn", "class", "struct", "enum", "extend", "type",
    "extern", "asm", "async", "await", "static", "pub", "as", "operator", "new", "delete",
    "in", "include", "this"
];
const TYPES = ["void", "bool", "char", "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64"];
const CONSTANTS = ["true", "false", "null"];
const DIAGNOSTIC_PATTERN = /^(.*):(\d+):(\d+): (Error|Warning): (.+)$/;
const ANSI_ESCAPE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function executableFile(name: string): boolean {
    try {
        return fs.statSync(name).isFile();
    } catch {
        return false;
    }
}

function findCompiler(): string | undefined {
    const config = vscode.workspace.getConfiguration("zircon");
    const configured = config.get<string>("compilerPath");
    const candidates = [configured];
    const executableNames = process.platform === "win32" ? ["zirconc.exe", "zirconc"] : ["zirconc", "zirconc.exe"];

    for (const entry of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
        for (const name of executableNames) candidates.push(path.join(entry, name));
    }

    return candidates.find(candidate => candidate && executableFile(candidate));
}

function includePath(compilerPath: string): string | undefined {
    const configured = vscode.workspace.getConfiguration("zircon").get<string>("includePath");
    if (configured) return configured;
    const candidate = path.resolve(path.dirname(compilerPath), "..", "include");
    return fs.existsSync(candidate) ? candidate : undefined;
}

function maskNonCode(source: string): string {
    const mask = (value: string): string => value.replace(/[^\r\n]/g, " ");
    return source
        .replace(/"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/g, mask)
        .replace(/\/\*[\s\S]*?\*\//g, mask)
        .replace(/\/\/[^\r\n]*/g, mask);
}

function positionAt(source: string, offset: number): vscode.Position {
    const before = source.slice(0, offset);
    const lines = before.split(/\r\n|\r|\n/);
    return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}

type DeclarationKind = "fn" | "class" | "struct" | "enum" | "extend" | "type" | "const" | "static";

function indexDefinitions(uri: vscode.Uri, source: string): Map<string, vscode.Location[]> {
    const code = maskNonCode(source);
    const declarationPattern = /\b(?:fn|class|struct|enum|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    const definitions = new Map<string, vscode.Location[]>();
    let match: RegExpExecArray | null;

    while ((match = declarationPattern.exec(code)) !== null) {
        const nameOffset = match.index + match[0].lastIndexOf(match[1]);
        const position = positionAt(source, nameOffset);
        const range = new vscode.Range(position, position.translate(0, match[1].length));
        const locations = definitions.get(match[1]) || [];
        locations.push(new vscode.Location(uri, range));
        definitions.set(match[1], locations);
    }

    return definitions;
}

function makeCompletion(label: string, kind: vscode.CompletionItemKind, detail: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(label, kind);
    item.detail = detail;
    item.documentation = new vscode.MarkdownString(HOVER_MAP[label] || label);
    return item;
}

function documentSymbolKind(kind: DeclarationKind): vscode.SymbolKind {
    switch (kind) {
        case "fn": return vscode.SymbolKind.Function;
        case "class": return vscode.SymbolKind.Class;
        case "struct": return vscode.SymbolKind.Struct;
        case "enum": return vscode.SymbolKind.Enum;
        case "extend": return vscode.SymbolKind.Interface;
        case "const":
        case "static": return vscode.SymbolKind.Constant;
        case "type": return vscode.SymbolKind.TypeParameter;
    }
}

function parseDiagnostics(output: string, document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics = [];
    const sourcePath = path.resolve(document.uri.fsPath).toLowerCase();
    for (const line of output.replace(ANSI_ESCAPE, "").split(/\r?\n/)) {
        const match = DIAGNOSTIC_PATTERN.exec(line);
        if (!match || path.resolve(match[1]).toLowerCase() !== sourcePath) continue;
        const lineNumber = Number(match[2]) - 1;
        const character = Number(match[3]) - 1;
        if (lineNumber < 0 || character < 0) continue;
        if (lineNumber >= document.lineCount) continue;
        const text = document.lineAt(lineNumber).text;
        let endCharacter = Math.min(character + 1, text.length);
        while (endCharacter < text.length && /[A-Za-z0-9_]/.test(text[endCharacter])) endCharacter++;
        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(lineNumber, character, lineNumber, Math.max(character + 1, endCharacter)),
            match[5].trim(),
            match[4] === "Error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = "zirconc";
        diagnostics.push(diagnostic);
    }
    return diagnostics;
}

export function activate(context: vscode.ExtensionContext): void {
    const diagnostics = vscode.languages.createDiagnosticCollection("zircon");
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const generations = new Map<string, number>();
    let definitionIndex: Map<string, vscode.Location[]> | undefined;
    let definitionIndexRevision = 0;
    let definitionIndexBuild: Promise<Map<string, vscode.Location[]>> | undefined;
    let lastReportedCompilerIssue: string | undefined;

    function reportCompilerIssue(key: string, message: string): void {
        if (lastReportedCompilerIssue === key) return;
        lastReportedCompilerIssue = key;
        void vscode.window.showErrorMessage(message);
    }

    const selector = { scheme: "file", language: "zircon" };
    context.subscriptions.push(diagnostics, {
        dispose() {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        }
    });

    function invalidateDefinitionIndex(): void {
        definitionIndexRevision++;
        definitionIndex = undefined;
    }

    async function getDefinitionIndex(): Promise<Map<string, vscode.Location[]>> {
        if (definitionIndex) return definitionIndex;
        if (definitionIndexBuild) return definitionIndexBuild;

        const buildRevision = definitionIndexRevision;
        definitionIndexBuild = (async () => {
            const uris = new Map<string, vscode.Uri>();
            const excludedDirectories = "{**/.claude/**,**/.git/**,**/node_modules/**}";
            for (const uri of await vscode.workspace.findFiles("**/*.zir", excludedDirectories)) uris.set(uri.toString(), uri);

            const compiler = findCompiler();
            const includes = compiler && includePath(compiler);
            if (includes) {
                const includeUri = vscode.Uri.file(includes);
                for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(includeUri, "**/*.zir"), excludedDirectories)) {
                    uris.set(uri.toString(), uri);
                }
            }

            const index = new Map<string, vscode.Location[]>();
            const openDocuments = new Map(vscode.workspace.textDocuments.map(document => [document.uri.toString(), document]));
            for (const uri of uris.values()) {
                const openDocument = openDocuments.get(uri.toString());
                let source: string;
                try {
                    source = openDocument
                        ? openDocument.getText()
                        : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
                } catch {
                    continue;
                }
                for (const [name, locations] of indexDefinitions(uri, source)) {
                    const existing = index.get(name) || [];
                    existing.push(...locations);
                    index.set(name, existing);
                }
            }

            if (definitionIndexRevision === buildRevision) definitionIndex = index;
            return index;
        })().finally(() => {
            definitionIndexBuild = undefined;
        });

        return definitionIndexBuild;
    }

    context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
        provideHover(document, position) {
            const word = document.getText(document.getWordRangeAtPosition(position));
            const description = HOVER_MAP[word];
            return description ? new vscode.Hover(new vscode.MarkdownString(description)) : undefined;
        }
    }));

    context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
        async provideDefinition(document, position) {
            const wordRange = document.getWordRangeAtPosition(position);
            if (!wordRange) return undefined;
            const name = document.getText(wordRange);
            const definitions = await getDefinitionIndex();
            const matches = definitions.get(name) || [];
            const currentFileDefinitions = indexDefinitions(document.uri, document.getText()).get(name) || [];
            const currentUri = document.uri.toString();
            const locations = [
                ...matches.filter(location => location.uri.toString() !== currentUri),
                ...currentFileDefinitions
            ];
            const unique = new Map(locations.map(location => [`${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}`, location]));
            const results = [...unique.values()];
            return results.length ? results : undefined;
        }
    }));

    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
        provideCompletionItems() {
            return [
                ...KEYWORDS.map(label => makeCompletion(label, vscode.CompletionItemKind.Keyword, "keyword")),
                ...TYPES.map(label => makeCompletion(label, vscode.CompletionItemKind.Class, "built-in type")),
                ...CONSTANTS.map(label => makeCompletion(label, vscode.CompletionItemKind.Constant, "constant"))
            ];
        }
    }, ".", ":"));

    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(selector, {
        provideDocumentSymbols(document) {
            const source = document.getText();
            const code = maskNonCode(source);
            const declarationPattern = /\b(fn|class|struct|enum|extend|type|const|static)\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)/g;
            const symbols: vscode.DocumentSymbol[] = [];
            let match: RegExpExecArray | null;
            while ((match = declarationPattern.exec(code)) !== null) {
                const nameOffset = match.index + match[0].lastIndexOf(match[2]);
                const selectionRange = new vscode.Range(positionAt(source, nameOffset), positionAt(source, nameOffset + match[2].length));
                const line = document.lineAt(selectionRange.start.line);
                const range = new vscode.Range(line.range.start, line.range.end);
                symbols.push(new vscode.DocumentSymbol(
                    match[2],
                    match[1],
                    documentSymbolKind(match[1] as DeclarationKind),
                    range,
                    selectionRange
                ));
            }
            return symbols;
        }
    }));

    function checkDocument(document: vscode.TextDocument): void {
        if (document.languageId !== "zircon" || document.uri.scheme !== "file") return;
        const uri = document.uri.toString();
        const generation = (generations.get(uri) || 0) + 1;
        generations.set(uri, generation);
        const compiler = findCompiler();
        if (!compiler) {
            diagnostics.delete(document.uri);
            reportCompilerIssue(
                "compiler-not-found",
                "The Zircon compiler (zirconc.exe) was not found. Add its folder to PATH or set Zircon: Compiler Path."
            );
            return;
        }

        const args = ["-check", document.uri.fsPath];
        const includes = includePath(compiler);
        if (includes) args.push("-I", includes);
        const cwd = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath || path.dirname(document.uri.fsPath);
        execFile(compiler, args, { cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
            if (generations.get(uri) !== generation) return;
            if (error && error.killed) {
                reportCompilerIssue("compiler-timeout", "The Zircon compiler did not finish within 15 seconds.");
                return;
            }
            if (error && typeof error.code === "string") {
                reportCompilerIssue(
                    `compiler-start-${error.code}`,
                    `Could not start the Zircon compiler (error code: ${error.code}). Check Zircon: Compiler Path and file permissions.`
                );
                return;
            }
            lastReportedCompilerIssue = undefined;
            diagnostics.set(document.uri, parseDiagnostics(`${stdout || ""}\n${stderr || ""}`, document));
        });
    }

    function scheduleCheck(document: vscode.TextDocument, delay = 500): void {
        const uri = document.uri.toString();
        clearTimeout(timers.get(uri));
        timers.set(uri, setTimeout(() => {
            timers.delete(uri);
            checkDocument(document);
        }, delay));
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => checkDocument(document)),
        vscode.workspace.onDidSaveTextDocument(document => scheduleCheck(document, 0)),
        vscode.workspace.onDidChangeTextDocument(event => {
            invalidateDefinitionIndex();
            scheduleCheck(event.document);
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            const uri = document.uri.toString();
            clearTimeout(timers.get(uri));
            timers.delete(uri);
            generations.set(uri, (generations.get(uri) || 0) + 1);
            diagnostics.delete(document.uri);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("zircon.compilerPath") || event.affectsConfiguration("zircon.includePath")) {
                invalidateDefinitionIndex();
                for (const document of vscode.workspace.textDocuments) checkDocument(document);
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(invalidateDefinitionIndex)
    );

    const workspaceWatcher = vscode.workspace.createFileSystemWatcher("**/*.zir");
    context.subscriptions.push(
        workspaceWatcher,
        workspaceWatcher.onDidCreate(invalidateDefinitionIndex),
        workspaceWatcher.onDidChange(invalidateDefinitionIndex),
        workspaceWatcher.onDidDelete(invalidateDefinitionIndex)
    );

    const compiler = findCompiler();
    const includeDirectory = compiler && includePath(compiler);
    if (includeDirectory) {
        const includeWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(includeDirectory), "**/*.zir"));
        context.subscriptions.push(
            includeWatcher,
            includeWatcher.onDidCreate(invalidateDefinitionIndex),
            includeWatcher.onDidChange(invalidateDefinitionIndex),
            includeWatcher.onDidDelete(invalidateDefinitionIndex)
        );
    }

    for (const document of vscode.workspace.textDocuments) checkDocument(document);
}

export function deactivate(): void {}
