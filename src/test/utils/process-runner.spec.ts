import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CancellationTokenSource } from 'vscode';
import { runCommand } from '../../utils/process-runner';

/**
 * A small Node script standing in for phpcs: echoes its arguments and stdin as
 * JSON, exits with FIXTURE_EXIT, or sleeps forever when passed `--sleep`.
 */
const fixtureScript = `
if (process.argv.includes('--sleep')) { setInterval(() => {}, 1000); }
else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input }));
    process.exitCode = Number(process.env.FIXTURE_EXIT || 0);
  });
}
`;

suite('Process Runner Test Suite', () => {
  let tmpDir: string;
  let executable: string;
  const savedEnv = { ...process.env };

  suiteSetup(() => {
    // Run the VS Code binary as plain Node.
    process.env.ELECTRON_RUN_AS_NODE = '1';

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phpsab runner '));
    const script = path.join(tmpDir, 'fixture.js');
    fs.writeFileSync(script, fixtureScript);

    if (process.platform === 'win32') {
      // Same shape as Composer's vendor/bin/phpcs.bat proxy.
      executable = path.join(tmpDir, 'fixture.bat');
      fs.writeFileSync(
        executable,
        `@ECHO OFF\r\n"${process.execPath}" "${script}" %*\r\n`,
      );
    } else {
      executable = path.join(tmpDir, 'fixture');
      fs.writeFileSync(
        executable,
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      );
      fs.chmodSync(executable, 0o755);
    }
  });

  suiteTeardown(() => {
    process.env = savedEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  teardown(() => {
    delete process.env.FIXTURE_EXIT;
  });

  test('passes stdin and special-character arguments through unchanged', async () => {
    const args = [
      '--report=json',
      // Shell metacharacters that must reach the executable literally.
      `--stdin-path=${path.join(tmpDir, `it's 100%PATH% & $HOME (x);.php`)}`,
      '-',
    ];
    const input = '<?php\necho "héllo";\n';

    const result = await runCommand(executable, args, { input });

    assert.strictEqual(result.error, null, result.stderr);
    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { args, input });
  });

  test('reports the exit code', async () => {
    process.env.FIXTURE_EXIT = '6';
    const result = await runCommand(executable, ['-'], { input: '' });
    assert.strictEqual(result.exitCode, 6);
    assert.strictEqual(result.cancelled, false);
  });

  test('kills the process on cancellation', async () => {
    const source = new CancellationTokenSource();
    const run = runCommand(executable, ['--sleep'], { token: source.token });
    setTimeout(() => source.cancel(), 300);

    const result = await run;
    assert.strictEqual(result.cancelled, true);
    source.dispose();
  });

  test('kills the process on timeout', async () => {
    const result = await runCommand(executable, ['--sleep'], { timeout: 300 });
    assert.strictEqual(result.error?.code, 'ETIMEDOUT');
  });

  test('reports a missing executable as ENOENT', async () => {
    const missing = path.join(
      tmpDir,
      process.platform === 'win32' ? 'missing.bat' : 'missing',
    );
    const result = await runCommand(missing, ['-'], { input: '' });
    assert.strictEqual(result.error?.code, 'ENOENT');
  });
});
