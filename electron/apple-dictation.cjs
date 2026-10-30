"use strict";
const { spawn: nativeSpawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { StringDecoder } = require("node:string_decoder");
const { randomUUID } = require("node:crypto");

const MAX_LINE = 1024 * 1024;
const MAX_PENDING = 1024 * 1024;

/** A private pipe to our bundled helper; never a local HTTP transcription service. */
function createAppleDictation({ binary, platform = process.platform, systemVersion = "0", spawn = nativeSpawn, exists = existsSync, startupMs = 120000, finishMs = 20000 }) {
	const sessions = new Map();
	const epochs = new Map();
	let capabilityRead;
	let capabilityChild = null;
	let disposed = false;
	const supported = platform === "darwin" && Number(systemVersion.split(".")[0]) >= 26;
	const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"].includes(key)));
	function launch(args) { return spawn(binary, args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"] }); }
	function kill(child) {
		if (child.exitCode != null || child.signalCode != null) return;
		child.kill("SIGTERM");
		const timer = setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); }, 2000);
		timer.unref?.(); child.once("exit", () => clearTimeout(timer));
	}
	async function capabilities() {
		if (disposed) throw new Error("Apple dictation is closed.");
		if (!supported) return { available: false, locales: [], defaultLocale: null, error: "Apple dictation requires macOS 26 or later." };
		if (!exists(binary)) return { available: false, locales: [], defaultLocale: null, error: "Apple speech helper is missing. Rebuild the desktop app." };
		if (!capabilityRead) capabilityRead = new Promise((resolve, reject) => {
			const child = launch(["--capabilities"]);
			capabilityChild = child;
			const decoder = new StringDecoder("utf8");
			let output = "";
			const timer = setTimeout(() => { kill(child); reject(new Error("Apple speech availability check timed out.")); }, 20000);
			child.on("error", () => { clearTimeout(timer); reject(new Error("Could not start Apple speech.")); });
			child.stdout.on("data", data => {
				output += decoder.write(data);
				if (output.length > MAX_LINE) { kill(child); reject(new Error("Invalid Apple speech response.")); }
			});
			child.stderr.resume();
			child.once("close", code => {
				capabilityChild = null;
				output += decoder.end();
				clearTimeout(timer);
				try {
					const value = JSON.parse(output);
					if (code !== 0 || typeof value.available !== "boolean" || !Array.isArray(value.locales) || value.locales.length > 1000 || !value.locales.every(item => typeof item.id === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(item.id) && typeof item.label === "string" && item.label.length < 200) || !(value.defaultLocale === null || value.locales.some(item => item.id === value.defaultLocale))) throw new Error();
					resolve(value);
				} catch { reject(new Error("Could not read Apple speech languages.")); }
			});
		}).catch(error => { capabilityRead = undefined; throw error; });
		return capabilityRead;
	}
	function remove(session) {
		clearTimeout(session.timer);
		if (sessions.get(session.owner) === session) sessions.delete(session.owner);
		kill(session.child);
	}
	function fail(session, message) {
		if (session.ended) return;
		session.ended = true;
		const error = new Error(message);
		session.rejectReady(error); session.rejectResult(error);
		remove(session);
	}
	function cancel(owner) {
		epochs.set(owner, (epochs.get(owner) ?? 0) + 1);
		const session = sessions.get(owner);
		if (session) fail(session, "Dictation cancelled.");
	}
	async function start(owner, locale) {
		cancel(owner);
		const epoch = epochs.get(owner);
		const caps = await capabilities();
		if (epochs.get(owner) !== epoch) throw new Error("Dictation cancelled.");
		if (!caps.available) throw new Error(caps.error ?? "Apple speech is unavailable on this Mac.");
		const selected = locale === "system" ? caps.defaultLocale : locale;
		if (!caps.locales.some(item => item.id === selected)) throw new Error("This dictation language is not supported by Apple. Choose a language in Settings.");
		let resolveReady, rejectReady, resolveResult, rejectResult;
		const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
		const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
		result.catch(() => {});
		const child = launch(["--language", selected]);
		const decoder = new StringDecoder("utf8");
		const session = { owner, id: randomUUID(), child, resolveReady, rejectReady, resolveResult, rejectResult, result, ended: false, ready: false, finishing: false, writes: Promise.resolve(), pending: 0, output: "", timer: null };
		sessions.set(owner, session);
		session.timer = setTimeout(() => fail(session, "Apple speech preparation timed out. Try again after the language download finishes."), startupMs);
		child.on("error", () => fail(session, "Could not start Apple speech."));
		child.stdin.on("error", () => fail(session, "Apple speech stopped accepting audio."));
		child.stderr.resume();
		child.once("close", () => fail(session, "Apple speech stopped before completing dictation."));
		child.stdout.on("data", data => {
			if (session.ended) return;
			session.output += decoder.write(data);
			if (session.output.length > MAX_LINE) return fail(session, "Apple speech response was too large.");
			let newline;
			while (!session.ended && (newline = session.output.indexOf("\n")) >= 0) {
				const line = session.output.slice(0, newline); session.output = session.output.slice(newline + 1);
				try {
					const value = JSON.parse(line);
					if (value.type === "ready" && !session.ready) {
						session.ready = true; clearTimeout(session.timer); resolveReady({ sessionId: session.id });
					} else if (value.type === "result" && session.finishing && typeof value.text === "string") {
						session.ended = true; resolveResult(value.text); remove(session);
					} else if (value.type === "error") {
						fail(session, typeof value.message === "string" ? value.message.slice(0, 500) : "Apple speech failed.");
					} else if (value.type !== "preparing") fail(session, "Invalid Apple speech response.");
				} catch { fail(session, "Invalid Apple speech response."); }
			}
		});
		return ready;
	}
	function owned(owner, id) {
		const session = sessions.get(owner);
		if (!session || session.id !== id || session.ended || !session.ready) throw new Error("Dictation session is no longer active.");
		return session;
	}
	function write(session, packet) {
		const line = JSON.stringify(packet) + "\n";
		if (session.pending + line.length > MAX_PENDING) { fail(session, "Apple speech could not keep up with the audio."); return Promise.reject(new Error("Apple speech audio queue is full.")); }
		session.pending += line.length;
		const task = session.writes.then(() => new Promise((resolve, reject) => {
			if (session.ended) return reject(new Error("Dictation cancelled."));
			session.child.stdin.write(line, error => { if (error) reject(new Error("Apple speech stopped accepting audio.")); else resolve(); });
		})).finally(() => { session.pending -= line.length; });
		session.writes = task.catch(error => { fail(session, error.message); });
		return task;
	}
	async function append(owner, id, frame) {
		const session = owned(owner, id);
		if (session.finishing || !ArrayBuffer.isView(frame) || frame.byteLength < 2 || frame.byteLength > 8192 || frame.byteLength % 2) throw new Error("Invalid dictation audio frame.");
		await write(session, { type: "audio", data: Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString("base64") });
	}
	async function finish(owner, id) {
		const session = owned(owner, id);
		if (session.finishing) throw new Error("Dictation session is already finishing.");
		session.finishing = true;
		session.timer = setTimeout(() => fail(session, "Apple speech finalization timed out."), finishMs);
		await write(session, { type: "finish" });
		return session.result;
	}
	function dispose() { disposed = true; if (capabilityChild) kill(capabilityChild); for (const owner of new Set([...sessions.keys(), ...epochs.keys()])) cancel(owner); }
	return { capabilities, start, append, finish, cancel, dispose };
}
module.exports = { createAppleDictation };
