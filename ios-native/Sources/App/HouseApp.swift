import SwiftUI

@main
struct HouseApp: App {
    @State private var hub: HubClient
    @State private var store: HomeStore
    @State private var theme = ThemeStore()
    @State private var card = CardModel()
    @Environment(\.scenePhase) private var phase

    init() {
        let hub = HubClient()
        _hub = State(initialValue: hub)
        _store = State(initialValue: HomeStore(hub: hub))
    }

    var body: some Scene {
        WindowGroup {
            HomeScreen()
                .environment(store)
                .environment(hub)
                .environment(theme)
                .environment(card)
                .preferredColorScheme(theme.colorScheme)
                .onOpenURL { card.open(url: $0, store: store, theme: theme) }
                .onAppear { card.applyLaunchArguments(store: store, theme: theme) }
        }
        .onChange(of: phase, initial: true) { _, now in
            // Keep the hub's events only while the app is on screen.
            if now == .active { hub.resume() } else if now == .background { hub.suspend() }
        }
    }
}
