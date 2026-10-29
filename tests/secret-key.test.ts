/**
 * electron/secret-key.cjs: the desktop app's safeStorage-wrapped data key.
 * A fake safeStorage stands in for DPAPI/Keychain; each fake "profile" can
 * only unwrap what it wrapped, like a reset Windows profile or a denied
 * Keychain item.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { loadSecretsKey } = require("../electron/secret-key.cjs");
const { KEY_FILE, isSealed, openText, sealText, useKey } = require("../electron/secret-box.cjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-secret-key-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let dirs = 0;
const freshDir = () => fs.mkdirSync(path.join(TMP, String(++dirs)), { recursive: true }) as string;

/** A fake safeStorage bound to one OS profile. */
function fakeSafeStorage(profile: string, available = true) {
	let calls = 0;
	return {
		get calls() { return calls; },
		isEncryptionAvailable: () => available,
		encryptString(text: string) {
			calls++;
			return Buffer.from(`${profile}:${text}`);
		},
		decryptString(data: Buffer) {
			calls++;
			const text = data.toString();
			if (!text.startsWith(`${profile}:`)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
			return text.slice(profile.length + 1);
		},
	};
}

/** Seal `text` into `file` with `key`, as the stores do. */
function sealWith(key: Buffer, file: string, text: string): void {
	useKey(key);
	try { fs.writeFileSync(file, sealText(file, text)); } finally { useKey(null); }
}

describe("loadSecretsKey", () => {
	it("creates one wrapped key file and reuses it on the next start", () => {
		const directory = freshDir();
		const safeStorage = fakeSafeStorage("alice");
		const first = loadSecretsKey({ directory, safeStorage, platform: "win32" });
		assert.equal(first.length, 32);
		const stored = JSON.parse(fs.readFileSync(path.join(directory, KEY_FILE), "utf8"));
		assert.equal(stored.lhSecretsKey, 1);
		assert.equal(typeof stored.safeStorage, "string");
		assert(!fs.readFileSync(path.join(directory, KEY_FILE), "utf8").includes(first.toString("base64")), "the key is never stored unwrapped");
		assert.deepEqual(fs.readdirSync(directory), [KEY_FILE], "no temp files left");
		assert.deepEqual(loadSecretsKey({ directory, safeStorage, platform: "darwin" }), first);
	});

	it("Linux and an unavailable OS store give no key and write nothing", () => {
		const directory = freshDir();
		const lines: string[] = [];
		assert.equal(loadSecretsKey({ directory, safeStorage: fakeSafeStorage("alice"), platform: "linux" }), null);
		assert.equal(loadSecretsKey({ directory, safeStorage: fakeSafeStorage("alice", false), platform: "win32", log: (l: string) => lines.push(l) }), null);
		assert.deepEqual(fs.readdirSync(directory), []);
		assert.match(lines.join("\n"), /unavailable/);
	});

	it("a key file another profile wrapped is moved aside with the sealed credentials, never deleted", () => {
		const directory = freshDir();
		const oldKey = loadSecretsKey({ directory, safeStorage: fakeSafeStorage("old-profile"), platform: "win32" });
		const sealed = path.join(directory, "chatgpt-credentials.json");
		const plain = path.join(directory, "xai-credentials.json");
		const absent = path.join(directory, "github-copilot-credentials.json");
		sealWith(oldKey, sealed, "{\"version\":1}");
		fs.writeFileSync(plain, "{\"version\":1,\"allowBackgroundUse\":true}");
		const oldSealedBytes = fs.readFileSync(sealed, "utf8");

		const lines: string[] = [];
		const newKey = loadSecretsKey({ directory, safeStorage: fakeSafeStorage("new-profile"), sealedFiles: [sealed, plain, absent], platform: "win32", log: (l: string) => lines.push(l) });
		assert.equal(newKey.length, 32);
		assert.notDeepEqual(newKey, oldKey);

		const names = fs.readdirSync(directory).sort();
		const asideKey = names.find((n) => n.startsWith(`${KEY_FILE}.unreadable-`));
		const asideCreds = names.find((n) => n.startsWith("chatgpt-credentials.json.unreadable-"));
		assert(asideKey && asideCreds, names.join(", "));
		assert.equal(fs.readFileSync(path.join(directory, asideCreds), "utf8"), oldSealedBytes, "kept byte for byte");
		assert(!fs.existsSync(sealed));
		assert(fs.existsSync(plain), "plaintext credentials stay readable and in place");
		assert(!fs.existsSync(absent));
		assert.match(lines.join("\n"), /1 sealed credential file/);
		// The new key is the one now stored.
		assert.deepEqual(loadSecretsKey({ directory, safeStorage: fakeSafeStorage("new-profile"), platform: "win32" }), newKey);
	});

	it("a damaged key file is replaced the same way", () => {
		const directory = freshDir();
		fs.writeFileSync(path.join(directory, KEY_FILE), "{not json");
		const key = loadSecretsKey({ directory, safeStorage: fakeSafeStorage("alice"), platform: "darwin" });
		assert.equal(key.length, 32);
		assert(fs.readdirSync(directory).some((n) => n.startsWith(`${KEY_FILE}.unreadable-`)));
	});

	it("the loaded key seals and opens through secret-box in this process", () => {
		const directory = freshDir();
		const key = loadSecretsKey({ directory, safeStorage: fakeSafeStorage("alice"), platform: "win32" });
		const file = path.join(directory, "auth.json");
		sealWith(key, file, "{\"OPENROUTER_API_KEY\":\"sk-or-v1-secret\"}");
		const raw = fs.readFileSync(file, "utf8");
		assert(isSealed(raw));
		assert(!raw.includes("sk-or-v1-secret"));
		useKey(key);
		try { assert.equal(openText(file, raw), "{\"OPENROUTER_API_KEY\":\"sk-or-v1-secret\"}"); } finally { useKey(null); }
		// The server child gets the same key as LH_SECRETS_KEY.
		const saved = process.env.LH_SECRETS_KEY;
		process.env.LH_SECRETS_KEY = key.toString("base64");
		try { assert.equal(openText(file, raw), "{\"OPENROUTER_API_KEY\":\"sk-or-v1-secret\"}"); } finally {
			if (saved === undefined) delete process.env.LH_SECRETS_KEY;
			else process.env.LH_SECRETS_KEY = saved;
		}
	});
});
