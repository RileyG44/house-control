import SwiftUI

/// 75 → "1:15", 3725 → "1:02:05".
func clock(_ seconds: Double) -> String {
    let s = max(0, Int(seconds))
    let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
}

/// What the TV is playing (web/src/tv/nowplaying.js): the artwork with the app's badge, the title
/// and its show or channel, back 10 s / play-pause / ahead 30 s, and a scrubber. Between the TV's
/// reports the position is worked out here (`position` at `at`, moving while it plays). A jump or
/// a pause asked for here shows at once and stands until the TV agrees (or 4 s pass).
struct NowPlayingCard: View {
    let device: TVDevice
    let np: NowPlaying
    var onPlayPause: () -> Void
    var onSeek: (Double) async -> Bool

    @State private var asked: (patch: NowPlaying, until: Date, seek: Bool)?
    @State private var drag: Double?            // 0…1 while a finger is on the scrubber
    @State private var notch: Int?
    @State private var poster = false

    private var current: NowPlaying {
        if let a = asked, a.until > Date() { return a.patch }
        return np
    }
    private var seekable: Bool { np.seekable && (np.duration ?? 0) > 0 }

    var body: some View {
        let info = TVCatalog.info(for: device.app)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                artwork(info)
                VStack(alignment: .leading, spacing: 3) {
                    Text(np.title).font(.headline).foregroundStyle(Color.ink).lineLimit(2)
                    Text(np.subtitle ?? device.app?.name ?? "").font(.subheadline).foregroundStyle(Color.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            TimelineView(.animation(minimumInterval: 1 / 30, paused: current.state != "playing" || drag != nil)) { ctx in
                scrubber(now: ctx.date.timeIntervalSince1970)
            }
            HStack(spacing: 28) {
                Spacer()
                skip(-10, symbol: "gobackward.10")
                Button {
                    Haptics.light()
                    let cur = current
                    var p = cur
                    p.state = cur.state == "paused" ? "playing" : "paused"
                    p.position = cur.position()
                    p.at = Date().timeIntervalSince1970
                    asked = (p, Date().addingTimeInterval(4), false)
                    onPlayPause()
                } label: {
                    Image(systemName: current.state == "paused" ? "play.fill" : "pause.fill")
                        .font(.system(size: 22, weight: .bold))
                        .frame(width: 54, height: 54)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .accessibilityLabel(current.state == "paused" ? "Play" : "Pause")
                skip(30, symbol: "goforward.30")
                Spacer()
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color.fill))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color(hex: info.glow).opacity(0.35)))
        .onChange(of: np) { _, next in
            // The TV caught up with what was asked: its own reports take over.
            guard let a = asked else { return }
            if next.title != a.patch.title { asked = nil; return }
            if !a.seek { if next.state == a.patch.state { asked = nil }; return }
            if let want = a.patch.position(), let got = next.position(), abs(want - got) < 2.5 { asked = nil }
        }
    }

    private func artwork(_ info: TVAppInfo) -> some View {
        let w: CGFloat = poster ? 64 : 120, h: CGFloat = poster ? 92 : 68
        return ZStack(alignment: .bottomTrailing) {
            AsyncImage(url: np.artwork) { phase in
                if let img = phase.image {
                    img.resizable().aspectRatio(contentMode: .fill)
                } else {
                    AppLogo(app: info, size: max(w, h)).frame(width: w, height: h).clipped()
                }
            }
            .frame(width: w, height: h)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            AppLogo(app: info, size: 22)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(.white.opacity(0.6), lineWidth: 1))
                .offset(x: 5, y: 5)
        }
        .task(id: np.artwork) {
            // A tall picture is a poster: shown upright.
            guard let url = np.artwork, let (data, _) = try? await URLSession.shared.data(from: url), let img = UIImage(data: data) else { return }
            poster = img.size.height > img.size.width * 1.1
        }
    }

    private func skip(_ by: Double, symbol: String) -> some View {
        Button {
            guard seekable, let pos = current.position() else { return }
            Haptics.light()
            seek(pos + by)
        } label: {
            Image(systemName: symbol).font(.system(size: 22, weight: .medium)).frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(seekable ? Color.ink : Color.faint)
        .disabled(!seekable)
        .accessibilityLabel(by < 0 ? "Back 10 seconds" : "Ahead 30 seconds")
    }

    private func seek(_ seconds: Double) {
        guard seekable, let duration = np.duration else { return }
        let target = min(max(0, seconds), max(0, duration - 1))
        var p = current
        p.position = target
        p.at = Date().timeIntervalSince1970
        asked = (p, Date().addingTimeInterval(4), true)
        Task {
            if await onSeek(target) == false { asked = nil }
        }
    }

    private func scrubber(now: Double) -> some View {
        let duration = np.duration ?? 0
        let pos = drag.map { $0 * duration } ?? current.position(at: now) ?? 0
        let t = duration > 0 ? min(1, max(0, pos / duration)) : 0
        return VStack(spacing: 6) {
            GeometryReader { g in
                let w = g.size.width
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.fillHi).frame(height: drag != nil ? 8 : 5)
                    Capsule().fill(Color.ink.opacity(0.85)).frame(width: max(0, w * t), height: drag != nil ? 8 : 5)
                    if seekable {
                        Circle().fill(Color.ink)
                            .frame(width: drag != nil ? 20 : 12, height: drag != nil ? 20 : 12)
                            .offset(x: w * t - (drag != nil ? 10 : 6))
                    }
                    if drag != nil {
                        Text(clock(pos))
                            .font(.caption.weight(.bold)).monospacedDigit()
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .glassEffect(.regular, in: .capsule)
                            .fixedSize()
                            .position(x: min(max(w * t, 30), w - 30), y: -16)
                    }
                }
                .frame(height: 24)
                .contentShape(Rectangle())
                .onTouch { phase, p in
                    guard seekable else { return }
                    let f = min(1, max(0, Double(p.x / max(1, w))))
                    switch phase {
                    case .began, .moved:
                        let n = Int(f * 10)
                        if notch != nil, n != notch { Haptics.tick() }
                        notch = n
                        drag = f
                    case .ended:
                        Haptics.light()
                        drag = nil
                        notch = nil
                        seek(f * duration)
                    case .cancelled:
                        drag = nil
                        notch = nil
                    }
                }
            }
            .frame(height: 24)
            .animation(.snappy(duration: 0.15), value: drag != nil)
            HStack {
                Text(clock(pos)).monospacedDigit()
                Spacer()
                if duration > 0 { Text("−" + clock(duration - pos)).monospacedDigit() }
            }
            .font(.caption)
            .foregroundStyle(Color.muted)
        }
        .accessibilityElement()
        .accessibilityLabel("Position")
        .accessibilityValue(duration > 0 ? "\(clock(pos)) of \(clock(duration))" : clock(pos))
        .accessibilityAdjustableAction { dir in seek(pos + (dir == .increment ? 10 : -10)) }
    }
}
