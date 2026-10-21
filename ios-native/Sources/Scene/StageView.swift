import RealityKit
import SwiftUI

/// Holds the scene across SwiftUI updates (and lets the RealityView's closures reach it).
@MainActor
final class SceneBox {
    var scene: HomeScene?
    let holder = Entity()
    var subscription: EventSubscription?
    var builtRev = -1
    var lastPick = Date.distantPast
    var dragStart: (az: Float, el: Float)?
    var pinchStart: Float?
}

/// The 3D home behind the card: full screen and never resized. As the card is pulled up the view
/// is scaled and moved (from the card's live position) into the strip above it; in front of the
/// TV the camera itself frames the TV and its wall into whatever room the card leaves.
struct StageView: View {
    var size: CGSize
    var safeTop: CGFloat
    @Environment(HomeStore.self) private var store
    @Environment(CardModel.self) private var card
    @Environment(\.colorScheme) private var scheme
    @State private var box = SceneBox()

    var body: some View {
        let t = framing()
        RealityView { content in
            content.camera = .virtual
            content.add(box.holder)
            box.subscription = content.subscribe(to: SceneEvents.Update.self) { [box] event in
                MainActor.assumeIsolated { box.scene?.update(dt: Float(min(0.05, event.deltaTime))) }
            }
        }
        .gesture(SpatialTapGesture().targetedToAnyEntity().onEnded { value in pick(value.entity) })
        .simultaneousGesture(SpatialTapGesture().onEnded { _ in backgroundTap() })
        .simultaneousGesture(orbit)
        .simultaneousGesture(magnify)
        .frame(width: size.width, height: size.height)
        .scaleEffect(t.scale, anchor: .topLeading)
        .offset(t.offset)
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .mask {
            RoundedRectangle(cornerRadius: t.radius, style: .continuous)
                .frame(width: t.clip.width, height: t.clip.height)
                .position(x: t.clip.midX, y: t.clip.midY)
                .blur(radius: t.feather)
        }
        .onAppear(perform: rebuildIfNeeded)
        .onChange(of: store.modelRev) { rebuildIfNeeded() }
        .onChange(of: scheme, initial: true) { box.scene?.lookGoal = scheme == .light ? 1 : 0 }
        .onChange(of: card.route, initial: true) { applyFocus() }
        .onChange(of: size, initial: true) { resize() }
        .onChange(of: card.top, initial: true) { box.scene?.cardTop = card.top }
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

    private func resize() {
        box.scene?.resize(size, top: safeTop + 4, bottom: size.height - CardMetrics.restTop + 10)
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

    // MARK: - the card's progress

    struct Framing {
        var scale: CGFloat = 1
        var offset: CGSize = .zero
        var clip: CGRect
        var radius: CGFloat = 0
        var feather: CGFloat = 0
    }

    /// At rest the model fills the area above the card; pulled up, the same picture is scaled and
    /// moved into the strip between the Dynamic Island and the card, in step with the card.
    private func framing() -> Framing {
        let full = CGRect(origin: .zero, size: size)
        guard let scene = box.scene else { return Framing(clip: full) }
        // In front of the TV the camera itself frames the strip (HomeScene.cardTop): no scaling.
        let p = min(1, max(0, card.progress)) * (1 - scene.tvness)
        guard p > 0.0005, let r = scene.restRect() else { return Framing(clip: full) }
        let side: CGFloat = 12
        let miniTop = safeTop + 4, miniBottom = CardMetrics.expandedTop - 6
        let mw = max(10, size.width - side * 2), mh = max(10, miniBottom - miniTop)
        let fit = mh * 0.94 / r.height
        let s1 = min(1, fit, mw * 0.96 / r.width)
        let s = 1 + (s1 - 1) * p
        let R = CGPoint(x: r.midX, y: r.midY)
        let M = CGPoint(x: size.width / 2, y: (miniTop + miniBottom) / 2)
        let C = CGPoint(x: R.x + (M.x - R.x) * p, y: R.y + (M.y - R.y) * p)
        return Framing(scale: s, offset: CGSize(width: C.x - R.x * s, height: C.y - R.y * s), clip: full)
    }
}
