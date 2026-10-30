// Build unsigned first: electron-builder interprets identity '-' as a search
// qualifier and can select a real certificate whose name contains a hyphen.
// Sign directly in afterPack, after builder writes updater metadata and before
// it creates the archives. Built-in signing stays disabled with identity:null.
import { build as electronBuild, Platform, Arch } from "electron-builder";
import { signAsync } from "@electron/osx-sign";
import prepareMacIcon from "./after-pack.cjs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");

/** @param {{projectDir?: string, build?: typeof electronBuild, sign?: typeof signAsync, prepareIcon?: typeof prepareMacIcon}} options */
export async function packageLocalMac({ projectDir = ROOT, build = electronBuild, sign = signAsync, prepareIcon = prepareMacIcon } = {}) {
	const app = path.join(projectDir, "dist", "mac-arm64", "LearnHarness.app");
	/** @param {import('electron-builder').AfterPackContext} context */
	async function afterPack(context) {
		// Builder flips fuses after afterPack, which would invalidate this
		// signature. Fail if that pipeline ever changes instead of shipping it.
		if (context.packager.config.electronFuses != null) throw new Error("Local ad-hoc signing must be moved after fuse changes before enabling electronFuses.");
		await prepareIcon(context);
		await sign({
			app, platform: "darwin", identity: "-", identityValidation: false,
			preAutoEntitlements: false, preEmbedProvisioningProfile: false,
			optionsForFile: () => ({
				entitlements: path.join(projectDir, "build", "entitlements.mac.plist"),
				hardenedRuntime: false, timestamp: "none",
			}),
		});
	}
	const config = {
		extends: path.join(projectDir, "electron-builder.yml"),
		mac: { identity: null, notarize: false, hardenedRuntime: false },
		afterPack,
	};
	return build({ projectDir, targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64), publish: "never", config });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		console.error("Local Mac packaging requires an Apple Silicon Mac running native arm64 Node.");
		process.exitCode = 1;
	} else {
		await packageLocalMac();
	}
}
