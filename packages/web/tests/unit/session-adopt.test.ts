/**
 * An attempt that adopts the tab a browser already shows, in the browser's
 * own user context (`adopt-tab`), on a scripted peer: the documents it
 * prepares as it adopts the tab.
 */

import { describe, expect, it } from 'vitest';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { ContextTree } from '../../src/driver/context-tree.ts';
import { BidiSession, type SessionSettings } from '../../src/driver/session.ts';
import { ProtectedApp } from '../../src/protected-app.ts';
import { adoptable, FakeBidi } from '../helpers/bidi-fake.ts';

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

/** A session on `fake` that adopts the tab the browser shows, with no viewport of its own, set up as `settings` say beside that. */
function adopting(fake: FakeBidi, settings: Partial<SessionSettings> = {}): BidiSession {
  const all = { media: {}, viewport: null, initScripts: { forAttempt: () => [] }, permissions: [], userContext: 'adopt-tab', testIdAttribute: 'data-testid', ...settings };
  const attempt = { protectedApp: new ProtectedApp(new Set(), undefined, undefined) };
  return new BidiSession({ connection: fake.connection, exclusive: false, traits: BROWSER_TRAITS.chromium } as never, all as never, attempt as never, new ContextTree());
}

/** The contexts the driver's own preloads were run in by hand (`prepareOpen`), each script in a `try` of its own. */
function prepared(fake: FakeBidi): string[] {
  return fake.commands('script.callFunction')
    .filter((command) => String(command.params['functionDeclaration']).startsWith('() => {\ntry {'))
    .map((command) => (command.params['target'] as { context: string }).context);
}

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
