"use client";

import { useSyncExternalStore } from "react";
import {
	FACTORY_SETTINGS, isDictationLanguage, sanitizeUserSettings,
	type DictationLanguage, type DictationSettings, type UserSettings,
} from "@/src/core";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

const INITIAL = { language: undefined as DictationLanguage | undefined, saving: false, error: null as string | null };

/** One confirmed preference and one write in flight, shared by every surface.
 * The factory keeps transport tests isolated without a second persistence path.
 */
export function createDictationPreferenceStore<T extends string>(request: typeof fetch, config: {
	field: "language" | "appleLocale"; fallback: T; valid: (value: unknown) => value is T;
}, saved: () => void = () => {}) {
	const initial = { ...INITIAL, language: undefined as T | undefined };
	let snapshot = initial;
	let reading: Promise<T> | null = null;
	let writing: Promise<boolean> | null = null;
	let revision = 0;
	let needsRead = true;
	let section: DictationSettings = {};
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<typeof initial>) => {
		snapshot = { ...snapshot, ...patch };
		for (const listener of listeners) listener();
	};

	function load(refresh = false): Promise<T> {
		if (writing) return getLanguage();
		if (reading && !refresh) return reading;
		if (!refresh && !needsRead && snapshot.language !== undefined) return Promise.resolve(snapshot.language);
		const version = ++revision;
		needsRead = true;
		reading = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings");
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings | null };
				if (!("settings" in body)) throw new Error();
				const record = sanitizeUserSettings(body.settings);
				if (body.settings !== null && record === null) throw new Error();
				if (version !== revision) return getLanguage();
				const language = record?.dictation?.[config.field] ?? config.fallback;
				section = record?.dictation ?? {};
				if (!config.valid(language)) throw new Error();
				needsRead = false;
				publish({ language, error: null });
				return language;
			} catch {
				if (version !== revision) return getLanguage();
				const message = "Could not load dictation language. Try again.";
				publish({ error: message });
				throw new Error(message);
			} finally {
				if (version === revision) reading = null;
			}
		});
		return reading;
	}

	function save(language: T): Promise<boolean> {
		// A different selection must never inherit the previous write's success.
		if (writing || snapshot.language === undefined) return Promise.resolve(false);
		revision++;
		reading = null;
		writing = Promise.resolve().then(async () => {
			try {
				const res = await request("/api/settings/dictation", {
					method: "PUT", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ...section, [config.field]: language }),
				});
				if (!res.ok) throw new Error();
				const body = await res.json() as { settings: UserSettings };
				const confirmed = body.settings?.dictation?.[config.field];
				if (!config.valid(confirmed)) throw new Error();
				section = body.settings.dictation ?? {};
				needsRead = false;
				publish({ language: confirmed, error: null });
				saved();
				return true;
			} catch {
				publish({ error: "Could not save dictation language. Try again." });
				return false;
			} finally {
				writing = null;
				publish({ saving: false });
			}
		});
		publish({ saving: true, error: null });
		return writing;
	}

	async function getLanguage(): Promise<T> {
		for (;;) {
			if (writing) await writing;
			else if (reading) await reading;
			else if (needsRead || snapshot.language === undefined) await load();
			else return snapshot.language;
		}
	}

	return {
		load, save, getLanguage,
		getSnapshot: () => snapshot,
		getServerSnapshot: () => initial,
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

export function createDictationLanguageStore(request: typeof fetch, saved: () => void = () => {}) {
	return createDictationPreferenceStore(request, { field: "language", fallback: FACTORY_SETTINGS.dictation.language, valid: isDictationLanguage }, saved);
}

let announcingSave = false;
const store = createDictationLanguageStore((...args) => fetch(...args), () => {
	// All our readers already received the confirmed PUT response. Keep the
	// repo's notification contract without depending on a redundant GET.
	announcingSave = true;
	try { notifySettingsSaved("dictation"); } finally { announcingSave = false; }
});
let readers = 0;
let stopSignals: (() => void) | undefined;

function subscribe(listener: () => void) {
	const off = store.subscribe(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "dictation" && !announcingSave) void store.load(true).catch(() => {});
		});
		// A confirmed preference lives for the window, not the page. Navigation
		// and reopening Settings must not add a new network failure point.
		void store.getLanguage().catch(() => {});
	}
	return () => { off(); if (--readers === 0) { stopSignals?.(); stopSignals = undefined; } };
}

const noSubscription = () => () => {};
export function useDictationLanguage(enabled = true) {
	const snapshot = useSyncExternalStore(enabled ? subscribe : noSubscription, enabled ? store.getSnapshot : store.getServerSnapshot, store.getServerSnapshot);
	return { ...snapshot, load: store.load, save: store.save, getLanguage: store.getLanguage };
}
