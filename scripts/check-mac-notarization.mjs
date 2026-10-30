// Mirror electron-builder's credential priority; never inspect keychains or
// contact Apple here. Missing credentials must fail before an expensive build.
const env = process.env;
const account = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
const api = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];
const required = env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD ? account
	: api.some(key => env[key]) ? api
		: ["APPLE_KEYCHAIN_PROFILE"];
const missing = required.filter(key => !env[key]);
if (missing.length) {
	console.error(`Missing macOS notarization credentials: ${missing.join(", ")}. Set a complete Apple account/API-key credential set or APPLE_KEYCHAIN_PROFILE. For local testing use npm run desktop:dist:local.`);
	process.exitCode = 1;
}
