/** `attachBrowser`: the `browser` fixture and a `screen` on a Chromium that is already running, outside any test. */

import type { Screen } from '@e2e-dev/core';
import { TestError } from '@e2e-dev/core/engine';
import type { Browser } from './fixture/types.ts';
import { attachedWeb } from './engine.ts';
import { releaseQuietly } from './errors.ts';

/** How long an attached session's operations may take altogether when `timeout` is not given. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AttachBrowserOptions {
  /** The attribute `getByTestId` matches; default `data-testid`. */
  readonly testIdAttribute?: string | undefined;
  /** How long the attached session's operations may take altogether, in milliseconds; default 120000. */
  readonly timeout?: number | undefined;
  /** Cancels attaching and every operation. `close` still detaches. */
  readonly signal?: AbortSignal | undefined;
}

export interface AttachedBrowser extends AsyncDisposable {
  readonly browser: Browser;
  readonly screen: Screen;
  /** Detaches. The browser keeps running, with its tabs, cookies, and storage. */
  close(): Promise<void>;
}

/**
 * What attaching, and every operation of the attached session, fails with
 * once `timeoutMs`, the attach's `timeout`, ran out: `TEST_TIMEOUT`, the
 * code of a session whose time ran out. It is the reason the session's
 * signal aborts with, and classified, which is what the host keeps of an
 * abort: the step it cuts short, each step after it, and an attach still in
 * flight all fail with this error, where any other reason reads as a
 * cancellation.
 */
function attachTimeout(timeoutMs: number): TestError {
  return new TestError('TEST_TIMEOUT', `attachBrowser's timeout of ${String(timeoutMs)}ms ran out: it bounds attaching and every operation on the attached browser together. Pass a longer timeout`);
}

/**
 * Attaches to the Chromium at `cdpEndpoint` (`http://127.0.0.1:9222`, or its
 * `ws://` DevTools URL) and drives the tab it shows in the default browser
 * context, as it is, with the same `browser` and `screen` a test gets. Of
 * several open tabs that is the one visible; a browser that shows more than
 * one (two windows, a headless shell with two tabs), or none of several, is
 * refused. Relative URLs have no base: pass `browser.goto` a full URL.
 * Attaching and every operation after it share `options.timeout`: once it
 * runs out each fails `TEST_TIMEOUT` (`attachTimeout`), until `close`,
 * which ends the count.
 */
export async function attachBrowser(cdpEndpoint: string, options: AttachBrowserOptions = {}): Promise<AttachedBrowser> {
  const engine = attachedWeb(cdpEndpoint, { viewport: null, ...(options.testIdAttribute === undefined ? {} : { testIdAttribute: options.testIdAttribute }) });
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(attachTimeout(timeoutMs)), timeoutMs);
  // A count still running holds no program open.
  timer.unref();
  const signal = AbortSignal.any([deadline.signal, ...(options.signal === undefined ? [] : [options.signal])]);
  try {
    const { launch } = await import('@e2e-dev/core');
    const host = await launch(engine, { signal, handleSignals: false });
    try {
      const session = await host.newSession();
      const close = async (): Promise<void> => {
        clearTimeout(timer);
        await host.close();
      };
      return { browser: session.browser, screen: session.screen, close, [Symbol.asyncDispose]: close };
    } catch (cause) {
      await releaseQuietly(host.close());
      throw cause;
    }
  } catch (cause) {
    clearTimeout(timer);
    throw cause;
  }
}
