/**
 * POST /api/search/local — Settings' Retry for the app-run SearXNG
 * (desktop server only). Starting can take minutes (opening Docker, a
 * first download), so the retry is kicked off, not awaited; the reply is
 * the state right after, and GET /api/search keeps reporting progress.
 */

import { localSearchStatus, syncLocalSearch } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST() {
	void syncLocalSearch({ retry: true });
	return Response.json({ local: localSearchStatus() });
}
