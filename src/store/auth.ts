/**
 * The AuthStore adapter (auth-keys wave, 2026-09-19): the flat {VAR: value}
 * auth.json map at config.AUTH_FILE — the SAME file the Electron app has
 * always hand-edited (owner decision: option A — same file, env-located,
 * zero migration). 0600, atomic writes, hand-edits keep working (the file
 * is re-read from disk on every access).
 *
 * The server (src/server/keys.ts) is the only intended writer: it applies
 * shape validation before setAuthVar and env precedence on top of
 * authVars(). This adapter persists what it is given, never throws
 * (absent/corrupt file = {} = "no keys yet", the documented first-boot
 * state, matching settings doctrine), and preserves unknown vars verbatim
 * (forward-compat: future entries — e.g. a plans-login token — ride along
 * untouched until a catalog entry adopts them).
 *
 * At rest the map is sealed by electron/secret-box.cjs where a key source
 * applies (Windows dev/web: DPAPI), plaintext 0600 elsewhere. A plaintext
 * file is still read (migration, hand-edits) and sealed on the next write.
 * A sealed file that cannot be opened is moved aside, never overwritten,
 * and reported through unreadableFile().
 */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import { openText, sealText } from "../../electron/secret-box.cjs";
import type { AuthStore } from "../core/ports.ts";

// Where a sealed auth.json that could not be decrypted was moved this
// process (globalThis anchor: HMR re-imports the module).
const g = globalThis as { __lhUnreadableAuthFile?: string };

/** Move an undecryptable sealed file aside, never overwrite it: the bytes
 *  may still open with the right key (e.g. a restored Windows profile). */
function quarantine(): void {
	const target = `${AUTH_FILE}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	try {
		fs.renameSync(AUTH_FILE, target);
		g.__lhUnreadableAuthFile = target;
	} catch {
		/* left in place; the next read retries */
	}
}

/** The flat string→string map, or {} for absent/corrupt/non-object. */
function readMap(): Record<string, string> {
	let text: string;
	try {
		text = fs.readFileSync(AUTH_FILE, "utf-8");
	} catch {
		return {}; // absent: the documented first-boot state
	}
	try {
		text = openText(AUTH_FILE, text);
	} catch {
		quarantine(); // sealed but undecryptable: keep it, start empty
		return {};
	}
	try {
		const raw = JSON.parse(text);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][],
		);
	} catch {
		return {}; // absent or corrupt — the documented state is "no keys yet"
	}
}

/** Write the map atomically at mode 0600: a partial write must never
 *  leave a 0644 file (secrets) or a truncated JSON (looks like "no keys").
 *  tmp-in-same-dir + rename keeps the swap atomic; chmod BEFORE the
 *  rename so the mode never exists relaxed on the final path. */
function writeMap(map: Record<string, string>): void {
	const dir = path.dirname(AUTH_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.auth.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${sealText(AUTH_FILE, JSON.stringify(map, null, "\t"))}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600); // umask may have relaxed the create mode
	fs.renameSync(tmp, AUTH_FILE);
}

export const authStore: AuthStore = {
	authVars() {
		return readMap();
	},
	setAuthVar(name, value) {
		const map = readMap();
		map[name] = value;
		writeMap(map);
	},
	deleteAuthVar(name) {
		const map = readMap();
		if (!(name in map)) return; // absent = silent success, idempotent
		delete map[name];
		writeMap(map);
	},
	unreadableFile() {
		return g.__lhUnreadableAuthFile ?? null;
	},
};
