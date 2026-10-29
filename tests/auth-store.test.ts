/**
 * The AuthStore fs adapter (auth-keys wave, 2026-09-19) — flat {VAR: value}
 * map at config.AUTH_FILE. THIS FILE is the sole owner of its auth file:
 * LH_AUTH_FILE is redirected to a fresh tmp dir BEFORE the first config
 * import (the seam is module-load-bound — data-dir-seam precedent), so no
 * hand-edited dev/desktop auth.json is ever touched.
 *
 * Pinning: absent/corrupt = {} ("no keys yet"); set/delete round-trip with
 * unknown vars preserved verbatim; the file is ALWAYS protected at rest
 * (sealed by secret-box where a key source applies, else mode 0600);
 * plaintext files are read and sealed on the next write; an unopenable
 * sealed file is moved aside, never overwritten;
 * writes are atomic (tmp+rename — no partial JSON state).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-auth-store-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

// Import AFTER the env redirect — module-load-bound seam.
const { authStore } = await import("../src/store/auth.ts");
const { AUTH_FILE } = await import("../config.ts");
const { assertSecretAtRest, readSecretJSON, sealsAtRest } = await import("./secret-files.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("AuthStore adapter", () => {
	it("absent file = {} (the documented first-boot state), never throws", () => {
		assert.deepEqual(authStore.authVars(), {});
	});

	it("set → read round-trip; trim is the CALLER's (server's) job, verbatim here", () => {
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-abc");
		assert.equal(authStore.authVars().OPENROUTER_API_KEY, "sk-or-v1-abc");
	});

	it("the file is protected at rest (sealed, or 0600 where that holds), also after rewrites", async () => {
		authStore.setAuthVar("DEEPGRAM_API_KEY", "d".repeat(40));
		await assertSecretAtRest(AUTH_FILE);
		authStore.setAuthVar("DEEPGRAM_API_KEY", "e".repeat(40));
		await assertSecretAtRest(AUTH_FILE, "rewrite stays protected");
		if (sealsAtRest()) assert(!fs.readFileSync(AUTH_FILE, "utf-8").includes("e".repeat(40)), "no plaintext key on disk");
	});

	it("a plaintext file (migration, hand-edit) is read, then sealed by the next write", async () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ HAND_EDITED: "pasted-value" }));
		assert.equal(authStore.authVars().HAND_EDITED, "pasted-value");
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-migrate");
		await assertSecretAtRest(AUTH_FILE);
		assert.deepEqual(await readSecretJSON(AUTH_FILE), { HAND_EDITED: "pasted-value", OPENROUTER_API_KEY: "sk-or-v1-migrate" });
	});

	it("a sealed file that cannot be opened is moved aside, never overwritten", () => {
		const foreign = JSON.stringify({ lhSecretBox: 1, iv: "AAAAAAAAAAAAAAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA==", data: "AAAA" });
		fs.writeFileSync(AUTH_FILE, foreign);
		assert.equal(authStore.unreadableFile(), null);
		assert.deepEqual(authStore.authVars(), {}, "starts empty instead of failing");
		const moved = authStore.unreadableFile();
		assert(moved && path.basename(moved).startsWith("auth.json.unreadable-"));
		assert.equal(fs.readFileSync(moved, "utf-8"), foreign, "the bytes are kept as they were");
		assert(!fs.existsSync(AUTH_FILE));
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-again");
		assert.equal(fs.readFileSync(moved, "utf-8"), foreign, "a later save never touches it");
		fs.rmSync(moved);
	});

	it("set preserves unknown vars verbatim (forward-compat)", () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ FUTURE_PLANS_TOKEN: "opaque-xyz", KEEP: "me" }));
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-new");
		const vars = authStore.authVars();
		assert.equal(vars.FUTURE_PLANS_TOKEN, "opaque-xyz");
		assert.equal(vars.KEEP, "me");
		assert.equal(vars.OPENROUTER_API_KEY, "sk-or-v1-new");
	});

	it("corrupt/non-object file = {} — never throws, looks like first boot", () => {
		fs.writeFileSync(AUTH_FILE, "{not json");
		assert.deepEqual(authStore.authVars(), {});
		fs.writeFileSync(AUTH_FILE, JSON.stringify(["an", "array"]));
		assert.deepEqual(authStore.authVars(), {});
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ OK: "fine", bad: 42 }));
		assert.deepEqual(authStore.authVars(), { OK: "fine" }, "non-string values drop");
	});

	it("delete removes just that var; absent delete = silent no-op", () => {
		fs.writeFileSync(AUTH_FILE, JSON.stringify({ A: "1", B: "2" }));
		authStore.deleteAuthVar("A");
		assert.deepEqual(authStore.authVars(), { B: "2" });
		authStore.deleteAuthVar("NOT_THERE");
		assert.deepEqual(authStore.authVars(), { B: "2" });
	});

	it("atomic writes: no tmp leftovers, valid JSON on disk every time", () => {
		authStore.setAuthVar("OPENROUTER_API_KEY", "sk-or-v1-final");
		const files = fs.readdirSync(TMP).filter((f) => f.startsWith(".auth.json.tmp"));
		assert.deepEqual(files, [], "no tmp file survives the rename");
		JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")); // must parse
	});
});
