// `npm test` entry on every OS. npm runs scripts through cmd.exe on Windows,
// which can neither parse a POSIX `NODE_ENV=test cmd` prefix nor expand
// globs, so the env is set here and node:test expands the patterns itself.
// Extra arguments replace the default patterns: `npm test -- tests/x.test.ts`.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const patterns = process.argv.slice(2);
const result = spawnSync(
	process.execPath,
	[tsx, "--test", ...(patterns.length ? patterns : ["tests/*.test.ts", "tests/*.test.tsx"])],
	{ stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } },
);
process.exit(result.status ?? 1);
