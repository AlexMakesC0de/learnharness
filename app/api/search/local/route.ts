/**
 * POST /api/search/local — start the app-run SearXNG if it is the chosen
 * engine (desktop server only): the Electron shell calls it once the server
 * is up, and Settings' Retry calls it after a failure. Starting can take
 * minutes (opening Docker, a first download), so it is kicked off, not
 * awaited; GET /api/search keeps reporting progress. (Not a Next
 * instrumentation hook: that trace ignores outputFileTracingExcludes and
 * pulled the repo's data/ into the package.)
 */

import { localSearchStatus, syncLocalSearch } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	void syncLocalSearch({ retry: true });
	return Response.json({ local: localSearchStatus() });
}
