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
                AskButton()
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.top, 6)
                    .padding(.trailing, 18)
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

/// The house agent's mic, in the top corner over the 3D home: it opens VoiceSheet, listening. The
/// sheet goes over the card (the card presents it), so the home stays as it was underneath.
struct AskButton: View {
    @Environment(CardModel.self) private var card
    @Environment(HubClient.self) private var hub

    private var connected: Bool { if case .connected = hub.link { return true }; return false }

    var body: some View {
        Button {
            Haptics.light()
            card.asking = true
        } label: {
            Image(systemName: "mic.fill")
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 30, height: 30)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .disabled(!connected)
        .opacity(connected ? 1 : 0.5)
        .accessibilityLabel("Ask the house")
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
