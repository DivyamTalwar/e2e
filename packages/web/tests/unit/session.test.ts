/** A BiDi session's own state: the input it sends (held keys through chords and modifier clicks until their `keyboard.up`, pressure, the viewport bound, what counts as dispatched), refs a locate just proved, and a user context that opens after the attempt closed. */

import { describe, expect, it, vi } from 'vitest';
import { ContextTree } from '../../src/driver/context-tree.ts';
import { clickSources, moveSources, pressDownSources, swipeSources, typeSource } from '../../src/driver/input-sources.ts';
import { fixtureKeyStroke, strokeSource, type KeyPhase } from '../../src/driver/keyboard.ts';
import { BidiSession } from '../../src/driver/session.ts';
import { BROWSER_TRAITS, type BrowserName } from '../../src/browsers.ts';
import type { UserContextMode } from '../../src/driver/user-context.ts';
import { ProtectedApp } from '../../src/protected-app.ts';
import type { NodeRef } from '@e2e-dev/core/engine';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';
import type { ElementRef } from '../../src/driver/script.ts';

const SHIFT = '';

/** A session on `fake` that has opened nothing yet, on a 100 by 100 viewport, in a user context of its own unless `userContext` says otherwise. */
function unopened(fake: FakeBidi, browser: BrowserName = 'chromium', userContext: UserContextMode = 'fresh'): BidiSession {
  const settings = { media: {}, viewport: { width: 100, height: 100 }, initScripts: { forAttempt: () => [] }, permissions: [], userContext };
  const attempt = { protectedApp: new ProtectedApp(new Set(), undefined, undefined) };
  return new BidiSession({ connection: fake.connection, exclusive: true, traits: BROWSER_TRAITS[browser] } as never, settings as never, attempt as never, new ContextTree());
}

/** A session on `fake` with its user context and its tab `tab` open; the tab it opens next is `tab-2`. */
async function session(fake: FakeBidi, browser: BrowserName = 'chromium'): Promise<BidiSession> {
  const tabs = ['tab', 'tab-2'];
  fake
    .on('browser.createUserContext', { result: { userContext: 'mine' } })
    .on('network.addDataCollector', { result: { collector: 'c' } })
    .on('browsingContext.create', () => ({ result: { context: tabs.shift() } }));
  const opened = unopened(fake, browser);
  await opened.openUserContext(new AbortController().signal);
  await opened.ensureContext();
  return opened;
}

/** The BiDi key source of one `browser.keyboard` call, with Shift held before it or not. */
function keySource(key: string, phase: KeyPhase, shiftHeld: boolean) {
  return strokeSource(fixtureKeyStroke(key, phase), shiftHeld);
}

/** Each `input.performActions` call's key actions. */
function keyActions(fake: FakeBidi): { type: string; value?: string }[][] {
  return fake.commands('input.performActions').map((command) =>
    (command.params['actions'] as { type: string; actions: { type: string; value?: string }[] }[]).filter((source) => source.type === 'key').flatMap((source) => source.actions));
}

describe('BidiInput.send', () => {
  it('neither presses nor releases a modifier the test holds, and lets its own up release it', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    await held.input.send([keySource('Shift+ArrowRight', 'press', true)]);
    await held.input.send(clickSources(5, 5, { modifiers: ['Shift'] }));
    await held.input.send([keySource('Shift', 'keyUp', true)]);
    const keys = keyActions(fake);
    expect(keys[0]).toEqual([{ type: 'keyDown', value: SHIFT }]);
    expect(keys[1]!.some((action) => action.value === SHIFT)).toBe(false);
    expect(keys[2]!.some((action) => action.value === SHIFT)).toBe(false);
    expect(keys[3]).toEqual([{ type: 'keyUp', value: SHIFT }]);
  });

  it('keeps a click’s ticks when a held modifier joins one it adds', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    const click = clickSources(5, 5, { modifiers: ['Shift', 'Control'] });
    await held.input.send(click);
    const sentKeys = keyActions(fake).at(-1)!;
    const askedKeys = (click.find((source) => source.type === 'key') as { actions: unknown[] }).actions;
    expect(sentKeys).toHaveLength(askedKeys.length);
    expect(sentKeys.filter((action) => action.value === SHIFT)).toEqual([]);
    expect(sentKeys.filter((action) => action.value === '').map((action) => action.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('releases a key with the value that pressed it, after the Shift that changed it is gone', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    for (const [key, phase] of [['Shift', 'keyDown'], ['a', 'keyDown'], ['Shift', 'keyUp'], ['a', 'keyUp']] as const) await held.input.key(fixtureKeyStroke(key, phase));
    expect(keyActions(fake).flat()).toEqual([
      { type: 'keyDown', value: SHIFT },
      { type: 'keyDown', value: 'A' },
      { type: 'keyUp', value: SHIFT },
      { type: 'keyUp', value: 'A' },
    ]);
  });

  it('records what a send holds only once the browser took it', async () => {
    let refuse = true;
    const fake = new FakeBidi().on('input.performActions', () => (refuse ? { error: 'invalid argument', message: 'no' } : { result: {} }));
    const held = await session(fake);
    await expect(held.input.send([keySource('Shift', 'keyDown', false)])).rejects.toThrow('no');
    refuse = false;
    await held.input.send(clickSources(5, 5, { modifiers: ['Shift'] }));
    expect(keyActions(fake).at(-1)!.filter((action) => action.value === SHIFT).map((action) => action.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('moves with pressure only while a button is held, and remembers where the mouse went', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    await held.input.send(moveSources(10, 10));
    await held.input.send(pressDownSources(20, 20));
    await held.input.send(moveSources(30, 30));
    const moves = fake.commands('input.performActions').map((command) => (command.params['actions'] as { actions: { type: string; pressure?: number }[] }[])[0]!.actions[0]!.pressure);
    expect(moves).toEqual([undefined, undefined, 0.5]);
    expect(held.input.pointer).toEqual({ x: 30, y: 30 });
  });

  it('moves the mouse to where a swipe wheels, in the same call', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    await held.input.send(swipeSources(40, 60, 0, 50));
    expect(held.input.pointer).toEqual({ x: 40, y: 60 });
    expect(fake.commands('input.performActions')).toHaveLength(1);
  });

  it('refuses a pointer target outside the viewport before sending, as not dispatched, on either browser', async () => {
    for (const browser of ['chromium', 'firefox'] as const) {
      // Firefox waits for a shown frame before pointer input; the page has one.
      const fake = new FakeBidi()
        .on('input.performActions', { result: {} })
        .on('script.callFunction', { result: { type: 'success', realm: 'r', result: { type: 'boolean', value: true } } });
      const held = await session(fake, browser);
      for (const [x, y] of [[-1, -1], [101, 10], [10, 101]] as const) {
        await expect(held.input.send(moveSources(x, y))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('outside the 100x100 viewport') });
        await expect(held.input.send(swipeSources(x, y, 0, 10))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      expect(held.input.dispatches).toBe(0);
      expect(fake.commands('input.performActions')).toEqual([]);
      await held.input.send(clickSources(100, 100));
      expect(held.input.dispatches).toBe(1);
    }
  });

  it('brings a hidden tab to the front before Firefox pointer input, which the parent process sends to the tab on screen', async () => {
    let shown = false;
    const fake = new FakeBidi()
      .on('input.performActions', { result: {} })
      .on('browsingContext.activate', () => {
        shown = true;
        return { result: {} };
      })
      .on('script.callFunction', () => ({ result: { type: 'success', realm: 'r', result: shown ? { type: 'undefined' } : { type: 'boolean', value: false } } }));
    const held = await session(fake, 'firefox');
    await held.input.send(clickSources(5, 5));
    await held.input.send([typeSource('a')]);
    expect(fake.commands('browsingContext.activate').map((command) => command.params)).toEqual([{ context: 'tab' }]);
    expect(fake.commands('input.performActions')).toHaveLength(2);
  });

  it('counts input the page suppressed as not dispatched, and input it saw or a failed send as dispatched', async () => {
    let fail = false;
    const fake = new FakeBidi().on('input.performActions', () => (fail ? { error: 'unknown error', message: 'gone' } : { result: {} }));
    const held = await session(fake);
    const suppressed = (verdict: string | null): boolean => verdict === 'covered';
    await held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), async () => 'covered', suppressed);
    expect(held.input.dispatches).toBe(0);
    await held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), async () => null, suppressed);
    expect(held.input.dispatches).toBe(1);
    fail = true;
    await expect(held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), async () => 'covered', suppressed)).rejects.toThrow('gone');
    expect(held.input.dispatches).toBe(2);
  });

  it('takes input whose tab closed under it (a click that closes its own tab) as dispatched, not failed', async () => {
    const fake = new FakeBidi().on('input.performActions', { error: 'no such frame', message: 'Browsing context is gone' });
    const held = await session(fake);
    await expect(held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), async () => null, (verdict) => verdict !== null)).resolves.toBeNull();
    expect(held.input.dispatches).toBe(1);
  });

  it('counts input whose verdict never comes as dispatched, so an operation timing out on it may have committed', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    void held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), () => new Promise<never>(() => undefined), () => true);
    await vi.waitFor(() => expect(fake.commands('input.performActions')).toHaveLength(1));
    expect(held.input.dispatches).toBe(1);
  });

  it('sends a key WebDriver has no value for as CDP key events that carry the modifiers BiDi holds', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} }).on('goog:cdp.getSession', { result: { session: 'cdp' } }).on('goog:cdp.sendCommand', { result: {} });
    const held = await session(fake);
    await held.input.key(fixtureKeyStroke('Shift', 'keyDown'));
    await held.input.key(fixtureKeyStroke('MediaPlayPause', 'press'));
    await held.input.key(fixtureKeyStroke('Shift', 'keyUp'));
    expect(fake.commands('input.performActions')).toHaveLength(2);
    const cdp = fake.commands('goog:cdp.sendCommand').map((command) => command.params as { method: string; session: string; params: { type: string; modifiers: number } });
    expect(cdp.map((command) => [command.session, command.params.type, command.params.modifiers])).toEqual([['cdp', 'rawKeyDown', 8], ['cdp', 'keyUp', 8]]);
  });

  it('forgets held keys with the tab that held them', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    held.contextClosed('tab');
    await held.ensureContext();
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    expect(keyActions(fake).at(-1)).toEqual([{ type: 'keyDown', value: SHIFT }]);
  });
});

describe('BidiSession.refs', () => {
  it('claims a located ref as fresh once, and only while no input went out since its locate', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    const target = { element: { sharedId: 'e' } as ElementRef, context: 'tab', locator: { kind: 'selector', selector: '#a' } as const };
    held.refs.storeLocated('1', target);
    held.refs.storeLocated('2', target);
    expect(held.refs.claimFresh({ id: '1' } as NodeRef)).toBe(true);
    expect(held.refs.claimFresh({ id: '1' } as NodeRef)).toBe(false);
    await held.input.send(moveSources(1, 1));
    expect(held.refs.claimFresh({ id: '2' } as NodeRef)).toBe(false);
  });
});

/** The contexts `fake` was asked to close, in order. */
function closedTabs(fake: FakeBidi): unknown[] {
  return fake.commands('browsingContext.close').map((command) => command.params['context']);
}

/** The tab commands `fake` got, in order, each with its context. */
function tabCommands(fake: FakeBidi): string[] {
  return fake.sent
    .filter((command) => ['browsingContext.create', 'browsingContext.setViewport', 'browsingContext.activate'].includes(command.method))
    .map((command) => `${command.method.replace('browsingContext.', '')} ${String(command.params['context'] ?? '')}`.trim());
}

describe('BidiSession tabs', () => {
  it('opens its first tab at the viewport without activating it, and a tab opened beside it at the front', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    expect(tabCommands(fake)).toEqual(['create', 'setViewport tab']);
    const beside = await held.newTab();
    expect(tabCommands(fake).slice(2)).toEqual(['create', 'setViewport tab-2', 'activate tab-2']);
    expect(held.context).toBe('tab-2');
    expect(held.tabs.list().map((tab) => tab.context)).toEqual(['tab', 'tab-2']);
    expect(held.tabs.active()).toBe(beside);
  });

  it('answers its own tab to a newTab before any tab is open, opened once', async () => {
    const fake = new FakeBidi()
      .on('browser.createUserContext', { result: { userContext: 'mine' } })
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.create', { result: { context: 'tab' } });
    const opening = unopened(fake);
    await opening.openUserContext(new AbortController().signal);
    const [context, tab] = await Promise.all([opening.ensureContext(), opening.newTab()]);
    expect(context).toBe('tab');
    expect(opening.tabs.list()).toEqual([tab]);
    expect(fake.commands('browsingContext.create')).toHaveLength(1);
  });

  it('closes a tab it created that it cannot show, and opens another on the next use', async () => {
    let refuse = true;
    const fake = new FakeBidi().on('browsingContext.setViewport', () => (refuse ? { error: 'unknown error', message: 'no viewport' } : { result: {} }));
    const opened = ['tab', 'tab-2'];
    fake
      .on('browser.createUserContext', { result: { userContext: 'mine' } })
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.create', () => ({ result: { context: opened.shift() } }));
    const opening = unopened(fake);
    await opening.openUserContext(new AbortController().signal);
    await expect(opening.ensureContext()).rejects.toThrow('no viewport');
    expect(closedTabs(fake)).toEqual(['tab']);
    expect(opening.context).toBeUndefined();
    expect(opening.tabs.list()).toEqual([]);
    refuse = false;
    await expect(opening.ensureContext()).resolves.toBe('tab-2');
    expect(opening.tabs.list().map((tab) => tab.context)).toEqual(['tab-2']);
  });

  it('closes a tab a newTab created that it cannot show, and keeps showing the tab before it', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    fake.on('browsingContext.activate', { error: 'unknown error', message: 'no focus' });
    await expect(held.newTab()).rejects.toThrow('no focus');
    expect(closedTabs(fake)).toEqual(['tab-2']);
    expect(held.context).toBe('tab');
    expect(held.tabs.list().map((tab) => tab.context)).toEqual(['tab']);
  });

  it('closes a tab it created when the network cannot cover it', async () => {
    const tree = new ContextTree();
    const fake = new FakeBidi()
      .on('browser.createUserContext', { result: { userContext: 'mine' } })
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('session.subscribe', { result: { subscription: 's' } })
      .on('network.addIntercept', { error: 'unknown error', message: 'no intercept' })
      .on('browsingContext.create', () => {
        tree.created('tab', 'mine', null);
        return { result: { context: 'tab' } };
      });
    const settings = { media: {}, viewport: null, initScripts: { forAttempt: () => [] }, permissions: [], userContext: 'fresh' };
    const attempt = { protectedApp: new ProtectedApp(new Set(['http://app.test']), { 'x-preview': 'on' }, undefined) };
    const shared = new BidiSession({ connection: fake.connection, exclusive: false, traits: BROWSER_TRAITS.chromium } as never, settings as never, attempt as never, tree);
    await shared.openUserContext(new AbortController().signal);
    await expect(shared.ensureContext()).rejects.toThrow('no intercept');
    expect(closedTabs(fake)).toEqual(['tab']);
    expect(shared.tabs.list()).toEqual([]);
  });

  it('leaves a tab it adopted open when it cannot show it, and adopts it again on the next use', async () => {
    let refuse = true;
    const fake = new FakeBidi()
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.getTree', { result: { contexts: [{ context: 'theirs', userContext: 'default' }] } })
      .on('browsingContext.setViewport', () => (refuse ? { error: 'unknown error', message: 'no viewport' } : { result: {} }));
    const attached = unopened(fake, 'chromium', 'adopt-tab');
    await expect(attached.openUserContext(new AbortController().signal)).rejects.toThrow('no viewport');
    expect(closedTabs(fake)).toEqual([]);
    expect(attached.tabs.list()).toEqual([]);
    refuse = false;
    await expect(attached.ensureContext()).resolves.toBe('theirs');
    expect(attached.tabs.list().map((tab) => tab.context)).toEqual(['theirs']);
    expect(fake.commands('browsingContext.create')).toEqual([]);
    expect(fake.commands('browsingContext.activate')).toEqual([]);
  });
});

describe('BidiSession.close', () => {
  it('removes a user context that a reset opened after the attempt closed', async () => {
    let created: (reply: { result: unknown }) => void = () => undefined;
    const fake = new FakeBidi()
      .on('browser.createUserContext', () => new Promise((resolve) => (created = resolve)))
      .on('network.addDataCollector', { result: { collector: 'c' } });
    const closing = unopened(fake);
    const opening = closing.openUserContext(new AbortController().signal);
    await settle();
    await closing.close();
    created({ result: { userContext: 'late' } });
    await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fake.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toEqual(['late']);
    expect(fake.commands('script.addPreloadScript')).toEqual([]);
  });

  it('ends the attempt’s lifetime, so work it started that nothing awaits stops', async () => {
    const fake = new FakeBidi();
    const closing = unopened(fake);
    const lifetime = closing.lifetime;
    expect(lifetime.aborted).toBe(false);
    await closing.close();
    expect(lifetime.aborted).toBe(true);
  });

  it('owes a user context whose removal failed in a reset, and removes it on close', async () => {
    const names = ['first', 'second'];
    const fake = new FakeBidi().on('browser.createUserContext', async () => ({ result: { userContext: names.shift() } })).on('network.addDataCollector', { result: { collector: 'c' } });
    const closing = unopened(fake);
    await closing.openUserContext(new AbortController().signal);
    fake.on('browser.removeUserContext', { error: 'unknown error', message: 'busy' });
    await expect(closing.replaceUserContext(new AbortController().signal)).rejects.toThrow('busy');
    expect(closing.userContext.id).toBe('second');
    fake.on('browser.removeUserContext', { result: {} });
    await closing.close();
    expect(fake.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toEqual(['first', 'first', 'second']);
  });

  it('removes the user context a reset replaced when the network cannot bind to the new one', async () => {
    const names = ['first', 'second'];
    const fake = new FakeBidi().on('browser.createUserContext', async () => ({ result: { userContext: names.shift() } })).on('network.addDataCollector', { result: { collector: 'c' } });
    const closing = unopened(fake);
    await closing.openUserContext(new AbortController().signal);
    fake.on('network.addDataCollector', { error: 'unknown error', message: 'no collector' });
    await expect(closing.replaceUserContext(new AbortController().signal)).rejects.toThrow('no collector');
    expect(closing.userContext.id).toBe('second');
    expect(fake.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toEqual(['first']);
    await closing.close();
    expect(fake.commands('browser.removeUserContext').map((command) => command.params['userContext'])).toEqual(['first', 'second']);
  });

  it('closes every tab it opened in a browser it attached to, whichever is shown, and leaves the one it adopted', async () => {
    const fake = new FakeBidi()
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.getTree', { result: { contexts: [{ context: 'theirs', userContext: 'default' }] } })
      .on('browsingContext.create', { result: { context: 'mine' } });
    const attached = unopened(fake, 'chromium', 'adopt-tab');
    await attached.openUserContext(new AbortController().signal);
    await attached.newTab();
    await attached.tabs.show(attached.tabs.find('theirs')!);
    await attached.close();
    expect(fake.commands('browsingContext.close').map((command) => command.params['context'])).toEqual(['mine']);
    expect(fake.commands('browser.removeUserContext')).toEqual([]);
  });

  it('closes every tab it opened in the browser’s own user context when a reset replaces it', async () => {
    const opened = ['first', 'second'];
    const fake = new FakeBidi()
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.create', () => ({ result: { context: opened.shift() } }));
    const kept = unopened(fake, 'chromium', 'default');
    await kept.openUserContext(new AbortController().signal);
    await kept.ensureContext();
    await kept.newTab();
    await kept.tabs.show(kept.tabs.find('first')!);
    await kept.replaceUserContext(new AbortController().signal);
    expect(fake.commands('browsingContext.close').map((command) => command.params['context'])).toEqual(['first', 'second']);
    expect(kept.tabs.list()).toEqual([]);
  });
});
