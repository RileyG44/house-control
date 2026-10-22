import SwiftUI

/// Browse (docs/streaming-catalog.md): a row of chips, "For you" and then each of the TV's apps,
/// and a grid of the chosen one's posters, from the hub's streaming catalog (hub/catalog.py). An
/// app's Popular, Trending and New are picked under the chips, and More reads the row's next
/// page. A poster opens the title's sheet (TVTitleSheet), whose Play on TV goes the way a
/// search result does. Only the TV's own apps, and only what their subscriptions include.
struct TVBrowse: View {
    let id: String
    /// Plays a title on the TV: in the app of `offer` when one was picked in its sheet, else its own.
    var onPlay: (BrowseTile, TitleDetails.Offer?) -> Void
    @Environment(HomeStore.self) private var store
    @State private var chip = Self.forYou
    @State private var rowKey: [String: String] = [:]
    /// More pages of a row, by "app:row", and the rows that have no more.
    @State private var extra: [String: [BrowseTile]] = [:]
    @State private var pages: [String: Int] = [:]
    @State private var ended: Set<String> = []
    @State private var loadingMore = false
    @State private var phase: Phase = .loading
    @State private var selected: BrowseTile?

    enum Phase: Equatable { case loading, ready, failed(String) }

    static let forYou = "foryou"
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: 3)

    var body: some View {
        let catalog = store.tv.browse
        VStack(alignment: .leading, spacing: 12) {
            chips(catalog)
            if let catalog {
                content(catalog)
            } else if case .failed(let why) = phase {
                Label(why, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(Color.muted)
            } else {
                HStack(spacing: 8) { ProgressView(); Text("Finding what’s on…").foregroundStyle(Color.muted) }.font(.subheadline)
            }
        }
        .task { await load() }
        .sheet(item: $selected) { tile in
            TVTitleSheet(tile: tile) { offer in onPlay(tile, offer) }
        }
    }

    private func load(force: Bool = false) async {
        do {
            try await store.tv.loadBrowse(force: force)
            phase = .ready
        } catch {
            phase = .failed(error.localizedDescription.isEmpty ? "The streaming catalog didn’t answer." : error.localizedDescription)
        }
    }

    // MARK: - the chips

    private func chips(_ catalog: BrowseCatalog?) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                chipButton(Self.forYou, selected: chip == Self.forYou || catalog?.apps.contains { $0.id == chip } != true) {
                    Label("For you", systemImage: "sparkles")
                }
                ForEach(catalog?.apps ?? []) { app in
                    chipButton(app.id, selected: chip == app.id) {
                        HStack(spacing: 6) {
                            AppLogo(app: TVCatalog.info(id: app.id) ?? TVCatalog.other, size: 20)
                                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                            Text(app.name)
                        }
                    }
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 2)
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }

    private func chipButton<Content: View>(_ key: String, selected: Bool, @ViewBuilder label: () -> Content) -> some View {
        let glass: Glass = selected ? Glass.regular.tint(Color.accentColor).interactive() : Glass.regular.interactive()
        let content = label()
        return Button {
            Haptics.tick()
            chip = key
        } label: {
            content
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(selected ? Color.white : Color.ink)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .glassEffect(glass, in: .capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    // MARK: - the posters

    @ViewBuilder
    private func content(_ catalog: BrowseCatalog) -> some View {
        if let app = catalog.apps.first(where: { $0.id == chip }) {
            let key = rowKey[app.id] ?? app.rows.first?.key ?? ""
            let row = app.rows.first { $0.key == key } ?? app.rows[0]
            if app.rows.count > 1 {
                Picker("Row", selection: Binding(get: { row.key }, set: { rowKey[app.id] = $0 })) {
                    ForEach(app.rows) { r in Text(r.label).tag(r.key) }
                }
                .pickerStyle(.segmented)
            }
            let k = "\(app.id):\(row.key)"
            grid(row.items + (extra[k] ?? []))
            if !ended.contains(k), row.items.count >= 20 || row.key == "new" {
                Button { Task { await more(app: app.id, row: row.key, base: row.items) } } label: {
                    HStack(spacing: 8) {
                        if loadingMore { ProgressView() }
                        Text(loadingMore ? "Loading…" : "More \(row.label.lowercased()) on \(app.name)")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.ink)
                .disabled(loadingMore)
            }
        } else if catalog.forYou.isEmpty {
            Text(catalog.apps.isEmpty ? "Nothing to show from the TV’s apps right now." : "Pick an app to see what’s on it.")
                .font(.subheadline).foregroundStyle(Color.muted)
        } else {
            grid(catalog.forYou)
        }
    }

    private func more(app: String, row: String, base: [BrowseTile]) async {
        let k = "\(app):\(row)"
        let page = (pages[k] ?? 0) + 1
        loadingMore = true
        defer { loadingMore = false }
        do {
            let got = try await store.tv.browseMore(app: app, row: row, page: page)
            let seen = Set((base + (extra[k] ?? [])).map(\.id))
            extra[k, default: []] += got.items.filter { !seen.contains($0.id) }
            pages[k] = page
            if !got.more || got.items.isEmpty { ended.insert(k) }
        } catch {
            store.show(error.localizedDescription, error: true)
        }
    }

    private func grid(_ tiles: [BrowseTile]) -> some View {
        LazyVGrid(columns: columns, spacing: 14) {
            ForEach(tiles) { t in
                Button {
                    Haptics.light()
                    selected = t
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        TVPoster(tile: t)
                        Text(t.title).font(.caption.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(1)
                        Text(caption(t)).font(.caption2).foregroundStyle(Color.muted).lineLimit(1)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel([t.title, caption(t)].filter { !$0.isEmpty }.joined(separator: ", "))
            }
        }
    }

    private func caption(_ t: BrowseTile) -> String {
        let app = t.app.flatMap { TVCatalog.info(id: $0)?.name }
        switch t.kind {
        case "continue": return ["Continue", app].compactMap { $0 }.joined(separator: " · ")
        case "recommendation": return ["Picked by", app ?? "the app"].joined(separator: " ")
        default: return [t.year.map(String.init), chip == Self.forYou ? app : nil].compactMap { $0 }.joined(separator: " · ")
        }
    }
}

/// A title's poster, 2:3, with its app's logo in the corner (and how far along, for Continue).
struct TVPoster: View {
    let tile: BrowseTile
    var showApp = true

    var body: some View {
        let info = tile.app.flatMap { TVCatalog.info(id: $0) }
        let tint = Color(hex: info?.glow ?? "#5b6f8f")
        Color.fill
            .aspectRatio(2 / 3, contentMode: .fit)
            .overlay {
                AsyncImage(url: tile.poster) { phase in
                    if let img = phase.image {
                        img.resizable().scaledToFill()
                    } else {
                        ZStack {
                            tint.opacity(0.35)
                            Text(tile.title)
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Color.ink)
                                .multilineTextAlignment(.center)
                                .lineLimit(4)
                                .padding(8)
                        }
                    }
                }
            }
            .overlay(alignment: .bottom) {
                if let p = tile.progress, p >= 0 {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(Color.white.opacity(0.3))
                            Rectangle().fill(Color.white).frame(width: g.size.width * min(1, p))
                        }
                    }
                    .frame(height: 3)
                }
            }
            .overlay(alignment: .topTrailing) {
                if showApp, let info {
                    AppLogo(app: info, size: 22)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .padding(5)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.line))
    }
}

/// A title, tapped in Browse: its picture, title, year, runtime, rating and description, the
/// TV's apps it's included in, and Play on TV (in the app it was shown under, or another one of
/// those). Details come from `GET /api/tv/title/{id}`; Continue titles and the apps' own picks
/// have none there, and are picked up again on the TV instead.
struct TVTitleSheet: View {
    let tile: BrowseTile
    var onPlay: (TitleDetails.Offer?) -> Void
    @Environment(HomeStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var details: TitleDetails?
    @State private var loading = false

    private var catalogued: Bool { tile.kind == "movie" || tile.kind == "show" }
    private var shown: BrowseTile { details?.tile ?? tile }
    /// The offer Play on TV uses: the app the title was shown under, else the first.
    private var primary: TitleDetails.Offer? {
        guard let offers = details?.offers, !offers.isEmpty else { return nil }
        return offers.first { $0.app == tile.app } ?? offers[0]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    art
                    VStack(alignment: .leading, spacing: 4) {
                        Text(shown.title).font(.title2.weight(.bold)).foregroundStyle(Color.ink)
                        let facts = shown.facts
                        if !facts.isEmpty { Text(facts).font(.subheadline).foregroundStyle(Color.muted) }
                        if !shown.genres.isEmpty {
                            Text(shown.genres.joined(separator: " · ")).font(.caption).foregroundStyle(Color.faint)
                        }
                    }
                    if let blurb = shown.blurb ?? shown.subtitle {
                        Text(blurb).font(.subheadline).foregroundStyle(Color.ink)
                    }
                    playButton
                    included
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 30)
            }
            .navigationTitle(shown.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            guard catalogued, details == nil else { return }
            loading = true
            details = try? await store.tv.title(tile.id)
            loading = false
        }
    }

    private var art: some View {
        Color.fill
            .aspectRatio(16 / 9, contentMode: .fit)
            .overlay {
                AsyncImage(url: shown.backdrop ?? shown.poster) { phase in
                    if let img = phase.image { img.resizable().scaledToFill() } else { Color.fill }
                }
            }
            .overlay(alignment: .bottomLeading) {
                if let info = tile.app.flatMap({ TVCatalog.info(id: $0) }) {
                    AppLogo(app: info, size: 34)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .padding(10)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var playButton: some View {
        let label = tile.resume != nil ? "Resume on TV" : tile.recommendation != nil ? "Open on TV" : "Play on TV"
        let app = (primary?.name ?? tile.app.flatMap { TVCatalog.info(id: $0)?.name })
        return Button {
            Haptics.medium()
            onPlay(primary)
            dismiss()
        } label: {
            VStack(spacing: 1) {
                Label(label, systemImage: "play.fill").font(.headline)
                if let app { Text("in \(app)").font(.caption).opacity(0.8) }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
        .buttonStyle(.glassProminent)
        .controlSize(.large)
        .disabled(!tile.playable && primary == nil)
    }

    @ViewBuilder
    private var included: some View {
        if let details, details.offers.count > 1 || !details.rentOrBuy.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Where it’s included").font(.subheadline.weight(.semibold)).foregroundStyle(Color.muted)
                ForEach(details.offers) { o in
                    HStack(spacing: 12) {
                        AppLogo(app: TVCatalog.info(id: o.app) ?? TVCatalog.other, size: 32)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(o.name).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                            Text(o.how.capitalized).font(.caption).foregroundStyle(Color.muted)
                        }
                        Spacer()
                        if o.app != primary?.app {
                            Button("Play") {
                                Haptics.medium()
                                onPlay(o)
                                dismiss()
                            }
                            .buttonStyle(.glass)
                            .font(.subheadline.weight(.semibold))
                            .accessibilityLabel("Play \(shown.title) in \(o.name)")
                        }
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.fill))
                }
                if !details.rentOrBuy.isEmpty {
                    Text("Also to rent or buy: \(details.rentOrBuy.joined(separator: ", "))")
                        .font(.caption).foregroundStyle(Color.faint)
                }
            }
        } else if loading {
            HStack(spacing: 8) { ProgressView(); Text("Looking up where it’s included…").foregroundStyle(Color.muted) }.font(.footnote)
        }
    }
}
