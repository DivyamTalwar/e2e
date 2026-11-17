/**
 * CSS and XPath selectors on the BiDi driver match what Playwright 1.64.1
 * matches: each `>>` part is evaluated inside every element the part before
 * it matched, with CSS combinators stopping at that element and a leading
 * `/` in XPath read from it, CSS pierces open shadow roots, and a deep
 * descendant selector costs time linear in the DOM. The expected counts
 * were recorded from `page.locator(selector).count()` on Playwright 1.64.1.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LocatorExpression } from '@e2e-dev/core/engine';
import { BidiConnection } from '../../src/driver/connection.ts';
import { readerCall } from '../../src/in-page/readers.ts';
import { openBidiPage, type BidiPage } from '../helpers/bidi-page.ts';
import { selectElements } from '../helpers/select-chain.ts';
import { bySelector, startWebSession } from '../helpers/web-session.ts';

const SHADOW = `<p class="x"><div id="host"></div></p><script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<section class="in"><span class="inner">S</span><button>Shadow</button></section>';</script>`;

/** Pages, and for each, selectors with the number of elements Playwright 1.64.1 matches. */
const CASES: readonly (readonly [string, Readonly<Record<string, number>>])[] = [
  ['<main class="card"><article><button>X</button></article></main>', {
    'article >> main button': 0,
    'article >> .card > article > button': 0,
    'article >> article button': 0,
    'article >> button': 1,
    'main >> article button': 1,
    'main >> article > button': 1,
    'main >> main article': 0,
    'article >> :scope > button': 1,
  }],
  ['<ul><li class="a">1</li><li class="b">2</li></ul><ul><li class="c">3</li></ul>', {
    'ul >> li + li': 1,
    'li.a >> li': 0,
    'ul >> .a ~ .b': 1,
    'ul >> li ~ li': 1,
    'body >> ul + ul li': 1,
    'ul + ul >> li': 1,
  }],
  ['<section><button>In</button></section><button>Out</button>', {
    'css=section >> xpath=//button': 1,
    'section >> //button': 1,
    'section >> xpath=.//button': 1,
    'section >> xpath=/button': 1,
    'section >> (//button)': 2,
    'xpath=//section >> button': 1,
    '//button': 2,
    'section >> xpath=..': 1,
    'section >> xpath=//section': 0,
  }],
  [SHADOW, {
    'p .inner': 0,
    '#host span': 1,
    '#host >> span': 1,
    '#host >> section > span': 1,
    'div .in span, button': 2,
    '.in >> span': 1,
    'section ~ button': 0,
    'span ~ button': 1,
    '#host >> xpath=//span': 0,
    'span >> xpath=..': 1,
    '#host >> :scope': 1,
    '#host >> :scope >> span': 1,
    '.in >> :scope': 1,
    '.in >> :scope >> button': 1,
  }],
  ['<main><article><p><button>A</button></p><button>B</button></article></main>', {
    ':scope > body': 1,
    ':scope main': 1,
    'article >> :scope button': 2,
    'main >> :scope > article > button': 1,
    'article >> p > button, :scope > button': 2,
    'main >> article >> p button': 1,
    'xpath=//article >> xpath=./button': 1,
    'article >> xpath=//p >> button': 1,
    'article >> xpath=//button': 2,
  }],
  ['<div><div><div><span>x</span></div></div></div>', {
    'div >> div div span': 1,
    'div >> div > div > span': 1,
    'div div': 2,
    'div >> div': 2,
    'div >> div >> div': 1,
    'div div >> div span': 1,
  }],
  ['<article><button>X</button></article>', {
    ':scope': 1,
    'article >> :scope': 1,
    'article >> :scope >> button': 1,
    'article >> :scope >> :scope': 1,
    'article >> :scope.x': 0,
    'article >> article:scope': 1,
    'article >> :scope:not(article)': 0,
    'article >> :scope:has(button)': 1,
    'article >> :scope, button': 2,
    'article >> :is(:scope, button)': 2,
    'article >> :not(:scope)': 1,
    'article >> :scope :scope': 0,
    'html >> :scope': 1,
    'button >> :scope': 1,
  }],
  ['<html class="x"><body><article class="x"><button class="x">X</button></article><article><button>Y</button></article></body></html>', {
    ':scope.x': 1,
    'article >> :scope': 2,
    'article >> :scope.x': 1,
    'article >> .x:scope': 1,
    'article >> :scope:not(.x)': 1,
    'article >> :scope >> .x': 1,
    'article >> :scope, .x': 3,
    'body >> :scope > article >> :scope': 2,
  }],
];

describe('selectors as Playwright reads them', () => {
  let page: BidiPage;

  beforeAll(async () => {
    page = await openBidiPage();
  });

  afterAll(async () => {
    await page?.close();
  });

  /** How many elements `selector` matches on the driver. */
  const count = async (selector: string): Promise<number> => (await selectElements(page, selector)).length;

  it.each(CASES.map(([html, expected], index) => [index, html, expected] as const))('matches page %i as Playwright does', async (_index, html, expected) => {
    await page.setContent(html);
    const actual: Record<string, number> = {};
    for (const selector of Object.keys(expected)) actual[selector] = await count(selector);
    expect(actual).toEqual(expected);
  });

  it('matches a deep descendant selector in time linear in the DOM', async () => {
    await page.setContent(`${'<div>'.repeat(24)}<span>x</span>${'</div>'.repeat(24)}`);
    const timed = async (selector: string): Promise<{ matches: number; ms: number }> => {
      const start = performance.now();
      const matches = await count(selector);
      return { matches, ms: performance.now() - start };
    };
    const missing = `section ${'div '.repeat(11)}span`;
    expect(await count(missing)).toBe(0);
    const runs = [await timed(missing), await timed(missing), await timed(missing)];
    expect(Math.min(...runs.map((run) => run.ms))).toBeLessThan(100);
    expect((await timed(`${'div '.repeat(12)}span`)).matches).toBe(1);
  });

  it('resolves a frame chain in three calls per frame, none in the frame\'s own world, and reads the matches in one', async () => {
    const inner = '<section><iframe srcdoc="<button>Deep</button>"></iframe></section>';
    const frames = ['#outer', 'section >> xpath=//iframe'];
    const session = await startWebSession();
    try {
      await session.setContent(`<iframe id="outer" srcdoc="${inner.replaceAll('"', '&quot;')}"></iframe>`);
      await session.waitForFrames();
      const calls = vi.spyOn(BidiConnection.prototype, 'send');
      const found = await session.locate(frames.reduceRight<LocatorExpression>((source, selector) => ({ kind: 'frame', selector, source }), bySelector('button')));
      expect(found.map((node) => ({ name: node.name, framePath: node.framePath }))).toEqual([{ name: 'Deep', framePath: frames }]);
      const readers = new Map([[readerCall('selectFrame'), 'selectFrame reader'], [readerCall('locate'), 'locate reader']]);
      const sent = calls.mock.calls.map(([method, params]) => {
        if (method !== 'script.callFunction') return method;
        const { functionDeclaration, target } = params as { functionDeclaration: string; target: { sandbox?: string } };
        return readers.get(functionDeclaration) ?? `page function in ${target.sandbox ?? 'the page\'s world'}`;
      });
      const perFrame = ['selectFrame reader', 'page function in e2e-frames', 'script.getRealms'];
      expect(sent).toEqual([...perFrame, ...perFrame, 'locate reader']);
    } finally {
      vi.restoreAllMocks();
      await session.close();
    }
  });
});
