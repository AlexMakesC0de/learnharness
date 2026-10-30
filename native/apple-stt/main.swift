import AVFoundation
import Darwin
import Foundation
import Speech

// Stdout is exclusively the NDJSON protocol. Never log input audio or recognized text.
private enum Output {
    static let lock = NSLock()
    static func emit(_ value: [String: Any]) {
        lock.withLock {
            guard let json = try? JSONSerialization.data(withJSONObject: value) else { exit(1) }
            FileHandle.standardOutput.write(json + Data([10]))
        }
    }
    static func complete(_ value: [String: Any], code: Int32) -> Never {
        lock.lock()
        guard let json = try? JSONSerialization.data(withJSONObject: value) else { exit(1) }
        FileHandle.standardOutput.write(json + Data([10]))
        // Keep the lock until process exit: a simultaneous reader failure must never
        // append an error after a final result, or emit a second terminal message.
        exit(code)
    }
    static func fail(_ message: String) -> Never {
        complete(["type": "error", "message": message], code: 1)
    }
}

private enum Input: Sendable {
    case audio(Data)
    case finish
}

// Blocking stdin reads run outside Swift's cooperative executor. Cancel/EOF terminate this
// disposable session process immediately, including during an OS asset download or finalization.
// Process teardown releases the analyzer; cancellation never emits a transcript.
private func readInput(_ continuation: AsyncStream<Input>.Continuation) {
    var line = Data()
    var chunk = [UInt8](repeating: 0, count: 4096)
    var finished = false
    while true {
        let count = Darwin.read(STDIN_FILENO, &chunk, chunk.count)
        if count == 0 {
            if !finished { exit(0) }
            if !line.isEmpty { Output.fail("Input received after finish.") }
            return // EOF following finish must not discard the transcript being drained.
        }
        if count < 0 {
            if errno == EINTR { continue }
            Output.fail("Could not read audio input.")
        }
        for byte in chunk.prefix(count) {
            if byte != 10 {
                guard line.count < 32_768 else { Output.fail("Input line exceeds 32 KB.") }
                line.append(byte)
                continue
            }
            guard !line.isEmpty,
                  let object = try? JSONSerialization.jsonObject(with: line),
                  let message = object as? [String: Any],
                  let type = message["type"] as? String else {
                Output.fail("Malformed input command.")
            }
            line.removeAll(keepingCapacity: true)
            if type == "cancel", message.count == 1 { exit(0) }
            guard !finished else { Output.fail("Input received after finish.") }
            let event: Input
            switch type {
            case "audio":
                guard message.count == 2, let encoded = message["data"] as? String,
                      let data = Data(base64Encoded: encoded), !data.isEmpty,
                      data.count % 2 == 0 else {
                    Output.fail("Audio must be base64-encoded complete linear16 samples.")
                }
                event = .audio(data)
            case "finish":
                guard message.count == 1 else { Output.fail("Malformed finish command.") }
                finished = true
                event = .finish
            default:
                Output.fail("Unknown input command.")
            }
            switch continuation.yield(event) {
            case .enqueued: break
            case .dropped: Output.fail("Audio input buffer is full.")
            case .terminated: return
            @unknown default: Output.fail("Could not queue audio input.")
            }
        }
    }
}

@available(macOS 26.0, *)
private final class PCMConverter {
    private let source: AVAudioFormat
    private let target: AVAudioFormat
    private let converter: AVAudioConverter

    init(target: AVAudioFormat) {
        guard let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                                         channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: source, to: target) else {
            Output.fail("Apple speech audio conversion is unavailable.")
        }
        self.source = source
        self.target = target
        self.converter = converter
        converter.primeMethod = .none
    }

    func convert(_ data: Data) -> AVAudioPCMBuffer? {
        let frames = AVAudioFrameCount(data.count / 2)
        guard let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: frames),
              let samples = input.int16ChannelData else {
            Output.fail("Could not allocate an audio input buffer.")
        }
        input.frameLength = frames
        data.withUnsafeBytes { bytes in
            _ = memcpy(samples[0], bytes.baseAddress!, data.count)
        }
        let capacity = AVAudioFrameCount(ceil(Double(frames) * target.sampleRate / 16_000)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            Output.fail("Could not allocate an audio conversion buffer.")
        }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return input
        }
        guard status != .error, error == nil else { Output.fail("Could not convert audio for Apple speech.") }
        return output.frameLength > 0 ? output : nil
    }

    func drain() -> AVAudioPCMBuffer? {
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 4096) else {
            Output.fail("Could not allocate the final audio conversion buffer.")
        }
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            inputStatus.pointee = .endOfStream
            return nil
        }
        guard status != .error, error == nil else { Output.fail("Could not finalize audio conversion.") }
        return output.frameLength > 0 ? output : nil
    }
}

@available(macOS 26.0, *)
private func capabilities() async {
    let available = SpeechTranscriber.isAvailable
    let locales = available ? await SpeechTranscriber.supportedLocales : []
    let displayLocale = Locale.current
    let entries = locales.map { locale -> [String: String] in
        let id = locale.identifier(.bcp47)
        return ["id": id, "label": displayLocale.localizedString(forIdentifier: id) ?? id]
    }.sorted { $0["label"]! < $1["label"]! }
    let system = available ? await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) : nil
    Output.emit(["available": available, "locales": entries,
                 "defaultLocale": system.map { $0.identifier(.bcp47) } as Any? ?? NSNull()])
}

@available(macOS 26.0, *)
private func transcribe(language: String, input: AsyncStream<Input>) async {
    guard SpeechTranscriber.isAvailable else { Output.fail("Apple on-device speech is unavailable on this Mac.") }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) else {
        Output.fail("The selected language is not supported by Apple speech.")
    }
    // Final-only results remove volatile replacement races; all final segments are retained.
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    let status = await AssetInventory.status(forModules: [transcriber])
    guard status != .unsupported else { Output.fail("The selected Apple speech language is unavailable.") }
    if status != .installed {
        do {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await request.downloadAndInstall()
            }
        } catch { Output.fail("Could not install the Apple speech language. Check your connection and try again.") }
    }
    guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
        Output.fail("The Apple speech language assets are not installed.")
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        Output.fail("Apple speech could not select an audio format.")
    }
    let converter = PCMConverter(target: format)
    let analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated,
                                                                        modelRetention: .processLifetime))
    let (audio, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(128))
    do {
        try await analyzer.prepareToAnalyze(in: format)
        try await analyzer.start(inputSequence: audio)
    } catch { Output.fail("Could not start Apple on-device speech.") }
    let results = Task { () throws -> String in
        var text = ""
        for try await result in transcriber.results {
            if result.isFinal { text += String(result.text.characters) }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    Output.emit(["type": "ready"])
    func append(_ buffer: AVAudioPCMBuffer) {
        switch continuation.yield(AnalyzerInput(buffer: buffer)) {
        case .enqueued: break
        case .dropped: Output.fail("Apple speech audio processing buffer is full.")
        case .terminated: Output.fail("Apple speech stopped accepting audio.")
        @unknown default: Output.fail("Could not queue audio for Apple speech.")
        }
    }
    for await event in input {
        switch event {
        case .audio(let data):
            if let buffer = converter.convert(data) { append(buffer) }
        case .finish:
            while let buffer = converter.drain() { append(buffer) }
            continuation.finish()
            // Never truncate a late final segment with a guessed sleep. Wait for the result
            // sequence to end; fail explicitly if the OS cannot finish within the deadline.
            DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
                Output.fail("Apple speech took too long to finalize. Please try again.")
            }
            do {
                try await analyzer.finalizeAndFinishThroughEndOfInput()
                let text = try await results.value
                Output.complete(["type": "result", "text": text], code: 0)
            } catch { Output.fail("Apple speech could not finalize the recording.") }
        }
    }
}

@main
private enum AppleSTT {
    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        let args = Array(CommandLine.arguments.dropFirst())
        if args == ["--capabilities"] {
            if #available(macOS 26.0, *) { await capabilities() }
            else { Output.emit(["available": false, "locales": [], "defaultLocale": NSNull()]) }
            return
        }
        guard args.count == 2, args[0] == "--language", !args[1].isEmpty, args[1].utf8.count < 128 else {
            Output.fail("Usage: apple-stt --capabilities or --language <BCP-47 locale>.")
        }
        guard #available(macOS 26.0, *) else { Output.fail("Apple on-device speech requires macOS 26 or later.") }
        let (input, continuation) = AsyncStream<Input>.makeStream(bufferingPolicy: .bufferingOldest(128))
        DispatchQueue.global(qos: .userInitiated).async { readInput(continuation) }
        await transcribe(language: args[1], input: input)
    }
}
