"use strict";
/**
 * Secrets at rest: an AES-256-GCM envelope for the owner-only secret files
 * (auth.json, chatgpt/github-copilot/xai-credentials.json). File mode 0600
 * protects them on macOS and Linux; on Windows Node's chmod only toggles the
 * read-only bit, so there the files are encrypted with a per-install data
 * key that Windows DPAPI binds to the current user. The desktop app does the
 * same on Windows and macOS with a key from Electron safeStorage
 * (secret-key.cjs).
 *
 * Key source, first match wins:
 *   1. LH_SECRETS_KEY (base64, 32 bytes): an explicit key from the host.
 *      The desktop app passes its safeStorage key to its server this way.
 *   2. useKey(): the desktop main process's own safeStorage key, held in
 *      memory only.
 *   3. Windows, outside the Electron shell: secrets.key beside the secret
 *      file, the data key wrapped with DPAPI (CurrentUser), created on the
 *      first write. Unwrapped once per process and cached.
 *   4. Otherwise none: files stay plaintext JSON and 0600 does the job.
 *
 * Plaintext files are always accepted on read, so existing files and
 * hand-edits keep working; the next write seals them. A sealed file that
 * cannot be opened (missing or foreign key, tampered bytes) throws
 * code "unreadable"; callers decide how to keep it, never overwrite it.
 *
 * CommonJS so the Electron main process and the Next server share one
 * implementation (same as chatgpt.cjs). Synchronous because the auth.json
 * store is.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const KEY_FILE = "secrets.key";
const ENVELOPE = 1;
const AAD = Buffer.from("lhSecretBox:1");
const fail = (code) => Object.assign(new Error(code), { code });

// The desktop main process's key (useKey); never copied into process.env, so
// children spawned by main get it only where main passes it explicitly.
let processKey = null;

/** Main process only: use `key` (32 bytes) for this process, or null for none. */
function useKey(key) {
	if (key !== null && (!Buffer.isBuffer(key) || key.length !== 32)) throw fail("bad-key");
	processKey = key;
}

/** Which key source applies in this process: "env", "process", "dpapi" or null. */
function keySource(env = process.env, platform = process.platform) {
	if (env.LH_SECRETS_KEY) return "env";
	if (processKey !== null) return "process";
	// The desktop app's processes get their key from safeStorage via main
	// (secret-key.cjs), never from DPAPI here.
	if (platform === "win32" && !process.versions.electron && env.LH_DESKTOP_SERVER !== "1") return "dpapi";
	return null;
}

/** DPAPI through Windows PowerShell 5.1 (always present on Windows). Data
 *  travels on stdin, never argv; `op` is a fixed method name. */
function dpapi(op, input) {
	const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const script = "Add-Type -AssemblyName System.Security;"
		+ "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());"
		+ `$o=[Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser');`
		+ "[Console]::Out.Write([Convert]::ToBase64String($o))";
	const result = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", script], {
		input: input.toString("base64"), encoding: "utf8", windowsHide: true, timeout: 30_000,
	});
	if (result.status !== 0 || !result.stdout) throw fail("dpapi");
	return Buffer.from(result.stdout.trim(), "base64");
}

const cache = new Map();

/** The 32-byte data key for secret files in `dir`, or null when no key
 *  source applies. `create` makes the DPAPI key file if it is missing. */
function dataKey(dir, create) {
	const source = keySource();
	if (source === null) return null;
	if (source === "env") {
		const key = Buffer.from(process.env.LH_SECRETS_KEY, "base64");
		if (key.length !== 32) throw fail("bad-key");
		return key;
	}
	if (source === "process") return processKey;
	const file = path.join(dir, KEY_FILE);
	const cached = cache.get(file);
	if (cached) return cached;
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw fail("unreadable");
		if (!create) return null;
		return createKey(file);
	}
	let wrapped;
	try {
		const parsed = JSON.parse(raw);
		if (parsed.lhSecretsKey !== 1 || typeof parsed.dpapi !== "string") throw fail("unreadable");
		wrapped = Buffer.from(parsed.dpapi, "base64");
	} catch {
		throw fail("unreadable");
	}
	let key;
	try { key = dpapi("Unprotect", wrapped); } catch { throw fail("unreadable"); }
	if (key.length !== 32) throw fail("unreadable");
	cache.set(file, key);
	return key;
}

/** Create the key file exactly once: a hard link from a complete temp file
 *  fails if another process won the race, and then its key is used. */
function createKey(file) {
	const key = crypto.randomBytes(32);
	const body = `${JSON.stringify({ lhSecretsKey: 1, dpapi: dpapi("Protect", key).toString("base64") })}\n`;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(temp, body, { mode: 0o600, flag: "wx" });
	try {
		fs.linkSync(temp, file);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		return dataKey(path.dirname(file), false);
	} finally {
		fs.rmSync(temp, { force: true });
	}
	cache.set(file, key);
	return key;
}

function parseEnvelope(raw) {
	if (typeof raw !== "string" || !raw.trimStart().startsWith("{\"lhSecretBox\"")) return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed && parsed.lhSecretBox === ENVELOPE ? parsed : null;
	} catch {
		return null;
	}
}

/** True when `raw` (file contents) is a sealed envelope. */
function isSealed(raw) {
	return parseEnvelope(raw) !== null;
}

/** The text to write to `file`: sealed when a key source applies,
 *  otherwise `text` unchanged. Throws rather than fall back to plaintext. */
function sealText(file, text) {
	const key = dataKey(path.dirname(file), true);
	if (key === null) return text;
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(AAD);
	const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
	return JSON.stringify({
		lhSecretBox: ENVELOPE,
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		data: data.toString("base64"),
	});
}

/** The plaintext of `raw` read from `file`. Plaintext passes through;
 *  a sealed envelope that cannot be opened throws code "unreadable". */
function openText(file, raw) {
	const envelope = parseEnvelope(raw);
	if (envelope === null) return raw;
	let key;
	try { key = dataKey(path.dirname(file), false); } catch { throw fail("unreadable"); }
	if (key === null) throw fail("unreadable");
	try {
		const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
		decipher.setAAD(AAD);
		decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
		return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
	} catch {
		throw fail("unreadable");
	}
}

module.exports = { KEY_FILE, keySource, useKey, isSealed, sealText, openText };
