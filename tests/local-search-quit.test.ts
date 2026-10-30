/**
 * Quit-time removal of the app-run SearXNG (electron/local-search.cjs) and
 * its wiring into the shell, the package and the Compose file. Spec:
 * docs/superpowers/specs/2026-10-30-searxng-app-lifecycle-design.md.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { dockerCandidates } from "../src/server/local-search.ts";

const require = createRequire(import.meta.url);
const cleanupModule = require("../electron/local-search.cjs") as {
	createLocalSearchCleanup: (options: Record<string, unknown>) => { down(): Promise<boolean> };
	dockerCandidates: typeof dockerCandidates;
};

class Child extends EventEmitter {
	killed = false;
	kill() {
		this.killed = true;
		return true;
	}
}

function cleanup({ engine = "searxng", read, exitCode = 0 as number | null, spawnThrows = false, timeoutMs = 50 } = {} as {
	engine?: string;
	read?: () => string;
	exitCode?: number | null;
	spawnThrows?: boolean;
	timeoutMs?: number;
}) {
	const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
	const children: Child[] = [];
	const service = cleanupModule.createLocalSearchCleanup({
		settingsFile: "/data/settings.json",
		platform: "darwin",
		home: "/Users/u",
		envPath: "/usr/bin",
		exists: (file: string) => file === "/usr/local/bin/docker",
		read: read ?? (() => JSON.stringify({ version: 1, agent: { search: { engine } } })),
		spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
			if (spawnThrows) throw new Error("spawn EACCES");
			spawned.push({ command, args, env: options.env });
			const child = new Child();
			children.push(child);
			if (exitCode !== null) queueMicrotask(() => child.emit("exit", exitCode));
			return child;
		},
		timeoutMs,
	});
	return { service, spawned, children };
}

describe("createLocalSearchCleanup", () => {
	it("SearXNG chosen: removes only the learnharness-search project", async () => {
		const c = cleanup();
		assert.equal(await c.service.down(), true);
		assert.equal(c.spawned.length, 1);
		assert.equal(c.spawned[0]!.command, "/usr/local/bin/docker");
		assert.deepEqual(c.spawned[0]!.args, ["compose", "-p", "learnharness-search", "down"]);
		assert.ok(c.spawned[0]!.env.PATH!.split(":").includes("/Applications/Docker.app/Contents/Resources/bin"));
	});

	it("another engine, or unreadable settings: never touches Docker", async () => {
		for (const c of [cleanup({ engine: "tavily" }), cleanup({ read: () => { throw new Error("ENOENT"); } }), cleanup({ read: () => "{" })]) {
			assert.equal(await c.service.down(), false);
			assert.equal(c.spawned.length, 0);
		}
	});

	it("a hung docker is killed after the cap; quit still proceeds", async () => {
		const c = cleanup({ exitCode: null, timeoutMs: 20 });
		assert.equal(await c.service.down(), false);
		assert.equal(c.children[0]!.killed, true);
	});

	it("spawn failure or a non-zero exit resolves false, never rejects", async () => {
		assert.equal(await cleanup({ spawnThrows: true }).service.down(), false);
		assert.equal(await cleanup({ exitCode: 1 }).service.down(), false);
	});

	it("the shell's docker lookup mirrors the server's", () => {
		for (const [platform, home, envPath] of [
			["darwin", "/Users/u", "/a:/b"],
			["win32", "C:\\Users\\u", "C:\\bin;D:\\tools"],
			["linux", "/home/u", "/usr/bin:/opt/x"],
		] as const) {
			assert.deepEqual(cleanupModule.dockerCandidates(platform, home, envPath), dockerCandidates(platform, home, envPath));
		}
	});
});

describe("wiring", () => {
	const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");

	it("the server child learns where the bundled compose files and the secret live", () => {
		assert.match(main, /LH_SEARXNG_DIR: searxngDir\(\)/);
		assert.match(main, /LH_SEARXNG_HOME: path\.join\(app\.getPath\("userData"\), "searxng"\)/);
	});

	it("once the spawned server is up, the shell asks it to start SearXNG (authenticated, not awaited)", () => {
		const boot = main.slice(main.indexOf("await waitUntilUp(url);"), main.indexOf("} else {", main.indexOf("await waitUntilUp(url);")));
		assert.match(boot, /void fetch\(`\$\{url\}\/api\/search\/local`, \{ method: "POST", headers: \{ "x-learnharness-desktop": desktopAPISecret \} \}\)/);
	});

	it("before-quit defers once for the cleanup, after the server is gone", () => {
		const hook = main.slice(main.indexOf('app.on("before-quit"'), main.indexOf('process.on("exit", killServer)'));
		assert.ok(hook.indexOf("killServer()") < hook.indexOf("event.preventDefault()"));
		assert.match(hook, /localSearchCleaned = true;/);
		assert.match(hook, /localSearchCleanup\.down\(\)\.finally\(\(\) => app\.quit\(\)\)/);
	});

	it("the update install path removes SearXNG before quitAndInstall", () => {
		const fn = main.slice(main.indexOf("function installUpdateNow"), main.indexOf("function setupAutoUpdater"));
		assert.ok(fn.indexOf("killServer()") < fn.indexOf("localSearchCleanup.down()"));
		assert.match(fn, /localSearchCleaned = true;/);
		assert.match(fn, /localSearchCleanup\.down\(\)\.finally\(\(\) => autoUpdater\?\.quitAndInstall\(\)\)/);
	});

	it("the package ships the compose files; the container no longer restarts on its own", () => {
		const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
		assert.match(builder, /- from: ops\/searxng\n\s+to: searxng\n\s+filter:\n\s+- compose\.yml\n\s+- settings\.yml/);
		const compose = readFileSync(new URL("../ops/searxng/compose.yml", import.meta.url), "utf8");
		assert.doesNotMatch(compose, /^\s*restart:/m);
	});
});
