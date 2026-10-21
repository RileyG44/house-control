import SwiftUI

/// Pairs this phone with the TV's own launcher, the way an Apple TV pairs a remote: the TV shows
/// a 4-digit code in its top corner, and the code typed here is traded for the launcher's token,
/// which stays in this phone's Keychain. The fourth digit sends it. Cancel, or swiping the sheet
/// away, hides the code on the TV.
struct PairTVSheet: View {
    let id: String
    @Environment(HomeStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var checking = false
    @State private var note: String?
    @State private var tries = 0
    @State private var paired = false
    @FocusState private var focused: Bool

    /// The TV takes its code away after five wrong ones.
    private let maxTries = 5

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Image(systemName: "tv")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                Text("Type the 4-digit code the TV shows in its top corner.")
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
                    .multilineTextAlignment(.center)
                TextField("0000", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
                    .multilineTextAlignment(.center)
                    .focused($focused)
                    .frame(maxWidth: 180)
                    .padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.fill))
                    .disabled(tries >= maxTries)
                    .onChange(of: code) { _, now in
                        let digits = String(now.filter { $0.isASCII && $0.isNumber }.prefix(4))
                        if digits != now { code = digits; return }
                        if digits.count == 4 { finish(digits) }
                    }
                    .accessibilityLabel("Code on the TV")
                Group {
                    if checking {
                        ProgressView()
                    } else if let note {
                        Text(note).font(.footnote).foregroundStyle(Color.danger).multilineTextAlignment(.center)
                    } else {
                        Text("After this, the remote talks to the TV straight over the Wi-Fi when you’re home, and through the hub when you’re not.")
                            .font(.footnote)
                            .foregroundStyle(Color.faint)
                            .multilineTextAlignment(.center)
                    }
                }
                .frame(minHeight: 36)
                Spacer(minLength: 0)
            }
            .padding(24)
            .navigationTitle("Pair with the TV")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
        .onAppear { focused = true }
        .onDisappear { if !paired { store.tv.cancelPairing(id) } }
    }

    private func finish(_ digits: String) {
        guard !checking, tries < maxTries else { return }
        checking = true
        note = nil
        Task {
            let result = await store.tv.finishPairing(id, code: digits)
            checking = false
            switch result {
            case .paired:
                paired = true
                Haptics.success()
                store.show("Paired: the remote talks to the TV directly")
                dismiss()
            case .wrongCode:
                tries += 1
                Haptics.error()
                code = ""
                note = tries >= maxTries ? "Too many tries: the TV took its code away. Close this and pair again."
                    : "That isn’t the code on the TV."
            case .failed(let why):
                Haptics.error()
                code = ""
                note = why
            }
        }
    }
}
