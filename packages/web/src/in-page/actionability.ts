/**
 * Page functions that decide whether, and where, an action can reach an
 * element: the checks before a pointer action, the hit test at its point,
 * scrolling into view, and where a wheel lands.
 */

import { withDom, type Area, type Outcome } from './dom.ts';

/** What `actionPoint` checks beside the element itself. */
export interface ActionPointOptions {
  /** How to scroll the element into view, for a retry after an overlay covered it; unset, only when its point is clipped. */
  readonly align?: { readonly block: ScrollLogicalPosition; readonly inline: ScrollLogicalPosition };
  /** True for a label clicked in place of its control (`labelStandIn`): the point is the control's centre when the control lays out a box. */
  readonly atControl?: boolean;
}

/**
 * Where an action can land on an element, after the checks Playwright runs
 * before a pointer action, but the hit test and the enabled check (the
 * `disabled` reader): attached, visible, scrolled into view when its point is
 * clipped by the viewport or a scrolling ancestor (or as `align` says), and
 * holding still for a frame. Not yet while one of them fails. The point is
 * the centre of the element's first client rect that shows at least a pixel,
 * as Playwright's clickable point, in whole pixels inside that rect: pointer
 * input takes whole pixels, and a rounded centre can miss a small element.
 */
export const actionPoint = withDom(async function actionPoint(dom, element: Element, options: ActionPointOptions): Promise<Outcome<{ x: number; y: number }>> {
  const shown = dom.shown(element);
  if (shown.kind !== 'ok') return shown;
  if (options.align === undefined) dom.scrollIfClipped(element);
  else (dom.scrollTarget(element) ?? element).scrollIntoView({ ...options.align, behavior: 'instant' });
  const held = await dom.still(() => dom.boxOf(element));
  if (held.kind !== 'ok') return held;
  const pixelIn = (area: Area): Outcome<{ x: number; y: number }> => {
    const x = (area.left + area.right) / 2;
    const y = (area.top + area.bottom) / 2;
    const inside = (px: number, py: number): boolean => px >= area.left && px < area.right && py >= area.top && py < area.bottom;
    for (const [px, py] of [[Math.floor(x), Math.floor(y)], [Math.floor(x) + 1, Math.floor(y)], [Math.floor(x) + 1, Math.floor(y) + 1], [Math.floor(x), Math.floor(y) + 1]] as const) {
      if (inside(px, py)) return { kind: 'ok', x: px, y: py };
    }
    return { kind: 'ok', x: Math.round(x), y: Math.round(y) };
  };
  const outside: Outcome<never> = { kind: 'not-yet', reason: 'element is outside of the viewport' };
  const control = options.atControl === true ? (element as HTMLLabelElement).control?.getBoundingClientRect() : undefined;
  if (control !== undefined && control.width > 0 && control.height > 0) {
    const [cx, cy] = [control.left + control.width / 2, control.top + control.height / 2];
    const over = dom.rectsOf(element).map((rect) => dom.clipped(element, rect)).find((rect): rect is Area => rect !== null && cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom);
    if (over === undefined) return outside;
    return pixelIn({
      left: Math.max(over.left, control.left),
      top: Math.max(over.top, control.top),
      right: Math.min(over.right, control.right),
      bottom: Math.min(over.bottom, control.bottom),
    });
  }
  const area = dom.visibleArea(element);
  return area === null ? outside : pixelIn(area);
});

/**
 * Scrolls a frame into view on the way to an element inside it, as
 * `actionPoint` scrolls an element: when the frame shows and the centre of
 * its box is clipped. It waits for nothing: the element's own check waits
 * for the page to hold still, and the hit test at its point sees every frame.
 */
export const scrollFrameIntoView = withDom((dom, frame: Element): void => {
  if (dom.shown(frame).kind === 'ok') dom.scrollIfClipped(frame);
});

/**
 * Whether the element shows, as `actionPoint` reads it before anything
 * about a pointer: attached, laying out a box, not `visibility: hidden`,
 * and not content a `content-visibility: hidden` ancestor skips. For an
 * action that types or selects, which needs no point.
 */
export const elementShown = withDom((dom, element: Element): Outcome => dom.shown(element));

/**
 * Whether a pointer event at `x`, `y` of the element's document reaches the
 * element, descending through open and recorded closed shadow roots to the
 * element actually hit. As Playwright's hit check, the element is first
 * retargeted to the button or link that holds it (a label inside a button
 * lets the button take the event), and the hit element's ancestors are
 * walked through the slots it is assigned to.
 */
export const hitBlocker = withDom((dom, element: Element, x: number, y: number): Outcome => {
  const hit = dom.hitAt(x, y);
  if (hit === null) return { kind: 'not-yet', reason: 'no element receives pointer events at the action point' };
  return dom.reaches(hit, dom.pointerTarget(element)) ? { kind: 'ok' } : dom.interceptedBy(hit);
});

/**
 * The label a click on a checkbox or radio goes through, null to click the
 * control itself; not yet while neither the control nor any of its labels
 * renders (a dialog not open yet). A component library (Element Plus)
 * hides a native checkbox or radio under its label's styled content, or gives
 * it no box at all, so the control fails the hit check though a user's click
 * there reaches it through the label. The choice reads the control and its
 * labels only, past anything else on top (a loading mask, a modal), which
 * the label's own actionability checks then wait out or fail on. No label
 * stands in for a disabled control, nor when the click would land on a link
 * or other control inside the label, nor at a point outside the label's box.
 */
export function labelStandIn(node: Element): Outcome<{ label: HTMLLabelElement | null }> {
  const itself: Outcome<{ label: null }> = { kind: 'ok', label: null };
  const unrendered: Outcome<never> = { kind: 'not-yet', reason: 'the control and its labels are not visible' };
  if (!node.isConnected || node.localName !== 'input') return itself;
  const input = node as HTMLInputElement;
  if ((input.type !== 'checkbox' && input.type !== 'radio') || input.matches(':disabled')) return itself;
  const labels = [...(input.labels ?? [])];
  const root = input.getRootNode();
  if (labels.length === 0 || (!(root instanceof Document) && !(root instanceof ShadowRoot))) return itself;
  const INTERACTIVE = 'a,button,input,select,textarea,summary,[contenteditable],[role="button"],[role="link"]';
  const hasBox = ({ width, height }: DOMRect): boolean => width > 0 && height > 0;
  const centre = ({ left, top, width, height }: DOMRect): [number, number] => [left + width / 2, top + height / 2];
  const topmost = (x: number, y: number): Element | undefined =>
    root.elementsFromPoint(x, y).find((hit) => hit === input || labels.some((label) => label.contains(hit)));
  const pressesInteractive = (label: HTMLLabelElement, hit: Element | undefined): boolean =>
    label.contains(hit?.closest(INTERACTIVE) ?? null);
  input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const box = input.getBoundingClientRect();
  if (!hasBox(box)) {
    const shown = labels.filter((label) => hasBox(label.getBoundingClientRect()) && label.checkVisibility({ visibilityProperty: true }));
    if (shown.length === 0) return unrendered;
    const label = shown.find((each) => {
      each.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return !pressesInteractive(each, topmost(...centre(each.getBoundingClientRect())));
    });
    return { kind: 'ok', label: label ?? null };
  }
  const [x, y] = centre(box);
  const hit = topmost(x, y);
  if (hit === undefined) return unrendered;
  const label = labels.find((own) => own.contains(hit));
  if (label === undefined || pressesInteractive(label, hit)) return itself;
  const outer = label.getBoundingClientRect();
  return x >= outer.left && x <= outer.right && y >= outer.top && y <= outer.bottom ? { kind: 'ok', label } : itself;
}

/**
 * Scrolls an element into view as Playwright's `scrollIntoViewIfNeeded`
 * does: once it holds still for a frame, and only when some of it is out of
 * the viewport or the box of an ancestor that clips it (`clippers` in
 * `dom.ts`; to its nearest edge there), one around its shadow host or the
 * slot it is assigned to included. In the viewport each axis follows
 * Chromium's center-if-needed, which Playwright's rect scroll uses: a box
 * wholly out is centred, a box partly out goes to its closest edge, start
 * unless it is smaller than the view and past its end or larger and short
 * of it. Any element with a box counts, a zero-sized or `visibility:
 * hidden` one included; a `display: contents` element counts by the boxes
 * of its contents. Not yet while nothing lays out a box (it may appear) or
 * the box moves.
 */
export const scrollIntoViewIfNeeded = withDom(async (dom, element: Element): Promise<Outcome> => {
  if (!element.isConnected) return { kind: 'detached' };
  const bounds = (): DOMRect | null => {
    const rects = dom.rectsOf(element);
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    return new DOMRect(left, top, Math.max(...rects.map((rect) => rect.right)) - left, Math.max(...rects.map((rect) => rect.bottom)) - top);
  };
  const held = await dom.still(bounds);
  if (held.kind !== 'ok') return held;
  const rect = held.box;
  const outside = (area: { left: number; top: number; right: number; bottom: number }): boolean =>
    rect.left < area.left || rect.top < area.top || rect.right > area.right || rect.bottom > area.bottom;
  const container = dom.clippers(element).some((clipper) => outside(clipper.bounds));
  const { width, height } = dom.viewport();
  if (container || outside({ left: 0, top: 0, right: width, bottom: height })) {
    const axis = (start: number, end: number, view: number): ScrollLogicalPosition => {
      if (start >= 0 && end <= view) return 'nearest';
      if (end <= 0 || start >= view) return 'center';
      return (end > view && end - start < view) || (end < view && end - start > view) ? 'end' : 'start';
    };
    dom.scrollTarget(element)?.scrollIntoView(container
      ? { block: 'nearest', inline: 'nearest', behavior: 'instant' }
      : { block: axis(rect.top, rect.bottom, height), inline: axis(rect.left, rect.right, width), behavior: 'instant' });
    // Firefox keeps a fractional page scroll offset in layout but paints at a whole-pixel one, so a box's pixels would sit
    // a pixel from where it reports: land on whole device pixels, as Chromium does. Down, so a fractional end still fits.
    const whole = (offset: number): number => Math.floor(offset * devicePixelRatio) / devicePixelRatio;
    if (whole(scrollX) !== scrollX || whole(scrollY) !== scrollY) scrollTo({ left: whole(scrollX), top: whole(scrollY), behavior: 'instant' });
  }
  return { kind: 'ok' };
});

/** Where a wheel reaches an element, with the box it read when nothing blocked it. */
export type WheelAim =
  | { readonly aim: 'pointer' | 'centre'; readonly box: { x: number; y: number; width: number; height: number } }
  | { readonly aim: 'blocked' };

/**
 * Where a wheel reaches `element` in a top-level document, whose box is the
 * viewport's: at the pointer when it already hovers the element, at its
 * centre when the hit target there is the element or inside it, else
 * `blocked`, which the full actionability checks answer.
 */
export function wheelAim(element: Element): WheelAim {
  if (window !== window.top || !element.isConnected || element.getClientRects().length === 0) return { aim: 'blocked' };
  const rect = element.getBoundingClientRect();
  const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  if (element.matches(':hover')) return { aim: 'pointer', box };
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return hit !== null && element.contains(hit) ? { aim: 'centre', box } : { aim: 'blocked' };
}

/** An element's box size, which a swipe on it spans; null for one that lays out no box of its own (`display: contents`). */
export function boxSize(element: Element): { width: number; height: number } | null {
  if (element.getClientRects().length === 0) return null;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}
