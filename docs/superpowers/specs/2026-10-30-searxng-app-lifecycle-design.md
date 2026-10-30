# SearXNG follows the desktop app

Approved by Alex in chat on 2026-10-30. Builds on [local SearXNG](../plans/2026-10-30-local-searxng.md), which added the keyless `searxng` engine and the `npm run search:*` commands.

## Goal

In the desktop app, local search needs no terminal: choosing "SearXNG (local)" in Settings starts it, every later launch starts it again, and quitting the app removes it. A new user installs Docker Desktop and picks SearXNG in Settings. Nothing else.

## Decisions

- **Start only when chosen.** The app touches Docker only when `agent.search.engine` is `"searxng"`: at launch, and as soon as the user picks it. Users of Tavily, Brave or no search never see Docker.
- **Open Docker for the user.** If Docker Desktop is installed but not running, the app opens it in the background (macOS: `open -g -a Docker`; Windows: start `Docker Desktop.exe`) and waits up to 2 minutes. On Linux it reports "start Docker" instead.
- **On quit, only the SearXNG container goes.** Docker Desktop, other containers and the downloaded image stay. "Quit" means the app process ends (Cmd+Q on macOS). Closing the last window on macOS keeps the app and its server resident, as today, so SearXNG stays up too.
- **Switching away stops it.** Picking Tavily, Brave or Automatic removes the container.
- **Desktop only.** Web/dev servers keep the manual `npm run search:start|stop|status`.

## Design

### Server: local search manager (`src/server/local-search.ts`)

The server owns the lifecycle because it already knows the chosen engine and already reports search state to Settings.

- **Enabled only in the desktop server.** Electron passes `LH_SEARXNG_DIR` (bundled `compose.yml` + `settings.yml`) and `LH_SEARXNG_HOME` (`userData/searxng`). Without them the manager is inert.
- **`syncLocalSearch()`.** Reads the effective engine. If it is `searxng`, run `ensure`; otherwise `down`. It is called once at server boot (the Electron shell's authenticated `POST /api/search/local` right after the server is up; a Next `instrumentation.ts` hook was dropped because its file trace ignores `outputFileTracingExcludes` and pulled the repo's `data/` into the package) and after every successful `PUT /api/settings/agent`. Calls are serialized: one operation at a time, and the latest wanted state wins.
- **`ensure` steps**, each setting a state Settings can show:
  1. `checking`: find the docker binary in fixed locations (`/usr/local/bin`, `/opt/homebrew/bin`, `/Applications/Docker.app/Contents/Resources/bin` on macOS; Program Files on Windows; `PATH` on Linux), because apps started from the Dock don't inherit the shell's `PATH`. Spawned commands get those directories prepended to `PATH` so Compose finds its credential helpers. If none is found: `missing-docker`.
  2. `starting-docker`: if `docker info` fails, open Docker Desktop once and poll `docker info` for up to 2 minutes. On timeout: `error`.
  3. `downloading`: if the pinned image isn't present locally (`docker image inspect`), pull it. This happens on first use only.
  4. `starting`: create the secret (0600) and copy `settings.yml` under `LH_SEARXNG_HOME`, then `docker compose -f <bundled compose.yml> up -d` and poll `/healthz` for up to 60 s.
  5. `ready`, or `error` with a plain message. Mapped cases: port 8080 already in use, Compose failure (last stderr line; Compose prints progress before the error), health timeout.
- **`down`.** `docker compose ... down` for the `learnharness-search` project only. Never removes images or other projects.
- **Status.** `GET /api/search` gains `local?: { state, message }` while the engine is `searxng`. `POST /api/search/local` re-runs `ensure`; this is the Retry button.

### Compose file

Drop `restart: unless-stopped`, so a force-quit or crash can't bring SearXNG back on Docker restart. The next launch's `up` replaces any leftover container. The `npm run search:*` script keeps working with the same file.

### Electron shell (`electron/main.cjs`, new `electron/local-search.cjs`)

- Pass `LH_SEARXNG_DIR` and `LH_SEARXNG_HOME` to the server child.
- **Quit cleanup.** In `before-quit`, if the app's compose project has a container, call `event.preventDefault()`, run `docker compose ... down` with a 10 s cap, then quit for real. If down fails or times out, quit anyway; the next launch tidies up. The docker lookup duplicates the server's fixed candidate list, and a test pins the two lists equal (the import law keeps `electron/` and `src/` apart).
- **Packaging.** `electron-builder.yml` `extraResources` ships `ops/searxng/{compose.yml,settings.yml}` to `Resources/searxng/`.

### Settings UI (`components/settings/agent-section.tsx`)

When the engine is SearXNG, the hint under the menu shows the local state, polling `/api/search` every 2 s while the state is `checking`, `starting-docker`, `downloading` or `starting`:

| State | Text | Action |
|---|---|---|
| checking / starting-docker | "Starting Docker…" | — |
| downloading | "Downloading SearXNG (first time, about 380 MB)…" | — |
| starting | "Starting SearXNG…" | — |
| ready | "Ready, running on this Mac" | — |
| missing-docker | "Docker Desktop is needed for local search" | Download Docker Desktop (opens docker.com in the system browser) |
| error | the message | Retry |

## Errors and edge cases

- A search while SearXNG is not ready fails with the existing "not running" message. There is still no fallback to a paid engine.
- Port 8080 used by something else: `error` reads "Port 8080 is in use by another program". The app doesn't pick another port, because the adapter's endpoint is fixed.
- A container from `npm run search:start` belongs to the same Compose project, so the app adopts it, and removes it on quit.
- Docker Desktop quit mid-session: searches fail with the existing message, and Retry goes back through `starting-docker`.

## Testing

- **Unit tests** for the manager with an injected command runner and fetch:
  - docker missing
  - daemon down, then up after open
  - daemon never comes up
  - image absent, so a pull
  - healthy
  - port conflict
  - switching away runs `down`
  - concurrent syncs serialize, with the latest wanted state winning
  - the manager stays inert without `LH_SEARXNG_DIR`
- **Unit tests** for the Electron quit hook (deferred quit, 10 s cap, quit even on failure) and the docker candidate lists matching.
- **UI test:** each state's hint text, plus the Download and Retry actions.
- **Manual on Alex's Mac:**
  1. Build the local package and launch it.
  2. Pick SearXNG and watch it reach Ready.
  3. Quit and confirm the container is gone and the other containers are untouched.
  4. Relaunch and confirm SearXNG starts again by itself.
