import AVFoundation
import Foundation
import Observation
import Speech

/// The house agent from the phone (docs/voice-agent.md): what is said is heard on the phone
/// (SFSpeechRecognizer, on the device when it can, fed by AVAudioEngine), sent to the hub as
/// `POST /api/agent {"text", "client"}` when the speaking stops (1.5 s of quiet, or a tap), and the
/// hub's Codex does it with the house tools. Its steps come over the hub's events (`{"agent": …}`,
/// this phone's requests only), the reply with the answer; a spoken request's reply is read out.
/// Typing works too, for when there's no microphone or no permission.
@MainActor @Observable
final class VoiceAgent {
    enum Phase: Equatable { case idle, listening, thinking, done, failed }

    struct Step: Identifiable, Equatable {
        var id: Int
        var text: String
        var ok: Bool?
    }

    /// How long a pause ends the request, and how long to wait for the first word.
    static let quiet: Double = 1.5
    static let firstWord: Double = 6

    let hub: HubClient
    private(set) var phase: Phase = .idle
    /// The words heard so far, while listening.
    private(set) var transcript = ""
    /// The request on its way, or the last one.
    private(set) var request = ""
    private(set) var steps: [Step] = []
    private(set) var reply = ""
    /// Why listening didn't work (no permission, nothing heard): the text field is the way then.
    private(set) var note: String?

    private let recognizer = SFSpeechRecognizer()
    private let engine = AVAudioEngine()
    @ObservationIgnored private var recognition: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var silence: Task<Void, Never>?
    private let synthesizer = AVSpeechSynthesizer()
    private let finished = SpeechFinished { VoiceAgent.releaseAudio() }
    @ObservationIgnored private var runID: String?

    init(hub: HubClient) {
        self.hub = hub
        synthesizer.delegate = finished
    }

    // MARK: - listening

    /// Starts listening. False when it can't (no permission, no recognizer): type instead.
    @discardableResult
    func listen() async -> Bool {
        guard phase != .listening, phase != .thinking else { return phase == .listening }
        stopSpeaking()
        note = nil
        guard let recognizer, recognizer.isAvailable else {
            note = "Speech recognition isn’t available right now: type instead"
            return false
        }
        guard await Self.authorized() else {
            note = "Allow the microphone and speech recognition in Settings to talk to the house, or type instead"
            return false
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
            Self.tap(engine.inputNode, into: request)
            engine.prepare()
            try engine.start()
            recognition = request
            task = Self.recognize(recognizer, request, for: self)
        } catch {
            stopAudio()
            note = "Couldn’t listen: type instead"
            return false
        }
        transcript = ""
        steps = []
        reply = ""
        phase = .listening
        Haptics.light()
        waitForQuiet(Self.firstWord)
        return true
    }

    /// Stops listening and sends what was heard (the mic tapped again, or the pause).
    func finishListening() {
        guard phase == .listening else { return }
        stopAudio()
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            phase = .idle
            note = "I didn’t catch that"
            return
        }
        send(text, spoken: true)
    }

    /// The sheet went away: nothing more is heard or said.
    func cancel() {
        stopAudio()
        stopSpeaking()
        if phase == .listening { phase = .idle }
    }

    private func heard(_ text: String?, final: Bool, failed: Bool) {
        guard phase == .listening else { return }
        if let text, !text.isEmpty, text != transcript {
            transcript = text
            waitForQuiet(Self.quiet)
        }
        if final || failed { finishListening() }
    }

    private func waitForQuiet(_ seconds: Double) {
        silence?.cancel()
        silence = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.finishListening()
        }
    }

    private func stopAudio() {
        silence?.cancel()
        silence = nil
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        recognition?.endAudio()
        task?.cancel()
        recognition = nil
        task = nil
        Self.releaseAudio()
    }

    // The microphone's buffers and the recognizer's results arrive on their own threads, so the
    // closures that take them are made outside the main actor.

    nonisolated private static func authorized() async -> Bool {
        let speech = await withCheckedContinuation { (done: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }

    nonisolated private static func tap(_ input: AVAudioInputNode, into request: SFSpeechAudioBufferRecognitionRequest) {
        nonisolated(unsafe) let request = request
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
            request.append(buffer)
        }
    }

    nonisolated private static func recognize(_ recognizer: SFSpeechRecognizer, _ request: SFSpeechAudioBufferRecognitionRequest,
                                              for owner: VoiceAgent) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { [weak owner] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let failed = error != nil
            guard let owner else { return }
            Task { @MainActor in owner.heard(text, final: final, failed: failed) }
        }
    }

    nonisolated static func releaseAudio() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - asking

    /// Sends `text` to the hub's agent; the reply comes when it is done (steps arrive meanwhile, in `take`).
    func send(_ text: String, spoken: Bool) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, phase != .thinking else { return }
        if phase == .listening { stopAudio() }
        stopSpeaking()
        request = text
        transcript = ""
        steps = []
        reply = ""
        note = nil
        runID = nil
        phase = .thinking   // at once: a late word from the recognizer finds it busy
        Task { await ask(text, spoken: spoken) }
    }

    private func ask(_ text: String, spoken: Bool) async {
        do {
            let answer = try await hub.post("api/agent", .object(["text": .string(text), "client": .string(hub.clientID)]), slow: true)
            if let list = answer["steps"]?.array { steps = Self.steps(list) }
            reply = answer["reply"]?.string ?? "Done."
            phase = .done
            Haptics.success()
        } catch {
            reply = error.localizedDescription
            phase = .failed
            Haptics.error()
        }
        if spoken { say(reply) }
    }

    /// A run as the hub tells every screen about it (HubClient.onAgent): only this phone's request.
    func take(_ run: JSON) {
        guard phase == .thinking, run["client"]?.string == hub.clientID else { return }
        let id = run["id"]?.string
        if let runID, id != runID { return }
        runID = id
        if let list = run["steps"]?.array { steps = Self.steps(list) }
    }

    private static func steps(_ list: [JSON]) -> [Step] {
        list.enumerated().map { i, step in
            Step(id: i, text: step["text"]?.string ?? step["tool"]?.string ?? "", ok: step["ok"]?.bool)
        }
    }

    // MARK: - speaking

    private func say(_ text: String) {
        guard !text.isEmpty else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .voicePrompt, options: .duckOthers)
        try? session.setActive(true)
        let line = AVSpeechUtterance(string: text)
        line.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        synthesizer.speak(line)
    }

    func stopSpeaking() {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
    }
}

/// Lets the audio go once a reply has been read out, so music that was ducked comes back up.
private final class SpeechFinished: NSObject, AVSpeechSynthesizerDelegate, Sendable {
    let done: @Sendable () -> Void

    init(_ done: @escaping @Sendable () -> Void) {
        self.done = done
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { done() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { done() }
}
