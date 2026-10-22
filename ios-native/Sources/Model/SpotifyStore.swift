import Foundation
import Observation

struct SpotifyOutput: Identifiable {
    var id: String
    var name: String
}

struct SpotifyPlaylist: Identifiable {
    var id: String
    var uri: String
    var name: String
    var owner: String
}

struct SpotifyState {
    var available = false
    var playing = false
    var canOpen = false
    var canTransfer = false
    var canSeek = false
    var volumeSupported = true
    var device = ""
    var volume: Double?
    var title = "Spotify"
    var artist = "Your music, around the studio"
    var artwork: URL?
    var duration = 0.0
    var position = 0.0
    var outputs: [SpotifyOutput] = []
    var error = "Connecting to Spotify…"

    init() {}
    init(_ json: JSON) {
        available = json["available"]?.bool ?? false
        playing = json["playing"]?.bool ?? false
        canOpen = json["canOpen"]?.bool ?? false
        canTransfer = json["canTransfer"]?.bool ?? false
        canSeek = json["canSeek"]?.bool ?? false
        volumeSupported = json["volumeSupported"]?.bool ?? true
        device = json["device"]?.string ?? ""
        volume = json["volume"]?.double
        title = json["track"]?["title"]?.string ?? "Spotify"
        artist = json["track"]?["artist"]?.string ?? "Your music, around the studio"
        artwork = json["track"]?["artwork"]?.string.flatMap(URL.init(string:))
        duration = json["track"]?["duration"]?.double ?? 0
        position = json["track"]?["position"]?.double ?? 0
        outputs = (json["devices"]?.array ?? []).compactMap { output in
            guard let id = output["id"]?.string else { return nil }
            return SpotifyOutput(id: id, name: output["name"]?.string ?? "Speaker")
        }
        error = json["error"]?.string ?? ""
    }
}

/// Both hubs expose the same remote; the Dell forwards to the Mac when it hosts Spotify.
@MainActor @Observable
final class SpotifyStore {
    let hub: HubClient
    private(set) var state = SpotifyState()
    private(set) var playlists: [SpotifyPlaylist] = []
    private(set) var nextPlaylistOffset: Int?
    private(set) var loadingPlaylists = false
    private(set) var playlistError = ""
    @ObservationIgnored private var reading = false
    @ObservationIgnored private var tail: Task<Void, Never>?
    @ObservationIgnored private var pendingVolume: Double?
    @ObservationIgnored private var volumeTask: Task<Void, Never>?

    init(hub: HubClient) { self.hub = hub }

    func refresh() async {
        guard !reading else { return }
        reading = true
        defer { reading = false }
        do { state = SpotifyState(try await hub.get("api/spotify", checkError: false)) }
        catch { state.available = false; state.error = "The Spotify remote cannot reach your hub." }
    }

    func follow() async {
        while !Task.isCancelled {
            await refresh()
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
        }
    }

    func loadPlaylists(reset: Bool = true) async {
        guard !loadingPlaylists, reset || nextPlaylistOffset != nil else { return }
        loadingPlaylists = true; playlistError = ""
        defer { loadingPlaylists = false }
        do {
            let offset = reset ? 0 : nextPlaylistOffset ?? 0
            let json = try await hub.get("api/spotify/playlists?offset=\(offset)", checkError: false)
            guard json["available"]?.bool == true else {
                playlistError = json["error"]?.string ?? "Connect your Spotify account to choose playlists here."
                return
            }
            let items = (json["items"]?.array ?? []).compactMap { item -> SpotifyPlaylist? in
                guard let id = item["id"]?.string, let uri = item["uri"]?.string else { return nil }
                return SpotifyPlaylist(id: id, uri: uri, name: item["name"]?.string ?? "Playlist", owner: item["owner"]?.string ?? "")
            }
            if reset { playlists = items }
            else { playlists += items.filter { item in !playlists.contains { $0.id == item.id } } }
            nextPlaylistOffset = json["next"]?.int
        } catch { playlistError = "Your playlists cannot reach Spotify. Try Refresh." }
    }

    func perform(_ action: String, fields: [String: JSON] = [:]) {
        let previous = tail
        tail = Task {
            await previous?.value
            await send(action, fields: fields)
        }
    }

    private func send(_ action: String, fields: [String: JSON] = [:]) async {
        do {
            _ = try await hub.post("api/spotify", .object(fields.merging(["action": .string(action)]) { _, new in new }))
            await refresh()
        } catch { state.error = error.localizedDescription; Haptics.error() }
    }

    func setVolume(_ level: Double) {
        pendingVolume = min(100, max(0, level.rounded()))
        guard volumeTask == nil else { return }
        volumeTask = Task {
            while let level = pendingVolume {
                pendingVolume = nil
                await send("volume", fields: ["level": .number(level)])
            }
            volumeTask = nil
        }
    }
}
