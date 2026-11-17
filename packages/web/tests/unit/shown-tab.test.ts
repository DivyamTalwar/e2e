/**
 * The tab an attempt adopts (`shownTab`), told from what the browser
 * reports: a plain `page` target of the attempt's user context, the visible
 * one of several, and a refusal that names the tabs when none stands out.
 */

import { describe, expect, it } from 'vitest';
import { shownTab } from '../../src/driver/shown-tab.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';

/** One top-level context as the browser reports it: its CDP target, its user context, and whether its document is visible. */
interface Reported {
  readonly context: string;
  readonly type: string;
  readonly subtype?: string;
  readonly userContext?: string;
  readonly visible?: boolean;
  /** Its browsing context is gone by the time its document is read. */
  readonly gone?: boolean;
}

/** A browser that reports `open`, in that order. */
function browserWith(open: readonly Reported[]): FakeBidi {
  return new FakeBidi()
    .on('browsingContext.getTree', {
      result: { contexts: open.map((each) => ({ context: each.context, url: `http://app.test/${each.context}`, userContext: each.userContext ?? 'default', children: null })) },
    })
    .on('goog:cdp.sendCommand', {
      result: { result: { targetInfos: open.map((each) => ({ targetId: each.context, type: each.type, ...(each.subtype === undefined ? {} : { subtype: each.subtype }) })) } },
    })
    .on('script.callFunction', (params) => {
      const reported = open.find((each) => each.context === (params['target'] as { context: string }).context)!;
      if (reported.gone) return { error: 'no such frame' };
      return { result: { type: 'success', realm: 'r', result: { type: 'boolean', value: reported.visible ?? false } } };
    });
}

describe('shownTab', () => {
  it('is the one page target, wherever it stands among a prerendered page and a DevTools front-end, with no document read', async () => {
    const fake = browserWith([
      { context: 'prerender', type: 'page', subtype: 'prerender', visible: true },
      { context: 'devtools', type: 'other', visible: true },
      { context: 'tab', type: 'page' },
    ]);
    expect(await shownTab(fake.connection, 'default', undefined)).toBe('tab');
    expect(fake.commands('script.callFunction')).toEqual([]);
  });

  it('is undefined when no tab is open in the user context', async () => {
    const fake = browserWith([{ context: 'theirs', type: 'page', userContext: 'other', visible: true }, { context: 'prerender', type: 'page', subtype: 'prerender' }]);
    expect(await shownTab(fake.connection, 'default', undefined)).toBeUndefined();
  });

  it('is the only visible tab of several, and never a tab of another user context', async () => {
    const fake = browserWith([
      { context: 'background', type: 'page' },
      { context: 'theirs', type: 'page', userContext: 'other', visible: true },
      { context: 'shown', type: 'page', visible: true },
      { context: 'closing', type: 'page', gone: true },
    ]);
    expect(await shownTab(fake.connection, 'default', undefined)).toBe('shown');
    expect(fake.commands('script.callFunction').map((command) => (command.params['target'] as { context: string }).context)).toEqual(['background', 'shown', 'closing']);
  });

  it('stays the tab adopted before while it is open, whatever is visible, and is chosen again once it closed', async () => {
    const open = [{ context: 'adopted', type: 'page' }, { context: 'opened', type: 'page', visible: true }];
    const fake = browserWith(open);
    expect(await shownTab(fake.connection, 'default', 'adopted')).toBe('adopted');
    expect(fake.commands('script.callFunction')).toEqual([]);
    expect(await shownTab(browserWith(open.slice(1)).connection, 'default', 'adopted')).toBe('opened');
  });

  it('refuses several visible tabs, naming every open one', async () => {
    const fake = browserWith([{ context: 'a', type: 'page', visible: true }, { context: 'b', type: 'page', visible: true }, { context: 'c', type: 'page' }]);
    await expect(shownTab(fake.connection, 'default', undefined)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'cannot tell which tab of the attached browser to drive: 3 are open (http://app.test/a, http://app.test/b, http://app.test/c) and 2 of them are visible. Leave one tab visible, or close the others.',
    });
  });

  it('refuses several tabs when none is visible', async () => {
    const fake = browserWith([{ context: 'a', type: 'page' }, { context: 'b', type: 'page' }]);
    await expect(shownTab(fake.connection, 'default', undefined)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'cannot tell which tab of the attached browser to drive: 2 are open (http://app.test/a, http://app.test/b) and none of them is visible. Leave one tab visible, or close the others.',
    });
  });
});
