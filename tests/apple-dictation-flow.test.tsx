import React, { act } from "react";
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
let teardown: (() => Promise<void>) | undefined;
afterEach(async () => { await teardown?.(); teardown = undefined; });
async function fixture(options: {
	read?: Promise<Response>;
	pendingMic?: boolean;
} = {}) {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const started = deferred<{
		sessionId: string;
	}>(), final = deferred<string>();
	const state = { appends: [] as string[], frames: [] as number[][], starts: [] as string[], finishes: 0, cancels: 0, tracksStopped: 0, micRequests: 0 };
	const microphone = deferred<{
		getTracks: () => {
			stop: () => void;
		}[];
	}>();
	const bridge = { capabilities: async () => ({ available: true, locales: [{ id: "en-AU", label: "English" }], defaultLocale: "en-AU" }),
		start: (locale: string) => { state.starts.push(locale); return started.promise; }, append: async (_id: string, frame: Uint8Array) => { state.frames.push([...frame]); },
		finish: async () => { state.finishes++; return final.promise; }, cancel: async () => { state.cancels++; } };
	Object.assign(window, { lh: { platform: "darwin", appleDictation: bridge, expandWindow() { } } });
	let worklet!: {
		port: {
			onmessage?: (event: {
				data: unknown;
			}) => void;
			postMessage: (message: {
				type: string;
			}) => void;
		};
	};
	class Worklet {
		port = { onmessage: undefined as ((event: {
				data: unknown;
			}) => void) | undefined, postMessage: (message: {
				type: string;
			}) => { if (message.type === "flush")
				queueMicrotask(() => { this.port.onmessage?.({ data: { type: "audio", buffer: new Int16Array([3]) } }); this.port.onmessage?.({ data: { type: "flushed" } }); }); } };
		constructor() { worklet = this; }
		connect() { }
		disconnect() { }
	}
	class Graph {
		state = "running";
		destination = {};
		audioWorklet = { addModule: async () => { } };
		createMediaStreamSource() { return { connect() { }, disconnect() { } }; }
	}
	const values = { React, window, document, Event: window.Event, CustomEvent: window.CustomEvent, Element: window.Element, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, AudioContext: Graph, AudioWorkletNode: Worklet,
		navigator: { userAgent: "Electron", mediaDevices: { getUserMedia: async () => { state.micRequests++; return options.pendingMic ? microphone.promise : { getTracks: () => [{ stop() { state.tracksStopped++; } }] }; } } },
		fetch: async (url: unknown) => { assert.equal(url, "/api/settings", "Apple dictation must not mint a cloud token"); return options.read ?? Response.json({ settings: { version: 1, dictation: { language: "pl", appleLocale: "en-AU" } } }); } };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	let dictation!: Dictation;
	function Harness() { dictation = useDictation({ append: text => state.appends.push(text) }); return null; }
	await act(async () => { root.render(<Harness />); });
	await act(async () => { notifySettingsSaved("dictation"); });
	teardown = async () => { await act(async () => root.unmount()); for (const [key, value] of previous) {
		if (value)
			Object.defineProperty(globalThis, key, value);
		else
			delete (globalThis as Record<string, unknown>)[key];
	} };
	return { state, started, final, microphone, get dictation() { return dictation; }, frame: () => worklet.port.onmessage?.({ data: { type: "audio", buffer: new Int16Array([1, 2]) } }) };
}
test("Mac uses Apple without a cloud key and drains the final partial frame before one transcript append", async () => {
	const f = await fixture();
	await act(async () => f.dictation.toggle());
	assert.deepEqual(f.state.starts, ["en-AU"]);
	await act(async () => { f.started.resolve({ sessionId: "fixture" }); });
	assert.equal(f.dictation.phase, "recording");
	await act(async () => f.frame());
	await act(async () => f.dictation.stop());
	assert.equal(f.dictation.phase, "stopping");
	assert.deepEqual(f.state.appends, []);
	assert.deepEqual(f.state.frames, [[1, 0, 2, 0], [3, 0]]);
	assert.equal(f.state.finishes, 1);
	await act(async () => f.final.resolve("Apple speech works."));
	assert.deepEqual(f.state.appends, ["Apple speech works."]);
	assert.equal(f.dictation.phase, "idle");
});
test("stop during native preparation preserves buffered audio and finalizes after ready", async () => {
	const f = await fixture();
	await act(async () => f.dictation.toggle());
	await act(async () => f.frame());
	await act(async () => f.dictation.stop());
	assert.equal(f.dictation.phase, "stopping");
	await act(async () => f.started.resolve({ sessionId: "fixture" }));
	assert.equal(f.state.finishes, 1);
	await act(async () => f.final.resolve("Prepared speech."));
	assert.deepEqual(f.state.appends, ["Prepared speech."]);
});
test("cancel during startup discards buffered speech and ignores late native readiness", async () => {
	const f = await fixture();
	await act(async () => f.dictation.toggle());
	await act(async () => f.frame());
	await act(async () => f.dictation.cancel());
	await act(async () => f.started.resolve({ sessionId: "fixture" }));
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.finishes, 0);
	assert.deepEqual(f.state.appends, []);
	assert.ok(f.state.cancels > 0);
});
test("cancel during finalization discards a late final transcript", async () => {
	const f = await fixture();
	await act(async () => f.dictation.toggle());
	await act(async () => f.started.resolve({ sessionId: "fixture" }));
	await act(async () => f.dictation.stop());
	await act(async () => f.dictation.cancel());
	await act(async () => f.final.resolve("Discard me."));
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.dictation.phase, "idle");
});
test("stop before settings load never starts native speech or requests the microphone", async () => {
	const read = deferred<Response>();
	const f = await fixture({ read: read.promise });
	await act(async () => f.dictation.toggle());
	await act(async () => f.dictation.stop());
	assert.equal(f.dictation.phase, "idle");
	await act(async () => read.resolve(Response.json({ settings: { version: 1 } })));
	assert.deepEqual(f.state.starts, []);
	assert.equal(f.state.micRequests, 0);
});
test("native startup failure is shown even while microphone permission remains pending", async () => {
	const f = await fixture({ pendingMic: true });
	await act(async () => f.dictation.toggle());
	await act(async () => f.started.reject(new Error("Apple speech failed to prepare.")));
	assert.equal(f.dictation.phase, "idle");
	assert.match(f.dictation.error!, /failed to prepare/);
	await act(async () => f.microphone.resolve({ getTracks: () => [{ stop() { f.state.tracksStopped++; } }] }));
	assert.equal(f.state.tracksStopped, 1);
});
test("stop while microphone permission is pending completes immediately even if Apple is ready", async () => {
	const f = await fixture({ pendingMic: true });
	await act(async () => f.dictation.toggle());
	await act(async () => f.started.resolve({ sessionId: "fixture" }));
	await act(async () => f.dictation.stop());
	assert.equal(f.dictation.phase, "idle");
	await f.dictation.finish();
	assert.equal(f.state.finishes, 0);
	await act(async () => f.microphone.resolve({ getTracks: () => [{ stop() { f.state.tracksStopped++; } }] }));
	assert.equal(f.state.tracksStopped, 1);
	assert.deepEqual(f.state.appends, []);
});
