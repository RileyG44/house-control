import SwiftUI
import UIKit

/// Long press, then drag: a UIKit long-press recognizer, so a press that moves first is a scroll
/// (or the card being pulled) and a lifted tile owns the finger until it is let go.
struct LiftGesture: UIGestureRecognizerRepresentable {
    var duration: Double = 0.38
    var space: String
    var onLift: (CGPoint) -> Void
    var onMove: (CGPoint) -> Void
    var onEnd: (Bool) -> Void   // false: cancelled

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let g = UILongPressGestureRecognizer()
        g.minimumPressDuration = duration
        g.allowableMovement = 8
        return g
    }

    func updateUIGestureRecognizer(_ recognizer: UILongPressGestureRecognizer, context: Context) {
        recognizer.minimumPressDuration = duration
    }

    func handleUIGestureRecognizerAction(_ g: UILongPressGestureRecognizer, context: Context) {
        let p = context.converter.location(in: .named(space))
        switch g.state {
        case .began: onLift(p)
        case .changed: onMove(p)
        case .ended: onEnd(true)
        case .cancelled, .failed: onEnd(false)
        default: break
        }
    }
}

/// A tile held and dragged is not also tapped: taps are ignored from the lift until shortly after the drop.
@MainActor
enum TileGuard {
    static var lifted = false
    static var droppedAt = Date.distantPast
    static var allowsTap: Bool { !lifted && Date().timeIntervalSince(droppedAt) > 0.35 }
}

/// Where each tile of a room goes: lamps two to a row, the AC and the TV across the whole width.
enum TileLayout {
    static let gap: CGFloat = 10
    static let lampHeight: CGFloat = 70
    static let wideHeight: CGFloat = 66

    static func frames(_ tiles: [Tile], width: CGFloat) -> (frames: [String: CGRect], height: CGFloat) {
        let cw = (width - gap) / 2
        var out: [String: CGRect] = [:]
        var y: CGFloat = 0
        var col = 0
        for t in tiles {
            if t.wide {
                if col == 1 { y += lampHeight + gap; col = 0 }
                out[t.id] = CGRect(x: 0, y: y, width: width, height: wideHeight)
                y += wideHeight + gap
            } else {
                out[t.id] = CGRect(x: CGFloat(col) * (cw + gap), y: y, width: cw, height: lampHeight)
                col += 1
                if col == 2 { col = 0; y += lampHeight + gap }
            }
        }
        if col == 1 { y += lampHeight + gap }
        return (out, max(0, y - gap))
    }
}

/// One room on the card: its heading (fold it away with a tap) and its tiles, which can be held
/// and dragged into another order within the room.
struct RoomSection: View {
    let room: Room
    let tiles: [Tile]
    @Environment(HomeStore.self) private var store
    @Environment(CardModel.self) private var card
    @State private var width: CGFloat = 340
    /// The tiles' order while one is being dragged.
    @State private var dragOrder: [String]?
    @State private var lifted: String?
    @State private var grab: CGPoint = .zero       // where the finger took the tile, in its frame
    @State private var finger: CGPoint = .zero
    @State private var startOrder: [String] = []
    @State private var startFinger: CGPoint = .zero

    private var space: String { "room-\(room.id)" }

    var body: some View {
        let folded = store.folded.contains(room.id)
        VStack(alignment: .leading, spacing: 10) {
            RoomHeader(room: room, tiles: tiles, folded: folded) {
                Haptics.light()
                withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) { store.toggleFold(room.id) }
            } onHold: {
                Haptics.medium()
                withAnimation(.snappy) { card.arrangingRooms = true }
            }
            if !folded {
                grid
                    .transition(.opacity.combined(with: .move(edge: .top)).combined(with: .scale(scale: 0.98, anchor: .top)))
            }
        }
    }

    private var shown: [Tile] {
        guard let order = dragOrder else { return tiles }
        let byID = Dictionary(uniqueKeysWithValues: tiles.map { ($0.id, $0) })
        return order.compactMap { byID[$0] }
    }

    private var grid: some View {
        let layout = TileLayout.frames(shown, width: width)
        return ZStack(alignment: .topLeading) {
            ForEach(tiles) { tile in
                let f = layout.frames[tile.id] ?? .zero
                let isLifted = lifted == tile.id
                tileView(tile)
                    .frame(width: f.width, height: f.height)
                    .scaleEffect(isLifted ? 1.04 : 1)
                    .shadow(color: .black.opacity(isLifted ? 0.28 : 0), radius: isLifted ? 18 : 0, y: isLifted ? 10 : 0)
                    .offset(x: isLifted ? finger.x - grab.x : f.minX, y: isLifted ? finger.y - grab.y : f.minY)
                    .zIndex(isLifted ? 10 : 0)
                    .opacity(lifted != nil && !isLifted ? 0.92 : 1)
                    .gesture(LiftGesture(space: space,
                                         onLift: { lift(tile, at: $0, frame: f) },
                                         onMove: { move(to: $0) },
                                         onEnd: { drop(tile, done: $0) }))
            }
        }
        .frame(width: width, height: layout.height, alignment: .topLeading)
        .coordinateSpace(.named(space))
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { if $0 > 0 { width = $0 } }
    }

    @ViewBuilder
    private func tileView(_ tile: Tile) -> some View {
        switch tile.kind {
        case .light:
            if let cfg = store.lightConfig(tile.deviceID) { LightTile(cfg: cfg) { card.open(.light(cfg.id)) } }
        case .ac:
            if let cfg = store.acConfig(tile.deviceID) { ACTile(cfg: cfg) { card.open(.ac(cfg.id)) } }
        case .tv:
            TVTile(tile: tile) { card.open(.tv(tile.deviceID)) }
        case .speaker:
            SpeakerTile() { card.open(.speaker(tile.deviceID)) }
        }
    }

    // MARK: - dragging

    private func lift(_ tile: Tile, at p: CGPoint, frame: CGRect) {
        TileGuard.lifted = true
        Haptics.medium()
        startOrder = tiles.map(\.id)
        dragOrder = startOrder
        grab = CGPoint(x: p.x - frame.minX, y: p.y - frame.minY)
        finger = p
        startFinger = p
        withAnimation(.spring(response: 0.25, dampingFraction: 0.7)) { lifted = tile.id }
    }

    private func move(to p: CGPoint) {
        guard let key = lifted, var order = dragOrder else { return }
        // Clamped to the room: a tile moves only among its own room's tiles.
        let layout = TileLayout.frames(shown, width: width)
        finger = CGPoint(x: min(max(p.x, grab.x - 8), width - (layout.frames[key]?.width ?? 0) + grab.x + 8),
                         y: min(max(p.y, grab.y - 24), layout.height - (layout.frames[key]?.height ?? 0) + grab.y + 24))
        let center = CGPoint(x: finger.x - grab.x + (layout.frames[key]?.width ?? 0) / 2,
                             y: finger.y - grab.y + (layout.frames[key]?.height ?? 0) / 2)
        let byID = Dictionary(uniqueKeysWithValues: tiles.map { ($0.id, $0) })
        order.removeAll { $0 == key }
        var best: (Int, CGFloat) = (0, .infinity)
        for i in 0...order.count {
            var candidate = order
            candidate.insert(key, at: i)
            let f = TileLayout.frames(candidate.compactMap { byID[$0] }, width: width).frames[key] ?? .zero
            let d = hypot(f.midX - center.x, f.midY - center.y)
            if d < best.1 { best = (i, d) }
        }
        order.insert(key, at: best.0)
        if order != dragOrder {
            Haptics.tick()
            // The others slide out of the way; the lifted tile stays under the finger.
            withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { dragOrder = order }
        }
    }

    private func drop(_ tile: Tile, done: Bool) {
        TileGuard.lifted = false
        TileGuard.droppedAt = Date()
        guard lifted == tile.id else { return }
        let order = done ? (dragOrder ?? startOrder) : startOrder
        let still = hypot(finger.x - startFinger.x, finger.y - startFinger.y) < 10
        if order != startOrder {
            store.reorderTiles(order)
            Haptics.light()
        }
        withAnimation(.spring(response: 0.3, dampingFraction: 0.72)) {
            lifted = nil
            dragOrder = nil
        }
        // Held and let go where it was: the device's page.
        if done, still, order == startOrder {
            switch tile.kind {
            case .light: card.open(.light(tile.deviceID))
            case .ac: card.open(.ac(tile.deviceID))
            case .tv: card.open(.tv(tile.deviceID))
            case .speaker: card.open(.speaker(tile.deviceID))
            }
        }
    }
}

struct RoomHeader: View {
    let room: Room
    let tiles: [Tile]
    let folded: Bool
    var onTap: () -> Void
    var onHold: () -> Void
    @Environment(HomeStore.self) private var store

    var body: some View {
        let lamps = store.plan.lights.filter { $0.room == room.id }
        let on = lamps.filter { store.lights[$0.id]?.on == true }.count
        HStack(spacing: 8) {
            Text(room.name.uppercased())
                .font(.caption.weight(.bold))
                .tracking(1.2)
                .foregroundStyle(Color.muted)
            if on > 0 {
                Text("\(on)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.warmInk)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.warm))
                    .contentTransition(.numericText(value: Double(on)))
            }
            Spacer()
            if folded {
                Text(on > 0 ? "\(on) on" : "\(tiles.count) \(tiles.count == 1 ? "device" : "devices")")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Color.faint)
            }
            Image(systemName: "chevron.down")
                .font(.caption.weight(.bold))
                .foregroundStyle(Color.faint)
                .rotationEffect(.degrees(folded ? -90 : 0))
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
        .onLongPressGesture(minimumDuration: 0.42, perform: onHold)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(room.name), \(on) on")
        .accessibilityValue(folded ? "Folded" : "Open")
        .accessibilityAddTraits(.isButton)
    }
}

/// Putting rooms in order: one row per room, held and dragged like tiles; Done (the header's
/// check) goes back to the list.
struct RoomArranger: View {
    @Environment(HomeStore.self) private var store
    @Environment(CardModel.self) private var card
    @State private var dragOrder: [String]?
    @State private var lifted: String?
    @State private var grabY: CGFloat = 0
    @State private var fingerY: CGFloat = 0
    private let rowH: CGFloat = 56
    private let gap: CGFloat = 8

    var body: some View {
        let rooms = store.orderedRooms
        let order = dragOrder ?? rooms.map(\.id)
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Hold and drag a room to move it").font(.footnote).foregroundStyle(Color.muted)
                Spacer()
                Button("Done") { withAnimation(.snappy) { card.arrangingRooms = false } }
                    .buttonStyle(.glassProminent)
            }
            ZStack(alignment: .topLeading) {
                ForEach(rooms) { room in
                    let i = CGFloat(order.firstIndex(of: room.id) ?? 0)
                    let isLifted = lifted == room.id
                    HStack(spacing: 12) {
                        Image(systemName: "line.3.horizontal").foregroundStyle(Color.faint)
                        Text(room.name).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                        Spacer()
                        Text("\(store.tiles(in: room.id).count)").font(.footnote).foregroundStyle(Color.faint)
                    }
                    .padding(.horizontal, 16)
                    .frame(height: rowH)
                    .frame(maxWidth: .infinity)
                    .background(TileBackground(on: false, tint: .clear))
                    .scaleEffect(isLifted ? 1.04 : 1)
                    .shadow(color: .black.opacity(isLifted ? 0.25 : 0), radius: 16, y: 8)
                    .offset(y: isLifted ? fingerY - grabY : i * (rowH + gap))
                    .zIndex(isLifted ? 1 : 0)
                    .gesture(LiftGesture(duration: 0.12, space: "rooms",
                                         onLift: { p in
                                             Haptics.medium()
                                             dragOrder = rooms.map(\.id)
                                             grabY = p.y - i * (rowH + gap)
                                             fingerY = p.y
                                             withAnimation(.spring(response: 0.25, dampingFraction: 0.7)) { lifted = room.id }
                                         },
                                         onMove: { p in
                                             guard var o = dragOrder else { return }
                                             fingerY = min(max(p.y, grabY - 20), CGFloat(rooms.count - 1) * (rowH + gap) + grabY + 20)
                                             let slot = Int(((fingerY - grabY) / (rowH + gap)).rounded())
                                             let target = min(max(slot, 0), rooms.count - 1)
                                             o.removeAll { $0 == room.id }
                                             o.insert(room.id, at: target)
                                             if o != dragOrder {
                                                 Haptics.tick()
                                                 withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { dragOrder = o }
                                             }
                                         },
                                         onEnd: { done in
                                             if done, let o = dragOrder { store.reorderRooms(o); Haptics.light() }
                                             withAnimation(.spring(response: 0.3, dampingFraction: 0.75)) { lifted = nil; dragOrder = nil }
                                         }))
                }
            }
            .frame(height: CGFloat(rooms.count) * (rowH + gap) - gap, alignment: .top)
            .coordinateSpace(.named("rooms"))
        }
    }
}
