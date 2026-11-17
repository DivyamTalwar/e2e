/**
 * Which ancestors clip a node. The viewport takes the root's `overflow` and,
 * by CSS Overflow 3's viewport propagation, the `<body>`'s, so neither clips
 * to its own box; a `display: contents` element has no box to clip to, and
 * none a positioned node could be laid out against. A top-layer element (a
 * modal dialog, an open popover, a fullscreen element) is laid out against
 * the viewport, so nothing around it clips what it holds. Everything else
 * with an `overflow` other than `visible` clips what is laid out in it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bySelector, startWebSession, type WebSession } from '../helpers/web-session.ts';

let page: WebSession;

beforeAll(async () => {
  page = await startWebSession({ timeoutMs: 10_000 });
});

afterAll(async () => {
  await page.close();
});

const BUTTON = '<button onclick="document.title = \'clicked\'" style="width:80px;height:24px">Target</button>';

/** A button past the end of the first screen, with room after it to centre it. */
const BELOW = `<div style="height:2000px"></div>${BUTTON}<div style="height:600px"></div>`;

/** A button drawn above its parent's box, where no scroll of the parent brings it. */
const ABOVE = BUTTON.replace('style="', 'style="position:relative;top:-80px;');

/** The button with `css` before its size. */
const styled = (css: string): string => BUTTON.replace('style="', `style="${css};`);

/** How far the button's top is from where a centred button's would be. */
const offCentre = (): Promise<number> => page.browser.evaluate(() => document.querySelector('button')!.getBoundingClientRect().top - (innerHeight - 24) / 2);

const title = (): Promise<string> => page.browser.evaluate(() => document.title);

/**
 * Whether the browser's own hit test reaches the button where it draws: at
 * the centre of its box, or of its contents' box for a `display: contents`
 * button, which has none of its own. False for one its ancestors clip away.
 */
const painted = (): Promise<boolean> => page.browser.evaluate(() => {
  const button = document.querySelector('button')!;
  const contents = document.createRange();
  contents.selectNodeContents(button);
  const { left, top, width, height } = (button.getClientRects().length > 0 ? button : contents).getBoundingClientRect();
  return document.elementFromPoint(left + width / 2, top + height / 2) === button;
});

/** Taps the button, expecting the tap to find it clipped away until its budget ends. */
async function expectClipped(): Promise<void> {
  const [button] = await page.locate(bySelector('button'));
  await expect(page.engine.perform!(button!.ref, { kind: 'tap' }, page.op(2_000))).rejects.toMatchObject({
    code: 'NOT_ACTIONABLE',
    message: expect.stringContaining('element is outside of the viewport'),
  });
  expect(await title()).toBe('');
}

describe('clip containers', () => {
  it.each([
    ['overflow-x: hidden on a full-height body', 'html, body { height: 100%; margin: 0 } body { overflow-x: hidden }'],
    ['overflow: hidden on the root alone', 'html { overflow: hidden }'],
    ['a body that scrolls for a root with overflow: hidden', 'html { overflow: hidden } html, body { height: 100%; margin: 0 } body { overflow: auto }'],
  ])('scrolls to a target below the fold and taps it: %s', async (_name, css) => {
    await page.setContent(`<!doctype html><style>${css}</style>${BELOW}`);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each([
    ['overflow-x: hidden', 'overflow-x: hidden'],
    ['overflow: hidden', 'overflow: hidden'],
    ['overflow: clip', 'overflow: clip'],
  ])('taps a target outside the box of a body whose overflow the viewport takes: %s', async (_name, body) => {
    await page.setContent(`<!doctype html><style>body { margin: 100px 0 0; ${body} }</style>${ABOVE}`);
    expect(await painted()).toBe(true);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each([
    ['the root has overflow: hidden too', 'overflow: hidden', 'overflow: hidden'],
    ['the root has overflow-x: hidden, so is not visible on both axes', 'overflow-x: hidden', 'overflow: hidden'],
    ['the root has overflow: clip', 'overflow: clip', 'overflow: hidden'],
    ['the root has containment', 'contain: layout', 'overflow: hidden'],
    ['the root is a size container', 'container-type: inline-size', 'overflow: hidden'],
    ['the body has containment', '', 'overflow: hidden; contain: style'],
    ['the body has content-visibility: auto', '', 'overflow: hidden; content-visibility: auto'],
    ['the body is a size container', '', 'overflow: hidden; container-type: inline-size'],
  ])('refuses a tap on a target clipped by a body that keeps its own overflow: %s', async (_name, root, body) => {
    await page.setContent(`<!doctype html><style>html { ${root} } body { margin: 100px 0 0; ${body} }</style>${ABOVE}`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('refuses a tap on a target clipped by a second body, which keeps its own overflow though the first is display: none', async () => {
    await page.setContent(`<!doctype html><style>body { margin: 100px 0 0 }</style><script>
      const first = document.documentElement.appendChild(document.createElement('body'));
      first.style.display = 'none';
      const second = document.documentElement.appendChild(document.createElement('body'));
      second.style.overflow = 'hidden';
      second.innerHTML = ${JSON.stringify(ABOVE)};
    </script>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('refuses a tap on a target an ordinary overflow: hidden box clips away', async () => {
    await page.setContent(`<div style="margin-top:100px;overflow:hidden">${ABOVE}</div>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('taps a target under a display: contents element with overflow: hidden, which lays out no box to clip to', async () => {
    await page.setContent(`<div style="display:contents;overflow:hidden">${BUTTON}</div>`);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each([
    ['a modal dialog under a transformed ancestor', `<div style="transform:translateX(0);overflow:hidden;height:40px"><dialog>${BUTTON}</dialog></div>`, 'document.querySelector("dialog").showModal()'],
    ['an open popover under a positioned ancestor', `<div style="position:relative;overflow:hidden;height:40px"><div popover style="position:absolute;inset:auto;top:80px">${BUTTON}</div></div>`, 'document.querySelector("[popover]").showPopover()'],
    [
      'an open popover inside a modal dialog that clips its own content',
      `<dialog style="overflow:hidden;height:40px"><div popover style="position:absolute;inset:auto;top:10px;left:10px">${BUTTON}</div></dialog>`,
      'document.querySelector("dialog").showModal(); document.querySelector("[popover]").showPopover()',
    ],
  ])('taps a target in a top-layer element past an overflow: hidden ancestor, which does not clip it: %s', async (_name, html, open) => {
    await page.setContent(`<!doctype html>${html}<script>${open}</script>`);
    expect(await painted()).toBe(true);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each([
    ['a modal dialog', `<dialog style="overflow:hidden">${ABOVE}</dialog>`, 'document.querySelector("dialog").showModal()'],
    ['an open popover', `<div popover style="overflow:hidden">${ABOVE}</div>`, 'document.querySelector("[popover]").showPopover()'],
  ])('refuses a tap on a target a top-layer element clips by its own overflow: %s', async (_name, html, open) => {
    await page.setContent(`<!doctype html>${html}<script>${open}</script>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it.each([
    ['position: relative, under an absolute target', 'position:relative', 'position:absolute;top:100px'],
    ['a transform, under a fixed target', 'transform:translateX(0)', 'position:fixed;top:100px'],
  ])('taps a target past an overflow: hidden box that a display: contents ancestor does not lay it out against: %s', async (_name, contents, target) => {
    await page.setContent(`<!doctype html><div style="overflow:hidden;height:20px"><div style="display:contents;${contents}">${styled(target)}</div></div>`);
    expect(await painted()).toBe(true);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
  });

  it.each([
    'translate:0px',
    'rotate:0deg',
    'scale:1',
    'contain:strict',
    'contain:content',
    'will-change:transform',
    'backdrop-filter:blur(1px)',
  ])('refuses a tap on a fixed target clipped by an overflow: hidden ancestor that %s makes its containing block', async (css) => {
    await page.setContent(`<!doctype html><div style="margin-top:100px;overflow:hidden;width:200px;height:20px;${css}">${styled('position:fixed;top:-80px')}</div>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('refuses a tap on a target clipped by the positioned box around a display: contents element', async () => {
    await page.setContent(`<!doctype html><div style="margin-top:100px;position:relative;overflow:hidden;height:20px"><div style="display:contents">${styled('position:absolute;top:-80px')}</div></div>`);
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('refuses a tap on a display: contents target with a position of its own, clipped by the box its text is laid out in', async () => {
    /** The page with the style `box` on the outer box, which the button's text is laid out in and reaches past. */
    const laidOutIn = (box: string): string => `<!doctype html><div style="margin-top:100px;${box};height:20px"><div style="margin-top:-80px;height:24px">${styled('display:contents;position:absolute')}</div></div>`;
    await page.setContent(laidOutIn('overflow:visible'));
    expect(await painted()).toBe(true);
    await page.setContent(laidOutIn('overflow:hidden'));
    expect(await painted()).toBe(false);
    await expectClipped();
  });

  it('centres a node it scrolls into view, with and without an overflow on the body that the viewport takes', async () => {
    const tops: number[] = [];
    for (const css of ['', 'html, body { height: 100%; margin: 0 } body { overflow-x: hidden }']) {
      await page.setContent(`<!doctype html><style>body { margin: 0 } ${css}</style>${BELOW}`);
      await page.act(bySelector('button'), { kind: 'scrollIntoView' });
      tops.push(await offCentre());
    }
    expect(tops).toEqual([0, 0]);
  });

  it.each([
    ['in an open popover', `<div popover style="position:absolute;inset:auto;top:2000px;margin:0;padding:0;border:0">${BUTTON}</div>`, 'document.querySelector("[popover]").showPopover()'],
    ['absolute, under a display: contents element with position: relative', `<div style="display:contents;position:relative">${styled('position:absolute;top:2000px')}</div>`, ''],
    ['absolute, with no positioned ancestor', styled('position:absolute;top:2000px'), ''],
  ])('centres a node it scrolls into view past an overflow: hidden ancestor that does not clip it: %s', async (_name, html, open) => {
    await page.setContent(`<!doctype html><style>body { margin: 0 }</style><div style="overflow:hidden;height:40px">${html}</div><div style="height:4000px"></div><script>${open}</script>`);
    await page.act(bySelector('button'), { kind: 'scrollIntoView' });
    expect(await offCentre()).toBe(0);
  });

  it('scrolls a node to the nearest edge of the positioned overflow: hidden box that clips it', async () => {
    await page.setContent(`<!doctype html><style>body { margin: 0 }</style><div style="position:relative;overflow:hidden;height:100px">${styled('position:absolute;top:300px')}</div>`);
    await page.act(bySelector('button'), { kind: 'scrollIntoView' });
    expect(await page.browser.evaluate(() => document.querySelector('button')!.getBoundingClientRect().bottom)).toBe(100);
  });

  it('taps a target in a fullscreen element past an overflow: hidden ancestor, which does not clip it', async () => {
    await page.setContent(`<!doctype html><div style="transform:translateX(0);overflow:hidden;height:40px">
      <span id="enter" onclick="document.getElementById('stage').requestFullscreen()">Enter</span>
      <div id="stage" style="background:white">${styled('position:relative;top:200px')}</div>
    </div>
    <script>window.entered = new Promise((resolve) => document.addEventListener('fullscreenchange', resolve, { once: true }));</script>`);
    await page.act(bySelector('#enter'), { kind: 'tap' });
    await page.browser.evaluate('window.entered.then(() => null)');
    expect(await page.browser.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('stage');
    expect(await painted()).toBe(true);
    await page.act(bySelector('button'), { kind: 'tap' });
    expect(await title()).toBe('clicked');
    await page.browser.evaluate(() => document.exitFullscreen().then(() => null));
  });
});
