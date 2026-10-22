import SwiftUI

/// The look shared by every tile: a soft card, lit from its icon by its own colour when on
/// (a warm tint in the light look, a glow in the dark one).
struct TileBackground: View {
    var on: Bool
    var tint: Color
    var level: Double = 1
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let light = scheme == .light
        RoundedRectangle(cornerRadius: 26, style: .continuous)
            .fill(on ? Color.onBase : Color.tile)
            .overlay {
                if on {
                    RoundedRectangle(cornerRadius: 26, style: .continuous)
                        .fill(RadialGradient(colors: [tint.opacity((light ? 0.22 : 0.26) + level * 0.16), tint.opacity(light ? 0.07 : 0.04)],
                                             center: UnitPoint(x: 0.1, y: 0.5), startRadius: 4, endRadius: 190))
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .strokeBorder(on ? tint.opacity(light ? 0.46 : 0.28) : Color.line, lineWidth: 1)
            }
            .shadow(color: on && light ? tint.opacity(0.18) : .clear, radius: 10, y: 4)
    }
}

struct Bubble: View {
    var symbol: String
    var on: Bool
    var tint: Color
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 18, weight: .regular))
            .foregroundStyle(on ? Color(hex: "#241503") : Color.ink)
            .frame(width: 40, height: 40)
            .background(Circle().fill(on ? tint : Color.fill))
            .shadow(color: on ? tint.opacity(0.55) : .clear, radius: 8)
    }
}

/// A lamp's tile: a tap switches it, a slide sideways sets its brightness (from off it turns it
/// on); held and let go it opens the lamp's page, held and dragged it moves (RoomSection).
struct LightTile: View {
    let cfg: LightConfig
    var onOpen: () -> Void
    @Environment(HomeStore.self) private var store
    @State private var width: CGFloat = 160
    @State private var slide: (start: Double, step: Int)?

    var body: some View {
        let s = store.lights[cfg.id] ?? LightState()
        let tint = RGB.of(s).color
        let level = s.on ? s.brightness : 0
        let status = !s.on ? "Off" : cfg.dimmable ? "\(Int((s.brightness * 100).rounded()))%" : "On"
        HStack(spacing: 10) {
            Bubble(symbol: lampSymbol(cfg.type, plug: cfg.capabilities.isEmpty), on: s.on, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(cfg.name)
                    .font(.house(16))
                    .foregroundStyle(Color.ink)
                    .lineLimit(1)
                Text(status)
                    .font(slide != nil ? .footnote.weight(.bold) : .footnote)
                    .foregroundStyle(s.on ? Color.onSub.opacity(0.8) : Color.muted)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            ZStack(alignment: .leading) {
                TileBackground(on: s.on, tint: tint, level: s.brightness)
                // The level as a fill across the tile (stronger while sliding).
                if cfg.dimmable && s.on {
                    RoundedRectangle(cornerRadius: 26, style: .continuous)
                        .fill(tint.opacity(slide != nil ? 0.26 : 0.1))
                        .frame(width: max(0, width * level))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                }
            }
        }
        .overlay(alignment: .bottomLeading) {
            if cfg.dimmable {
                Capsule().fill(Color.fill).frame(height: 3)
                    .overlay(alignment: .leading) {
                        Capsule().fill(tint).frame(width: max(0, (width - 28) * level), height: 3)
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 8)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = max(40, $0) }
        .contentShape(RoundedRectangle(cornerRadius: 26))
        .onTapGesture(perform: toggle)
        .gesture(SlideGesture(onBegin: {
            guard cfg.dimmable else { return }
            TileGuard.lifted = true
            let cur = store.lights[cfg.id] ?? LightState()
            slide = (cur.on ? cur.brightness : 0, Int(((cur.on ? cur.brightness : 0) * 20).rounded()))
        }, onChange: { dx in
            guard let sl = slide else { return }
            let b = min(1, max(0, sl.start + Double(dx / max(40, width))))
            let step = Int((b * 20).rounded())      // a tick every 5 %
            if step != sl.step { Haptics.tick(); slide?.step = step }
            store.setLight(cfg.id, b < 0.04 ? LightPatch(on: false) : LightPatch(on: true, brightness: max(0.05, b)))
        }, onEnd: {
            if slide != nil { TileGuard.lifted = false; TileGuard.droppedAt = Date() }
            slide = nil
        }))
        .animation(slide != nil ? nil : .smooth(duration: 0.25), value: s)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(cfg.name), \(status)")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Settings") { onOpen() }
        .accessibilityAdjustableAction { dir in
            guard cfg.dimmable else { return }
            store.setLight(cfg.id, LightPatch(on: true, brightness: s.brightness + (dir == .increment ? 0.1 : -0.1)))
        }
    }

    private func toggle() {
        guard TileGuard.allowsTap else { return }
        Haptics.light()
        store.toggleLight(cfg.id)
    }
}

/// The AC's tile: a tap opens its controls, a slide sideways sets the temperature (a degree every 24 pt,
/// shown big while sliding); held and let go it opens the AC's page.
struct ACTile: View {
    let cfg: ACConfig
    var onOpen: () -> Void
    @Environment(HomeStore.self) private var store
    @State private var slide: (start: Int, value: Int)?

    var body: some View {
        let s = store.acs[cfg.id] ?? ACState()
        let tint = Color(hex: modeColors[s.mode] ?? "#5db2ff")
        HStack(spacing: 10) {
            Bubble(symbol: modeSymbols[s.mode] ?? "air.conditioner.horizontal", on: s.on, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(cfg.name).font(.house(16)).foregroundStyle(Color.ink).lineLimit(1)
                Text("\(s.on ? modeNames[s.mode] ?? s.mode : "Off") · Room \(Int(s.roomTemp.rounded()))°")
                    .font(.footnote).foregroundStyle(Color.muted).lineLimit(1)
            }
            Spacer(minLength: 4)
            HStack(spacing: 2) {
                Button { step(-1) } label: { Image(systemName: "minus").frame(width: 30, height: 34) }
                    .accessibilityLabel("Cooler")
                    .opacity(slide == nil ? 1 : 0)
                Text("\(slide?.value ?? s.target)°")
                    .font(slide != nil ? .system(size: 30, weight: .bold, design: .rounded) : .house(24, weight: .light))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: Double(slide?.value ?? s.target)))
                    .frame(minWidth: 44)
                Button { step(1) } label: { Image(systemName: "plus").frame(width: 30, height: 34) }
                    .accessibilityLabel("Warmer")
                    .opacity(slide == nil ? 1 : 0)
            }
            .buttonStyle(.plain)
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(Color.ink)
            PowerDot(on: s.on, tint: tint) {
                Haptics.medium()
                store.setAC(cfg.id, ["on": .bool(!s.on)])
            }
            .accessibilityLabel("\(cfg.name) power")
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TileBackground(on: s.on, tint: tint))
        .contentShape(RoundedRectangle(cornerRadius: 26))
        .onTapGesture {
            guard TileGuard.allowsTap else { return }
            Haptics.light()
            onOpen()
        }
        .gesture(SlideGesture(onBegin: {
            TileGuard.lifted = true
            let t = (store.acs[cfg.id] ?? ACState()).target
            slide = (t, t)
        }, onChange: { dx in
            guard let sl = slide else { return }
            let v = min(cfg.max, max(cfg.min, sl.start + Int((dx / 24).rounded(.towardZero))))
            if v != sl.value {
                Haptics.tick()
                withAnimation(.snappy(duration: 0.15)) { slide?.value = v }
                store.setAC(cfg.id, ["on": .bool(true), "target": .number(Double(v))])
            }
        }, onEnd: {
            if slide != nil { TileGuard.lifted = false; TileGuard.droppedAt = Date() }
            withAnimation(.snappy) { slide = nil }
        }))
        .animation(.smooth(duration: 0.25), value: s)
        .accessibilityAction(named: "Settings") { onOpen() }
    }

    private func step(_ d: Int) {
        Haptics.tick()
        let s = store.acs[cfg.id] ?? ACState()
        store.setAC(cfg.id, ["on": .bool(true), "target": .number(Double(s.target + d))])
    }
}

struct PowerDot: View {
    var on: Bool
    var tint: Color
    var disabled = false
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "power")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(on ? Color(hex: "#241503") : Color.ink)
                .frame(width: 38, height: 38)
                .background(Circle().fill(on ? tint : Color.fill))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }
}

struct TVTile: View {
    let tile: Tile
    var onOpen: () -> Void
    @Environment(HomeStore.self) private var store
    @State private var width: CGFloat = 340
    @State private var slide: (start: Int, value: Int, max: Int)?

    var body: some View {
        let tv = store.tv
        let d = tv.device(tile.deviceID)
        let on = d?.on == true
        let app = on ? d?.app : nil
        let known = app.flatMap { $0.id == "other" ? nil : $0 }
        let info = TVCatalog.info(for: app)
        let tint = on ? Color(hex: info.glow) : Color.warm
        let status = d?.status(available: tv.state.available) ?? (tv.ready ? "Not reachable" : "Connecting…")
        let title = on ? d?.nowPlaying?.title : nil
        HStack(spacing: 10) {
            if let known {
                AppLogo(app: TVCatalog.info(for: known), size: 40)
                    .clipShape(Circle())
                    .shadow(color: tint.opacity(0.5), radius: 8)
            } else {
                Bubble(symbol: "tv", on: on, tint: tint)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(d?.name ?? "TV").font(.house(16)).foregroundStyle(Color.ink).lineLimit(1)
                Text(title.map { "\(status) · \($0)" } ?? status)
                    .font(.footnote).foregroundStyle(Color.muted).lineLimit(1)
            }
            Spacer(minLength: 4)
            PowerDot(on: on, tint: tint, disabled: !tv.state.available) {
                guard let d, tv.state.available, d.online else {
                    store.show(tv.state.error.isEmpty ? "The TV can’t be reached." : tv.state.error, error: true)
                    Haptics.error()
                    return
                }
                Haptics.medium()
                tv.act(tile.deviceID, action: d.on ? "sleep" : "wake")
            }
            .accessibilityLabel("TV power")
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TileBackground(on: on, tint: tint))
        .contentShape(RoundedRectangle(cornerRadius: 26))
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = max(40, $0) }
        .onTapGesture { if TileGuard.allowsTap { Haptics.light(); onOpen() } }
        .overlay(alignment: .bottomLeading) {
            if on, let v = slide?.value ?? d?.volume {
                Capsule().fill(tint.opacity(0.7))
                    .frame(width: max(0, (width - 28) * CGFloat(v) / CGFloat(max(1, d?.volumeMax ?? 100))), height: 3)
                    .padding(.horizontal, 14).padding(.bottom, 6)
            }
        }
        .overlay(alignment: .trailing) {
            if let slide {
                Text("\(Int((Double(slide.value) / Double(slide.max) * 100).rounded()))%")
                    .font(.title2.weight(.light)).monospacedDigit()
                    .padding(12).background(.regularMaterial, in: Capsule()).padding(.trailing, 54)
                    .allowsHitTesting(false)
            }
        }
        .gesture(SlideGesture(onBegin: {
            guard let d = tv.device(tile.deviceID), d.on, d.online, let v = d.volume else { return }
            TileGuard.lifted = true
            slide = (v, v, max(1, d.volumeMax ?? 100))
        }, onChange: { dx in
            guard let sl = slide else { return }
            let value = min(sl.max, max(0, sl.start + Int((Double(dx / width) * Double(sl.max)).rounded())))
            guard value != sl.value else { return }
            Haptics.tick()
            slide?.value = value
            tv.setVolume(tile.deviceID, level: value)
        }, onEnd: {
            if slide != nil { TileGuard.lifted = false; TileGuard.droppedAt = Date() }
            slide = nil
        }))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onOpen() }
        .accessibilityAction(named: "Remote") { onOpen() }
        .accessibilityAdjustableAction { dir in
            if d?.on == true { tv.act(tile.deviceID, action: dir == .increment ? "volup" : "voldown") }
        }
    }

    private func power() {
        let tv = store.tv
        guard let d = tv.device(tile.deviceID), tv.state.available, d.online else {
            store.show(tv.state.error.isEmpty ? "The TV can’t be reached." : tv.state.error, error: true)
            Haptics.error()
            return
        }
        Haptics.medium()
        tv.act(tile.deviceID, action: d.on ? "sleep" : "wake")
    }
}
