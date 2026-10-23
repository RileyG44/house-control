import SwiftUI

/// The whole screen: the 3D home filling it, and over it the controls card, a real sheet with two
/// detents. The 3D viewport follows the card's live position, keeping its full width while the
/// camera fits the house into the strip left between the Dynamic Island and the card.
struct HomeScreen: View {
    @Environment(HomeStore.self) private var store
    @Environment(CardModel.self) private var card

    var body: some View {
        @Bindable var card = card
        GeometryReader { geo in
            let _ = CardMetrics.update(size: geo.size, insets: geo.safeAreaInsets)
            ZStack(alignment: .top) {
                LauncherField().ignoresSafeArea()
                StageView(size: CGSize(width: geo.size.width, height: geo.size.height + geo.safeAreaInsets.top + geo.safeAreaInsets.bottom),
                          safeTop: geo.safeAreaInsets.top)
                    .ignoresSafeArea()
                ToastView()
                    .padding(.top, 6)
            }
        }
        .ignoresSafeArea(.keyboard)
        .sheet(isPresented: .constant(true)) {
            ControlsCard()
                .presentationDetents([.rest, .expanded], selection: $card.detent)
                .presentationBackgroundInteraction(.enabled(upThrough: .expanded))
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(36)
                .presentationBackground { LauncherField(card: true) }
                .interactiveDismissDisabled()
                .sensoryFeedback(.selection, trigger: card.detent)
                .onChange(of: card.detent) { card.detentChanged() }
        }
    }
}

extension CardMetrics {
    static func update(size: CGSize, insets: EdgeInsets) {
        let h = size.height + insets.top + insets.bottom
        guard h > 100 else { return }
        screenHeight = h
        safeTop = insets.top
        safeBottom = insets.bottom
    }
}

/// Errors and notes, under the Dynamic Island.
struct ToastView: View {
    @Environment(HomeStore.self) private var store

    var body: some View {
        if let t = store.toast {
            HStack(spacing: 8) {
                Image(systemName: t.error ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(t.error ? Color.danger : Color.accentColor)
                Text(t.text)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.ink)
                    .lineLimit(2)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .glassEffect(.regular, in: .capsule)
            .padding(.horizontal, 20)
            .transition(.move(edge: .top).combined(with: .opacity))
            .id(t.id)
            .onTapGesture { withAnimation { store.toast = nil } }
        }
    }
}
