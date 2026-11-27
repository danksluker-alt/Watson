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
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let playFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    let recFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    var engineRunning = false
    var echoCancellation = true
    var inputConverter: AVAudioConverter?
    var convErrorLogged = false
    var stopEngineWork: DispatchWorkItem?

    // Recognition (main-thread state, except `request`, which the audio thread reads)
    var locale = "en-US"
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
        // Plugging in AirPods or switching output stops the engine; rebuild it if we still need it.
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.engineRunning = false
            self.engine.inputNode.removeTap(onBus: 0)
            if self.listening || self.isSpeaking {
                do { try self.ensureEngine() } catch { emit(["ev": "error", "message": error.localizedDescription]) }
            }
        }
    }

    var isSpeaking: Bool { writingUtterance != nil || pending > 0 || !queue.isEmpty }

    // MARK: Engine

    func ensureEngine() throws {
        stopEngineWork?.cancel()
        if engineRunning && engine.isRunning { return }
        engineRunning = false
        let input = engine.inputNode
        if echoCancellation {
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
        if player.engine == nil {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: playFormat)
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
        try engine.start()
        engineRunning = true
        player.play() // no-op if already playing; needed after an engine restart
    }

    /// Release the microphone (and the orange dot) shortly after we stop needing it.
    func scheduleEngineStop() {
        stopEngineWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.listening, !self.isSpeaking, self.engineRunning else { return }
            self.engine.inputNode.removeTap(onBus: 0)
            self.player.stop()
            self.engine.stop()
            self.engineRunning = false
        }
        stopEngineWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0, execute: work)
    }

    // Audio thread.
    func handleInput(_ buffer: AVAudioPCMBuffer) {
        guard isListening.get() else { return }
        if let ch = buffer.floatChannelData?[0] {
            let n = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0..<n { sum += ch[i] * ch[i] }
            let rms = sqrt(sum / Float(max(n, 1)))
            let now = Date().timeIntervalSince1970
            if now - lastLevelEmit.get() > 0.05 {
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

    func startListening(silence: Double?) throws {
        endRecognition(cancel: true)
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
        req.contextualStrings = ["Watson", "Claude", "ChatGPT", "Grok", "Gemini", "Spotify", "Cowork"]
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
        endpointTimer?.invalidate()
        endpointTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.checkEndpoint() }
        emit(["ev": "listening", "session": sid])
    }

    func onResult(_ sid: Int, text: String?, isFinal: Bool, error: String?) {
        guard sid == session, listening else { return }
        if let text, !text.isEmpty, text != lastText {
            if isSpeaking {
                // Ignore what is probably our own voice leaking in; stop only for real new words.
                let spoken = Set(words(spokenText))
                let novel = words(text).filter { !spoken.contains($0) }
                if novel.count < 2 { return }
                stopSpeaking(reason: "bargein")
                emit(["ev": "bargein"])
            }
            lastText = text
            lastChange = Date()
            emit(["ev": "partial", "text": text, "session": sid])
        }
        if isFinal || error != nil {
            if !lastText.isEmpty { finish(sid) } else if error != nil && !isSpeaking {
                // "No speech detected" and friends. Keep listening only if we were asked to.
                endRecognition(cancel: true)
                emit(["ev": "nospeech", "session": sid])
            }
        }
    }

    func checkEndpoint() {
        guard listening, !lastText.isEmpty, !isSpeaking else { return }
        if Date().timeIntervalSince(lastChange) >= silenceSeconds { finish(session) }
    }

    func finish(_ sid: Int) {
        let text = lastText
        endRecognition(cancel: true)
        emit(["ev": "final", "text": text, "session": sid])
    }

    func endRecognition(cancel: Bool) {
        endpointTimer?.invalidate()
        endpointTimer = nil
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

    func selectedVoice() -> AVSpeechSynthesisVoice? {
        if let voiceId, let v = AVSpeechSynthesisVoice(identifier: voiceId) { return v }
        let lang = String(locale.prefix(2))
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(lang) }
        let regional = candidates.filter { $0.language == locale.replacingOccurrences(of: "_", with: "-") }
        let pool = regional.isEmpty ? candidates : regional
        return pool.max { $0.quality.rawValue < $1.quality.rawValue }
    }

    func speak(id: String, text: String) {
        queue.append((id, text))
        if writingUtterance == nil { writeNext() }
    }

    func writeNext() {
        guard !queue.isEmpty else { checkIdle(); return }
        let item = queue.removeFirst()
        do { try ensureEngine() } catch {
            emit(["ev": "error", "message": error.localizedDescription])
            queue.removeAll()
            return
        }
        if engine.isRunning && !player.isPlaying { player.play() }
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
        spokenText = ""
        announcedIds.removeAll()
        emit(["ev": "speak.idle"])
        if !listening { scheduleEngineStop() }
    }

    func stopSpeaking(reason: String) {
        let wasSpeaking = isSpeaking
        generation += 1
        queue.removeAll()
        writingUtterance = nil
        pending = 0
        synth.stopSpeaking(at: .immediate)
        if player.engine != nil { player.stop() }
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
            return ["id": v.identifier, "name": v.name, "language": v.language, "quality": quality]
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

    /// Visible text of a window as lines, plus whether a "Stop" button suggests the app is still generating.
    static func snapshot(_ window: AXUIElement, deadline: Date) -> (lines: [String], busy: Bool) {
        var busy = false
        var visited = 0

        func walk(_ el: AXUIElement, depth: Int) -> [String] {
            visited += 1
            if visited > 40_000 || depth > 90 || Date() > deadline { return [] }
            let role = string(el, kAXRoleAttribute) ?? ""
            if role == "AXButton" {
                let label = [string(el, kAXDescriptionAttribute), string(el, kAXTitleAttribute), string(el, kAXHelpAttribute)]
                    .compactMap { $0 }.joined(separator: " ").lowercased()
                if label.contains("stop") { busy = true }
                return []
            }
            if role == "AXTextArea" || role == "AXTextField" || role == "AXSearchField" || role == "AXToolbar" || role == "AXTabGroup" {
                return [] // skip input boxes and browser chrome
            }
            if role == "AXStaticText" {
                let v = (string(el, kAXValueAttribute) ?? string(el, kAXTitleAttribute) ?? "")
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

    static func findInput(_ window: AXUIElement) -> AXUIElement? {
        var found: AXUIElement?
        var visited = 0
        func walk(_ el: AXUIElement, depth: Int) {
            visited += 1
            if visited > 40_000 || depth > 90 { return }
            let role = string(el, kAXRoleAttribute) ?? ""
            if role == "AXTextArea" || (role == "AXTextField" && string(el, kAXSubroleAttribute) != "AXSearchField") {
                found = el // keep the last one: chat boxes sit at the bottom
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
    static func sendPrompt(bundleId: String?, url: String?, browser: String?, newChat: Bool, text: String, submit: Bool, returnFocus: Bool) throws -> String {
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
            let start = Date()
            var focused = false
            while Date().timeIntervalSince(start) < (newChat ? 15 : 3) {
                if let pair = appElement(b), let window = mainWindow(pair.1), let input = findInput(window) {
                    usleep(newChat ? 900_000 : 150_000) // let the page finish wiring up the box
                    AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                    focused = true
                    break
                }
                usleep(400_000)
            }
            if !focused { log("No message box found in \(b); pasting into whatever has focus.") }
            usleep(200_000)
        } else if let bundleId, !bundleId.isEmpty {
            target = bundleId
            run("/usr/bin/open", ["-b", bundleId])
            try waitFront(bundleId, seconds: 12)
            usleep(700_000)
            if newChat {
                key(45, flags: .maskCommand) // Cmd+N: new chat in Claude, ChatGPT and most chat apps
                usleep(900_000)
            }
            if let pair = appElement(bundleId), let window = mainWindow(pair.1), let input = findInput(window) {
                AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                usleep(150_000)
            }
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

func handle(_ msg: [String: Any]) {
    let id = msg["id"] as? String
    let cmd = msg["cmd"] as? String ?? ""
    switch cmd {
    case "configure":
        if let l = msg["locale"] as? String { voice.locale = l }
        if let v = msg["voiceId"] as? String { voice.voiceId = v.isEmpty ? nil : v }
        if let r = msg["rate"] as? Double { voice.rate = Float(r) }
        if let e = msg["echoCancellation"] as? Bool { voice.echoCancellation = e }
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
            let deadline = Date().addingTimeInterval(3.5)
            let wins = AX.windows(pair.1).prefix(4).map { w -> [String: Any] in
                let snap = AX.snapshot(w, deadline: deadline)
                return ["title": AX.string(w, kAXTitleAttribute) ?? "", "lines": snap.lines, "busy": snap.busy]
            }
            reply(id, data: ["windows": Array(wins)])
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
