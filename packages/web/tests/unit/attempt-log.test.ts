/**
 * An attempt's subscriptions to what its pages log, over a scripted peer:
 * one per user context, from where the browser reports a page's log, with
 * Chromium told to report its own lines for each tab and for a frame
 * another process renders, and the CDP events it sends routed to the app
 * log.
 */

import { describe, expect, it } from 'vitest';
import type { AppLogEntry } from '@e2e-dev/core/engine';
import { ContextTree } from '../../src/driver/context-tree.ts';
import { routeEvents, SESSION_EVENTS } from '../../src/driver/events.ts';
import { BidiSession } from '../../src/driver/session.ts';
import { BROWSER_TRAITS, type BrowserName } from '../../src/browsers.ts';
import type { UserContextMode } from '../../src/driver/user-context.ts';
import { ProtectedApp } from '../../src/protected-app.ts';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';

/**
 * A session on `browser` with its events routed and its user context open,
 * which opens `tab` first, or adopts the tab `theirs` it finds open. `fake`
 * names each CDP session after its context, except a frame's whose name
 * starts `same`, which its tab's process renders.
 */
async function unopened(fake: FakeBidi, browser: BrowserName, userContext: UserContextMode = 'fresh'): Promise<{ held: BidiSession; log: AppLogEntry[] }> {
  const tree = new ContextTree();
  const tabs = ['tab', 'tab-2'];
  const log: AppLogEntry[] = [];
  let subscriptions = 0;
  fake
    .on('browser.createUserContext', { result: { userContext: 'mine' } })
    .on('network.addDataCollector', { result: { collector: 'c' } })
    .on('session.subscribe', () => ({ result: { subscription: `subscription-${String(++subscriptions)}` } }))
    .on('browsingContext.getTree', { result: { contexts: [{ context: 'theirs', userContext: 'default' }] } })
    .on('browsingContext.create', () => {
      const context = tabs.shift();
      fake.emit('browsingContext.contextCreated', { context, userContext: 'mine', parent: null });
      return { result: { context } };
    })
    .on('goog:cdp.getSession', (params) => ({ result: { session: `cdp of ${String(params['context']).startsWith('same') ? 'tab' : String(params['context'])}` } }));
  const settings = { media: {}, viewport: null, initScripts: { forAttempt: () => [] }, permissions: [], userContext, testIdAttribute: 'data-testid' };
  const attempt = { protectedApp: new ProtectedApp(new Set(), undefined, undefined), appLog: (entry: AppLogEntry) => log.push(entry), navigation: () => undefined };
  const held = new BidiSession({ connection: fake.connection, exclusive: true, traits: { ...BROWSER_TRAITS[browser], windowClipsViewport: false } } as never, settings as never, attempt as never, tree);
  routeEvents(fake.connection, tree, () => held);
  if (userContext !== 'adopt-tab') await held.openUserContext(new AbortController().signal);
  return { held, log };
}

/** A session (`unopened`) with its first tab open. */
async function session(fake: FakeBidi, browser: BrowserName, userContext: UserContextMode = 'fresh'): Promise<{ held: BidiSession; log: AppLogEntry[] }> {
  const opened = await unopened(fake, browser, userContext);
  if (userContext === 'adopt-tab') await opened.held.openUserContext(new AbortController().signal);
  else await opened.held.ensureContext();
  return opened;
}

/** Whether `params` subscribe to a page's log, from either place a browser reports it. */
function forLog(params: Record<string, unknown>): boolean {
  return (params['events'] as string[]).some((event) => event === 'log.entryAdded' || event === 'goog:cdp.Log.entryAdded');
}

/** The log subscriptions `fake` got, each with its events and the user contexts it is for. */
function subscribed(fake: FakeBidi): unknown[] {
  return fake.commands('session.subscribe').filter((command) => forLog(command.params)).map((command) => ({ events: command.params['events'], userContexts: command.params['userContexts'] }));
}

/** The CDP sessions `fake` was told to report the browser's own lines on, in order. */
function reporting(fake: FakeBidi): unknown[] {
  return fake.commands('goog:cdp.sendCommand').filter((command) => command.params['method'] === 'Log.enable').map((command) => command.params['session']);
}

const CDP_EVENTS = ['goog:cdp.Runtime.consoleAPICalled', 'goog:cdp.Runtime.exceptionThrown', 'goog:cdp.Log.entryAdded'];

describe('the log of an attempt\'s pages', () => {
  it('is no event every session subscribes to: Chromium\'s mapper can exit formatting one', () => {
    expect(SESSION_EVENTS).not.toContain('log.entryAdded');
  });

  it('is heard off CDP for the attempt\'s user context on Chromium, once, with each tab told to report the browser\'s own lines', async () => {
    const fake = new FakeBidi();
    const { held } = await session(fake, 'chromium');
    expect(subscribed(fake)).toEqual([{ events: CDP_EVENTS, userContexts: ['mine'] }]);
    await held.newTab();
    fake.emit('browsingContext.contextCreated', { context: 'popup', userContext: 'mine', parent: null, originalOpener: 'tab', url: 'about:blank', children: null });
    await settle();
    expect(subscribed(fake)).toHaveLength(1);
    expect(reporting(fake)).toEqual(['cdp of tab', 'cdp of tab-2', 'cdp of popup']);
  });

  it('is heard off log.entryAdded for the attempt\'s user context on Firefox, with no CDP', async () => {
    const fake = new FakeBidi();
    const { held } = await session(fake, 'firefox');
    await held.newTab();
    expect(subscribed(fake)).toEqual([{ events: ['log.entryAdded'], userContexts: ['mine'] }]);
    expect(fake.commands('goog:cdp.getSession')).toEqual([]);
  });

  it('tells a tab it adopts to report the browser\'s own lines before anything listens, so the lines from before the attempt reach no one', async () => {
    const fake = new FakeBidi();
    await session(fake, 'chromium', 'adopt-tab');
    const order = fake.sent.filter((command) => command.method === 'session.subscribe' || command.params['method'] === 'Log.enable').map((command) => command.method);
    expect(order).toEqual(['goog:cdp.sendCommand', 'session.subscribe']);
    expect(reporting(fake)).toEqual(['cdp of theirs']);
  });

  it('tells a frame another process renders to report the browser\'s own lines once it navigated, and leaves one its tab\'s process renders', async () => {
    const fake = new FakeBidi().on('script.callFunction', { result: { type: 'success', realm: 'r', result: { type: 'string', value: '' } } });
    await session(fake, 'chromium');
    for (const frame of ['same-site-frame', 'cross-site-frame']) {
      fake.emit('browsingContext.contextCreated', { context: frame, parent: 'tab', url: 'about:blank', children: null });
      fake.emit('browsingContext.navigationCommitted', { context: frame, navigation: 'n', timestamp: 0, url: 'https://pay.test/frame' });
      fake.emit('browsingContext.navigationCommitted', { context: frame, navigation: 'n-2', timestamp: 0, url: 'https://pay.test/frame-2' });
    }
    await settle();
    expect(reporting(fake)).toEqual(['cdp of tab', 'cdp of cross-site-frame']);
  });

  it('ends its subscriptions when the attempt closes', async () => {
    const fake = new FakeBidi();
    const { held } = await session(fake, 'chromium');
    await held.close();
    expect(fake.commands('session.unsubscribe').map((command) => command.params)).toEqual([{ subscriptions: ['subscription-1'] }]);
  });

  it('fails the tab\'s open when the subscription is refused, closing the tab, and subscribes again for the next one', async () => {
    const fake = new FakeBidi();
    const { held } = await unopened(fake, 'firefox');
    fake.on('session.subscribe', (params) => (forLog(params) ? { error: 'invalid argument', message: 'no such event' } : { result: { subscription: 'other' } }));
    await expect(held.ensureContext()).rejects.toThrow('no such event');
    expect(fake.commands('browsingContext.close').map((command) => command.params['context'])).toEqual(['tab']);
    fake.on('session.subscribe', { result: { subscription: 'heard' } });
    await expect(held.ensureContext()).resolves.toBe('tab-2');
    expect(subscribed(fake)).toHaveLength(2);
  });

  it('routes Chromium\'s console calls, uncaught errors, and own lines to the app log, and leaves out debug lines and the echo of a failed load', async () => {
    const fake = new FakeBidi();
    const { log } = await session(fake, 'chromium');
    const cdp = (event: string, params: unknown): void => fake.emit(`goog:cdp.${event}`, { event, params, session: 'cdp of tab' });
    const at = { callFrames: [{ functionName: '', scriptId: '1', url: 'https://app.test/app.js', lineNumber: 11, columnNumber: 2 }] };
    cdp('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'deprecated %s' }, { type: 'string', value: 'prop' }], executionContextId: 1, timestamp: 0, stackTrace: at });
    cdp('Runtime.consoleAPICalled', { type: 'debug', args: [{ type: 'string', value: 'noise' }], executionContextId: 1, timestamp: 0 });
    cdp('Runtime.consoleAPICalled', { type: 'assert', args: [{ type: 'string', value: 'never' }], executionContextId: 1, timestamp: 0 });
    cdp('Runtime.exceptionThrown', { timestamp: 0, exceptionDetails: { exceptionId: 1, text: 'Uncaught', lineNumber: 0, columnNumber: 0, exception: { type: 'object', subtype: 'error', className: 'RangeError', description: 'RangeError: render loop exceeded' } } });
    cdp('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'WebSocket connection to \'ws://app.test/\' failed', timestamp: 0, stackTrace: at } });
    cdp('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', timestamp: 0, url: 'https://app.test/missing', networkRequestId: '1.2' } });
    cdp('Log.entryAdded', { entry: { source: 'violation', level: 'verbose', text: '[Violation] handler took 200ms', timestamp: 0 } });
    cdp('Log.entryAdded', { entry: { source: 'deprecation', level: 'warning', text: 'unload is deprecated', timestamp: 0 } });
    expect(log).toEqual([
      { source: 'console', level: 'warning', text: 'deprecated prop (at https://app.test/app.js:12)' },
      { source: 'console', level: 'error', text: 'never' },
      { source: 'error', level: 'error', text: 'RangeError: render loop exceeded' },
      { source: 'console', level: 'error', text: 'WebSocket connection to \'ws://app.test/\' failed (at https://app.test/app.js:12)' },
      { source: 'console', level: 'warning', text: 'unload is deprecated' },
    ]);
  });
});
