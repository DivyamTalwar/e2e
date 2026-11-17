/** `attachBrowser`: the `browser` fixture and a `screen` on a Chromium that is already running, outside any test. */

import type { Screen } from '@e2e-dev/core';
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
 * Attaches to the Chromium at `cdpEndpoint` (`http://127.0.0.1:9222`, or its
 * `ws://` DevTools URL) and drives the tab it shows in the default browser
 * context, as it is, with the same `browser` and `screen` a test gets. Of
 * several open tabs that is the one visible; a browser that shows more than
 * one (two windows, a headless shell with two tabs), or none of several, is
 * refused. Relative URLs have no base: pass `browser.goto` a full URL.
 */
export async function attachBrowser(cdpEndpoint: string, options: AttachBrowserOptions = {}): Promise<AttachedBrowser> {
  const engine = attachedWeb(cdpEndpoint, { viewport: null, ...(options.testIdAttribute === undefined ? {} : { testIdAttribute: options.testIdAttribute }) });
  const signals = [AbortSignal.timeout(options.timeout ?? DEFAULT_TIMEOUT_MS), ...(options.signal === undefined ? [] : [options.signal])];
  const { launch } = await import('@e2e-dev/core');
  const host = await launch(engine, { signal: AbortSignal.any(signals), handleSignals: false });
  try {
    const session = await host.newSession();
    const close = (): Promise<void> => host.close();
    return { browser: session.browser, screen: session.screen, close, [Symbol.asyncDispose]: close };
  } catch (cause) {
    await releaseQuietly(host.close());
    throw cause;
  }
}
