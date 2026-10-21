import SwiftUI
import WebKit

/// The home editor (rooms, lamps, furniture, links to the real devices): the panel's own editor,
/// served by the hub the app is connected to (`?mode=editor`). Its Save goes through that hub's
/// savePlan, which the other hub picks up too; the app reloads the plan when the editor closes.
/// The editor's own Done leads back to the panel's page, which closes this screen instead.
struct EditorScreen: View {
    let base: URL
    var onClose: () -> Void

    var body: some View {
        EditorWeb(url: editorURL, onLeave: onClose)
            .ignoresSafeArea(edges: .bottom)
            .background(Color.black)
    }

    private var editorURL: URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.path = "/"
        c.queryItems = [URLQueryItem(name: "mode", value: "editor"), URLQueryItem(name: "platform", value: "ios")]
        return c.url!
    }
}

private struct EditorWeb: UIViewRepresentable {
    let url: URL
    var onLeave: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onLeave: onLeave) }

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let onLeave: () -> Void
        init(onLeave: @escaping () -> Void) { self.onLeave = onLeave }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard action.targetFrame?.isMainFrame != false, let url = action.request.url else { return .allow }
            let mode = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "mode" }?.value
            if webView.url != nil, mode != "editor" {
                await MainActor.run { onLeave() }
                return .cancel
            }
            return .allow
        }
    }
}
