import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { AgentSection } from "../components/settings/agent-section.tsx";
import type { AgentSettings } from "../src/core/index.ts";

it("keyless settings keep Research interactive and SearXNG (local) selectable without a key", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const reason = "No search engine is configured.";
	const bodies: Record<string, unknown> = {
		"/api/search": { available: false, engine: null, reason },
		"/api/keys": { keys: [{ id: "TAVILY_API_KEY", present: false }, { id: "BRAVE_API_KEY", present: false }] },
		"/api/models": { models: [], slots: { strong: null, cheap: null, vision: null } },
		"/api/settings/prompts": { prober: [], teacher: [] },
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
		// The engine menu (MenuShell) measures and animates its placement.
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		fetch: async (url: string) => {
			assert.ok(url in bodies, `unexpected request: ${url}`);
			return new Response(JSON.stringify(bodies[url]));
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	let written: AgentSettings | undefined;
	try {
		await act(async () => {
			root.render(<AgentSection
				agent={{ tools: { research: true } }}
				models={undefined}
				graph={undefined}
				compaction={undefined}
				onSectionChange={(next) => { written = next; }}
				onModelsChange={() => {}}
				onCompactionChange={() => {}}
			/>);
		});
		const row = document.querySelector<HTMLElement>('[data-testid="tool-row-research"]')!;
		const toggle = row.querySelector<HTMLButtonElement>('[data-testid="toggle-tool-research"]')!;
		assert.ok(toggle);
		assert.equal(toggle.hasAttribute("disabled"), false);
		assert.equal(toggle.getAttribute("aria-checked"), "true");
		assert.ok(!row.className.includes("opacity-40"));
		assert.ok(!row.textContent?.includes(reason), "search setup hint is no longer a research-disable hint");
		act(() => { toggle.click(); });
		assert.equal(written?.tools?.research, false, "the keyless toggle emits the same stored boolean");
		const engine = document.querySelector<HTMLButtonElement>('[data-testid="search-engine-trigger"]')!;
		assert.ok(!engine.className.includes("cursor-not-allowed"), "keyless SearXNG keeps the engine preference pickable");
		assert.ok(document.querySelector('[data-testid="search-engine-row"]')?.textContent?.includes(reason));
		act(() => { engine.click(); });
		const menu = document.querySelector<HTMLElement>('[data-testid="search-engine-menu"]')!;
		assert.ok(menu, "the menu opens without any key");
		assert.ok(menu.querySelector('[data-testid="engine-option-tavily"]')?.textContent?.includes("no key"));
		assert.ok(menu.querySelector('[data-testid="engine-option-brave"]')?.textContent?.includes("no key"));
		const local = menu.querySelector<HTMLButtonElement>('[data-testid="engine-option-searxng"]')!;
		assert.equal(local.textContent, "SearXNG (local)", "keyless: no key mark");
		act(() => { local.click(); });
		assert.deepEqual(written?.search, { engine: "searxng" });
		assert.equal(written?.tools?.research, true, "the pick keeps the rest of the stored section");
		assert.equal(document.querySelector('[data-testid="search-engine-menu"]'), null, "the pick closes the menu");
	} finally {
		act(() => { root.unmount(); });
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});
