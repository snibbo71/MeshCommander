import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var mainWindowController: MainWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Built once, permanently owns index 0 of NSApp.mainMenu - MenuBridge preserves
        // this item and only replaces everything after it on every JS-driven rebuild.
        buildAppMenu()

        let controller = MainWindowController()
        mainWindowController = controller
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    // MARK: - Native app menu

    private func buildAppMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)

        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu

        let aboutItem = appMenu.addItem(withTitle: "About MeshCommanderAS", action: #selector(showAboutPanel), keyEquivalent: "")
        aboutItem.target = self

        appMenu.addItem(NSMenuItem.separator())

        let hideItem = appMenu.addItem(withTitle: "Hide MeshCommanderAS", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        hideItem.target = NSApp
        let hideOthersItem = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthersItem.keyEquivalentModifierMask = [.command, .option]
        hideOthersItem.target = NSApp
        let showAllItem = appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        showAllItem.target = NSApp

        appMenu.addItem(NSMenuItem.separator())

        let quitItem = appMenu.addItem(withTitle: "Quit MeshCommanderAS", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.target = NSApp

        NSApp.mainMenu = mainMenu
    }

    @objc private func showAboutPanel() {
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.alignment = .center
        let bodyAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11),
            .paragraphStyle: paragraphStyle,
        ]

        let credits = NSMutableAttributedString(string: "Copyright Intel Corporation\n\n", attributes: bodyAttrs)
        credits.append(NSAttributedString(string: "Original project:\n", attributes: bodyAttrs))
        credits.append(linkAttributedString(text: "github.com/Ylianst/MeshCommander", url: "https://github.com/Ylianst/MeshCommander", attrs: bodyAttrs))
        credits.append(NSAttributedString(string: "\n\nThis fork:\n", attributes: bodyAttrs))
        credits.append(linkAttributedString(text: "github.com/snibbo71/MeshCommander", url: "https://github.com/snibbo71/MeshCommander", attrs: bodyAttrs))

        NSApp.orderFrontStandardAboutPanel(options: [
            .credits: credits,
            .applicationName: "MeshCommanderAS",
        ])
    }

    private func linkAttributedString(text: String, url: String, attrs: [NSAttributedString.Key: Any]) -> NSAttributedString {
        var linkAttrs = attrs
        linkAttrs[.link] = URL(string: url)
        return NSAttributedString(string: text, attributes: linkAttrs)
    }
}
