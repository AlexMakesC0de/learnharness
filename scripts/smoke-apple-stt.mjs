import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This fixture uses synthesized speech only. It never records a microphone or prints transcripts.
if (process.platform !== 'darwin') {
  console.log('Apple speech smoke skipped: macOS required.');
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const protocolOnly = args.includes('--protocol-only');
const paths = args.filter((argument) => argument !== '--protocol-only');
assert.ok(paths.length <= 1 && paths.every((argument) => !argument.startsWith('--')),
  'Usage: node scripts/smoke-apple-stt.mjs [helper-path] [--protocol-only]');
const binary = paths[0] ? path.resolve(paths[0]) : path.join(root, 'build/apple-stt/apple-stt');
assert.ok(existsSync(binary), 'Build the Apple speech helper before running the smoke test');
const capabilities = JSON.parse(execFileSync(binary, ['--capabilities'], { timeout: 30_000, encoding: 'utf8' }));
assert.equal(typeof capabilities.available, 'boolean', 'Capabilities must declare engine availability');
assert.ok(Array.isArray(capabilities.locales), 'Capabilities must include a locale array');
if (!capabilities.available) {
  assert.deepEqual(capabilities.locales, [], 'Unavailable speech must have no supported locales');
  assert.equal(capabilities.defaultLocale, null, 'Unavailable speech must have no default locale');
  if (protocolOnly) {
    console.log('Unavailable capabilities shape passed.');
    console.log('Protocol startup and recognition checks skipped: Apple speech is unavailable on this hardware or macOS version.');
    process.exit(0);
  }
}
assert.equal(capabilities.available, true, 'Actual native smoke requires supported Apple speech hardware and macOS 26+');
assert.ok(capabilities.locales.length > 0);
assert.ok(capabilities.defaultLocale === null || capabilities.locales.some(({ id }) => id === capabilities.defaultLocale));
const locale = capabilities.locales.find(({ id }) => id === 'en-US')?.id;
assert.ok(locale, 'Fixture requires the Apple English (US) model');
console.log(`Capabilities passed (${capabilities.locales.length} supported locales).`);

function session(timeout = 180_000) {
  const child = spawn(binary, ['--language', locale], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let pending = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    assert.ok(pending.length < 128 * 1024, 'Helper output is bounded');
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
      child.emit('message');
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const closed = once(child, 'close').then(([code, signal]) => {
    clearTimeout(timer);
    assert.equal(signal, null, 'Native helper exceeded its process timeout');
    assert.equal(pending, '', 'Helper output ends at a complete NDJSON boundary');
    return { code, messages, stderr };
  });
  async function ready() {
    while (!messages.some(({ type }) => type === 'ready')) {
      if (messages.some(({ type }) => type === 'error') || child.exitCode !== null) {
        throw new Error('Apple speech preparation failed; inspect native availability/assets.');
      }
      await Promise.race([once(child, 'message'), closed.then(() => { throw new Error('Helper exited before ready'); })]);
    }
  }
  return { child, closed, ready, send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`) };
}

for (const input of [
  '{bad json}\n',
  `${JSON.stringify({ type: 'audio', data: 'AQ==' })}\n`,
  `${JSON.stringify({ type: 'audio', data: 'not base64' })}\n`,
  `${JSON.stringify({ type: 'audio', data: '' })}\n`,
  `${JSON.stringify({ type: 'unknown' })}\n`,
  `${'x'.repeat(32_769)}\n`,
]) {
  const test = session(10_000);
  test.child.stdin.write(input);
  const { code, messages } = await test.closed;
  assert.notEqual(code, 0, 'Malformed input fails explicitly');
  assert.equal(messages.filter(({ type }) => type === 'error').length, 1);
  assert.ok(!messages.some(({ type }) => type === 'result'));
}
console.log('Malformed JSON, PCM, base64, unknown commands and line bounds passed.');

for (const command of ['cancel', 'eof', 'partial-eof']) {
  for (const afterReady of protocolOnly ? [false] : [false, true]) {
    const test = session(afterReady ? 180_000 : 5_000);
    if (afterReady) await test.ready();
    const started = Date.now();
    if (command === 'cancel') test.send({ type: 'cancel' });
    else test.child.stdin.end(command === 'partial-eof' ? '{\"type\":' : undefined);
    const { code, messages } = await test.closed;
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 3_000, 'Cancellation/EOF exits promptly');
    assert.ok(!messages.some(({ type }) => type === 'result' || type === 'error'));
  }
}
console.log(protocolOnly
  ? 'Cancel and EOF (including incomplete lines) passed during startup.'
  : 'Cancel and EOF (including incomplete lines) passed during preparation and after ready.');
if (protocolOnly) {
  console.log('Protocol-only smoke passed (no ready waits or synthesized recognition fixture).');
  process.exit(0);
}

{
  const test = session();
  await test.ready();
  test.send({ type: 'finish' });
  test.child.stdin.end();
  const { code, messages } = await test.closed;
  assert.equal(code, 0);
  assert.deepEqual(messages.filter(({ type }) => type === 'result'), [{ type: 'result', text: '' }]);
  console.log('Empty recording finalization passed.');
}

const temp = mkdtempSync(path.join(tmpdir(), 'apple-stt-smoke-'));
try {
  const source = path.join(temp, 'fixture.aiff');
  const wave = path.join(temp, 'fixture.wav');
  execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '145', '-o', source,
    'Apple speech recognition runs locally on this computer. Learning new things takes practice every day.']);
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', source, wave]);
  const wav = readFileSync(wave);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  let pcm;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') {
      pcm = wav.subarray(offset + 8, offset + 8 + size);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  assert.ok(pcm?.length && pcm.length % 2 === 0, 'Fixture contains complete linear16 samples');
  for (const command of ['cancel', 'eof']) {
    const test = session();
    await test.ready();
    for (let offset = 0; offset < pcm.length; offset += 3_200) {
      if (!test.send({ type: 'audio', data: pcm.subarray(offset, offset + 3_200).toString('base64') })) {
        await once(test.child.stdin, 'drain');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (command === 'cancel') test.send({ type: 'cancel' });
    else test.child.stdin.end();
    const { code, messages } = await test.closed;
    assert.equal(code, 0);
    assert.ok(!messages.some(({ type }) => type === 'result' || type === 'error'));
  }
  console.log('Cancel and EOF discard in-flight synthesized audio without a transcript.');
  const test = session();
  await test.ready();
  for (let offset = 0; offset < pcm.length; offset += 3_200) {
    if (!test.send({ type: 'audio', data: pcm.subarray(offset, offset + 3_200).toString('base64') })) {
      await once(test.child.stdin, 'drain');
    }
  }
  // Include trailing silence so that the end of the utterance can be recognized reliably.
  test.send({ type: 'audio', data: Buffer.alloc(16_000).toString('base64') });
  test.send({ type: 'finish' });
  test.child.stdin.end();
  const { code, messages } = await test.closed;
  assert.equal(code, 0);
  const results = messages.filter(({ type }) => type === 'result');
  assert.equal(results.length, 1, 'Finish emits exactly one final transcript');
  const text = results[0].text.toLowerCase();
  assert.ok(text.split(/\s+/).length >= 10, 'Actual engine recognized meaningful speech');
  for (const expected of ['apple', 'speech', 'learning', 'practice']) {
    assert.ok(text.includes(expected), `Actual engine recognized fixture word: ${expected}`);
  }
  assert.ok(!messages.some(({ type }) => type === 'error'));
  console.log('Actual on-device recognition passed (synthesized fixture, expected words verified; transcript omitted).');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
