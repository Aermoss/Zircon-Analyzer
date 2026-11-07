import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOVER_MAP: Record<string, string> = {
    bool: "Boolean value", char: "32-bit Unicode scalar value",
    i8: "8-bit signed integer", i16: "16-bit signed integer", i32: "32-bit signed integer",
    i64: "64-bit signed integer", i128: "128-bit signed integer", isize: "Pointer-sized signed integer",
    u8: "8-bit unsigned integer", u16: "16-bit unsigned integer", u32: "32-bit unsigned integer",
    u64: "64-bit unsigned integer", u128: "128-bit unsigned integer", usize: "Pointer-sized unsigned integer",
    f32: "32-bit floating-point number", f64: "64-bit floating-point number"
};

const KEYWORD_DOCS: Record<string, string> = {
    fn: "Declares a function or method.",
    let: "Declares a variable. Add `mut` to make it mutable.",
    mut: "Makes a variable, reference or pointer mutable.",
    const: "Declares a compile-time constant.",
    static: "Declares a global variable.",
    class: "Declares a class with fields, constructors and methods.",
    struct: "Declares a structure.",
    enum: "Declares an enumeration. Variants can carry values.",
    extend: "Adds methods to an existing type.",
    type: "Declares a type alias.",
    extern: "Declares functions implemented elsewhere, for example `extern \"C\" { ... }`.",
    pub: "Makes a field or method visible outside its type.",
    virtual: "Declares a method that derived classes can override.",
    override: "Overrides a virtual method of the base class.",
    if: "Conditional. It can also be used as an expression.",
    else: "Alternative branch of an `if`.",
    match: "Compares a value against patterns.",
    for: "Loops over a range or a collection: `for i in 0..n { ... }`.",
    while: "Loops while a condition is true.",
    loop: "Loops until `break`.",
    break: "Leaves the innermost loop.",
    continue: "Skips to the next iteration of the innermost loop.",
    return: "Returns from the current function.",
    as: "Casts a value to another type.",
    in: "Separates the pattern from the iterated value in a `for` loop.",
    new: "Allocates an object on the heap.",
    delete: "Frees an object allocated with `new`.",
    this: "The current object inside a method.",
    operator: "Declares an operator overload, such as `operator+` or `operator[]`.",
    asm: "Inline assembly.",
    unsafe: "Marks code that bypasses safety checks.",
    volatile: "Marks memory accesses that must not be optimized away.",
    async: "Declares an asynchronous function.",
    await: "Waits for an asynchronous result.",
    include: "Includes modules: `#[include \"std/io\" : *]`."
};

const KEYWORDS = [
    "if", "else", "for", "while", "loop", "match", "return", "break", "continue",
    "let", "mut", "const", "volatile", "virtual", "override", "fn", "class", "struct", "enum", "extend", "type",
    "extern", "asm", "unsafe", "async", "await", "static", "pub", "as", "operator", "new", "delete",
    "in", "include", "this"
];
const TYPES = ["void", "bool", "char", "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64"];
const CONSTANTS = ["true", "false", "null"];
const IDENTIFIER = "[A-Za-z_][A-Za-z0-9_]*";
const LABEL_PATTERN = /^'[A-Za-z_][A-Za-z0-9_]*$/;
const DIAGNOSTIC_PATTERN = /^(.*):(\d+):(\d+): (Error|Fatal Error|Warning|Info): (.+)$/;
const ANSI_ESCAPE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function executableFile(name: string): boolean {
    try {
        return fs.statSync(name).isFile();
    } catch {
        return false;
    }
}

function findCompiler(folder?: vscode.WorkspaceFolder): string | undefined {
    const config = vscode.workspace.getConfiguration("zircon", folder?.uri);
    const configured = config.get<string>("compilerPath");
    const candidates: string[] = [];
    if (configured) candidates.push(path.resolve(folder?.uri.fsPath || "", configured));
    const executableNames = process.platform === "win32" ? ["zirconc.exe", "zirconc"] : ["zirconc", "zirconc.exe"];

    for (const entry of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
        for (const name of executableNames) candidates.push(path.join(entry, name));
    }

    for (const root of [folder, ...(vscode.workspace.workspaceFolders || [])]) {
        if (!root) continue;
        for (const name of executableNames) {
            candidates.push(path.join(root.uri.fsPath, "bin", name));
            candidates.push(path.resolve(root.uri.fsPath, "..", "Zircon", "bin", name));
        }
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

function includeSearchDirectories(documentPath: string, compilerPath: string | undefined, folder: vscode.WorkspaceFolder | undefined): string[] {
    const cwd = folder?.uri.fsPath || path.dirname(documentPath);
    const directories = [path.dirname(documentPath), cwd, path.join(cwd, "include")];
    if (compilerPath) directories.push(path.resolve(path.dirname(compilerPath), "..", "include"));
    directories.push(...(compilerPath ? includePaths(compilerPath, folder) : extraIncludePaths(folder)));
    return directories;
}

function resolveInclude(name: string, directories: string[]): string | undefined {
    for (const directory of directories) {
        const candidate = path.resolve(directory, name);
        let stat: fs.Stats;
        try {
            stat = fs.statSync(candidate);
        } catch {
            continue;
        }
        if (!stat.isDirectory()) return candidate;
        const entry = path.join(candidate, "Entry.zir");
        if (fs.existsSync(entry)) return entry;
    }
    return undefined;
}

function findIncludePaths(source: string): Array<{ name: string; start: number; end: number }> {
    const code = maskNonCode(source);
    const results: Array<{ name: string; start: number; end: number }> = [];
    const directive = /#\[\s*include\b/g;
    let match: RegExpExecArray | null;

    while ((match = directive.exec(code)) !== null) {
        const close = code.indexOf("]", directive.lastIndex);
        const end = close < 0 ? code.length : close;
        const strings = /"((?:\\.|[^"\\\r\n])*)"/g;
        strings.lastIndex = directive.lastIndex;
        let literal: RegExpExecArray | null;

        while ((literal = strings.exec(source)) !== null && literal.index < end) {
            results.push({ name: literal[1].replace(/\\(.)/g, "$1"), start: literal.index + 1, end: literal.index + 1 + literal[1].length });
        }

        directive.lastIndex = end;
    }

    return results;
}

function maskNonCode(source: string): string {
    const mask = (value: string): string => value.replace(/[^\r\n]/g, " ");
    return source
        .replace(/"(?:\\.|[^"\\\r\n])*"|'[A-Za-z_][A-Za-z0-9_]*(?!['A-Za-z0-9_])|'(?:\\.|[^'\\\r\n])*'/g, value => LABEL_PATTERN.test(value) ? value : mask(value))
        .replace(/\/\*[\s\S]*?\*\//g, mask)
        .replace(/\/\/[^\r\n]*/g, mask);
}

let lineStartsSource: string | undefined;
let lineStarts: number[] = [0];

function positionAt(source: string, offset: number): vscode.Position {
    if (source !== lineStartsSource) {
        lineStarts = [0];

        for (let i = 0; i < source.length; i++) {
            const character = source.charCodeAt(i);
            if (character === 13 && source.charCodeAt(i + 1) === 10) i++;
            if (character === 10 || character === 13) lineStarts.push(i + 1);
        }

        lineStartsSource = source;
    }

    let low = 0;
    let high = lineStarts.length - 1;

    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (lineStarts[middle] <= offset) low = middle; else high = middle - 1;
    }

    return new vscode.Position(low, offset - lineStarts[low]);
}

function lastStartingBefore<T extends { start: number }>(items: T[], offset: number): T | undefined {
    let low = 0;
    let high = items.length - 1;
    let result: T | undefined;

    while (low <= high) {
        const middle = (low + high) >> 1;
        if (items[middle].start < offset) {
            result = items[middle];
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    return result;
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

function documentationAbove(sourceLines: string[], declarationLine: number): string | undefined {
    const docLines: string[] = [];
    for (let line = declarationLine - 1; line >= 0; line--) {
        const text = sourceLines[line].trim();
        if (!text.startsWith("///")) break;
        docLines.unshift(text.replace(/^\/\/\/\s?/, ""));
    }
    return docLines.length ? docLines.join("\n") : undefined;
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
        const documentation = documentationAbove(sourceLines, positionAt(source, match.index).line);
        functions.push({ name: match[1], label, parameters, documentation });
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
    item.documentation = new vscode.MarkdownString(HOVER_MAP[label] || KEYWORD_DOCS[label] || label);
    return item;
}

interface TypeBlock {
    name: string;
    kind: "class" | "struct" | "enum" | "extend";
    uri: vscode.Uri;
    start: number;
    nameStart: number;
    end: number;
    generics: string[];
    base?: string;
    header: string;
    documentation?: string;
    members: Member[];
}

interface Member {
    name: string;
    kind: "field" | "method" | "variant";
    uri: vscode.Uri;
    start: number;
    nameStart: number;
    end: number;
    text: string;
    type?: string;
    isStatic: boolean;
    documentation?: string;
    container: TypeBlock;
}

interface Parameter {
    name: string;
    type: string;
    nameStart: number;
}

interface FunctionScope {
    name: string;
    uri: vscode.Uri;
    start: number;
    nameStart: number;
    bodyStart: number;
    bodyEnd: number;
    end: number;
    label: string;
    parameters: Parameter[];
    returnType?: string;
    container?: TypeBlock;
}

interface GlobalValue {
    name: string;
    kind: "const" | "static" | "type";
    uri: vscode.Uri;
    start: number;
    nameStart: number;
    end: number;
    type?: string;
    text: string;
}

interface FileStructure {
    uri: vscode.Uri;
    types: TypeBlock[];
    functions: FunctionScope[];
    values: GlobalValue[];
}

interface Local {
    name: string;
    nameStart: number;
    type?: string;
    initializer?: { start: number; end: number };
    iterable?: { start: number; end: number };
    parameter: boolean;
}

function collapse(text: string, limit = 240): string {
    const value = text.replace(/\s+/g, " ").trim();
    return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function findMatching(code: string, open: number): number {
    const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
    const stack: string[] = [];

    for (let i = open; i < code.length; i++) {
        const character = code[i];
        if (pairs[character]) stack.push(pairs[character]);
        else if (character === ")" || character === "]" || character === "}") {
            if (stack.pop() !== character) return -1;
            if (stack.length === 0) return i;
        }
    }

    return -1;
}

function findMatchingBackward(code: string, close: number): number {
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const stack: string[] = [];

    for (let i = close; i >= 0; i--) {
        const character = code[i];
        if (pairs[character]) stack.push(pairs[character]);
        else if (character === "(" || character === "[" || character === "{") {
            if (stack.pop() !== character) return -1;
            if (stack.length === 0) return i;
        }
    }

    return -1;
}

function splitRanges(code: string, start: number, end: number, angles: boolean): Array<{ start: number; end: number }> {
    const parts: Array<{ start: number; end: number }> = [];
    let depth = 0;
    let partStart = start;

    for (let i = start; i < end; i++) {
        const character = code[i];
        if (character === "(" || character === "[" || character === "{" || (angles && character === "<")) depth++;
        else if (character === ")" || character === "]" || character === "}" || (angles && character === ">" && code[i - 1] !== "-")) depth = Math.max(0, depth - 1);
        else if (character === "," && depth === 0) {
            parts.push({ start: partStart, end: i });
            partStart = i + 1;
        }
    }

    if (code.slice(partStart, end).trim()) parts.push({ start: partStart, end });
    return parts;
}

function firstTopLevelSemicolon(code: string, start: number, end: number): number {
    let depth = 0;

    for (let i = start; i < end; i++) {
        const character = code[i];
        if (character === "(" || character === "[" || character === "{") depth++;
        else if (character === ")" || character === "]" || character === "}") depth--;
        else if (character === ";" && depth === 0) return i;
    }

    return end;
}

function indexStructure(uri: vscode.Uri, source: string): FileStructure {
    const code = maskNonCode(source);
    const sourceLines = source.split(/\r\n|\r|\n/);
    const types: TypeBlock[] = [];
    const functions: FunctionScope[] = [];
    const values: GlobalValue[] = [];
    const docAt = (offset: number): string | undefined => documentationAbove(sourceLines, positionAt(source, offset).line);

    const typePattern = new RegExp(`\\b(class|struct|enum|extend)\\s+(${IDENTIFIER})\\s*(<[^{};]*?>)?\\s*(?::\\s*([^{};]+?))?\\s*\\{`, "g");
    let match: RegExpExecArray | null;

    while ((match = typePattern.exec(code)) !== null) {
        const open = typePattern.lastIndex - 1;
        const close = findMatching(code, open);
        if (close < 0) continue;
        const kind = match[1] as TypeBlock["kind"];
        const generics = (match[3] ? splitTopLevel(match[3].slice(1, -1)) : [])
            .map(parameter => new RegExp(`^(${IDENTIFIER})`).exec(parameter)?.[1])
            .filter((parameter): parameter is string => Boolean(parameter));
        const block: TypeBlock = {
            name: match[2], kind, uri, start: match.index, nameStart: match.index + match[0].indexOf(match[2], match[1].length),
            end: close + 1, generics, base: kind === "class" ? match[4]?.trim() : undefined,
            header: collapse(code.slice(match.index, open)), documentation: docAt(match.index), members: []
        };

        if (kind !== "extend") {
            const headEnd = firstTopLevelSemicolon(code, open + 1, close);

            for (const part of splitRanges(code, open + 1, headEnd, true)) {
                const text = code.slice(part.start, part.end);

                if (kind === "enum") {
                    const variant = new RegExp(`^\\s*(${IDENTIFIER})\\s*(\\([\\s\\S]*\\))?\\s*(?:=\\s*([\\s\\S]+?))?\\s*$`).exec(text);
                    if (!variant) continue;
                    const nameStart = part.start + text.indexOf(variant[1]);
                    block.members.push({
                        name: variant[1], kind: "variant", uri, start: nameStart, nameStart, end: part.end, isStatic: true, container: block,
                        text: `${block.name}::${variant[1]}${variant[2] ? collapse(variant[2]) : ""}${variant[3] ? ` = ${collapse(variant[3])}` : ""}`
                    });
                } else {
                    const field = new RegExp(`^\\s*(?:pub\\s+)?(?:static\\s+)?(?:mut\\s+)?(${IDENTIFIER})\\s*:\\s*([\\s\\S]+?)\\s*(?:=[^=][\\s\\S]*)?$`).exec(text);
                    if (!field) continue;
                    const nameStart = part.start + text.indexOf(field[1], text.search(/\S/));
                    block.members.push({
                        name: field[1], kind: "field", uri, start: part.start + text.search(/\S/), nameStart, end: part.end, isStatic: false,
                        type: collapse(field[2]), text: collapse(text), container: block, documentation: docAt(nameStart)
                    });
                }
            }
        }

        types.push(block);
    }

    const blockAt = (offset: number): TypeBlock | undefined => {
        const block = lastStartingBefore(types, offset);
        return block && offset < block.end ? block : undefined;
    };

    const functionPattern = new RegExp(`\\bfn\\s+(${IDENTIFIER})\\s*(?:<[^>\\r\\n]*>\\s*)?\\(`, "g");

    while ((match = functionPattern.exec(code)) !== null) {
        const open = functionPattern.lastIndex - 1;
        const close = findMatching(code, open);
        if (close < 0) continue;
        const parameters: Parameter[] = [];
        const labels: string[] = [];
        let hasThis = false;

        for (const part of splitRanges(code, open + 1, close, true)) {
            const text = code.slice(part.start, part.end);
            if (/^\s*(?:&\s*(?:mut\s+)?|mut\s+)?this\s*$/.test(text)) {
                hasThis = true;
                continue;
            }
            labels.push(collapse(source.slice(part.start, part.end)));
            const parameter = new RegExp(`^\\s*(?:mut\\s+)?(${IDENTIFIER})\\s*:\\s*([\\s\\S]+?)\\s*$`).exec(text);
            if (parameter) parameters.push({ name: parameter[1], type: collapse(parameter[2]), nameStart: part.start + text.indexOf(parameter[1]) });
        }

        const suffix = code.slice(close + 1).match(/^\s*(?:async\s*)?(?:->\s*([^;{\r\n]+))?/);
        const suffixEnd = close + 1 + (suffix ? suffix[0].length : 0);
        const returnType = suffix?.[1]?.trim();
        const bodyStart = code[suffixEnd] === "{" ? suffixEnd : -1;
        const bodyEnd = bodyStart >= 0 ? findMatching(code, bodyStart) : -1;
        const nameStart = match.index + match[0].indexOf(match[1], 2);
        const container = blockAt(match.index);
        const label = `fn ${match[1]}(${labels.join(", ")})${returnType ? ` -> ${returnType}` : ""}`;
        const end = bodyEnd >= 0 ? bodyEnd + 1 : suffixEnd;

        functions.push({ name: match[1], uri, start: match.index, nameStart, bodyStart, bodyEnd, end, label, parameters, returnType, container });

        if (container) {
            container.members.push({
                name: match[1], kind: "method", uri, start: match.index, nameStart, end, text: label, type: returnType,
                isStatic: !hasThis, container, documentation: docAt(match.index)
            });
        }

        functionPattern.lastIndex = Math.max(functionPattern.lastIndex, bodyStart >= 0 ? bodyStart + 1 : suffixEnd);
    }

    const insideFunction = (offset: number): boolean => {
        const scope = lastStartingBefore(functions, offset);
        return scope !== undefined && offset > scope.bodyStart && offset < scope.bodyEnd;
    };
    const valuePattern = new RegExp(`\\b(static|const|type)\\s+(?:mut\\s+)?(${IDENTIFIER})\\s*(?::\\s*([^=;]+?))?\\s*(?:=|;)`, "g");

    while ((match = valuePattern.exec(code)) !== null) {
        if (blockAt(match.index) || insideFunction(match.index)) continue;
        const end = firstTopLevelSemicolon(code, match.index, code.length) + 1;
        const kind = match[1] as GlobalValue["kind"];
        const type = kind === "type" ? code.slice(valuePattern.lastIndex, end - 1).trim() : match[3]?.trim();
        values.push({ name: match[2], kind, uri, start: match.index, nameStart: match.index + match[0].indexOf(match[2], match[1].length), end, type, text: collapse(code.slice(match.index, end)) });
    }

    return { uri, types, functions, values };
}

function stripReferences(text: string): string {
    let result = text.trim();
    let previous: string;

    do {
        previous = result;
        result = result.replace(/^&\s*(?:mut\s+)?/, "").replace(/^\*\s*(?:mut\s+)?/, "").replace(/^mut\s+/, "").trim();
    } while (result !== previous);

    return result;
}

function parseType(text: string): { base: string; args: string[] } | undefined {
    const value = stripReferences(text);
    const array = /^\[([\s\S]+);[\s\S]*\]$/.exec(value);
    if (array) return { base: "[]", args: [array[1].trim()] };
    const match = new RegExp(`^(?:::)?(?:${IDENTIFIER}\\s*::\\s*)*(${IDENTIFIER})\\s*(?:<([\\s\\S]*)>)?`).exec(value);
    if (!match) return undefined;
    return { base: match[1], args: match[2] ? splitTopLevel(match[2]) : [] };
}

function substitute(text: string, parameters: string[], args: string[]): string {
    return parameters.reduce((result, parameter, index) => args[index] ? result.replace(new RegExp(`\\b${parameter}\\b`, "g"), args[index]) : result, text);
}

function elementType(text: string): string | undefined {
    const value = text.trim();
    if (/^\*/.test(value)) return value.replace(/^\*\s*(?:mut\s+)?/, "");
    const parsed = parseType(value);
    if (!parsed) return undefined;
    if (parsed.base === "[]" || parsed.base === "Vector") return parsed.args[0];
    if (parsed.base === "Map") return parsed.args[1];
    if (parsed.base === "String") return "i8";
    return undefined;
}

interface Segment {
    name: string;
    call: boolean;
    index: boolean;
    path?: string;
}

function skipSpaceBack(code: string, index: number): number {
    while (index >= 0 && /\s/.test(code[index])) index--;
    return index;
}

function receiverChain(code: string, end: number): { segments: Segment[]; start: number } | undefined {
    const segments: Segment[] = [];
    let i = skipSpaceBack(code, end - 1);

    while (true) {
        let call = false;
        let index = false;

        while (i >= 0 && (code[i] === ")" || code[i] === "]")) {
            const open = findMatchingBackward(code, i);
            if (open < 0) return undefined;
            if (code[i] === ")") call = true; else index = true;
            i = skipSpaceBack(code, open - 1);
        }

        const nameEnd = i + 1;
        while (i >= 0 && /[A-Za-z0-9_]/.test(code[i])) i--;
        const name = code.slice(i + 1, nameEnd);
        if (!/^[A-Za-z_]/.test(name)) return undefined;
        const segment: Segment = { name, call, index };
        segments.unshift(segment);
        let start = i + 1;
        i = skipSpaceBack(code, i);

        if (code[i] === "." && code[i - 1] !== ".") {
            i = skipSpaceBack(code, i - 1);
            continue;
        }

        if (code[i] === ">" && code[i - 1] === "-") {
            i = skipSpaceBack(code, i - 2);
            continue;
        }

        if (code[i] === ":" && code[i - 1] === ":") {
            let j = skipSpaceBack(code, i - 2);
            const typeEnd = j + 1;

            if (code[j] === ">") {
                let depth = 0;
                for (; j >= 0; j--) {
                    if (code[j] === ">") depth++;
                    else if (code[j] === "<" && --depth === 0) break;
                }
                j = skipSpaceBack(code, j - 1);
            }

            while (j >= 0 && /[A-Za-z0-9_]/.test(code[j])) j--;
            const typePath = code.slice(j + 1, typeEnd).replace(/\s+/g, "");
            if (/^[A-Za-z_]/.test(typePath)) {
                segment.path = typePath;
                start = j + 1;
            }
        }

        return { segments, start };
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const diagnostics = vscode.languages.createDiagnosticCollection("zircon");
    const output = vscode.window.createOutputChannel("Zircon");
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const generations = new Map<string, number>();
    let definitionIndex: Map<string, vscode.Location[]> | undefined;
    let functionIndex: Map<string, FunctionInfo[]> | undefined;
    let hoverIndex: Map<string, string[]> | undefined;
    let symbolKindIndex: Map<string, vscode.CompletionItemKind> | undefined;
    let structureIndex: Map<string, FileStructure> | undefined;
    let definitionIndexRevision = 0;
    let definitionIndexBuild: Promise<Map<string, vscode.Location[]>> | undefined;
    let lastReportedCompilerIssue: string | undefined;
    let contentsSupported = true;

    function reportCompilerIssue(key: string, message: string): void {
        if (lastReportedCompilerIssue === key) return;
        lastReportedCompilerIssue = key;
        void vscode.window.showErrorMessage(message);
    }

    const selector = { scheme: "file", language: "zircon" };
    context.subscriptions.push(diagnostics, output, {
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
        structureIndex = undefined;
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
            const structures = new Map<string, FileStructure>();
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
                structures.set(uri.toString(), indexStructure(uri, source));
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
                structureIndex = structures;
            }
            return index;
        })().finally(() => {
            definitionIndexBuild = undefined;
        });

        return definitionIndexBuild;
    }

    interface Context {
        document: vscode.TextDocument;
        code: string;
        offset: number;
        word: string;
        range?: vscode.Range;
        structures: FileStructure[];
        current: FileStructure;
        scope?: FunctionScope;
    }

    async function contextAt(document: vscode.TextDocument, position: vscode.Position): Promise<Context> {
        await getDefinitionIndex();
        const source = document.getText();
        const current = indexStructure(document.uri, source);
        const others = [...(structureIndex?.values() || [])].filter(structure => structure.uri.toString() !== document.uri.toString());
        const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        const offset = document.offsetAt(range ? range.start : position);
        let scope: FunctionScope | undefined;

        for (const candidate of current.functions) {
            if (offset > candidate.bodyStart && offset < candidate.bodyEnd && (!scope || candidate.bodyStart > scope.bodyStart)) scope = candidate;
        }

        return { document, code: maskNonCode(source), offset, word: range ? document.getText(range) : "", range, structures: [current, ...others], current, scope };
    }

    function typeBlocks(context: Context, name: string): TypeBlock[] {
        return context.structures.flatMap(structure => structure.types.filter(block => block.name === name));
    }

    function membersOf(context: Context, typeText: string, depth = 0): Array<{ member: Member; type?: string }> {
        const parsed = parseType(typeText);
        if (!parsed || depth > 6) return [];
        const result: Array<{ member: Member; type?: string }> = [];

        for (const block of typeBlocks(context, parsed.base)) {
            for (const member of block.members) {
                result.push({ member, type: member.type ? substitute(member.type, block.generics, parsed.args) : undefined });
            }

            if (block.base) result.push(...membersOf(context, block.base, depth + 1));
        }

        return result;
    }

    function localsAt(context: Context, offset: number): Local[] {
        const scope = context.scope;
        if (!scope) return [];
        const locals: Local[] = scope.parameters.map(parameter => ({ name: parameter.name, nameStart: parameter.nameStart, type: parameter.type, parameter: true }));
        const code = context.code.slice(0, scope.bodyEnd);
        const letPattern = new RegExp(`\\blet\\s+(?:&\\s*)?(?:mut\\s+)?(${IDENTIFIER})\\s*(?::\\s*([^=;]+?))?\\s*(=|;)`, "g");
        letPattern.lastIndex = scope.bodyStart;
        let match: RegExpExecArray | null;

        while ((match = letPattern.exec(code)) !== null) {
            const nameStart = match.index + match[0].indexOf(match[1], 3);
            const local: Local = { name: match[1], nameStart, type: match[2]?.trim(), parameter: false };

            if (match[3] === "=") {
                const start = letPattern.lastIndex;
                local.initializer = { start, end: firstTopLevelSemicolon(context.code, start, context.code.length) };
            }

            locals.push(local);
        }

        const tuplePattern = /\blet\s+(?:mut\s+)?\(([^)]*)\)/g;
        tuplePattern.lastIndex = scope.bodyStart;

        while ((match = tuplePattern.exec(code)) !== null) {
            const open = match.index + match[0].indexOf("(");
            for (const part of splitRanges(context.code, open + 1, open + 1 + match[1].length, false)) {
                const text = context.code.slice(part.start, part.end);
                const name = new RegExp(`^\\s*(?:mut\\s+)?(${IDENTIFIER})\\s*$`).exec(text)?.[1];
                if (name && name !== "_") locals.push({ name, nameStart: part.start + text.indexOf(name), parameter: false });
            }
        }

        const forPattern = new RegExp(`\\bfor\\s+(?:mut\\s+)?(${IDENTIFIER})\\s+in\\s+`, "g");
        forPattern.lastIndex = scope.bodyStart;

        while ((match = forPattern.exec(code)) !== null) {
            const start = forPattern.lastIndex;
            const brace = context.code.indexOf("{", start);
            locals.push({ name: match[1], nameStart: match.index + match[0].indexOf(match[1], 3), iterable: { start, end: brace < 0 ? start : brace }, parameter: false });
        }

        return locals.filter(local => local.nameStart <= offset).sort((a, b) => a.nameStart - b.nameStart);
    }

    function findLocal(context: Context, name: string, offset: number): Local | undefined {
        const candidates = localsAt(context, offset).filter(local => local.name === name);
        return candidates[candidates.length - 1];
    }

    function expressionType(context: Context, start: number, end: number, depth: number): string | undefined {
        const text = context.code.slice(start, end).trim();
        const allocation = new RegExp(`^new\\s+((?:${IDENTIFIER}\\s*::\\s*)*${IDENTIFIER}(?:\\s*<[^;]*?>)?)\\s*[(\\[]`).exec(text);
        if (allocation) return `*mut ${allocation[1]}`;
        const construction = new RegExp(`^(${IDENTIFIER})(\\s*<[^;(]*?>)?\\s*[({]`).exec(text);
        if (construction && typeBlocks(context, construction[1]).some(block => block.kind !== "extend" && block.kind !== "enum")) return construction[1] + (construction[2] || "");
        const chain = receiverChain(context.code, start + context.code.slice(start, end).trimEnd().length);
        if (!chain || chain.start > start + context.code.slice(start, end).search(/\S/)) return undefined;
        return resolveChain(context, chain.segments, start, depth + 1);
    }

    function localType(context: Context, name: string, offset: number, depth: number): string | undefined {
        if (depth > 8) return undefined;
        const local = findLocal(context, name, offset);
        if (!local) return undefined;
        if (local.type) return local.type;
        if (local.initializer) return expressionType(context, local.initializer.start, local.initializer.end, depth);

        if (local.iterable) {
            const iterable = expressionType(context, local.iterable.start, local.iterable.end, depth);
            return iterable ? elementType(iterable) : undefined;
        }

        return undefined;
    }

    function resolveChain(context: Context, segments: Segment[], offset: number, depth = 0): string | undefined {
        if (!segments.length || depth > 8) return undefined;
        const first = segments[0];
        let current: string | undefined;

        if (first.path) {
            const member = membersOf(context, first.path).find(candidate => candidate.member.name === first.name);
            current = member?.member.kind === "variant" ? first.path : member?.type;
        } else if (first.name === "this") {
            const block = context.scope?.container;
            current = block ? block.name + (block.generics.length ? `<${block.generics.join(", ")}>` : "") : undefined;
        } else {
            current = localType(context, first.name, offset, depth);

            if (!current) {
                const value = context.structures.flatMap(structure => structure.values).find(candidate => candidate.name === first.name && candidate.kind !== "type");
                current = value?.type;
            }

            if (!current && first.call) {
                const fn = context.structures.flatMap(structure => structure.functions).find(candidate => candidate.name === first.name && !candidate.container);
                current = fn?.returnType || (typeBlocks(context, first.name).some(block => block.kind === "class" || block.kind === "struct") ? first.name : undefined);
            }
        }

        if (current && first.index) current = elementType(current);

        for (const segment of segments.slice(1)) {
            if (!current) return undefined;
            const member = membersOf(context, current).find(candidate => candidate.member.name === segment.name);
            if (!member) return undefined;
            current = member.type;
            if (current && segment.index) current = elementType(current);
        }

        return current;
    }

    function accessAt(context: Context, offset: number): { kind: "path" | "member"; type?: string } | undefined {
        const before = context.code.slice(0, offset);
        const path = /::\s*$/.exec(before);

        if (path) {
            let j = skipSpaceBack(context.code, path.index - 1);
            const end = j + 1;

            if (context.code[j] === ">") {
                let depth = 0;
                for (; j >= 0; j--) {
                    if (context.code[j] === ">") depth++;
                    else if (context.code[j] === "<" && --depth === 0) break;
                }
                j = skipSpaceBack(context.code, j - 1);
            }

            while (j >= 0 && /[A-Za-z0-9_]/.test(context.code[j])) j--;
            const text = context.code.slice(j + 1, end).replace(/\s+/g, "");
            return { kind: "path", type: new RegExp(`^${IDENTIFIER}`).test(text) ? text : undefined };
        }

        const member = /(?:[^.]\.|->)\s*$/.exec(before);
        if (!member) return undefined;
        const arrow = member[0].indexOf("->");
        const accessor = member.index + (arrow >= 0 ? arrow : member[0].indexOf(".", 1));
        const chain = receiverChain(context.code, accessor);
        return { kind: "member", type: chain ? resolveChain(context, chain.segments, offset) : undefined };
    }

    function resolveMembers(context: Context): Member[] | undefined {
        if (!context.word) return undefined;
        const access = accessAt(context, context.offset);
        if (!access?.type) return undefined;
        const members = membersOf(context, access.type).map(candidate => candidate.member).filter(member => member.name === context.word);
        return members.length ? members : undefined;
    }

    async function locationOf(document: vscode.TextDocument, uri: vscode.Uri, offset: number, length: number): Promise<vscode.Location> {
        const target = uri.toString() === document.uri.toString() ? document : await vscode.workspace.openTextDocument(uri);
        const start = target.positionAt(offset);
        return new vscode.Location(uri, new vscode.Range(start, start.translate(0, length)));
    }

    function memberMarkdown(member: Member): vscode.MarkdownString {
        const markdown = new vscode.MarkdownString();
        markdown.appendCodeblock(member.text, "zircon");
        const role = member.kind === "field" ? "Field" : member.kind === "variant" ? "Variant" : member.isStatic ? "Static method" : "Method";
        markdown.appendMarkdown(`\n${role} of \`${member.container.name}\``);
        if (member.documentation) markdown.appendMarkdown(`\n\n${member.documentation}`);
        return markdown;
    }

    function typeSummary(blocks: TypeBlock[]): string | undefined {
        const block = blocks.find(candidate => candidate.kind !== "extend");
        if (!block) return undefined;
        const items = block.members.filter(member => member.kind !== "method");
        if (!items.length) return block.header;

        if (block.kind === "enum") {
            const names = items.map(member => member.name);
            return `${block.header} { ${names.slice(0, 16).join(", ")}${names.length > 16 ? ", ..." : ""} }`;
        }

        return `${block.header} {\n${items.slice(0, 24).map(member => `    ${member.text}`).join(",\n")}${items.length > 24 ? ",\n    ..." : ""}\n}`;
    }

    context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
        async provideHover(document, position) {
            const range = document.getWordRangeAtPosition(position);
            if (!range) return undefined;
            const word = document.getText(range);
            const description = HOVER_MAP[word];
            if (description) return new vscode.Hover(new vscode.MarkdownString(description), range);

            const semantic = await contextAt(document, position);
            if (semantic.code[semantic.offset] === " ") return undefined;
            const members = resolveMembers(semantic);

            if (members) {
                const markdown = new vscode.MarkdownString();
                members.slice(0, 4).forEach((member, index) => {
                    if (index) markdown.appendMarkdown("\n\n---\n\n");
                    markdown.appendMarkdown(memberMarkdown(member).value);
                });
                return new vscode.Hover(markdown, range);
            }

            if (!accessAt(semantic, semantic.offset)) {
                const local = findLocal(semantic, word, semantic.offset);

                if (local) {
                    const type = local.type || localType(semantic, word, semantic.offset, 0);
                    const markdown = new vscode.MarkdownString();
                    markdown.appendCodeblock(local.parameter ? `${word}: ${type || "?"}` : `let ${word}${type ? `: ${type}` : ""}`, "zircon");
                    markdown.appendMarkdown(local.parameter ? "\nParameter" : "\nLocal variable");
                    return new vscode.Hover(markdown, range);
                }
            }

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

            const summary = typeSummary(typeBlocks(semantic, word));

            if (summary) {
                const markdown = new vscode.MarkdownString();
                markdown.appendCodeblock(summary, "zircon");
                const documentation = typeBlocks(semantic, word).find(block => block.documentation)?.documentation;
                if (documentation) markdown.appendMarkdown(`\n${documentation}`);
                return new vscode.Hover(markdown, range);
            }

            const declarations = [...new Set(hoverIndex?.get(word) || [])];

            if (declarations.length) {
                const markdown = new vscode.MarkdownString();
                for (const declaration of declarations) markdown.appendCodeblock(declaration, "zircon");
                return new vscode.Hover(markdown, range);
            }

            return KEYWORD_DOCS[word] ? new vscode.Hover(new vscode.MarkdownString(KEYWORD_DOCS[word]), range) : undefined;
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
            const semantic = await contextAt(document, position);
            const members = resolveMembers(semantic);

            if (members) {
                return Promise.all(members.map(member => locationOf(document, member.uri, member.nameStart, member.name.length)));
            }

            if (!accessAt(semantic, semantic.offset)) {
                const local = findLocal(semantic, name, semantic.offset);
                if (local) return [await locationOf(document, document.uri, local.nameStart, name.length)];
            }

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

    function memberCompletion(member: Member, index: number): vscode.CompletionItem {
        const kind = member.kind === "field" ? vscode.CompletionItemKind.Field
            : member.kind === "variant" ? vscode.CompletionItemKind.EnumMember
                : vscode.CompletionItemKind.Method;
        const item = new vscode.CompletionItem(member.name, kind);
        item.detail = member.text;
        item.documentation = memberMarkdown(member);
        item.sortText = `0_${String(index).padStart(4, "0")}`;
        return item;
    }

    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
        async provideCompletionItems(document, position, _token, completionContext) {
            const semantic = await contextAt(document, position);
            const access = accessAt(semantic, semantic.offset);
            if (completionContext.triggerCharacter === ">" && access?.kind !== "member") return undefined;

            if (access?.type) {
                const seen = new Set<string>();
                const members = membersOf(semantic, access.type)
                    .map(candidate => candidate.member)
                    .filter(member => access.kind === "path" ? member.kind === "variant" || member.isStatic : member.kind !== "variant" && !member.isStatic)
                    .filter(member => !seen.has(member.name) && seen.add(member.name));
                if (members.length) return members.map(memberCompletion);
            }

            const items = [
                ...KEYWORDS.map(label => makeCompletion(label, vscode.CompletionItemKind.Keyword, "keyword")),
                ...TYPES.map(label => makeCompletion(label, vscode.CompletionItemKind.Class, "built-in type")),
                ...CONSTANTS.map(label => makeCompletion(label, vscode.CompletionItemKind.Constant, "constant"))
            ];
            const known = new Set(items.map(item => item.label.toString()));

            if (!access) {
                for (const local of localsAt(semantic, semantic.offset).reverse()) {
                    if (known.has(local.name)) continue;
                    const item = new vscode.CompletionItem(local.name, vscode.CompletionItemKind.Variable);
                    const type = local.type || localType(semantic, local.name, semantic.offset, 0);
                    item.detail = local.parameter ? `${local.name}: ${type || "?"}` : `let ${local.name}${type ? `: ${type}` : ""}`;
                    item.sortText = `0_${local.name}`;
                    items.push(item);
                    known.add(local.name);
                }
            }

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
    }, ".", ":", ">", ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_".split("")));

    context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(selector, {
        provideDocumentLinks(document) {
            const source = document.getText();
            const directories = includeSearchDirectories(document.uri.fsPath, findCompiler(vscode.workspace.getWorkspaceFolder(document.uri)), vscode.workspace.getWorkspaceFolder(document.uri));
            const links: vscode.DocumentLink[] = [];

            for (const include of findIncludePaths(source)) {
                const target = resolveInclude(include.name, directories);
                if (!target) continue;
                const link = new vscode.DocumentLink(new vscode.Range(document.positionAt(include.start), document.positionAt(include.end)), vscode.Uri.file(target));
                link.tooltip = target;
                links.push(link);
            }

            return links;
        }
    }));

    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(selector, {
        provideDocumentSymbols(document) {
            const structure = indexStructure(document.uri, document.getText());

            const symbol = (name: string, detail: string, kind: vscode.SymbolKind, start: number, end: number, nameStart: number): vscode.DocumentSymbol => {
                const selection = new vscode.Range(document.positionAt(nameStart), document.positionAt(nameStart + name.length));
                const range = new vscode.Range(document.positionAt(start), document.positionAt(Math.max(end, nameStart + name.length))).union(selection);
                return new vscode.DocumentSymbol(name, detail, kind, range, selection);
            };

            const typeKind = (kind: TypeBlock["kind"]): vscode.SymbolKind => kind === "class" ? vscode.SymbolKind.Class
                : kind === "struct" ? vscode.SymbolKind.Struct
                    : kind === "enum" ? vscode.SymbolKind.Enum
                        : vscode.SymbolKind.Interface;

            const entries: Array<{ start: number; symbol: vscode.DocumentSymbol }> = [];

            for (const block of structure.types) {
                const parent = symbol(block.name, block.kind, typeKind(block.kind), block.start, block.end, block.nameStart);
                parent.children = block.members.sort((a, b) => a.start - b.start).map(member => symbol(
                    member.name,
                    member.kind === "method" ? member.text.replace(/^fn \S+?(?=\()/, "") : member.kind === "field" ? member.type || "" : "",
                    member.kind === "field" ? vscode.SymbolKind.Field : member.kind === "variant" ? vscode.SymbolKind.EnumMember : vscode.SymbolKind.Method,
                    member.start, member.end, member.nameStart
                ));
                entries.push({ start: block.start, symbol: parent });
            }

            for (const fn of structure.functions) {
                if (fn.container) continue;
                entries.push({ start: fn.start, symbol: symbol(fn.name, "fn", vscode.SymbolKind.Function, fn.start, fn.end, fn.nameStart) });
            }

            for (const value of structure.values) {
                const kind = value.kind === "type" ? vscode.SymbolKind.TypeParameter : vscode.SymbolKind.Constant;
                entries.push({ start: value.start, symbol: symbol(value.name, value.kind, kind, value.start, value.end, value.nameStart) });
            }

            return entries.sort((a, b) => a.start - b.start).map(entry => entry.symbol);
        }
    }));

    function contentsFile(document: vscode.TextDocument): string {
        const directory = path.join(os.tmpdir(), "zircon-analyzer");
        fs.mkdirSync(directory, { recursive: true });
        const name = createHash("sha1").update(document.uri.toString()).digest("hex").slice(0, 16);
        const file = path.join(directory, `${name}.zir`);
        fs.writeFileSync(file, document.getText(), "utf8");
        return file;
    }

    function parseDiagnostics(text: string, document: vscode.TextDocument, cwd: string, compiler: string): vscode.Diagnostic[] {
        const lines = text.replace(ANSI_ESCAPE, "").split(/\r?\n/);
        const result: vscode.Diagnostic[] = [];
        const elsewhere = new Map<string, string[]>();
        const sourcePath = path.resolve(document.uri.fsPath).toLowerCase();
        let previous: vscode.Diagnostic | undefined;

        for (let i = 0; i < lines.length; i++) {
            const match = DIAGNOSTIC_PATTERN.exec(lines[i]);
            if (!match) continue;
            const file = path.resolve(cwd, match[1]);
            const line = Number(match[2]) - 1;
            const character = Number(match[3]) - 1;
            if (line < 0 || character < 0) continue;

            let length = 0;
            const marker = lines[i + 2]?.match(/^\s*\|\s?(.*)$/)?.[1];
            const carets = marker?.match(/\^+/)?.[0];
            if (carets) length = carets.length;
            const message = match[5].trim();

            if (match[4] === "Info") {
                if (previous) {
                    const range = new vscode.Range(line, character, line, character + Math.max(1, length));
                    previous.relatedInformation = [...(previous.relatedInformation || []), new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(file), range), message)];
                }
                continue;
            }

            if (file.toLowerCase() !== sourcePath) {
                previous = undefined;
                const messages = elsewhere.get(file) || [];
                messages.push(`${path.basename(file)}:${line + 1}:${character + 1}: ${message}`);
                elsewhere.set(file, messages);
                continue;
            }

            if (line >= document.lineCount) continue;
            const textLine = document.lineAt(line).text;

            if (!length) {
                let endCharacter = Math.min(character + 1, textLine.length);
                while (endCharacter < textLine.length && /[A-Za-z0-9_]/.test(textLine[endCharacter])) endCharacter++;
                length = Math.max(1, endCharacter - character);
            }

            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(line, character, line, character + length),
                message,
                match[4] === "Warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
            );
            diagnostic.source = "zirconc";
            result.push(diagnostic);
            previous = diagnostic;
        }

        if (elsewhere.size) {
            const includes = findIncludePaths(document.getText());
            const directories = includeSearchDirectories(document.uri.fsPath, compiler, vscode.workspace.getWorkspaceFolder(document.uri));

            for (const [file, messages] of elsewhere) {
                const include = includes.find(candidate => resolveInclude(candidate.name, directories)?.toLowerCase() === file.toLowerCase()) || includes[0];
                const range = include
                    ? new vscode.Range(document.positionAt(include.start), document.positionAt(include.end))
                    : new vscode.Range(0, 0, 0, 0);
                const diagnostic = new vscode.Diagnostic(range, `${path.basename(file)} has ${messages.length} error(s):\n${messages.join("\n")}`, vscode.DiagnosticSeverity.Error);
                diagnostic.source = "zirconc";
                result.push(diagnostic);
            }
        }

        return result;
    }

    function checkDocument(document: vscode.TextDocument): void {
        if (document.languageId !== "zircon" || document.uri.scheme !== "file") return;
        const uri = document.uri.toString();
        const generation = (generations.get(uri) || 0) + 1;
        generations.set(uri, generation);
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const compiler = findCompiler(folder);
        if (!compiler) {
            diagnostics.delete(document.uri);
            reportCompilerIssue(
                "compiler-not-found",
                "The Zircon compiler (zirconc.exe) was not found. Add its folder to PATH or set Zircon: Compiler Path."
            );
            return;
        }

        const args = ["-check", document.uri.fsPath];

        if (document.isDirty && contentsSupported) {
            try {
                args.push("--contents", contentsFile(document));
            } catch (error) {
                output.appendLine(`Could not write a temporary file: ${String(error)}`);
            }
        }

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
            const text = `${stdout || ""}\n${stderr || ""}`;
            if (contentsSupported && text.includes("Unknown option '--contents'")) {
                contentsSupported = false;
                output.appendLine("This zirconc does not support --contents; unsaved changes will be checked after saving.");
                checkDocument(document);
                return;
            }
            lastReportedCompilerIssue = undefined;
            diagnostics.set(document.uri, parseDiagnostics(text, document, cwd, compiler));
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

    context.subscriptions.push(vscode.commands.registerCommand("zircon.runFile", async (resource?: vscode.Uri) => {
        const document = resource ? await vscode.workspace.openTextDocument(resource) : vscode.window.activeTextEditor?.document;

        if (!document || document.languageId !== "zircon") {
            void vscode.window.showErrorMessage("Open a Zircon file to run it.");
            return;
        }

        if (document.isDirty && !(await document.save())) return;
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const compiler = findCompiler(folder);

        if (!compiler) {
            void vscode.window.showErrorMessage("The Zircon compiler (zirconc.exe) was not found. Add its folder to PATH or set Zircon: Compiler Path.");
            return;
        }

        const directory = path.join(os.tmpdir(), "zircon-analyzer");
        fs.mkdirSync(directory, { recursive: true });
        const name = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
        const executable = path.join(directory, process.platform === "win32" ? `${name}.exe` : name);
        const args = [document.uri.fsPath, "-o", executable, "-r"];
        for (const include of includePaths(compiler, folder)) args.push("-I", include);
        const cwd = folder?.uri.fsPath || path.dirname(document.uri.fsPath);
        const task = new vscode.Task(
            { type: "zircon", file: document.uri.fsPath },
            folder || vscode.TaskScope.Workspace,
            `Run ${path.basename(document.uri.fsPath)}`,
            "zircon",
            new vscode.ProcessExecution(compiler, args, { cwd })
        );
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
        await vscode.tasks.executeTask(task);
    }));

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => checkDocument(document)),
        vscode.workspace.onDidSaveTextDocument(document => {
            invalidateDefinitionIndex();
            scheduleCheck(document, 0);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId === "zircon" && event.contentChanges.length) scheduleCheck(event.document);
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
                contentsSupported = true;
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
