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
    "let", "mut", "const", "volatile", "virtual", "override", "fn", "class", "struct", "enum", "extend", "type",
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

function extraIncludePaths(folder: vscode.WorkspaceFolder | undefined): string[] {
    const configured = vscode.workspace.getConfiguration("zircon", folder?.uri).get<string[]>("includePaths") || [];
    return configured.filter(Boolean).map(entry => path.resolve(folder?.uri.fsPath || "", entry));
}

function includePaths(compilerPath: string, folder: vscode.WorkspaceFolder | undefined): string[] {
    const standard = includePath(compilerPath);
    return [...(standard ? [standard] : []), ...extraIncludePaths(folder)];
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

interface FunctionInfo {
    name: string;
    label: string;
    parameters: string[];
    documentation?: string;
}

function splitTopLevel(value: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let round = 0;
    let square = 0;
    let angle = 0;
    for (let i = 0; i < value.length; i++) {
        switch (value[i]) {
            case "(": round++; break;
            case ")": round--; break;
            case "[": square++; break;
            case "]": square--; break;
            case "<": angle++; break;
            case ">": angle = Math.max(0, angle - 1); break;
            case ",":
                if (round === 0 && square === 0 && angle === 0) {
                    parts.push(value.slice(start, i).trim());
                    start = i + 1;
                }
                break;
        }
    }
    const tail = value.slice(start).trim();
    if (tail) parts.push(tail);
    return parts;
}

function indexFunctionInfo(source: string): FunctionInfo[] {
    const code = maskNonCode(source);
    const sourceLines = source.split(/\r\n|\r|\n/);
    const pattern = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>\r\n]*>\s*)?\(/g;
    const functions: FunctionInfo[] = [];
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(code)) !== null) {
        const open = pattern.lastIndex - 1;
        let depth = 1;
        let close = open + 1;
        while (close < code.length && depth > 0) {
            if (code[close] === "(") depth++;
            else if (code[close] === ")") depth--;
            close++;
        }
        if (depth !== 0) continue;

        const parameters = splitTopLevel(source.slice(open + 1, close - 1))
            .filter(parameter => parameter && !/^(?:&\s*(?:mut\s+)?|mut\s+)?this$/.test(parameter));
        let suffixEnd = close;
        let suffix = code.slice(close).match(/^\s*(?:async\s*)?(?:->\s*([^;{\r\n]+))?/);
        if (suffix) suffixEnd = close + suffix[0].length;
        const returnType = suffix?.[1]?.trim();
        const label = `fn ${match[1]}(${parameters.join(", ")})${returnType ? ` -> ${returnType}` : ""}`;

        const declarationLine = positionAt(source, match.index).line;
        const docLines: string[] = [];
        for (let line = declarationLine - 1; line >= 0; line--) {
            const text = sourceLines[line].trim();
            if (!text.startsWith("///")) break;
            docLines.unshift(text.replace(/^\/\/\/\s?/, ""));
        }
        functions.push({ name: match[1], label, parameters, documentation: docLines.length ? docLines.join("\n") : undefined });
        pattern.lastIndex = Math.max(pattern.lastIndex, suffixEnd);
    }
    return functions;
}

function findActiveCall(source: string, offset: number): { name: string; activeParameter: number } | undefined {
    const code = maskNonCode(source);
    const stack: Array<{ open: number; commas: number }> = [];
    for (let i = 0; i < Math.min(offset, code.length); i++) {
        if (code[i] === "(") stack.push({ open: i, commas: 0 });
        else if (code[i] === ")") stack.pop();
        else if (code[i] === "," && stack.length) stack[stack.length - 1].commas++;
    }
    const active = stack[stack.length - 1];
    if (!active) return undefined;
    const callee = code.slice(0, active.open).trimEnd();
    const name = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(callee)?.[1];
    return name ? { name, activeParameter: active.commas } : undefined;
}

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
    let functionIndex: Map<string, FunctionInfo[]> | undefined;
    let hoverIndex: Map<string, string[]> | undefined;
    let symbolKindIndex: Map<string, vscode.CompletionItemKind> | undefined;
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
        functionIndex = undefined;
        hoverIndex = undefined;
        symbolKindIndex = undefined;
    }

    async function getDefinitionIndex(): Promise<Map<string, vscode.Location[]>> {
        if (definitionIndex) return definitionIndex;
        if (definitionIndexBuild) return definitionIndexBuild;

        const buildRevision = definitionIndexRevision;
        definitionIndexBuild = (async () => {
            const uris = new Map<string, vscode.Uri>();
            const excludedDirectories = "{**/.claude/**,**/.git/**,**/node_modules/**}";
            for (const document of vscode.workspace.textDocuments) {
                if (document.languageId === "zircon" && document.uri.scheme === "file") uris.set(document.uri.toString(), document.uri);
            }
            for (const uri of await vscode.workspace.findFiles("**/*.zir", excludedDirectories)) uris.set(uri.toString(), uri);

            const compiler = findCompiler();
            const includes = new Set<string>();
            const standard = compiler && includePath(compiler);
            if (standard) includes.add(standard);

            for (const folder of vscode.workspace.workspaceFolders || []) {
                for (const include of extraIncludePaths(folder)) includes.add(include);
            }

            for (const include of includes) {
                const includeUri = vscode.Uri.file(include);
                for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(includeUri, "**/*.zir"), excludedDirectories)) {
                    uris.set(uri.toString(), uri);
                }
            }

            const index = new Map<string, vscode.Location[]>();
            const functions = new Map<string, FunctionInfo[]>();
            const hovers = new Map<string, string[]>();
            const symbolKinds = new Map<string, vscode.CompletionItemKind>();
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
                for (const info of indexFunctionInfo(source)) {
                    const overloads = functions.get(info.name) || [];
                    overloads.push(info);
                    functions.set(info.name, overloads);
                    const descriptions = hovers.get(info.name) || [];
                    descriptions.push(info.label);
                    hovers.set(info.name, descriptions);
                }
                const code = maskNonCode(source);
                const sourceLines = source.split(/\r\n|\r|\n/);
                const symbolPattern = /\b(fn|class|struct|enum|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
                let symbol: RegExpExecArray | null;
                while ((symbol = symbolPattern.exec(code)) !== null) {
                    const kind = symbol[1] === "fn" ? vscode.CompletionItemKind.Function
                        : symbol[1] === "class" ? vscode.CompletionItemKind.Class
                            : symbol[1] === "struct" ? vscode.CompletionItemKind.Struct
                                : symbol[1] === "enum" ? vscode.CompletionItemKind.Enum
                                    : vscode.CompletionItemKind.TypeParameter;
                    symbolKinds.set(symbol[2], kind);
                }
                const declarationPattern = /\b(class|struct|enum|type|const|static)\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)/g;
                let declaration: RegExpExecArray | null;
                while ((declaration = declarationPattern.exec(code)) !== null) {
                    const line = sourceLines[positionAt(source, declaration.index).line]?.trim();
                    if (!line) continue;
                    const descriptions = hovers.get(declaration[2]) || [];
                    const declarationText = line.replace(/\s*\{\s*$/, "");
                    descriptions.push(declarationText.length > 240 ? `${declarationText.slice(0, 237)}...` : declarationText);
                    hovers.set(declaration[2], descriptions);
                }
            }

            if (definitionIndexRevision === buildRevision) {
                definitionIndex = index;
                functionIndex = functions;
                hoverIndex = hovers;
                symbolKindIndex = symbolKinds;
            }
            return index;
        })().finally(() => {
            definitionIndexBuild = undefined;
        });

        return definitionIndexBuild;
    }

    context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
        async provideHover(document, position) {
            const range = document.getWordRangeAtPosition(position);
            if (!range) return undefined;
            const word = document.getText(range);
            const description = HOVER_MAP[word];
            if (description) return new vscode.Hover(new vscode.MarkdownString(description), range);

            await getDefinitionIndex();
            const localFunctions = indexFunctionInfo(document.getText()).filter(info => info.name === word);
            const functions = localFunctions.length ? localFunctions : (functionIndex?.get(word) || []);
            if (functions.length) {
                const markdown = new vscode.MarkdownString();
                functions.forEach((info, index) => {
                    if (index) markdown.appendMarkdown("\n\n---\n\n");
                    markdown.appendCodeblock(info.label, "zircon");
                    if (info.documentation) markdown.appendMarkdown(`\n${info.documentation}`);
                });
                return new vscode.Hover(markdown, range);
            }

            const declarations = [...new Set(hoverIndex?.get(word) || [])];
            if (!declarations.length) return undefined;
            const markdown = new vscode.MarkdownString();
            for (const declaration of declarations) markdown.appendCodeblock(declaration, "zircon");
            return new vscode.Hover(markdown, range);
        }
    }));

    context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(selector, {
        async provideSignatureHelp(document, position) {
            const call = findActiveCall(document.getText(), document.offsetAt(position));
            if (!call) return undefined;
            await getDefinitionIndex();
            const localOverloads = indexFunctionInfo(document.getText()).filter(info => info.name === call.name);
            const overloads = localOverloads.length ? localOverloads : functionIndex?.get(call.name);
            if (!overloads?.length) return undefined;

            const help = new vscode.SignatureHelp();
            help.signatures = overloads.map(info => {
                const signature = new vscode.SignatureInformation(info.label, info.documentation);
                signature.parameters = info.parameters.map(parameter => new vscode.ParameterInformation(parameter));
                return signature;
            });
            help.activeSignature = 0;
            help.activeParameter = Math.min(call.activeParameter, Math.max(0, help.signatures[0].parameters.length - 1));
            return help;
        }
    }, "(", ","));

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
        async provideCompletionItems(document) {
            const items = [
                ...KEYWORDS.map(label => makeCompletion(label, vscode.CompletionItemKind.Keyword, "keyword")),
                ...TYPES.map(label => makeCompletion(label, vscode.CompletionItemKind.Class, "built-in type")),
                ...CONSTANTS.map(label => makeCompletion(label, vscode.CompletionItemKind.Constant, "constant"))
            ];
            const definitions = await getDefinitionIndex();
            const localDefinitions = indexDefinitions(document.uri, document.getText());
            const localKinds = new Map<string, vscode.CompletionItemKind>();
            const localSymbolPattern = /\b(fn|class|struct|enum|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
            const localCode = maskNonCode(document.getText());
            let localSymbol: RegExpExecArray | null;
            while ((localSymbol = localSymbolPattern.exec(localCode)) !== null) {
                const kind = localSymbol[1] === "fn" ? vscode.CompletionItemKind.Function
                    : localSymbol[1] === "class" ? vscode.CompletionItemKind.Class
                        : localSymbol[1] === "struct" ? vscode.CompletionItemKind.Struct
                            : localSymbol[1] === "enum" ? vscode.CompletionItemKind.Enum
                                : vscode.CompletionItemKind.TypeParameter;
                localKinds.set(localSymbol[2], kind);
            }
            const known = new Set(items.map(item => item.label.toString()));
            const names = new Set([...definitions.keys(), ...localDefinitions.keys()]);
            for (const name of names) {
                if (known.has(name)) continue;
                const item = makeCompletion(name, localKinds.get(name) || symbolKindIndex?.get(name) || vscode.CompletionItemKind.Variable, "workspace symbol");
                const declarations = [...new Set(hoverIndex?.get(name) || [])];
                const functions = functionIndex?.get(name) || [];
                if (functions.length) {
                    item.detail = functions[0].label;
                    if (functions[0].documentation) item.documentation = new vscode.MarkdownString(functions[0].documentation);
                } else if (declarations.length) {
                    item.documentation = new vscode.MarkdownString(declarations.map(value => `\`${value}\``).join("\n\n"));
                }
                item.sortText = `1_${name}`;
                items.push(item);
                known.add(name);
            }
            return items;
        }
    }, ".", ":", ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_".split("")));

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

        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const args = ["-check", document.uri.fsPath];
        for (const include of includePaths(compiler, folder)) args.push("-I", include);
        const cwd = folder?.uri.fsPath || path.dirname(document.uri.fsPath);
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
        vscode.workspace.onDidSaveTextDocument(document => {
            invalidateDefinitionIndex();
            scheduleCheck(document, 0);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
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
            if (event.affectsConfiguration("zircon.compilerPath") || event.affectsConfiguration("zircon.includePath") || event.affectsConfiguration("zircon.includePaths")) {
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

    void getDefinitionIndex();
    for (const document of vscode.workspace.textDocuments) checkDocument(document);
}

export function deactivate(): void {}
