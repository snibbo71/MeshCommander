import Cocoa

final class MainWindowController: NSWindowController, NSWindowDelegate {
    private let webViewController: WebViewController

    init() {
        webViewController = WebViewController()

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 970, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "MeshCommanderAS"
        window.minSize = NSSize(width: 970, height: 640)
        window.contentViewController = webViewController
        window.center()

        super.init(window: window)
        window.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func windowWillClose(_ notification: Notification) {
        webViewController.prepareForTermination()
    }
}
