import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Arch, Platform, type AfterPackContext } from "electron-builder";
import { packageLocalMac } from "../scripts/package-local-mac.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packContext = (electronFuses?: object) => ({ packager: { config: { electronFuses } } }) as unknown as AfterPackContext;

describe("local Mac packaging", () => {
	it("keeps normal installer/updater targets and signs after the icon hook without builder identity lookup", async () => {
		const stages: string[] = [];
		await packageLocalMac({
			projectDir: root,
			build: async (options) => {
				assert.ok(options);
				assert.ok(options.config && typeof options.config === "object");
				assert.ok(options.config.mac);
				assert.ok(options.targets);
				assert.equal(options.publish, "never");
				assert.equal(options.config.mac.identity, null, "null skips builder identity lookup, unlike '-' which can match a real certificate");
				assert.equal(options.config.mac.notarize, false);
				assert.equal(options.config.mac.hardenedRuntime, false);
				assert.equal(options.config.extends, path.join(root, "electron-builder.yml"));
				assert.deepEqual(options.targets.get(Platform.MAC)?.get(Arch.arm64), ["dmg", "zip"]);
				assert.equal(options.prepackaged, undefined);
				assert.equal(typeof options.config.afterPack, "function");
				assert.ok(typeof options.config.afterPack === "function");
				stages.push("package");
				await options.config.afterPack(packContext());
				assert.deepEqual(stages, ["package", "icon", "ad-hoc"]);
				stages.push("archives");
				return [];
			},
			prepareIcon: async () => { stages.push("icon"); },
			sign: async (options) => {
				assert.deepEqual(stages, ["package", "icon"]);
				assert.equal(options.app, path.join(root, "dist/mac-arm64/LearnHarness.app"));
				assert.equal(options.identity, "-");
				assert.equal(options.identityValidation, false, "direct signer must never search the keychain");
				assert.equal(options.preAutoEntitlements, false);
				assert.equal(options.preEmbedProvisioningProfile, false);
				assert.equal(options.optionsForFile?.("fixture")?.hardenedRuntime, false);
				assert.equal(options.optionsForFile?.("fixture")?.timestamp, "none");
				stages.push("ad-hoc");
			},
		});
		assert.deepEqual(stages, ["package", "icon", "ad-hoc", "archives"]);
	});

	it("never creates archives if ad-hoc signing fails", async () => {
		let archives = false;
		await assert.rejects(packageLocalMac({
			projectDir: root,
			build: async (options) => {
				assert.ok(options?.config && typeof options.config === "object" && typeof options.config.afterPack === "function");
				await options.config.afterPack(packContext());
				archives = true;
				return [];
			},
			prepareIcon: async () => {},
			sign: async () => { throw new Error("fixture signing failure"); },
		}), /fixture signing failure/);
		assert.equal(archives, false);
	});

	it("rejects fuse mutations that would invalidate a signature created in afterPack", async () => {
		await assert.rejects(packageLocalMac({
			build: async (options) => {
				assert.ok(options?.config && typeof options.config === "object" && typeof options.config.afterPack === "function");
				await options.config.afterPack(packContext({ runAsNode: true }));
				return [];
			},
			prepareIcon: async () => { assert.fail("must reject before icon/signing changes"); },
			sign: async () => { assert.fail("must reject before signing"); },
		}), /fuse changes/);
	});
});

describe("distribution notarization preflight", () => {
	const check = (credentials: Record<string, string>) => {
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith("APPLE_")) delete env[key];
		return spawnSync(process.execPath, [path.join(root, "scripts/check-mac-notarization.mjs")], {
			env: { ...env, ...credentials }, encoding: "utf8", timeout: 10000,
		});
	};

	it("rejects missing credentials before building", () => {
		const result = check({});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /notarization credentials/i);
	});

	const credentialCases: Record<string, string>[] = [
		{ APPLE_KEYCHAIN_PROFILE: "fixture-notary" },
		{ APPLE_ID: "fixture@example.invalid", APPLE_APP_SPECIFIC_PASSWORD: "fixture-password", APPLE_TEAM_ID: "FIXTURE" },
		{ APPLE_API_KEY: "/fixture/key.p8", APPLE_API_KEY_ID: "FIXTURE", APPLE_API_ISSUER: "fixture-issuer" },
	];
	for (const credentials of credentialCases) {
		it(`accepts complete ${Object.keys(credentials)[0]} credentials without contacting Apple`, () => {
			const result = check(credentials);
			assert.equal(result.status, 0, result.stderr);
		});
	}

	it("rejects incomplete higher-priority credentials even when a keychain profile exists", () => {
		const result = check({ APPLE_ID: "fixture@example.invalid", APPLE_KEYCHAIN_PROFILE: "fixture-notary" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /APPLE_APP_SPECIFIC_PASSWORD/);
		assert.ok(!result.stderr.includes("fixture@example.invalid"));
	});
});
