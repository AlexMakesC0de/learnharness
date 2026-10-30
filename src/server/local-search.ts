/**
 * The app-run local SearXNG (spec: docs/superpowers/specs/
 * 2026-10-30-searxng-app-lifecycle-design.md): in the DESKTOP server only,
 * choosing the "searxng" engine starts the bundled Compose project — Docker
 * Desktop opened in the background if it is closed, the pinned image pulled
 * on first use — and choosing another engine removes it. The Electron shell
 * removes it on quit (electron/local-search.cjs).
 *
 * Enabled by LH_SEARXNG_DIR (bundled compose.yml + settings.yml) and
 * LH_SEARXNG_HOME (userData/searxng: the secret + config copy), which only
 * the Electron shell sets; web/dev servers stay inert and keep the manual
 * `npm run search:*` commands.
 *
 * Never auto-falls back: a SearXNG that is not ready only fails searches
 * with the adapter's own message (server/search.ts).
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SEARXNG_ENDPOINT } from "./search.ts";
import { effectiveSettings } from "./stores.ts";

export type LocalSearchState =
	| "off"
	| "checking"
	| "starting-docker"
	| "downloading"
	| "starting"
	| "ready"
	| "missing-docker"
	| "error";

export interface LocalSearchStatus {
	state: LocalSearchState;
	message: string;
}

/** The Compose project name pinned by ops/searxng/compose.yml. */
export const SEARXNG_PROJECT = "learnharness-search";

const DOCKER_START_MS = 120_000;
const HEALTH_MS = 60_000;

type RunResult = { code: number; stdout: string; stderr: string };

export interface LocalSearchDeps {
	/** Directory holding the bundled compose.yml + settings.yml. */
	composeDir: string;
	platform: NodeJS.Platform;
	userHome: string;
	/** The inherited PATH (Dock-launched apps get a minimal one). */
	envPath: string;
	exists: (file: string) => boolean;
	readCompose: () => string;
	/** Create the secret once and copy settings.yml; returns what Compose needs. */
	prepareConfig: () => { secret: string; configDir: string };
	/** Runs a binary with an argument array — never through a shell. */
	run: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<RunResult>;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	onChange?: (status: LocalSearchStatus) => void;
}

/** Where docker lives. Apps started from the Dock don't inherit the
 *  shell's PATH, so the standard install locations come first.
 *  MIRRORED in electron/local-search.cjs (tests pin the two equal). */
export function dockerCandidates(platform: NodeJS.Platform, userHome: string, envPath: string): string[] {
	const p = platform === "win32" ? path.win32 : path.posix;
	const fixed =
		platform === "darwin"
			? [
					"/usr/local/bin/docker",
					"/opt/homebrew/bin/docker",
					"/Applications/Docker.app/Contents/Resources/bin/docker",
					p.join(userHome, ".docker", "bin", "docker"),
				]
			: platform === "win32"
				? ["C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"]
				: ["/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker"];
	const binary = platform === "win32" ? "docker.exe" : "docker";
	const fromPath = envPath
		.split(p.delimiter)
		.filter(Boolean)
		.map((dir) => p.join(dir, binary));
	return [...new Set([...fixed, ...fromPath])];
}

/** Compose prints progress to stderr before the error: keep the last line. */
function lastLine(text: string): string {
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	return (lines.at(-1) ?? "no details").slice(0, 200);
}

export function createLocalSearch(deps: LocalSearchDeps) {
	let status: LocalSearchStatus = { state: "off", message: "" };
	let applied = false;
	let desired = false;
	let running: Promise<void> | null = null;

	const set = (state: LocalSearchState, message: string) => {
		status = { state, message };
		deps.onChange?.(status);
	};
	const p = deps.platform === "win32" ? path.win32 : path.posix;
	const candidates = dockerCandidates(deps.platform, deps.userHome, deps.envPath);
	// docker-credential-desktop and the compose plugin sit beside docker.
	const searchPath = [...new Set(candidates.map((c) => p.dirname(c))), deps.envPath].filter(Boolean).join(p.delimiter);
	const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, PATH: searchPath, ...extra });
	const findDocker = () => candidates.find((c) => deps.exists(c)) ?? null;

	const daemonUp = async (docker: string) =>
		(await deps.run(docker, ["info", "--format", "{{.ServerVersion}}"], { env: env(), timeoutMs: 15_000 })).code === 0;

	async function openDockerDesktop() {
		if (deps.platform === "darwin") {
			await deps.run("/usr/bin/open", ["-g", "-a", "Docker"], { env: env(), timeoutMs: 15_000 });
		} else if (deps.platform === "win32") {
			await deps.run("cmd.exe", ["/d", "/c", "start", "", "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"], {
				env: env(),
				timeoutMs: 15_000,
			});
		}
	}

	async function healthy() {
		try {
			const resp = await deps.fetch(`${SEARXNG_ENDPOINT}/healthz`, { redirect: "error", signal: AbortSignal.timeout(5_000) });
			return resp.ok;
		} catch {
			return false;
		}
	}

	async function ensure() {
		set("checking", "Checking Docker…");
		const docker = findDocker();
		if (!docker) return set("missing-docker", "Docker Desktop is needed for local search");
		if (!(await daemonUp(docker))) {
			if (deps.platform !== "darwin" && deps.platform !== "win32") {
				return set("error", "Docker is not running. Start it (for example: sudo systemctl start docker), then retry.");
			}
			set("starting-docker", "Starting Docker…");
			await openDockerDesktop();
			const deadline = deps.now() + DOCKER_START_MS;
			let up = false;
			while (!up && deps.now() < deadline) {
				await deps.sleep(2_000);
				up = await daemonUp(docker);
			}
			if (!up) return set("error", "Docker Desktop did not start within 2 minutes. Open it, then retry.");
		}
		const image = deps.readCompose().match(/^\s*image:\s*(\S+)/m)?.[1];
		if (!image) return set("error", "The bundled compose.yml names no image.");
		if ((await deps.run(docker, ["image", "inspect", image], { env: env(), timeoutMs: 30_000 })).code !== 0) {
			set("downloading", "Downloading SearXNG (first time, about 380 MB)…");
			const pull = await deps.run(docker, ["pull", image], { env: env(), timeoutMs: 20 * 60_000 });
			if (pull.code !== 0) return set("error", `Could not download SearXNG: ${lastLine(pull.stderr)}`);
		}
		set("starting", "Starting SearXNG…");
		const { secret, configDir } = deps.prepareConfig();
		const up = await deps.run(docker, ["compose", "-f", p.join(deps.composeDir, "compose.yml"), "up", "-d"], {
			env: env({ LH_SEARXNG_SECRET: secret, LH_SEARXNG_CONFIG_DIR: configDir }),
			timeoutMs: 120_000,
		});
		if (up.code !== 0) {
			return set(
				"error",
				/port is already allocated|address already in use/i.test(up.stderr)
					? "Port 8080 is in use by another program. Close it, then retry."
					: `Could not start SearXNG: ${lastLine(up.stderr)}`,
			);
		}
		const deadline = deps.now() + HEALTH_MS;
		for (;;) {
			if (await healthy()) return set("ready", `Ready, running on this ${deps.platform === "darwin" ? "Mac" : "computer"}`);
			if (deps.now() >= deadline) break;
			await deps.sleep(1_000);
		}
		set("error", "SearXNG started but did not answer within 60 seconds. Retry, or check Docker Desktop.");
	}

	async function down() {
		const docker = findDocker();
		if (docker) await deps.run(docker, ["compose", "-p", SEARXNG_PROJECT, "down"], { env: env(), timeoutMs: 60_000 });
		set("off", "");
	}

	/** One operation at a time; the latest wish wins. */
	function sync(wanted: boolean): Promise<void> {
		desired = wanted;
		running ??= (async () => {
			try {
				while (applied !== desired) {
					const target = desired;
					try {
						await (target ? ensure() : down());
					} catch (err) {
						set("error", err instanceof Error ? err.message : String(err));
					}
					applied = target;
				}
			} finally {
				running = null;
			}
		})();
		return running;
	}

	return {
		status: (): LocalSearchStatus => status,
		sync,
		/** Re-run ensure (the Settings Retry button). */
		async retry() {
			await running;
			applied = false;
			return sync(true);
		},
	};
}

// ─── the desktop server's instance (globalThis: Next may load this module twice) ───

type LocalSearch = ReturnType<typeof createLocalSearch>;
const g = globalThis as typeof globalThis & { __lhLocalSearch?: LocalSearch | null };

function nodeDeps(composeDir: string, home: string): LocalSearchDeps {
	return {
		composeDir,
		platform: process.platform,
		userHome: os.homedir(),
		envPath: process.env.PATH ?? "",
		exists: existsSync,
		readCompose: () => readFileSync(path.join(composeDir, "compose.yml"), "utf8"),
		prepareConfig: () => {
			const configDir = path.join(home, "config");
			const secretFile = path.join(home, "secret");
			mkdirSync(configDir, { recursive: true, mode: 0o700 });
			chmodSync(home, 0o700);
			if (!existsSync(secretFile)) writeFileSync(secretFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
			copyFileSync(path.join(composeDir, "settings.yml"), path.join(configDir, "settings.yml"));
			return { secret: readFileSync(secretFile, "utf8").trim(), configDir };
		},
		run: (command, args, { env, timeoutMs }) =>
			new Promise((resolve, reject) => {
				const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: timeoutMs });
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
				child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
				child.once("error", reject);
				child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
			}),
		fetch: (url, init) => fetch(url, init),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		now: Date.now,
	};
}

function localSearch(): LocalSearch | null {
	if (g.__lhLocalSearch !== undefined) return g.__lhLocalSearch;
	const composeDir = process.env.LH_SEARXNG_DIR;
	const home = process.env.LH_SEARXNG_HOME;
	g.__lhLocalSearch = composeDir && home ? createLocalSearch(nodeDeps(composeDir, home)) : null;
	return g.__lhLocalSearch;
}

const searxngChosen = () => effectiveSettings().agent.search?.engine === "searxng";

/** Bring the container in line with the chosen engine (server boot, after
 *  every agent-settings write). `retry` re-runs a failed start. */
export function syncLocalSearch(options: { retry?: boolean } = {}): Promise<void> {
	const manager = localSearch();
	if (!manager) return Promise.resolve();
	const wanted = searxngChosen();
	return options.retry && wanted ? manager.retry() : manager.sync(wanted);
}

/** The local state for Settings — null outside the desktop server or when
 *  SearXNG is not the chosen engine. */
export function localSearchStatus(): LocalSearchStatus | null {
	const manager = localSearch();
	return manager && searxngChosen() ? manager.status() : null;
}
