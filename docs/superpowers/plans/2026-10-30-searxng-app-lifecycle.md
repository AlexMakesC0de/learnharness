# SearXNG App Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the desktop app, choosing "SearXNG (local)" starts SearXNG (opening Docker Desktop if needed), every launch starts it again, and quitting removes its container.

**Architecture:** A server-side manager (`src/server/local-search.ts`) owns ensure/down, is enabled only by Electron-provided env, runs at server boot (`instrumentation.ts`) and after agent-settings writes, and reports state through `/api/search`. The Electron shell removes the container on quit (`electron/local-search.cjs`), with the update-install path cleaning up before `quitAndInstall`.

**Tech Stack:** Next.js 16 route handlers + instrumentation, Electron main (CJS), Docker Compose CLI, node:test via tsx, linkedom DOM tests.

**Spec:** [SearXNG follows the desktop app](../specs/2026-10-30-searxng-app-lifecycle-design.md). Builds on [local SearXNG](2026-10-30-local-searxng.md).

---

## File map

| File | Responsibility |
|---|---|
| `src/server/local-search.ts` (new) | Docker lookup, ensure/down state machine, serialized sync, globalThis singleton, status |
| `src/server/index.ts` | export the manager's public API |
| `instrumentation.ts` (new) | boot sync (fire-and-forget, Node runtime only) |
| `app/api/settings/[section]/route.ts` | sync after an agent-section write |
| `app/api/search/route.ts` | add `local` status |
| `app/api/search/local/route.ts` (new) | POST = Retry |
| `ops/searxng/compose.yml` | drop `restart: unless-stopped` |
| `electron-builder.yml` | ship `ops/searxng/{compose,settings}.yml` to `Resources/searxng` |
| `electron/local-search.cjs` (new) | quit-time `docker compose -p learnharness-search down`, 10 s cap |
| `electron/main.cjs` | pass `LH_SEARXNG_DIR`/`LH_SEARXNG_HOME`; before-quit + update-install cleanup |
| `components/settings/agent-section.tsx` | state hint, Download/Retry, 2 s polling while transitional |
| `docs/development.md` | user setup steps |
| `tests/local-search-manager.test.ts`, `tests/local-search-quit.test.ts`, `tests/research-settings.test.tsx` | tests |

### Task 1: Server manager

**Files:** Create `src/server/local-search.ts`, `tests/local-search-manager.test.ts`.

- [ ] **Step 1: Write failing tests** with a scripted fake runner. `run` receives `(command, args)` and returns `{code, stdout, stderr}` per a table; `sleep` advances a fake clock; `fetch` answers `/healthz`.

Cases (each asserts final `status()` and the commands run):
1. no docker candidate exists → `missing-docker`, no command run.
2. daemon up, image present, compose up ok, healthz ok → `ready`; commands are `info`, `image inspect <digest ref>`, `compose -f <dir>/compose.yml up -d`; env carries `LH_SEARXNG_SECRET`/`LH_SEARXNG_CONFIG_DIR`.
3. daemon down then up after `open -g -a Docker` (darwin) → passes through `starting-docker` → `ready`.
4. daemon never up within 2 minutes → `error` /did not start within 2 minutes/.
5. linux daemon down → `error` /systemctl/ and no open attempt.
6. image missing → `pull` runs, `downloading` observed → `ready`; pull failure → `error` /Could not download/.
7. compose up stderr "port is already allocated" → `error` "Port 8080 is in use by another program…".
8. healthz never ok within 60 s → `error` /did not answer within 60 seconds/.
9. `sync(true)` then `sync(false)` → `compose -p learnharness-search down` runs after ensure; `off`.
10. `sync(false)` on a fresh manager runs no command (non-users never touch Docker).
11. concurrent `sync(true)` ×2 → one ensure.
12. `retry()` after `error` re-runs ensure.
13. `dockerCandidates("darwin", "/Users/u", "/a:/b")` lists the fixed macOS paths, then `/a/docker`, `/b/docker`.

- [ ] **Step 2:** `node --import tsx --test tests/local-search-manager.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `createLocalSearch(deps)` returning `{ status(), sync(wanted), retry() }`:
  - `ensure`: checking → find docker → `info --format {{.ServerVersion}}` (15 s) → (non-linux) open Docker, poll every 2 s ≤ 120 s → `image inspect` the `image:` ref parsed from compose.yml → `pull` (20 min) if missing → `prepareConfig()` → `compose -f … up -d` (120 s) → poll `/healthz` every 1 s ≤ 60 s.
  - Error text uses the last non-empty stderr line (Compose prints progress to stderr first), truncated to 200 chars.
  - `down`: `compose -p learnharness-search down` (60 s) → `off`.
  - `sync`: `desired = wanted`; one loop runs while `applied !== desired`; thrown errors become `error`. Initial `applied = false`.
  - Spawned env: `PATH` = unique dirnames of all candidates + inherited PATH, so Compose finds `docker-credential-desktop`.
  - Module singleton on `globalThis.__lhLocalSearch`, built from `LH_SEARXNG_DIR` + `LH_SEARXNG_HOME`, else `null`.
  - `syncLocalSearch({retry?})` reads `effectiveSettings().agent.search?.engine === "searxng"`. `localSearchStatus()` returns `null` unless the manager exists and SearXNG is chosen.
  - `prepareConfig` (node default): mkdir `home/config` 0700, create `home/secret` (32 random bytes hex, 0600) if absent, copy `settings.yml`.

- [ ] **Step 4:** Rerun → PASS. **Step 5:** Commit `feat: server-side manager for app-run SearXNG`.

### Task 2: Server wiring

**Files:** `src/server/index.ts`, `instrumentation.ts`, `app/api/settings/[section]/route.ts`, `app/api/search/route.ts`, `app/api/search/local/route.ts`.

- [ ] Export `syncLocalSearch`, `localSearchStatus`, and the types from the barrel.
- [ ] `instrumentation.ts`:
  ```ts
  export async function register() {
  	if (process.env.NEXT_RUNTIME !== "nodejs") return;
  	const { syncLocalSearch } = await import("./src/server/local-search.ts");
  	void syncLocalSearch();
  }
  ```
- [ ] Settings PUT: after `writeSettingsRecord(next)`, `if (section === "agent") void syncLocalSearch();`.
- [ ] `GET /api/search`: `{ ...searchStatus(), ...(local ? { local } : {}) }`.
- [ ] `POST /api/search/local`: `await syncLocalSearch({ retry: true })` is NOT awaited (it can take minutes). Kick it off, then return `{ local: localSearchStatus() }`.
- [ ] Test (in the manager test file): without `LH_SEARXNG_DIR`, `localSearchStatus()` is `null` and `syncLocalSearch()` resolves with no effect.
- [ ] Typecheck + lint, commit `feat: run SearXNG sync at boot and on engine change`.

### Task 3: Electron quit cleanup and packaging

**Files:** `electron/local-search.cjs`, `electron/main.cjs`, `electron-builder.yml`, `ops/searxng/compose.yml`, `tests/local-search-quit.test.ts`.

- [ ] **Failing tests:**
  - `createLocalSearchCleanup({settingsFile, platform, home, envPath, exists, spawn, read, timeoutMs}).down()`:
    - engine not searxng (or unreadable settings) → resolves `false`, no spawn
    - searxng chosen → spawns `<docker> compose -p learnharness-search down` and resolves `true` on exit 0
    - a child that never exits → resolves `false` after `timeoutMs` and kills it
    - spawn error → `false`
  - The CJS `dockerCandidates` equals the TS one for darwin, win32 and linux.
  - Source wiring of `electron/main.cjs` (read as text, like `tests/automatic-updates.test.ts`):
    - passes `LH_SEARXNG_DIR` and `LH_SEARXNG_HOME`
    - `before-quit` calls `event.preventDefault()` only once before `localSearchCleanup.down()`
    - `installUpdateNow` awaits the cleanup before `quitAndInstall`
  - `electron-builder.yml` ships `ops/searxng` to `searxng`; compose has no `restart:`.
- [ ] **Implement** `electron/local-search.cjs` (fully mirrors the candidates; the spawned PATH is built as on the server).
- [ ] `main.cjs` changes:
  - Create the cleanup only when main spawned the server (`!devUrl`).
  - `before-quit`: dispose dictation, `killServer()`, then once: `preventDefault`, `down().finally(() => app.quit())`.
  - `installUpdateNow`: `killServer()`, then `await localSearchCleanup?.down()`, mark cleaned, then `quitAndInstall()`.
- [ ] Builder `extraResources`: `{ from: ops/searxng, to: searxng, filter: [compose.yml, settings.yml] }`.
- [ ] Remove `restart: unless-stopped` from compose.
- [ ] Tests pass, commit `feat: remove app-run SearXNG when the desktop app quits`.

### Task 4: Settings UI states

**Files:** `components/settings/agent-section.tsx`, `tests/research-settings.test.tsx`.

- [ ] **Failing DOM test:**
  - With `agent.search.engine = "searxng"` and `/api/search` returning `local: {state:"missing-docker"}`, the row shows "Docker Desktop is needed for local search" and a link to `https://www.docker.com/products/docker-desktop/` (`data-testid="search-local-download"`).
  - With `state:"error"`, a Retry button (`search-local-retry`) POSTs `/api/search/local`.
  - With `state:"downloading"`, the text matches the spec table.
- [ ] **Implement:**
  - Widen the `search` state type with `local?`.
  - The hint renders the local message plus the action for missing-docker/error.
  - An effect polls `refreshSearch` every 2 s while the state is in `{checking, starting-docker, downloading, starting}`.
  - Picking SearXNG re-reads status after the write; this already happens through the engine-keyed effect.
- [ ] Tests pass, commit `feat: show local search progress in settings`.

### Task 5: Docs and verification

- [ ] `docs/development.md`: replace the 3-step setup with the desktop flow ("install Docker Desktop, choose SearXNG (local)"); keep `npm run search:*` for web/dev.
- [ ] `npm run typecheck && npm run lint && npm test`.
- [ ] `npm run desktop:dist:local`; codesign verify; `Resources/searxng/compose.yml` exists in the app.
- [ ] End-to-end on Alex's Mac without touching his profile:
  1. Stop the manual `npm run search:start` container.
  2. Launch the packaged app with a disposable `--user-data-dir` whose `data/settings.json` pins `searxng`.
  3. Confirm the container comes up healthy by itself.
  4. Quit the app and confirm the container is gone and the other containers are untouched.
  5. Relaunch and confirm it starts again, then quit.
- [ ] Independent review, fixes, commit, push, PR, CI, merge.

## Execution record

- Executed inline by Claude on 2026-10-30 in the `learnharness-macos` worktree, branch `feat/searxng-app-lifecycle`.
- **Task 2 deviation (boot trigger):** `instrumentation.ts` was built as planned, but the first package build refused to finish: `build-server.mjs` found `data/` in the standalone output. `.next/server/instrumentation.js.nft.json` listed 850 files including the repo's `data/chats/*.json`; the `outputFileTracingExcludes` `"*"` key covers routes, not the instrumentation trace. The hook was removed. The Electron shell now sends the authenticated `POST /api/search/local` once the spawned server is up, which runs the same sync. The spec was updated to match.
- Task 3: `installUpdateNow` stays synchronous when no cleanup applies (the existing updater test pins `SIGTERM` then install), and defers to `down().finally(quitAndInstall)` only when cleanup is pending; a fixture test covers that path.
- UI tests live in `tests/local-search-settings.test.tsx` rather than `tests/research-settings.test.tsx`.
