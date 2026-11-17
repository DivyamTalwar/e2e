/**
 * Which response ends a request for an attempt's network, against a
 * scripted peer: only a redirect status that names a `Location` leads to
 * another hop, so its record stays with what the next hop goes on with;
 * any other 3xx is the request's last hop, and its record goes.
 */

import { describe, expect, it } from 'vitest';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { ContextTree } from '../../src/driver/context-tree.ts';
import { AttemptNetwork } from '../../src/driver/network.ts';
import { ProtectedApp } from '../../src/protected-app.ts';
import type { Network } from 'webdriver-bidi-protocol';
import { FakeBidi, requestData, responseData, settle } from '../helpers/bidi-fake.ts';

const START = 'https://external.test/start';
const LOCATION: Network.Header[] = [{ name: 'Location', value: { type: 'string', value: '/next' } }];

/** A `beforeRequestSent` event of hop `redirectCount` of request `id` at `url`, held by the route's intercept. */
function hop(id: string, url: string, redirectCount = 0): Network.BeforeRequestSentParameters {
  return {
    context: 'tab',
    isBlocked: true,
    navigation: null,
    redirectCount,
    timestamp: 0,
    intercepts: ['intercept-1'],
    request: requestData(id, url, { headers: [{ name: 'Accept', value: { type: 'string', value: '*/*' } }] }),
  };
}

/**
 * Sends request `r` through a route that continues it with an `x-route`
 * header, answers it with `status` and `headers`, then announces another
 * hop under the same id. Returns whether the response collector was told to
 * let go of the response, and what the second hop was continued with.
 */
async function answered(status: number, headers: Network.Header[]): Promise<{ released: boolean; next: Record<string, unknown> | undefined }> {
  const fake = new FakeBidi();
  const contexts = new ContextTree();
  fake.on('network.addIntercept', { result: { intercept: 'intercept-1' } });
  fake.on('network.addDataCollector', { result: { collector: 'collector-1' } });
  fake.on('session.subscribe', { result: { subscription: 'subscription-1' } });
  const net = new AttemptNetwork(fake.connection, {
    protectedApp: new ProtectedApp(new Set(['http://app.test']), undefined, undefined),
    ours: () => true,
    onPage: () => true,
    contexts,
    exclusive: false,
    traits: BROWSER_TRAITS.chromium,
    onFailure: () => undefined,
    onNavigationAbort: () => undefined,
    lifetime: new AbortController().signal,
  });
  await net.bind('user-1');
  contexts.created('tab', 'user-1', null);
  await net.addContext('tab');
  await net.addRoute({
    pattern: { kind: 'string', value: '**', exact: true },
    handle: (held, decisions) => decisions.continue({ headers: { ...held.headers, 'x-route': 'routed' } }),
  });
  fake.emit('network.beforeRequestSent', hop('r', START));
  await settle();
  await settle();
  fake.emit('network.responseCompleted', { ...hop('r', START), isBlocked: false, response: responseData(START, status, { headers }) });
  await settle();
  fake.emit('network.beforeRequestSent', hop('r', 'https://external.test/next', 1));
  await settle();
  return {
    released: fake.commands('network.disownData').some((command) => command.params['dataType'] === 'response' && command.params['request'] === 'r'),
    next: fake.commands('network.continueRequest').at(-1)?.params,
  };
}

describe('the last hop of a request', () => {
  it.each([301, 302, 303, 307, 308])('keeps a %s that names a Location for the hop it leads to, which goes on with the route\'s headers', async (status) => {
    const { released, next } = await answered(status, LOCATION);
    expect(released).toBe(false);
    expect(next).toMatchObject({ request: 'r', headers: expect.arrayContaining([{ name: 'x-route', value: { type: 'string', value: 'routed' } }]) });
  });

  it.each([300, 304, 305, 306, 399])('takes a %s that names a Location as the last hop, which no browser follows', async (status) => {
    const { released, next } = await answered(status, LOCATION);
    expect(released).toBe(true);
    expect(next).toEqual({ request: 'r' });
  });

  it.each([301, 302, 303, 307, 308])('takes a %s that names no Location as the last hop', async (status) => {
    const { released, next } = await answered(status, []);
    expect(released).toBe(true);
    expect(next).toEqual({ request: 'r' });
  });
});
