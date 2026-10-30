import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { createDictationLanguageStore } from "../components/dictation-preference.ts";

test("Apple locales are separate from Deepgram language and default to system", () => {
	assert.equal(resolveSettings(null).dictation.appleLocale, "system");
	const settings = { language: "multi" as const, appleLocale: "en-AU" };
	assert.deepEqual(parseDictationSettingsBody(settings), { ok: true, settings });
	assert.deepEqual(sanitizeUserSettings({ version: 1, dictation: settings })?.dictation, settings);
	assert.equal(parseDictationSettingsBody({ appleLocale: "en-AU\n--other" }).ok, false);
	assert.equal(sanitizeUserSettings({ version: 1, dictation: { language: "pl", appleLocale: 3 } })?.dictation?.language, "pl");
});
test("changing the Deepgram language preserves the saved Apple locale", async () => {
	let written: unknown;
	const store = createDictationLanguageStore(async (_url, init) => {
		if (init?.method === "PUT") written = JSON.parse(init.body as string);
		return Response.json({ settings: { version: 1, dictation: init ? written : { language: "en", appleLocale: "en-AU" } } });
	});
	await store.load(); await store.save("pl");
	assert.deepEqual(written, { language: "pl", appleLocale: "en-AU" });
});
