# Local SearXNG implementation plan

> **For agentic workers:** Implement inline using superpowers:executing-plans, with a bounded DeepSeek Compose draft and an independent final review.

**Goal:** Run free local web search and add SearXNG alongside Tavily and Brave.

**Architecture:** A project-scoped Docker Compose service binds only `127.0.0.1:8080`. The app's existing search port gains a keyless `searxng` adapter at that fixed loopback endpoint. Tavily/Brave behavior and stored keys remain intact.

**Tech stack:** Docker Compose, official SearXNG container, Next.js/Electron, strict TypeScript, node:test.

## Approved specification

Alex approved in chat on 2026-10-30: provision local SearXNG at `http://127.0.0.1:8080`, add/select “SearXNG (local)” for the Mac app, retain selectable Tavily and Brave, never automatically fall back to a paid provider, add start/stop commands, verify live searches and rebuild.

## Global constraints

- Preserve all unrelated containers, source edits and user settings/credentials. Use the existing isolated branch/worktree.
- Bind the Docker port only to IPv4 loopback. No LAN listener, public instance, vendor search API keys or shared public SearXNG instance.
- Pin the official image by digest. Generate the SearXNG server secret outside tracked source and outside the app's traceable project directory.
- The fixed endpoint needs no user-configurable URL or API-key-shaped placeholder. Reject redirects and bound response size/time. Surface local service/JSON API/upstream failures clearly.
- Selecting SearXNG is explicit; absence of a pin retains Tavily→Brave automatic key selection. A stopped local service never triggers a different provider.
- Configure Alex's actual packaged-app preference after verification without copying or replacing other settings. Rehearsal/test profiles remain disposable. No push, merge, deployment or release.

## Review focus

- Local service down, JSON disabled, rate limits, malformed/oversized results and upstream engine failures.
- Keyless SearXNG selection and no accidental Tavily/Brave fallback or key requirements.
- Explicit provider preference survives validation, saves and page remounts.
- Loopback-only Docker publication, scoped start/stop commands, secret persistence and no build leakage.
- Live adapter behavior from the packaged server, not only unit tests or direct container requests.

### Task 1: Local service

**Files:** `ops/searxng/compose.yml`, `scripts/local-search.mjs`, package scripts and setup docs. DeepSeek owns only the initial Compose draft; parent reviews/provisions/tests.

- [x] Pin the official image and configure HTML/JSON search, private-instance settings and generated secret.
- [x] Add `search:start`, `search:stop`, `search:status`; start verifies readiness, stop affects only this Compose project.
- [x] Start the real service and verify useful live search results; preserve other containers.

### Task 2: Application integration

**Files:** search core/server contracts, parser/sanitizer, agent settings/menu, web tool help, and relevant tests.

- [x] Add failing adapter/resolution/settings tests, implement a bounded local JSON adapter, run focused tests.
- [x] Add a keyless SearXNG menu option and preserve Tavily/Brave options and automatic precedence.
- [x] Test keyless UI selection, stored preference validation and no paid fallback.

### Task 3: Verify, configure and commit

- [x] Run full tests/typecheck/lint, real local searches, current-source Mac package and packaged UI/provider verification.
- [ ] Safely select SearXNG in Alex's packaged-app settings; preserve unrelated fields and credentials. (Blocked: the Claude Code permission classifier refused writes to the real profile; Alex selects it in Settings → Agent → Search engine.)
- [x] Independent review, fixes, archive/signature checks, task-only commit and concise report.

## Execution record

- Starting clean at `f8bc845` on `codex/macos-local-build`; Docker Desktop and Compose are running, port 8080 is unused.
- The user approved the plan before implementation. Search remains online through upstream engines; “local” describes this service, not an offline web index.
- Codex stopped after the Compose draft and the failing adapter tests; Claude finished Tasks 1–3 on the same branch.
- Image pinned to the official `ghcr.io/searxng/searxng` index digest `sha256:c4e8…1b86` (2026.10.29-c15647b5a). The secret lives in `~/.config/learnharness/searxng/secret` (0600, never mounted); `config/settings.yml` is copied from the tracked `ops/searxng/settings.yml` (JSON format on, limiter off).
- `npm run search:start` brought the service up healthy on `127.0.0.1:8080` only (IPv4 loopback, `docker port` confirmed), 37 results for the test query; DuckDuckGo answered with a CAPTCHA and the other engines still returned results. The 17 unrelated containers stayed up.
- The real adapter returned five clean results each for two live queries. Typecheck, lint and all 2,556 tests pass.
- The settings menu now opens without any key: the existing DOM test that pinned "keyless menu cannot open" was updated to cover choosing SearXNG with no key.
- `desktop:dist:local` rebuilt from the final source; codesign `--verify --deep --strict` passes (ad-hoc), the ZIP and DMG verify. The packaged server, run against a disposable data folder, showed SearXNG selectable with no key, persisted across a restart, and rejected unknown engines. The packaged chunks contain the loopback adapter; a live researcher `web_search` call from the packaged app was not exercised (it needs a model run).
- Build note: the standalone server output already carries the whole repo tree (docs, tests, scripts), so `ops/searxng/*` and `scripts/local-search.mjs` ship there too. They hold no secret (the secret was grepped for in the app and `dist/`); trimming the standalone tree is a separate pre-existing issue.
- Independent review found nothing at high confidence; its notes on timeout wording and the start script's JSON parsing were applied.
- Alex asked to commit, push and merge everything on 2026-10-30, superseding the plan's "no push, merge" constraint.
