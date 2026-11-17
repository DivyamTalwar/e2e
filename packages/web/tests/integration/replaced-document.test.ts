/**
 * What is running when a navigation replaces its document runs once, on
 * both BiDi browsers: a `browser.evaluate` fails as an engine fault and its
 * code never runs in the document that came after, a fill or a select whose
 * handler navigated away and then blocked is applied once, and a key whose
 * handler did is pressed once. Firefox sends such a command again to the
 * new document unless it is launched without `remote.retry-on-abort`, so
 * the wait for a frame before a mouse action is taken up by the driver in
 * the page that came after. A read still running, such as a tap's wait for
 * its element to hold still, fails stale: Firefox keeps no page in its
 * back-forward cache, where a call still running is never answered. Firefox
 * still sends a command again that it sent to a tab that never navigated:
 * there a `browser.evaluate` runs again, and the refusal of a node may
 * follow a focus that ran.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bySelector, onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';
import { BidiConnection } from '../../src/driver/connection.ts';
import { actionPoint } from '../../src/in-page/actionability.ts';
import { nextFrame } from '../../src/in-page/document.ts';

const send = BidiConnection.prototype.send;

/** Resolves once the driver sent its next call of the page function `fn`, which it sends behind a check of the nodes it passes. */
function called(fn: { toString(): string }): Promise<void> {
  return new Promise((resolve) => {
    vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(function (this: BidiConnection, method, params) {
      const { functionDeclaration } = params as { functionDeclaration?: unknown };
      if (typeof functionDeclaration === 'string' && functionDeclaration.includes(fn.toString())) resolve();
      return send.call(this, method, params);
    });
  });
}

/** Where a page navigates to: a page of its own origin, and the same server as another site. */
const DESTINATIONS = [['its own origin', '127.0.0.1'], ['another site', 'localhost']] as const;

/** Page source of `request(url)`: one synchronous GET, which the page's code goes on after. */
const REQUEST = 'const request = (url) => { const call = new XMLHttpRequest(); call.open("GET", url, false); call.send(); };';

/** A page function that asks for `ran`, navigates to `next`, and never settles. */
async function navigateAndWait({ ran, next }: { ran: string; next: string }): Promise<null> {
  const call = new XMLHttpRequest();
  call.open('GET', ran, false);
  call.send();
  location.href = next;
  await new Promise(() => undefined);
  return null;
}

/** A page function that asks for `ran` and never settles. */
async function waitForever(ran: string): Promise<null> {
  const call = new XMLHttpRequest();
  call.open('GET', ran, false);
  call.send();
  await new Promise(() => undefined);
  return null;
}

describe('a document replaced under a call or input', () => {
  let page: WebSession;
  let served = 0;

  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 10_000, startAttempt: false });
  });
  beforeEach(async () => {
    await page.startAttempt();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await page.endAttempt();
  });
  afterAll(async () => {
    await page.close();
  });

  /** Serves a fresh path that counts the requests it got, each answered at once, readable from any origin. */
  function counted(): { readonly url: string; readonly hits: () => number } {
    let hits = 0;
    served += 1;
    const url = page.serve(`/counted-${String(served)}`, (_request, response) => {
      hits += 1;
      response.writeHead(204, { 'access-control-allow-origin': '*' }).end();
    });
    return { url, hits: () => hits };
  }

  /** Serves a fresh path that holds every request until `release`, readable from any origin; `reached` resolves with the first. */
  function held(): { readonly url: string; readonly reached: Promise<void>; readonly release: () => void } {
    const holding = new Set<() => void>();
    let reach = (): void => undefined;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    served += 1;
    const url = page.serve(`/held-${String(served)}`, (_request, response) => {
      holding.add(() => response.writeHead(204, { 'access-control-allow-origin': '*' }).end());
      reach();
    });
    return {
      url,
      reached,
      release: () => {
        for (const end of holding) end();
        holding.clear();
      },
    };
  }

  /** Resolves once the tab shows the page at `pathname`. */
  const arrived = (pathname: string): Promise<void> => expect.poll(() => page.browser.evaluate('location.pathname'), { timeout: 10_000 }).toBe(pathname);

  it.each(DESTINATIONS)('runs a browser.evaluate once that navigates to %s and outlives its document, and fails it as an engine fault', async (_where, host) => {
    const ran = counted();
    const next = page.serve('/next', '<title>Next</title>').replace('127.0.0.1', host);
    await page.setContent('<title>Start</title>');
    await expect(page.browser.evaluate(navigateAndWait, { ran: ran.url, next })).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    await arrived('/next');
    expect(ran.hits()).toBe(1);
  });

  it.each(DESTINATIONS)('runs a browser.evaluate once whose page a goto to %s replaces under it, and fails it as an engine fault', async (_where, host) => {
    const ran = counted();
    const next = page.serve('/next', '<title>Next</title>').replace('127.0.0.1', host);
    await page.setContent('<title>Start</title>');
    const failure = page.browser.evaluate(waitForever, ran.url).then(() => undefined, (cause: unknown) => cause);
    await expect.poll(ran.hits).toBe(1);
    await page.browser.goto(next);
    expect(await failure).toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    expect(await page.browser.evaluate('location.pathname')).toBe('/next');
    expect(ran.hits()).toBe(1);
  });

  it.each([
    ['fill', '<input id=c>', 'input', { kind: 'fill', value: 'x', sensitive: false }],
    ['select', '<select id=c><option>a</option><option>b</option></select>', 'change', { kind: 'selectOption', value: 'b' }],
  ] as const)('applies a %s once whose handler navigated away and then blocked', async (_edit, control, event, action) => {
    const handled = counted();
    const hold = held();
    const next = page.serve('/after-edit', '<title>After</title>');
    await page.setContent(`${control}<script>
      ${REQUEST}
      c.addEventListener('${event}', () => {
        request(${JSON.stringify(handled.url)});
        location.href = ${JSON.stringify(next)};
        request(${JSON.stringify(hold.url)});
      });
    </script>`);
    const [target] = await page.locate(bySelector('#c'));
    const edit = page.engine.perform!(target!.ref, action, page.op());
    await hold.reached;
    try {
      // Firefox replaces the document under the blocked handler and fails the edit; Chromium keeps it until the handler returns.
      if (onFirefox) await expect(edit).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false, message: expect.stringContaining('no such frame') });
    } finally {
      hold.release();
    }
    if (!onFirefox) await edit;
    await arrived('/after-edit');
    expect(handled.hits()).toBe(1);
  });

  it('presses a key once whose handler navigated away and then blocked, in a page whose successor takes the same key', async () => {
    const pressed = counted();
    const hold = held();
    const field = (then: string): string => `<input id=i><script>
      ${REQUEST}
      i.addEventListener('keydown', () => { request(${JSON.stringify(pressed.url)}); ${then} });
      i.focus();
    </script>`;
    const next = page.serve('/after-key', field(''));
    await page.setContent(field(`location.href = ${JSON.stringify(next)}; request(${JSON.stringify(hold.url)});`));
    const press = page.engine.keyboard!.press('a', page.op());
    await hold.reached;
    try {
      if (onFirefox) await expect(press).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false, message: expect.stringContaining('no such frame') });
    } finally {
      hold.release();
    }
    if (!onFirefox) await press;
    await arrived('/after-key');
    expect(pressed.hits()).toBe(1);
  });

  it('moves the mouse in the page that replaced one a navigation took away while the move waited for its frame', async () => {
    const moves = '<script>addEventListener("mousemove", (event) => { window.moved = [event.clientX, event.clientY]; });</script>';
    const next = page.serve('/after-move', `<title>After</title>${moves}`);
    // No frame callback runs in the first page, as in one that navigates away before its next frame.
    await page.setContent(`<title>Start</title>${moves}<script>requestAnimationFrame = () => 0;</script>`);
    const waiting = called(nextFrame);
    const move = page.browser.mouse.move(40, 40);
    // Firefox takes a mouse action once its page rendered a frame; Chromium takes it at once.
    if (onFirefox) {
      await waiting;
      await page.browser.goto(next);
    }
    await move;
    await expect.poll(() => page.browser.evaluate('[location.pathname === "/after-move", window.moved]')).toEqual([onFirefox, [40, 40]]);
  });

  it('fails a tap as stale whose page a navigation replaced while it waited for the element to hold still', async () => {
    const next = page.serve('/after-tap', '<title>After</title>');
    // No frame callback runs, so the wait for the button to hold still is running when the page goes.
    await page.setContent('<button id=b>b</button><script>requestAnimationFrame = () => 0;</script>');
    const [button] = await page.locate(bySelector('#b'));
    const waiting = called(actionPoint);
    const tap = page.engine.perform!(button!.ref, { kind: 'tap' }, page.op()).then(() => undefined, (cause: unknown) => cause);
    await waiting;
    await page.browser.goto(next);
    expect(await tap).toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('runs a browser.evaluate in a tab that never navigated once, except on Firefox, which sends it again to the page the tab loads', async () => {
    const ran = counted();
    const next = page.serve('/next', '<title>Next</title>');
    await page.browser.newTab();
    await expect(page.browser.evaluate(navigateAndWait, { ran: ran.url, next })).rejects.toMatchObject({ code: 'ENGINE_FAILURE', retryable: false });
    await arrived('/next');
    if (onFirefox) expect(ran.hits()).toBeGreaterThan(1);
    else expect(ran.hits()).toBe(1);
  });

  it('reports a press in a tab that never navigated, whose focus handler navigated away and then blocked, as possibly committed on Firefox, which refuses the node for the page that came after', async () => {
    const handled = counted();
    const hold = held();
    const next = page.serve('/after-focus', '<title>After</title>');
    await page.browser.newTab();
    await page.browser.evaluate((urls: { handled: string; hold: string; next: string }) => {
      const request = (url: string): void => {
        const call = new XMLHttpRequest();
        call.open('GET', url, false);
        call.send();
      };
      const input = document.body.appendChild(document.createElement('input'));
      input.id = 'i';
      input.addEventListener('focus', () => {
        request(urls.handled);
        location.href = urls.next;
        request(urls.hold);
      });
      return null;
    }, { handled: handled.url, hold: hold.url, next });
    const [field] = await page.locate(bySelector('#i'));
    const press = page.engine.perform!(field!.ref, { kind: 'press', key: 'x' }, page.op());
    await hold.reached;
    try {
      // The handler ran once, and Firefox then asks the page that came after for the focus, which refuses the node: no proof that nothing ran.
      if (onFirefox) await expect(press).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false, message: expect.stringContaining('no such node') });
    } finally {
      hold.release();
    }
    if (!onFirefox) await press;
    await arrived('/after-focus');
    expect(handled.hits()).toBe(1);
  });
});
