/**
 * What an attempt finds open in a Chromium it did not open, and which tab
 * of it the attempt adopts: the one a person sees there, told by what the
 * browser reports about each tab, never by where a tab stands in a list.
 */

import { EngineError } from '@e2e-dev/core/engine';
import { unlessStale } from '../errors.ts';
import { ChromiumCdp } from './cdp.ts';
import type { BidiConnection } from './connection.ts';
import { callFunction } from './script.ts';

/** Whether a person can see the document: false in a background tab, and in a window that is minimized, hidden, or covered. */
const documentVisible = (): boolean => document.visibilityState === 'visible';

/** What an attempt that adopts a tab finds open in the browser's user context. */
export interface FoundTabs {
  /** The tab a person sees, which the attempt adopts; undefined when no tab is open. */
  readonly shown: string | undefined;
  /** Every top-level context open there, `shown` and what is no tab included. */
  readonly all: readonly string[];
}

/**
 * Reads what is open in `userContext` and which tab of it a person sees.
 * `adopted`, the tab the attempt adopted before, is that one for as long as
 * it is open: the attempt shows its own tabs beside it, and a restart
 * returns to it.
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
export async function foundTabs(connection: BidiConnection, userContext: string, adopted: string | undefined): Promise<FoundTabs> {
  const [{ contexts }, { targetInfos }] = await Promise.all([
    connection.send('browsingContext.getTree', { maxDepth: 0 }),
    ChromiumCdp.browser(connection).send('Target.getTargets', {}),
  ]);
  const pages = new Set(targetInfos.filter((target) => target.type === 'page' && target.subtype === undefined).map((target) => target.targetId));
  const open = contexts.filter((info) => info.userContext === userContext);
  const all = open.map((info) => info.context);
  const tabs = open.filter((info) => pages.has(info.context));
  if (tabs.some((tab) => tab.context === adopted)) return { shown: adopted, all };
  if (tabs.length < 2) return { shown: tabs[0]?.context, all };
  const visible = await Promise.all(tabs.map((tab) => unlessStale(callFunction(connection, tab.context, documentVisible), false)));
  const shown = tabs.filter((_tab, index) => visible[index]);
  if (shown.length === 1) return { shown: shown[0]!.context, all };
  throw new EngineError(
    'UNSUPPORTED_CAPABILITY',
    `cannot tell which tab of the attached browser to drive: ${String(tabs.length)} are open (${tabs.map((tab) => tab.url).join(', ')}) and ${shown.length === 0 ? 'none' : String(shown.length)} of them ${shown.length === 0 ? 'is' : 'are'} visible. Leave one tab visible, or close the others.`,
    { retryable: false },
  );
}
