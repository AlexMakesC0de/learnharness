/**
 * The app-run SearXNG manager (spec: docs/superpowers/specs/
 * 2026-10-30-searxng-app-lifecycle-design.md). Docker, the clock and the
 * health probe are scripted — no process is spawned, nothing waits.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createLocalSearch,
	dockerCandidates,
	localSearchStatus,
	syncLocalSearch,
	type LocalSearchDeps,
	type LocalSearchState,
} from "../src/server/local-search.ts";

type Result = { code: number; stdout: string; stderr: string };
const result = (code: number, stderr = ""): Result => ({ code, stdout: "", stderr });

function harness({
	platform = "darwin" as NodeJS.Platform,
	docker = true,
	daemon = (_clock: number, _opened: boolean) => true,
	image = true,
	pull = result(0),
	up = result(0),
	healthy = (_clock: number) => true,
} = {}) {
	let clock = 0;
	let opened = false;
	const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
	const states: LocalSearchState[] = [];
	const deps: LocalSearchDeps = {
		composeDir: "/res/searxng",
		platform,
		userHome: "/Users/u",
		envPath: "/usr/bin",
		exists: (file) => docker && file === "/usr/local/bin/docker",
		readCompose: () => "services:\n  searxng:\n    image: ghcr.io/searxng/searxng@sha256:abc\n",
		prepareConfig: () => ({ secret: "s3cret", configDir: "/home/searxng/config" }),
		run: async (command, args, { env }) => {
			calls.push({ command, args, env });
			if (command === "/usr/bin/open") {
				opened = true;
				return result(0);
			}
			if (args[0] === "info") return result(daemon(clock, opened) ? 0 : 1, "Cannot connect to the Docker daemon");
			if (args[0] === "image") return result(image ? 0 : 1);
			if (args[0] === "pull") return pull;
			if (args[0] === "compose" && args.includes("up")) return up;
			return result(0);
		},
		fetch: async (url) => {
			assert.equal(url, "http://127.0.0.1:8080/healthz");
			if (healthy(clock)) return new Response("OK");
			throw new TypeError("fetch failed");
		},
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
		onChange: (status) => states.push(status.state),
	};
	const manager = createLocalSearch(deps);
	const dockerArgs = () => calls.filter((c) => c.command === "/usr/local/bin/docker").map((c) => c.args.join(" "));
	return { manager, calls, states, dockerArgs };
}

describe("createLocalSearch — ensure", () => {
	it("no Docker installed: missing-docker, nothing run", async () => {
		const h = harness({ docker: false });
		await h.manager.sync(true);
		assert.equal(h.manager.status().state, "missing-docker");
		assert.match(h.manager.status().message, /Docker Desktop is needed/);
		assert.deepEqual(h.calls, []);
	});

	it("Docker running, image present: starts the bundled compose project and waits for health", async () => {
		const h = harness();
		await h.manager.sync(true);
		assert.deepEqual(h.manager.status(), { state: "ready", message: "Ready, running on this Mac" });
		assert.deepEqual(h.dockerArgs(), [
			"info --format {{.ServerVersion}}",
			"image inspect ghcr.io/searxng/searxng@sha256:abc",
			"compose -f /res/searxng/compose.yml up -d",
		]);
		const up = h.calls.at(-1)!;
		assert.equal(up.env.LH_SEARXNG_SECRET, "s3cret");
		assert.equal(up.env.LH_SEARXNG_CONFIG_DIR, "/home/searxng/config");
		assert.ok(up.env.PATH!.split(":").includes("/Applications/Docker.app/Contents/Resources/bin"), "credential helpers reachable");
		assert.deepEqual(h.states, ["checking", "starting", "ready"]);
	});

	it("Docker installed but closed: opens Docker Desktop in the background and waits for it", async () => {
		const h = harness({ daemon: (clock, opened) => opened && clock >= 6_000 });
		await h.manager.sync(true);
		assert.equal(h.manager.status().state, "ready");
		assert.ok(h.calls.some((c) => c.command === "/usr/bin/open" && c.args.join(" ") === "-g -a Docker"));
		assert.deepEqual(h.states, ["checking", "starting-docker", "starting", "ready"]);
	});

	it("Docker Desktop never comes up: error after 2 minutes", async () => {
		const h = harness({ daemon: () => false });
		await h.manager.sync(true);
		assert.equal(h.manager.status().state, "error");
		assert.match(h.manager.status().message, /did not start within 2 minutes/);
		assert.ok(!h.dockerArgs().some((a) => a.startsWith("compose")));
	});

	it("Linux with the daemon down: says how to start it, never tries to open an app", async () => {
		const h = harness({ platform: "linux", daemon: () => false });
		await h.manager.sync(true);
		assert.equal(h.manager.status().state, "error");
		assert.match(h.manager.status().message, /systemctl start docker/);
		assert.ok(!h.calls.some((c) => c.command === "/usr/bin/open"));
		assert.equal(h.dockerArgs().filter((a) => a.startsWith("info")).length, 1);
	});

	it("first use downloads the pinned image; a failed download is reported", async () => {
		const h = harness({ image: false });
		await h.manager.sync(true);
		assert.equal(h.manager.status().state, "ready");
		assert.ok(h.dockerArgs().includes("pull ghcr.io/searxng/searxng@sha256:abc"));
		assert.ok(h.states.includes("downloading"));

		const failed = harness({ image: false, pull: result(1, "pulling…\nError response from daemon: denied\n") });
		await failed.manager.sync(true);
		assert.deepEqual(failed.manager.status(), {
			state: "error",
			message: "Could not download SearXNG: Error response from daemon: denied",
		});
	});

	it("port 8080 taken: says so plainly", async () => {
		const h = harness({
			up: result(1, " Container x Starting\nError response from daemon: Bind for 127.0.0.1:8080 failed: port is already allocated\n"),
		});
		await h.manager.sync(true);
		assert.deepEqual(h.manager.status(), {
			state: "error",
			message: "Port 8080 is in use by another program. Close it, then retry.",
		});
	});

	it("other compose failures surface their last stderr line", async () => {
		const h = harness({ up: result(1, " Network x Creating\nno space left on device\n") });
		await h.manager.sync(true);
		assert.equal(h.manager.status().message, "Could not start SearXNG: no space left on device");
	});

	it("never healthy: error after 60 seconds", async () => {
		const h = harness({ healthy: () => false });
		await h.manager.sync(true);
		assert.equal(h.manager.status().state, "error");
		assert.match(h.manager.status().message, /did not answer within 60 seconds/);
	});

	it("a thrown runner error becomes an error state, not a rejection", async () => {
		const manager = createLocalSearch({
			composeDir: "/res/searxng",
			platform: "darwin",
			userHome: "/Users/u",
			envPath: "",
			exists: () => true,
			readCompose: () => "image: x\n",
			prepareConfig: () => ({ secret: "s", configDir: "/c" }),
			run: async () => {
				throw new Error("spawn EACCES");
			},
			fetch: async () => new Response("OK"),
			sleep: async () => {},
			now: () => 0,
		});
		await manager.sync(true);
		assert.deepEqual(manager.status(), { state: "error", message: "spawn EACCES" });
	});
});

describe("createLocalSearch — sync", () => {
	it("a fresh manager told 'not wanted' never touches Docker", async () => {
		const h = harness();
		await h.manager.sync(false);
		assert.deepEqual(h.calls, []);
		assert.equal(h.manager.status().state, "off");
	});

	it("switching away removes only this compose project", async () => {
		const h = harness();
		await h.manager.sync(true);
		await h.manager.sync(false);
		assert.equal(h.dockerArgs().at(-1), "compose -p learnharness-search down");
		assert.deepEqual(h.manager.status(), { state: "off", message: "" });
	});

	it("overlapping syncs run one ensure; the latest wish wins", async () => {
		const h = harness();
		await Promise.all([h.manager.sync(true), h.manager.sync(true)]);
		assert.equal(h.dockerArgs().filter((a) => a.includes("up -d")).length, 1);

		const flip = harness();
		await Promise.all([flip.manager.sync(true), flip.manager.sync(false)]);
		assert.equal(flip.dockerArgs().at(-1), "compose -p learnharness-search down");
		assert.equal(flip.manager.status().state, "off");
	});

	it("retry re-runs ensure after an error", async () => {
		let healthy = false;
		const h = harness({ healthy: () => healthy });
		await h.manager.sync(true);
		assert.equal(h.manager.status().state, "error");
		healthy = true;
		await h.manager.retry();
		assert.equal(h.manager.status().state, "ready");
	});
});

describe("dockerCandidates", () => {
	it("macOS: the standard install paths, then PATH", () => {
		assert.deepEqual(dockerCandidates("darwin", "/Users/u", "/a:/b"), [
			"/usr/local/bin/docker",
			"/opt/homebrew/bin/docker",
			"/Applications/Docker.app/Contents/Resources/bin/docker",
			"/Users/u/.docker/bin/docker",
			"/a/docker",
			"/b/docker",
		]);
	});

	it("Windows and Linux", () => {
		assert.deepEqual(dockerCandidates("win32", "C:\\Users\\u", "C:\\bin"), [
			"C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
			"C:\\bin\\docker.exe",
		]);
		assert.deepEqual(dockerCandidates("linux", "/home/u", ""), ["/usr/bin/docker", "/usr/local/bin/docker", "/snap/bin/docker"]);
	});
});

describe("module entry points outside the desktop server", () => {
	it("without LH_SEARXNG_DIR the manager is inert", async () => {
		assert.equal(process.env.LH_SEARXNG_DIR, undefined);
		await syncLocalSearch();
		await syncLocalSearch({ retry: true });
		assert.equal(localSearchStatus(), null);
	});
});
