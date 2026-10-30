# macOS local build implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved plan in this session.

**Goal:** Build and launch LearnHarness locally on Alex's Apple Silicon Mac without the upstream author's Apple signing credentials.

**Architecture:** Reuse the existing standalone server and Electron packaging pipeline. Separate shared payload preparation from local ad-hoc packaging and Developer ID distribution. The packaged updater uses Alex's fork.

**Tech stack:** Next.js 16, Electron 44, electron-builder 26.16.1, npm, GitHub Actions.

**Spec:** Alex approved in chat on 2026-10-30: add a local Apple Silicon build command needing no signing credentials; point updates at `AlexMakesC0de/learnharness`; add macOS to full CI checks; build and launch-test on this Mac.

## Global constraints

- Preserve upstream authorship, existing platform behavior, app identity, and user data.
- Do not publish releases, push, merge, or use real provider credentials during verification.
- Local packages use an ad-hoc signature, skip notarization, and explicitly never publish.
- Developer ID distribution continues to require the builder's own signing/notarization credentials; remove upstream-specific team/keychain defaults.
- Keep the existing native-renderer, provider-runtime, payload exclusion, and server smoke gates.

## Review focus

- The local path must not discover or use a real signing identity or notarization credentials.
- A local build must not publish even when GitHub credentials exist in the environment.
- The packaged updater must address Alex's fork, preserving original author attribution.
- Shared payload preparation must check Electron's bundled Node, not only host Node.
- Launch checks must use disposable data, without overwriting an existing installation or learning records.

### Task 1: Portable macOS packaging and CI

**Files:** `package.json`, `package-lock.json`, `electron-builder.yml`, `.github/workflows/ci.yml`, `docs/development.md`, `docs/desktop-release.md`, `scripts/package-local-mac.mjs`, `scripts/check-mac-notarization.mjs`, `tests/mac-local-build.test.ts`, `tests/desktop-platform.test.ts`.

**Interfaces:** `desktop:prepare` builds and verifies the standalone payload. `desktop:dist:local` prepares then builds ad-hoc arm64 DMG/ZIP files. `desktop:dist` validates notarization credentials, prepares, then builds signed/notarized distribution packages using caller-configured credentials. Both packaging paths explicitly disable publishing.

- [x] Install the locked dependencies and run baseline tests/typecheck/lint.
- [x] Read the installed Next.js standalone deployment documentation.
- [x] Extract shared preparation, add local packaging, and remove upstream-specific signing defaults.
- [x] Set package homepage and GitHub update feed to Alex's fork; preserve author metadata and update its existing packaging test.
- [x] Add `macos-15` to full quality CI alongside Ubuntu and Windows.
- [x] Document local setup/build/output and caller-configured signing credentials.
- [x] Run full tests, typecheck, lint, and `npm run desktop:dist:local`.
- [x] Check packaged provider runtime/native rendering, signature and update-feed metadata; launch the actual app using a disposable macOS user-data directory and inspect its window.
- [x] Review the complete diff, fix material issues, commit only task files, and report branch/SHA/package location and verification limits.

## Execution record

- Existing clone is clean at `c6a0e21`; origin main matches it. Latest CI passes on Windows, Linux, and macOS standalone.
- Worktree: `/Users/alex/Developer/learnharness-macos`, branch `codex/macos-local-build`.
- Native worktree creation rejected this repository because it is outside the chat's registered workspace folders; used Git's worktree command instead.
- Baseline: 2,527 tests passed; typecheck and lint passed.
- Review ruling: electron-builder searches real identities before falling back to `identity: "-"`. Use normal DMG/ZIP targets with `identity: null`, and sign directly through the existing `@electron/osx-sign` dependency with identity validation disabled in the local `afterPack` hook, after updater metadata and icon generation. Reject fuse configuration to prevent post-signature executable mutation. Declare the signer as a direct pinned dev dependency. This prevents accidentally using a real certificate.
- Review ruling: `forceCodeSigning` alone does not require notarization. Add credential preflight before preparation, preserving electron-builder's credential precedence and failing without exposing values.
- Signing regression checks: seven tests passed after the initial missing-module failure.
- Verification ruling: a directory-first/prepackaged build omits `app-update.yml`. Use the normal builder lifecycle and public `afterPack` hook instead, preserving system updater metadata generation before local signing.
- Final verification: `npm test` passed 2,535/2,535; `npm run typecheck` and `npm run lint` passed. Electron Node native-renderer checks passed 18/18.
- `npm run desktop:dist:local` completed. The app's strict deep signature verification passed; `Signature=adhoc`, no team identity. ZIP integrity and embedded `AlexMakesC0de/learnharness` feed passed; `hdiutil verify` validated the DMG checksum.
- Final packaged provider initialization passed offline; the packaged browser-service exercised JavaScript and shut down cleanly. The actual packaged app opened its home and Providers settings with no renderer errors, using a temporary profile and no real keys. Test app processes were stopped.
- Independent source review cleared the final changes. The original clone remains clean on main. Generated next-env.d.ts changes were restored.
- Limitations: Developer ID signing/notarization and a real update installation were not exercised; no provider-funded teaching session or microphone permission flow was run. CI configuration was updated locally; no push, merge, release or deployment was performed.
