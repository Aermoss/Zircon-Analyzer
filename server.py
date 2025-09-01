from pygls.server import LanguageServer
import lsprotocol.types as types

server = LanguageServer("divine", "0.0.1")

hoverMap = {
    "i8": "8-bit signed integer",
    "i16": "16-bit signed integer",
    "i32": "32-bit signed integer",
    "i64": "i64-bit signed integer",
    "i128": "128-bit signed integer",
    "u8": "8-bit unsigned integer",
    "u16": "16-bit unsigned integer",
    "u32": "32-bit unsigned integer",
    "u64": "i64-bit unsigned integer",
    "u128": "128-bit unsigned integer",
    "f32": "32-bit floating point number",
    "f64": "64-bit floating point number"
}

@server.feature(types.TEXT_DOCUMENT_HOVER)
def hover(server: LanguageServer, params: types.HoverParams):
    if (word := server.workspace.get_text_document(params.text_document.uri).word_at_position(params.position)) in hoverMap:
        return types.Hover(contents = types.MarkupContent(kind = types.MarkupKind.PlainText, value = hoverMap[word]))

@server.feature(types.TEXT_DOCUMENT_DID_OPEN)
def didOpen(ls, params: types.DidOpenTextDocumentParams):
    text_doc = ls.workspace.get_text_document(params.text_document.uri)
    server.show_message_log(text_doc.source)

if __name__ == "__main__":
    server.start_io()