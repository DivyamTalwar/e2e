/**
 * A `frameLocator` chain resolves each frame inside the one before it: the
 * inner selector is looked up in the outer frame's document, never in the
 * page, as a browser's own frame chain does. A
 * located node's box is in the top-level viewport, as the contract asks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression } from '@e2e-dev/core/engine';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

/** Escapes HTML for a double-quoted attribute value, so a document can carry a nested `srcdoc`. */
function attribute(html: string): string {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Wraps `source` in `frame` scopes, outermost first, as a `browser.frameLocator` chain does. */
function withinFrames(selectors: readonly string[], source: LocatorExpression): LocatorExpression {
  return selectors.reduceRight<LocatorExpression>(
    (inner, selector) => ({ kind: 'frame', selector, source: inner }),
    source,
  );
}

const TWIN_FRAME = '<iframe class="twin" title="twin" srcdoc="<p>twin</p>"></iframe>';
const DEEP_DOCUMENT = '<button>Deep button</button>';
const INNER_DOCUMENT =
  '<button onclick="this.textContent = \'Inner clicked\'">Inner button</button>' +
  `<iframe id="deep" title="deep" srcdoc="${attribute(DEEP_DOCUMENT)}"></iframe>`;
const OUTER_DOCUMENT =
  `<h2>Outer</h2><iframe id="inner" title="inner" style="border:7px solid;padding:5px" srcdoc="${attribute(INNER_DOCUMENT)}"></iframe>` +
  TWIN_FRAME +
  TWIN_FRAME;
const HOST_DOCUMENT =
  '<h1>Host</h1><iframe id="aside" title="aside" srcdoc="<p>aside</p>"></iframe>' +
  TWIN_FRAME +
  `<iframe id="outer" title="outer" srcdoc="${attribute(OUTER_DOCUMENT)}"></iframe>`;

/** A role query for the one button named `name`. */
function buttonNamed(name: string): LocatorExpression {
  return {
    kind: 'query',
    query: {
      kind: 'role',
      value: { kind: 'string', value: 'button', exact: true },
      name: { kind: 'string', value: name, exact: true },
    },
  };
}

const INNER_BUTTON = buttonNamed('Inner button');
const DEEP_BUTTON = buttonNamed('Deep button');

describe('nested frame locators', () => {
  let page: WebSession;
  const locate = (expression: LocatorExpression) => page.locate(expression);
  /** Reads `read` of the inner frame's document, through both frames. */
  const innerDocument = <T,>(read: string) => page.browser.evaluate(
    `() => { const doc = document.querySelector('#outer').contentDocument.querySelector('#inner').contentDocument; return (${read})(doc); }`,
  ) as Promise<T>;

  beforeAll(async () => {
    page = await startWebSession();
    await page.setContent(HOST_DOCUMENT);
    await page.browser.evaluate(async () => {
      const deep = () => document.querySelector<HTMLIFrameElement>('#outer')?.contentDocument
        ?.querySelector<HTMLIFrameElement>('#inner')?.contentDocument
        ?.querySelector<HTMLIFrameElement>('#deep')?.contentDocument?.querySelector('button');
      while (deep() == null) await new Promise((resolve) => setTimeout(resolve, 20));
      return null;
    });
  });

  afterAll(async () => {
    await page.close();
  });

  it('resolves a two-level chain and taps inside the innermost frame', async () => {
    const matches = await locate(withinFrames(['#outer', '#inner'], INNER_BUTTON));
    expect(matches.map((node) => node.name)).toEqual(['Inner button']);
    await page.engine.perform!(matches[0]!.ref, { kind: 'tap' }, page.op());
    expect(await innerDocument<string>("(doc) => doc.querySelector('button').innerText")).toBe('Inner clicked');
  });

  it('reports a located node\'s box in the top-level viewport, past each frame\'s border and padding', async () => {
    // The inner document's one button, whatever an earlier test renamed it to.
    const button: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true } } };
    const [node] = await locate(withinFrames(['#outer', '#inner'], button));
    // The same element's box, measured through both frames' borders and padding.
    const expected = (await page.browser.evaluate(() => {
      let x = 0;
      let y = 0;
      let doc = document;
      for (const selector of ['#outer', '#inner']) {
        const frame = doc.querySelector<HTMLIFrameElement>(selector)!;
        const style = getComputedStyle(frame);
        const box = frame.getBoundingClientRect();
        x += box.x + frame.clientLeft + Number.parseFloat(style.paddingLeft);
        y += box.y + frame.clientTop + Number.parseFloat(style.paddingTop);
        doc = frame.contentDocument!;
      }
      const box = doc.querySelector('button')!.getBoundingClientRect();
      return { x: x + box.x, y: y + box.y, width: box.width, height: box.height };
    }))!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(node!.rect![key]).toBeCloseTo(expected[key], 3);
  });

  it('resolves a three-level chain, counting the last frame inside the second', async () => {
    const matches = await locate(withinFrames(['#outer', '#inner', '#deep'], DEEP_BUTTON));
    expect(matches.map((node) => node.name)).toEqual(['Deep button']);
    await expect(locate(withinFrames(['#outer', '#deep'], DEEP_BUTTON))).rejects.toMatchObject({
      code: 'FRAME_NOT_FOUND',
      message: 'no frame matches #deep',
    });
  });

  it('names the inner selector when the outer frame holds no such frame, even though the page does', async () => {
    await expect(locate(withinFrames(['#outer', '#aside'], INNER_BUTTON))).rejects.toMatchObject({
      code: 'FRAME_NOT_FOUND',
      message: 'no frame matches #aside',
      retryable: true,
    });
  });

  it('reports two matching frames inside the outer document as ambiguous, though the page holds one', async () => {
    expect(await page.browser.evaluate(() => document.querySelectorAll('.twin').length)).toBe(1);
    await expect(locate(withinFrames(['#outer', '.twin'], INNER_BUTTON))).rejects.toMatchObject({
      code: 'FRAME_AMBIGUOUS',
      message: '2 frames match .twin',
      retryable: false,
    });
  });
});

describe('a cross-site frame', () => {
  let page: WebSession;

  beforeAll(async () => {
    page = await startWebSession();
  });

  afterAll(async () => {
    await page.close();
  });

  it('takes a tap, which the browser routes into the frame\'s own process', async () => {
    const inner = page.serve('/cross-site-button', '<button onclick="this.textContent = \'Clicked\'">Press</button>').replace('127.0.0.1', 'localhost');
    await page.setContent(`<iframe id="site" src="${inner}"></iframe>`);
    await page.waitForFrames();
    await page.act(withinFrames(['#site'], buttonNamed('Press')), { kind: 'tap' });
    expect(await page.locate(withinFrames(['#site'], buttonNamed('Clicked')))).toHaveLength(1);
  });
});

describe('a frame located through before its document loaded', () => {
  let page: WebSession;

  beforeAll(async () => {
    page = await startWebSession();
  });

  afterAll(async () => {
    await page.close();
  });

  /** Appends an iframe `#late` whose document the server holds back; resolves with what lets it load. */
  async function appendLateFrame(pathname: string): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const late = page.serve(pathname, (_request, response) => {
      void held.then(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<button onclick="this.textContent = \'Clicked\'">Press</button>');
      });
    });
    await page.setContent('<p>host</p>');
    await page.browser.evaluate((src: string) => {
      const frame = document.createElement('iframe');
      frame.id = 'late';
      frame.src = src;
      document.body.append(frame);
      return null;
    }, late);
    return release;
  }

  /** Taps the frame's button once it loaded, and reads that the page took the tap. */
  async function tapInFrame(): Promise<void> {
    await expect.poll(async () => (await page.locate(withinFrames(['#late'], buttonNamed('Press')))).length).toBe(1);
    await page.act(withinFrames(['#late'], buttonNamed('Press')), { kind: 'tap' });
    expect(await page.locate(withinFrames(['#late'], buttonNamed('Clicked')))).toHaveLength(1);
  }

  it('still takes a tap the engine sees land', async () => {
    const release = await appendLateFrame('/late-frame');
    // The frame shows its first, empty document. Whatever this locate answers, it leaves that document's own world alone.
    await page.engine.locate!(withinFrames(['#late'], buttonNamed('Press')), page.op(500)).catch(() => undefined);
    release();
    await tapInFrame();
  });

  it('sees a tap land in a frame whose window the page reached into before its document loaded', async () => {
    const release = await appendLateFrame('/late-frame-reached');
    // The browser keeps a window a script touched for the document that loads next, without the listeners it had.
    await page.browser.evaluate(() => {
      Reflect.set(document.querySelector('iframe')!.contentWindow!, 'early', true);
      return null;
    });
    release();
    await tapInFrame();
  });

  it('sees a tap land in a frame observed before its document loaded', async () => {
    const release = await appendLateFrame('/late-frame-observed');
    await page.observe();
    release();
    await tapInFrame();
  });

  it('sees a tap land in a frame the page wrote with document.open(), which drops the window\'s listeners', async () => {
    await page.setContent('<iframe id="late"></iframe>');
    await page.browser.evaluate(() => {
      const written = document.querySelector('iframe')!.contentDocument!;
      written.open();
      written.write('<button onclick="this.textContent = \'Clicked\'">Press</button>');
      written.close();
      return null;
    });
    await tapInFrame();
  });
});

describe('a position inside a framed node', () => {
  let page: WebSession;

  beforeAll(async () => {
    page = await startWebSession();
  });

  afterAll(async () => {
    await page.close();
  });

  it('clicks at the offset from a bordered node\'s origin, past the frame\'s own offset', async () => {
    const landed = "addEventListener('click', (event) => { top.document.title = (event.target.id || 'page') + ' ' + event.clientX + ',' + event.clientY; })";
    const inner = `<style>body { margin: 0 } #target { margin: 20px 0 0 30px; width: 100px; height: 60px; border: 10px solid }</style><div id="target"></div><script>${landed}</script>`;
    await page.setContent(`<style>body { margin: 0 }</style><iframe id="pad" style="position: absolute; left: 200px; top: 150px; width: 300px; height: 200px; border: 0" srcdoc="${attribute(inner)}"></iframe><script>${landed}</script>`);
    await page.waitForFrames();
    await page.browser.frameLocator('#pad').locator('#target').click({ position: { x: 5, y: 7 } });
    // The padding box starts at (40, 30) of the frame's document, past the 10px border.
    await expect.poll(() => page.browser.evaluate(() => document.title)).toBe('target 45,37');
  });

  it('observes and locates a node in a scaled frame at the box the page shows it in', async () => {
    const inner = '<style>body { margin: 0 } #target { margin: 20px 0 0 30px; width: 100px; height: 60px; border: 10px solid }</style><div id="target" data-testid="target"></div>';
    await page.setContent(`<style>body { margin: 0 }</style><iframe id="pad" style="position: absolute; left: 200px; top: 150px; width: 300px; height: 200px; border: 0; transform-origin: 0 0; transform: scale(0.5)" srcdoc="${attribute(inner)}"></iframe>`);
    await page.waitForFrames();
    const shown = { rect: { x: 215, y: 160, width: 60, height: 40 }, origin: { x: 220, y: 165 } };
    const [located] = await page.locate(withinFrames(['#pad'], { kind: 'selector', selector: '#target' }));
    expect({ rect: located!.rect, origin: located!.origin }).toEqual(shown);
    const observed = (await page.nodes()).find((node) => node.testId === 'target')!;
    expect({ rect: observed.rect, origin: observed.origin }).toEqual(shown);
  });
});
