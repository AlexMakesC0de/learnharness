// Local SearXNG for the researcher's web_search (ops/searxng/compose.yml).
//
//   npm run search:start    create the secret + config once, start, wait until ready
//   npm run search:stop     stop and remove this Compose project's container only
//   npm run search:status   container state + a readiness probe
//
// The service listens on 127.0.0.1:8080 only. Its secret and config live
// outside the repo in $LH_SEARXNG_HOME (default ~/.config/learnharness/searxng):
// `secret` (0600, never mounted) and `config/settings.yml` (copied from
// ops/searxng/settings.yml on every start). The cache is a named volume.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const COMPOSE_FILE = path.join(ROOT, "ops", "searxng", "compose.yml");
const SETTINGS_SOURCE = path.join(ROOT, "ops", "searxng", "settings.yml");
const ENDPOINT = "http://127.0.0.1:8080";
const HOME = process.env.LH_SEARXNG_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "learnharness", "searxng");
const SECRET_FILE = path.join(HOME, "secret");
const CONFIG_DIR = path.join(HOME, "config");

function readSecret() {
	return existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, "utf8").trim() : "";
}

function ensureSecretAndConfig() {
	mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	chmodSync(HOME, 0o700);
	if (!readSecret()) writeFileSync(SECRET_FILE, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
	chmodSync(SECRET_FILE, 0o600);
	const settings = path.join(CONFIG_DIR, "settings.yml");
	copyFileSync(SETTINGS_SOURCE, settings);
	chmodSync(settings, 0o644); // mounted read-only; the container's user must read it
}

/** docker compose scoped to this project's file (its `name:` pins the project). */
function compose(args, { capture = false } = {}) {
	const result = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
		cwd: ROOT,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		env: {
			...process.env,
			LH_SEARXNG_CONFIG_DIR: CONFIG_DIR,
			// stop/status never need the real secret, only a value that satisfies interpolation.
			LH_SEARXNG_SECRET: readSecret() || "unused",
		},
	});
	if (result.error) throw new Error(`docker is not available: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(`docker compose ${args.join(" ")} failed${capture ? `: ${result.stderr.trim()}` : ""}`);
	}
	return result.stdout ?? "";
}

async function probe(pathname) {
	try {
		const resp = await fetch(`${ENDPOINT}${pathname}`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
		return { ok: resp.ok, status: resp.status, text: await resp.text() };
	} catch (err) {
		return { ok: false, status: 0, text: err instanceof Error ? err.message : String(err) };
	}
}

async function waitUntilHealthy(timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await probe("/healthz")).ok) return true;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	return false;
}

/** One real JSON search: proves the JSON format is enabled and engines answer. */
async function checkJsonSearch() {
	const { ok, status, text } = await probe("/search?q=searxng&format=json");
	if (!ok) throw new Error(`JSON search failed (${status || "unreachable"}): ${text.slice(0, 200)}`);
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`JSON search returned non-JSON: ${text.slice(0, 200)}`);
	}
	const results = Array.isArray(data?.results) ? data.results.length : 0;
	const failed = Array.isArray(data?.unresponsive_engines) ? data.unresponsive_engines.map((e) => (Array.isArray(e) ? e.join(": ") : String(e))) : [];
	return { results, failed };
}

async function start() {
	ensureSecretAndConfig();
	compose(["up", "-d", "--wait", "--wait-timeout", "60"]);
	if (!(await waitUntilHealthy())) throw new Error(`SearXNG did not become healthy at ${ENDPOINT} — see \`docker compose -f ops/searxng/compose.yml logs\``);
	const { results, failed } = await checkJsonSearch();
	console.log(`SearXNG is ready at ${ENDPOINT} (test search: ${results} results).`);
	if (failed.length) console.log(`Unresponsive upstream engines: ${failed.join("; ")}`);
	if (!results) console.log("The test search returned no results; upstream engines may be blocking requests.");
	console.log('In LearnHarness: Settings → Agent → Search engine → "SearXNG (local)".');
}

async function status() {
	const ps = compose(["ps", "--format", "{{.Name}}\t{{.State}}\t{{.Status}}\t{{.Ports}}"], { capture: true }).trim();
	console.log(ps || "SearXNG container is not running (npm run search:start).");
	const health = await probe("/healthz");
	console.log(health.ok ? `${ENDPOINT} is healthy.` : `${ENDPOINT} is not answering (${health.text.slice(0, 120)}).`);
	if (!health.ok) process.exitCode = 1;
}

const command = process.argv[2];
try {
	if (command === "start") await start();
	else if (command === "stop") compose(["down"]);
	else if (command === "status") await status();
	else {
		console.error("usage: node scripts/local-search.mjs <start|stop|status>");
		process.exitCode = 2;
	}
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
}
