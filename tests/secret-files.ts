/**
 * Test helpers for the owner-only secret files (auth.json,
 * *-credentials.json). They read through electron/secret-box.cjs, so the
 * same assertions hold where files are sealed at rest (Windows dev/web) and
 * where they stay plaintext 0600 (macOS, Linux).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const box = require("../electron/secret-box.cjs");

export const KEY_FILE: string = box.KEY_FILE;
export const sealsAtRest = (): boolean => box.keySource() !== null;

/** The parsed JSON of a secret file, sealed or not. */
export async function readSecretJSON(file: string): Promise<any> {
	return JSON.parse(box.openText(file, await fs.readFile(file, "utf8")));
}

/** Protected at rest: sealed where a key source applies, mode 0600 elsewhere. */
export async function assertSecretAtRest(file: string, message?: string): Promise<void> {
	if (sealsAtRest()) assert(box.isSealed(await fs.readFile(file, "utf8")), message ?? `${file} is sealed at rest`);
	else assert.equal((await fs.stat(file)).mode & 0o777, 0o600, message);
}
