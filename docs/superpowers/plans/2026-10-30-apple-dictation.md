# Apple dictation implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the independent native helper, and execute the integration in this session. Review the complete change before committing.

**Goal:** Make Dictate use on-device Apple speech in the Mac desktop app while preserving Deepgram elsewhere.

**Architecture:** Existing renderer microphone capture feeds a guarded Electron IPC adapter and a bundled Swift SpeechAnalyzer helper. Keep all deferred transcript targeting, meter and submit semantics.

**Tech stack:** Swift, Apple Speech/AVFoundation, Electron, React, strict TypeScript, node:test.

**Spec:** [Apple dictation design](../specs/2026-10-30-apple-dictation-design.md), approved in chat.

## Global constraints

- Preserve browser/Linux/Windows Deepgram behavior; no silent cloud fallback on Mac.
- Do not alter Conduit or real user data. Keep all generated binaries ignored.
- Authorize desktop main-frame IPC and session ownership; bound audio/protocol buffers and process timeouts.
- Capture remains in the renderer; only final text is appended, exactly once.

## Review focus

- Stop/cancel while native startup or language download is pending.
- Audio arriving just before stop, including the worklet's partial frame.
- Navigation/restart races and text delivered to the wrong input or new session.
- Cross-frame/window session theft, malformed audio, helper crash and pipe backpressure.
- Platform/language selection and preserving existing saved Deepgram settings.

### Task 1: Swift helper and local native verification

**Owner/files:** native worker owns `native/apple-stt/**`, `scripts/build-apple-stt.mjs`, `scripts/smoke-apple-stt.mjs`. It does not edit shared configuration.

**Interface:** binary and NDJSON protocol exactly as specified in the design.

- [x] Implement capability discovery, PCM conversion, asset preparation, finalization and cancellation, using Conduit as a read-only reference.
- [x] Build the helper and verify actual on-device recognition using a local synthesized audio fixture; test cancellation/invalid inputs.
- [x] Review the native implementation and address material findings.

### Task 2: Guarded desktop adapter and renderer integration

**Owner/files:** root owns `electron/apple-dictation.cjs`, `electron/main.cjs`, `electron/preload.cjs`, bridge types, `components/dictation.tsx`, `public/worklets/pcm-capture.js` and their tests.

**Interface:** `window.lh.appleDictation` methods specified in the design; session-scoped sequential audio and finalization.

- [x] Write failing tests for native routing, startup/cancel/stop races, final transcript flush and IPC ownership/error handling.
- [x] Implement guarded subprocess management, preload methods and Mac routing without invoking cloud token minting.
- [x] Drain final PCM frames before stop and preserve existing Deepgram behavior.
- [x] Run focused dictation, platform and bridge tests.

### Task 3: Settings, packaging, documentation and full verification

**Owner/files:** root owns settings contracts/resolution/store validation, Mac settings UI, package scripts, builder config, workflows, docs and related tests.

**Interfaces:** `dictation.appleLocale` defaults to `system`; Apple capability locale list drives Mac UI; Deepgram preference remains separate.

- [x] Add regression coverage for platform-aware provider UI and saved language isolation.
- [x] Build/package the helper only on Mac, including dev/release paths, and document setup/errors.
- [x] Run full tests/typecheck/lint, actual native fixture and packaged native smoke/launch checks.
- [x] Complete independent review, commit only task files, preserve the worktree and report SHA/artifact locations and verification limits.

## Progress

- Starting from clean `ae0d35a` on `codex/macos-local-build` in the existing isolated worktree.
- User approved the behavior plan; source changes may proceed.

- Builder check found nothing important unresolved. Native helper implementation was delegated with exclusive file ownership; Conduit was read only.
- Native build and full local/packaged helper smoke passed: 30 supported locales, malformed protocol bounds, cancel/EOF during startup and capture, empty finalization, and actual Apple recognition of a synthesized audio fixture.
- Review fixed startup races around settings, microphone permission and helper failure. Stop before a capture worklet exists now cancels promptly; late microphone grants are released. Captured audio still drains and finalizes; cancellation discards late results.
- Added native session ownership/Unicode tests, real-hook lifecycle tests, platform-aware settings tests, actual-worklet tail draining, and trusted-frame IPC regression coverage.
- Final verification: full deterministic suite passed 2,552/2,552; typecheck and lint passed. `npm run desktop:dist:local` built the current app/DMG/ZIP; strict deep app signature and helper signature checks passed. DMG checksum, ZIP integrity, helper inclusion and fork updater feed were verified.
- Actual packaged Dictate button passed using a synthesized Web Audio input stream in a disposable profile: meter activity, deferred transcript, final text insertion, Mac Apple settings, and zero Deepgram token/audio requests. No renderer errors. Chromium fake-microphone flags alone remained behind OS microphone permission, so this check deliberately supplied a synthetic MediaStream instead; physical microphone permission/capture remains a manual check.
- The native CI protocol smoke validates unavailable hardware explicitly and skips speech-dependent checks there. The full default smoke requires working Apple speech and continues to fail if unavailable.
- Independent final source review found no remaining material issues. The original clone stays clean. No push, merge, deployment or release was performed.
