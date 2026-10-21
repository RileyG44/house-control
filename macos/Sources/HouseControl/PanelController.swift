import AppKit
import WebKit

private final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// The borderless popover under the menu bar icon. The web content draws the card
/// itself on a fully transparent window, over a Liquid Glass sheet cut to the card's
/// shape (a vibrant blur before macOS 26).
final class PanelController: NSObject, NSWindowDelegate {
    private static let card = NSSize(width: 440, height: 800)
    // Transparent margin around the card, matching `html.native #app` padding in style.css.
    private static let padTop: CGFloat = 13, padSide: CGFloat = 24, padBottom: CGFloat = 34

    let host: WebHost
    private let window: FloatingPanel
    private var glass: NSView?
    private var outsideClickMonitor: Any?
    private(set) var isVisible = false
    private var lastHide = Date.distantPast
    var onVisibilityChange: ((Bool) -> Void)?
    /// Keeps the panel open when it loses focus (HOUSE_PIN=1, for UI automation and screenshots).
    private let pinned = ProcessInfo.processInfo.environment["HOUSE_PIN"] != nil

    init(host: WebHost) {
        self.host = host
        let size = NSSize(width: Self.card.width + Self.padSide * 2, height: Self.card.height + Self.padTop + Self.padBottom)
        window = FloatingPanel(contentRect: NSRect(origin: .zero, size: size),
                               styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
                               backing: .buffered, defer: false)
        super.init()
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .popUpMenu
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        window.isMovable = false
        window.hidesOnDeactivate = false
        window.animationBehavior = .none
        window.delegate = self
        let (content, glass) = Self.onGlass(host.webView, size: size)
        window.contentView = content
        self.glass = glass
        window.alphaValue = 0
    }

    /// The web view over a glass sheet that sits exactly behind the card (`.card` in
    /// style.css, radius 34), inside the window's transparent margin.
    private static func onGlass(_ webView: NSView, size: NSSize) -> (NSView, NSView) {
        let root = NSView(frame: NSRect(origin: .zero, size: size))
        let glass: NSView
        if #available(macOS 26.0, *) {
            let view = NSGlassEffectView()
            view.cornerRadius = 34
            view.tintColor = tint(light: false)
            glass = view
        } else {
            let view = NSVisualEffectView()
            view.material = .hudWindow
            view.blendingMode = .behindWindow
            view.state = .active
            view.wantsLayer = true
            view.layer?.cornerRadius = 34
            view.layer?.masksToBounds = true
            glass = view
        }
        glass.frame = NSRect(x: padSide, y: padBottom, width: size.width - padSide * 2, height: size.height - padTop - padBottom)
        glass.autoresizingMask = [.width, .height]
        webView.frame = root.bounds
        webView.autoresizingMask = [.width, .height]
        root.addSubview(glass)
        root.addSubview(webView)
        return (root, glass)
    }

    private static func tint(light: Bool) -> NSColor {
        light ? NSColor(calibratedRed: 0.98, green: 0.96, blue: 0.93, alpha: 0.35)
              : NSColor(calibratedRed: 0.03, green: 0.05, blue: 0.1, alpha: 0.3)
    }

    /// The panel's look (`theme` from ui/theme.js): `choice` is "auto", "light" or "dark",
    /// `look` what the page shows. The window takes the choice, so the page's Auto follows
    /// the system; the glass takes a tint that suits the look.
    func setTheme(choice: String, look: String) {
        switch choice {
        case "light": window.appearance = NSAppearance(named: .aqua)
        case "dark": window.appearance = NSAppearance(named: .darkAqua)
        default: window.appearance = nil
        }
        if #available(macOS 26.0, *), let glass = glass as? NSGlassEffectView {
            glass.tintColor = Self.tint(light: look == "light")
        }
    }

    func toggle(below button: NSStatusBarButton) {
        if isVisible { hide(); return }
        // The click that dismissed the panel (resign key) must not immediately reopen it.
        if Date().timeIntervalSince(lastHide) < 0.25 { return }
        show(below: button)
    }

    func show(below button: NSStatusBarButton) {
        guard let buttonWindow = button.window else { return }
        let anchor = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let screen = buttonWindow.screen ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

        var size = window.frame.size
        size.height = min(Self.card.height + Self.padTop + Self.padBottom, visible.height - 4)
        var x = anchor.midX - size.width / 2
        x = max(visible.minX + 4 - Self.padSide, min(x, visible.maxX - size.width - 4 + Self.padSide))
        let y = anchor.minY - size.height + 3
        window.setFrame(NSRect(x: x.rounded(), y: y.rounded(), width: size.width, height: size.height), display: true)

        host.call("setNotch", Double(anchor.midX - x - Self.padSide))
        host.call("shown")

        isVisible = true
        window.alphaValue = 0
        window.makeKeyAndOrderFront(nil)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.16
            window.animator().alphaValue = 1
        }
        if !pinned {
            outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                self?.hide()
            }
        }
        onVisibilityChange?(true)
    }

    func hide() {
        guard isVisible else { return }
        isVisible = false
        lastHide = Date()
        if let monitor = outsideClickMonitor { NSEvent.removeMonitor(monitor) }
        outsideClickMonitor = nil
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.12
            window.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self, !self.isVisible else { return }
            self.window.orderOut(nil)
            self.host.call("hidden")
        })
        onVisibilityChange?(false)
    }

    func windowDidResignKey(_ notification: Notification) {
        if !pinned { hide() }
    }
}
