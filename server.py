import subprocess, re, os, threading, string, pygls.server, lsprotocol

server = pygls.server.LanguageServer("zircon-analyzer", "0.0.3")

HOVER_MAP = {
    "i8": "8-bit signed integer",
    "i16": "16-bit signed integer",
    "i32": "32-bit signed integer",
    "i64": "64-bit signed integer",
    "i128": "128-bit signed integer",
    "u8": "8-bit unsigned integer",
    "u16": "16-bit unsigned integer",
    "u32": "32-bit unsigned integer",
    "u64": "64-bit unsigned integer",
    "u128": "128-bit unsigned integer",
    "f32": "32-bit floating-point number",
    "f64": "64-bit floating-point number"
}

KEYWORDS = [
    "if", "else", "for", "while", "loop", "match", "ret", "break", "continue",
    "let", "mut", "const", "volatile", "func", "class", "type", "enum", "impl",
    "extern", "use", "asm", "namespace", "async", "await", "static",
    "pub", "priv", "as", "op", "new", "del", "in", "include", "this"
]

TYPES = [
    "void", "bool",
    "i8", "u8",
    "i16", "u16",
    "i32", "u32",
    "i64", "u64",
    "i128", "u128",
    "f32", "f64"
]

CONSTANTS = [
    "true", "false", "null"
]

ANSI_ESCAPE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
DIAGNOSTIC_PATTERN = re.compile(r"(.+?):(\d+):(\d+): (Error|Warning): (.+)")

_debounce_timers: dict = {}
_debounce_lock = threading.Lock()
DEBOUNCE_DELAY = 0.5

def _cancel_timer(uri: str) -> None:
    with _debounce_lock:
        timer = _debounce_timers.pop(uri, None)
        if timer: timer.cancel()

def schedule_diagnostics(ls: pygls.server.LanguageServer, uri: str) -> None:
    with _debounce_lock:
        timer = _debounce_timers.get(uri)
        if timer: timer.cancel()
        timer = threading.Timer(DEBOUNCE_DELAY, get_diagnostics, args = [ls, uri])
        _debounce_timers[uri] = timer
        timer.start()

def get_diagnostics(ls: pygls.server.LanguageServer, uri: str) -> None:
    if not COMPILER_PATH: return
    doc = ls.workspace.get_text_document(uri)
    source_lines = doc.source.splitlines()

    result = subprocess.run(
        [COMPILER_PATH, "-check", doc.path] + (["-I", INCLUDE_PATH] if INCLUDE_PATH else []),
        capture_output = True, text = True, cwd = ls.workspace.root_path, timeout = 15
    )

    output = ANSI_ESCAPE.sub("", result.stdout + result.stderr)
    diagnostics = []

    for line in output.splitlines():
        match = DIAGNOSTIC_PATTERN.search(line)

        if not match:
            continue

        file, row, col, severity_str, message = match.groups()

        if os.path.abspath(file).lower() != os.path.abspath(path).lower():
            continue

        line_no = int(row) - 1
        char_no = int(col) - 1
        end_char_no = char_no + 1

        if 0 <= line_no < len(source_lines):
            current_line = source_lines[line_no]
            allowed = string.ascii_letters + string.digits + "_"

            if char_no < len(current_line):
                while end_char_no < len(current_line) and current_line[end_char_no] in allowed:
                    end_char_no += 1

            if end_char_no <= char_no:
                end_char_no = char_no + 1

        diagnostics.append(
            lsprotocol.types.Diagnostic(
                range = lsprotocol.types.Range(
                    start = lsprotocol.types.Position(line = line_no, character = char_no),
                    end = lsprotocol.types.Position(line = line_no, character = end_char_no)
                ),
                message = message.strip(),
                severity = lsprotocol.types.DiagnosticSeverity.Error if severity_str == "Error" else lsprotocol.types.DiagnosticSeverity.Warning,
                source = os.path.split(COMPILER_PATH)[1]
            )
        )

    ls.publish_diagnostics(uri, diagnostics)

@server.feature(lsprotocol.types.INITIALIZE)
def on_initialize(ls: pygls.server.LanguageServer, params: lsprotocol.types.InitializeParams):
    global COMPILER_PATH, INCLUDE_PATH

    COMPILER_PATH = os.path.join(ls.workspace.root_path, "zirconc.exe")

    if not os.path.exists(COMPILER_PATH):
        COMPILER_PATH = None

    INCLUDE_PATH = os.path.join(ls.workspace.root_path, "include")

    if not os.path.exists(INCLUDE_PATH):
        INCLUDE_PATH = None

    if isinstance(params.initialization_options, dict):
        if params.initialization_options.get("compilerPath"):
            COMPILER_PATH = params.initialization_options["compilerPath"]

        if params.initialization_options.get("includePath"):
            INCLUDE_PATH = params.initialization_options["includePath"]

@server.feature(lsprotocol.types.TEXT_DOCUMENT_HOVER)
def hover(ls: pygls.server.LanguageServer, params: lsprotocol.types.HoverParams):
    doc = ls.workspace.get_text_document(params.text_document.uri)
    word = doc.word_at_position(params.position)

    for key in HOVER_MAP:
        if word.endswith(key):
            return lsprotocol.types.Hover(
                contents = lsprotocol.types.MarkupContent(
                    kind = lsprotocol.types.MarkupKind.Markdown,
                    value = HOVER_MAP[key]
                )
            )

@server.feature(lsprotocol.types.TEXT_DOCUMENT_COMPLETION, lsprotocol.types.CompletionOptions(trigger_characters = [".", ":"]))
def completion(ls: pygls.server.LanguageServer, params: lsprotocol.types.CompletionParams):
    items = []

    for keyword in KEYWORDS:
        items.append(
            lsprotocol.types.CompletionItem(
                label = keyword,
                kind = lsprotocol.types.CompletionItemKind.Keyword,
                detail = "keyword",
                documentation = lsprotocol.types.MarkupContent(
                    kind = lsprotocol.types.MarkupKind.Markdown,
                    value = HOVER_MAP.get(keyword, keyword),
                ),
            )
        )

    for type in TYPES:
        items.append(
            lsprotocol.types.CompletionItem(
                label = type,
                kind = lsprotocol.types.CompletionItemKind.Class,
                detail = "built-in type",
                documentation = lsprotocol.types.MarkupContent(
                    kind = lsprotocol.types.MarkupKind.Markdown,
                    value = HOVER_MAP.get(type, type)
                )
            )
        )

    for contant in CONSTANTS:
        items.append(
            lsprotocol.types.CompletionItem(
                label = contant,
                kind = lsprotocol.types.CompletionItemKind.Constant,
                detail = "constant",
                documentation = lsprotocol.types.MarkupContent(
                    kind = lsprotocol.types.MarkupKind.Markdown,
                    value = HOVER_MAP.get(contant, contant)
                )
            )
        )

    return lsprotocol.types.CompletionList(is_incomplete = False, items = items)

@server.feature(lsprotocol.types.TEXT_DOCUMENT_DID_OPEN)
def did_open(ls: pygls.server.LanguageServer, params: lsprotocol.types.DidOpenTextDocumentParams):
    get_diagnostics(ls, params.text_document.uri)

@server.feature(lsprotocol.types.TEXT_DOCUMENT_DID_SAVE)
def did_save(ls: pygls.server.LanguageServer, params: lsprotocol.types.DidSaveTextDocumentParams):
    _cancel_timer(params.text_document.uri)
    get_diagnostics(ls, params.text_document.uri)

@server.feature(lsprotocol.types.TEXT_DOCUMENT_DID_CHANGE)
def did_change(ls: pygls.server.LanguageServer, params: lsprotocol.types.DidChangeTextDocumentParams):
    schedule_diagnostics(ls, params.text_document.uri)

@server.feature(lsprotocol.types.TEXT_DOCUMENT_DID_CLOSE)
def did_close(ls: pygls.server.LanguageServer, params: lsprotocol.types.DidCloseTextDocumentParams):
    _cancel_timer(params.text_document.uri)
    server.publish_diagnostics(params.text_document.uri, [])

if __name__ == "__main__":
    server.start_io()