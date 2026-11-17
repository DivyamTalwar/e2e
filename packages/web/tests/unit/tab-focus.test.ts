/**
 * Which page holds focus, over a scripted peer: on Chromium every tab of the
 * attempt is told to behave as focused when it opens (its own, one a test
 * opens, the one it adopts, one the app opens); on Firefox, where only the
 * tab at the front holds focus, a tab that lost it is brought to the front
 * before keys go to it.
 */

import { describe, expect, it } from 'vitest';
import { ContextTree } from '../../src/driver/context-tree.ts';
import { routeEvents } from '../../src/driver/events.ts';
import { fixtureKeyStroke } from '../../src/driver/keyboard.ts';
import { BidiSession } from '../../src/driver/session.ts';
import { BROWSER_TRAITS, type BrowserName } from '../../src/browsers.ts';
import type { UserContextMode } from '../../src/driver/user-context.ts';
import { ProtectedApp } from '../../src/protected-app.ts';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';

/**
 * A session on `browser` with its events routed and its first tab open:
 * `tab`, or the tab `theirs` it finds open when it adopts one. `fake`
 * announces each tab it opens, as a browser does, names a tab's CDP session
 * after it, and answers whether a tab's document holds focus from `focused`.
 */
async function session(fake: FakeBidi, browser: BrowserName, userContext: UserContextMode = 'fresh', focused: () => boolean = () => true): Promise<BidiSession> {
  const tree = new ContextTree();
  const tabs = ['tab', 'tab-2'];
  fake
    .on('browser.createUserContext', { result: { userContext: 'mine' } })
    .on('network.addDataCollector', { result: { collector: 'c' } })
    .on('browsingContext.getTree', { result: { contexts: [{ context: 'theirs', userContext: 'default' }] } })
    .on('browsingContext.create', () => {
      const context = tabs.shift();
      fake.emit('browsingContext.contextCreated', { context, userContext: 'mine', parent: null });
      return { result: { context } };
    })
    .on('goog:cdp.getSession', (params) => ({ result: { session: `cdp of ${String(params['context'])}` } }))
    .on('script.callFunction', () => ({ result: { type: 'success', realm: 'r', result: { type: 'boolean', value: focused() } } }));
  const settings = { media: {}, viewport: null, initScripts: { forAttempt: () => [] }, permissions: [], userContext, testIdAttribute: 'data-testid' };
  const attempt = { protectedApp: new ProtectedApp(new Set(), undefined, undefined) };
  const opened = new BidiSession({ connection: fake.connection, exclusive: true, traits: { ...BROWSER_TRAITS[browser], windowClipsViewport: false } } as never, settings as never, attempt as never, tree);
  routeEvents(fake.connection, tree, () => opened);
  await opened.openUserContext(new AbortController().signal);
  await opened.ensureContext();
  return opened;
}

/** The CDP sessions `fake` was told to emulate focus on, in order. */
function emulated(fake: FakeBidi): unknown[] {
  return fake.commands('goog:cdp.sendCommand')
    .filter((command) => command.params['method'] === 'Emulation.setFocusEmulationEnabled')
    .map((command) => ({ session: command.params['session'], ...(command.params['params'] as object) }));
}

/** A tab the app opened from `tab`, as the browser announces it. */
function popup(fake: FakeBidi, context: string): void {
  fake.emit('browsingContext.contextCreated', { context, userContext: 'mine', parent: null, originalOpener: 'tab', url: 'about:blank', children: null });
}

describe('focus on Chromium', () => {
  it('has the attempt\'s own tab, a tab a test opens, and a tab the app opens each behave as focused, once', async () => {
    const fake = new FakeBidi();
    const held = await session(fake, 'chromium');
    expect(emulated(fake)).toEqual([{ session: 'cdp of tab', enabled: true }]);
    await held.newTab();
    popup(fake, 'popup');
    await settle();
    expect(emulated(fake)).toEqual([
      { session: 'cdp of tab', enabled: true },
      { session: 'cdp of tab-2', enabled: true },
      { session: 'cdp of popup', enabled: true },
    ]);
  });

  it('has the tab it adopts behave as focused', async () => {
    const fake = new FakeBidi();
    await session(fake, 'chromium', 'adopt-tab');
    expect(emulated(fake)).toEqual([{ session: 'cdp of theirs', enabled: true }]);
  });

  it('leaves a tab of another user context, and a frame, as they are', async () => {
    const fake = new FakeBidi();
    await session(fake, 'chromium');
    fake.emit('browsingContext.contextCreated', { context: 'elsewhere', userContext: 'other', parent: null, originalOpener: 'tab', url: 'about:blank', children: null });
    fake.emit('browsingContext.contextCreated', { context: 'frame', parent: 'tab', url: 'about:blank', children: null });
    await settle();
    expect(emulated(fake)).toEqual([{ session: 'cdp of tab', enabled: true }]);
  });

  it('closes a tab it could not have behave as focused, and fails the open', async () => {
    const fake = new FakeBidi().on('goog:cdp.sendCommand', { error: 'unknown error', message: 'no emulation' });
    await expect(session(fake, 'chromium')).rejects.toThrow('no emulation');
    expect(fake.commands('browsingContext.close').map((command) => command.params['context'])).toEqual(['tab']);
  });

  it('counts a tab the app opened and closed before it was told as nothing, and fails the next step when a tab still open cannot be told', async () => {
    const fake = new FakeBidi();
    const held = await session(fake, 'chromium');
    fake.on('goog:cdp.sendCommand', (params) => {
      if (params['session'] === 'cdp of popup') fake.emit('browsingContext.contextDestroyed', { context: 'popup', userContext: 'mine', parent: null });
      return { error: 'unknown error', message: `Unknown CDP session ID: ${String(params['session'])}` };
    });
    popup(fake, 'popup');
    await settle();
    expect(() => held.latch.throwPending()).not.toThrow();
    popup(fake, 'popup-2');
    await settle();
    expect(() => held.latch.throwPending()).toThrow('Unknown CDP session ID: cdp of popup-2');
  });

  it('sends keys without asking whether the tab holds focus', async () => {
    const fake = new FakeBidi();
    const held = await session(fake, 'chromium');
    await held.input.key(fixtureKeyStroke('F5', 'press'));
    expect(fake.commands('script.callFunction')).toEqual([]);
    expect(fake.commands('browsingContext.activate')).toEqual([]);
  });
});

describe('focus on Firefox', () => {
  it('emulates no focus: the launch preference gives the tab at the front the browser\'s', async () => {
    const fake = new FakeBidi();
    const held = await session(fake, 'firefox');
    await held.newTab();
    popup(fake, 'popup');
    await settle();
    expect(fake.commands('goog:cdp.sendCommand')).toEqual([]);
    expect(fake.commands('goog:cdp.getSession')).toEqual([]);
  });

  it('brings a tab that lost focus to the front before keys go to it, and leaves one that holds it where it is', async () => {
    let focused = false;
    const fake = new FakeBidi();
    const held = await session(fake, 'firefox', 'fresh', () => focused);
    await held.input.key(fixtureKeyStroke('a', 'press'));
    expect(fake.sent.filter((command) => ['browsingContext.activate', 'input.performActions'].includes(command.method)).map((command) => `${command.method} ${String(command.params['context'])}`))
      .toEqual(['browsingContext.activate tab', 'input.performActions tab']);
    focused = true;
    await held.input.key(fixtureKeyStroke('b', 'press'));
    expect(fake.commands('browsingContext.activate')).toHaveLength(1);
    expect(fake.commands('input.performActions')).toHaveLength(2);
  });

  it('brings the tab to the front before text is inserted in it', async () => {
    const fake = new FakeBidi();
    const held = await session(fake, 'firefox', 'fresh', () => false);
    await held.input.holdFocus();
    expect(fake.commands('browsingContext.activate').map((command) => command.params['context'])).toEqual(['tab']);
  });
});
