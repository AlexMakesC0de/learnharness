# Apple dictation on macOS

Approved by Alex in chat on 2026-10-30: desktop macOS 26+ uses on-device Apple speech for Dictate; Windows keeps Deepgram. Preserve the meter, insert-on-stop, cancellation, and existing browser/Linux behavior. Mac languages come from Apple and default to the system language. Show Apple errors without silently falling back to cloud transcription.

## Implementation contract

- Bundle a standalone Swift helper using SpeechTranscriber/SpeechAnalyzer, following Conduit's provider and buffer conversion approach. Do not require Conduit, link its checkout, or edit its in-flight work.
- Keep microphone capture and RMS in the existing renderer AudioWorklet. Send linear16 mono 16kHz PCM through a guarded Electron bridge to the helper; audio never reaches the Next server or Deepgram on the Mac path.
- The main process owns one active helper per trusted renderer. Validate the exact app main frame, operation shapes, session ownership, audio size, and process lifetime. Cancel on navigation, renderer destruction and app quit. Bound protocol lines, buffering and timeouts; never log audio or transcript content.
- Helper binary `build/apple-stt/apple-stt`; packaged resource `apple-stt`. Source `native/apple-stt/main.swift`. Native build requires macOS 26+/Xcode 26+; Windows/Linux skip the build. Older Mac desktop displays a clear unavailable message, without cloud fallback.
- `apple-stt --capabilities` emits one JSON object `{available, locales:[{id,label}], defaultLocale}` and exits. Locales are actual Apple-supported BCP-47 identifiers; defaultLocale is the supported system locale, or null if unsupported.
- A transcription process launches with `--language <locale>`. It prepares/downloads required Apple language assets, then emits `{"type":"ready"}`. Stdin is newline-delimited JSON: `{"type":"audio","data":"<base64 linear16>"}`, `{"type":"finish"}`, `{"type":"cancel"}`. Finish drains final recognition results, emits `{"type":"result","text":"..."}` once and exits. Failures emit `{"type":"error","message":"..."}` and exit nonzero. EOF cancels. No partial transcript text is displayed.
- Narrow preload API `window.lh.appleDictation`: capabilities(), start(locale), append(sessionId, frame), finish(sessionId), cancel(). Start resolves with a sessionId after ready; cancellation must abort an in-flight start. Main-process framing and pipe backpressure must preserve audio/finish order.
- Capture can start while the helper prepares. Buffer complete PCM frames boundedly and fail explicitly on overflow. Drain the worklet's last partial frame before finalization. Stop finishes the recorded utterance; cancel/navigation discards it and invalidates every outstanding callback. Submit awaits final text before reading the field.
- Persist `dictation.appleLocale` separately from the existing Deepgram `dictation.language`, using `system` by default. Mac settings show Apple on-device speech and a supported-language picker; hide Deepgram key guidance there while preserving any stored key. Windows/browser/Linux retain existing Deepgram controls and behavior.
- Verification: deterministic bridge/hook/settings tests, real Apple transcription of a locally generated audio fixture, full tests/typecheck/lint, package signature/feed checks, and packaged desktop launch. A real human microphone pass may remain manual; never claim it occurred from fixture results.

Technical details not fixed here belong to the implementer, within these contracts. No push, merge, deployment or release is authorized.
