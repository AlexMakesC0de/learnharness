"use strict";
/**
 * The desktop app's data key for secret-box.cjs: 32 random bytes wrapped
 * with Electron safeStorage (Windows DPAPI, macOS Keychain) in
 * userData/secrets.key as {"lhSecretsKey":1,"safeStorage":"<b64>"}. Main
 * loads it once after app ready, keeps it in memory (secret-box useKey) and
 * passes it to the server child as LH_SECRETS_KEY.
 *
 * Windows and macOS only. Linux keeps plaintext 0600: safeStorage there can
 * fall back to basic_text, which protects nothing.
 *
 * A key file that no longer unwraps (e.g. a reset Windows profile or a
 * denied Keychain item) is moved aside, never deleted, together with the
 * sealed credential files it protected; a new key is created and the user
 * signs in again. A sealed auth.json is left for the server, which moves it
 * aside and tells the user in Settings.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { KEY_FILE, isSealed } = require("./secret-box.cjs");

const PLATFORMS = new Set(["win32", "darwin"]);

/** Rename `file` to `<file>.unreadable-<stamp>`; false when it is absent. */
function moveAside(file, stamp) {
	try {
		fs.renameSync(file, `${file}.unreadable-${stamp}`);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

function sealedOnDisk(file) {
	try {
		return isSealed(fs.readFileSync(file, "utf8"));
	} catch {
		return false;
	}
}

function unwrap(raw, safeStorage) {
	const parsed = JSON.parse(raw);
	if (parsed.lhSecretsKey !== 1 || typeof parsed.safeStorage !== "string") throw new Error("not a safeStorage key file");
	const key = Buffer.from(safeStorage.decryptString(Buffer.from(parsed.safeStorage, "base64")), "base64");
	if (key.length !== 32) throw new Error("wrong key length");
	return key;
}

/** Create the key file exactly once (temp file + hard link, as secret-box's
 *  DPAPI key); if another process won the race, use its key. */
function create(file, safeStorage) {
	const key = crypto.randomBytes(32);
	const wrapped = safeStorage.encryptString(key.toString("base64")).toString("base64");
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify({ lhSecretsKey: 1, safeStorage: wrapped })}\n`, { mode: 0o600, flag: "wx" });
	try {
		fs.linkSync(temp, file);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		return unwrap(fs.readFileSync(file, "utf8"), safeStorage);
	} finally {
		fs.rmSync(temp, { force: true });
	}
	return key;
}

/**
 * The data key for the secret files in `directory`, or null where none
 * applies (Linux, or OS encryption unavailable). `sealedFiles` are moved
 * aside with an unreadable key file. Throws only on file system errors.
 */
function loadSecretsKey({ directory, safeStorage, sealedFiles = [], platform = process.platform, log = () => {} }) {
	if (!PLATFORMS.has(platform)) return null;
	if (!safeStorage.isEncryptionAvailable()) {
		log("secrets: OS encryption unavailable, secret files are left as they are");
		return null;
	}
	const file = path.join(directory, KEY_FILE);
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return create(file, safeStorage);
	}
	try {
		return unwrap(raw, safeStorage);
	} catch {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		moveAside(file, stamp);
		const moved = sealedFiles.filter((f) => sealedOnDisk(f) && moveAside(f, stamp));
		log(`secrets: ${KEY_FILE} could not be unwrapped; moved it aside with ${moved.length} sealed credential file(s) and created a new key`);
		return create(file, safeStorage);
	}
}

module.exports = { loadSecretsKey };
