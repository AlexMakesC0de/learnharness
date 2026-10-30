import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'darwin') {
  console.log('Apple speech helper build skipped: macOS required.');
  process.exit(0);
}
const version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' });
if (Number(version.split('.')[0]) < 26) throw new Error('Apple speech helper build requires macOS 26 or later.');
const xcode = execFileSync('/usr/bin/xcodebuild', ['-version'], { encoding: 'utf8' });
if (Number(xcode.match(/Xcode (\d+)/)?.[1] ?? 0) < 26) throw new Error('Apple speech helper build requires Xcode 26 or later.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'build/apple-stt/apple-stt');
mkdirSync(path.dirname(output), { recursive: true });
// An older deployment target lets unsupported Macs run capability discovery and get a clear error.
execFileSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-swift-version', '6', '-O',
  '-target', 'arm64-apple-macos13.0', '-framework', 'Speech', '-framework', 'AVFoundation',
  path.join(root, 'native/apple-stt/main.swift'), '-o', output], { stdio: 'inherit' });
console.log(`Built Apple speech helper: ${output}`);
