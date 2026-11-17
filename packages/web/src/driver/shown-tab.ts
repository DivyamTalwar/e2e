/**
 * Which tab an attempt adopts in a Chromium it did not open: the one a
 * person sees there, told by what the browser reports about each tab, never
 * by where a tab stands in a list.
 */

import { EngineError } from '@e2e-dev/core/engine';
import { unlessStale } from '../errors.ts';
import { ChromiumCdp } from './cdp.ts';
import type { BidiConnection } from './connection.ts';
import { callFunction } from './script.ts';

/** Whether a person can see the document: false in a background tab, and in a window that is minimized, hidden, or covered. */
const documentVisible = (): boolean => document.visibilityState === 'visible';

/**
 * The tab open in `userContext` that a person sees, or undefined when none
 * is open there. `adopted`, the tab the attempt adopted before, is the one
 * for as long as it is open: the attempt shows its own tabs beside it, and a
 * restart returns to it.
 *
 * A top-level browsing context is a tab only when Chromium lists its target
 * as a plain `page`. The BiDi mapper also reports as top-level contexts a
 * page being prerendered (full Chrome prerenders its search page in every
 * window) and a DevTools front-end, in no order that means anything; neither
 * is a tab a person opened.
 *
 * One tab is the one. Of several, it is the only one whose document is
 * visible. When several are visible (two windows, or a headless shell, which
 * shows every tab), or none is (every window covered), nothing the browser
 * reports singles one out, and the adoption is refused, naming them.
 */
export async function shownTab(connection: BidiConnection, userContext: string, adopted: string | undefined): Promise<string | undefined> {
  const [{ contexts }, { targetInfos }] = await Promise.all([
    connection.send('browsingContext.getTree', { maxDepth: 0 }),
    ChromiumCdp.browser(connection).send('Target.getTargets', {}),
  ]);
  const pages = new Set(targetInfos.filter((target) => target.type === 'page' && target.subtype === undefined).map((target) => target.targetId));
  const tabs = contexts.filter((info) => info.userContext === userContext && pages.has(info.context));
  if (tabs.some((tab) => tab.context === adopted)) return adopted;
  if (tabs.length < 2) return tabs[0]?.context;
  const visible = await Promise.all(tabs.map((tab) => unlessStale(callFunction(connection, tab.context, documentVisible), false)));
  const shown = tabs.filter((_tab, index) => visible[index]);
  if (shown.length === 1) return shown[0]!.context;
  throw new EngineError(
    'UNSUPPORTED_CAPABILITY',
    `cannot tell which tab of the attached browser to drive: ${String(tabs.length)} are open (${tabs.map((tab) => tab.url).join(', ')}) and ${shown.length === 0 ? 'none' : String(shown.length)} of them ${shown.length === 0 ? 'is' : 'are'} visible. Leave one tab visible, or close the others.`,
    { retryable: false },
  );
}
