import SwiftUI

/// The house agent's card, from the mic on the home stage (AskButton, VoiceAgent.swift): it listens as it
/// opens, shows the words as they come, then the request's steps and the reply. The mic stops it
/// early; the field below takes a typed request instead.
struct VoiceSheet: View {
    @Environment(HomeStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @FocusState private var typing: Bool

    var body: some View {
        let voice = store.voice
        let listening = voice.phase == .listening
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Ask the house")
                    .font(.house(20, weight: .semibold))
                    .foregroundStyle(Color.ink)
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .bold))
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("Close")
            }

            Group {
                if listening {
                    Text(voice.transcript.isEmpty ? "Listening…" : voice.transcript)
                        .foregroundStyle(voice.transcript.isEmpty ? Color.muted : Color.ink)
                } else if !voice.request.isEmpty {
                    Text("“\(voice.request)”")
                        .foregroundStyle(Color.muted)
                }
            }
            .font(.house(19, weight: .medium))
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(.snappy, value: voice.transcript)

            if !voice.steps.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(voice.steps) { step in
                        Label {
                            Text(step.text)
                                .foregroundStyle(step.ok == false ? Color.danger : Color.muted)
                        } icon: {
                            Image(systemName: step.ok == false ? "exclamationmark.circle.fill"
                                  : step.ok == nil ? "circle.dotted" : "checkmark.circle.fill")
                                .foregroundStyle(step.ok == false ? Color.danger : step.ok == nil ? Color.faint : Color.accentColor)
                                .symbolEffect(.rotate, isActive: step.ok == nil)
                        }
                        .font(.subheadline.weight(.medium))
                        .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .animation(.snappy, value: voice.steps)
            }

            if voice.phase == .thinking {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(voice.steps.isEmpty ? "Thinking…" : "Working on it…")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.muted)
                }
            } else if !voice.reply.isEmpty {
                Text(voice.reply)
                    .font(.body.weight(.medium))
                    .foregroundStyle(voice.phase == .failed ? Color.danger : Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            if let note = voice.note {
                Text(note)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.warm)
            }

            Spacer(minLength: 0)

            HStack(spacing: 10) {
                TextField("Or type it…", text: $typed)
                    .font(.body)
                    .submitLabel(.send)
                    .focused($typing)
                    .onSubmit(sendTyped)
                    .padding(.horizontal, 16)
                    .frame(height: 46)
                    .background(Capsule().fill(Color.fill))
                    .disabled(voice.phase == .thinking)
                    .onChange(of: typing) { _, now in if now { voice.cancel() } }
                Button {
                    if !typed.trimmingCharacters(in: .whitespaces).isEmpty {
                        sendTyped()
                    } else if listening {
                        voice.finishListening()
                    } else {
                        typing = false
                        Task { if !(await voice.listen()) { typing = true } }
                    }
                } label: {
                    Image(systemName: !typed.trimmingCharacters(in: .whitespaces).isEmpty ? "arrow.up"
                          : listening ? "stop.fill" : "mic.fill")
                        .font(.system(size: 20, weight: .bold))
                        .frame(width: 34, height: 34)
                        .foregroundStyle(listening ? Color.stage : Color.ink)
                        .symbolEffect(.pulse, isActive: listening)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .tint(listening ? Color.accentColor : Color.fillHi)
                .disabled(voice.phase == .thinking)
                .accessibilityLabel(listening ? "Stop listening" : typed.isEmpty ? "Speak" : "Send")
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 22)
        .padding(.bottom, 14)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground { LauncherField(card: true) }
        .task {
            if !(await voice.listen()) { typing = true }
        }
        .onDisappear { voice.cancel() }
    }

    private func sendTyped() {
        let text = typed
        typed = ""
        store.voice.send(text, spoken: false)
    }
}
