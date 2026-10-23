import SwiftUI

struct SpeakerTile: View {
    var onOpen: () -> Void
    @Environment(HomeStore.self) private var store
    var body: some View {
        let state = store.spotify.state
        HStack(spacing: 12) {
            Bubble(symbol: "hifispeaker", on: state.playing, tint: Color(hex: "#85d7b3"))
            VStack(alignment: .leading, spacing: 3) {
                Text("Studio speaker").font(.house(16)).foregroundStyle(Color.ink)
                Text(state.available ? state.title : "Spotify").font(.footnote).foregroundStyle(Color.muted).lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Color.faint)
        }
        .padding(.horizontal, 14).frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TileBackground(on: state.playing, tint: Color(hex: "#85d7b3")))
        .contentShape(RoundedRectangle(cornerRadius: 26))
        .onTapGesture { if TileGuard.allowsTap { Haptics.light(); onOpen() } }
        .accessibilityElement(children: .combine).accessibilityAddTraits(.isButton)
        .accessibilityAction { onOpen() }
    }
}

struct SpotifyPage: View {
    @Environment(HomeStore.self) private var store
    @State private var seek: Double?
    @State private var volume: Double?
    @State private var chosenOutput = ""
    @State private var libraryRequested = false

    var body: some View {
        let player = store.spotify
        let state = player.state
        let output = state.outputs.contains { $0.id == chosenOutput } ? chosenOutput : state.device
        ScrollView {
            VStack(spacing: 22) {
                if !state.error.isEmpty {
                    Text(state.error).font(.subheadline).foregroundStyle(Color.muted)
                        .frame(maxWidth: .infinity).padding(16)
                        .background(Color.fill, in: RoundedRectangle(cornerRadius: 24))
                        .accessibilityIdentifier("spotify-status")
                }
                AsyncImage(url: state.artwork) { image in image.resizable().scaledToFill() } placeholder: {
                    RoundedRectangle(cornerRadius: 30).fill(Color.fill)
                        .overlay(Image(systemName: "hifispeaker").font(.system(size: 58, weight: .ultraLight)).foregroundStyle(Color.muted))
                }
                .frame(width: 230, height: 230).clipShape(RoundedRectangle(cornerRadius: 30))
                VStack(spacing: 6) {
                    Text(state.title).font(.house(28, weight: .light)).foregroundStyle(Color.ink).multilineTextAlignment(.center)
                    Text(state.artist).font(.house(17)).foregroundStyle(Color.muted).multilineTextAlignment(.center)
                }
                VStack(spacing: 10) {
                    HStack(spacing: 12) {
                        Button { player.saveSong(state.trackURI) } label: {
                            Label(state.saved ? "Liked" : "Liked Songs", systemImage: state.saved ? "checkmark.circle.fill" : "plus.circle")
                        }
                        .buttonStyle(.glass).disabled(!state.available || !state.canSave || state.trackURI.isEmpty || state.saved || player.saving)
                        .accessibilityLabel(state.saved ? "Saved to Liked Songs" : "Save to Liked Songs")
                        Menu {
                            ForEach(player.playlists.filter(\.writable)) { playlist in
                                Button(playlist.name) { player.saveSong(state.trackURI, playlist: playlist.id) }
                            }
                            if player.nextPlaylistOffset != nil {
                                Button("More playlists…") { Task { await player.loadPlaylists(reset: false) } }
                            }
                            if player.playlists.filter(\.writable).isEmpty && !player.loadingPlaylists {
                                Text("No editable playlists loaded")
                            }
                        } label: { Label("Playlist", systemImage: "text.badge.plus") }
                        .buttonStyle(.glass).disabled(!state.available || !state.canAddToPlaylist || state.trackURI.isEmpty || player.saving)
                        .accessibilityLabel("Add song to playlist")
                    }
                    if player.saving { ProgressView("Saving song…") }
                    else if player.saveMessageURI == state.trackURI && !player.saveMessage.isEmpty {
                        Text(player.saveMessage).font(.footnote).foregroundStyle(Color.muted)
                    } else if state.available && state.canTransfer && (!state.canSave || !state.canAddToPlaylist) {
                        Text("Connect Spotify again to allow saving songs and editing playlists.")
                            .font(.footnote).foregroundStyle(Color.muted).multilineTextAlignment(.center)
                    }
                }
                if state.duration > 0 {
                    VStack(spacing: 6) {
                        GradientSlider(value: seek ?? state.position, range: 0...max(1, state.duration), colors: [.faint, .ink], height: 30,
                                       onChange: { seek = $0 }, onEnd: { value in
                            player.perform("seek", fields: ["position": .number(value)]); seek = nil
                        })
                        .disabled(!state.canSeek || !state.available)
                        .accessibilityLabel("Track position")
                        HStack {
                            Text(clock(seek ?? state.position)); Spacer(); Text(clock(state.duration))
                        }.font(.caption).foregroundStyle(Color.muted).monospacedDigit()
                    }
                }
                HStack(spacing: 28) {
                    transport("backward.end.fill", label: "Previous track") { player.perform("previous") }
                    Button { Haptics.light(); player.perform(state.playing ? "pause" : "play") } label: {
                        Image(systemName: state.playing ? "pause.fill" : "play.fill")
                            .font(.system(size: 26)).frame(width: 66, height: 66)
                    }
                    .buttonStyle(.glassProminent).buttonBorderShape(.circle).tint(Color.ink).foregroundStyle(Color.stage)
                    .accessibilityLabel(state.playing ? "Pause" : "Play")
                    transport("forward.end.fill", label: "Next track") { player.perform("next") }
                }
                .disabled(!state.available)
                HStack(spacing: 14) {
                    Image(systemName: "speaker.wave.2").foregroundStyle(Color.muted)
                    GradientSlider(value: volume ?? state.volume ?? 0, range: 0...100, detent: 5,
                                   colors: [.faint, .ink], height: 34, onChange: { level in volume = level; player.setVolume(level) },
                                   onEnd: { _ in volume = nil })
                        .accessibilityLabel("Spotify volume")
                }
                .disabled(!state.available || state.volume == nil || !state.volumeSupported)
                VStack(alignment: .leading, spacing: 12) {
                    Text("Playing on").font(.subheadline).foregroundStyle(Color.muted)
                    Picker("Speaker", selection: Binding(get: { output }, set: { id in
                        chosenOutput = id
                        if !id.isEmpty { player.perform("transfer", fields: ["device": .string(id)]) }
                    })) {
                        Text(state.outputs.isEmpty ? "No speakers available" : "Choose a speaker").tag("")
                        ForEach(state.outputs) { output in Text(output.name).tag(output.id) }
                    }
                    .pickerStyle(.menu).frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .disabled(!state.canTransfer || !state.available)
                    Text(!state.available ? (state.error.isEmpty ? "Spotify is temporarily unavailable. Try Refresh." : state.error)
                         : state.canTransfer ? "Choose your Echo or another Spotify Connect output."
                         : "Choose the speaker in Spotify on your Mac. Connect your Spotify account to choose outputs here.")
                        .font(.footnote).foregroundStyle(Color.muted)
                    if state.canOpen {
                        Button("Open Spotify on Mac") { player.perform("open") }.buttonStyle(.glass)
                    }
                }
                .padding(18).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.fill, in: RoundedRectangle(cornerRadius: 26))
                VStack(alignment: .leading, spacing: 12) {
                    Text("Your playlists").font(.house(20)).foregroundStyle(Color.ink)
                    if !state.available {
                        Text(state.error.isEmpty ? "Spotify is temporarily unavailable. Try Refresh." : state.error)
                            .font(.subheadline).foregroundStyle(Color.muted)
                    } else if !state.canTransfer {
                        Text("Connect your Spotify account to choose playlists and your Echo here.")
                            .font(.subheadline).foregroundStyle(Color.muted)
                    }
                    if state.canTransfer || (!state.available && !player.playlists.isEmpty) {
                        if !player.playlistError.isEmpty {
                            Text(player.playlistError).font(.subheadline).foregroundStyle(Color.muted)
                        }
                        ForEach(player.playlists) { playlist in
                            Button {
                                var fields: [String: JSON] = ["uri": .string(playlist.uri)]
                                if !output.isEmpty { fields["device"] = .string(output) }
                                Haptics.light(); player.perform("play", fields: fields)
                            } label: {
                                HStack(spacing: 14) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(playlist.name).font(.house(17)).foregroundStyle(Color.ink)
                                        Text(playlist.owner.isEmpty ? "Spotify playlist" : playlist.owner).font(.footnote).foregroundStyle(Color.muted)
                                    }
                                    Spacer()
                                    Image(systemName: "play.fill").foregroundStyle(Color.ink)
                                }
                                .padding(16).background(Color.fill, in: RoundedRectangle(cornerRadius: 24))
                            }
                            .buttonStyle(.plain).disabled(!state.available || !state.canTransfer)
                            .accessibilityLabel("Play \(playlist.name)")
                        }
                        if player.loadingPlaylists { ProgressView("Loading your playlists…") }
                        else if state.available && player.playlists.isEmpty && player.playlistError.isEmpty {
                            Text("No playlists found in this Spotify account.").font(.subheadline).foregroundStyle(Color.muted)
                        }
                        if player.nextPlaylistOffset != nil {
                            Button("More playlists") { Task { await player.loadPlaylists(reset: false) } }
                                .buttonStyle(.glass).disabled(player.loadingPlaylists || !state.available)
                        }
                    }
                }
            }
            .padding(24).padding(.bottom, 30)
        }
        .navigationTitle("Spotify").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Refresh", systemImage: "arrow.clockwise") {
            Task { await player.refresh(); if player.state.canTransfer { await player.loadPlaylists() } }
        } } }
        .task { await player.refresh() }
        .task(id: state.canTransfer) {
            if state.canTransfer && !libraryRequested { libraryRequested = true; await player.loadPlaylists() }
        }
    }

    private func transport(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button { Haptics.light(); action() } label: { Image(systemName: symbol).font(.system(size: 23)).frame(width: 42, height: 42) }
            .buttonStyle(.glass).buttonBorderShape(.circle).accessibilityLabel(label)
    }

    private func clock(_ value: Double) -> String {
        let seconds = max(0, Int(value))
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }
}
