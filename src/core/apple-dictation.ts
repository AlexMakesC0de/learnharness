/** Browser-safe contract for the Mac-only preload bridge. */
export interface AppleDictationCapabilities {
	available: boolean;
	locales: { id: string; label: string }[];
	defaultLocale: string | null;
	error?: string;
}
export interface AppleDictationBridge {
	capabilities(): Promise<AppleDictationCapabilities>;
	start(locale: string): Promise<{ sessionId: string }>;
	append(sessionId: string, frame: Uint8Array): Promise<void>;
	finish(sessionId: string): Promise<string>;
	cancel(): Promise<void>;
}
export function isAppleDictationLocale(value: unknown): value is string {
	return typeof value === "string" && (value === "system" || (value.length <= 50 && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)));
}
