/**
 * Routes and the browser's HTTP cache: while the attempt has a route, every
 * request asks the network, so a route sees a resource the browser already
 * holds; without a route the cache answers, before the first route, after
 * the last one is removed, and in the next attempt.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../../src/fixture/types.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

describe('routes and the HTTP cache', () => {
  let session: WebSession;
  let browser: Browser;
  /** How many requests for `/app.js` and for `/stamp` reached the server. */
  const served = { script: 0, stamp: 0 };
  let page: string;

  beforeAll(async () => {
    session = await startWebSession({ timeoutMs: 10_000, startAttempt: false });
    page = session.serve('/cached-page', '<!doctype html><title>Cached</title><h1>Cached</h1><script src="/app.js"></script>');
    session.serve('/opener', '<!doctype html><title>Opener</title><a href="/cached-page" target="_blank" rel="opener">Open</a>');
    session.serve('/app.js', (_request, response) => {
      served.script += 1;
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600' });
      response.end(`window.app = ${String(served.script)};`);
    });
    session.serve('/stamp', (_request, response) => {
      served.stamp += 1;
      response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'public, max-age=3600' });
      response.end(String(served.stamp));
    });
  });

  beforeEach(async () => {
    served.script = 0;
    served.stamp = 0;
    await session.startAttempt();
    browser = session.browser;
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
  });

  /** Counts the requests for `/app.js` a route saw, and lets each go on. */
  const countScript = async (): Promise<{ hits: number }> => {
    const seen = { hits: 0 };
    await browser.route('**/app.js', async (route) => {
      seen.hits += 1;
      await route.continue();
    });
    return seen;
  };

  /** Fetches `/stamp` from the page: the count of the request that produced the body. */
  const stamp = (): Promise<string> => browser.evaluate(async () => (await fetch('/stamp')).text());

  it('answers from the cache while no route is set', async () => {
    await browser.goto(page);
    await browser.goto(page);
    expect(served.script).toBe(1);
    expect([await stamp(), await stamp()]).toEqual(['1', '1']);
  });

  it('hands a route a script the browser cached before the route was added', async () => {
    await browser.goto(page);
    const seen = await countScript();
    await browser.goto(await browser.url());
    await expect.poll(() => seen.hits).toBe(1);
    expect(served.script).toBe(2);
  });

  it('hands a route every fetch of a response the browser would keep', async () => {
    await browser.goto(page);
    expect(await stamp()).toBe('1');
    const bodies: string[] = [];
    await browser.route('**/stamp', async (route) => {
      const upstream = await route.fetch();
      bodies.push(await upstream.text());
      await route.fulfill({ body: `routed ${bodies.at(-1) ?? ''}` });
    });
    expect([await stamp(), await stamp()]).toEqual(['routed 2', 'routed 3']);
  });

  it('asks the network for everything while a route is set, matched or not', async () => {
    await browser.goto(page);
    await browser.route('**/never-asked', (route) => route.abort());
    await browser.goto(page);
    expect(served.script).toBe(2);
  });

  it('answers from the cache again once unroute removed the last route', async () => {
    const seen = await countScript();
    await browser.goto(page);
    await browser.goto(page);
    expect(seen.hits).toBe(2);
    await browser.unroute('**/app.js');
    // The loads under the route stored their responses, so the cache answers from the first load on.
    await browser.goto(page);
    await browser.goto(page);
    expect(seen.hits).toBe(2);
    expect(served.script).toBe(2);
  });

  it('answers from the cache again after unrouteAll', async () => {
    await countScript();
    await browser.route('**/stamp', (route) => route.continue());
    await browser.goto(page);
    expect([await stamp(), await stamp()]).toEqual(['1', '2']);
    await browser.unrouteAll();
    expect([await stamp(), await stamp()]).toEqual(['2', '2']);
  });

  it('keeps asking the network while one of two routes is left', async () => {
    const seen = await countScript();
    await browser.route('**/stamp', (route) => route.continue());
    await browser.goto(page);
    await browser.unroute('**/stamp');
    await browser.goto(page);
    expect(seen.hits).toBe(2);
    expect(served.script).toBe(2);
  });

  it('hands a route the cached script of a tab the app opens after the route was added', async () => {
    await browser.goto(page);
    const seen = await countScript();
    await browser.goto('/opener');
    const popup = await browser.waitForPopup(() => browser.locator('a').click());
    await expect.poll(() => browser.evaluate(() => (window as unknown as { app?: number }).app ?? 0)).toBe(2);
    expect(seen.hits).toBe(1);
    expect(await popup.url()).toBe(page);
  });

  it('hands a route the cached script of a tab the test opens after the route was added', async () => {
    await browser.goto(page);
    const seen = await countScript();
    const tab = await browser.newTab();
    await tab.activate();
    await browser.goto(page);
    expect(seen.hits).toBe(1);
    expect(served.script).toBe(2);
  });

  it('leaves the cache on for the attempt after one that ended with a route set', async () => {
    await countScript();
    await browser.goto(page);
    await session.startAttempt();
    browser = session.browser;
    served.script = 0;
    await browser.goto(page);
    await browser.goto(page);
    expect(served.script).toBe(1);
  });
});
