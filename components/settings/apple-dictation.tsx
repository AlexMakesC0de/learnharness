"use client";
import { useEffect, useState } from "react";
import type { AppleDictationCapabilities } from "@/src/core";
import { useAppleDictationPreference } from "@/components/apple-dictation-preference";
import { useDictationActive } from "@/components/dictation-state";
import { DictationLanguagePicker } from "@/components/dictation-language";
import { SettingsRow } from "@/components/settings/controls";
export function AppleDictationSettings() {
	const preference = useAppleDictationPreference();
	const active = useDictationActive();
	const [capabilities, setCapabilities] = useState<AppleDictationCapabilities | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let current = true;
		const bridge = window.lh?.appleDictation;
		if (!bridge) {
			setError("Apple speech is unavailable. Rebuild the Mac desktop app.");
			return;
		}
		bridge.capabilities().then(value => { if (current) {
			setCapabilities(value);
			setError(value.available ? null : value.error ?? "Apple speech is unavailable on this Mac.");
		} }).catch(() => { if (current)
			setError("Could not load Apple speech languages. Reopen Settings to try again."); });
		return () => { current = false; };
	}, []);
	const system = capabilities?.locales.find(locale => locale.id === capabilities.defaultLocale)?.label;
	const languages = [{ code: "system", label: system ? `System language (${system})` : "System language" }, ...(capabilities?.locales ?? []).map(locale => ({ code: locale.id, label: locale.label }))];
	return <>
  <SettingsRow label="Apple speech" testid="dictation-apple-provider"><span className="text-xs text-muted-foreground">On this Mac</span></SettingsRow>
  <SettingsRow label="Language" testid="row-dictation-language" dimmed={active}>
   <DictationLanguagePicker preference={preference} disabled={active || !capabilities?.available} items={languages}/>
  </SettingsRow>
  <p data-testid="dictation-setup-hint" className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">Audio is transcribed on this Mac. First use may download an Apple language model.</p>
  {error && <p role="alert" className="px-1 text-xs text-destructive">{error}</p>}
 </>;
}
