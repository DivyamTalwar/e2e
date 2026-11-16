/**
 * `installBrowsers` with `withDeps` on a machine made to look like Debian:
 * a fake `sudo` and `apt-get` on the PATH record what apt is asked for, and
 * `apt-get update` only returns once the test's event loop has run.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { browserExecutable, installBrowsers } from '../../src/install/provision.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, existsSync: (file: string) => file === '/usr/bin/apt-get' || fs.existsSync(file) };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

let dir = '';
let calls = '';
let loopRan = '';
let env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'e2e-apt-'));
  calls = path.join(dir, 'calls');
  loopRan = path.join(dir, 'loop-ran');
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const fake = [
    '#!/bin/sh',
    `echo "$(basename "$0") $*" >> "${calls}"`,
    'case "$*" in *update)',
    '  tries=0',
    `  until [ -e "${loopRan}" ]; do`,
    '    tries=$((tries + 1))',
    '    [ "$tries" -gt 300 ] && exit 1',
    '    sleep 0.01',
    '  done ;;',
    'esac',
    '',
  ].join('\n');
  for (const name of ['sudo', 'apt-get']) {
    writeFileSync(path.join(bin, name), fake);
    chmodSync(path.join(bin, name), 0o755);
  }
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`);
  Object.defineProperty(process, 'platform', { value: 'linux' });
  env = { E2E_BROWSERS_PATH: path.join(dir, 'browsers') };
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it.skipIf(platform.value === 'win32')('runs apt without blocking the event loop, so the install lock keeps its heartbeat', async () => {
  const executable = await browserExecutable('chromium', false, env);
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, '');
  const logs: string[] = [];
  const loop = setImmediate(() => writeFileSync(loopRan, ''));
  try {
    await installBrowsers(['chromium'], { env, headed: false, withDeps: true, log: (line) => logs.push(line) });
  } finally {
    clearImmediate(loop);
  }
  const asked = readFileSync(calls, 'utf8').trim().split('\n').map((line) => line.replace(/^sudo /, ''));
  expect(asked[0]).toBe('apt-get update');
  expect(asked.slice(1, -1)).toHaveLength(11);
  for (const probe of asked.slice(1, -1)) expect(probe).toMatch(/^apt-get install --simulate --no-install-recommends \S+$/);
  expect(asked.at(-1)).toMatch(/^apt-get satisfy -y --no-install-recommends fonts-noto-color-emoji, .*, libasound2t64 \| libasound2, .*, libxrandr2$/);
  expect(logs).toEqual([expect.stringMatching(/^Installing system packages: fonts-noto-color-emoji .* libasound2t64 .* libxrandr2$/)]);
});
