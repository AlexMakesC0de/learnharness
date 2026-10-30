// Quit-time removal of the app-run SearXNG (spec: docs/superpowers/specs/
// 2026-10-30-searxng-app-lifecycle-design.md). The server starts it
// (src/server/local-search.ts); the shell removes it when the app quits,
// only if SearXNG is the saved engine — users of other engines never touch
// Docker. Capped so a stuck Docker can never hold the quit hostage.
const { spawn: nativeSpawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

const SEARXNG_PROJECT = "learnharness-search";

/** MIRRORS dockerCandidates in src/server/local-search.ts (tests pin them equal). */
function dockerCandidates(platform, userHome, envPath) {
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
	const fromPath = envPath.split(p.delimiter).filter(Boolean).map((dir) => p.join(dir, binary));
	return [...new Set([...fixed, ...fromPath])];
}

function createLocalSearchCleanup({
	settingsFile,
	platform = process.platform,
	home,
	envPath = process.env.PATH ?? "",
	exists = existsSync,
	read = (file) => readFileSync(file, "utf8"),
	spawn = nativeSpawn,
	timeoutMs = 10_000,
}) {
	function searxngChosen() {
		try {
			return JSON.parse(read(settingsFile))?.agent?.search?.engine === "searxng";
		} catch {
			return false;
		}
	}

	return {
		/** Resolves true once the container is gone; false when skipped,
		 *  failed or past the cap. Never rejects. `after` (SearXNG users only)
		 *  holds the removal until the server has stopped its docker work. */
		async down({ after } = {}) {
			if (!searxngChosen()) return false;
			await after?.catch(() => {});
			const candidates = dockerCandidates(platform, home, envPath);
			const docker = candidates.find((file) => exists(file));
			if (!docker) return false;
			const p = platform === "win32" ? path.win32 : path.posix;
			const searchPath = [...new Set(candidates.map((file) => p.dirname(file))), envPath].filter(Boolean).join(p.delimiter);
			return new Promise((resolve) => {
				let child = null;
				let settled = false;
				const finish = (ok) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(ok);
				};
				const timer = setTimeout(() => {
					try {
						child?.kill();
					} catch {
						/* already gone */
					}
					finish(false);
				}, timeoutMs);
				try {
					child = spawn(docker, ["compose", "-p", SEARXNG_PROJECT, "down"], {
						stdio: "ignore",
						windowsHide: true,
						env: { ...process.env, PATH: searchPath },
					});
				} catch {
					finish(false);
					return;
				}
				child.once("error", () => finish(false));
				child.once("exit", (code) => finish(code === 0));
			});
		},
	};
}

module.exports = { createLocalSearchCleanup, dockerCandidates, SEARXNG_PROJECT };
