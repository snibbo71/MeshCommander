import Cocoa
import WebKit

/// Bridges the JS-side `nw.gui.Menu`/`MenuItem` tree (node-shim.js, talking over the
/// "mcMenu" WKScriptMessageHandler) to a real `NSMenu`. The vendor JS in index.html
/// (`NW_SetupMainMenu`) already builds a complete, correct menu tree using this same
/// Menu/MenuItem API and rebuilds it from scratch on every relevant state change; this
/// just renders that tree natively rather than reimplementing its logic in Swift.
///
/// Index 0 of `NSApp.mainMenu` is the native app menu (About/Hide/Quit), built once by
/// AppDelegate at launch - every rebuild here preserves it and replaces only what follows.
final class MenuBridge: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let op = body["op"] as? String, op == "setMenu",
              let tree = body["tree"] as? [String: Any] else { return }
        DispatchQueue.main.async { [weak self] in
            self?.rebuildMenu(from: tree)
        }
    }

    private func rebuildMenu(from tree: [String: Any]) {
        guard let mainMenu = NSApp.mainMenu else { return }
        while mainMenu.items.count > 1 {
            mainMenu.removeItem(at: mainMenu.items.count - 1)
        }
        let items = (tree["items"] as? [[String: Any]]) ?? []
        for itemDict in items {
            if let menuItem = buildMenuItem(from: itemDict) {
                mainMenu.addItem(menuItem)
            }
        }
    }

    private func buildMenuItem(from dict: [String: Any]) -> NSMenuItem? {
        let type = dict["type"] as? String
        if type == "separator" {
            return NSMenuItem.separator()
        }

        let label = (dict["label"] as? String) ?? ""
        let item = NSMenuItem(title: label, action: nil, keyEquivalent: "")
        item.tag = (dict["id"] as? Int) ?? 0
        item.isEnabled = (dict["enabled"] as? Bool) ?? true
        if type == "checkbox" {
            item.state = ((dict["checked"] as? Bool) ?? false) ? .on : .off
        }

        if let submenuDict = dict["submenu"] as? [String: Any] {
            let submenu = NSMenu(title: label)
            let subItems = (submenuDict["items"] as? [[String: Any]]) ?? []
            for subDict in subItems {
                if let subItem = buildMenuItem(from: subDict) {
                    submenu.addItem(subItem)
                }
            }
            item.submenu = submenu
        } else {
            item.target = self
            item.action = #selector(itemClicked(_:))
        }
        return item
    }

    @objc private func itemClicked(_ sender: NSMenuItem) {
        webView?.evaluateJavaScript("window.__mcMenuClick(\(sender.tag));")
    }
}
