import SwiftUI

/// The TV's remote, pushed inside the card (docs/tv-remote.md, docs/card-sheet.md): what's on,
/// the direction pad with the keys and an upright volume beside it, the apps, and a title search.
struct TVRemotePage: View {
    let id: String
    @Environment(HomeStore.self) private var store
    @State private var opening: (app: TVAppInfo, until: Date)?

    private var tv: TVStore { store.tv }

    var body: some View {
        let d = tv.device(id)
        let available = tv.state.available && d?.online == true
        let on = d?.on == true
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if tv.ready && !available {
                    Label(!tv.state.available ? (tv.state.error.isEmpty ? "The TV can’t be reached." : tv.state.error)
                          : "\(d?.name ?? "The TV") isn’t answering. Is it plugged in and on the Wi-Fi?", systemImage: "wifi.slash")
                        .font(.footnote)
                        .foregroundStyle(Color.muted)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.fill))
                }
                if let d, on, let np = d.nowPlaying {
                    NowPlayingCard(device: d, np: np,
                                   onPlayPause: { tv.act(id, action: "playpause") },
                                   onSeek: { await tv.act(id, ["action": .string("seek"), "position": .number($0)]) })
                } else if let d, on, let app = d.app, app.id != "home" {
                    NowOnStrip(app: app) { Haptics.light(); tv.act(id, action: "home") }
                }
                remote(d, on: on, available: available)
                Text("Apps").font(.subheadline.weight(.semibold)).foregroundStyle(Color.muted)
                apps(d, on: on)
                Text("Search").font(.subheadline.weight(.semibold)).foregroundStyle(Color.muted)
                TVSearch(id: id, onPlay: { result, offer in
                    open(TVCatalog.info(id: offer.app) ?? TVAppInfo(id: offer.app, name: offer.name, bg: ["#2b3140"], glow: "#9aa4b5", mark: []), play: offer)
                })
            }
            .padding(.horizontal, 18)
            .padding(.top, 8)
            .padding(.bottom, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(d?.name ?? "TV")
        .navigationSubtitle(status(d))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                PowerToolbarButton(on: on, disabled: !available) { power(d) }
            }
        }
        .onChange(of: d?.app?.id) { _, now in if now == opening?.app.id { opening = nil } }
    }

    private func status(_ d: TVDevice?) -> String {
        if let o = opening, o.until > Date() { return "Opening \(o.app.name)…" }
        guard tv.ready else { return "Connecting…" }
        return d?.status(available: tv.state.available) ?? "Not reachable"
    }

    private func power(_ d: TVDevice?) {
        guard let d, tv.state.available, d.online else {
            store.show(tv.state.error.isEmpty ? "The TV can’t be reached." : tv.state.error, error: true)
            Haptics.error()
            return
        }
        Haptics.medium()
        tv.act(id, action: d.on ? "sleep" : "wake")
    }

    private func key(_ action: String) { tv.act(id, action: action) }

    private func open(_ app: TVAppInfo, play: SearchResult.Offer? = nil) {
        guard tv.state.available else {
            store.show(tv.state.error.isEmpty ? "The TV can’t be reached." : tv.state.error, error: true)
            Haptics.error()
            return
        }
        Haptics.light()
        opening = (app, Date().addingTimeInterval(8))
        var body: [String: JSON] = ["action": .string(play == nil ? "open" : "play"), "app": .string(app.id), "name": .string(app.name)]
        if let play { body["link"] = .string(play.link) }
        Task {
            let ok = await tv.act(id, body)
            if !ok { opening = nil }
        }
    }

    // MARK: - the direction pad, its keys and the volume

    private func remote(_ d: TVDevice?, on: Bool, available: Bool) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(spacing: 10) {
                KeyButton(symbol: "house", label: "Home") { key("home") }
                KeyButton(symbol: "arrow.uturn.backward", label: "Back") { key("back") }
                KeyButton(symbol: "playpause", label: "Play or pause") { key("playpause") }
                KeyButton(symbol: d?.muted == true && on ? "speaker.slash.fill" : "speaker.slash", label: "Mute", active: d?.muted == true && on) { key("mute") }
            }
            DPad(enabled: available && on, onKey: { key($0) }, size: 250)
                .frame(maxWidth: .infinity)
            VolumeColumn(level: d?.volume, max: d?.volumeMax ?? 25, muted: d?.muted == true, enabled: on && d?.volume != nil,
                         onStep: { key($0 > 0 ? "volup" : "voldown") },
                         onLevel: { level in Task { await tv.act(id, ["action": .string("volume"), "level": .number(Double(level))]) } })
        }
        .opacity(available ? 1 : 0.6)
    }

    // MARK: - apps

    private func apps(_ d: TVDevice?, on: Bool) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 12) {
                ForEach(TVCatalog.apps) { app in
                    let current = on && d?.app?.id == app.id
                    let isOpening = opening?.app.id == app.id && (opening?.until ?? .distantPast) > Date()
                    Button { open(app) } label: {
                        VStack(spacing: 6) {
                            AppLogo(app: app, size: 62)
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .strokeBorder(current ? Color.accentColor : Color.line, lineWidth: current ? 3 : 1)
                                    .padding(current ? -4 : 0))
                                .overlay(alignment: .topTrailing) {
                                    if current { Circle().fill(Color.green).frame(width: 10, height: 10).offset(x: 4, y: -4) }
                                }
                                .scaleEffect(isOpening ? 0.94 : 1)
                                .animation(isOpening ? .easeInOut(duration: 0.6).repeatForever() : .default, value: isOpening)
                            Text(app.name).font(.caption2.weight(.medium)).foregroundStyle(Color.muted).lineLimit(1)
                        }
                        .frame(width: 70)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open \(app.name)")
                }
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 2)
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }
}

/// A round key beside the pad.
struct KeyButton: View {
    var symbol: String
    var label: String
    var active = false
    var action: () -> Void
    var body: some View {
        Button {
            Haptics.light()
            action()
        } label: {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 34, height: 34)
                .foregroundStyle(active ? Color.accentColor : Color.ink)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel(label)
    }
}

/// The app that is open, when it doesn't say what it plays.
struct NowOnStrip: View {
    let app: TVApp
    var onHome: () -> Void
    var body: some View {
        let info = TVCatalog.info(for: app)
        HStack(spacing: 12) {
            AppLogo(app: info, size: 40).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text("Now on").font(.caption).foregroundStyle(Color.muted)
                Text(app.id == "other" ? app.name : info.name).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(1)
            }
            Spacer()
            Button(action: onHome) { Image(systemName: "house").font(.system(size: 15, weight: .semibold)).frame(width: 28, height: 28) }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Home screen")
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.fill))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color(hex: info.glow).opacity(0.35)))
    }
}

/// The upright volume beside the pad: + at the top, the level rising from the bottom, − at the
/// foot. Held, + and − repeat; dragging the level sets it when let go.
struct VolumeColumn: View {
    var level: Int?
    var max: Int
    var muted: Bool
    var enabled: Bool
    var onStep: (Int) -> Void
    var onLevel: (Int) -> Void
    @State private var dragging: Int?

    var body: some View {
        let shown = dragging ?? level ?? 0
        let t = max > 0 ? CGFloat(shown) / CGFloat(max) : 0
        VStack(spacing: 6) {
            RepeatKey(symbol: "plus", label: "Volume up") { onStep(1) }
            GeometryReader { g in
                ZStack(alignment: .bottom) {
                    Capsule().fill(Color.fill)
                    Capsule().fill(Color.accentColor.opacity(muted ? 0.35 : 0.85))
                        .frame(height: Swift.max(0, g.size.height * t))
                    VStack(spacing: 4) {
                        Image(systemName: muted ? "speaker.slash.fill" : "speaker.wave.2.fill").font(.system(size: 12, weight: .bold))
                        Text(enabled ? "\(shown)" : "–").font(.caption.weight(.bold)).monospacedDigit()
                    }
                    .foregroundStyle(t > 0.25 ? Color.white : Color.ink)
                    .padding(.bottom, 10)
                }
                .clipShape(Capsule())
                .contentShape(Capsule())
                .onTouch { phase, p in
                    guard enabled else { return }
                    let v = Int((Swift.min(1, Swift.max(0, 1 - p.y / g.size.height)) * CGFloat(max)).rounded())
                    switch phase {
                    case .began, .moved:
                        if v != dragging { if dragging != nil { Haptics.tick() }; dragging = v }
                    case .ended:
                        if v != level { onLevel(v) }
                        dragging = nil
                    case .cancelled:
                        dragging = nil
                    }
                }
            }
            RepeatKey(symbol: "minus", label: "Volume down") { onStep(-1) }
        }
        .frame(width: 50, height: 250)
        .opacity(enabled ? 1 : 0.45)
        .allowsHitTesting(enabled)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Volume")
        .accessibilityValue("\(shown) of \(max)")
    }
}

/// − or +: one step on a press, then (held 300 ms) another every 120 ms.
struct RepeatKey: View {
    var symbol: String
    var label: String
    var onStep: () -> Void
    @State private var timer: Task<Void, Never>?

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(Color.ink)
            .frame(width: 44, height: 44)
            .glassEffect(.regular.interactive(), in: .circle)
            .onTouch { phase, _ in
                switch phase {
                case .began:
                    Haptics.tick()
                    onStep()
                    timer?.cancel()
                    timer = Task {
                        try? await Task.sleep(for: .milliseconds(300))
                        while !Task.isCancelled {
                            Haptics.tick()
                            onStep()
                            try? await Task.sleep(for: .milliseconds(120))
                        }
                    }
                case .moved: break
                case .ended, .cancelled:
                    timer?.cancel()
                    timer = nil
                }
            }
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { onStep() }
    }
}
