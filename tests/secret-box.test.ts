/**
 * electron/secret-box.cjs: the at-rest envelope for owner-only secret
 * files. Pins the key-source rule, the envelope round trip, tamper and
 * wrong-key detection, plaintext pass-through, and (Windows only) the real
 * DPAPI key file: created once, reused by a separate process.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const BOX = path.resolve("electron/secret-box.cjs");
const { KEY_FILE, keySource, isSealed, sealText, openText } = require(BOX);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-secret-box-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** Run `fn` with LH_SECRETS_KEY set, restoring the env afterwards. */
function withKey<T>(key: Buffer | string | undefined, fn: () => T): T {
	const saved = process.env.LH_SECRETS_KEY;
	if (key === undefined) delete process.env.LH_SECRETS_KEY;
	else process.env.LH_SECRETS_KEY = typeof key === "string" ? key : key.toString("base64");
	try { return fn(); } finally {
		if (saved === undefined) delete process.env.LH_SECRETS_KEY;
		else process.env.LH_SECRETS_KEY = saved;
	}
}

describe("key source", () => {
	it("an explicit key wins everywhere", () => {
		assert.equal(keySource({ LH_SECRETS_KEY: "x" }, "linux"), "env");
		assert.equal(keySource({ LH_SECRETS_KEY: "x" }, "win32"), "env");
	});
	it("Windows dev/web uses DPAPI; the desktop server child does not (yet)", () => {
		assert.equal(keySource({}, "win32"), "dpapi");
		assert.equal(keySource({ LH_DESKTOP_SERVER: "1" }, "win32"), null);
	});
	it("macOS and Linux keep plaintext 0600", () => {
		assert.equal(keySource({}, "darwin"), null);
		assert.equal(keySource({}, "linux"), null);
	});
});

describe("envelope (explicit key)", () => {
	const key = crypto.randomBytes(32);
	const file = path.join(TMP, "env", "auth.json");
	const secret = JSON.stringify({ OPENROUTER_API_KEY: "sk-or-v1-secret-value" });

	it("round-trips, and the sealed text holds no plaintext", () => {
		withKey(key, () => {
			const sealed = sealText(file, secret);
			assert(isSealed(sealed));
			assert(!sealed.includes("sk-or-v1-secret-value"));
			assert.equal(openText(file, sealed), secret);
		});
	});

	it("each seal uses a fresh IV", () => {
		withKey(key, () => assert.notEqual(sealText(file, secret), sealText(file, secret)));
	});

	it("tampered bytes or a different key are unreadable, never garbage", () => {
		const sealed = withKey(key, () => sealText(file, secret));
		const envelope = JSON.parse(sealed);
		const flipped = Buffer.from(envelope.data, "base64");
		flipped[0] = (flipped[0] ?? 0) ^ 1;
		const tampered = JSON.stringify({ ...envelope, data: flipped.toString("base64") });
		withKey(key, () => assert.throws(() => openText(file, tampered), { code: "unreadable" }));
		withKey(crypto.randomBytes(32), () => assert.throws(() => openText(file, sealed), { code: "unreadable" }));
	});

	it("a key of the wrong length is refused on write", () => {
		withKey(Buffer.alloc(16), () => assert.throws(() => sealText(file, secret), { code: "bad-key" }));
	});

	it("plaintext passes through on read, whatever the key source", () => {
		withKey(key, () => assert.equal(openText(file, secret), secret));
		assert.equal(openText(file, "{broken"), "{broken");
		assert(!isSealed(secret));
	});
});

describe("DPAPI key file (Windows)", { skip: process.platform !== "win32" }, () => {
	const dir = path.join(TMP, "dpapi");
	const file = path.join(dir, "auth.json");

	it("creates one wrapped key file on first seal and opens in a separate process", () => {
		withKey(undefined, () => {
			assert.equal(keySource(), "dpapi");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, sealText(file, "{\"A\":\"1\"}"));
			const keyFile = JSON.parse(fs.readFileSync(path.join(dir, KEY_FILE), "utf8"));
			assert.equal(keyFile.lhSecretsKey, 1);
			assert.equal(typeof keyFile.dpapi, "string");
			assert.deepEqual(fs.readdirSync(dir).sort(), ["auth.json", KEY_FILE].sort(), "no temp files left");
			const child = spawnSync(process.execPath, ["-e",
				"const b=require(process.argv[1]);const f=process.argv[2];process.stdout.write(b.openText(f,require('fs').readFileSync(f,'utf8')))",
				BOX, file], { encoding: "utf8", env: { ...process.env, LH_SECRETS_KEY: "" } });
			assert.equal(child.status, 0, child.stderr);
			assert.equal(child.stdout, "{\"A\":\"1\"}");
		});
	});

	it("a sealed file without its key file is unreadable", () => {
		withKey(undefined, () => {
			const other = path.join(TMP, "dpapi-missing-key", "auth.json");
			fs.mkdirSync(path.dirname(other), { recursive: true });
			assert.throws(() => openText(other, fs.readFileSync(file, "utf8")), { code: "unreadable" });
		});
	});
});
