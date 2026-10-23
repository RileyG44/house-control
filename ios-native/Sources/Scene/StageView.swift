import RealityKit
import SwiftUI

/// Holds the scene across SwiftUI updates (and lets the RealityView's closures reach it).
@MainActor @Observable
final class SceneBox {
    @ObservationIgnored var scene: HomeScene?
    @ObservationIgnored let holder = Entity()
    @ObservationIgnored var subscription: EventSubscription?
    @ObservationIgnored var builtRev = -1
    @ObservationIgnored var lastPick = Date.distantPast
    @ObservationIgnored var dragStart: (az: Float, el: Float)?
    @ObservationIgnored var pinchStart: Float?
}

/// The 3D home behind the card. The viewport gets shorter as the card rises and stays full
/// width, so the surrounding sky and landscape remain edge to edge at either detent.
struct StageView: View {
    var size: CGSize
    var safeTop: CGFloat
    @Environment(HomeStore.self) private var store
    @Environment(CardModel.self) private var card
    @Environment(\.colorScheme) private var scheme
    @State private var box = SceneBox()

    var body: some View {
        let t = framing
        RealityView { content in
            content.camera = .virtual
            content.add(box.holder)
            box.subscription = content.subscribe(to: SceneEvents.Update.self) { [box] event in
                MainActor.assumeIsolated {
                    guard let scene = box.scene else { return }
                    scene.update(dt: Float(min(0.05, event.deltaTime)))
                }
            }
        }
        .gesture(SpatialTapGesture().targetedToAnyEntity().onEnded { value in
            // A tabletop speaker can share a lamp's oversized interaction box.
            let speaker = value.hitTest(point: value.location, in: .local, query: .all, mask: .all)
                .first { $0.entity.name.hasPrefix("pick:speaker:") }
            pick(speaker?.entity ?? value.entity)
        })
        .simultaneousGesture(SpatialTapGesture().onEnded { _ in backgroundTap() })
        .simultaneousGesture(orbit)
        .simultaneousGesture(magnify)
        .frame(width: t.viewport.width, height: t.viewport.height)
        // Its foot fades out under the card instead of ending in a line.
        .mask {
            LinearGradient(stops: [.init(color: .black, location: 0),
                                   .init(color: .black, location: t.fadeStart),
                                   .init(color: .black.opacity(1 - t.progress), location: 1)],
                           startPoint: .top, endPoint: .bottom)
        }
        .frame(width: size.width, height: size.height, alignment: .top)
        .onAppear(perform: rebuildIfNeeded)
        .onChange(of: store.modelRev) { rebuildIfNeeded() }
        .onChange(of: scheme, initial: true) { box.scene?.lookGoal = scheme == .light ? 1 : 0 }
        .onChange(of: card.route, initial: true) { applyFocus() }
        .onChange(of: t, initial: true) { resize() }
        .accessibilityLabel("The 3D view of \(store.plan.name)")
    }

    // MARK: - the scene

    private func rebuildIfNeeded() {
        guard box.builtRev != store.modelRev else { return }
        box.builtRev = store.modelRev
        let scene = HomeScene(plan: store.plan, store: store, light: scheme == .light)
        box.holder.children.removeAll()
        box.holder.addChild(scene.root)
        box.scene = scene
        resize()
        applyFocus()
        scene.syncInstantly()
    }

    /// Fit the camera to the same viewport RealityKit is drawing, at every sheet position.
    private func resize() {
        let t = framing
        box.scene?.resize(t.viewport, top: t.topInset, bottom: t.bottomInset)
    }

    private func applyFocus() {
        guard let scene = box.scene else { return }
        switch card.route {
        case .tv(let id)?: scene.setFocus(.tv(id))
        case .ac(let id)?: scene.setFocus(.ac(id))
        case .light(let id)?: scene.setFocus(store.lightConfig(id).map { .room($0.room) } ?? .home)
        default: scene.setFocus(.home)
        }
    }

    // MARK: - touches

    private func pick(_ entity: Entity) {
        var e: Entity? = entity
        while let x = e, Pick(name: x.name) == nil { e = x.parent }
        guard let name = e?.name, let p = Pick(name: name) else { return }
        box.lastPick = Date()
        switch p {
        case .light(let id):
            Haptics.tick()
            box.scene?.lamps[id]?.bump()
            store.toggleLight(id)
        case .ac(let id):
            Haptics.light()
            card.open(.ac(id))
        case .tv(let id):
            guard !id.isEmpty else { return }
            Haptics.light()
            card.open(.tv(id))
        case .speaker(let id):
            Haptics.light()
            card.open(.speaker(id))
        }
    }

    /// A tap on the small model over the pulled-up card (not on a lamp, the AC or the TV) puts the card down.
    private func backgroundTap() {
        let expanded = card.progress > 0.5
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
            guard Date().timeIntervalSince(box.lastPick) > 0.2, expanded else { return }
            Haptics.tick()
            card.detent = .rest
        }
    }

    private var orbit: some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { v in
                guard let scene = box.scene else { return }
                if box.dragStart == nil { box.dragStart = (scene.goal.az, scene.goal.el) }
                scene.orbit(byX: Float(v.translation.width), y: Float(v.translation.height), from: box.dragStart!)
            }
            .onEnded { _ in box.dragStart = nil }
    }

    private var magnify: some Gesture {
        MagnifyGesture()
            .onChanged { v in
                guard let scene = box.scene else { return }
                if box.pinchStart == nil { box.pinchStart = scene.zoom }
                scene.pinch(box.pinchStart! / Float(v.magnification))
            }
            .onEnded { _ in box.pinchStart = nil }
    }

    private var framing: StageFraming {
        StageFraming(size: size, safeTop: safeTop, restTop: CardMetrics.restTop,
                     expandedTop: CardMetrics.expandedTop, progress: card.progress)
    }
}
