import SwiftUI

/// Making or changing a scene: its name and icon, and what it sets — every lamp as it is now
/// (and the AC, if asked). Saved into the plan's `scenes`, so the web panel has it too.
struct ScenePage: View {
    let id: String?
    @Environment(HomeStore.self) private var store
    @Environment(CardModel.self) private var card
    @State private var name = ""
    @State private var icon = "sparkles"
    @State private var includeAC = false
    @State private var capture = true
    @State private var loaded = false
    @State private var confirmDelete = false
    @State private var tvActions: [String: JSON] = [:]
    @FocusState private var naming: Bool

    private var existing: SceneConfig? { id.flatMap { i in store.plan.scenes.first { $0.id == i } } }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name)
                    .focused($naming)
                    .submitLabel(.done)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 6), spacing: 8) {
                    ForEach(sceneIcons, id: \.self) { i in
                        Button {
                            Haptics.tick()
                            icon = i
                        } label: {
                            Image(systemName: sceneSymbol(i))
                                .font(.system(size: 18, weight: .medium))
                                .frame(maxWidth: .infinity, minHeight: 40)
                                .foregroundStyle(icon == i ? Color.stage : Color.ink)
                                .background(Circle().fill(icon == i ? Color.ink : Color.fill))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(i)
                        .accessibilityAddTraits(icon == i ? .isSelected : [])
                    }
                }
                .padding(.vertical, 4)
            }
            Section {
                if id != nil {
                    Toggle("Use the lamps as they are now", isOn: $capture)
                }
                if !store.plan.acs.isEmpty {
                    Toggle("Include the AC", isOn: $includeAC)
                }
            } footer: {
                Text(id == nil || capture ? "The scene sets every lamp as it is now." : "The scene keeps what it already sets.")
            }
            Section("What it sets") {
                ForEach(store.plan.lights) { l in
                    HStack {
                        Image(systemName: lampSymbol(l.type)).frame(width: 24).foregroundStyle(Color.muted)
                        Text(l.name)
                        Spacer()
                        Text(summary(l)).foregroundStyle(Color.muted).monospacedDigit()
                    }
                    .font(.subheadline)
                }
                if includeAC {
                    ForEach(store.plan.acs) { a in
                        HStack {
                            Image(systemName: "air.conditioner.horizontal").frame(width: 24).foregroundStyle(Color.muted)
                            Text(a.name)
                            Spacer()
                            Text(acSummary(a)).foregroundStyle(Color.muted)
                        }
                        .font(.subheadline)
                    }
                }
            }
            if !store.tvTiles.isEmpty || !tvActions.isEmpty {
                Section {
                    ForEach(Array(Set(store.tvTiles.map(\.deviceID) + Array(tvActions.keys))).sorted(), id: \.self) { deviceID in
                        Picker(store.tv.device(deviceID)?.name ?? "TV", selection: Binding(
                            get: { tvActions[deviceID]?["app"]?.string ?? "" },
                            set: { appID in
                                if appID.isEmpty { tvActions[deviceID] = nil }
                                else {
                                    let name = TVCatalog.apps.first { $0.id == appID }?.name ?? appID
                                    tvActions[deviceID] = .object(["app": .string(appID), "name": .string(name)])
                                }
                            })) {
                            Text("Leave unchanged").tag("")
                            ForEach(TVCatalog.apps, id: \.id) { app in Text(app.name).tag(app.id) }
                            if let app = tvActions[deviceID]?["app"]?.string, !TVCatalog.apps.contains(where: { $0.id == app }) {
                                Text(tvActions[deviceID]?["name"]?.string ?? app).tag(app)
                            }
                        }
                    }
                } header: { Text("TV apps") } footer: { Text("Opens the selected app when you use this preset.") }
            }
            if let id {
                Section {
                    Button("Delete scene", role: .destructive) { confirmDelete = true }
                        .confirmationDialog("Delete “\(name)”?", isPresented: $confirmDelete, titleVisibility: .visible) {
                            Button("Delete", role: .destructive) {
                                store.deleteScene(id)
                                card.path = []
                            }
                        }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .navigationTitle(id == nil ? "New scene" : "Edit scene")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Save", systemImage: "checkmark") {
                    Haptics.success()
                    store.saveScene(id: id, name: name.trimmingCharacters(in: .whitespaces), icon: icon, capture: capture, includeAC: includeAC, tvs: tvActions)
                    card.path = []
                }
                .buttonStyle(.glassProminent)
                .foregroundStyle(Color.stage)
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            if let s = existing {
                name = s.name
                icon = sceneIcons.contains(s.icon) ? s.icon : "sparkles"
                includeAC = !s.acs.isEmpty
                capture = false
                tvActions = s.tvs
            } else {
                naming = true
            }
        }
    }

    /// What the scene would set this lamp to.
    private func summary(_ l: LightConfig) -> String {
        if let s = existing, !capture {
            let p = (s.lights[l.id] ?? LightPatch()).merged(over: s.lights["*"] ?? LightPatch())
            guard p.on != nil || p.brightness != nil else { return "—" }
            if p.on == false { return "Off" }
            return describe(on: true, brightness: p.brightness, temp: p.temp, color: p.color ?? nil, l)
        }
        let st = store.lights[l.id] ?? LightState()
        return describe(on: st.on, brightness: st.brightness, temp: st.temp, color: st.color, l)
    }

    private func describe(on: Bool, brightness: Double?, temp: Double?, color: String?, _ l: LightConfig) -> String {
        guard on else { return "Off" }
        var parts: [String] = []
        if l.dimmable, let b = brightness { parts.append("\(Int((b * 100).rounded()))%") }
        if let c = color, l.hasColor { parts.append(c.uppercased()) } else if l.hasTemp, let t = temp { parts.append("\(Int(t)) K") }
        return parts.isEmpty ? "On" : parts.joined(separator: " · ")
    }

    private func acSummary(_ a: ACConfig) -> String {
        let s = store.acs[a.id] ?? ACState()
        return s.on ? "\(modeNames[s.mode] ?? s.mode) \(s.target)°" : "Off"
    }
}
