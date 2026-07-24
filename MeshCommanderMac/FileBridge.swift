import Cocoa
import WebKit

/// Bridges the JS-side file-save shim (node-shim.js, talking over the "mcFile"
/// WKScriptMessageHandler) to a real NSSavePanel + filesystem write. Backs
/// File > Save Computers... - the vendor's saveComputerListOk() (index.html)
/// clicks a `<input type=file nwsaveas="...">` (an NW.js-proprietary attribute
/// meaningless to real WebKit) and then calls require('fs').writeFile() with
/// the path that click is expected to have stuffed into the input's `value`.
/// node-shim.js intercepts both of those points; this is the native side of it.
final class FileBridge: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String, let reqId = body["reqId"] as? Int else { return }
        switch op {
        case "savePanel":
            let suggestedName = (body["suggestedName"] as? String) ?? "untitled"
            handleSavePanel(reqId: reqId, suggestedName: suggestedName)
        case "writeFile":
            guard let path = body["path"] as? String, let base64 = body["dataB64"] as? String else { return }
            handleWriteFile(reqId: reqId, path: path, base64: base64)
        default:
            break
        }
    }

    private func handleSavePanel(reqId: Int, suggestedName: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = suggestedName
            panel.canCreateDirectories = true
            let completion: (NSApplication.ModalResponse) -> Void = { response in
                self.replySavePanel(reqId: reqId, path: (response == .OK) ? panel.url?.path : nil)
            }
            if let window = self.webView?.window {
                panel.beginSheetModal(for: window, completionHandler: completion)
            } else {
                panel.begin(completionHandler: completion)
            }
        }
    }

    private func replySavePanel(reqId: Int, path: String?) {
        let pathArg = path.map { jsonStringLiteral($0) } ?? "null"
        webView?.evaluateJavaScript("window.__mcFileSaveCallback(\(reqId), \(pathArg));", completionHandler: nil)
    }

    private func handleWriteFile(reqId: Int, path: String, base64: String) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            var errorMessage: String?
            if let data = Data(base64Encoded: base64) {
                do {
                    try data.write(to: URL(fileURLWithPath: path))
                } catch {
                    errorMessage = String(describing: error)
                }
            } else {
                errorMessage = "invalid base64 data"
            }
            DispatchQueue.main.async {
                let errArg = errorMessage.map { self.jsonStringLiteral($0) } ?? "null"
                self.webView?.evaluateJavaScript("window.__mcFileWriteCallback(\(reqId), \(errArg));", completionHandler: nil)
            }
        }
    }

    /// Safely quotes/escapes an arbitrary Swift string for inlining into evaluateJavaScript
    /// source, by round-tripping it through JSONSerialization (wrapped in an array, since
    /// a bare string isn't valid top-level JSON) and stripping the array brackets back off.
    private func jsonStringLiteral(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s]),
              let json = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(json.dropFirst().dropLast())
    }
}
