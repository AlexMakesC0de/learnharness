/**
 * Server boot (Next instrumentation — runs once per server start, before
 * requests): bring the app-run SearXNG in line with the saved engine.
 * Fire-and-forget: starting Docker can take minutes and must not hold up
 * the server. Desktop only; elsewhere the manager is inert.
 */

export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { syncLocalSearch } = await import("./src/server/local-search.ts");
	void syncLocalSearch();
}
