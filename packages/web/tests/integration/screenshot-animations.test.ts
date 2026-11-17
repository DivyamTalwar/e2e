/**
 * A capture stops what time moves on the page: an animation or transition
 * that ends is captured at its end, one that repeats forever at the style
 * under it, in every document and shadow root, and every path out of the
 * capture plays the cancelled ones again.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineSnapshot } from '@e2e-dev/core/engine';
import { decodePng } from '../helpers/png.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';
import { BidiConnection } from '../../src/driver/connection.ts';

const GREEN = [0, 128, 0, 255];
const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

/**
 * A block that blinks from red to blue forever over a green style of its
 * own, so green shows only while the animation is cancelled, above a black
 * block whose move 200px to the right takes ten minutes.
 */
const STAGE = `<style>
  body { margin: 0; background: #fff; }
  @keyframes blink { from { background-color: rgb(255, 0, 0); } to { background-color: rgb(0, 0, 255); } }
  #blink { width: 40px; height: 40px; background: rgb(0, 128, 0); animation: blink 200ms linear infinite alternate; }
  #slide { width: 40px; height: 40px; background: rgb(0, 0, 0); transition: margin-left 600s linear; }
  #slide.moved { margin-left: 200px; }
</style>
<div id="blink"></div><div id="slide"></div>`;

/** A page that holds the stage in each place a capture must reach, with `window.stage()` answering the root it is in. */
const PLACES: readonly (readonly [string, string])[] = [
  ['the document', `<!doctype html>${STAGE}<script>window.stage = () => document;</script>`],
  ...(['open', 'closed'] as const).map((mode) => [
    `${mode === 'open' ? 'an' : 'a'} ${mode} shadow root`,
    `<!doctype html><style>body { margin: 0; }</style><div id="host"></div>
      <script>
        const root = document.getElementById('host').attachShadow({ mode: '${mode}' });
        root.innerHTML = ${JSON.stringify(STAGE)};
        window.stage = () => root;
      </script>`,
  ] as const),
  [
    'a frame',
    `<!doctype html><style>body { margin: 0; }</style>
      <iframe style="display:block;border:0;width:320px;height:200px" srcdoc="${STAGE.replaceAll('"', '&quot;')}"></iframe>
      <script>window.stage = () => document.querySelector('iframe').contentDocument;</script>`,
  ],
];

/** How far the blink animation has played, in milliseconds; -1 while the block has none. Runs in the page. */
function blinkTime(): number {
  const stage: () => Document | ShadowRoot = Reflect.get(window, 'stage');
  const [animation] = stage().getElementById('blink')!.getAnimations();
  return animation === undefined ? -1 : Number(animation.currentTime);
}

/** Starts the slide's move and records the stage's `transitionend`s; answers how far the block has moved, in pixels. Runs in the page. */
function startSlide(): number {
  const stage: () => Document | ShadowRoot = Reflect.get(window, 'stage');
  const ended: string[] = [];
  Reflect.set(window, 'ended', ended);
  const slide = stage().getElementById('slide')!;
  stage().addEventListener('transitionend', (event) => ended.push(`${event.type} of ${event.target === slide ? 'the slide' : 'something else'}`));
  const style = (slide.ownerDocument.defaultView ?? window).getComputedStyle(slide);
  // Reading the style before the change gives the transition a value to start from.
  void style.marginLeft;
  slide.classList.add('moved');
  return Number.parseFloat(style.marginLeft);
}

/** The `transitionend`s `startSlide` recorded. Runs in the page. */
function transitionEnds(): string[] {
  return Reflect.get(window, 'ended');
}

let session: WebSession;

beforeAll(async () => {
  session = await startWebSession({ web: { viewport: { width: 320, height: 200 } }, startAttempt: false });
});

beforeEach(async () => {
  await session.startAttempt();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await session.endAttempt();
});

afterAll(async () => {
  await session?.close();
});

/** One observation's pixels: the bytes, and the image they decode to. */
async function capture(): Promise<{ bytes: Uint8Array; image: ReturnType<typeof decodePng>; snapshot: EngineSnapshot }> {
  const snapshot = await session.observe({ pixels: true });
  if (snapshot.pixels === undefined) throw new Error('the observation took no pixels');
  return { bytes: snapshot.pixels.data, image: decodePng(snapshot.pixels.data), snapshot };
}

/** One artifact screenshot, decoded. */
async function screenshot(label: string): Promise<ReturnType<typeof decodePng>> {
  return decodePng(readFileSync(path.join(session.artifactsDir, await session.engine.artifacts!.screenshot!(label, session.op(10_000)))));
}

/** Whether the blink animation plays again, from its start. */
async function expectBlinkRuns(): Promise<void> {
  await expect.poll(() => session.browser.evaluate(blinkTime), { timeout: 5_000 }).toBeGreaterThan(0);
}

/** What a test does around each screenshot, counted from 1: `before` once the page is masked and the capture is about to be sent, `after` once the browser answered it. */
interface CaptureHooks {
  readonly before?: (order: number) => Promise<void>;
  readonly after?: (order: number, connection: BidiConnection, context: string) => void;
}

/** Runs `hooks` around every screenshot the driver takes. */
function aroundCapture(hooks: CaptureHooks): void {
  const send = BidiConnection.prototype.send;
  let captures = 0;
  vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(async function (this: BidiConnection, method, params) {
    const order = method === 'browsingContext.captureScreenshot' ? (captures += 1) : 0;
    if (order > 0) await hooks.before?.(order);
    const result = await send.call(this, method, params);
    if (order > 0) hooks.after?.(order, this, (params as { context: string }).context);
    return result;
  });
}

describe.each(PLACES)('in %s', (_place, page) => {
  it('takes the same pixels of an infinite animation twice, and the animation runs again afterwards', async () => {
    await session.setContent(page);
    await session.waitForFrames();
    expect(await session.browser.evaluate(blinkTime)).toBeGreaterThanOrEqual(0);

    const first = await capture();
    const second = await capture();

    expect(Buffer.compare(second.bytes, first.bytes)).toBe(0);
    expect(first.image.pixelAt(20, 20)).toEqual(GREEN);
    await expectBlinkRuns();
  });

  it('captures a transition in flight at its end, and its transitionend fires', async () => {
    await session.setContent(page);
    await session.waitForFrames();
    expect(await session.browser.evaluate(startSlide)).toBeLessThan(1);

    const { image } = await capture();

    expect(image.pixelAt(220, 60)).toEqual(BLACK);
    expect(image.pixelAt(20, 60)).toEqual(WHITE);
    await expect.poll(() => session.browser.evaluate(transitionEnds), { timeout: 5_000 }).toEqual(['transitionend of the slide']);
  });
});

it('takes an artifact screenshot with the same animations stopped', async () => {
  await session.setContent(PLACES[0]![1]);
  expect(await session.browser.evaluate(startSlide)).toBeLessThan(1);

  const image = await screenshot('stopped');

  expect(image.pixelAt(20, 20)).toEqual(GREEN);
  expect(image.pixelAt(220, 60)).toEqual(BLACK);
  await expectBlinkRuns();
});

it('plays a cancelled animation again when the capture fails', async () => {
  await session.setContent(PLACES[0]![1]);
  const during: number[] = [];
  aroundCapture({
    before: async () => {
      during.push(await session.browser.evaluate(blinkTime));
      throw new Error('capture failed');
    },
  });

  await expect(session.engine.artifacts!.screenshot!('failed', session.op(5_000))).rejects.toThrow('capture failed');
  vi.restoreAllMocks();

  expect(during).toEqual([-1]);
  await expectBlinkRuns();
});

it('plays a cancelled animation again when the capture goes stale, and stops it again for the capture that follows', async () => {
  await session.setContent(PLACES[0]![1]);
  const during: number[] = [];
  let captures = 0;
  aroundCapture({
    before: async () => {
      during.push(await session.browser.evaluate(blinkTime));
    },
    after: (order, connection, context) => {
      captures = order;
      if (order > 1) return;
      // A navigation committed under the masks makes the capture stale, though the browser answered it.
      const event = { type: 'event', method: 'browsingContext.navigationCommitted', params: { context, navigation: null, timestamp: Date.now(), url: session.origin } };
      (connection as unknown as { receive(raw: string): void }).receive(JSON.stringify(event));
    },
  });

  const image = await screenshot('stale');
  vi.restoreAllMocks();

  expect(captures).toBe(2);
  // The second capture found the animation running again, or it would have had nothing to cancel.
  expect(during).toEqual([-1, -1]);
  expect(image.pixelAt(20, 20)).toEqual(GREEN);
  await expectBlinkRuns();
});

it('keeps an animation cancelled for a capture that overlaps the one that cancelled it', async () => {
  await session.setContent(PLACES[0]![1]);
  let second: Promise<Awaited<ReturnType<typeof capture>>> | undefined;
  let secondMasked!: () => void;
  const whenSecondMasked = new Promise<void>((resolve) => (secondMasked = resolve));
  let firstDone!: () => void;
  const whenFirstDone = new Promise<void>((resolve) => (firstDone = resolve));
  aroundCapture({
    before: async (order) => {
      if (order === 1) {
        // The second capture masks the page while the first holds it, and takes its screenshot only once the first let go.
        second = capture();
        await whenSecondMasked;
      } else {
        secondMasked();
        await whenFirstDone;
      }
    },
  });

  const first = await capture();
  firstDone();
  const overlapping = await second!;
  vi.restoreAllMocks();

  expect(first.image.pixelAt(20, 20)).toEqual(GREEN);
  expect(overlapping.image.pixelAt(20, 20)).toEqual(GREEN);
  await expectBlinkRuns();
});

it('covers a secure field an infinite animation moves where the field rests with the animation cancelled', async () => {
  await session.setContent(`<!doctype html>
    <style>
      body { margin: 0; background: #fff; }
      @keyframes drift { from { transform: translateX(100px); } to { transform: translateX(160px); } }
      #card { animation: drift 150ms linear infinite alternate; }
      input { position: absolute; left: 20px; top: 20px; width: 120px; height: 40px; border: 0; background: #fff; color: #fff; }
    </style>
    <div id="card"><input type="password" value="hunter22"></div>`);

  const { image, snapshot } = await capture();

  expect(snapshot.maskedRegionCount).toBe(1);
  expect(image.pixelAt(80, 40)).toEqual(BLACK);
  expect(image.pixelAt(250, 40)).toEqual(WHITE);
});

it('leaves an animation that holds still as the page set it: paused, at a zero rate, or driven by scroll', async () => {
  await session.setContent(`<!doctype html>
    <style>
      body { margin: 0; background: #fff; min-height: 1200px; }
      @keyframes blink { from { background-color: rgb(255, 0, 0); } to { background-color: rgb(0, 0, 255); } }
      @keyframes grow { from { width: 0px; } to { width: 320px; } }
      div { position: fixed; left: 0; width: 40px; height: 40px; background: rgb(0, 128, 0); }
      #paused { top: 0; animation: blink 1s linear infinite; animation-play-state: paused; }
      #ended { top: 40px; animation: blink 1s linear; animation-play-state: paused; }
      #frozen { top: 80px; }
      #scrolled { top: 120px; animation: grow linear; animation-timeline: scroll(root); }
    </style>
    <div id="paused"></div><div id="ended"></div><div id="frozen"></div><div id="scrolled"></div>
    <script>
      const frozen = document.getElementById('frozen').animate([{ backgroundColor: 'rgb(255, 0, 0)' }, { backgroundColor: 'rgb(0, 0, 255)' }], { duration: 1000, iterations: Infinity });
      frozen.playbackRate = 0;
    </script>`);
  // A scroll timeline reads the scroll position once per frame.
  await session.browser.evaluate(async () => {
    scrollTo(0, 500);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return null;
  });
  /** Each block's animation states, and its style as the animation holds it. Runs in the page. */
  const held = (): string[] => ['paused', 'ended', 'frozen', 'scrolled'].map((id) => {
    const block = document.getElementById(id)!;
    const style = getComputedStyle(block);
    return `${id}: ${block.getAnimations().map((animation) => animation.playState).join()} ${style.backgroundColor} ${String(Math.round(Number.parseFloat(style.width)))}px`;
  });
  const before = await session.browser.evaluate(held);
  expect(before).toEqual([
    'paused: paused rgb(255, 0, 0) 40px',
    'ended: paused rgb(255, 0, 0) 40px',
    'frozen: running rgb(255, 0, 0) 40px',
    'scrolled: running rgb(0, 128, 0) 160px',
  ]);

  const first = await capture();
  const second = await capture();

  expect(Buffer.compare(second.bytes, first.bytes)).toBe(0);
  expect(first.image.pixelAt(20, 20).slice(0, 3)).toEqual([255, 0, 0]);
  expect(first.image.pixelAt(150, 140)).toEqual(GREEN);
  expect(await session.browser.evaluate(held)).toEqual(before);
});

it('captures a page that holds an animation its browser will not finish', async () => {
  // Firefox never applies a playback rate in a frame it does not render, and finish() refuses an animation whose rate is turning zero.
  await session.setContent(`${PLACES[0]![1]}
    <iframe style="display:none" srcdoc="<div id='held'></div><script>document.getElementById('held').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600000 }).updatePlaybackRate(0);</script>"></iframe>`);
  await session.waitForFrames();

  const image = await screenshot('unfinished');

  expect(image.pixelAt(20, 20)).toEqual(GREEN);
  await expectBlinkRuns();
});

it('plays the other animations again when the page turned one backwards under the capture', async () => {
  await session.setContent(`${PLACES[0]![1]}
    <div id="turned" style="width:40px;height:40px"></div>
    <script>window.turned = document.getElementById('turned').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, iterations: Infinity });</script>`);
  aroundCapture({
    // play() refuses an animation with no end that runs backwards.
    before: async () => {
      await session.browser.evaluate(() => {
        const turned: Animation = Reflect.get(window, 'turned');
        turned.playbackRate = -1;
        return null;
      });
    },
  });

  const image = await screenshot('turned');
  vi.restoreAllMocks();

  expect(image.pixelAt(20, 20)).toEqual(GREEN);
  await expectBlinkRuns();
});
