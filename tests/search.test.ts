/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback) + the Tavily/Brave adapters against a STUB fetch (never the
 * network — the wire shapes are verified against the published docs, and
 * the tests pin those shapes).
 *
 * PURE + injected fetch — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSearchEngineFor, tavilyProvider, braveProvider, searxngProvider } from "../src/server/search.ts";

describe("resolveSearchEngineFor (the auto-detect decision)", () => {
	it("no keys: honestly unavailable, no default", () => {
		const out = resolveSearchEngineFor(undefined, {});
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /no search engine configured/i);
	});

	it("a key alone is enough — no engine choice needed", () => {
		const tav = resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001" });
		assert.ok(tav.available);
		assert.equal(tav.engine, "tavily");
		assert.match(tav.reason, /auto/);

		const brv = resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001" });
		assert.ok(brv.available);
		assert.equal(brv.engine, "brave");
	});

	it("both keys, no pin: preference order — Tavily first (owner decision)", () => {
		const out = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "tavily");
	});

	it("the explicit pin wins when its key is present", () => {
		const out = resolveSearchEngineFor("brave", {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "brave");
		assert.match(out.reason, /chosen/);
	});

	it("the explicit pin does NOT silently fall back to the other engine", () => {
		const out = resolveSearchEngineFor("tavily", { brave: "brave-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /tavily/);
		assert.match(out.reason, /API key is missing/);
	});
});

/** A one-shot stub fetch: asserts the request shape and returns the canned response. */
function stubFetch(canned: unknown, expect: (url: string, init: RequestInit) => void) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		expect(url, init);
		return new Response(JSON.stringify(canned), { status: 200 });
	};
}

describe("tavilyProvider (wire shape per docs.tavily.com, verified 2026-09-20)", () => {
	it("POSTs api.tavily.com/search with Bearer auth + the query body", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", stubFetch(
			{
				results: [
					{ title: "Example", url: "https://example.com/a", content: "line1\nline2" },
					{ title: "No URL", content: "dropped" },
				],
			},
			(url, init) => {
				assert.equal(url, "https://api.tavily.com/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer tvly-throwaway-key-00001");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.max_results, 5);
				// The legacy api_key-in-body form is retired — auth is the header.
				assert.equal(body.api_key, undefined);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/a", snippet: "line1 line2" }]);
	});

	it("maps the {detail:{error}} error body into the message", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", async () =>
			new Response(JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key." } }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), /Tavily search API 401: Unauthorized/);
	});
});

describe("braveProvider (wire shape per Brave's dashboard docs, verified 2026-09-20)", () => {
	it("GETs res/v1/web/search with the X-Subscription-Token header", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", stubFetch(
			{
				web: {
					results: [
						{ title: "Example", url: "https://example.com/b", description: "a description" },
						{ description: "dropped — no url" },
					],
				},
			},
			(url, init) => {
				assert.ok(url.startsWith("https://api.search.brave.com/res/v1/web/search?"), url);
				assert.ok(url.includes("q=test+query"), url); // URLSearchParams: spaces as +
				assert.ok(url.includes("count=5"));
				const headers = init.headers as Record<string, string>;
				assert.equal(headers["x-subscription-token"], "brave-throwaway-key-00001");
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/b", snippet: "a description" }]);
	});

	it("surfaces the HTTP status on failure", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", async () =>
			new Response("rate limited", { status: 429 }),
		);
		await assert.rejects(provider.search("q", 5), /Brave search API 429/);
	});
});

describe("searxngProvider (local SearXNG JSON API, ops/searxng)", () => {
	it("an explicit pin is live without any key; automatic precedence stays Tavily → Brave", () => {
		const local = resolveSearchEngineFor("searxng", { tavily: "paid-key" });
		assert.equal(local.engine, "searxng");
		assert.equal(local.available, true);
		assert.equal(local.key, null);
		assert.equal(resolveSearchEngineFor(undefined, { tavily: "paid-key", brave: "other-key" }).engine, "tavily");
		assert.equal(resolveSearchEngineFor(undefined, {}).available, false, "never auto-selected");
		assert.equal(resolveSearchEngineFor("brave", {}).available, false);
	});

	it("queries only loopback JSON search, normalizes results and honors count without any auth header", async () => {
		const provider = searxngProvider(async (url, init) => {
			const parsed = new URL(url);
			assert.equal(parsed.origin, "http://127.0.0.1:8080");
			assert.equal(parsed.pathname, "/search");
			assert.equal(parsed.searchParams.get("q"), "test query");
			assert.equal(parsed.searchParams.get("format"), "json");
			assert.equal(init.redirect, "error");
			assert.equal(new Headers(init.headers).has("authorization"), false);
			return Response.json({
				results: [
					{ title: "Unsafe", url: "javascript:alert(1)", content: "bad" },
					{ title: "Example", url: "https://example.com/", content: "Some <b>useful</b> text &amp; more." },
					{ url: "https://example.org/", content: "Next" },
				],
			});
		});
		assert.deepEqual(await provider.search("test query", 1), [
			{ title: "Example", url: "https://example.com/", snippet: "Some useful text & more." },
		]);
		assert.deepEqual((await provider.search("test query", 5)).map((h) => h.title), ["Example", "https://example.org/"]);
	});

	it("reports stopped services, JSON refusals, rate limits and engine failures — one local call, nothing else", async () => {
		const expected: Record<number, RegExp> = { 403: /JSON/, 429: /limit/, 500: /SearXNG 500/ };
		for (const [status, pattern] of Object.entries(expected)) {
			let calls = 0;
			const provider = searxngProvider(async (url) => {
				calls++;
				assert.ok(url.startsWith("http://127.0.0.1:8080/search?"));
				return new Response("failure", { status: Number(status) });
			});
			await assert.rejects(provider.search("q", 5), pattern);
			assert.equal(calls, 1);
		}
		await assert.rejects(
			searxngProvider(async () => {
				throw new TypeError("fetch failed");
			}).search("q", 5),
			/not running or unreachable.*search:start/,
		);
		await assert.rejects(
			searxngProvider(async () => {
				throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
			}).search("q", 5),
			/did not answer within 20s/,
		);
		await assert.rejects(searxngProvider(async () => Response.json({ unexpected: true })).search("q", 5), /unexpected response/);
		await assert.rejects(searxngProvider(async () => new Response("<html>")).search("q", 5), /not JSON/);
		await assert.rejects(
			searxngProvider(async () => Response.json({ results: [], unresponsive_engines: [["google", "blocked"]] })).search("q", 5),
			/upstream engines failed.*google: blocked/,
		);
		assert.deepEqual(await searxngProvider(async () => Response.json({ results: [] })).search("q", 5), []);
	});

	it("rejects oversized bodies rather than buffering an unbounded local response", async () => {
		const provider = searxngProvider(async () => new Response("x".repeat(1024 * 1024 + 1)));
		await assert.rejects(provider.search("q", 5), /too large/);
	});
});
