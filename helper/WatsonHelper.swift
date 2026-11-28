// watson-helper: the native half of Watson.
//
// Electron starts this binary and talks to it over stdin/stdout, one JSON
// object per line. It owns everything that needs macOS frameworks:
//   - on-device speech recognition (Speech framework), with live partials
//   - the spoken voice (AVSpeechSynthesizer), played through the same audio
//     engine as the microphone so Apple's echo cancellation can remove it
//   - barge-in: if you talk over Watson, it stops speaking
//   - Accessibility: typing a request into another app (Claude, ChatGPT, ...)
//     and reading that app's window text back
//
// Commands in:  {"id":"r1","cmd":"listen.start"}
// Events out:   {"ev":"partial","text":"..."}  or  {"ev":"result","id":"r1","ok":true,"data":{...}}

import AppKit
import ApplicationServices
import AVFoundation
import EventKit
import Foundation
import Speech

// MARK: - Output

let outQueue = DispatchQueue(label: "watson.out")

func emit(_ obj: [String: Any]) {
    outQueue.async {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              var line = String(data: data, encoding: .utf8) else { return }
        line += "\n"
        FileHandle.standardOutput.write(line.data(using: .utf8)!)
    }
}

func log(_ message: String) { emit(["ev": "log", "message": message]) }

func reply(_ id: String?, ok: Bool = true, data: Any? = nil, error: String? = nil) {
    guard let id else { return }
    var obj: [String: Any] = ["ev": "result", "id": id, "ok": ok]
    if let data { obj["data"] = data }
    if let error { obj["error"] = error }
    emit(obj)
}

// MARK: - Small thread-safe box

final class Locked<T> {
    private var value: T
    private let lock = NSLock()
    init(_ value: T) { self.value = value }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
}

// MARK: - Voice: microphone, recognition, speech

final class Voice: NSObject, AVSpeechSynthesizerDelegate {
    // Two engines. On macOS 27 (M1) voice processing works on an input-only engine, but connecting
    // any output on that engine fails with -10875 or hangs. So the mic engine never plays, and the
    // voice plays on its own engine. A bonus: Watson can speak without the mic.
    var engine = AVAudioEngine()       // microphone (with echo cancellation when it works)
    let outEngine = AVAudioEngine()    // Watson's voice; never touch its inputNode
    let player = AVAudioPlayerNode()
    var outRunning = false
    var stopOutputWork: DispatchWorkItem?
    var configObserver: NSObjectProtocol?
    var outConfigObserver: NSObjectProtocol?
    /// Set when voice processing (echo cancellation) failed to start on this Mac; we then use the plain mic.
    var voiceProcessingFailed = false
    let playFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    let recFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    var engineRunning = false
    var echoCancellation = true
    var inputConverter: AVAudioConverter?
    var convErrorLogged = false
    var stopEngineWork: DispatchWorkItem?

    // Recognition (main-thread state, except `request`, which the audio thread reads)
    var locale = "en-US"
    /// Names the recognizer should expect (the user's AI apps), sent by `configure`.
    var vocabulary: [String] = []
    /// "male", "female" or "" (any): which kind of voice "Best available" prefers.
    var gender = ""
    var recognizer: SFSpeechRecognizer?
    let request = Locked<SFSpeechAudioBufferRecognitionRequest?>(nil)
    var task: SFSpeechRecognitionTask?
    var listening = false
    var session = 0
    var lastText = ""
    var lastChange = Date()
    var silenceSeconds = 1.1
    var endpointTimer: Timer?
    var lastLevelEmit = Locked<Double>(0)
    let isListening = Locked<Bool>(false)
    // "Hey Watson": an on-device-only recognition session that only looks for the wake phrase.
    // It shows nothing, sends nothing and is restarted every ~50 s. Any real listen replaces it.
    var wakeMode = false
    let wakeOnly = Locked<Bool>(false)
    var wakeTimer: Timer?
    /// When the mic last delivered audio (audio thread writes, main thread reads).
    let lastBufferAt = Locked<Double>(0)
    var micWatchdog: Timer?
    var wakeWanted = false
    var wakeStarts: [Date] = []
    var micStartedAt = Date.distantPast
    var micRestarts: [Date] = []
    // Barge-in: the audio thread notices the user's voice while Watson talks and ducks the voice
    // at once; the first real word then stops it. Only with echo cancellation (otherwise the mic
    // hears Watson itself).
    let speakingNow = Locked<Bool>(false)
    let loudFrames = Locked<Int>(0)
    var duckedAt: Date?

    // Speech output (main-thread state)
    let synth = AVSpeechSynthesizer()
    var voiceId: String?
    var rate: Float = 0.52
    var queue: [(id: String, text: String)] = []
    var writingUtterance: AVSpeechUtterance?
    var pending = 0
    var generation = 0
    var spokenText = ""
    var announcedIds = Set<String>()

    override init() {
        super.init()
        synth.delegate = self
        observeConfigurationChanges()
    }

    /// Plugging in AirPods or switching devices stops an engine; restart it if we still need it.
    func observeConfigurationChanges() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            guard let self else { return }
            // Turning on echo cancellation itself reports a change right after we start: if audio
            // keeps flowing, there's nothing to do (the watchdog checks). Real changes later rebuild.
            if Date().timeIntervalSince(self.micStartedAt) < 1.5 { return }
            log("Audio input changed; restarting the microphone.")
            DispatchQueue.main.async { self.restartMic() }
        }
        if outConfigObserver == nil {
            outConfigObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: outEngine, queue: .main) { [weak self] _ in
                guard let self else { return }
                log("Audio output changed; restarting the voice.")
                self.outRunning = false
                if self.isSpeaking {
                    do { try self.ensureOutput() } catch { emit(["ev": "error", "message": error.localizedDescription]) }
                }
            }
        }
    }

    /// Rebuild the mic engine and, if we're listening, start it again. The recognition request
    /// keeps going: it's fed by whatever engine is running.
    func restartMic() {
        let now = Date()
        micRestarts = micRestarts.filter { now.timeIntervalSince($0) < 10 } + [now]
        if micRestarts.count > 3 {
            log("The microphone keeps failing; stopping.")
            endRecognition(cancel: true)
            emit(["ev": "error", "message": "The microphone keeps dropping out. Check the input in System Settings → Sound."])
            return
        }
        lastBufferAt.set(Date().timeIntervalSince1970)
        rebuildEngine()
        guard listening else { return }
        do { try ensureEngine() } catch { emit(["ev": "error", "message": error.localizedDescription]) }
    }

    /// While listening, the mic must keep delivering audio. If it goes quiet for over a second
    /// (a device change can do that), rebuild it rather than listen to nothing.
    func checkMicAlive() {
        guard listening, engineRunning else { return }
        let gap = Date().timeIntervalSince1970 - lastBufferAt.get()
        if gap > 1.2 {
            // Seen on an M1 with macOS 27: the echo-cancelling mic starts fine but delivers no audio
            // at all. Fall back to the plain mic, as when echo cancellation fails to start.
            if engine.inputNode.isVoiceProcessingEnabled && !voiceProcessingFailed {
                log("The echo-cancelling microphone delivered no audio for \(String(format: "%.1f", gap)) s; using the plain microphone.")
                voiceProcessingFailed = true
            } else {
                log("The microphone stopped delivering audio for \(String(format: "%.1f", gap)) s; restarting it.")
            }
            restartMic()
        }
    }

    /// A fresh mic engine. A failed voice-processing start can leave the old one unusable.
    func rebuildEngine() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        engine = AVAudioEngine()
        engineRunning = false
        observeConfigurationChanges()
    }

    /// Starts the voice engine (output only).
    func ensureOutput() throws {
        stopOutputWork?.cancel()
        if outRunning && outEngine.isRunning { return }
        if player.engine == nil {
            outEngine.attach(player)
            outEngine.connect(player, to: outEngine.mainMixerNode, format: playFormat)
        }
        outEngine.prepare()
        try outEngine.start()
        outRunning = true
        player.play()
    }

    func scheduleOutputStop() {
        stopOutputWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.isSpeaking, self.outRunning else { return }
            self.player.stop()
            self.outEngine.stop()
            self.outRunning = false
        }
        stopOutputWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: work)
    }

    static let micOff = "Watson can't use the microphone. Turn on Watson in System Settings → Privacy & Security → Microphone."
    static let speechOff = "Watson can't use speech recognition. Turn on Watson in System Settings → Privacy & Security → Speech Recognition."

    /// Checks Microphone and Speech Recognition before touching the audio engine: without them
    /// the engine fails with an unreadable Core Audio error.
    func checkPermissions() throws {
        func fail(_ message: String) -> NSError { NSError(domain: "watson", code: 3, userInfo: [NSLocalizedDescriptionKey: message]) }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            throw fail("Allow Watson to use the microphone when macOS asks, then try again.")
        default: throw fail(Voice.micOff)
        }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: break
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { _ in }
            throw fail("Allow Watson to use speech recognition when macOS asks, then try again.")
        default: throw fail(Voice.speechOff)
        }
    }

    var isSpeaking: Bool { writingUtterance != nil || pending > 0 || !queue.isEmpty }

    // MARK: Engine

    func ensureEngine() throws {
        stopEngineWork?.cancel()
        if engineRunning && engine.isRunning { return }
        do {
            try startEngine(voiceProcessing: echoCancellation && !voiceProcessingFailed)
        } catch where echoCancellation && !voiceProcessingFailed {
            // Seen on an M1 with macOS 27: AUVoiceIO fails to initialize (-10875). Use the plain mic
            // instead of giving up; barge-in then relies on the word filter in onResult.
            log("Audio engine failed with echo cancellation (\((error as NSError).domain) \((error as NSError).code)); retrying without it.")
            voiceProcessingFailed = true
            rebuildEngine()
            try startEngine(voiceProcessing: false)
        }
    }

    func startEngine(voiceProcessing: Bool) throws {
        engineRunning = false
        let input = engine.inputNode
        if voiceProcessing {
            do {
                try input.setVoiceProcessingEnabled(true)
                if #available(macOS 14.0, *) {
                    // Keep Spotify and other audio at full volume while Watson listens.
                    input.voiceProcessingOtherAudioDuckingConfiguration =
                        AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
                }
            } catch {
                log("Echo cancellation unavailable: \(error.localizedDescription)")
            }
        } else if input.isVoiceProcessingEnabled {
            try? input.setVoiceProcessingEnabled(false)
        }
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else {
            throw NSError(domain: "watson", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone input. Check Microphone permission in System Settings."])
        }
        input.removeTap(onBus: 0)
        inputConverter = AVAudioConverter(from: inFormat, to: recFormat)
        if inFormat.channelCount > 1 { inputConverter?.channelMap = [0] }
        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
            self?.handleInput(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        engineRunning = true
        micStartedAt = Date()
        lastBufferAt.set(Date().timeIntervalSince1970)
        log("Microphone started: \(Int(inFormat.sampleRate)) Hz, \(inFormat.channelCount) ch, echo cancellation \(input.isVoiceProcessingEnabled ? "on" : "off")")
    }

    /// Release the microphone (and the orange dot) shortly after we stop needing it.
    func scheduleEngineStop() {
        stopEngineWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.listening, self.engineRunning else { return }
            self.engine.inputNode.removeTap(onBus: 0)
            self.engine.stop()
            self.engineRunning = false
        }
        stopEngineWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: work)
    }

    // Audio thread.
    func handleInput(_ buffer: AVAudioPCMBuffer) {
        lastBufferAt.set(Date().timeIntervalSince1970)
        guard isListening.get() else { return }
        if let ch = buffer.floatChannelData?[0] {
            let n = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0..<n { sum += ch[i] * ch[i] }
            let rms = sqrt(sum / Float(max(n, 1)))
            if speakingNow.get() && engine.inputNode.isVoiceProcessingEnabled {
                // ~130 ms of voice-level sound while Watson talks: someone is talking over it.
                let loud = rms > 0.03 ? loudFrames.get() + 1 : 0
                loudFrames.set(loud)
                if loud == 6 { DispatchQueue.main.async { [weak self] in self?.duck() } }
            }
            let now = Date().timeIntervalSince1970
            if !wakeOnly.get() && now - lastLevelEmit.get() > 0.05 {
                lastLevelEmit.set(now)
                emit(["ev": "level", "value": min(1.0, Double(rms) * 12)])
            }
        }
        guard let req = request.get(), let conv = inputConverter else { return }
        let ratio = recFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: recFormat, frameCapacity: capacity) else { return }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        if let err {
            if !convErrorLogged { convErrorLogged = true; log("Audio conversion failed: \(err.localizedDescription)") }
            return
        }
        if out.frameLength > 0 { req.append(out) }
    }

    // MARK: Recognition

    func startListening(silence: Double?, wake: Bool = false) throws {
        endRecognition(cancel: true)
        try checkPermissions()
        if let silence { silenceSeconds = silence }
        if recognizer == nil || recognizer?.locale.identifier != locale {
            recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
        }
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(domain: "watson", code: 2, userInfo: [NSLocalizedDescriptionKey: "Speech recognition isn't available for \(locale). Check Speech Recognition permission and Siri language."])
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        if #available(macOS 13.0, *) { req.addsPunctuation = true }
        let names = Array(Set(["Watson", "Claude", "ChatGPT", "Grok", "Gemini", "Spotify", "Cowork"] + vocabulary))
        // Whole phrases help more than single words ("and Grok" was once heard as nothing).
        let phrases = names.filter { $0 != "Watson" && $0 != "Spotify" }.flatMap { ["ask \($0)", "and \($0)"] }
        req.contextualStrings = Array((names + phrases).prefix(90))
        if wake {
            // Never stream the room to a server: the wake phrase is listened for on this Mac only.
            guard recognizer.supportsOnDeviceRecognition else {
                throw NSError(domain: "watson", code: 3, userInfo: [NSLocalizedDescriptionKey: "\"Hey Watson\" needs on-device speech recognition for \(locale). Turn on Siri once (System Settings → Siri) so macOS downloads it."])
            }
            req.contextualStrings = ["Hey Watson", "Hi Watson", "Okay Watson", "Watson"]
            req.addsPunctuation = false
        }
        try ensureEngine()
        session += 1
        let sid = session
        lastText = ""
        lastChange = Date()
        request.set(req)
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let message = error?.localizedDescription
            DispatchQueue.main.async { self?.onResult(sid, text: text, isFinal: isFinal, error: message) }
        }
        listening = true
        isListening.set(true)
        lastBufferAt.set(Date().timeIntervalSince1970)
        micWatchdog?.invalidate()
        micWatchdog = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.checkMicAlive() }
        wakeMode = wake
        wakeOnly.set(wake)
        endpointTimer?.invalidate()
        wakeTimer?.invalidate()
        if wake {
            // Recognition sessions don't last forever: start a fresh one now and then.
            wakeTimer = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in self?.restartWake(sid) }
            return
        }
        endpointTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.checkEndpoint() }
        emit(["ev": "listening", "session": sid])
    }

    func startWake() {
        wakeWanted = true
        if listening { return } // a real listen (or the wake session itself) is already running
        // A recognizer that fails at once would otherwise restart every 0.3 s forever.
        let now = Date()
        wakeStarts = wakeStarts.filter { now.timeIntervalSince($0) < 20 } + [now]
        if wakeStarts.count > 8 {
            wakeWanted = false
            log("“Hey Watson” keeps failing to start; pausing it.")
            return
        }
        do { try startListening(silence: nil, wake: true) } catch {
            emit(["ev": "error", "message": error.localizedDescription])
        }
    }

    func restartWake(_ sid: Int) {
        guard sid == session, wakeMode else { return }
        endRecognition(cancel: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, self.wakeWanted else { return } // turned off in the meantime
            self.startWake()
        }
    }

    static let wakePhrase = try! NSRegularExpression(pattern: "\\b(hey|hi|okay|ok|hello)[ ,]+watson\\b", options: [.caseInsensitive])

    func onWakeResult(_ sid: Int, text: String?, isFinal: Bool, error: String?) {
        // Watson's own voice saying its name must not wake it.
        if let text, !isSpeaking, Voice.wakePhrase.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil {
            endRecognition(cancel: true)
            emit(["ev": "wake"])
            return
        }
        if isFinal || error != nil { restartWake(sid) }
    }

    /// Lower Watson's voice the moment the user starts talking over it; restore it if no words follow.
    func duck() {
        guard isSpeaking, duckedAt == nil else { return }
        duckedAt = Date()
        outEngine.mainMixerNode.outputVolume = 0.18
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
            guard let self, let at = self.duckedAt, Date().timeIntervalSince(at) >= 1.35 else { return }
            self.unduck()
        }
    }

    func unduck() {
        duckedAt = nil
        loudFrames.set(0)
        outEngine.mainMixerNode.outputVolume = 1
    }

    func onResult(_ sid: Int, text: String?, isFinal: Bool, error: String?) {
        guard sid == session, listening else { return }
        if wakeMode { return onWakeResult(sid, text: text, isFinal: isFinal, error: error) }
        if let text, !text.isEmpty, text != lastText {
            if isSpeaking {
                // Ignore what is probably our own voice leaking in; stop only for real new words.
                // With echo cancellation one new word is enough; without it, two.
                let spoken = Set(words(spokenText))
                let novel = words(text).filter { !spoken.contains($0) }
                let needed = engine.inputNode.isVoiceProcessingEnabled ? 1 : 2
                if novel.count < needed { return }
                stopSpeaking(reason: "bargein")
                emit(["ev": "bargein"])
            }
            lastText = text
            lastChange = Date()
            emit(["ev": "partial", "text": text, "session": sid])
        }
        if isFinal || error != nil {
            if !lastText.isEmpty { finish(sid) } else if error != nil {
                // "No speech detected" and friends. While Watson talks this also ends the talk-over
                // listen; the app starts a fresh one afterwards instead of keeping a dead session.
                endRecognition(cancel: true)
                emit(["ev": "nospeech", "session": sid])
            }
        }
    }

    func checkEndpoint() {
        guard listening, !lastText.isEmpty, !isSpeaking else { return }
        if Date().timeIntervalSince(lastChange) >= Voice.pauseNeeded(after: lastText, base: silenceSeconds) { finish(session) }
    }

    /// Words a thought rarely ends on: after them, a pause usually means "still thinking".
    static let unfinished: Set<String> = [
        "and", "but", "or", "so", "because", "cause", "then", "also", "plus", "like", "um", "uh", "er", "hmm", "erm",
        "the", "a", "an", "to", "of", "for", "with", "from", "about", "into", "in", "on", "at", "by", "my", "your",
        "our", "their", "his", "her", "its", "this", "that", "these", "those", "is", "are", "was", "were", "be",
        "if", "when", "where", "what", "which", "who", "how", "why", "i", "i'm", "we", "you", "it", "can", "could",
        "would", "should", "will", "do", "does", "did", "maybe", "just", "some", "any", "more", "than", "as",
    ]

    /// How long a pause ends the user's turn: longer when the words so far sound unfinished.
    static func pauseNeeded(after text: String, base: Double) -> Double {
        let t = text.trimmingCharacters(in: .whitespaces)
        let last = t.lowercased().components(separatedBy: CharacterSet.letters.union(CharacterSet(charactersIn: "'")).inverted).filter { !$0.isEmpty }.last ?? ""
        let wordCount = t.split(separator: " ").count
        if t.hasSuffix(",") || t.hasSuffix("…") || t.hasSuffix("...") || unfinished.contains(last) { return max(base * 2.2, 2.6) }
        if t.hasSuffix("?") || t.hasSuffix("!") { return base * 0.85 }
        if wordCount <= 2 { return max(base, 1.5) } // "Hey Watson", "Okay": often more is coming
        return base
    }

    func finish(_ sid: Int) {
        let text = lastText
        endRecognition(cancel: true)
        emit(["ev": "final", "text": text, "session": sid])
    }

    func endRecognition(cancel: Bool) {
        endpointTimer?.invalidate()
        endpointTimer = nil
        wakeTimer?.invalidate()
        wakeTimer = nil
        micWatchdog?.invalidate()
        micWatchdog = nil
        wakeMode = false
        wakeOnly.set(false)
        if let req = request.get() { req.endAudio() }
        request.set(nil)
        if cancel { task?.cancel() } else { task?.finish() }
        task = nil
        listening = false
        isListening.set(false)
        scheduleEngineStop()
    }

    func words(_ s: String) -> [String] {
        s.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { $0.count > 1 }
    }

    // MARK: Speaking

    /// How human a voice sounds: Siri's natural voices, then Premium, then Enhanced. Novelty and
    /// old robotic voices only if nothing else exists.
    static func naturalness(_ v: AVSpeechSynthesisVoice) -> Int {
        let id = v.identifier
        if id.contains("speech.synthesis.voice") || id.contains("eloquence") { return 0 }
        if id.contains("siri") { return 10 }
        switch v.quality {
        case .premium: return 8
        case .enhanced: return 6
        default: return id.contains("super-compact") ? 1 : 2
        }
    }

    func selectedVoice() -> AVSpeechSynthesisVoice? {
        if let voiceId, let v = AVSpeechSynthesisVoice(identifier: voiceId) { return v }
        let lang = String(locale.prefix(2))
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(lang) }
        let regional = candidates.filter { $0.language == locale.replacingOccurrences(of: "_", with: "-") }
        let pool = regional.isEmpty ? candidates : regional
        let best = { (vs: [AVSpeechSynthesisVoice]) in vs.max { Voice.naturalness($0) < Voice.naturalness($1) } }
        // The preferred gender wins if it has a natural-sounding voice; otherwise the most natural voice.
        let wanted: AVSpeechSynthesisVoiceGender? = gender == "male" ? .male : gender == "female" ? .female : nil
        if let wanted {
            let match = pool.filter { $0.gender == wanted } + (regional.isEmpty ? [] : candidates.filter { $0.gender == wanted && !regional.contains($0) })
            if let v = best(match), Voice.naturalness(v) >= 6 { return v }
        }
        return best(pool)
    }

    func speak(id: String, text: String) {
        queue.append((id, text))
        if writingUtterance == nil { writeNext() }
    }

    func writeNext() {
        guard !queue.isEmpty else { checkIdle(); return }
        let item = queue.removeFirst()
        do { try ensureOutput() } catch {
            emit(["ev": "error", "message": "Watson couldn't play its voice: \(error.localizedDescription)"])
            queue.removeAll()
            // Still say we're done, or the app waits for speech that will never finish.
            pending = 0
            speakingNow.set(false)
            emit(["ev": "speak.idle"])
            return
        }
        if outEngine.isRunning && !player.isPlaying { player.play() }
        speakingNow.set(true)
        spokenText += " " + item.text
        let utterance = AVSpeechUtterance(string: item.text)
        utterance.voice = selectedVoice()
        utterance.rate = rate
        utterance.prefersAssistiveTechnologySettings = false
        writingUtterance = utterance
        let gen = generation
        let id = item.id
        var converter: AVAudioConverter?
        synth.write(utterance) { [weak self] buffer in
            guard let self, let pcm = buffer as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                DispatchQueue.main.async { self.utteranceDone(utterance, gen: gen) }
                return
            }
            if converter == nil || converter!.inputFormat != pcm.format {
                converter = AVAudioConverter(from: pcm.format, to: self.playFormat)
            }
            guard let conv = converter else { return }
            let ratio = self.playFormat.sampleRate / pcm.format.sampleRate
            let capacity = AVAudioFrameCount(Double(pcm.frameLength) * ratio) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: self.playFormat, frameCapacity: capacity) else { return }
            var fed = false
            var err: NSError?
            conv.convert(to: out, error: &err) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true
                status.pointee = .haveData
                return pcm
            }
            guard err == nil, out.frameLength > 0 else { return }
            DispatchQueue.main.async {
                guard gen == self.generation else { return }
                if !self.announcedIds.contains(id) {
                    self.announcedIds.insert(id)
                    emit(["ev": "speak.start", "id": id])
                }
                self.pending += 1
                self.player.scheduleBuffer(out) {
                    DispatchQueue.main.async {
                        guard gen == self.generation else { return }
                        self.pending -= 1
                        self.checkIdle()
                    }
                }
            }
        }
    }

    func utteranceDone(_ utterance: AVSpeechUtterance, gen: Int) {
        guard gen == generation, writingUtterance === utterance else { return }
        writingUtterance = nil
        writeNext()
    }

    // Some macOS versions finish a write() without the empty end buffer.
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let gen = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.utteranceDone(utterance, gen: gen) }
    }

    func checkIdle() {
        guard !isSpeaking else { return }
        speakingNow.set(false)
        if duckedAt != nil { unduck() }
        spokenText = ""
        announcedIds.removeAll()
        emit(["ev": "speak.idle"])
        scheduleOutputStop()
    }

    func stopSpeaking(reason: String) {
        let wasSpeaking = isSpeaking
        generation += 1
        queue.removeAll()
        writingUtterance = nil
        pending = 0
        synth.stopSpeaking(at: .immediate)
        if player.engine != nil { player.stop() }
        speakingNow.set(false)
        if duckedAt != nil { unduck() }
        if wasSpeaking {
            spokenText = reason == "bargein" ? spokenText : ""
            announcedIds.removeAll()
            emit(["ev": "speak.idle", "stopped": true])
        }
    }

    func voices() -> [[String: Any]] {
        AVSpeechSynthesisVoice.speechVoices().map { v -> [String: Any] in
            let quality: String
            switch v.quality {
            case .premium: quality = "premium"
            case .enhanced: quality = "enhanced"
            default: quality = "default"
            }
            let gender = v.gender == .male ? "male" : v.gender == .female ? "female" : ""
            let name = v.identifier.contains("siri") ? "Siri \(v.name)" : v.name
            return ["id": v.identifier, "name": name, "language": v.language, "quality": v.identifier.contains("siri") ? "siri" : quality, "gender": gender]
        }
    }
}

// MARK: - Accessibility: drive other apps

enum AX {
    static func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }

    static func string(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }

    static func children(_ el: AXUIElement) -> [AXUIElement] {
        (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    static func appElement(_ bundleId: String) -> (NSRunningApplication, AXUIElement)? {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else { return nil }
        let el = AXUIElementCreateApplication(app.processIdentifier)
        // Electron and Chromium apps only build their accessibility tree when asked.
        AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        if isBrowser(bundleId) {
            AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        }
        return (app, el)
    }

    static func isBrowser(_ bundleId: String) -> Bool {
        ["com.google.Chrome", "com.brave.Browser", "company.thebrowser.Browser", "com.microsoft.edgemac", "com.vivaldi.Vivaldi", "com.operasoftware.Opera"]
            .contains(bundleId)
    }

    static func windows(_ app: AXUIElement) -> [AXUIElement] {
        var list = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        if list.isEmpty, let w = attr(app, kAXMainWindowAttribute) { list = [w as! AXUIElement] }
        return list
    }

    static func mainWindow(_ app: AXUIElement) -> AXUIElement? {
        if let w = attr(app, kAXMainWindowAttribute) { return (w as! AXUIElement) }
        if let w = attr(app, kAXFocusedWindowAttribute) { return (w as! AXUIElement) }
        return windows(app).first
    }

    static let inlineRoles: Set<String> = ["AXStaticText", "AXLink", "AXImage"]
    static let controlRoles: Set<String> = ["AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox", "AXRadioButton", "AXComboBox", "AXSlider", "AXMenu", "AXMenuBar", "AXMenuItem", "AXDisclosureTriangle"]

    /// Presses a menu item by path, e.g. ["Go", "Claude"]. Titles match case-insensitively.
    @discardableResult
    static func pressMenu(_ app: AXUIElement, _ path: [String]) -> Bool {
        guard path.count >= 2, let bar = attr(app, kAXMenuBarAttribute) else { return false }
        guard let top = children(bar as! AXUIElement).first(where: { (string($0, kAXTitleAttribute) ?? "").caseInsensitiveCompare(path[0]) == .orderedSame }) else { return false }
        var items = children(top).flatMap { children($0) }
        for (i, name) in path.dropFirst().enumerated() {
            guard let item = items.first(where: { (string($0, kAXTitleAttribute) ?? "").caseInsensitiveCompare(name) == .orderedSame }) else { return false }
            if i == path.count - 2 {
                if (attr(item, kAXEnabledAttribute) as? Bool) == false { return false }
                return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
            }
            items = children(item).flatMap { children($0) }
        }
        return false
    }

    /// The first enabled menu item whose title matches, anywhere in the menu bar.
    static func findMenuItem(_ app: AXUIElement, matching pattern: String) -> AXUIElement? {
        guard let bar = attr(app, kAXMenuBarAttribute) else { return nil }
        for top in children(bar as! AXUIElement) {
            for item in children(top).flatMap({ children($0) }) {
                let t = string(item, kAXTitleAttribute) ?? ""
                if t.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil, (attr(item, kAXEnabledAttribute) as? Bool) != false {
                    return item
                }
            }
        }
        return nil
    }

    /// Opens a new conversation through the app's own menu ("New Chat"), never a blind ⌘N:
    /// in some apps ⌘N means something else (in Claude's Code view it starts a coding session).
    static func startNewChat(_ app: AXUIElement, chatMenu: [String]?) -> Bool {
        if let chatMenu, !chatMenu.isEmpty {
            if pressMenu(app, chatMenu) { usleep(900_000) } else { log("Menu \(chatMenu.joined(separator: " → ")) not found.") }
        }
        if let item = findMenuItem(app, matching: #"^new (chat|conversation|thread)\b"#) {
            return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
        }
        log("No New Chat menu item; using the open conversation.")
        return false
    }

    /// Waits for a window's message box. Chromium apps build their accessibility tree lazily,
    /// so the first look right after switching it on often finds nothing.
    static func waitForInput(_ bundleId: String, seconds: Double) -> AXUIElement? {
        let start = Date()
        while Date().timeIntervalSince(start) < seconds {
            if let pair = appElement(bundleId), let window = mainWindow(pair.1), let input = findInput(window) { return input }
            usleep(350_000)
        }
        return nil
    }

    static func focus(_ input: AXUIElement) -> Bool {
        AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        usleep(150_000)
        return (attr(input, kAXFocusedAttribute) as? Bool) ?? true
    }

    /// Diagnostics: elements in a window whose value can be edited (candidate message boxes). Read-only.
    static func editables(_ window: AXUIElement) -> [[String: String]] {
        var out: [[String: String]] = []
        var visited = 0
        var webAreas = 0
        func walk(_ el: AXUIElement, depth: Int, inWeb: Bool) {
            visited += 1
            if visited > 80_000 || depth > 150 || out.count >= 30 { return }
            let role = string(el, kAXRoleAttribute) ?? ""
            let web = inWeb || role == "AXWebArea"
            if role == "AXWebArea" { webAreas += 1 }
            if ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"].contains(role) || (role == "AXGroup" && web && (attr(el, "AXEditableAncestor") != nil) && CFEqual(attr(el, "AXEditableAncestor"), el)) {
                out.append([
                    "role": role,
                    "subrole": string(el, kAXSubroleAttribute) ?? "",
                    "placeholder": string(el, "AXPlaceholderValue") ?? "",
                    "description": string(el, kAXDescriptionAttribute) ?? "",
                    "inPage": web ? "yes" : "no",
                    "depth": String(depth),
                ])
            }
            for kid in children(el) { walk(kid, depth: depth + 1, inWeb: web) }
        }
        walk(window, depth: 0, inWeb: false)
        out.append(["summary": "visited \(visited) elements, web areas \(webAreas)"])
        return out
    }

    /// The app's menu bar: each menu with its items and their ⌘ shortcuts. Read-only.
    static func menus(_ app: AXUIElement) -> [[String: Any]] {
        guard let bar = attr(app, kAXMenuBarAttribute) else { return [] }
        return children(bar as! AXUIElement).compactMap { top -> [String: Any]? in
            let title = string(top, kAXTitleAttribute) ?? ""
            let items = children(top).flatMap { children($0) }.compactMap { item -> String? in
                let t = string(item, kAXTitleAttribute) ?? ""
                if t.isEmpty { return nil }
                let ch = string(item, "AXMenuItemCmdChar") ?? ""
                let mods = (attr(item, "AXMenuItemCmdModifiers") as? Int) ?? 0
                // Modifier bits: 1 shift, 2 option, 4 control, 8 = no command.
                var keys = ""
                if !ch.isEmpty {
                    if mods & 4 != 0 { keys += "⌃" }
                    if mods & 2 != 0 { keys += "⌥" }
                    if mods & 1 != 0 { keys += "⇧" }
                    if mods & 8 == 0 { keys += "⌘" }
                    keys += ch
                }
                return keys.isEmpty ? t : "\(t) [\(keys)]"
            }
            return ["menu": title, "items": items]
        }
    }

    /// Visible text of a window as lines, plus whether a "Stop" button suggests the app is still generating.
    static func snapshot(_ window: AXUIElement, deadline: Date) -> (lines: [String], busy: Bool) {
        var busy = false
        var visited = 0

        func walk(_ el: AXUIElement, depth: Int) -> [String] {
            visited += 1
            if visited > 40_000 || depth > 90 || Date() > deadline { return [] }
            let role = string(el, kAXRoleAttribute) ?? ""
            if controlRoles.contains(role) {
                let label = [string(el, kAXDescriptionAttribute), string(el, kAXTitleAttribute), string(el, kAXHelpAttribute)]
                    .compactMap { $0 }.joined(separator: " ").lowercased()
                if label.contains("stop") { busy = true }
                return [] // buttons, model pickers and menus aren't part of a reply
            }
            if role == "AXTextArea" || role == "AXTextField" || role == "AXSearchField" || role == "AXToolbar" || role == "AXTabGroup" {
                return [] // skip input boxes and browser chrome
            }
            if role == "AXStaticText" {
                let v = (string(el, kAXValueAttribute) ?? string(el, kAXTitleAttribute) ?? "")
                // Claude shows "Claude is responding" while it writes; other apps say "Thinking…".
                if v.count < 60, v.range(of: #"^\w+ is (responding|thinking|writing|typing)|^(thinking|generating|searching)…?$"#, options: [.regularExpression, .caseInsensitive]) != nil {
                    busy = true
                }
                return v.isEmpty ? [] : [v]
            }
            let kids = children(el)
            if kids.isEmpty { return [] }
            let kidRoles = kids.map { string($0, kAXRoleAttribute) ?? "" }
            let allInline = kidRoles.allSatisfy { inlineRoles.contains($0) }
            var lines: [String] = []
            for kid in kids { lines.append(contentsOf: walk(kid, depth: depth + 1)) }
            if allInline && lines.count > 1 { return [lines.joined()] }
            return lines
        }

        let lines = walk(window, depth: 0)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return (lines, busy)
    }

    /// Labels of form fields that must never receive a prompt.
    static let notAChatBox = #"\b(name|age|birth(day|date)?|e-?mail|password|phone|search|url|zip)\b"#
    static let chatBox = #"\b(ask|message|chat|prompt|reply|send|type|anything|help|question|talk)\b"#

    /// The chat's message box: a multi-line text area, or a text field labelled like one.
    /// Plain form fields ("Full Name", "Age", search boxes) are never chosen.
    static func findInput(_ window: AXUIElement) -> AXUIElement? {
        var found: AXUIElement?
        var visited = 0
        func label(_ el: AXUIElement) -> String {
            [string(el, "AXPlaceholderValue"), string(el, kAXDescriptionAttribute), string(el, kAXTitleAttribute), string(el, kAXHelpAttribute)]
                .compactMap { $0 }.joined(separator: " ")
        }
        func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
        func walk(_ el: AXUIElement, depth: Int) {
            visited += 1
            if visited > 40_000 || depth > 90 { return }
            let role = string(el, kAXRoleAttribute) ?? ""
            if role == "AXTextArea" || (role == "AXTextField" && string(el, kAXSubroleAttribute) != "AXSearchField") {
                let l = label(el)
                let ok = !matches(l, notAChatBox) && (role == "AXTextArea" || matches(l, chatBox))
                if ok { found = el } // keep the last one: chat boxes sit at the bottom
            }
            if role == "AXToolbar" || role == "AXTabGroup" { return } // not the browser's address bar
            for kid in children(el) { walk(kid, depth: depth + 1) }
        }
        walk(window, depth: 0)
        return found
    }

    static func key(_ code: CGKeyCode, flags: CGEventFlags = []) {
        let src = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    static func frontmost() -> (bundleId: String, name: String)? {
        var result: (bundleId: String, name: String)?
        let read = {
            if let app = NSWorkspace.shared.frontmostApplication, let b = app.bundleIdentifier {
                result = (b, app.localizedName ?? b)
            }
        }
        if Thread.isMainThread { read() } else { DispatchQueue.main.sync(execute: read) }
        return result
    }

    static func defaultBrowser() -> String? {
        guard let url = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "https://example.com")!) else { return nil }
        return Bundle(url: url)?.bundleIdentifier
    }

    static func run(_ path: String, _ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        try? p.run()
        p.waitUntilExit()
    }

    static func waitFront(_ bundleId: String, seconds: Double) throws {
        let start = Date()
        while frontmost()?.bundleId != bundleId {
            if Date().timeIntervalSince(start) > seconds {
                throw NSError(domain: "watson", code: 11, userInfo: [NSLocalizedDescriptionKey: "Couldn't bring \(bundleId) to the front."])
            }
            usleep(100_000)
        }
    }

    /// Paste through the clipboard, then put the user's clipboard back.
    static func paste(_ text: String) {
        let pb = NSPasteboard.general
        var saved: [NSPasteboardItem] = []
        DispatchQueue.main.sync {
            for item in pb.pasteboardItems ?? [] {
                let copy = NSPasteboardItem()
                for type in item.types { if let d = item.data(forType: type) { copy.setData(d, forType: type) } }
                saved.append(copy)
            }
            pb.clearContents()
            pb.setString(text, forType: .string)
        }
        usleep(80_000)
        key(9, flags: .maskCommand) // Cmd+V
        usleep(450_000)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            pb.clearContents()
            if !saved.isEmpty { pb.writeObjects(saved) }
        }
    }

    static func requireTrust() throws {
        guard AXIsProcessTrusted() else {
            throw NSError(domain: "watson", code: 10, userInfo: [NSLocalizedDescriptionKey: "Watson needs Accessibility permission to type into other apps. Turn it on in System Settings → Privacy & Security → Accessibility."])
        }
    }

    /// Bring an app (or a chat website in the browser) forward, focus its message box,
    /// paste the text and optionally press Return. Returns the bundle id that received it.
    static func sendPrompt(bundleId: String?, url: String?, browser: String?, newChat: Bool, chatMenu: [String]?, text: String, submit: Bool, returnFocus: Bool) throws -> String {
        try requireTrust()
        let previous = frontmost()?.bundleId
        var target: String
        if let url, !url.isEmpty {
            guard let b = (browser?.isEmpty == false ? browser : nil) ?? defaultBrowser() else {
                throw NSError(domain: "watson", code: 12, userInfo: [NSLocalizedDescriptionKey: "Couldn't find your web browser."])
            }
            target = b
            if newChat { run("/usr/bin/open", ["-b", b, url]) } else { run("/usr/bin/open", ["-b", b]) }
            try waitFront(b, seconds: 12)
            // Wait for the page's message box to exist (the page may still be loading).
            guard let input = waitForInput(b, seconds: newChat ? 15 : 5) else {
                throw NSError(domain: "watson", code: 14, userInfo: [NSLocalizedDescriptionKey: "I couldn't find the chat's message box in your browser, so nothing was sent. Is the page signed in?"])
            }
            usleep(newChat ? 900_000 : 150_000) // let the page finish wiring up the box
            _ = focus(input)
            usleep(200_000)
        } else if let bundleId, !bundleId.isEmpty {
            target = bundleId
            // A closed app is launched; it needs longer to show its window and message box.
            let wasRunning = !NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).isEmpty
            if !wasRunning { log("Opening \(bundleId); it wasn't running.") }
            run("/usr/bin/open", ["-b", bundleId])
            try waitFront(bundleId, seconds: wasRunning ? 12 : 30)
            usleep(wasRunning ? 700_000 : 2_500_000)
            _ = waitForInput(bundleId, seconds: wasRunning ? 3 : 15) // wakes up the app's accessibility tree
            if newChat, let pair = appElement(bundleId), startNewChat(pair.1, chatMenu: chatMenu) {
                usleep(900_000)
            }
            guard let input = waitForInput(bundleId, seconds: wasRunning ? 6 : 15) else {
                throw NSError(domain: "watson", code: 15, userInfo: [NSLocalizedDescriptionKey: "I couldn't find the app's message box, so nothing was sent."])
            }
            _ = focus(input)
        } else {
            throw NSError(domain: "watson", code: 13, userInfo: [NSLocalizedDescriptionKey: "That agent has no app or website set."])
        }

        paste(text)
        if submit {
            key(36) // Return
            usleep(300_000)
        }
        if returnFocus, let previous, previous != target {
            usleep(400_000)
            run("/usr/bin/open", ["-b", previous])
        }
        return target
    }

    /// Dictation: type text into the app the user was in (no Return).
    static func insert(bundleId: String, text: String) throws {
        try requireTrust()
        run("/usr/bin/open", ["-b", bundleId])
        try waitFront(bundleId, seconds: 6)
        usleep(250_000)
        paste(text)
    }
}

// MARK: - Calendar and Reminders (EventKit)

let eventStore = EKEventStore()

enum Apple {
    static func hex(_ cg: CGColor?) -> String {
        guard let cg, let c = NSColor(cgColor: cg)?.usingColorSpace(.sRGB) else { return "#0A84FF" }
        return String(format: "#%02X%02X%02X", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }

    static func status(_ type: EKEntityType) -> String {
        let s = EKEventStore.authorizationStatus(for: type)
        if #available(macOS 14.0, *) {
            if s == .fullAccess { return "granted" }
            if s == .writeOnly { return "writeOnly" }
        }
        switch s {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        default: return "unknown"
        }
    }

    static func access(_ type: EKEntityType, _ done: @escaping (Bool) -> Void) {
        if status(type) == "granted" { return done(true) }
        let finish: (Bool, Error?) -> Void = { granted, _ in DispatchQueue.main.async { done(granted) } }
        if #available(macOS 14.0, *) {
            if type == .event { eventStore.requestFullAccessToEvents(completion: finish) }
            else { eventStore.requestFullAccessToReminders(completion: finish) }
        } else {
            eventStore.requestAccess(to: type, completion: finish)
        }
    }

    static func events(from: Date, to: Date) -> [[String: Any]] {
        let pred = eventStore.predicateForEvents(withStart: from, end: to, calendars: nil)
        return eventStore.events(matching: pred)
            .sorted { $0.startDate < $1.startDate }
            .prefix(60)
            .map { e -> [String: Any] in
                var o: [String: Any] = [
                    "title": e.title ?? "Untitled",
                    "start": e.startDate.timeIntervalSince1970,
                    "end": e.endDate.timeIntervalSince1970,
                    "allDay": e.isAllDay,
                    "calendar": e.calendar.title,
                    "color": hex(e.calendar.cgColor),
                ]
                if let l = e.location, !l.isEmpty { o["location"] = l }
                return o
            }
    }

    static func addEvent(title: String, start: Date, end: Date, allDay: Bool, location: String?, notes: String?) throws -> [String: Any] {
        let e = EKEvent(eventStore: eventStore)
        e.title = title
        e.startDate = start
        e.endDate = end
        e.isAllDay = allDay
        e.location = location
        e.notes = notes
        e.calendar = eventStore.defaultCalendarForNewEvents
        try eventStore.save(e, span: .thisEvent, commit: true)
        return ["title": title, "start": start.timeIntervalSince1970, "end": end.timeIntervalSince1970, "allDay": allDay, "calendar": e.calendar?.title ?? "", "color": hex(e.calendar?.cgColor)]
    }

    static func reminders(list: String?, _ done: @escaping ([[String: Any]]) -> Void) {
        var calendars: [EKCalendar]?
        if let list, !list.isEmpty {
            calendars = eventStore.calendars(for: .reminder).filter { $0.title.localizedCaseInsensitiveContains(list) }
            if calendars?.isEmpty == true { calendars = nil }
        }
        let pred = eventStore.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: calendars)
        eventStore.fetchReminders(matching: pred) { found in
            let items = (found ?? [])
                .sorted { a, b in
                    let da = a.dueDateComponents.flatMap { Calendar.current.date(from: $0) } ?? .distantFuture
                    let db = b.dueDateComponents.flatMap { Calendar.current.date(from: $0) } ?? .distantFuture
                    return da < db
                }
                .prefix(40)
                .map { r -> [String: Any] in
                    var o: [String: Any] = [
                        "id": r.calendarItemIdentifier,
                        "title": r.title ?? "",
                        "list": r.calendar.title,
                        "color": hex(r.calendar.cgColor),
                        "priority": r.priority,
                    ]
                    if let d = r.dueDateComponents.flatMap({ Calendar.current.date(from: $0) }) { o["due"] = d.timeIntervalSince1970 }
                    return o
                }
            DispatchQueue.main.async { done(Array(items)) }
        }
    }

    static func addReminder(title: String, due: Date?, list: String?) throws -> [String: Any] {
        let r = EKReminder(eventStore: eventStore)
        r.title = title
        var cal = eventStore.defaultCalendarForNewReminders()
        if let list, !list.isEmpty, let match = eventStore.calendars(for: .reminder).first(where: { $0.title.localizedCaseInsensitiveContains(list) }) {
            cal = match
        }
        r.calendar = cal
        if let due {
            r.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
            r.addAlarm(EKAlarm(absoluteDate: due))
        }
        try eventStore.save(r, commit: true)
        return ["title": title, "list": cal?.title ?? "Reminders"]
    }

    /// Marks one incomplete reminder done: an exact title match wins, otherwise a single
    /// reminder containing the words. Several possible matches is an error that lists them.
    static func completeReminder(_ match: String, _ done: @escaping (Result<[String: Any], Error>) -> Void) {
        let pred = eventStore.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        eventStore.fetchReminders(matching: pred) { found in
            let all = found ?? []
            let q = match.trimmingCharacters(in: .whitespaces).lowercased()
            let exact = all.filter { ($0.title ?? "").lowercased() == q }
            let partial = all.filter { ($0.title ?? "").lowercased().contains(q) }
            let pick = exact.count == 1 ? exact : partial
            DispatchQueue.main.async {
                func fail(_ m: String) { done(.failure(NSError(domain: "watson", code: 4, userInfo: [NSLocalizedDescriptionKey: m]))) }
                guard !q.isEmpty, let r = pick.first else { return fail("There's no open reminder called \"\(match)\".") }
                if pick.count > 1 { return fail("Several reminders match: \(pick.prefix(5).compactMap { $0.title }.joined(separator: ", ")). Which one?") }
                r.isCompleted = true
                do {
                    try eventStore.save(r, commit: true)
                    done(.success(["title": r.title ?? match, "list": r.calendar.title]))
                } catch { done(.failure(error)) }
            }
        }
    }
}

// MARK: - Command loop

let voice = Voice()
let axQueue = DispatchQueue(label: "watson.ax")

func micStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "unknown"
    }
}

func speechStatus() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "unknown"
    }
}

func permissions() -> [String: Any] {
    [
        "microphone": micStatus(),
        "speech": speechStatus(),
        "accessibility": AXIsProcessTrusted(),
        "calendar": Apple.status(.event),
        "reminders": Apple.status(.reminder),
    ]
}

func date(_ v: Any?) -> Date? {
    guard let n = v as? Double else { return nil }
    return Date(timeIntervalSince1970: n)
}

// MARK: - Audio probe (diagnostics)

/// Tries several audio-engine set-ups, each on a fresh engine, and reports which ones start.
/// Used to find out why voice processing (echo cancellation) fails on a given Mac.
func audioProbe(only: Int?) -> [[String: Any]] {
    func attempt(_ name: String, _ setup: (AVAudioEngine) throws -> Void) -> [String: Any] {
        let e = AVAudioEngine()
        var result: [String: Any] = ["name": name]
        do {
            try setup(e)
            e.prepare()
            try e.start()
            let f = e.inputNode.outputFormat(forBus: 0)
            result["ok"] = true
            result["format"] = "\(Int(f.sampleRate)) Hz \(f.channelCount) ch"
            result["vp"] = e.inputNode.isVoiceProcessingEnabled
        } catch {
            result["ok"] = false
            result["error"] = "\((error as NSError).domain) \((error as NSError).code)"
        }
        e.inputNode.removeTap(onBus: 0)
        e.stop()
        return result
    }
    let tap: (AVAudioEngine) -> Void = { e in
        let f = e.inputNode.outputFormat(forBus: 0)
        e.inputNode.installTap(onBus: 0, bufferSize: 1024, format: f) { _, _ in }
    }
    let mono24 = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    let mono48 = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    let stereo48 = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
    func player(_ e: AVAudioEngine, to node: AVAudioNode, format: AVAudioFormat?) {
        let p = AVAudioPlayerNode(); e.attach(p); e.connect(p, to: node, format: format)
    }
    // Two more set-ups were tried on macOS 27 / M1 and are deliberately left out: connecting a
    // player before enabling voice processing, and a player straight into the output node. Both
    // made engine.start() hang, and killing the hung process left coreaudiod unable to start any
    // input until it was reset. Never add a set-up here that hasn't been tried by hand first.
    let variants: [(String, (AVAudioEngine) throws -> Void)] = [
        ("0 vp + player->mixer 24k mono (current)", { e in try e.inputNode.setVoiceProcessingEnabled(true); player(e, to: e.mainMixerNode, format: mono24); tap(e) }),
        ("2 vp + player->mixer 48k mono", { e in try e.inputNode.setVoiceProcessingEnabled(true); player(e, to: e.mainMixerNode, format: mono48); tap(e) }),
        ("3 vp + player->mixer 48k stereo", { e in try e.inputNode.setVoiceProcessingEnabled(true); player(e, to: e.mainMixerNode, format: stereo48); tap(e) }),
        ("5 vp both nodes + player->mixer 24k", { e in try e.inputNode.setVoiceProcessingEnabled(true); try e.outputNode.setVoiceProcessingEnabled(true); player(e, to: e.mainMixerNode, format: mono24); tap(e) }),
        ("6 vp + player->mixer, no tap", { e in try e.inputNode.setVoiceProcessingEnabled(true); player(e, to: e.mainMixerNode, format: mono24) }),
        ("7 vp + input->mixer(vol 0) + player", { e in
            try e.inputNode.setVoiceProcessingEnabled(true)
            let mix = AVAudioMixerNode(); e.attach(mix)
            e.connect(e.inputNode, to: mix, format: e.inputNode.outputFormat(forBus: 0)); mix.outputVolume = 0
            e.connect(mix, to: e.mainMixerNode, format: nil)
            player(e, to: e.mainMixerNode, format: mono24)
        }),
    ]
    if let only {
        guard only >= 0 && only < variants.count else { return [] }
        return [attempt(variants[only].0, variants[only].1)]
    }
    return variants.map { attempt($0.0, $0.1) }
}

/// Echo test: says a sentence through the speakers (a separate path from the mic) while
/// recognizing what the mic hears, with or without voice processing on the mic engine.
/// If echo cancellation works across engines, the transcript with vp=true stays (nearly) empty.
final class EchoTest: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    let engine = AVAudioEngine()
    let synth = AVSpeechSynthesizer()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var text = ""
    var recError = ""
    let peak = Locked<Float>(0)
    let peakWhileSpeaking = Locked<Float>(0)
    let speaking = Locked<Bool>(false)
    var spoke = false

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) { speaking.set(true) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { speaking.set(false); spoke = true }

    func run(vp: Bool, done: @escaping ([String: Any]) -> Void) {
        let recFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
        do {
            if vp { try engine.inputNode.setVoiceProcessingEnabled(true) }
            let inFormat = engine.inputNode.outputFormat(forBus: 0)
            guard let conv = AVAudioConverter(from: inFormat, to: recFormat) else { throw NSError(domain: "no converter", code: 0) }
            if inFormat.channelCount > 1 { conv.channelMap = [0] }
            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            req.requiresOnDeviceRecognition = true
            request = req
            synth.delegate = self
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
                if let self, let ch = buffer.floatChannelData?[0] {
                    var m: Float = 0
                    for i in 0..<Int(buffer.frameLength) { m = max(m, abs(ch[i])) }
                    if m > self.peak.get() { self.peak.set(m) }
                    if self.speaking.get() && m > self.peakWhileSpeaking.get() { self.peakWhileSpeaking.set(m) }
                }
                let cap = AVAudioFrameCount(Double(buffer.frameLength) * 16_000 / inFormat.sampleRate) + 64
                guard let out = AVAudioPCMBuffer(pcmFormat: recFormat, frameCapacity: cap) else { return }
                var fed = false
                conv.convert(to: out, error: nil) { _, st in
                    if fed { st.pointee = .noDataNow; return nil }
                    fed = true; st.pointee = .haveData; return buffer
                }
                if out.frameLength > 0 { req.append(out) }
            }
            engine.prepare()
            try engine.start()
            let rec = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
            if rec?.isAvailable != true { recError = "recognizer unavailable" }
            task = rec?.recognitionTask(with: req) { [weak self] r, e in
                if let t = r?.bestTranscription.formattedString { self?.text = t }
                if let e { self?.recError = e.localizedDescription }
            }
        } catch {
            done(["vp": vp, "error": "\(error)"]); return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            let u = AVSpeechUtterance(string: "The quick brown fox jumps over the lazy dog, and the five boxing wizards jump quickly.")
            self.synth.speak(u)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            self.request?.endAudio()
            self.engine.inputNode.removeTap(onBus: 0)
            self.engine.stop()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.task?.cancel()
                done(["vp": vp, "heard": self.text, "spoke": self.spoke, "peak": self.peak.get(), "peakWhileSpeaking": self.peakWhileSpeaking.get(), "recError": self.recError, "format": "\(self.engine.inputNode.outputFormat(forBus: 0))"])
            }
        }
    }
}
var echoTest: EchoTest?

func handle(_ msg: [String: Any]) {
    let id = msg["id"] as? String
    let cmd = msg["cmd"] as? String ?? ""
    switch cmd {
    case "configure":
        if let l = msg["locale"] as? String { voice.locale = l }
        if let v = msg["voiceId"] as? String { voice.voiceId = v.isEmpty ? nil : v }
        if let r = msg["rate"] as? Double { voice.rate = Float(r) }
        if let e = msg["echoCancellation"] as? Bool { voice.echoCancellation = e }
        if let v = msg["vocabulary"] as? [String] { voice.vocabulary = v.filter { !$0.isEmpty } }
        if let g = msg["voiceGender"] as? String { voice.gender = g }
        reply(id)
    case "listen.start":
        do { try voice.startListening(silence: msg["silence"] as? Double); reply(id) }
        catch { reply(id, ok: false, error: error.localizedDescription); emit(["ev": "error", "message": error.localizedDescription]) }
    case "listen.stop":
        if voice.listening && !voice.lastText.isEmpty { voice.finish(voice.session) } else { voice.endRecognition(cancel: true) }
        reply(id)
    case "listen.cancel":
        voice.endRecognition(cancel: true)
        reply(id)
    case "wake.start":
        voice.startWake()
        reply(id)
    case "wake.stop":
        voice.wakeWanted = false
        if voice.wakeMode { voice.endRecognition(cancel: true) }
        reply(id)
    case "speak":
        voice.speak(id: msg["speakId"] as? String ?? UUID().uuidString, text: msg["text"] as? String ?? "")
        reply(id)
    case "speak.stop":
        voice.stopSpeaking(reason: "stop")
        reply(id)
    case "voices":
        reply(id, data: voice.voices())
    case "permissions":
        reply(id, data: permissions())
    case "permissions.request":
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            SFSpeechRecognizer.requestAuthorization { _ in
                DispatchQueue.main.async {
                    Apple.access(.event) { _ in
                        Apple.access(.reminder) { _ in reply(id, data: permissions()) }
                    }
                }
            }
        }
    case "apps.running":
        let apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .compactMap { app -> [String: String]? in
                guard let b = app.bundleIdentifier, let n = app.localizedName else { return nil }
                return ["name": n, "bundleId": b]
            }
        reply(id, data: apps)
    case "apps.installed":
        let ids = msg["bundleIds"] as? [String] ?? []
        reply(id, data: ids.filter { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) != nil })
    case "frontmost":
        if let f = AX.frontmost() { reply(id, data: ["bundleId": f.bundleId, "name": f.name]) } else { reply(id, data: [String: String]()) }
    case "browser.default":
        reply(id, data: ["bundleId": AX.defaultBrowser() ?? ""])
    case "ax.snapshot":
        let bundleId = msg["bundleId"] as? String ?? ""
        axQueue.async {
            guard AXIsProcessTrusted() else { reply(id, ok: false, error: "Accessibility permission is off."); return }
            guard let pair = AX.appElement(bundleId) else { reply(id, ok: false, error: "That app isn't open."); return }
            func read() -> [[String: Any]] {
                let deadline = Date().addingTimeInterval(3.5)
                return AX.windows(pair.1).prefix(4).map { w -> [String: Any] in
                    let snap = AX.snapshot(w, deadline: deadline)
                    return ["title": AX.string(w, kAXTitleAttribute) ?? "", "lines": snap.lines, "busy": snap.busy]
                }
            }
            var wins = read()
            // Chromium apps fill their tree a moment after accessibility is switched on.
            if wins.allSatisfy({ ($0["lines"] as? [String])?.isEmpty ?? true }) {
                usleep(900_000)
                wins = read()
            }
            reply(id, data: ["windows": wins])
        }
    case "ax.inputs":
        let bundleId = msg["bundleId"] as? String ?? ""
        axQueue.async {
            guard let pair = AX.appElement(bundleId) else { reply(id, ok: false, error: "That app isn't open."); return }
            usleep(800_000)
            let main = AX.mainWindow(pair.1)
            let wins = AX.windows(pair.1).prefix(6).map { w -> [String: Any] in
                ["title": AX.string(w, kAXTitleAttribute) ?? "", "main": main.map { CFEqual($0, w) } ?? false, "editables": AX.editables(w)]
            }
            let chosen = main.flatMap { AX.findInput($0) }
            reply(id, data: ["windows": wins, "chosen": chosen.map { el -> String in
                "\(AX.string(el, kAXRoleAttribute) ?? "") \"\(AX.string(el, "AXPlaceholderValue") ?? AX.string(el, kAXDescriptionAttribute) ?? "")\""
            } ?? "none"])
        }
    case "ax.menus":
        let bundleId = msg["bundleId"] as? String ?? ""
        axQueue.async {
            guard AXIsProcessTrusted() else { reply(id, ok: false, error: "Accessibility permission is off."); return }
            guard let pair = AX.appElement(bundleId) else { reply(id, ok: false, error: "That app isn't open."); return }
            reply(id, data: AX.menus(pair.1))
        }
    case "ax.send":
        let text = msg["text"] as? String ?? ""
        axQueue.async {
            do {
                let target = try AX.sendPrompt(
                    bundleId: msg["bundleId"] as? String,
                    url: msg["url"] as? String,
                    browser: msg["browser"] as? String,
                    newChat: msg["newChat"] as? Bool ?? false,
                    chatMenu: msg["chatMenu"] as? [String],
                    text: text,
                    submit: msg["submit"] as? Bool ?? true,
                    returnFocus: msg["returnFocus"] as? Bool ?? true)
                reply(id, data: ["bundleId": target])
            } catch { reply(id, ok: false, error: error.localizedDescription) }
        }
    case "ax.insert":
        let bundleId = msg["bundleId"] as? String ?? ""
        let text = msg["text"] as? String ?? ""
        axQueue.async {
            do { try AX.insert(bundleId: bundleId, text: text); reply(id) }
            catch { reply(id, ok: false, error: error.localizedDescription) }
        }
    case "calendar.events":
        Apple.access(.event) { granted in
            guard granted else { reply(id, ok: false, error: "Watson doesn't have access to Calendar. Allow it in System Settings → Privacy & Security → Calendars."); return }
            let from = date(msg["from"]) ?? Calendar.current.startOfDay(for: Date())
            let to = date(msg["to"]) ?? from.addingTimeInterval(86_400)
            reply(id, data: Apple.events(from: from, to: to))
        }
    case "calendar.add":
        Apple.access(.event) { granted in
            guard granted else { reply(id, ok: false, error: "Watson doesn't have access to Calendar."); return }
            guard let start = date(msg["start"]) else { reply(id, ok: false, error: "Missing start time."); return }
            let end = date(msg["end"]) ?? start.addingTimeInterval(3600)
            do {
                reply(id, data: try Apple.addEvent(title: msg["title"] as? String ?? "New event", start: start, end: end, allDay: msg["allDay"] as? Bool ?? false, location: msg["location"] as? String, notes: msg["notes"] as? String))
            } catch { reply(id, ok: false, error: error.localizedDescription) }
        }
    case "reminders.list":
        Apple.access(.reminder) { granted in
            guard granted else { reply(id, ok: false, error: "Watson doesn't have access to Reminders. Allow it in System Settings → Privacy & Security → Reminders."); return }
            Apple.reminders(list: msg["list"] as? String) { reply(id, data: $0) }
        }
    case "reminders.add":
        Apple.access(.reminder) { granted in
            guard granted else { reply(id, ok: false, error: "Watson doesn't have access to Reminders."); return }
            do { reply(id, data: try Apple.addReminder(title: msg["title"] as? String ?? "", due: date(msg["due"]), list: msg["list"] as? String)) }
            catch { reply(id, ok: false, error: error.localizedDescription) }
        }
    case "echo.test":
        let t = EchoTest(); echoTest = t
        t.run(vp: msg["vp"] as? Bool ?? true) { reply(id, data: $0); echoTest = nil }
    case "audio.probe":
        reply(id, data: audioProbe(only: msg["only"] as? Int))
    case "reminders.complete":
        Apple.access(.reminder) { granted in
            guard granted else { reply(id, ok: false, error: "Watson doesn't have access to Reminders."); return }
            Apple.completeReminder(msg["title"] as? String ?? "") { result in
                switch result {
                case .success(let data): reply(id, data: data)
                case .failure(let error): reply(id, ok: false, error: error.localizedDescription)
                }
            }
        }
    case "ping":
        reply(id, data: ["pong": true])
    default:
        reply(id, ok: false, error: "Unknown command \(cmd)")
    }
}

// Read stdin on a background thread; handle commands on the main thread.
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async { handle(obj) }
    }
    // Electron went away.
    exit(0)
}

emit(["ev": "ready", "permissions": permissions()])
RunLoop.main.run()
