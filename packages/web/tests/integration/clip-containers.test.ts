/**
 * Which ancestors clip a node. The viewport takes the root's `overflow` and,
 * by CSS Overflow 3's viewport propagation, the `<body>`'s, so neither clips
 * to its own box; a `display: contents` element has no box to clip to.
 * Everything else with an `overflow` other than `visible` clips.
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

const title = (): Promise<string> => page.browser.evaluate(() => document.title);

/** Whether the browser's own hit test reaches the button at its centre: false for one its ancestors clip away. */
const painted = (): Promise<boolean> => page.browser.evaluate(() => {
  const button = document.querySelector('button')!;
  const { left, top, width, height } = button.getBoundingClientRect();
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

  it('centres a node it scrolls into view, with and without an overflow on the body that the viewport takes', async () => {
    const tops: number[] = [];
    for (const css of ['', 'html, body { height: 100%; margin: 0 } body { overflow-x: hidden }']) {
      await page.setContent(`<!doctype html><style>body { margin: 0 } ${css}</style>${BELOW}`);
      await page.act(bySelector('button'), { kind: 'scrollIntoView' });
      tops.push(await page.browser.evaluate(() => document.querySelector('button')!.getBoundingClientRect().top - (innerHeight - 24) / 2));
    }
    expect(tops).toEqual([0, 0]);
  });
});
