import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { createAppleDictation } = require("../electron/apple-dictation.cjs");

class Helper extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	packets: unknown[] = [];
	killed = false;
	stdin = new Writable({ write: (data, _encoding, callback) => {
		this.packets.push(JSON.parse(data.toString())); callback();
	} });
	kill() { this.killed = true; this.emit("exit", null, "SIGTERM"); this.emit("close", null, "SIGTERM"); return true; }
	send(value: unknown) { this.stdout.write(JSON.stringify(value) + "\n"); }
}
function fixture() {
	const helpers: Helper[] = [];
	const service = createAppleDictation({
		platform: "darwin", systemVersion: "26.6", binary: "/fixture/apple-stt", exists: () => true,
		spawn: (_binary: string, args: string[], options: { env: Record<string, string> }) => {
			assert.ok(!Object.keys(options.env).some(key => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)));
			const helper = new Helper(); helpers.push(helper);
			if (args[0] === "--capabilities") queueMicrotask(() => {
				helper.send({ available: true, locales: [{ id: "en-AU", label: "English (Australia)" }], defaultLocale: "en-AU" });
				helper.emit("exit", 0, null); helper.emit("close", 0, null);
			});
			return helper;
		},
	});
	return { service, helpers };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("owns native sessions and preserves audio-before-finish and one final result", async () => {
	const { service, helpers } = fixture();
	const starting = service.start(1, "system"); await tick();
	const helper = helpers[1]!; helper.send({ type: "ready" });
	const { sessionId } = await starting;
	await assert.rejects(service.append(2, sessionId, new Uint8Array([0, 0])), /session/i);
	await service.append(1, sessionId, new Uint8Array([0, 0, 1, 0]));
	const final = service.finish(1, sessionId); await tick();
	assert.deepEqual(helper.packets, [{ type: "audio", data: "AAABAA==" }, { type: "finish" }]);
	helper.send({ type: "result", text: "A local transcript." });
	assert.equal(await final, "A local transcript.");
	assert.ok(helper.killed);
	await assert.rejects(service.finish(1, sessionId), /session/i);
	service.dispose();
});

test("cancels pending startup and rejects late ready/result packets", async () => {
	const { service, helpers } = fixture();
	const starting = service.start(1, "en-AU"); await tick();
	const rejected = assert.rejects(starting, /cancel/i);
	service.cancel(1); await rejected;
	assert.ok(helpers[1]!.killed);
	helpers[1]!.send({ type: "ready" }); helpers[1]!.send({ type: "result", text: "late" });
	service.dispose();
});

test("rejects unsupported locales, malformed PCM, helper crashes and unexpected output", async () => {
	const { service, helpers } = fixture();
	await assert.rejects(service.start(1, "xx-XX"), /language/i);
	const starting = service.start(1, "system"); await tick();
	const helper = helpers[1]!; helper.send({ type: "ready" });
	const { sessionId } = await starting;
	await assert.rejects(service.append(1, sessionId, new Uint8Array([1])), /audio/i);
	await assert.rejects(service.append(1, sessionId, new Uint8Array(8194)), /audio/i);
	const finished = service.finish(1, sessionId); await tick();
	const rejected = assert.rejects(finished, /stopped|exited/i);
	helper.emit("exit", 1, null); helper.emit("close", 1, null); await rejected;
	service.dispose();
});

test("does not launch a helper off macOS 26 and never substitutes a cloud backend", async () => {
	for (const [platform, systemVersion] of [["win32", "26.0"], ["darwin", "15.7"]]) {
		const service = createAppleDictation({ platform, systemVersion, binary: "/fixture", exists: () => true, spawn: () => assert.fail("unsupported host must not spawn") });
		assert.equal((await service.capabilities()).available, false);
		await assert.rejects(service.start(1, "system"), /macOS 26/i);
		service.dispose();
	}
});

test("preserves Unicode split across stdout chunks", async () => {
 const {service,helpers}=fixture();const starting=service.start(1,"system");await tick();const helper=helpers[1]!;helper.send({type:"ready"});const {sessionId}=await starting;
 const final=service.finish(1,sessionId);await tick();const bytes=Buffer.from(JSON.stringify({type:"result",text:"Γεια σου κόσμε"})+"\n");
 for(const byte of bytes)helper.stdout.write(Buffer.from([byte]));assert.equal(await final,"Γεια σου κόσμε");service.dispose();
});
