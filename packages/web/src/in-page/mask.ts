/** Page functions that hold a document still and cover its secure fields for one screenshot, and prove afterwards that the cover held. */

import { withDom } from './dom.ts';

/** What one masking changed in the document, kept under its token until `unmaskSecureFields` undoes it. */
type Mask = {
  readonly hosts: { container: Element | null; host: HTMLElement }[];
  readonly caret: CSSStyleSheet;
  readonly sheeted: (Document | ShadowRoot)[];
  readonly boxes: { field: Element; rect: DOMRect; box: HTMLElement }[];
  readonly selector: string;
  readonly cancelled: Animation[];
};

/**
 * Covers every secure field of the document, through open and recorded
 * closed shadow roots, with an opaque box, and hides the caret in the
 * document and each of those roots (with a stylesheet each adopts), for one
 * screenshot; returns how many fields it covered. A field inside a top-layer
 * element (a modal dialog, an open popover, a fullscreen element, found
 * through the composed tree, slots included) gets its box inside that
 * element, in its scaled coordinates, so the box moves with it however the
 * app reorders the top layer; any other field's box (and one in a top-layer
 * element turned or mirrored) sits in a manual popover of its own, above
 * what the app shows. Boxes live in closed shadow roots of hosts whose every
 * style is set inline as `!important`, so no page rule reaches them. `token`
 * names this masking for `unmaskSecureFields`; captures that overlap each
 * keep their own.
 *
 * Before any field is measured, so each is covered where it comes to rest,
 * it stops every animation and transition the clock moves in the document
 * and those roots: one that ends is finished, so the page gets its end
 * events, and one that repeats forever is cancelled to the style under it,
 * for `unmaskSecureFields` to play again. One that holds still is left as
 * the page set it: paused, at a zero playback rate, or driven by a scroll
 * position.
 */
export const maskSecureFields = withDom((dom, selector: string, token: string): number => {
  const sheeted = dom.roots();
  const cancelled: Animation[] = [];
  for (const animation of sheeted.flatMap((root) => root.getAnimations())) {
    if (animation.playState !== 'running' || animation.playbackRate === 0 || !(animation.timeline instanceof DocumentTimeline)) continue;
    if (animation.effect?.getComputedTiming().endTime === Infinity) {
      animation.cancel();
      cancelled.push(animation);
      continue;
    }
    try {
      animation.finish();
    } catch {
      // finish() refuses an animation whose playback rate is turning zero, which holds still without it.
    }
  }
  const fields = sheeted.flatMap((root) => [...root.querySelectorAll(selector)]);
  const pin = (element: HTMLElement, styles: Record<string, string>): void => {
    element.style.setProperty('all', 'initial', 'important');
    for (const [name, value] of Object.entries(styles)) element.style.setProperty(name, value, 'important');
  };
  const layerOf = (field: Element): Element | null => {
    for (let at: Element | null = field; at !== null; at = dom.parentOf(at)) {
      if (at.matches(':modal, :popover-open, :fullscreen')) return dom.turned(at) ? null : at;
    }
    return null;
  };
  const hosts = new Map<Element | null, { host: HTMLElement; layer: ShadowRoot }>();
  const hostFor = (container: Element | null): { host: HTMLElement; layer: ShadowRoot } => {
    let made = hosts.get(container);
    if (made === undefined) {
      const host = document.createElement('e2e-mask');
      pin(host, {
        display: 'block', position: 'fixed', inset: '0', width: '100vw', height: '100vh', margin: '0', padding: '0', border: '0',
        opacity: '1', visibility: 'visible', overflow: 'visible', background: 'transparent', 'pointer-events': 'none', 'z-index': '2147483647',
      });
      if (container === null) {
        host.popover = 'manual';
        document.documentElement.append(host);
        host.showPopover();
      } else {
        container.append(host);
      }
      made = { host, layer: host.attachShadow({ mode: 'closed' }) };
      hosts.set(container, made);
    }
    return made;
  };
  const boxes: Mask['boxes'] = [];
  for (const field of fields) {
    const rect = field.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const { host, layer } = hostFor(layerOf(field));
    const origin = host.getBoundingClientRect();
    const scaleX = host.offsetWidth > 0 ? origin.width / host.offsetWidth : 1;
    const scaleY = host.offsetHeight > 0 ? origin.height / host.offsetHeight : 1;
    const box = document.createElement('div');
    pin(box, {
      display: 'block', position: 'absolute',
      left: `${(rect.left - origin.left) / scaleX}px`, top: `${(rect.top - origin.top) / scaleY}px`, width: `${rect.width / scaleX}px`, height: `${rect.height / scaleY}px`,
      background: '#000', opacity: '1', visibility: 'visible', 'pointer-events': 'none',
    });
    layer.append(box);
    boxes.push({ field, rect, box });
  }
  const caret = new CSSStyleSheet();
  caret.replaceSync('input, textarea, [contenteditable] { caret-color: transparent !important; }');
  for (const root of sheeted) root.adoptedStyleSheets = [...root.adoptedStyleSheets, caret];
  const kept: Map<string, Mask> | undefined = Reflect.get(globalThis, Symbol.for('e2e.bidi.mask'));
  const masks = kept ?? new Map<string, Mask>();
  masks.set(token, { hosts: [...hosts].map(([container, { host }]) => ({ container, host })), caret, sheeted, boxes, selector, cancelled });
  Reflect.set(globalThis, Symbol.for('e2e.bidi.mask'), masks);
  return boxes.length;
});

/**
 * Removes what `maskSecureFields` added. Returns whether the screenshot taken
 * between the two showed no secure field: this document holds the masking
 * under `token`, every host still where it was put (the popover still open,
 * each other host still inside its top-layer element) and painted opaque,
 * every box drawn over the whole of its field, every covered field where its
 * box was, and no visible secure field
 * appeared that no box covers.
 *
 * Last, once every field was read where it rested, it plays again each
 * animation `maskSecureFields` cancelled, unless a capture that overlaps
 * this one still holds the document: that one takes them over and plays
 * them when it lets go.
 */
export const unmaskSecureFields = withDom((dom, token: string): boolean => {
  const masks: Map<string, Mask> | undefined = Reflect.get(globalThis, Symbol.for('e2e.bidi.mask'));
  const mask = masks?.get(token);
  if (masks === undefined || mask === undefined) return false;
  masks.delete(token);
  const painted = (element: HTMLElement): boolean => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility === 'visible' && style.opacity === '1';
  };
  const placed = ({ container, host }: Mask['hosts'][number]): boolean =>
    (container === null ? host.matches(':popover-open') : host.parentNode === container && container.matches(':modal, :popover-open, :fullscreen')) && painted(host);
  const covers = ({ field, box }: Mask['boxes'][number]): boolean => {
    const target = field.getBoundingClientRect();
    const drawn = box.getBoundingClientRect();
    return drawn.left <= target.left + 0.5 && drawn.top <= target.top + 0.5 && drawn.right >= target.right - 0.5 && drawn.bottom >= target.bottom - 0.5;
  };
  const shown = mask.hosts.every(placed) && mask.boxes.every((entry) => painted(entry.box) && covers(entry));
  for (const { host } of mask.hosts) host.remove();
  for (const root of mask.sheeted) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => sheet !== mask.caret);
  const still = ({ field, rect }: Mask['boxes'][number]): boolean => {
    const now = field.getBoundingClientRect();
    return now.x === rect.x && now.y === rect.y && now.width === rect.width && now.height === rect.height;
  };
  const covered = new Set(mask.boxes.map(({ field }) => field));
  const uncovered = (field: Element): boolean => {
    const rect = field.getBoundingClientRect();
    return !covered.has(field) && rect.width > 0 && rect.height > 0;
  };
  const held = shown && mask.boxes.every(still) && !dom.roots().some((root) => [...root.querySelectorAll(mask.selector)].some(uncovered));
  const overlapping: Mask | undefined = masks.values().next().value;
  if (overlapping !== undefined) {
    overlapping.cancelled.push(...mask.cancelled);
    return held;
  }
  for (const animation of mask.cancelled) {
    try {
      animation.play();
    } catch {
      // play() refuses an animation with no end that plays backwards.
    }
  }
  return held;
});
