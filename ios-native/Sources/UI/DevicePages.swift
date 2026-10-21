import SwiftUI

private let dimColors = [Color(hex: "#4a4f5e"), Color(hex: "#b9a98c"), Color(hex: "#ffe2b0")]
private let kelvinColors = [Color(hex: "#ff9438"), Color(hex: "#ffbd7a"), Color(hex: "#ffe2c2"), Color(hex: "#dfe9ff")]
private let tempColors = [Color(hex: "#2f7df6"), Color(hex: "#58b4f5"), Color(hex: "#f3e2c0"), Color(hex: "#f6a54a"), Color(hex: "#f0762c")]
private let swatches = ["#ff5a4f", "#ff9a3c", "#ffd84a", "#5fe08a", "#42d6e8", "#4f8dff", "#8b5cff", "#ff5fc4"]

/// A big number that rolls to its new value.
struct BigReadout: View {
    var value: Int
    var unit: String
    var off: Bool
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 2) {
            Text("\(value)")
                .font(.system(size: 64, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .contentTransition(.numericText(value: Double(value)))
            Text(unit).font(.title2.weight(.semibold)).foregroundStyle(Color.muted)
        }
        .foregroundStyle(off ? Color.faint : Color.ink)
        .animation(.snappy, value: value)
    }
}

struct RoundIcon: View {
    var symbol: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 16, weight: .semibold)).frame(width: 30, height: 30)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
    }
}

struct PowerToolbarButton: View {
    var on: Bool
    var disabled = false
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "power").font(.system(size: 15, weight: .bold))
        }
        .tint(on ? Color.accentColor : nil)
        .buttonStyle(on ? AnyPrimitiveButtonStyle(.glassProminent) : AnyPrimitiveButtonStyle(.glass))
        .disabled(disabled)
        .accessibilityLabel("Power")
    }
}

// MARK: - a lamp

struct LightPage: View {
    let id: String
    @Environment(HomeStore.self) private var store

    var body: some View {
        if let cfg = store.lightConfig(id) {
            let s = store.lights[id] ?? LightState()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack {
                        BigReadout(value: cfg.dimmable ? Int((s.brightness * 100).rounded()) : (s.on ? 100 : 0), unit: "%", off: !s.on)
                        Spacer()
                        Circle()
                            .fill(s.on ? RGB.of(s).color : Color.fill)
                            .frame(width: 54, height: 54)
                            .shadow(color: s.on ? RGB.of(s).color.opacity(0.7) : .clear, radius: 14)
                            .overlay(Image(systemName: lampSymbol(cfg.type)).font(.title3.weight(.semibold))
                                .foregroundStyle(s.on ? Color(hex: "#241503") : Color.muted))
                    }
                    if cfg.dimmable {
                        HStack(spacing: 10) {
                            RoundIcon(symbol: "sun.min") { Haptics.tick(); store.setLight(id, LightPatch(on: true, brightness: s.brightness - 0.1)) }
                            GradientSlider(value: (s.brightness * 100).rounded(), range: 5...100, step: 1, detent: 5, colors: dimColors) {
                                store.setLight(id, LightPatch(on: true, brightness: $0 / 100))
                            }
                            RoundIcon(symbol: "sun.max") { Haptics.tick(); store.setLight(id, LightPatch(on: true, brightness: s.brightness + 0.1)) }
                        }
                    }
                    if cfg.hasTemp {
                        label("Colour temperature", s.color == nil ? "\(Int(s.temp)) K" : "—")
                        GradientSlider(value: s.temp, range: 2200...6500, step: 100, detent: 500, colors: kelvinColors, height: 36) {
                            store.setLight(id, LightPatch(on: true, temp: $0))
                        }
                    }
                    if cfg.hasColor {
                        label("Colour", s.color?.uppercased() ?? "White")
                        HStack(spacing: 10) {
                            ForEach(swatches, id: \.self) { c in
                                let selected = s.color?.lowercased() == c
                                Button {
                                    Haptics.light()
                                    store.setLight(id, LightPatch(on: true, color: .some(c)))
                                } label: {
                                    Circle().fill(Color(hex: c))
                                        .frame(height: 32)
                                        .overlay(Circle().strokeBorder(Color.ink, lineWidth: selected ? 2.5 : 0).padding(-4))
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Colour \(c)")
                            }
                        }
                        .frame(maxWidth: .infinity)
                        ColorPicker(selection: Binding(
                            get: { s.color.map(Color.init(hex:)) ?? .white },
                            set: { c in
                                let ui = UIColor(c).resolvedColor(with: .current)
                                var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
                                ui.getRed(&r, green: &g, blue: &b, alpha: &a)
                                let rgb = RGB(Double(min(1, max(0, r))), Double(min(1, max(0, g))), Double(min(1, max(0, b))))
                                store.setLight(id, LightPatch(on: true, color: .some(rgb.hex)))
                            }), supportsOpacity: false) {
                            Label("Any colour", systemImage: "paintpalette").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                        }
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.fill))
                    }
                    if cfg.capabilities.isEmpty || (!cfg.hasColor && !cfg.hasTemp) {
                        Label("\(store.roomName(cfg.room)) · tap the lamp in the 3D view, or its tile, to switch it.", systemImage: lampSymbol(cfg.type))
                            .font(.footnote).foregroundStyle(Color.muted)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .navigationTitle(cfg.name)
            .navigationSubtitle("\(store.roomName(cfg.room)) · \(s.on ? "On" : "Off")")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    PowerToolbarButton(on: s.on) { Haptics.light(); store.toggleLight(id) }
                }
            }
        } else {
            ContentUnavailableView("This light is gone", systemImage: "lightbulb.slash")
        }
    }

    private func label(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
            Spacer()
            Text(value).font(.subheadline).foregroundStyle(Color.muted).monospacedDigit()
        }
    }
}

// MARK: - an air conditioner

struct ACPage: View {
    let id: String
    @Environment(HomeStore.self) private var store

    var body: some View {
        if let cfg = store.acConfig(id) {
            let s = store.acs[id] ?? ACState()
            let f = store.acFeatures(id)
            let tint = Color(hex: modeColors[s.mode] ?? "#5db2ff")
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .center) {
                        BigReadout(value: s.target, unit: "°\(cfg.unit)", off: !s.on)
                        Spacer()
                        if f.eco {
                            Toggle(isOn: Binding(get: { s.eco }, set: { Haptics.light(); store.setAC(id, ["eco": .bool($0)]) })) {
                                Label("Eco", systemImage: "leaf").font(.subheadline.weight(.semibold))
                            }
                            .toggleStyle(.button)
                            .buttonStyle(.glass)
                            .tint(.green)
                        }
                    }
                    HStack(spacing: 10) {
                        RoundIcon(symbol: "minus") { step(-1, s) }
                        GradientSlider(value: Double(s.target), range: Double(cfg.min)...Double(cfg.max), step: 1, detent: 1, colors: tempColors) {
                            store.setAC(id, ["on": .bool(true), "target": .number($0)])
                        }
                        RoundIcon(symbol: "plus") { step(1, s) }
                    }
                    HStack {
                        Text("\(cfg.min)°").font(.caption).foregroundStyle(Color.faint)
                        Spacer()
                        Text("\(cfg.max)°").font(.caption).foregroundStyle(Color.faint)
                    }
                    .padding(.horizontal, 52)
                    .padding(.top, -12)

                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                        if !f.modes.isEmpty {
                            option("Mode", modeNames[s.mode] ?? s.mode, symbol: modeSymbols[s.mode] ?? "fan", values: f.modes, names: modeNames, current: s.mode) {
                                store.setAC(id, ["on": .bool(true), "mode": .string($0)])
                            }
                        }
                        if !f.fans.isEmpty {
                            option("Fan", fanNames[s.fan] ?? s.fan, symbol: "fan", values: f.fans, names: fanNames, current: s.fan) {
                                store.setAC(id, ["fan": .string($0)])
                            }
                        }
                        if f.swing {
                            option("Airflow", swingNames[s.swing] ?? s.swing, symbol: "wind", values: swingValues, names: swingNames, current: s.swing) {
                                store.setAC(id, ["swing": .string($0)])
                            }
                        }
                        if f.sleep {
                            Button {
                                Haptics.light()
                                store.setAC(id, ["sleep": .bool(!s.sleep)])
                            } label: {
                                optionLabel("Sleep", s.sleep ? "On" : "Off", symbol: "moon", active: s.sleep)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .tint(tint)
            .navigationTitle(cfg.name)
            .navigationSubtitle("Room \(cfg.unit == "F" ? String(Int(s.roomTemp.rounded())) : String(format: "%.1f", s.roomTemp))°\(cfg.unit) · \(s.on ? modeNames[s.mode] ?? "" : "Off")")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    PowerToolbarButton(on: s.on) { Haptics.medium(); store.setAC(id, ["on": .bool(!s.on)]) }
                }
            }
        } else {
            ContentUnavailableView("This AC is gone", systemImage: "air.conditioner.horizontal")
        }
    }

    private func step(_ d: Int, _ s: ACState) {
        Haptics.tick()
        store.setAC(id, ["on": .bool(true), "target": .number(Double(s.target + d))])
    }

    private func option(_ title: String, _ value: String, symbol: String, values: [String], names: [String: String], current: String,
                        set: @escaping (String) -> Void) -> some View {
        Menu {
            Picker(title, selection: Binding(get: { current }, set: { Haptics.light(); set($0) })) {
                ForEach(values, id: \.self) { v in Text(names[v] ?? v).tag(v) }
            }
        } label: {
            optionLabel(title, value, symbol: symbol, active: false)
        }
        .buttonStyle(.plain)
    }

    private func optionLabel(_ title: String, _ value: String, symbol: String, active: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: symbol).font(.title3)
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.bold)).foregroundStyle(Color.faint)
            }
            Text(title).font(.caption).foregroundStyle(Color.muted)
            Text(value).font(.subheadline.weight(.semibold))
        }
        .foregroundStyle(Color.ink)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(active ? Color.accentSoft : Color.fill))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.line))
    }
}

// MARK: - settings

struct SettingsPage: View {
    @Environment(HubClient.self) private var hub
    @State private var lan = ""
    @State private var remote = ""
    @State private var backupName = ""
    @State private var backupLan = ""
    @State private var backupRemote = ""

    var body: some View {
        Form {
            Section {
                TextField("On the Wi-Fi", text: $lan).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                TextField("Over Tailscale", text: $remote).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            } header: {
                Text("Home server")
            } footer: {
                Text("Both are asked at once; the first that answers is used. The home server is dell-server.")
            }
            Section {
                TextField("Name", text: $backupName).autocorrectionDisabled()
                TextField("On the Wi-Fi", text: $backupLan).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                TextField("Over Tailscale", text: $backupRemote).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            } header: {
                Text("Backup hub")
            } footer: {
                Text("Used when the home server doesn’t answer within 3 s. While on the backup, the home server is asked again every 30 s and taken back as soon as it answers. Both hubs keep the same plan.")
            }
            Section {
                switch hub.link {
                case .connecting: Label("Looking for the hub…", systemImage: "antenna.radiowaves.left.and.right")
                case .connected(let url):
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(hub.which).font(.body.weight(.semibold))
                            Text(url.absoluteString).font(.footnote).foregroundStyle(Color.muted)
                        }
                    } icon: {
                        Image(systemName: hub.onBackup ? "arrow.triangle.branch" : "checkmark.circle.fill")
                    }
                    .foregroundStyle(hub.onBackup ? Color.warm : .green)
                case .offline(let why): Label(why, systemImage: "wifi.slash").foregroundStyle(Color.danger)
                }
                Button("Save and reconnect") {
                    hub.setAddresses(primary: [lan, remote], backup: [backupLan, backupRemote], backupName: backupName)
                }
                Button("Use the usual addresses") {
                    hub.setAddresses(primary: HubClient.defaultAddresses, backup: HubClient.defaultBackupAddresses,
                                     backupName: HubClient.defaultBackupName)
                    load()
                }
            }
        }
        .scrollContentBackground(.hidden)
        .navigationTitle("Hub")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: load)
    }

    private func load() {
        lan = hub.addresses.first ?? ""
        remote = hub.addresses.dropFirst().first ?? ""
        backupName = hub.backupName
        backupLan = hub.backupAddresses.first ?? ""
        backupRemote = hub.backupAddresses.dropFirst().first ?? ""
    }
}
