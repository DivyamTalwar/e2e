/**
 * An attempt that adopts the tab a browser already shows, in the browser's
 * own user context (`adopt-tab`), on a scripted peer: the documents it
 * prepares as it adopts the tab, and the tabs it closes when it ends.
 */

import { describe, expect, it } from 'vitest';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { ContextTree } from '../../src/driver/context-tree.ts';
import { routeEvents } from '../../src/driver/events.ts';
import { BidiSession, type SessionSettings } from '../../src/driver/session.ts';
import { ProtectedApp } from '../../src/protected-app.ts';
import { adoptable, contextInfo, FakeBidi, navigationInfo, settle } from '../helpers/bidi-fake.ts';

/** One browsing context as `getTree` lists it under the adopted tab. */
interface Listed {
  readonly context: string;
  readonly url?: string;
  readonly children?: readonly Listed[];
}

/**
 * A peer whose browser shows the one tab `theirs`, with `frames` in it. A
 * tree read of the whole browser lists the tab alone, one rooted at the tab
 * lists its frames too, and every context has a script context of its own.
 */
function showing(frames: readonly Listed[] = []): FakeBidi {
  const tab = { context: 'theirs', userContext: 'default', url: 'http://app.test/' };
  return adoptable(new FakeBidi(), 'theirs')
    .on('network.addDataCollector', { result: { collector: 'c' } })
    .on('browsingContext.getTree', (params) => ({ result: { contexts: [params['root'] === 'theirs' ? { ...tab, children: frames } : tab] } }))
    .on('script.getRealms', (params) => ({ result: { realms: [{ type: 'window', realm: 'r', origin: 'http://app.test', context: params['context'] }] } }));
}

/**
 * A session on `fake` that adopts the tab the browser shows, with no
 * viewport of its own, set up as `settings` say beside that, and told of the
 * browser's events as the running attempt is.
 */
function adopting(fake: FakeBidi, settings: Partial<SessionSettings> = {}): BidiSession {
  const all = { media: {}, viewport: null, initScripts: { forAttempt: () => [] }, permissions: [], userContext: 'adopt-tab', testIdAttribute: 'data-testid', ...settings };
  const attempt = { protectedApp: new ProtectedApp(new Set(), undefined, undefined), navigation: () => undefined };
  const tree = new ContextTree();
  tree.created('theirs', 'default', null);
  const session = new BidiSession({ connection: fake.connection, exclusive: false, traits: BROWSER_TRAITS.chromium } as never, all as never, attempt as never, tree);
  routeEvents(fake.connection, tree, () => session);
  return session;
}

/** The contexts the driver's own preloads were run in by hand (`prepareOpen`), each script in a `try` of its own. */
function prepared(fake: FakeBidi): string[] {
  return fake.commands('script.callFunction')
    .filter((command) => String(command.params['functionDeclaration']).startsWith('() => {\ntry {'))
    .map((command) => (command.params['target'] as { context: string }).context);
}

/**
 * Has the page of the adopted tab open three tabs on `fake`, which lists
 * every open tab from then on and drops one as it is closed: `joined`, whose
 * document loaded, `loading`, still waiting on its first, and `nowhere`,
 * whose only navigation got none.
 */
async function appOpensTabs(fake: FakeBidi): Promise<void> {
  const open = ['theirs'];
  fake
    .on('browsingContext.getTree', () => ({ result: { contexts: open.map((context) => ({ context, userContext: 'default', url: `http://app.test/${context}`, children: [] })) } }))
    .on('browsingContext.close', (params) => {
      open.splice(open.indexOf(String(params['context'])), 1);
      return { result: {} };
    });
  for (const popup of ['joined', 'loading', 'nowhere']) {
    open.push(popup);
    fake.emit('browsingContext.contextCreated', contextInfo(popup, { userContext: 'default', originalOpener: 'theirs' }));
    fake.emit('browsingContext.navigationStarted', navigationInfo(popup, `http://app.test/${popup}`));
  }
  fake.emit('browsingContext.domContentLoaded', navigationInfo('joined', 'http://app.test/joined'));
  fake.emit('browsingContext.navigationFailed', navigationInfo('nowhere', 'http://app.test/nowhere'));
  await settle();
}

/** The tabs the driver asked the browser to close, in order. */
function closedTabs(fake: FakeBidi): unknown[] {
  return fake.commands('browsingContext.close').map((command) => command.params['context']);
}

describe('the tabs an attempt closes in a browser it adopted a tab of', () => {
  it('are, at its end, every tab the app opened, joined or not, and never the tab it adopted', async () => {
    const fake = showing();
    const attached = adopting(fake);
    await attached.openUserContext(new AbortController().signal);
    await appOpensTabs(fake);
    expect(attached.tabs.list().map((tab) => tab.context)).toEqual(['theirs', 'joined']);
    await attached.close();
    expect(closedTabs(fake)).toEqual(['joined', 'loading', 'nowhere']);
  });

  it('are the same at a restart, which shows the adopted tab again', async () => {
    const fake = showing();
    const attached = adopting(fake);
    await attached.openUserContext(new AbortController().signal);
    await appOpensTabs(fake);
    await attached.replaceTabs(new AbortController().signal);
    expect(closedTabs(fake)).toEqual(['joined', 'loading', 'nowhere']);
    expect(attached.tabs.list().map((tab) => tab.context)).toEqual(['theirs']);
  });
});

describe('adopting the tab a browser shows', () => {
  it('runs the driver\'s preloads in the tab and each frame it shows', async () => {
    const fake = showing([{ context: 'frame', children: [{ context: 'nested' }] }]);
    const attached = adopting(fake);
    await attached.openUserContext(new AbortController().signal);
    expect(attached.context).toBe('theirs');
    expect(prepared(fake)).toEqual(['theirs', 'frame', 'nested']);
  });

  it('adopts a tab whose frame went away while its documents were listed, and prepares the documents left', async () => {
    const fake = showing([{ context: 'removed' }, { context: 'frame' }]);
    fake.on('script.getRealms', (params) => (params['context'] === 'removed'
      ? { error: 'no such frame', message: 'Context removed not found' }
      : { result: { realms: [{ type: 'window', realm: 'r', origin: 'http://app.test', context: params['context'] }] } }));
    const attached = adopting(fake);
    await attached.openUserContext(new AbortController().signal);
    expect(attached.context).toBe('theirs');
    expect(fake.commands('script.getRealms').map((command) => command.params['context'])).toEqual(['theirs', 'removed', 'frame']);
    expect(prepared(fake)).toEqual(['theirs', 'frame']);
  });
});
