/** A BiDi session's own state: the input it sends (held keys through chords and modifier clicks until their `keyboard.up`, pressure, the viewport bound, what each tab holds while another is shown, what counts as dispatched, a fill and a press on a node included), refs a locate just proved, the tabs it opens and the ones it closes again, and the user contexts it removes or refuses to set up once the attempt closed. */

import { describe, expect, it, vi } from 'vitest';
import { perform } from '../../src/driver/actions.ts';
import { ContextTree } from '../../src/driver/context-tree.ts';
import { clickSources, moveSources, pressDownSources, swipeSources, typeSource } from '../../src/driver/input-sources.ts';
import { fixtureKeyStroke, strokeSource, type KeyPhase } from '../../src/driver/keyboard.ts';
import { DispatchScope, type BidiInput } from '../../src/driver/input.ts';
import { routeEvents } from '../../src/driver/events.ts';
import { BidiSession } from '../../src/driver/session.ts';
import { BROWSER_TRAITS, type BrowserName } from '../../src/browsers.ts';
import { elementShown } from '../../src/in-page/actionability.ts';
import { elementAttached, fill, focus } from '../../src/in-page/edits.ts';
import type { UserContextMode } from '../../src/driver/user-context.ts';
import { ProtectedApp } from '../../src/protected-app.ts';
import { afterDispatch, BidiError, classify } from '../../src/errors.ts';
import type { NodeRef } from '@e2e-dev/core/engine';
import { FakeBidi, settle, type Reply, type SentCommand } from '../helpers/bidi-fake.ts';
import { callOf } from '../helpers/page-call.ts';
import { ElementRef } from '../../src/driver/script.ts';

const SHIFT = '';

/** A session on `fake` that has opened nothing yet, on a 100 by 100 viewport, in a user context of its own unless `userContext` says otherwise. */
function unopened(fake: FakeBidi, browser: BrowserName = 'chromium', userContext: UserContextMode = 'fresh'): BidiSession {
  const settings = { media: {}, viewport: { width: 100, height: 100 }, initScripts: { forAttempt: () => [] }, permissions: [], userContext, testIdAttribute: 'data-testid' };
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
    await held.input.send([typeSource(['a'])]);
    expect(fake.commands('browsingContext.activate').map((command) => command.params)).toEqual([{ context: 'tab' }]);
    expect(fake.commands('input.performActions')).toHaveLength(2);
  });

  it('sends Firefox pointer input to a tab still hidden at the front, as the shown tab of a minimized window is, which takes it', async () => {
    const fake = new FakeBidi()
      .on('input.performActions', { result: {} })
      .on('script.callFunction', { result: { type: 'success', realm: 'r', result: { type: 'boolean', value: false } } });
    const held = await session(fake, 'firefox');
    await held.input.send(clickSources(5, 5));
    expect(fake.commands('browsingContext.activate')).toHaveLength(1);
    expect(fake.commands('input.performActions')).toHaveLength(1);
    expect(held.input.dispatches).toBe(1);
  });

  it('waits for the frame of the document that replaced one a navigation took away under the wait, before Firefox pointer input', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake, 'firefox');
    const waits: Reply[] = [
      { error: 'no such frame', message: 'DiscardedBrowsingContextError: Actor \'MessageHandlerFrame\' destroyed before query \'MessageHandlerFrameParent:sendCommand\' was resolved' },
      { result: { type: 'success', realm: 'r', result: { type: 'boolean', value: true } } },
    ];
    fake.on('script.callFunction', () => waits.shift()!);
    await held.input.send(clickSources(5, 5));
    expect(waits).toEqual([]);
    expect(fake.commands('input.performActions')).toHaveLength(1);
  });

  it('sends no Firefox pointer input to a tab that closed under the wait for its frame, as never dispatched', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake, 'firefox');
    const gone: Reply = { error: 'no such frame', message: 'Browsing Context with id tab not found' };
    fake.on('script.callFunction', gone).on('browsingContext.activate', gone);
    await expect(held.input.send(clickSources(5, 5))).rejects.toMatchObject({ error: 'no such frame' });
    expect(fake.commands('input.performActions')).toEqual([]);
    expect(held.input.dispatches).toBe(0);
  });

  it('takes input the page suppressed back from the operation that sent it, and never from the attempt', async () => {
    let fail = false;
    const fake = new FakeBidi().on('input.performActions', () => (fail ? { error: 'unknown error', message: 'gone' } : { result: {} }));
    const held = await session(fake);
    const watch = (verdict: string | null) => ({ arm: async () => undefined, verdict: async () => verdict, suppressed: (seen: string | null): boolean => seen === 'covered' });
    const click = (verdict: string | null) => held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), watch(verdict));
    const [swallowed, seen, failed] = [new DispatchScope(), new DispatchScope(), new DispatchScope()];
    await swallowed.run(() => click('covered'));
    await seen.run(() => click(null));
    fail = true;
    await expect(failed.run(() => click('covered'))).rejects.toThrow('gone');
    expect([swallowed.dispatched, seen.dispatched, failed.dispatched]).toEqual([false, true, true]);
    expect(held.input.dispatches).toBe(3);
  });

  it('takes input whose tab closed under it (a click that closes its own tab) as dispatched, not failed', async () => {
    const fake = new FakeBidi().on('input.performActions', { error: 'no such frame', message: 'Browsing context is gone' });
    const held = await session(fake);
    await expect(held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), { arm: async () => undefined, verdict: async () => null, suppressed: (verdict) => verdict !== null })).resolves.toBeNull();
    expect(held.input.dispatches).toBe(1);
  });

  it('counts input whose verdict never comes as dispatched, so an operation timing out on it may have committed', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    void held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), { arm: async () => undefined, verdict: () => new Promise<never>(() => undefined), suppressed: () => true });
    await vi.waitFor(() => expect(fake.commands('input.performActions')).toHaveLength(1));
    expect(held.input.dispatches).toBe(1);
  });

  it('arms a watch only for input ready to go out, and ends one it armed whatever stopped the input', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    const calls: string[] = [];
    const watch = (arm: () => Promise<void>) => ({
      arm: async () => {
        calls.push('arm');
        await arm();
      },
      verdict: async () => {
        calls.push('verdict');
        return null;
      },
      suppressed: () => false,
    });
    await expect(held.input.sendSuppressible(clickSources(500, 5), AbortSignal.timeout(500), watch(async () => undefined))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(held.input.sendSuppressible(clickSources(5, 5), AbortSignal.abort(new Error('cancelled')), watch(async () => undefined))).rejects.toThrow('cancelled');
    expect(calls).toEqual([]);
    const cancelling = new AbortController();
    await expect(held.input.sendSuppressible(clickSources(5, 5), cancelling.signal, watch(async () => cancelling.abort(new Error('cancelled while arming'))))).rejects.toThrow('cancelled while arming');
    await expect(held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), watch(async () => {
      throw new BidiError('script.callFunction', 'no such frame', 'the frame is gone');
    }))).rejects.toThrow('no such frame');
    expect(calls).toEqual(['arm', 'verdict', 'arm', 'verdict']);
    expect(fake.commands('input.performActions')).toEqual([]);
    expect(held.input.dispatches).toBe(0);
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

  it('keeps what each tab holds while another is shown: its keys, its button, and where its mouse is', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    const [first] = held.tabs.list();
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    await held.input.send(pressDownSources(20, 30));
    const second = await held.newTab();
    expect(held.input.pointer).toEqual({ x: 0, y: 0 });
    await held.input.send(clickSources(5, 5, { modifiers: ['Shift'] }));
    expect(keyActions(fake).at(-1)!.filter((action) => action.value === SHIFT).map((action) => action.type)).toEqual(['keyDown', 'keyUp']);
    await held.tabs.show(first!);
    expect(held.input.pointer).toEqual({ x: 20, y: 30 });
    await held.input.send([keySource('Shift+ArrowRight', 'press', true)]);
    expect(keyActions(fake).at(-1)!.some((action) => action.value === SHIFT)).toBe(false);
    await held.input.send(moveSources(40, 40));
    const sent = fake.commands('input.performActions').at(-1)!.params as { context: string; actions: { actions: { pressure?: number }[] }[] };
    expect([sent.context, sent.actions[0]!.actions[0]!.pressure]).toEqual(['tab', 0.5]);
    await held.tabs.show(second);
    expect(held.input.pointer).toEqual({ x: 5, y: 5 });
  });

  it('drops what a tab held once the browser says the tab is gone', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const shared = await sharedSession(fake);
    // The scripted browser gives the next tab the id of the one that closed, which no browser does: anything kept of the closed one would show in it.
    const reopened = (): Reply => {
      fake.emit('browsingContext.contextCreated', { context: 'tab-2', userContext: 'mine', parent: null });
      return { result: { context: 'tab-2' } };
    };
    fake.on('browsingContext.create', reopened);
    const closing = await shared.newTab();
    await shared.input.send([keySource('Shift', 'keyDown', false)]);
    await shared.tabs.close(closing);
    await shared.newTab();
    await shared.input.send([keySource('Shift', 'keyDown', false)]);
    expect(keyActions(fake).at(-1)).toEqual([{ type: 'keyDown', value: SHIFT }]);
  });

  it('forgets held keys with the tab that held them', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    held.tabs.destroyed('tab');
    await held.ensureContext();
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    expect(keyActions(fake).at(-1)).toEqual([{ type: 'keyDown', value: SHIFT }]);
  });

  const unsuppressed = { arm: async () => undefined, verdict: async () => null, suppressed: () => false };
  it.each<[string, string, Reply, (input: BidiInput) => Promise<unknown>]>([
    ['a send', 'input.performActions', { result: {} }, (input) => input.send(clickSources(5, 5))],
    ['a suppressible send', 'input.performActions', { result: {} }, (input) => input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), unsuppressed)],
    ['a suppressible send the closed tab failed', 'input.performActions', { error: 'no such frame', message: 'Browsing context is gone' }, (input) => input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), unsuppressed)],
    ['a CDP key', 'goog:cdp.sendCommand', { result: {} }, (input) => input.key(fixtureKeyStroke('MediaPlayPause', 'keyDown'))],
    ['a drag event', 'goog:cdp.sendCommand', { result: {} }, (input) => input.dragEvent('drop', { x: 5, y: 5 }, { items: [], dragOperationsMask: 1 }, AbortSignal.timeout(500))],
  ])('keeps what %s left in a tab that closed under it out of the tab shown next, which has what it had', async (_name, method, reply, send) => {
    const fake = new FakeBidi().on('input.performActions', { result: {} }).on('goog:cdp.getSession', { result: { session: 'cdp' } }).on('goog:cdp.sendCommand', { result: {} });
    const held = await session(fake);
    await held.input.send(moveSources(7, 9));
    await held.newTab();
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    // The tab's close reaches the driver before the answer to the input that closed it.
    fake.on(method, () => {
      held.tabs.destroyed('tab-2');
      return reply;
    });
    await send(held.input);
    fake.on(method, { result: {} });
    await held.tabs.settled();
    expect(held.context).toBe('tab');
    expect(held.input.pointer).toEqual({ x: 7, y: 9 });
    await held.input.key(fixtureKeyStroke('MediaPlayPause', 'keyDown'));
    expect(fake.commands('goog:cdp.sendCommand').at(-1)!.params['params']).toMatchObject({ modifiers: 0, autoRepeat: false });
    await held.input.send([keySource('Shift', 'keyDown', false)]);
    expect(keyActions(fake).at(-1)).toEqual([{ type: 'keyDown', value: SHIFT }]);
  });
});

describe('a fill', () => {
  /** A page call's answer of `outcome`. */
  const answer = (outcome: Record<string, string>): Reply =>
    ({ result: { type: 'success', realm: 'r', result: { type: 'object', value: Object.entries(outcome).map(([key, value]) => [key, { type: 'string', value }]) } } });

  /** Has `fake` answer the page's `fill` with `filled`, and every check before it as a shown, enabled field. */
  function field(fake: FakeBidi, filled: () => Reply | Promise<Reply>): void {
    fake.on('script.callFunction', (params) => {
      if (callOf(fill, params) !== undefined) return filled();
      if (callOf(elementShown, params) !== undefined) return answer({ kind: 'ok' });
      return { result: { type: 'success', realm: 'r', result: { type: 'boolean', value: false } } };
    });
  }

  /** Fills the field `held` located as `id`, counted by a scope of its own. */
  function filling(held: BidiSession, id: string, timeoutMs: number): { scope: DispatchScope; done: Promise<void> } {
    held.refs.storeLocated(id, { element: new ElementRef('e'), context: 'tab', locator: { kind: 'selector', selector: '#a' } });
    const scope = new DispatchScope();
    return { scope, done: scope.run(() => perform(held, { id } as NodeRef, { kind: 'fill', value: 'x', sensitive: false }, timeoutMs, new AbortController().signal)) };
  }

  it('counts as dispatched while the page still runs it, so an operation timing out on it may have committed', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    let sent = false;
    field(fake, () => {
      sent = true;
      return new Promise<never>(() => undefined);
    });
    const { scope } = filling(held, '1', 5_000);
    await vi.waitFor(() => expect(sent).toBe(true));
    expect(scope.dispatched).toBe(true);
    expect(held.input.dispatches).toBe(1);
  });

  it('takes a try that changed nothing back from the operation, and never from the attempt', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    field(fake, () => answer({ kind: 'not-yet', reason: 'element is not editable' }));
    const { scope, done } = filling(held, '1', 120);
    await expect(done).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('element is not editable') });
    expect(scope.dispatched).toBe(false);
    expect(held.input.dispatches).toBeGreaterThan(0);
  });

  it('fails stale, as never dispatched, when the field left the document since its checks', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    field(fake, () => answer({ kind: 'detached' }));
    const { scope, done } = filling(held, '1', 5_000);
    await expect(done).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(scope.dispatched).toBe(false);
  });
});

describe('a press on a node', () => {
  it('sends no key once the node left the document, and fails stale as never dispatched', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} }).on('script.callFunction', (params) => ({
      result: { type: 'success', realm: 'r', result: { type: 'object', value: [['kind', { type: 'string', value: callOf(focus, params) === undefined ? 'ok' : 'detached' }]] } },
    }));
    const held = await session(fake);
    held.refs.storeLocated('1', { element: new ElementRef('e'), context: 'tab', locator: { kind: 'selector', selector: '#a' } });
    const scope = new DispatchScope();
    const pressing = scope.run(() => perform(held, { id: '1' } as NodeRef, { kind: 'press', key: 'a' }, 5_000, new AbortController().signal));
    await expect(pressing).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(fake.commands('input.performActions')).toEqual([]);
    expect(scope.dispatched).toBe(false);
  });

  const ok: Reply = { result: { type: 'success', realm: 'r', result: { type: 'object', value: [['kind', { type: 'string', value: 'ok' }]] } } };

  /**
   * Presses a key on a node an observation gave, on a page that answers its
   * `focus` with `focused` and the read before it with `read`; counted by a
   * scope of its own.
   */
  async function press(browser: BrowserName, focused: Reply, read: Reply = ok): Promise<{ fake: FakeBidi; scope: DispatchScope; failure: unknown }> {
    const fake = new FakeBidi().on('input.performActions', { result: {} }).on('script.callFunction', (params) => (callOf(focus, params) === undefined ? read : focused));
    const held = await session(fake, browser);
    held.refs.publish(new Map([['1', { element: new ElementRef('e'), context: 'tab' }]]));
    const scope = new DispatchScope();
    const failure = await scope.run(() => perform(held, { id: '1' } as NodeRef, { kind: 'press', key: 'a' }, 5_000, new AbortController().signal)).then(() => undefined, (cause: unknown) => cause);
    return { fake, scope, failure };
  }

  /** The page calls of `fn` that `fake` got. */
  const calls = (fake: FakeBidi, fn: { toString(): string }): SentCommand[] => fake.commands('script.callFunction').filter((command) => callOf(fn, command.params) !== undefined);

  /** What each browser answers for an element of a document a navigation replaced, settled and in flight, or of a frame that is gone. */
  const REFUSALS: readonly (readonly [BrowserName, Reply])[] = [
    ['chromium', { error: 'no such node', message: 'SharedId "f.1.d.2.e.3" belongs to different document. Current document is 4.' }],
    ['chromium', { error: 'no such node', message: 'SharedId "f.1.d.2.e.3" was not found.' }],
    ['chromium', { error: 'unknown error', message: 'Node with given id does not belong to the document' }],
    ['chromium', { error: 'no such frame', message: 'Context 046C34E7A7D4F228602F3B47BEDF8F34 not found' }],
    ['firefox', { error: 'no such node', message: 'The node with the reference e is not known' }],
    ['firefox', { error: 'no such frame', message: 'Browsing Context with id 15032385537 not found' }],
  ];

  it.each(REFUSALS)('reads the node before it focuses it, so one %s refused fails stale, as never dispatched, and no key goes out: %j', async (browser, refusal) => {
    const { fake, scope, failure } = await press(browser, ok, refusal);
    expect(afterDispatch(classify(failure, 'press'), 'press', scope.dispatched)).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(calls(fake, elementAttached)).toHaveLength(1);
    expect(calls(fake, focus)).toEqual([]);
    expect(fake.commands('input.performActions')).toEqual([]);
  });

  // The read of the node passed, so a navigation replaced the document in the moment since: Firefox may have run the focus in the one that went away.
  it.each(REFUSALS)('keeps a focus counted whose node %s refused, so it may have committed: %j', async (browser, refusal) => {
    const { fake, scope, failure } = await press(browser, refusal);
    expect(afterDispatch(classify(failure, 'press'), 'press', scope.dispatched)).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(fake.commands('input.performActions')).toEqual([]);
  });

  // What the browsers answered for a focus whose function ran and whose document, frame, or tab went away under it.
  it.each<readonly [BrowserName, Reply]>([
    ['chromium', { error: 'unknown error', message: 'Inspected target navigated or closed' }],
    ['chromium', { error: 'unknown error', message: 'Cannot find context with specified id' }],
    ['chromium', { error: 'unknown error', message: 'Execution context was destroyed.' }],
    ['chromium', { error: 'no such frame', message: 'Browsing context is gone' }],
    ['firefox', { error: 'no such frame', message: 'DiscardedBrowsingContextError: Actor \'MessageHandlerFrame\' destroyed before query \'MessageHandlerFrameParent:sendCommand\' was resolved' }],
  ])('keeps a focus on %s whose document went away under it counted, so it may have committed: %j', async (browser, gone) => {
    const { fake, scope, failure } = await press(browser, gone);
    expect(failure).toBeInstanceOf(BidiError);
    expect(fake.commands('input.performActions')).toEqual([]);
    expect(scope.dispatched).toBe(true);
  });

  it.each(['chromium', 'firefox'] as const)('reads the node, focuses it, and sends the key on %s: two page calls and one input', async (browser) => {
    const { fake, scope, failure } = await press(browser, ok);
    expect(failure).toBeUndefined();
    expect([calls(fake, elementAttached).length, calls(fake, focus).length, fake.commands('input.performActions').length]).toEqual([1, 1, 1]);
    expect(scope.dispatched).toBe(true);
  });
});

describe('BidiSession.refs', () => {
  it('claims a located ref as fresh once, and only while no input went out since its locate', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    const target = { element: new ElementRef('e'), context: 'tab', locator: { kind: 'selector', selector: '#a' } as const };
    held.refs.storeLocated('1', target);
    held.refs.storeLocated('2', target);
    expect(held.refs.claimFresh({ id: '1' } as NodeRef)).toBe(true);
    expect(held.refs.claimFresh({ id: '1' } as NodeRef)).toBe(false);
    await held.input.send(moveSources(1, 1));
    expect(held.refs.claimFresh({ id: '2' } as NodeRef)).toBe(false);
  });

  it('claims no located ref as fresh after a click the page swallowed, whose pointer move still reached it', async () => {
    const fake = new FakeBidi().on('input.performActions', { result: {} });
    const held = await session(fake);
    held.refs.storeLocated('1', { element: new ElementRef('e'), context: 'tab', locator: { kind: 'selector', selector: '#a' } });
    await held.input.sendSuppressible(clickSources(5, 5), AbortSignal.timeout(500), { arm: async () => undefined, verdict: async () => null, suppressed: () => true });
    expect(held.refs.claimFresh({ id: '1' } as NodeRef)).toBe(false);
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

/** Numbers the user contexts `fake` creates (`uc-1`, `uc-2`), and names each tab it opens after the user context it opened in. */
function numbered(fake: FakeBidi): FakeBidi {
  let userContexts = 0;
  return fake
    .on('browser.createUserContext', () => ({ result: { userContext: `uc-${String(++userContexts)}` } }))
    .on('network.addDataCollector', { result: { collector: 'c' } })
    .on('browsingContext.create', (params) => ({ result: { context: `tab in ${String(params['userContext'])}` } }));
}

/**
 * Holds `held`'s network on a request count it starts (`track`), so a tab
 * the network is asked to cover waits behind it, as it does behind any
 * round trip of the network's. Returns the release, which resolves once the
 * count is on.
 */
function holdNetwork(fake: FakeBidi, held: BidiSession): () => Promise<void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  fake.on('session.subscribe', async () => {
    await gate;
    return { result: { subscription: 's' } };
  });
  const tracking = held.network.track();
  return async () => {
    release();
    await tracking;
  };
}

/**
 * A session with its tab `tab` open in a browser other clients drive too,
 * with headers configured, so an intercept covers exactly its tabs. `fake`
 * announces each tab it opens and closes, as a browser does, and the
 * session's events are routed. The tab it opens next is `tab-2`.
 */
async function sharedSession(fake: FakeBidi): Promise<BidiSession> {
  const tree = new ContextTree();
  const tabs = ['tab', 'tab-2'];
  let intercepts = 0;
  fake
    .on('browser.createUserContext', { result: { userContext: 'mine' } })
    .on('network.addDataCollector', { result: { collector: 'c' } })
    .on('session.subscribe', { result: { subscription: 's' } })
    .on('network.addIntercept', () => ({ result: { intercept: `intercept-${String(++intercepts)}` } }))
    .on('browsingContext.getTree', { result: { contexts: [{ context: 'tab', userContext: 'mine' }] } })
    .on('browsingContext.create', () => {
      const context = tabs.shift();
      fake.emit('browsingContext.contextCreated', { context, userContext: 'mine', parent: null });
      return { result: { context } };
    })
    .on('browsingContext.close', (params) => {
      fake.emit('browsingContext.contextDestroyed', { context: params['context'], userContext: 'mine', parent: null });
      return { result: {} };
    });
  const settings = { media: {}, viewport: null, initScripts: { forAttempt: () => [] }, permissions: [], userContext: 'fresh' };
  const attempt = { protectedApp: new ProtectedApp(new Set(['http://app.test']), { 'x-preview': 'on' }, undefined) };
  const shared = new BidiSession({ connection: fake.connection, exclusive: false, traits: BROWSER_TRAITS.chromium } as never, settings as never, attempt as never, tree);
  routeEvents(fake.connection, tree, () => shared);
  await shared.openUserContext(new AbortController().signal);
  await shared.ensureContext();
  return shared;
}

describe('BidiSession tabs', () => {
  it('opens its first tab at the viewport without activating it, and a tab opened beside it at the front', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    expect(tabCommands(fake)).toEqual(['create', 'setViewport tab']);
    // Scale factor 1 whatever the display's, so a headed run renders what a headless one does.
    expect(fake.commands('browsingContext.setViewport')[0]?.params).toMatchObject({ context: 'tab', devicePixelRatio: 1 });
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

  it('fails a tab open stale, and closes the tab unshown, when a reset replaced the user context before the tab joined', async () => {
    const fake = numbered(new FakeBidi());
    const resetting = unopened(fake);
    await resetting.openUserContext(new AbortController().signal);
    const release = holdNetwork(fake, resetting);
    const opening = resetting.ensureContext();
    await settle();
    const replacing = resetting.replaceUserContext(new AbortController().signal);
    await settle();
    expect(resetting.userContext.id).toBe('uc-2');
    await release();
    await expect(opening).rejects.toMatchObject({ code: 'NODE_STALE' });
    await replacing;
    expect(tabCommands(fake)).toEqual(['create']);
    expect(closedTabs(fake)).toEqual(['tab in uc-1']);
    expect(resetting.context).toBeUndefined();
    await expect(resetting.ensureContext()).resolves.toBe('tab in uc-2');
  });

  it('fails a tab open stale when a reset forgot the tab while it was being shown', async () => {
    let sized: () => void = () => undefined;
    const fake = numbered(new FakeBidi()).on('browsingContext.setViewport', () => new Promise((resolve) => (sized = () => resolve({ result: {} }))));
    const resetting = unopened(fake);
    await resetting.openUserContext(new AbortController().signal);
    const opening = resetting.ensureContext();
    await settle();
    expect(resetting.tabs.list().map((tab) => tab.context)).toEqual(['tab in uc-1']);
    await resetting.replaceUserContext(new AbortController().signal);
    sized();
    await expect(opening).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(closedTabs(fake)).toEqual(['tab in uc-1']);
    expect(resetting.context).toBeUndefined();
    expect(resetting.tabs.list()).toEqual([]);
  });

  it('opens the first tab of the user context a reset moved to, never joining one still opening in the old', async () => {
    const created: (() => void)[] = [];
    const fake = numbered(new FakeBidi()).on('browsingContext.create', (params) =>
      new Promise((resolve) => created.push(() => resolve({ result: { context: `tab in ${String(params['userContext'])}` } }))));
    const resetting = unopened(fake);
    await resetting.openUserContext(new AbortController().signal);
    const opening = resetting.ensureContext();
    await settle();
    await resetting.replaceUserContext(new AbortController().signal);
    const first = resetting.ensureContext();
    await settle();
    created[0]!();
    await expect(opening).rejects.toMatchObject({ code: 'NODE_STALE' });
    const second = resetting.ensureContext();
    await settle();
    expect(created).toHaveLength(2);
    created[1]!();
    await expect(Promise.all([first, second])).resolves.toEqual(['tab in uc-2', 'tab in uc-2']);
    expect(fake.commands('browsingContext.create').map((command) => command.params['userContext'])).toEqual(['uc-1', 'uc-2']);
    expect(closedTabs(fake)).toEqual(['tab in uc-1']);
  });

  it('closes a tab still opening when the attempt closes in the browser’s own user context', async () => {
    const opened = ['first', 'second'];
    const fake = new FakeBidi()
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.create', () => ({ result: { context: opened.shift() } }));
    const kept = unopened(fake, 'chromium', 'default');
    await kept.openUserContext(new AbortController().signal);
    await kept.ensureContext();
    const release = holdNetwork(fake, kept);
    const opening = kept.newTab();
    await settle();
    const closing = kept.close();
    await settle();
    await release();
    await expect(opening).rejects.toMatchObject({ code: 'NODE_STALE' });
    await closing;
    expect(closedTabs(fake)).toEqual(['first', 'second']);
    expect(kept.tabs.list()).toEqual([]);
  });

  it('keeps its tabs when a restart is given up on before it closed them', async () => {
    let listed: () => void = () => undefined;
    const fake = new FakeBidi();
    const held = await session(fake);
    fake.on('browsingContext.getTree', () => new Promise((resolve) => (listed = () => resolve({ result: { contexts: [{ context: 'tab', userContext: 'mine' }] } }))));
    const givenUp = new AbortController();
    const restarting = held.replaceTabs(givenUp.signal);
    await settle();
    givenUp.abort(new Error('given up'));
    listed();
    await expect(restarting).rejects.toThrow('given up');
    expect(closedTabs(fake)).toEqual([]);
    expect(fake.commands('browsingContext.create')).toHaveLength(1);
    expect(held.context).toBe('tab');
    expect(held.tabs.list().map((tab) => tab.context)).toEqual(['tab']);
  });

  it('opens the blank tab of a restart before it closes the old ones, so its user context is never without a tab', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    fake.on('browsingContext.getTree', { result: { contexts: [{ context: 'tab', userContext: 'mine' }, { context: 'popup', userContext: 'mine' }, { context: 'theirs', userContext: 'other' }] } });
    await held.replaceTabs(new AbortController().signal);
    expect(fake.sent.filter((command) => command.method === 'browsingContext.create' || command.method === 'browsingContext.close').slice(1).map((command) => command.method))
      .toEqual(['browsingContext.create', 'browsingContext.close', 'browsingContext.close']);
    expect(closedTabs(fake)).toEqual(['tab', 'popup']);
    expect(held.context).toBe('tab-2');
    expect(held.tabs.list().map((tab) => tab.context)).toEqual(['tab-2']);
  });

  it('closes the old tabs of a restart whose blank tab cannot open', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    fake.on('browsingContext.getTree', { result: { contexts: [{ context: 'tab', userContext: 'mine' }] } });
    fake.on('browsingContext.setViewport', { error: 'unknown error', message: 'no viewport' });
    await expect(held.replaceTabs(new AbortController().signal)).rejects.toThrow('no viewport');
    expect(closedTabs(fake)).toEqual(['tab-2', 'tab']);
    expect(held.context).toBeUndefined();
    expect(held.tabs.list()).toEqual([]);
  });

  it('closes the old tabs of a restart given up on while their recording ended, and opens no tab', async () => {
    const fake = new FakeBidi();
    const held = await session(fake);
    fake.on('browsingContext.getTree', { result: { contexts: [{ context: 'tab', userContext: 'mine' }] } });
    const givenUp = new AbortController();
    vi.spyOn(held.video, 'contextClosing').mockImplementation(async () => givenUp.abort(new Error('given up')));
    await expect(held.replaceTabs(givenUp.signal)).rejects.toThrow('given up');
    expect(closedTabs(fake)).toEqual(['tab']);
    expect(fake.commands('browsingContext.create')).toHaveLength(1);
    expect(held.context).toBeUndefined();
  });

  it('closes the old tabs of a restart whose network cannot let go of them, and leaves the failure to the next step', async () => {
    const fake = new FakeBidi();
    const shared = await sharedSession(fake);
    fake.on('network.removeIntercept', (params) => (params['intercept'] === 'intercept-2' ? { error: 'unknown error', message: 'no removal' } : { result: {} }));
    await shared.replaceTabs(new AbortController().signal);
    expect(closedTabs(fake)).toEqual(['tab']);
    expect(shared.context).toBe('tab-2');
    await settle();
    expect(() => shared.latch.throwPending()).toThrow('no removal');
  });

  it('shows the tab an attached browser had open again after a restart, and closes only the others', async () => {
    const fake = new FakeBidi()
      .on('network.addDataCollector', { result: { collector: 'c' } })
      .on('browsingContext.getTree', { result: { contexts: [{ context: 'theirs', userContext: 'default' }, { context: 'mine', userContext: 'default' }] } })
      .on('browsingContext.create', { result: { context: 'mine' } });
    const attached = unopened(fake, 'chromium', 'adopt-tab');
    await attached.openUserContext(new AbortController().signal);
    await attached.newTab();
    await attached.replaceTabs(new AbortController().signal);
    expect(closedTabs(fake)).toEqual(['mine']);
    expect(fake.commands('browsingContext.create')).toHaveLength(1);
    expect(attached.context).toBe('theirs');
    expect(attached.tabs.list().map((tab) => tab.context)).toEqual(['theirs']);
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

  it('sets up no user context for a reset that starts after the attempt closed', async () => {
    const fake = new FakeBidi().on('browser.createUserContext', { result: { userContext: 'mine' } }).on('network.addDataCollector', { result: { collector: 'c' } });
    const closed = unopened(fake);
    await closed.openUserContext(new AbortController().signal);
    await closed.close();
    await expect(closed.replaceUserContext(new AbortController().signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fake.commands('browser.createUserContext')).toHaveLength(1);
    expect(closed.userContext.id).toBe('');
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
