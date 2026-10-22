import SwiftUI

/// What the sheet holds: the home page, and the light, AC and TV pages pushed inside it.
struct ControlsCard: View {
    @Environment(CardModel.self) private var card

    var body: some View {
        @Bindable var card = card
        NavigationStack(path: $card.path) {
            HomeCard()
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .light(let id): LightPage(id: id)
                    case .ac(let id): ACPage(id: id)
                    case .tv(let id): TVRemotePage(id: id)
                    case .speaker: SpotifyPage()
                    case .scene(let id): ScenePage(id: id)
                    case .settings: SettingsPage()
                    }
                }
        }
        .background(alignment: .top) {
            SheetProbe { card.sheetMoved(top: $0) }
                .frame(height: 1)
                .allowsHitTesting(false)
        }
    }
}

/// The home page of the card: the header, the scenes and every room with its tiles.
struct HomeCard: View {
    @Environment(HomeStore.self) private var store
    @Environment(CardModel.self) private var card

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                CardHeader()
                ScenesRow()
                if card.arrangingRooms {
                    RoomArranger()
                } else {
                    ForEach(store.orderedRooms) { room in
                        let tiles = store.tiles(in: room.id)
                        if !tiles.isEmpty { RoomSection(room: room, tiles: tiles) }
                    }
                    Text("Tap a light to switch it, or AC and TV to open controls. Slide to dim, set temperature or volume. Hold and drag devices or presets to reorder; hold a preset to edit or delete.")
                        .font(.footnote)
                        .foregroundStyle(Color.faint)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                        .padding(.top, 4)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .toolbar(.hidden, for: .navigationBar)
    }
}

/// The card's header: the home's name and what is on, the look, putting rooms in order, and
/// everything off (or on).
struct CardHeader: View {
    @Environment(HomeStore.self) private var store
    @Environment(HubClient.self) private var hub
    @Environment(ThemeStore.self) private var theme
    @Environment(CardModel.self) private var card
    @Environment(\.colorScheme) private var scheme
    @State private var themeNote: String?
    @State private var noteTask: Task<Void, Never>?
    @State private var editing = false

    var body: some View {
        let on = store.lightsOn
        let total = store.plan.lights.count
        let ac = store.plan.acs.compactMap { store.acs[$0.id] }.first { $0.on }
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(store.plan.name)
                    .font(.house(26, weight: .light))
                    .foregroundStyle(Color.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if case .offline = hub.link {
                    Label("Hub not reachable · last known state", systemImage: "wifi.slash")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.warm)
                        .lineLimit(1)
                        .onTapGesture { card.open(.settings) }
                } else {
                HStack(spacing: 6) {
                    Circle()
                        .fill(store.anyOn ? Color.green : Color.idle)
                        .frame(width: 7, height: 7)
                        .shadow(color: store.anyOn ? .green.opacity(0.7) : .clear, radius: 4)
                    Text("\(Text(on > 0 ? "\(on) of \(total)" : "No").bold()) lights on\(ac.map { " · AC \($0.target)°" } ?? "")")
                        .font(.subheadline)
                        .foregroundStyle(Color.muted)
                        .lineLimit(1)
                }
                if hub.onBackup, case .connected = hub.link {
                    Label(hub.which, systemImage: "arrow.triangle.branch")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.warm)
                        .lineLimit(1)
                        .onTapGesture { card.open(.settings) }
                }
                }
            }
            Spacer(minLength: 4)
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    Button {
                        Haptics.light()
                        theme.cycle()
                        announceTheme()
                    } label: {
                        Image(systemName: theme.choice.symbol)
                            .font(.system(size: 17, weight: .semibold))
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("Appearance: \(theme.choice.name). Change")

                    Button {
                        Haptics.medium()
                        withAnimation(.snappy) { card.arrangingRooms.toggle() }
                    } label: {
                        Image(systemName: card.arrangingRooms ? "checkmark" : "arrow.up.arrow.down")
                            .font(.system(size: 16, weight: .semibold))
                            .frame(width: 26, height: 26)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel(card.arrangingRooms ? "Done putting rooms in order" : "Put rooms in order")

                    Button {
                        Haptics.heavy()
                        store.toggleEverything()
                    } label: {
                        Image(systemName: "power")
                            .font(.system(size: 22, weight: .bold))
                            .frame(width: 38, height: 38)
                            .foregroundStyle(store.anyOn ? Color.stage : Color.ink)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .tint(store.anyOn ? Color.accentColor : Color.fillHi)
                    .accessibilityLabel("Everything on or off")

                    Menu {
                        Button("Edit home…", systemImage: "pencil.and.ruler") {
                            Haptics.medium()
                            editing = true
                        }
                        .disabled(hub.baseURL == nil)
                        Button("Hub addresses", systemImage: "network") { card.open(.settings) }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 16, weight: .semibold))
                            .frame(width: 22, height: 26)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("More")
                }
            }
        }
        .fullScreenCover(isPresented: $editing, onDismiss: { store.refreshPlan() }) {
            if let base = hub.baseURL {
                EditorScreen(base: base) { editing = false }
            }
        }
        .overlay(alignment: .topTrailing) {
            if let note = themeNote {
                Label(note, systemImage: theme.choice.symbol)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .glassEffect(.regular, in: .capsule)
                    .offset(y: -30)
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
            }
        }
    }

    private func announceTheme() {
        let look = scheme == .light ? "light" : "dark"
        withAnimation(.snappy) {
            themeNote = theme.choice == .auto ? "Automatic · \(look) now" : "\(theme.choice.name) appearance"
        }
        noteTask?.cancel()
        noteTask = Task {
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            withAnimation(.smooth) { themeNote = nil }
        }
    }
}

/// Lets a button switch between two primitive styles.
struct AnyPrimitiveButtonStyle: PrimitiveButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: PrimitiveButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}
