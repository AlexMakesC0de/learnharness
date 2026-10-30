/**
 * Settings → Agent → Search engine while the app-run SearXNG starts
 * (spec: docs/superpowers/specs/2026-10-30-searxng-app-lifecycle-design.md):
 * the hint follows /api/search's `local` state, offers Download / Retry,
 * and polls while a start is in progress.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { AgentSection } from "../components/settings/agent-section.tsx";

type Local = { state: string; message: string };

async function mount(localStates: Local[]) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const requests: { url: string; method: string }[] = [];
	const intervals: { callback: () => void; delay: number; cleared: boolean }[] = [];
	let searchReads = 0;
	const bodies: Record<string, () => unknown> = {
		"/api/search": () => ({
			available: true,
			engine: "searxng",
			reason: "search engine: searxng (local, chosen)",
			local: localStates[Math.min(searchReads++, localStates.length - 1)],
		}),
		"/api/search/local": () => ({ local: { state: "checking", message: "Checking Docker…" } }),
		"/api/keys": () => ({ keys: [] }),
		"/api/models": () => ({ models: [], slots: { strong: null, cheap: null, vision: null } }),
		"/api/settings/prompts": () => ({ prober: [], teacher: [] }),
	};
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		Event: dom.window.Event,
		CustomEvent: dom.window.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		setInterval: (callback: () => void, delay: number) => {
			intervals.push({ callback, delay, cleared: false });
			return intervals.length - 1;
		},
		clearInterval: (id: number) => {
			if (intervals[id]) intervals[id]!.cleared = true;
		},
		fetch: async (url: string, init?: RequestInit) => {
			assert.ok(url in bodies, `unexpected request: ${url}`);
			requests.push({ url, method: init?.method ?? "GET" });
			return new Response(JSON.stringify(bodies[url]!()));
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	await act(async () => {
		root.render(<AgentSection
			agent={{ search: { engine: "searxng" } }}
			models={undefined}
			graph={undefined}
			compaction={undefined}
			onSectionChange={() => {}}
			onModelsChange={() => {}}
			onCompactionChange={() => {}}
		/>);
	});
	const row = () => document.querySelector<HTMLElement>('[data-testid="search-engine-row"]')!;
	const live = () => intervals.filter((i) => !i.cleared && i.delay === 2_000);
	const tick = async () => {
		await act(async () => {
			for (const i of live()) i.callback();
		});
	};
	const unmount = () => {
		act(() => { root.unmount(); });
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	return { row, requests, live, tick, unmount };
}

describe("app-run SearXNG in Settings", () => {
	it("missing Docker: says so and links the download", async () => {
		const m = await mount([{ state: "missing-docker", message: "Docker Desktop is needed for local search" }]);
		try {
			assert.ok(m.row().textContent?.includes("Docker Desktop is needed for local search"));
			const link = m.row().querySelector<HTMLAnchorElement>('[data-testid="search-local-download"]')!;
			assert.equal(link.getAttribute("href"), "https://www.docker.com/products/docker-desktop/");
			assert.equal(link.getAttribute("target"), "_blank");
			assert.equal(m.live().length, 0, "nothing to wait for");
		} finally {
			m.unmount();
		}
	});

	it("progress polls every 2 s until ready, then stops", async () => {
		const m = await mount([
			{ state: "downloading", message: "Downloading SearXNG (first time, about 380 MB)…" },
			{ state: "starting", message: "Starting SearXNG…" },
			{ state: "ready", message: "Ready, running on this Mac" },
		]);
		try {
			assert.ok(m.row().textContent?.includes("Downloading SearXNG (first time, about 380 MB)…"));
			assert.equal(m.live().length, 1);
			await m.tick();
			assert.ok(m.row().textContent?.includes("Starting SearXNG…"));
			await m.tick();
			assert.ok(m.row().textContent?.includes("Ready, running on this Mac"));
			assert.equal(m.live().length, 0, "polling stops once ready");
		} finally {
			m.unmount();
		}
	});

	it("error: Retry asks the server to start again and resumes polling", async () => {
		const m = await mount([
			{ state: "error", message: "Port 8080 is in use by another program. Close it, then retry." },
			{ state: "checking", message: "Checking Docker…" },
		]);
		try {
			assert.ok(m.row().textContent?.includes("Port 8080 is in use by another program."));
			const retry = m.row().querySelector<HTMLButtonElement>('[data-testid="search-local-retry"]')!;
			await act(async () => { retry.click(); });
			assert.ok(m.requests.some((r) => r.url === "/api/search/local" && r.method === "POST"));
			assert.ok(m.row().textContent?.includes("Checking Docker…"));
			assert.equal(m.live().length, 1);
		} finally {
			m.unmount();
		}
	});
});
