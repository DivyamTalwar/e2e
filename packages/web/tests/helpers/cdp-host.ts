/** A local Chrome process owned independently of the engine's CDP transport. */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { BidiConnection } from '../../src/driver/connection.ts';
import { browserExecutable } from '../../src/install/provision.ts';

/** A live Chrome with a random remote-debugging port; the host the engine attaches to. */
export interface RemoteChrome {
  readonly endpoint: string;
  readonly proc: ChildProcess;
  readonly userDataDir: string;
  readonly closed: Promise<void>;
}

/** Waits for Chrome and its stdio to close before removing the profile it writes. */
export async function closeRemoteChrome(chrome: Omit<RemoteChrome, 'endpoint'>): Promise<void> {
  if (chrome.proc.exitCode === null && chrome.proc.signalCode === null) chrome.proc.kill('SIGKILL');
  await chrome.closed;
  rmSync(chrome.userDataDir, { recursive: true, force: true });
}

/** How a BiDi session ends: `session.end` detaches and leaves the browser to its host, `browser.close` ends the browser with it. */
const GOODBYES: ReadonlySet<string> = new Set(['session.end', 'browser.close']);

/**
 * Records the goodbye of every BiDi session this process ends from now until
 * the test restores its mocks; the function returned reads them in order.
 */
export function recordGoodbyes(): () => string[] {
  const send = vi.spyOn(BidiConnection.prototype, 'send');
  return () => send.mock.calls.map(([method]) => String(method)).filter((method) => GOODBYES.has(method));
}

/** The DevTools WebSocket URL `chrome` names over HTTP now, which only a Chrome still running answers. */
export async function debuggerUrl(chrome: Pick<RemoteChrome, 'endpoint'>): Promise<string> {
  const response = await fetch(`http://${new URL(chrome.endpoint).host}/json/version`);
  const version = (await response.json()) as { webSocketDebuggerUrl: string };
  return version.webSocketDebuggerUrl;
}

/** The pinned full Chrome's executable, which a suite that hosts one needs installed: nothing installs the headed build below the engine's `prepare`. */
export function installedChrome(): string {
  const executable = browserExecutable('chromium', true);
  if (!existsSync(executable)) throw new Error(`the pinned full Chrome is not installed at ${executable}: run "node packages/web/dist/bin.js install chromium --headed"`);
  return executable;
}

/** What the remote host runs. */
export interface RemoteChromeOptions {
  /**
   * A full Chrome build, run in new headless mode with its component
   * extensions and browser UI targets, as a user's own Chrome has them. The
   * pinned headless shell when unset.
   */
  readonly fullChrome?: string;
}

/** Launches the remote host and releases its resources if it never becomes ready. */
export async function launchRemoteChrome(options: RemoteChromeOptions = {}): Promise<RemoteChrome> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'e2e-cdp-host-'));
  // The sandbox flags are what a containerized CI runner needs to start Chrome
  // at all; they change nothing about the attach under test.
  // The pinned headless shell is always headless, the build a headless launch
  // runs, and as a blank host needs no extension workers.
  const proc = spawn(options.fullChrome ?? browserExecutable('chromium', false), [
    ...(options.fullChrome === undefined ? ['--disable-extensions', '--disable-component-extensions-with-background-pages'] : ['--headless=new']),
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    // Without it, Chrome on macOS can wait on a Keychain prompt and load no page.
    '--use-mock-keychain',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ]);
  const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()));
  const remote = { proc, userDataDir, closed };
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome never printed a CDP endpoint')), 30_000);
    let buffered = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    proc.once('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      // Surface Chrome's own stderr: it names the missing flag or library.
      reject(
        new Error(
          `Chrome exited before it was ready (code ${code}, signal ${signal}):\n${buffered.trim()}`,
        ),
      );
    });
  });
  try {
    const endpoint = await ready;
    return { endpoint, ...remote };
  } catch (cause) {
    await closeRemoteChrome(remote);
    throw cause;
  }
}
