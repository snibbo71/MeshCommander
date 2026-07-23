import Cocoa
import WebKit

final class WebViewController: NSViewController {
    private(set) var webView: WKWebView!
    private var networkBridge: NetworkBridge!
    private var datagramBridge: DatagramBridge!
    private var uiDelegate: WebViewUIDelegate!

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default() // persistent store, so localStorage survives relaunch under file://

        let contentController = WKUserContentController()
        configuration.userContentController = contentController

        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 970, height: 760), configuration: configuration)
        if #available(macOS 13.3, *) {
            webView.isInspectable = true // debug builds only - lets Safari's Web Inspector attach
        }
        self.webView = webView
        self.view = webView

        let bridge = NetworkBridge(webView: webView)
        networkBridge = bridge
        contentController.add(WeakScriptMessageHandler(target: bridge), name: "mcNet")

        let dgramBridge = DatagramBridge(webView: webView)
        datagramBridge = dgramBridge
        contentController.add(WeakScriptMessageHandler(target: dgramBridge), name: "mcDgram")

        // Without a WKUIDelegate implementing the open-panel method, clicking an
        // <input type=file> in a macOS WKWebView does nothing at all - no dialog, no error.
        let delegate = WebViewUIDelegate()
        uiDelegate = delegate
        webView.uiDelegate = delegate
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        guard let url = Bundle.main.url(forResource: "index-mac", withExtension: "html", subdirectory: "Resources") else {
            fatalError("index-mac.html not found in app bundle - did the build-html.js preprocessor run?")
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func prepareForTermination() {
        networkBridge.cancelAll()
        datagramBridge.cancelAll()
    }
}

final class WebViewUIDelegate: NSObject, WKUIDelegate {
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}

/// WKUserContentController.add(_:name:) always retains its handler strongly; this
/// breaks the resulting webView -> contentController -> handler -> webView cycle.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
