/**
 * The windows of the attempt's tabs, each grown until it shows its tab's
 * whole viewport. `browsingContext.setViewport` lays a page out at any size
 * and resizes no window. Firefox sends mouse and wheel input through the
 * window, as a person's input arrives (`remote.events.async.*`), so a point
 * of the page past the window's content area takes none: in a headless
 * window of 1366 by 768 with 85 pixels of toolbars, the last 37 rows of a
 * 1280 by 720 viewport. A window is as large as the page that fills it plus
 * its chrome, so it grows to the viewport plus that chrome before the tab
 * is sized, and a viewport no window can hold is refused.
 */

import type { Browser } from 'webdriver-bidi-protocol';
import { EngineError, type ViewportSize } from '@e2e-dev/core/engine';
import { releaseQuietly } from '../errors.ts';
import type { BidiConnection } from './connection.ts';
import { callFunction, type Wire } from './script.ts';

/** The sandbox realm a window's chrome is read in, where no script of the page replaces the sizes it reads. */
const WINDOW_SANDBOX = 'e2e-window';

/** How much larger the window is than the page that fills it: its toolbars and borders. Runs in the page. */
function windowChrome(): { width: number; height: number } {
  return { width: outerWidth - innerWidth, height: outerHeight - innerHeight };
}

/** The windows the attempt has sized a tab in, with the chrome of each. */
export class TabWindows {
  /**
   * Each window's chrome by its id, read from the first tab sized in it.
   * That tab has no viewport yet and fills the window, as every tab does
   * until the driver sizes it; once it has one, its page no longer tells
   * how large the window's content area is.
   */
  private readonly chrome = new Map<string, ViewportSize>();

  constructor(private readonly connection: BidiConnection) {}

  /**
   * Grows the window of tab `context` until its content area holds a page of
   * `viewport`'s size, before the tab is sized to it. A window that holds
   * one already is left as it is, so no window shrinks under a tab.
   * `UNSUPPORTED_CAPABILITY` when the window cannot grow that far: a headed
   * window ends at its display, a headless one at the browser's largest
   * window. It is then put back at the size it had, which holds the
   * viewport its tab has.
   */
  async hold(context: string, viewport: ViewportSize): Promise<void> {
    const open = await this.windowOf(context);
    const { clientWindow } = open;
    const chrome = this.chrome.get(clientWindow) ?? (await this.readChrome(context, clientWindow));
    const needed = { width: viewport.width + chrome.width, height: viewport.height + chrome.height };
    const holds = (window: ViewportSize): boolean => window.width >= needed.width && window.height >= needed.height;
    if (holds(open)) return;
    const resize = (width: number, height: number): Promise<Browser.ClientWindowInfo> => this.connection.send('browser.setClientWindowState', { clientWindow, state: 'normal', width, height });
    const grown = await resize(Math.max(open.width, needed.width), Math.max(open.height, needed.height));
    if (holds(grown)) return;
    await releaseQuietly(resize(open.width, open.height));
    const short = [
      ...(grown.width < needed.width ? [`${String(grown.width - chrome.width)} pixels of the page's width`] : []),
      ...(grown.height < needed.height ? [`${String(grown.height - chrome.height)} pixels of the page's height`] : []),
    ];
    throw new EngineError(
      'UNSUPPORTED_CAPABILITY',
      `the browser window cannot hold a ${String(viewport.width)}x${String(viewport.height)} viewport: it shows at most ${short.join(' and ')}, and pointer input reaches only what the window shows. `
        + 'A headed window ends at its display, a headless one at the browser\'s largest window; set a viewport that fits',
      { retryable: false },
    );
  }

  /** The window tab `context` is in, at its size now; `NODE_STALE` once the tab closed. */
  private async windowOf(context: string): Promise<Browser.ClientWindowInfo> {
    const { contexts } = await this.connection.send('browsingContext.getTree', { root: context, maxDepth: 0 });
    const { clientWindows } = await this.connection.send('browser.getClientWindows', {});
    const open = clientWindows.find((window) => window.clientWindow === contexts[0]?.clientWindow);
    if (open === undefined) throw new EngineError('NODE_STALE', 'the tab closed while its window was sized', { retryable: true });
    return open;
  }

  /** Reads the chrome of `clientWindow` from tab `context`, which fills it, and keeps it. */
  private async readChrome(context: string, clientWindow: string): Promise<ViewportSize> {
    const chrome = (await callFunction(this.connection, context, windowChrome, [], { sandbox: WINDOW_SANDBOX })) as Wire<ReturnType<typeof windowChrome>>;
    this.chrome.set(clientWindow, chrome);
    return chrome;
  }
}
