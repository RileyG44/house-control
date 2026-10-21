import SwiftUI

/// The title search (docs/tv-remote.md): a field (350 ms after typing stops it asks the hub's
/// streaming catalogue), results with their poster, year, kind and the apps they stream on; a
/// logo (or the row, when there is one app) plays it. Below: hand the words to the TV itself.
struct TVSearch: View {
    let id: String
    var onPlay: (SearchResult, SearchResult.Offer) -> Void
    @Environment(HomeStore.self) private var store
    @State private var query = ""
    @State private var results: [SearchResult] = []
    @State private var state: Phase = .idle
    @FocusState private var focused: Bool

    enum Phase: Equatable { case idle, searching, done, failed(String) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Color.muted)
                TextField("Search movies and shows", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .focused($focused)
                    .onSubmit { Task { await run(query.trimmingCharacters(in: .whitespaces)) } }
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.faint) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear the search")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.fill))

            let q = query.trimmingCharacters(in: .whitespaces)
            if !q.isEmpty {
                switch state {
                case .searching:
                    HStack(spacing: 8) { ProgressView(); Text("Searching…").foregroundStyle(Color.muted) }.font(.subheadline)
                case .failed(let why):
                    Label(why, systemImage: "exclamationmark.triangle").font(.subheadline).foregroundStyle(Color.muted)
                case .done where results.isEmpty:
                    Text("Nothing found for “\(q)”.").font(.subheadline).foregroundStyle(Color.muted)
                default:
                    EmptyView()
                }
                ForEach(results) { r in row(r) }
                extras(q)
            }
        }
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespaces)
            guard !q.isEmpty else { results = []; state = .idle; return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await run(q)
        }
    }

    private func run(_ q: String) async {
        guard !q.isEmpty else { return }
        state = .searching
        do {
            let found = try await store.tv.search(q)
            guard q == query.trimmingCharacters(in: .whitespaces) else { return }
            results = found
            state = .done
        } catch {
            guard q == query.trimmingCharacters(in: .whitespaces) else { return }
            results = []
            state = .failed(error.localizedDescription.isEmpty ? "The streaming catalog didn’t answer." : error.localizedDescription)
        }
    }

    private func row(_ r: SearchResult) -> some View {
        let one = r.offers.count == 1
        let sub = [r.year.map(String.init), r.type == "movie" ? "Movie" : "Show"].compactMap { $0 }.joined(separator: " · ")
        let tint = Color(hex: r.offers.first.flatMap { TVCatalog.info(id: $0.app)?.glow } ?? "#5b6f8f")
        return HStack(spacing: 12) {
            AsyncImage(url: r.poster) { phase in
                if let img = phase.image { img.resizable().aspectRatio(contentMode: .fill) }
                else {
                    ZStack {
                        tint.opacity(0.35)
                        Text(String(r.title.replacingOccurrences(of: "^the\\s+", with: "", options: [.regularExpression, .caseInsensitive]).prefix(1)).uppercased())
                            .font(.title3.weight(.bold)).foregroundStyle(Color.ink)
                    }
                }
            }
            .frame(width: 46, height: 66)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(r.title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(2)
                Text(sub).font(.caption).foregroundStyle(Color.muted)
                if r.offers.isEmpty {
                    Text(r.rentOrBuy.isEmpty ? "Not on the TV’s apps" : "Rent or buy on \(rentNames(r.rentOrBuy))")
                        .font(.caption).foregroundStyle(Color.faint).lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            HStack(spacing: 6) {
                ForEach(r.offers) { o in
                    Button { onPlay(r, o) } label: {
                        AppLogo(app: TVCatalog.info(id: o.app) ?? TVCatalog.other, size: 32)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Play \(r.title) in \(o.name)")
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.fill))
        .opacity(r.offers.isEmpty ? 0.7 : 1)
        .contentShape(Rectangle())
        .onTapGesture { if one { onPlay(r, r.offers[0]) } }
    }

    private func rentNames(_ list: [String]) -> String {
        var seen: [String] = []
        for s in list {
            let n = s.replacingOccurrences(of: "\\s*\\((rent|buy)\\)$", with: "", options: [.regularExpression, .caseInsensitive])
            if !seen.contains(n) { seen.append(n) }
        }
        return seen.joined(separator: ", ")
    }

    private func extras(_ q: String) -> some View {
        VStack(spacing: 8) {
            Button {
                Haptics.light()
                Task {
                    if await store.tv.act(id, ["action": .string("search"), "text": .string(q)]) { store.show("Searching the TV for “\(q)”") }
                }
            } label: {
                Label { Text("Search on the TV for “\(q)”").lineLimit(1) } icon: { Image(systemName: "tv") }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button {
                Haptics.light()
                Task {
                    if await store.tv.act(id, ["action": .string("text"), "text": .string(q)]) { store.show("Typed “\(q)” on the TV") }
                }
            } label: {
                Label { VStack(alignment: .leading) { Text("Type into the TV"); Text("for an app’s own search box").font(.caption).foregroundStyle(Color.muted) } }
                    icon: { Image(systemName: "keyboard") }
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .buttonStyle(.glass)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(Color.ink)
    }
}
