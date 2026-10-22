import SwiftUI

/// Presets share the device tiles' hold gesture: release to edit, or drag to change order.
/// A short horizontal swipe still scrolls the row. The order is saved only after a drop.
struct ScenesRow: View {
    @Environment(HomeStore.self) private var store
    @Environment(CardModel.self) private var card
    @State private var order: [String]?
    @State private var lifted: String?
    @State private var finger: CGFloat = 0
    @State private var grab: CGFloat = 0
    @State private var origin: CGFloat = 0
    @State private var travel: CGFloat = 0
    @State private var scrollX: CGFloat = 0
    @State private var visibleWidth: CGFloat = 340
    private let width: CGFloat = 82
    private let gap: CGFloat = 10

    var body: some View {
        let scenes = store.plan.scenes
        let keys = order ?? scenes.map(\.id)
        let byID = Dictionary(uniqueKeysWithValues: scenes.map { ($0.id, $0) })
        let shown = keys.compactMap { byID[$0] }
        ScrollViewReader { reader in
            ScrollView(.horizontal) {
                // Real layout positions let ScrollViewReader find the next chip at an edge.
                HStack(spacing: gap) {
                    ForEach(shown) { scene in
                        let index = keys.firstIndex(of: scene.id) ?? 0
                        let active = store.scene == scene.id
                        let dragging = lifted == scene.id
                        VStack(spacing: 7) {
                            Image(systemName: sceneSymbol(scene.icon))
                                .font(.system(size: 19, weight: .regular))
                                .foregroundStyle(active ? Color.stage : Color.ink)
                                .frame(width: 48, height: 48)
                                .background(Circle().fill(active ? Color.ink : Color.fill))
                                .overlay(Circle().strokeBorder(Color.line, lineWidth: 1))
                            Text(scene.name).font(.footnote).foregroundStyle(Color.ink).lineLimit(1)
                        }
                        .frame(width: width, height: 80)
                        .contentShape(Rectangle())
                        .scaleEffect(dragging ? 1.1 : 1)
                        .shadow(color: .black.opacity(dragging ? 0.25 : 0), radius: 12, y: 5)
                        .offset(x: dragging ? finger - grab - CGFloat(index) * (width + gap) : 0)
                        .zIndex(dragging ? 10 : 0)
                        .id(scene.id)
                        .onTapGesture {
                            guard TileGuard.allowsTap else { return }
                            Haptics.medium(); store.applyScene(scene.id)
                        }
                        .gesture(LiftGesture(space: "presets", onLift: { p in
                            TileGuard.lifted = true
                            order = scenes.map(\.id); lifted = scene.id
                            finger = p.x; origin = p.x; travel = 0
                            grab = p.x - CGFloat(index) * (width + gap)
                            Haptics.medium()
                        }, onMove: { p in
                            guard lifted == scene.id, var next = order else { return }
                            finger = p.x; travel = max(travel, abs(p.x - origin))
                            let destination = min(next.count - 1, max(0, Int(((p.x - grab) / (width + gap)).rounded())))
                            let current = next.firstIndex(of: scene.id) ?? index
                            if destination != current {
                                next.remove(at: current); next.insert(scene.id, at: destination)
                                withAnimation(.snappy(duration: 0.2)) { order = next }
                                Haptics.tick()
                            }
                            if p.x > scrollX + visibleWidth - 35, destination + 1 < next.count {
                                withAnimation(.linear(duration: 0.15)) { reader.scrollTo(next[destination + 1], anchor: .trailing) }
                            } else if p.x < scrollX + 35, destination > 0 {
                                withAnimation(.linear(duration: 0.15)) { reader.scrollTo(next[destination - 1], anchor: .leading) }
                            }
                        }, onEnd: { done in
                            guard lifted == scene.id else { return }
                            TileGuard.lifted = false; TileGuard.droppedAt = Date()
                            if done, let order, order != scenes.map(\.id) { store.reorderScenes(order) }
                            else if done && travel < 10 { card.open(.scene(scene.id)) }
                            withAnimation(.snappy) { lifted = nil; order = nil }
                        }))
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction { store.applyScene(scene.id) }
                        .accessibilityAction(named: "Edit") { card.open(.scene(scene.id)) }
                        .accessibilityAction(named: "Delete") { store.deleteScene(scene.id) }
                        .accessibilityAction(named: "Move earlier") { move(scene.id, by: -1) }
                        .accessibilityAction(named: "Move later") { move(scene.id, by: 1) }
                    }
                    Button { Haptics.light(); card.open(.scene(nil)) } label: {
                        VStack(spacing: 7) {
                            Image(systemName: "plus").font(.system(size: 19)).frame(width: 48, height: 48).background(Circle().fill(Color.fill))
                            Text("New").font(.footnote)
                        }
                        .foregroundStyle(Color.ink).frame(width: width, height: 80)
                    }
                    .accessibilityLabel("New preset")
                }
                .frame(height: 80)
                .coordinateSpace(.named("presets"))
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.x } action: { _, x in scrollX = x }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { visibleWidth = $0 }
            .scrollIndicators(.hidden)
            .scrollClipDisabled()
        }
        .onChange(of: store.plan.scenes.map(\.id)) {
            // Another screen can remove or reorder a preset while it is being held.
            if lifted != nil { TileGuard.lifted = false; TileGuard.droppedAt = Date(); lifted = nil; order = nil }
        }
    }

    private func move(_ id: String, by delta: Int) {
        var ids = store.plan.scenes.map(\.id)
        guard let index = ids.firstIndex(of: id) else { return }
        let to = min(ids.count - 1, max(0, index + delta))
        ids.remove(at: index); ids.insert(id, at: to)
        withAnimation(.snappy) { store.reorderScenes(ids) }
    }
}
