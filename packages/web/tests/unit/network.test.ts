/**
 * One attempt's network on the BiDi driver against a scripted peer:
 * intercepts scoped to the attempt's tabs, routes newest first with
 * fallback, site headers, failures on unawaited paths, basic-auth answers,
 * a route's own fetch of the request it holds, the `networkidle` window,
 * and response waits.
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContextTree } from '../../src/driver/context-tree.ts';
import { AttemptNetwork } from '../../src/driver/network.ts';
import type { NetworkRoute } from '../../src/driver/network-decisions.ts';
import { BROWSER_TRAITS, type BrowserName } from '../../src/browsers.ts';
import { ProtectedApp } from '../../src/protected-app.ts';
import type { Network } from 'webdriver-bidi-protocol';
import { FakeBidi, requestData, responseData, settle, type FakeEvent } from '../helpers/bidi-fake.ts';
import { gate } from '../helpers/gate.ts';

const SITE = 'http://app.test';

/** An attempt network over `fake`, and the failures it latched; `headers` configures one for the app's origin (`site`, else `SITE`), `credentials` its basic auth, and `credentialOrigins` lists more origins that get both. */
function network(
  fake: FakeBidi,
  options: { headers?: boolean; credentials?: { username: string; password: string }; site?: string; credentialOrigins?: readonly string[]; browser?: BrowserName; exclusive?: boolean; ours?: (context: string | null) => boolean; onPage?: (context: string | null) => boolean } = {},
) {
  const failures: Error[] = [];
  const contexts = new ContextTree();
  const lifetime = new AbortController();
  let intercepts = 0;
  fake.on('network.addIntercept', () => ({ result: { intercept: `intercept-${(intercepts += 1)}` } }));
  fake.on('network.addDataCollector', { result: { collector: 'collector-1' } });
  fake.on('session.subscribe', { result: { subscription: 'subscription-1' } });
  const net = new AttemptNetwork(fake.connection, {
    protectedApp: new ProtectedApp(new Set([options.site ?? SITE, ...(options.credentialOrigins ?? [])]), options.headers === true ? { 'X-Preview': 'token' } : undefined, options.credentials),
    ours: (event) => options.ours?.(event.context) ?? true,
    onPage: (context) => options.onPage?.(context) ?? true,
    contexts,
    exclusive: options.exclusive ?? false,
    traits: BROWSER_TRAITS[options.browser ?? 'chromium'],
    onFailure: (error) => failures.push(error),
    onNavigationAbort: () => undefined,
    lifetime: lifetime.signal,
  });
  /** Opens top-level tab `tab` of user-1, as its `contextCreated` event records it, and hands it to the network. */
  const open = (tab: string): Promise<void> => {
    contexts.created(tab, 'user-1', null);
    return net.addContext(tab);
  };
  /** Closes `tab`, as its `contextDestroyed` event tells the network and then the tree. */
  const close = (tab: string): Promise<void> => {
    const removed = net.removeContext(tab);
    contexts.destroyed(tab);
    return removed;
  };
  return { net, failures, contexts, open, close, lifetime };
}

/** A `beforeRequestSent` event held by `intercepts`, which a request nothing holds does not name. */
function request(id: string, url: string, intercepts: string[] = ['intercept-1']): Network.BeforeRequestSentParameters {
  const [first, ...rest] = intercepts;
  return {
    context: 'tab',
    isBlocked: first !== undefined,
    navigation: null,
    redirectCount: 0,
    timestamp: 0,
    ...(first === undefined ? {} : { intercepts: [first, ...rest] }),
    request: requestData(id, url, { headers: [{ name: 'Accept', value: { type: 'string', value: '*/*' } }] }),
  };
}

/** The event of a response with `status` to request `id` at `url`, which nothing holds unless `intercepts` do: with `fields` in its response. */
function responded(id: string, url: string, status: number, fields: Partial<Network.ResponseData> = {}, intercepts: string[] = []): Network.ResponseStartedParameters {
  return { ...request(id, url, intercepts), response: responseData(url, status, fields) };
}

/** The header that makes a 3xx response a redirect hop. */
const LOCATION: Network.Header[] = [{ name: 'Location', value: { type: 'string', value: '/next' } }];

/** A route on the URL `pattern` for the tests. */
function route(pattern: string, handle: NetworkRoute['handle']): NetworkRoute {
  return { pattern: { kind: 'string', value: pattern, exact: true }, handle };
}

describe('AttemptNetwork', () => {
  it('holds requests only for the attempt’s tabs, and starts over on a new user context', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true });
    await net.bind('user-1');
    expect(fake.commands('network.addIntercept')).toEqual([]);
    await open('tab-1');
    await open('tab-2');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([
      { phases: ['beforeRequestSent'], contexts: ['tab-1'] },
      { phases: ['beforeRequestSent'], contexts: ['tab-1', 'tab-2'] },
    ]);
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1']);
    await net.bind('user-2');
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept']).slice(1).toSorted()).toEqual(['intercept-1', 'intercept-2']);
    expect(fake.commands('session.subscribe').at(-1)?.params).toEqual({ events: ['network.beforeRequestSent', 'network.authRequired'], userContexts: ['user-2'] });
  });

  it('runs the newest matching route first and passes a fallback to the next', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    const order: string[] = [];
    await net.addRoute(route('**', async (_request, decisions) => {
      order.push('older');
      await decisions.fulfill({ status: 201, headers: {}, json: [{ name: 'Stubbed' }] });
    }));
    await net.addRoute(route('**/api/users', async (_request, decisions) => {
      order.push('newer');
      await decisions.fallback();
    }));
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/api/users`));
    await settle();
    await settle();
    expect(order).toEqual(['newer', 'older']);
    expect(fake.commands('network.provideResponse')[0]?.params).toEqual({
      request: 'r1',
      statusCode: 201,
      reasonPhrase: 'Created',
      headers: [{ name: 'content-type', value: { type: 'string', value: 'application/json' } }, { name: 'content-length', value: { type: 'string', value: '20' } }],
      body: { type: 'base64', value: Buffer.from('[{"name":"Stubbed"}]').toString('base64') },
    });
  });

  it('lets an unmatched request through, adding the site headers only for the app’s site', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true });
    await net.bind('user-1');
    await open('tab');
    fake.emit('network.beforeRequestSent', request('site', `${SITE}/page`));
    fake.emit('network.beforeRequestSent', request('other', 'https://cdn.test/lib.js'));
    await settle();
    const continued = fake.commands('network.continueRequest').map((command) => command.params);
    expect(continued).toContainEqual({
      request: 'site',
      headers: [{ name: 'accept', value: { type: 'string', value: '*/*' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }],
    });
    expect(continued).toContainEqual({ request: 'other' });
  });

  it('releases a held request whose route failed and reports the failure, but not a request the page already dropped', async () => {
    const fake = new FakeBidi();
    const { net, failures, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.addRoute(route('**', async () => {
      throw new Error('handler exploded');
    }));
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/a`));
    await settle();
    await settle();
    expect(fake.commands('network.failRequest').map((command) => command.params)).toEqual([{ request: 'r1' }]);
    expect(failures.map((error) => error.message)).toEqual(['handler exploded']);
    await net.removeRoutes(() => true);
    fake.on('network.continueRequest', { error: 'no such request', message: 'gone' });
    fake.emit('network.beforeRequestSent', request('r2', `${SITE}/b`));
    await settle();
    await settle();
    expect(failures).toHaveLength(1);
  });

  it('answers a basic-auth challenge once, then lets a refused one through as the 401', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { credentials: { username: 'ada', password: 'secret' } });
    await net.bind('user-1');
    await open('tab');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toContainEqual({ phases: ['authRequired'], contexts: ['tab'] });
    const challenge = { ...request('r1', `${SITE}/private`), response: responseData(`${SITE}/private`, 401) };
    fake.emit('network.authRequired', challenge);
    fake.emit('network.authRequired', challenge);
    await settle();
    expect(fake.commands('network.continueWithAuth').map((command) => command.params)).toEqual([
      { request: 'r1', action: 'provideCredentials', credentials: { type: 'password', username: 'ada', password: 'secret' } },
      { request: 'r1', action: 'cancel' },
    ]);
  });

  it('holds challenges on Firefox without credentials and lets each through as the 401', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { browser: 'firefox' });
    await net.bind('user-1');
    await open('tab');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([{ phases: ['authRequired'], contexts: ['tab'] }]);
    fake.emit('network.authRequired', { ...request('r1', `${SITE}/private`), response: responseData(`${SITE}/private`, 401) });
    await settle();
    expect(fake.commands('network.continueWithAuth').map((command) => command.params)).toEqual([{ request: 'r1', action: 'cancel' }]);
  });

  it('holds no challenge on Chromium without credentials', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    expect(fake.commands('network.addIntercept')).toEqual([]);
  });

  describe('a basic-auth challenge on each hop of a request', () => {
    type Emitted = FakeEvent;
    const first = `${SITE}/private`;
    const second = 'http://other.test/private';
    /** Hop `count` of the request starts at `url`, held by no intercept. */
    const sent = (url: string, count: number): Emitted => ['network.beforeRequestSent', { ...request('r', url, []), redirectCount: count }];
    /** A held challenge that names `url` as hop `count`. */
    const challenged = (url: string, count: number): Emitted => ['network.authRequired', { ...request('r', url), redirectCount: count, response: responseData(url, 401) }];
    /** The hop at `url` ends in a redirect. */
    const redirected = (url: string): Emitted => ['network.responseCompleted', responded('r', url, 302, { headers: LOCATION })];

    /**
     * Chromium announces each hop once and names the hop a challenge came
     * from. Firefox announces a hop again when it resends it with the
     * credentials, and names every challenge after the hop the request
     * started at.
     */
    it.each<[BrowserName, Emitted[]]>([
      ['chromium', [sent(first, 0), challenged(first, 0), redirected(first), sent(second, 1), challenged(second, 1), challenged(second, 1)]],
      ['firefox', [sent(first, 0), challenged(first, 0), sent(first, 0), redirected(first), sent(second, 1), challenged(first, 0), sent(second, 1), challenged(first, 0)]],
    ])('answers one from each credential origin a redirect leads through, and lets a second one on a hop through as the 401, as %s reports them', async (browser, events) => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { credentials: { username: 'ada', password: 'secret' }, credentialOrigins: [new URL(second).origin], browser });
      await net.bind('user-1');
      await open('tab');
      fake.emitAll(events);
      await settle();
      expect(fake.commands('network.continueWithAuth').map((command) => command.params['action'])).toEqual(['provideCredentials', 'provideCredentials', 'cancel']);
    });
  });

  it.each([
    ['its challenge was answered with', true],
    ['the browser holds for the realm, which raise no challenge', false],
  ])('sends a hop on as it is, past the routes and the redirect headers, when Firefox announces it again with the credentials %s', async (_name, challenged) => {
    const fake = new FakeBidi();
    const second = 'http://other.test/private';
    const { net, open } = network(fake, { headers: true, credentials: { username: 'ada', password: 'secret' }, credentialOrigins: [new URL(second).origin], browser: 'firefox' });
    await net.bind('user-1');
    await open('tab');
    let routed = 0;
    await net.addRoute(route('**', async (_held, decisions) => {
      routed += 1;
      await decisions.continue({ headers: { 'x-route': 'routed' } });
    }));
    /** Hop `count` of the request is announced at `url`, held, and what it was continued with. */
    const announced = async (url: string, count: number): Promise<Record<string, unknown> | undefined> => {
      fake.emit('network.beforeRequestSent', { ...request('r', url), redirectCount: count });
      await settle();
      await settle();
      return fake.commands('network.continueRequest').at(-1)?.params;
    };
    /** Hop `count` is announced again at `url`, after its challenge when one is raised, and what it was continued with. */
    const resent = (url: string, count: number): Promise<Record<string, unknown> | undefined> => {
      if (challenged) fake.emit('network.authRequired', { ...request('r', `${SITE}/private`), response: responseData(`${SITE}/private`, 401) });
      return announced(url, count);
    };
    const overridden = { request: 'r', headers: expect.arrayContaining([{ name: 'x-route', value: { type: 'string', value: 'routed' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }]) };
    expect(await announced(`${SITE}/private`, 0)).toEqual(overridden);
    expect(await resent(`${SITE}/private`, 0)).toEqual({ request: 'r' });
    fake.emit('network.responseCompleted', responded('r', `${SITE}/private`, 302, { headers: LOCATION }));
    expect(await announced(second, 1)).toEqual(overridden);
    expect(await resent(second, 1)).toEqual({ request: 'r' });
    expect(routed).toBe(1);
    expect(fake.commands('network.continueWithAuth').map((command) => command.params['action'])).toEqual(challenged ? ['provideCredentials', 'provideCredentials'] : []);
  });

  describe('a response wait on a request whose basic-auth challenge is held', () => {
    type Emitted = FakeEvent;
    const url = `${SITE}/private`;
    /** The request's hop starts, held by no intercept. */
    const sent: Emitted = ['network.beforeRequestSent', request('r', url, [])];
    /** A held challenge of the hop. */
    const challenged: Emitted = ['network.authRequired', { ...request('r', url), response: responseData(url, 401) }];
    /** The hop's response as `event` reports it: a 401 names a `scheme` challenge. */
    const response = (event: 'responseStarted' | 'responseCompleted', status: number, scheme = 'Basic'): Emitted =>
      [`network.${event}`, responded('r', url, status, status === 401 ? { authChallenges: [{ scheme, realm: 'preview' }] } : {})];

    /** A wait for the request's response on `browser`, with `credentials` configured or not, and the status it resolved with so far. */
    async function waitOn(browser: BrowserName, credentials: boolean) {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'the page' } } });
      const { net, open } = network(fake, { ...(credentials ? { credentials: { username: 'ada', password: 'secret' } } : {}), browser });
      await net.bind('user-1');
      await open('tab');
      const resolved: number[] = [];
      const waiting = net.waitForResponse((matched) => matched === url, AbortSignal.timeout(5_000));
      void waiting.then((matched) => resolved.push(matched.status), () => undefined);
      await settle();
      /** Emits `events` and lets the wait settle on them. */
      const emit = async (...events: Emitted[]): Promise<void> => {
        fake.emitAll(events);
        await settle();
      };
      return { fake, waiting, resolved, emit };
    }

    it('keeps the 401 of a challenge it answers with credentials from the wait, which resolves on the response they got, as Firefox reports them', async () => {
      const { fake, waiting, resolved, emit } = await waitOn('firefox', true);
      await emit(sent, response('responseStarted', 401), challenged, sent);
      expect(fake.commands('network.continueWithAuth').map((command) => command.params['action'])).toEqual(['provideCredentials']);
      expect(resolved).toEqual([]);
      await emit(response('responseStarted', 200), response('responseCompleted', 200));
      expect(resolved).toEqual([200]);
      await expect((await waiting).body().then(String)).resolves.toBe('the page');
    });

    it.each<[string, boolean, Emitted[]]>([
      ['the credentials were refused', true, [sent, response('responseStarted', 401), challenged, sent, response('responseStarted', 401)]],
      ['there are no credentials', false, [sent, response('responseStarted', 401)]],
    ])('hands the wait the 401 once its challenge goes through because %s, as Firefox reports them', async (_name, credentials, events) => {
      const { fake, waiting, resolved, emit } = await waitOn('firefox', credentials);
      await emit(...events);
      expect(resolved).toEqual([]);
      await emit(challenged);
      expect(fake.commands('network.continueWithAuth').at(-1)?.params['action']).toBe('cancel');
      expect(resolved).toEqual([401]);
      await emit(response('responseCompleted', 401));
      await expect((await waiting).body().then(String)).resolves.toBe('the page');
    });

    it('hands the wait a challenge the browser raises to nobody once its response completed', async () => {
      const { waiting, resolved, emit } = await waitOn('firefox', true);
      await emit(sent, response('responseStarted', 401, 'Bearer'));
      expect(resolved).toEqual([]);
      await emit(response('responseCompleted', 401, 'Bearer'));
      expect(resolved).toEqual([401]);
      await expect((await waiting).body().then(String)).resolves.toBe('the page');
    });

    it.each<[string, boolean, Emitted[]]>([
      ['no challenge is held', false, []],
      ['its challenge already went through', true, [challenged, challenged]],
    ])('hands the wait a 401 on its headers where %s, as Chromium reports them', async (_name, credentials, challenges) => {
      const { resolved, emit } = await waitOn('chromium', credentials);
      await emit(sent, ...challenges, response('responseStarted', 401));
      expect(resolved).toEqual([401]);
    });

    it('leaves a wait that ended with its match still parked out of the request', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { browser: 'firefox' });
      await net.bind('user-1');
      await open('tab');
      const ending = new AbortController();
      const waiting = net.waitForResponse(() => true, ending.signal);
      await settle();
      fake.emitAll([sent, response('responseStarted', 401)]);
      ending.abort();
      await expect(waiting).rejects.toThrow();
      fake.emitAll([challenged, response('responseCompleted', 401)]);
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'r' }]);
    });
  });

  it('refuses a URL rewrite on Firefox before the request goes, and fails the request', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { browser: 'firefox' });
    const errors: unknown[] = [];
    await net.bind('user-1');
    await net.addRoute(route(`${SITE}/a`, (_request, decisions) => decisions.continue({ url: `${SITE}/other` }).catch((cause: unknown) => {
      errors.push(cause);
      throw cause;
    })));
    await open('tab');
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/a`));
    await settle();
    expect(errors).toEqual([expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' })]);
    expect(fake.commands('network.continueRequest')).toEqual([]);
    expect(fake.commands('network.failRequest').map((command) => command.params)).toEqual([{ request: 'r1' }]);
  });

  it('waits for 500 ms with no request in flight before calling the network idle', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    await net.track();
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/slow`, []));
    const started = Date.now();
    let idle = false;
    const waiting = net.waitForIdle(AbortSignal.timeout(5_000)).then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(idle).toBe(false);
    fake.emit('network.responseCompleted', responded('r1', `${SITE}/slow`, 200));
    await waiting;
    expect(Date.now() - started).toBeGreaterThanOrEqual(690);
  });

  it('resolves a response wait on the headers of the first match in the tab, and reads its body once loaded', async () => {
    const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: '[1,2,3]' } } });
    const { net } = network(fake, { onPage: (context) => context === 'tab' });
    await net.bind('user-1');
    const waiting = net.waitForResponse((url) => url.endsWith('/api/users'), AbortSignal.timeout(5_000));
    await settle();
    const started = (id: string, url: string, context = 'tab'): Network.ResponseStartedParameters => ({
      ...responded(id, url, 200, { headers: [{ name: 'Content-Type', value: { type: 'string', value: 'application/json' } }] }),
      context,
    });
    fake.emit('network.responseStarted', started('other', `${SITE}/other`));
    fake.emit('network.responseStarted', started('popup', `${SITE}/api/users`, 'popup'));
    fake.emit('network.responseStarted', started('users', `${SITE}/api/users`));
    const response = await waiting;
    expect(response).toMatchObject({ url: `${SITE}/api/users`, status: 200, headers: { 'content-type': 'application/json' } });
    let read = false;
    const body = response.body().then((bytes) => {
      read = true;
      return bytes.toString();
    });
    await settle();
    expect(read).toBe(false);
    fake.emit('network.responseCompleted', started('users', `${SITE}/api/users`));
    await expect(body).resolves.toBe('[1,2,3]');
    expect(fake.commands('network.getData')[0]?.params).toEqual({ dataType: 'response', request: 'users', collector: 'collector-1', disown: true });
  });

  it('rejects a body read with the browser’s error when the load failed', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    fake.emit('network.responseStarted', responded('cut', `${SITE}/cut`, 200));
    const response = await waiting;
    fake.emit('network.fetchError', { ...request('cut', `${SITE}/cut`, []), errorText: 'net::ERR_CONTENT_LENGTH_MISMATCH' });
    await expect(response.body()).rejects.toThrow('net::ERR_CONTENT_LENGTH_MISMATCH');
  });

  it('tells a wait how its load ended after its tab closed', async () => {
    const fake = new FakeBidi();
    const { net, open, close } = network(fake);
    await net.bind('user-1');
    await open('tab');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    fake.emit('network.responseStarted', responded('gone', `${SITE}/gone`, 200));
    const response = await waiting;
    await close('tab');
    fake.emit('network.fetchError', { ...request('gone', `${SITE}/gone`, []), errorText: 'net::ERR_ABORTED' });
    await expect(response.body()).rejects.toThrow('net::ERR_ABORTED');
  });

  it('adds one response collector for concurrent waits', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    const first = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    const second = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    fake.emit('network.responseStarted', responded('r', `${SITE}/r`, 200));
    await Promise.all([first, second]);
    expect(fake.commands('network.addDataCollector')).toHaveLength(1);
    await net.bind('user-2');
    expect(fake.commands('network.removeDataCollector')).toHaveLength(1);
  });

  it('on a browser of its own, holds every tab with one intercept and lets another user context’s requests go untouched', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true, exclusive: true, ours: (context) => context !== 'foreign' });
    await net.bind('user-1');
    await open('tab-1');
    await open('tab-2');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([{ phases: ['beforeRequestSent'] }]);
    fake.emit('network.beforeRequestSent', { ...request('popup', `${SITE}/popup`), context: 'popup' });
    fake.emit('network.beforeRequestSent', { ...request('foreign', `${SITE}/x`), context: 'foreign' });
    await settle();
    expect(fake.commands('network.continueRequest').map((command) => command.params)).toEqual([
      { request: 'popup', headers: [{ name: 'accept', value: { type: 'string', value: '*/*' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }] },
      { request: 'foreign' },
    ]);
  });

  it('decides a request an intercept it since replaced still holds', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true });
    await net.bind('user-1');
    await open('tab-1');
    await open('tab-2');
    fake.emit('network.beforeRequestSent', request('held', `${SITE}/held`, ['intercept-1']));
    await settle();
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['held']);
  });

  it('answers a blank-served tab’s documents before any route, and fails its other requests', async () => {
    const fake = new FakeBidi();
    const { net, contexts } = network(fake);
    await net.bind('user-1');
    let routed = 0;
    await net.addRoute(route('**', async () => {
      routed += 1;
    }));
    contexts.created('scratch', 'user-1', null);
    const undo = await net.serveBlank('scratch');
    fake.emit('network.beforeRequestSent', { ...request('doc', `${SITE}/`), context: 'scratch', navigation: 'nav-1' });
    fake.emit('network.beforeRequestSent', { ...request('img', `${SITE}/a.png`), context: 'scratch' });
    await settle();
    expect(routed).toBe(0);
    expect(fake.commands('network.provideResponse').map((command) => command.params['request'])).toEqual(['doc']);
    expect(fake.commands('network.failRequest').map((command) => command.params['request'])).toEqual(['img']);
    await undo();
    fake.emit('network.beforeRequestSent', { ...request('later', `${SITE}/`), context: 'scratch', navigation: 'nav-2' });
    await settle();
    expect(routed).toBe(1);
  });

  it('reads the body of a response whose load completes in the same burst as its headers', async () => {
    const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'fast' } } });
    const { net } = network(fake);
    await net.bind('user-1');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    const event = responded('fast', `${SITE}/fast`, 200);
    fake.emit('network.responseStarted', event);
    fake.emit('network.responseCompleted', event);
    const response = await waiting;
    await expect(response.body().then(String)).resolves.toBe('fast');
  });

  describe('a route’s fetch of the request it holds', () => {
    /** What the upstream server received, in order. */
    const received: { url: string | undefined; method: string | undefined; headers: IncomingHttpHeaders; body: string }[] = [];
    /** Runs when the server gets a request for `/hang`, which it never answers. */
    let hang: () => void = () => undefined;
    let server: Server;
    let origin: string;

    beforeAll(async () => {
      server = createServer((incoming, response) => {
        let body = '';
        incoming.on('data', (chunk: Buffer) => (body += chunk.toString()));
        incoming.on('end', () => {
          received.push({ url: incoming.url, method: incoming.method, headers: incoming.headers, body });
          if (incoming.url === '/hang') {
            hang();
            return;
          }
          if (incoming.url === '/private' && incoming.headers.authorization === undefined) {
            response.writeHead(401, { 'www-authenticate': 'Basic realm="preview"' }).end();
            return;
          }
          response.setHeader('set-cookie', ['sid=fresh; Path=/; HttpOnly', 'theme=dark']);
          response.writeHead(200, { 'content-type': 'text/plain' }).end('upstream');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /**
     * A network whose one route fetches the request it holds, then fulfills
     * it; resolves with what the fetch gave the route once `held`, a
     * `beforeRequestSent` event, went through it. `before` runs between the
     * request being held and the fetch.
     */
    async function fetched(fake: FakeBidi, options: Parameters<typeof network>[1], held: (origin: string) => Network.BeforeRequestSentParameters, before: (net: AttemptNetwork) => Promise<void> = async () => undefined) {
      received.length = 0;
      const created = network(fake, { site: origin, ...options });
      await created.net.bind('user-1');
      await created.open('tab');
      const outcome = new Promise<{ status?: number; headers?: Readonly<Record<string, string>>; body?: string; failure?: unknown }>((resolve) => {
        void created.net.addRoute(route('**', async (_request, decisions) => {
          await before(created.net);
          try {
            const response = await decisions.fetch({ signal: new AbortController().signal, timeoutMs: 5_000 });
            resolve({ status: response.status, headers: response.headers, body: (await response.body()).toString() });
          } catch (failure) {
            resolve({ failure });
          }
          await decisions.fulfill({ status: 204, headers: {} });
        })).then(() => fake.emit('network.beforeRequestSent', held(origin)));
      });
      return { ...created, outcome: await outcome };
    }

    it('sends the request as the browser sent it, with its cookies, its body, and the configured headers', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'a=1' } } });
      const { outcome } = await fetched(fake, { headers: true, browser: 'firefox' }, (site) => {
        const posted = request('post', `${site}/form`);
        const cookie = (name: string, value: Network.BytesValue): Network.Cookie => ({ name, value, domain: new URL(site).hostname, path: '/', size: 0, httpOnly: false, secure: false, sameSite: 'lax' });
        const cookies = [cookie('sid', { type: 'string', value: 'old' }), cookie('lang', { type: 'base64', value: Buffer.from('en').toString('base64') })];
        return { ...posted, request: { ...posted.request, method: 'POST', bodySize: 3, cookies } };
      });
      expect(outcome).toMatchObject({ status: 200, body: 'upstream', headers: { 'content-type': 'text/plain', 'set-cookie': 'sid=fresh; Path=/; HttpOnly\ntheme=dark' } });
      expect(received).toEqual([{ url: '/form', method: 'POST', headers: expect.objectContaining({ accept: '*/*', cookie: 'sid=old; lang=en', 'x-preview': 'token' }), body: 'a=1' }]);
    });

    it('stores the cookies the response sets in the request’s user context', async () => {
      const fake = new FakeBidi();
      await fetched(fake, {}, (site) => request('r', `${site}/account/settings`));
      expect(fake.commands('storage.setCookie').map((command) => command.params)).toEqual([
        { cookie: { name: 'sid', value: { type: 'string', value: 'fresh' }, domain: '127.0.0.1', path: '/', httpOnly: true }, partition: { type: 'storageKey', userContext: 'user-1' } },
        { cookie: { name: 'theme', value: { type: 'string', value: 'dark' }, domain: '127.0.0.1', path: '/account' }, partition: { type: 'storageKey', userContext: 'user-1' } },
      ]);
    });

    it('stores no cookie of a user context the attempt has since replaced', async () => {
      const fake = new FakeBidi();
      const { outcome, failures } = await fetched(fake, {}, (site) => request('r', `${site}/`), (net) => net.bind('user-2'));
      expect(outcome).toMatchObject({ status: 200, body: 'upstream' });
      expect(fake.commands('storage.setCookie')).toEqual([]);
      expect(failures).toEqual([]);
    });

    it('answers a Basic challenge from a credential origin once, and from no other', async () => {
      const credentials = { username: 'ada', password: 'secret' };
      const answered = await fetched(new FakeBidi(), { credentials }, (site) => request('r', `${site}/private`));
      expect(answered.outcome.status).toBe(200);
      expect(received.map((one) => one.headers.authorization)).toEqual([undefined, `Basic ${Buffer.from('ada:secret').toString('base64')}`]);
      const elsewhere = await fetched(new FakeBidi(), { credentials, site: SITE }, (site) => request('r', `${site}/private`));
      expect([elsewhere.outcome.status, received]).toEqual([401, [expect.anything()]]);
    });

    it('refuses to fetch a request whose body the browser did not keep, rather than send none', async () => {
      const fake = new FakeBidi().on('network.getData', () => ({ error: 'no such network data', message: 'evicted' }));
      const { outcome } = await fetched(fake, { browser: 'firefox' }, (site) => {
        const posted = request('post', `${site}/upload`);
        return { ...posted, request: { ...posted.request, method: 'POST', bodySize: 30_000_000 } };
      });
      expect(outcome.failure).toMatchObject({ code: 'ACTION_FAILED', message: 'route.fetch: the browser kept none of the request body (too large or streamed), so the request cannot be replayed' });
      expect(received).toEqual([]);
    });

    describe('of a held navigation that posts a form', () => {
      const fake = (): FakeBidi => new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'a=1' } } });
      const submission = (site: string): Network.BeforeRequestSentParameters => {
        const posted = request('post', `${site}/form`);
        return { ...posted, navigation: 'nav-1', request: { ...posted.request, method: 'POST', bodySize: 3 } };
      };

      it('refuses on a browser that reports no body for it, with that reason, without asking for the body', async () => {
        const browser = fake();
        const { outcome } = await fetched(browser, { browser: 'chromium' }, submission);
        expect(outcome.failure).toMatchObject({ code: 'ACTION_FAILED', message: 'route.fetch: this browser reports no body for a navigation it holds, such as a form submission, so the request cannot be replayed' });
        expect(browser.commands('network.getData')).toEqual([]);
        expect(received).toEqual([]);
      });

      it('sends the form on a browser that reports its body', async () => {
        const { outcome } = await fetched(fake(), { browser: 'firefox' }, submission);
        expect(outcome).toMatchObject({ status: 200, body: 'upstream' });
        expect(received).toEqual([expect.objectContaining({ url: '/form', method: 'POST', body: 'a=1' })]);
      });
    });

    it('ends a fetch still waiting for its response when the attempt closes', async () => {
      const fake = new FakeBidi();
      const { net, open, lifetime } = network(fake, { site: origin });
      await net.bind('user-1');
      await open('tab');
      const { held: failure, release: failed } = gate<unknown>();
      await net.addRoute(route('**', async (_request, decisions) => {
        await decisions.fetch({ signal: new AbortController().signal, timeoutMs: 5_000 }).catch(failed);
        await decisions.abort();
      }));
      hang = () => lifetime.abort();
      fake.emit('network.beforeRequestSent', request('r', `${origin}/hang`));
      expect(await failure).toMatchObject({ name: 'AbortError' });
    });
  });

  it('never covers a tab that opened and closed in the same burst, nor one that closed while its intercept was added', async () => {
    const fake = new FakeBidi();
    const { net, open, close } = network(fake, { headers: true });
    let intercepts = 0;
    fake.on('network.addIntercept', (params) => {
      if ((params['contexts'] as string[]).includes('popup')) {
        void close('popup');
        return { error: 'no such frame', message: 'gone' };
      }
      return { result: { intercept: `intercept-${(intercepts += 1)}` } };
    });
    await net.bind('user-1');
    void open('flash');
    await close('flash');
    expect(fake.commands('network.addIntercept')).toEqual([]);
    await open('tab');
    await open('popup');
    expect(fake.commands('network.addIntercept').map((command) => command.params['contexts'])).toEqual([['tab'], ['tab', 'popup'], ['tab']]);
  });

  it('calls the network idle while a tab the app opened is still busy', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { onPage: (context) => context === 'tab' });
    await net.bind('user-1');
    await net.track();
    fake.emit('network.beforeRequestSent', { ...request('poll', `${SITE}/poll`, []), context: 'popup' });
    const started = Date.now();
    await net.waitForIdle(AbortSignal.timeout(5_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports a removal the browser refused, and takes one it no longer has as done', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true, exclusive: true });
    fake.on('network.addIntercept', { result: { intercept: 'global' } });
    await net.bind('user-1');
    await open('tab');
    fake.on('network.removeIntercept', { error: 'unknown error', message: 'refused' });
    await expect(net.dispose()).rejects.toThrow('refused');
    const again = new FakeBidi();
    const { net: second, open: secondOpen } = network(again, { headers: true, exclusive: true });
    again.on('network.addIntercept', { result: { intercept: 'global' } });
    await second.bind('user-1');
    await secondOpen('tab');
    again.on('network.removeIntercept', { error: 'no such intercept', message: 'gone' });
    await expect(second.dispose()).resolves.toBeUndefined();
  });

  it('removes a replacement intercept whose predecessor would not go, when the network is released', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true });
    await net.bind('user-1');
    await open('tab-1');
    fake.on('network.removeIntercept', (params) => (params['intercept'] === 'intercept-1' ? { error: 'unknown error', message: 'stuck' } : { result: {} }));
    await expect(open('tab-2')).rejects.toThrow('stuck');
    fake.on('network.removeIntercept', { result: {} });
    await net.dispose();
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toContain('intercept-2');
  });

  describe('redirect hops and the configured headers', () => {
    /** The `x-preview` header and the route's own on a redirect hop's continue, or undefined when it went on untouched. */
    async function hop(fake: FakeBidi, id: string, url: string, count: number, carried: Record<string, string>): Promise<Record<string, string> | undefined> {
      const base = request(id, url);
      const headers = Object.entries({ Accept: '*/*', ...carried }).map(([name, value]): Network.Header => ({ name, value: { type: 'string', value } }));
      fake.emit('network.beforeRequestSent', { ...base, redirectCount: count, request: { ...base.request, headers } });
      await settle();
      await settle();
      const sent = fake.commands('network.continueRequest').at(-1)?.params;
      if (sent?.['request'] !== id) throw new Error(`no continue for ${id}`);
      const wire = sent['headers'] as { name: string; value: { value: string } }[] | undefined;
      return wire === undefined ? undefined : Object.fromEntries(wire.map((header) => [header.name, header.value.value]));
    }

    it('keeps the configured headers a request started with on every hop, wherever it goes, for a request no route matched', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { headers: true });
      await net.bind('user-1');
      await open('tab');
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/start`));
      await settle();
      expect(fake.commands('network.continueRequest').at(-1)?.params['headers']).toContainEqual({ name: 'x-preview', value: { type: 'string', value: 'token' } });
      expect(await hop(fake, 'r', `${SITE}/next`, 1, {})).toEqual({ accept: '*/*', 'x-preview': 'token' });
      expect(await hop(fake, 'r', 'https://external.test/end', 2, { 'x-preview': 'token' })).toEqual({ accept: '*/*', 'x-preview': 'token' });
      expect(await hop(fake, 'r', 'https://external.test/again', 3, {})).toEqual({ accept: '*/*', 'x-preview': 'token' });
    });

    it('applies a route’s header overrides and the configured headers to every hop', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { headers: true });
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (held, decisions) => {
        await decisions.continue({ headers: { ...held.headers, 'X-Route': 'routed' } });
      }));
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/start`));
      await settle();
      await settle();
      expect(await hop(fake, 'r', `${SITE}/next`, 1, {})).toEqual({ accept: '*/*', 'x-route': 'routed', 'x-preview': 'token' });
      expect(await hop(fake, 'r', 'https://external.test/end', 2, { 'x-preview': 'token', 'x-route': 'routed' })).toEqual({ accept: '*/*', 'x-route': 'routed', 'x-preview': 'token' });
    });

    it.each(['POST', 'PUT'])('leaves the headers of a request body off every hop once a redirect turned the %s into a GET', async (method) => {
      const fake = new FakeBidi().on('goog:cdp.sendCommand', { result: { result: { postData: 'a=1', base64Encoded: false } } });
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (held, decisions) => {
        await decisions.continue({ headers: { ...held.headers, 'x-route': 'routed' } });
      }));
      const posted = request('r', `${SITE}/form`);
      const headers: Network.Header[] = [{ name: 'Accept', value: { type: 'string', value: '*/*' } }, { name: 'Content-Type', value: { type: 'string', value: 'application/x-www-form-urlencoded' } }];
      fake.emit('network.beforeRequestSent', { ...posted, request: { ...posted.request, method, bodySize: 3, headers } });
      await settle();
      await settle();
      expect(fake.commands('network.continueRequest').at(-1)?.params['headers']).toContainEqual({ name: 'content-type', value: { type: 'string', value: 'application/x-www-form-urlencoded' } });
      expect(await hop(fake, 'r', `${SITE}/done`, 1, {})).toEqual({ accept: '*/*', 'x-route': 'routed' });
      expect(await hop(fake, 'r', `${SITE}/again`, 2, {})).toEqual({ accept: '*/*', 'x-route': 'routed' });
    });

    it('keeps the configured headers on the hop a redirect a route fulfilled leads to, for a request that started at the app’s origin', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { headers: true });
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**/moved', async (_held, decisions) => {
        await decisions.fulfill({ status: 302, headers: { location: `${SITE}/home` } });
      }));
      for (const [id, origin] of [['app', SITE], ['external', 'https://external.test']] as const) fake.emit('network.beforeRequestSent', request(id, `${origin}/moved`));
      await settle();
      await settle();
      expect(fake.commands('network.provideResponse').map((command) => command.params['request'])).toEqual(['app', 'external']);
      expect(await hop(fake, 'app', `${SITE}/home`, 1, {})).toEqual({ accept: '*/*', 'x-preview': 'token' });
      expect(await hop(fake, 'external', `${SITE}/home`, 1, {})).toBeUndefined();
    });

    it('sends nothing configured on a request that starts at another origin and redirects to the app’s', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { headers: true });
      await net.bind('user-1');
      await open('tab');
      fake.emit('network.beforeRequestSent', request('r', 'https://external.test/start'));
      await settle();
      expect(fake.commands('network.continueRequest').at(-1)?.params).toEqual({ request: 'r' });
      expect(await hop(fake, 'r', `${SITE}/in`, 1, {})).toBeUndefined();
      expect(await hop(fake, 'r', 'https://external.test/out', 2, {})).toBeUndefined();
    });
  });

  it('calls a new user context idle while a request of the one it replaced never finished', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    await net.track();
    fake.emit('network.beforeRequestSent', request('stuck', `${SITE}/stuck`, []));
    await net.bind('user-2');
    await net.track();
    const started = Date.now();
    await net.waitForIdle(AbortSignal.timeout(2_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops counting the requests of a tab that closed without their events', async () => {
    const fake = new FakeBidi();
    const { net, open, close } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.track();
    fake.emit('network.beforeRequestSent', request('stuck', `${SITE}/stuck`, []));
    await close('tab');
    await net.waitForIdle(AbortSignal.timeout(2_000));
  });

  it.each([
    ['the subscription', 'session.subscribe'],
    ['the intercept', 'network.addIntercept'],
  ])('takes a route back when %s fails to install, and installs everything on the next try', async (_step, method) => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    let failed = false;
    let intercepts = 0;
    const answers: Record<string, (params: Record<string, unknown>) => { result: unknown }> = {
      'session.subscribe': () => ({ result: { subscription: 'subscription-1' } }),
      'network.addIntercept': () => ({ result: { intercept: `intercept-${(intercepts += 1)}` } }),
    };
    fake.on(method, (params) => {
      if (!failed) {
        failed = true;
        return { error: 'unknown error', message: 'install failed' };
      }
      return answers[method]!(params);
    });
    const handled: string[] = [];
    await expect(net.addRoute(route('**', async (_held, decisions) => {
      handled.push('first');
      await decisions.continue({});
    }))).rejects.toThrow('install failed');
    await net.addRoute(route('**', async (_held, decisions) => {
      handled.push('second');
      await decisions.fallback();
    }));
    expect(fake.commands('session.subscribe')).toHaveLength(method === 'session.subscribe' ? 2 : 1);
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([
      ...(method === 'network.addIntercept' ? [{ phases: ['beforeRequestSent'], contexts: ['tab'] }] : []),
      { phases: ['beforeRequestSent'], contexts: ['tab'] },
    ]);
    fake.emit('network.beforeRequestSent', request('r', `${SITE}/a`));
    await settle();
    await settle();
    expect(handled).toEqual(['second']);
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['r']);
  });

  describe('a response body still loading', () => {
    /** A network bound to user-1, and a response whose headers arrived but whose body never finished. */
    async function pending() {
      const fake = new FakeBidi();
      const { net } = network(fake);
      await net.bind('user-1');
      const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.responseStarted', responded('r', `${SITE}/r`, 200));
      return { fake, net, response: await waiting };
    }

    it('fails its read once the network is disposed', async () => {
      const { net, response } = await pending();
      await net.dispose();
      await expect(response.body()).rejects.toThrow('the network ended before the response finished loading');
    });

    it('fails a read already waiting when the network is disposed', async () => {
      const { net, response } = await pending();
      const body = response.body();
      await net.dispose();
      await expect(body).rejects.toThrow('the network ended');
    });

    it('fails its read once the user context is replaced', async () => {
      const { net, response } = await pending();
      await net.bind('user-2');
      await expect(response.body()).rejects.toThrow('the network ended');
    });

    it('fails its read once the connection closes', async () => {
      const { fake, response } = await pending();
      fake.drop();
      await expect(response.body()).rejects.toThrow('the BiDi connection closed');
    });
  });

  it('keeps a removal that failed while rebinding, and tries it again on dispose', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true, exclusive: true });
    fake.on('network.addIntercept', { result: { intercept: 'global' } });
    await net.bind('user-1');
    await open('tab');
    fake.on('network.removeIntercept', { error: 'unknown error', message: 'stuck' });
    await expect(net.bind('user-2')).rejects.toThrow('stuck');
    fake.on('network.removeIntercept', { result: {} });
    await net.dispose();
    expect(fake.commands('network.removeIntercept').filter((command) => command.params['intercept'] === 'global').length).toBeGreaterThanOrEqual(2);
  });

  it('binds the new user context with what the attempt needs when a removal for the old one failed, and still reports the removal', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { headers: true, exclusive: true });
    await net.bind('user-1');
    fake.on('network.removeIntercept', { error: 'unknown error', message: 'stuck' });
    await expect(net.bind('user-2')).rejects.toThrow('stuck');
    expect(fake.commands('session.subscribe').at(-1)?.params).toEqual({ events: ['network.beforeRequestSent', 'network.authRequired'], userContexts: ['user-2'] });
    fake.emit('network.beforeRequestSent', request('held', `${SITE}/page`, ['intercept-2']));
    await settle();
    expect(fake.commands('network.continueRequest').map((command) => command.params)).toEqual([{
      request: 'held',
      headers: [{ name: 'accept', value: { type: 'string', value: '*/*' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }],
    }]);
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    fake.emit('network.responseStarted', responded('r', `${SITE}/r`, 200));
    await expect(waiting).resolves.toMatchObject({ url: `${SITE}/r`, status: 200 });
  });

  it('reports what the new user context could not install over a removal for the old one that failed, which dispose tries again', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { headers: true, exclusive: true });
    await net.bind('user-1');
    fake.on('network.removeIntercept', { error: 'unknown error', message: 'stuck' });
    fake.on('network.addIntercept', { error: 'unknown error', message: 'refused' });
    await expect(net.bind('user-2')).rejects.toThrow('refused');
    fake.on('network.removeIntercept', { result: {} });
    await net.dispose();
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1', 'intercept-1']);
  });

  it('takes a blank-served tab back out when what serves it could not be installed', async () => {
    const fake = new FakeBidi();
    const { net, contexts } = network(fake);
    await net.bind('user-1');
    contexts.created('scratch', 'user-1', null);
    fake.on('network.addIntercept', { error: 'unknown error', message: 'refused' });
    await expect(net.serveBlank('scratch')).rejects.toThrow('refused');
    fake.on('network.addIntercept', { result: { intercept: 'intercept-1' } });
    let routed = 0;
    await net.addRoute(route('**', async (_held, decisions) => {
      routed += 1;
      await decisions.fallback();
    }));
    fake.emit('network.beforeRequestSent', { ...request('doc', `${SITE}/`), context: 'scratch', navigation: 'nav-1' });
    await settle();
    await settle();
    expect(routed).toBe(1);
    expect(fake.commands('network.provideResponse')).toEqual([]);
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['doc']);
  });

  describe('what a request leaves behind once it is over', () => {
    it('forgets a basic-auth answer once its tab closed mid-redirect, so a new challenge gets the credentials', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { credentials: { username: 'ada', password: 'secret' } });
      await net.bind('user-1');
      await open('tab');
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/private`, []));
      fake.emit('network.authRequired', { ...request('r', `${SITE}/private`), response: responseData(`${SITE}/private`, 401) });
      fake.emit('network.responseCompleted', responded('r', `${SITE}/private`, 302, { headers: LOCATION }));
      net.retire('tab');
      fake.emit('network.authRequired', { ...request('r', `${SITE}/private`), response: responseData(`${SITE}/private`, 401) });
      await settle();
      expect(fake.commands('network.continueWithAuth').map((command) => command.params['action'])).toEqual(['provideCredentials', 'provideCredentials']);
    });

    it('forgets a redirect policy once its tab closed mid-redirect', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (held, decisions) => {
        await decisions.continue({ headers: { ...held.headers, 'x-route': 'routed' } });
      }));
      fake.emit('network.beforeRequestSent', request('r', 'https://external.test/start'));
      await settle();
      await settle();
      fake.emit('network.responseCompleted', responded('r', 'https://external.test/start', 302, { headers: LOCATION }));
      net.retire('tab');
      fake.emit('network.beforeRequestSent', { ...request('r', 'https://external.test/again'), redirectCount: 1 });
      await settle();
      expect(fake.commands('network.continueRequest').at(-1)?.params).toEqual({ request: 'r' });
    });

    it.each([
      ['a 304', 304, []],
      ['a 304 that names a Location', 304, LOCATION],
      ['a redirect status with no Location', 302, []],
    ])('releases %s as a last hop, and keeps a redirect hop for its next one', async (_name, status, headers) => {
      const fake = new FakeBidi();
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (held, decisions) => {
        await decisions.continue({ headers: { ...held.headers, 'x-route': 'routed' } });
      }));
      const start = 'https://external.test/start';
      for (const id of ['last', 'hop']) fake.emit('network.beforeRequestSent', request(id, start));
      await settle();
      await settle();
      fake.emit('network.responseCompleted', responded('last', start, status, { headers }));
      fake.emit('network.responseCompleted', responded('hop', start, 302, { headers: LOCATION }));
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'last' }]);
      for (const id of ['last', 'hop']) fake.emit('network.beforeRequestSent', { ...request(id, 'https://external.test/next'), redirectCount: 1 });
      await settle();
      const [last, hop] = fake.commands('network.continueRequest').slice(-2).map((command) => command.params);
      expect(last).toEqual({ request: 'last' });
      expect(hop).toMatchObject({ request: 'hop', headers: expect.arrayContaining([{ name: 'x-route', value: { type: 'string', value: 'routed' } }]) });
    });

    it('keeps a fulfilled body only until its response completed', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'from the collector' } } });
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (_held, decisions) => {
        await decisions.fulfill({ status: 200, headers: {}, body: 'fulfilled' });
      }));
      const response = (id: string) => responded(id, `${SITE}/a`, 200);
      const first = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/a`));
      await settle();
      await settle();
      fake.emit('network.responseStarted', response('r'));
      fake.emit('network.responseCompleted', response('r'));
      await expect((await first).body().then(String)).resolves.toBe('fulfilled');
      await net.removeRoutes(() => true);
      const again = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.responseStarted', response('r'));
      fake.emit('network.responseCompleted', response('r'));
      await expect((await again).body().then(String)).resolves.toBe('from the collector');
    });

    it.each([
      ['reports the redirect’s response, as Chromium does', true],
      ['reports none for the redirect, as Firefox does', false],
    ])('keeps the body of a fulfilled redirect off the hop it led to, on a browser that %s', async (_name, reported) => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'landed' } } });
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (_held, decisions) => {
        await decisions.fulfill({ status: 302, headers: { location: '/next' }, body: 'moved' });
      }));
      /** Request `id` is fulfilled with the redirect and followed to the page it names. */
      const follow = async (id: string): Promise<void> => {
        const moved = responded(id, `${SITE}/moved`, 302, { headers: LOCATION });
        const landed = { ...responded(id, `${SITE}/next`, 200), redirectCount: 1 };
        fake.emit('network.beforeRequestSent', request(id, `${SITE}/moved`));
        await settle();
        await settle();
        if (reported) for (const event of ['network.responseStarted', 'network.responseCompleted'] as const) fake.emit(event, moved);
        fake.emit('network.beforeRequestSent', { ...request(id, `${SITE}/next`), redirectCount: 1 });
        fake.emit('network.responseStarted', landed);
        fake.emit('network.responseCompleted', landed);
        await settle();
      };
      const waiting = net.waitForResponse((url) => url.endsWith('/next'), AbortSignal.timeout(5_000));
      await settle();
      await follow('read');
      await expect((await waiting).body().then(String)).resolves.toBe('landed');
      await follow('unread');
      expect(fake.commands('network.disownData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'unread' }]);
    });
  });

  it('adds no intercept for a tab that closed while its intercept was added, and leaves no failure behind', async () => {
    const fake = new FakeBidi();
    const { net, failures, close, contexts } = network(fake, { headers: true });
    fake.on('network.addIntercept', (params) => {
      if ((params['contexts'] as string[]).length === 0) return { error: 'invalid argument', message: 'contexts must not be empty' };
      void close('tab');
      return { error: 'no such frame', message: 'gone' };
    });
    await net.bind('user-1');
    contexts.created('tab', 'user-1', null);
    await expect(net.addContext('tab')).resolves.toBeUndefined();
    expect(fake.commands('network.addIntercept').map((command) => command.params['contexts'])).toEqual([['tab']]);
    expect(failures).toEqual([]);
  });

  it('removes a route in call order with an addition still queued behind a tab change', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { headers: true });
    const { held, release } = gate();
    let intercepts = 0;
    fake.on('network.addIntercept', async () => {
      intercepts += 1;
      if (intercepts === 1) await held;
      return { result: { intercept: `intercept-${intercepts}` } };
    });
    await net.bind('user-1');
    const opening = open('tab');
    let ran = false;
    const removed = route('**', async (_held, decisions) => {
      ran = true;
      await decisions.fulfill({ status: 200, headers: {} });
    });
    const added = net.addRoute(removed);
    const unrouted = net.removeRoutes((one) => one === removed);
    await settle();
    release();
    await Promise.all([opening, added, unrouted]);
    fake.emit('network.beforeRequestSent', request('r', `${SITE}/x`));
    await settle();
    await settle();
    expect(ran).toBe(false);
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['r']);
  });

  it('lets interception go once the last route or blank-served tab no longer needs it', async () => {
    const fake = new FakeBidi();
    const { net, open, contexts } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.addRoute(route('**', async (_held, decisions) => decisions.fallback()));
    expect(fake.commands('network.addIntercept')).toHaveLength(1);
    await net.removeRoutes(() => true);
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1']);
    contexts.created('scratch', 'user-1', null);
    const undo = await net.serveBlank('scratch');
    expect(fake.commands('network.addIntercept').at(-1)?.params).toEqual({ phases: ['beforeRequestSent'], contexts: ['tab', 'scratch'] });
    await undo();
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1', 'intercept-2']);
  });

  it('leaves cookie headers out of a response wait', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    const headers: Network.Header[] = [
      { name: 'Set-Cookie', value: { type: 'string', value: 'sid=secret; HttpOnly' } },
      { name: 'Content-Type', value: { type: 'string', value: 'text/plain' } },
    ];
    fake.emit('network.responseStarted', responded('r', `${SITE}/login`, 200, { headers }));
    expect((await waiting).headers).toEqual({ 'content-type': 'text/plain' });
  });

  it('fulfills with the body’s own length, without the encoding headers of the response it amends', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.addRoute(route('**', async (_held, decisions) => {
      await decisions.fulfill({ status: 200, headers: { 'Content-Encoding': 'gzip', 'Content-Length': '42', 'Content-Type': 'text/plain' }, body: 'decoded body' });
    }));
    fake.emit('network.beforeRequestSent', request('r', `${SITE}/gz`));
    await settle();
    await settle();
    const sent = fake.commands('network.provideResponse')[0]?.params['headers'] as { name: string; value: { value: string } }[];
    expect(Object.fromEntries(sent.map((header) => [header.name, header.value.value]))).toEqual({ 'content-type': 'text/plain', 'content-length': '12' });
  });

  it('derives a fulfilled type only when the response names none, and lets contentType replace either', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    const named = { 'Content-Type': 'text/plain' };
    const answers = [{ json: 1 }, { json: 1, headers: named }, { json: 1, headers: named, contentType: 'application/vnd.one+json' }];
    await net.addRoute(route('**', async (held, decisions) => {
      await decisions.fulfill({ status: 200, headers: {}, ...answers[Number(new URL(held.url).searchParams.get('answer'))] });
    }));
    for (const index of answers.keys()) fake.emit('network.beforeRequestSent', request(`r${index}`, `${SITE}/quote?answer=${index}`));
    await settle();
    await settle();
    const types = fake.commands('network.provideResponse').map((command) =>
      (command.params['headers'] as { name: string; value: { value: string } }[]).find((header) => header.name === 'content-type')?.value.value);
    expect(types).toEqual(['application/json', 'text/plain', 'application/vnd.one+json']);
  });

  describe('collected bodies', () => {
    it('lets the collector go of a response body no wait matched, and of a body a wait read', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'read' } } });
      const { net } = network(fake);
      await net.bind('user-1');
      const done = (id: string, status = 200) => responded(id, `${SITE}/${id}`, status, { headers: status === 302 ? LOCATION : [] });
      fake.emit('network.responseCompleted', done('asset'));
      fake.emit('network.responseCompleted', done('hop', 302));
      const waiting = net.waitForResponse((url) => url.endsWith('/waited'), AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.responseStarted', done('waited'));
      fake.emit('network.responseCompleted', done('waited'));
      const response = await waiting;
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'asset' }]);
      await expect(Promise.all([response.body(), response.body()]).then((bodies) => bodies.map(String))).resolves.toEqual(['read', 'read']);
      expect(fake.commands('network.getData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'waited', disown: true }]);
    });

    it('reads a body two waits matched once, for both', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'shared' } } });
      const { net } = network(fake);
      await net.bind('user-1');
      const first = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      const second = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      const event = responded('r', `${SITE}/r`, 200);
      fake.emit('network.responseStarted', event);
      fake.emit('network.responseCompleted', event);
      const bodies = await Promise.all([first, second].map(async (wait) => String(await (await wait).body())));
      expect(bodies).toEqual(['shared', 'shared']);
      expect(fake.commands('network.getData')).toHaveLength(1);
      expect(fake.commands('network.disownData')).toEqual([]);
    });

    it('lets the request collector go of a held request’s body once the request is over', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'a=1' } } });
      const { net, open } = network(fake, { browser: 'firefox' });
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**/api', async (_held, decisions) => decisions.continue({})));
      const posted = request('post', `${SITE}/form`);
      const post = { ...posted, request: { ...posted.request, method: 'POST', bodySize: 3 } };
      fake.emit('network.beforeRequestSent', post);
      await settle();
      fake.emit('network.responseCompleted', { ...post, response: responseData(`${SITE}/form`, 200) });
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toContainEqual({ dataType: 'request', collector: 'collector-1', request: 'post' });
    });

    it('lets go of a posted body the server answered with a redirect to a page fetched without one', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'a=1' } } });
      const { net, open } = network(fake, { browser: 'firefox' });
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**/api', async (_held, decisions) => decisions.continue({})));
      const posted = request('post', `${SITE}/form`);
      const post = { ...posted, request: { ...posted.request, method: 'POST', bodySize: 3 } };
      fake.emit('network.beforeRequestSent', post);
      await settle();
      fake.emit('network.responseCompleted', { ...post, response: responseData(`${SITE}/form`, 303, { headers: [{ name: 'Location', value: { type: 'string', value: '/done' } }] }) });
      const followed = { ...request('post', `${SITE}/done`), redirectCount: 1 };
      fake.emit('network.beforeRequestSent', followed);
      await settle();
      fake.emit('network.responseCompleted', { ...followed, response: responseData(`${SITE}/done`, 200) });
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toContainEqual({ dataType: 'request', collector: 'collector-1', request: 'post' });
    });
  });
});
