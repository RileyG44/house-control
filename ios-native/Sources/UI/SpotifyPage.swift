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

    var body: some View {
        let player = store.spotify
        let state = player.state
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
                    Picker("Speaker", selection: Binding(get: { state.device }, set: { id in
                        if !id.isEmpty { player.perform("transfer", fields: ["device": .string(id)]) }
                    })) {
                        Text(state.outputs.isEmpty ? "No speakers available" : "Choose a speaker").tag("")
                        ForEach(state.outputs) { output in Text(output.name).tag(output.id) }
                    }
                    .disabled(!state.canTransfer || !state.available)
                    Text(state.canTransfer ? "Choose your Echo or another Spotify Connect output."
                         : "Choose the speaker in Spotify on your Mac. Connect your Spotify account to choose outputs here.")
                        .font(.footnote).foregroundStyle(Color.muted)
                    if state.canOpen {
                        Button("Open Spotify on Mac") { player.perform("open") }.buttonStyle(.glass)
                    }
                }
                .padding(18).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.fill, in: RoundedRectangle(cornerRadius: 26))
            }
            .padding(24).padding(.bottom, 30)
        }
        .navigationTitle("Spotify").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Refresh", systemImage: "arrow.clockwise") { Task { await player.refresh() } } } }
        .task { await player.follow() }
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
