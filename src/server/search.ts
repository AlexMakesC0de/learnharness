/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): the Tavily + Brave adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when BOTH keys are present
 *    the preference order is Tavily → Brave); without a pin, whichever
 *    engine has a key is the engine.
 *  - An explicit choice does NOT silently fall back to the other engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *  - SearXNG (2026-10-30) is keyless and local (ops/searxng, loopback
 *    only): live whenever it is the explicit pin, never part of the
 *    auto order, and a stopped service reports failure instead of
 *    reaching for a paid engine.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import type { SearchEngineId, SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				// Their error body is {detail: {error: "…"}} — surface the
				// message when present, else the raw slice.
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Brave: GET https://api.search.brave.com/res/v1/web/search with the
 *  key in the X-Subscription-Token header. VERIFIED against Brave's
 *  dashboard docs, 2026-09-20: count max 20; response
 *  {web: {results: [{title, url, description, …}]}}. */
export function braveProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "brave",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`Brave search API ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (data.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** The local SearXNG service (ops/searxng; `npm run search:start`). The
 *  endpoint is FIXED to IPv4 loopback — no configurable URL, no key. */
export const SEARXNG_ENDPOINT = "http://127.0.0.1:8080";

/** A local JSON answer is a few KB per result; anything past this is not
 *  a search response worth parsing. */
const SEARXNG_MAX_BYTES = 1024 * 1024;

/** Read a body, refusing past `limit` bytes instead of buffering it all. */
async function readBounded(resp: Response, limit: number): Promise<string> {
	if (!resp.body) return "";
	const reader = resp.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new Error(`SearXNG response too large (over ${limit} bytes)`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

const SEARXNG_TIMEOUT_MS = 20_000;

function isTimeout(err: unknown): boolean {
	return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function searxngTimeout(): Error {
	return new Error(`SearXNG (local) did not answer within ${SEARXNG_TIMEOUT_MS / 1000}s — its upstream engines may be slow`);
}

/** Only web links reach the researcher (no javascript:/data:/file:). */
function isWebUrl(raw: string): boolean {
	try {
		const { protocol } = new URL(raw);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/** SearXNG snippets can carry highlight markup — plain text only. */
function plainText(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

/** SearXNG: GET {SEARXNG_ENDPOINT}/search?q=…&format=json. The JSON
 *  format must be enabled in settings.yml (403 otherwise — ops/searxng
 *  enables it). Response {results: [{title, url, content, …}],
 *  unresponsive_engines: [[engine, reason], …]}. SearXNG takes no count
 *  parameter (one page ≈ 10–30 results), so the slice happens here.
 *  Redirects are refused and the body is size-bounded. */
export function searxngProvider(fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "searxng",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("/search", SEARXNG_ENDPOINT);
			url.searchParams.set("q", query);
			url.searchParams.set("format", "json");
			let resp: Response;
			try {
				resp = await fetchFn(url.toString(), {
					headers: { accept: "application/json" },
					redirect: "error",
					signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
				});
			} catch (err) {
				if (isTimeout(err)) throw searxngTimeout();
				const detail = err instanceof Error ? err.message : String(err);
				throw new Error(
					`SearXNG (local) is not running or unreachable at ${SEARXNG_ENDPOINT} — start it with \`npm run search:start\` (${detail})`,
				);
			}
			if (!resp.ok) {
				const body = (await readBounded(resp, SEARXNG_MAX_BYTES).catch(() => "")).slice(0, 200);
				if (resp.status === 403) {
					throw new Error(`SearXNG refused the JSON API (403) — enable the json format in its settings.yml: ${body}`);
				}
				if (resp.status === 429) {
					throw new Error(`SearXNG rate limit hit (429) — its limiter should be off for a private instance: ${body}`);
				}
				throw new Error(`SearXNG ${resp.status}: ${body}`);
			}
			const text = await readBounded(resp, SEARXNG_MAX_BYTES).catch((err: unknown) => {
				throw isTimeout(err) ? searxngTimeout() : err;
			});
			let data: {
				results?: unknown;
				unresponsive_engines?: unknown;
			};
			try {
				data = JSON.parse(text) as typeof data;
			} catch {
				throw new Error(`SearXNG returned an unreadable response (not JSON): ${text.slice(0, 200)}`);
			}
			if (!Array.isArray(data.results)) {
				throw new Error("SearXNG returned an unexpected response (no results list)");
			}
			const hits = (data.results as Array<{ title?: unknown; url?: unknown; content?: unknown }>)
				.filter((r): r is { title?: unknown; url: string; content?: unknown } => typeof r?.url === "string" && isWebUrl(r.url))
				.slice(0, Math.min(count, 20))
				.map((r) => ({
					title: (typeof r.title === "string" && plainText(r.title)) || r.url,
					url: r.url,
					snippet: plainText(typeof r.content === "string" ? r.content : "").slice(0, 500),
				}));
			if (hits.length === 0 && Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length > 0) {
				const failed = (data.unresponsive_engines as unknown[])
					.slice(0, 5)
					.map((e) => (Array.isArray(e) ? e.filter((x) => typeof x === "string").join(": ") : String(e)))
					.join("; ");
				throw new Error(`SearXNG returned no results — its upstream engines failed or were blocked (${failed})`);
			}
			return hits;
		},
	};
}

/** The engines this wave ships, in PREFERENCE order (both keys present,
 *  no explicit pin → the first live engine wins; owner decision
 *  2026-09-20: Tavily first — the AI-native search API the wave chose). */
const ENGINE_ORDER: ReadonlyArray<{ id: SearchEngineId; envVar: string }> = [
	{ id: "tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", envVar: "BRAVE_API_KEY" },
];

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. */
function engineKey(id: SearchEngineId): string | null {
	const envVar = ENGINE_ORDER.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be keyed; absent pin → first
 *  keyed engine in preference order. Never throws. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
): SearchStatus & { key: string | null } {
	if (pinned === "searxng") {
		return { available: true, engine: "searxng", reason: "search engine: searxng (local, chosen)", key: null };
	}
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			return {
				available: false,
				engine: null,
				reason: `search engine is set to "${pinned}" but its API key is missing — set the ${pinned === "tavily" ? "TAVILY_API_KEY" : "BRAVE_API_KEY"} key`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	for (const { id } of ENGINE_ORDER) {
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a Tavily or Brave search API key, or choose SearXNG (local)",
		key: null,
	};
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(
		effectiveSettings().agent.search?.engine,
		{
			tavily: engineKey("tavily") ?? undefined,
			brave: engineKey("brave") ?? undefined,
		},
	);
	return { available, engine, reason };
}

/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin — Teacher stream's rewiring reads this.) */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, {
		tavily: engineKey("tavily") ?? undefined,
		brave: engineKey("brave") ?? undefined,
	});
	if (!resolved.available) return null;
	if (resolved.engine === "searxng") return searxngProvider();
	if (!resolved.key) return null;
	return resolved.engine === "tavily" ? tavilyProvider(resolved.key) : braveProvider(resolved.key);
}
