"use client";
import { useSyncExternalStore } from "react";
import { isAppleDictationLocale } from "@/src/core";
import { createDictationPreferenceStore } from "@/components/dictation-preference";
import { notifySettingsSaved, onSettingsSaved } from "@/components/settings-signal";

let announcing = false;
const store = createDictationPreferenceStore((...args) => fetch(...args), { field: "appleLocale", fallback: "system", valid: isAppleDictationLocale }, () => {
	announcing = true;
	try { notifySettingsSaved("dictation"); } finally { announcing = false; }
});
let readers = 0;
let stop: (() => void) | undefined;
function subscribe(listener: () => void) {
	const off = store.subscribe(listener);
	if (readers++ === 0) {
		stop = onSettingsSaved(section => { if (section === "dictation" && !announcing) void store.load(true).catch(() => {}); });
		void store.getLanguage().catch(() => {});
	}
	return () => { off(); if (--readers === 0) { stop?.(); stop = undefined; } };
}
const noSubscription = () => () => {};
export function useAppleDictationPreference(enabled = true) {
	const snapshot = useSyncExternalStore(enabled ? subscribe : noSubscription, enabled ? store.getSnapshot : store.getServerSnapshot, store.getServerSnapshot);
	return { ...snapshot, load: store.load, save: store.save, getLanguage: store.getLanguage };
}
