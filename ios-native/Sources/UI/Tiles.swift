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
        RoundedRectangle(cornerRadius: 20, style: .continuous)
            .fill(on ? Color.onBase : Color.tile)
            .overlay {
                if on {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(RadialGradient(colors: [tint.opacity((light ? 0.22 : 0.26) + level * 0.16), tint.opacity(light ? 0.07 : 0.04)],
                                             center: UnitPoint(x: 0.1, y: 0.5), startRadius: 4, endRadius: 190))
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
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
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(on ? Color(hex: "#241503") : Color.ink)
            .frame(width: 40, height: 40)
            .background(Circle().fill(on ? tint : Color.fill))
            .shadow(color: on ? tint.opacity(0.55) : .clear, radius: 8)
    }
}

struct LightTile: View {
    let cfg: LightConfig
    var onOpen: () -> Void
    @Environment(HomeStore.self) private var store

    var body: some View {
        let s = store.lights[cfg.id] ?? LightState()
        let tint = RGB.of(s).color
        let status = !s.on ? "Off" : cfg.dimmable ? "\(Int((s.brightness * 100).rounded()))%" : "On"
        HStack(spacing: 10) {
            Bubble(symbol: lampSymbol(cfg.type, plug: cfg.capabilities.isEmpty), on: s.on, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(cfg.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.ink)
                    .lineLimit(1)
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(s.on ? Color.onSub.opacity(0.8) : Color.muted)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }
            // The name opens the light's page; the rest of the tile switches it.
            .contentShape(Rectangle())
            .onTapGesture { if !cfg.capabilities.isEmpty { onOpen() } else { toggle() } }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TileBackground(on: s.on, tint: tint, level: s.brightness))
        .overlay(alignment: .bottomLeading) {
            if cfg.dimmable {
                GeometryReader { g in
                    Capsule().fill(Color.fill).frame(height: 3)
                        .overlay(alignment: .leading) {
                            Capsule().fill(tint).frame(width: s.on ? max(3, (g.size.width) * s.brightness) : 0, height: 3)
                        }
                }
                .frame(height: 3)
                .padding(.horizontal, 14)
                .padding(.bottom, 8)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 20))
        .onTapGesture(perform: toggle)
        .animation(.smooth(duration: 0.25), value: s)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(cfg.name), \(status)")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Settings") { onOpen() }
    }

    private func toggle() {
        Haptics.light()
        store.toggleLight(cfg.id)
    }
}

struct ACTile: View {
    let cfg: ACConfig
    var onOpen: () -> Void
    @Environment(HomeStore.self) private var store

    var body: some View {
        let s = store.acs[cfg.id] ?? ACState()
        let tint = Color(hex: modeColors[s.mode] ?? "#5db2ff")
        HStack(spacing: 10) {
            Bubble(symbol: modeSymbols[s.mode] ?? "air.conditioner.horizontal", on: s.on, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(cfg.name).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(1)
                Text("\(s.on ? modeNames[s.mode] ?? s.mode : "Off") · Room \(Int(s.roomTemp.rounded()))°")
                    .font(.footnote).foregroundStyle(Color.muted).lineLimit(1)
            }
            Spacer(minLength: 4)
            HStack(spacing: 2) {
                Button { step(-1) } label: { Image(systemName: "minus").frame(width: 30, height: 34) }
                    .accessibilityLabel("Cooler")
                Text("\(s.target)°")
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: Double(s.target)))
                    .frame(minWidth: 44)
                Button { step(1) } label: { Image(systemName: "plus").frame(width: 30, height: 34) }
                    .accessibilityLabel("Warmer")
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
        .contentShape(RoundedRectangle(cornerRadius: 20))
        .onTapGesture(perform: onOpen)
        .animation(.smooth(duration: 0.25), value: s)
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
                Text(d?.name ?? "TV").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(1)
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
        .contentShape(RoundedRectangle(cornerRadius: 20))
        .onTapGesture(perform: onOpen)
    }
}
