import RealityKit
import SwiftUI

/// Holds the scene across SwiftUI updates (and lets the RealityView's closures reach it).
@MainActor @Observable
final class SceneBox {
    /// How far the camera is into the TV's close-up, mirrored from the scene so the view's framing
    /// (which SwiftUI only recomputes on observed changes) follows it.
    var tvness: CGFloat = 0
    @ObservationIgnored var scene: HomeScene?
    @ObservationIgnored let holder = Entity()
    @ObservationIgnored var subscription: EventSubscription?
    @ObservationIgnored var builtRev = -1
    @ObservationIgnored var lastPick = Date.distantPast
    @ObservationIgnored var dragStart: (az: Float, el: Float)?
    @ObservationIgnored var pinchStart: Float?
}

/// The 3D home behind the card: full screen and never resized. As the card is pulled up the view
/// is scaled and moved (from the card's live position) into the strip above it; in front of the
/// TV the strip shows the TV's straight-on view, its edges faded into the background.
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
                MainActor.assumeIsolated {
                    guard let scene = box.scene else { return }
                    scene.update(dt: Float(min(0.05, event.deltaTime)))
                    if abs(scene.tvness - box.tvness) > 0.002 { box.tvness = scene.tvness }
                }
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
        let p = min(1, max(0, card.progress))
        guard p > 0.0005, let r = scene.restRect() else { return Framing(clip: full) }
        let side: CGFloat = 12
        let miniTop = safeTop + 4, miniBottom = CardMetrics.expandedTop - 6
        let mw = max(10, size.width - side * 2), mh = max(10, miniBottom - miniTop)
        let tv = box.tvness
        let fit = mh * 0.94 / r.height
        // The TV's view is fitted by height (its sides run on past the frame and fade out).
        let s1 = min(1, fit, mw * 0.96 / r.width + (fit - mw * 0.96 / r.width) * tv)
        let s = 1 + (s1 - 1) * p
        let R = CGPoint(x: r.midX, y: r.midY)
        let M = CGPoint(x: size.width / 2, y: (miniTop + miniBottom) / 2)
        let C = CGPoint(x: R.x + (M.x - R.x) * p, y: R.y + (M.y - R.y) * p)
        let offset = CGSize(width: C.x - R.x * s, height: C.y - R.y * s)
        // In front of the TV the shrunken picture ends inside the strip: its edges are faded into
        // the background (no hard frame), and its foot tucks under the card.
        let k = p * tv
        let feather: CGFloat = 16
        let picture = CGRect(x: offset.width, y: offset.height, width: size.width * s, height: size.height * s)
            .insetBy(dx: feather, dy: feather)
        let clip = CGRect(x: full.minX + (picture.minX - full.minX) * k, y: full.minY + (picture.minY - full.minY) * k,
                          width: full.width + (picture.width - full.width) * k, height: full.height + (picture.height - full.height) * k)
        return Framing(scale: s, offset: offset, clip: clip, radius: 18 * k, feather: feather * k)
    }
}
