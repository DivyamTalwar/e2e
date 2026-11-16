/**
 * What the driver's page functions share. Each page function is serialized
 * with `toString()` and runs in the page, so none closes over module scope:
 * one that needs the DOM helpers (`createDom`) takes them through `withDom`,
 * which splices their source into its own, and each helper is written once.
 * `Outcome` is the answer they give the driver about acting on an element.
 */

import { CLOSED_SHADOW_ROOTS_KEY } from './closed-shadow.ts';

/**
 * What a page function answers about acting on an element. `kind` alone
 * decides what the driver does next (`settle` in `actions.ts`): `ok` is done,
 * with whatever the function read; `detached` is an element out of the
 * document; `not-yet` is a state the app may leave, polled until the
 * deadline; `refused` is one it will not, and may follow a change the
 * function already made. `reason` is the words a failure carries, written
 * for a person and never matched.
 */
export type Outcome<T extends object = object> =
  | ({ readonly kind: 'ok' } & T)
  | { readonly kind: 'detached' }
  | { readonly kind: 'not-yet'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string };

/** The sides of a box in its document's viewport. */
export interface Area {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Builds the helpers over the closed shadow roots recorded under `key`,
 * read when a helper runs, so roots recorded after the helpers were built
 * count too. Self-contained: its source is what `withDom` splices in.
 */
export function createDom(key: string) {
  const recorded = (): WeakMap<Element, ShadowRoot> | undefined => Reflect.get(globalThis, Symbol.for(key));

  /** The element's open or recorded closed shadow root. */
  const shadowOf = (element: Element): ShadowRoot | null => element.shadowRoot ?? recorded()?.get(element) ?? null;

  /** The document and every open or recorded closed shadow root under it, outermost first. */
  const roots = (): (Document | ShadowRoot)[] => {
    const found: (Document | ShadowRoot)[] = [document];
    for (let index = 0; index < found.length; index += 1) {
      for (const element of found[index]!.querySelectorAll('*')) {
        const shadow = shadowOf(element);
        if (shadow !== null) found.push(shadow);
      }
    }
    return found;
  };

  /**
   * The element's parent in the flat tree: the slot it is assigned to (in a
   * recorded closed root too, whose slots still list what they hold), else
   * its parent element, else the host of the shadow root it is in. A slot
   * assigned to another slot is that slot's child, so the lists are read
   * unflattened.
   */
  const parentOf = (at: Element): Element | null => {
    if (at.assignedSlot !== null) return at.assignedSlot;
    const closed = at.parentElement === null ? undefined : recorded()?.get(at.parentElement);
    for (const slot of closed?.querySelectorAll('slot') ?? []) if (slot.assignedElements().includes(at)) return slot;
    const root = at.getRootNode();
    return at.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  };

  /** Whether a rotation, skew, reflection, or 3D transform turns the element: its own, or a flat-tree ancestor's (`transform`, `rotate`, or a negative `scale`). */
  const turned = (from: Element): boolean => {
    for (let at: Element | null = from; at !== null; at = parentOf(at)) {
      const style = getComputedStyle(at);
      if (style.rotate !== 'none' || style.scale.includes('-')) return true;
      if (style.transform === 'none') continue;
      const matrix = new DOMMatrixReadOnly(style.transform);
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) return true;
    }
    return false;
  };

  /** The boxes the element lays out: its client rects, or those of its contents for a `display: contents` element, which has none of its own. */
  const rectsOf = (element: Element): DOMRect[] => {
    const own = [...element.getClientRects()];
    if (own.length > 0 || getComputedStyle(element).display !== 'contents') return own;
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()];
  };

  /** The box an action reads the element by: its first, for a `display: contents` element the first of its contents with a size, else its bounding box. */
  const boxOf = (element: Element): DOMRect =>
    element.getClientRects()[0] ?? rectsOf(element).find((rect) => rect.width > 0 && rect.height > 0) ?? element.getBoundingClientRect();

  /** The visual viewport's size, the window's without one. */
  const viewport = (): { width: number; height: number } => ({ width: visualViewport?.width || innerWidth, height: visualViewport?.height || innerHeight });

  /** What to scroll to bring the element into view: itself when it lays out a box, else the first element inside it that does, else its parent. */
  const scrollTarget = (element: Element): Element | null =>
    element.getClientRects().length > 0 ? element : ([...element.querySelectorAll('*')].find((child) => child.getClientRects().length > 0) ?? element.parentElement);

  /**
   * What shows of `rect`, a box of `element`: what the viewport and every
   * ancestor that clips its overflow leave of it, as Playwright clips a
   * clickable point; null when under a pixel does.
   */
  const clipped = (element: Element, rect: DOMRect): Area | null => {
    const { width, height } = viewport();
    let left = Math.max(rect.left, 0);
    let top = Math.max(rect.top, 0);
    let right = Math.min(rect.right, width);
    let bottom = Math.min(rect.bottom, height);
    let at: Element | null = element;
    let position = getComputedStyle(element).position;
    while (at !== null) {
      const parent: Node | null = at.parentNode;
      at = parent instanceof ShadowRoot ? parent.host : parent instanceof Element ? parent : null;
      if (at === null || at === document.documentElement) break;
      const clip = getComputedStyle(at);
      const transformed = clip.transform !== 'none' || clip.filter !== 'none' || clip.perspective !== 'none' || clip.contain.includes('paint') || clip.contain.includes('layout');
      if (position === 'fixed' && !transformed) continue;
      if (position === 'absolute' && !transformed && clip.position === 'static') continue;
      position = clip.position;
      const bounds = at.getBoundingClientRect();
      if (clip.overflowX !== 'visible') {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (clip.overflowY !== 'visible') {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    return (right - left) * (bottom - top) > 0.99 && right > left && bottom > top ? { left, top, right, bottom } : null;
  };

  /** What shows (`clipped`) of the first of the element's boxes that shows at all; null when none does. */
  const visibleArea = (element: Element): Area | null => {
    for (const rect of rectsOf(element)) {
      const area = clipped(element, rect);
      if (area !== null) return area;
    }
    return null;
  };

  /** Scrolls the element to the centre of the view unless the centre of its box already shows (`visibleArea`). */
  const scrollIfClipped = (element: Element): void => {
    const area = visibleArea(element);
    const rect = boxOf(element);
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (area !== null && x >= area.left && x <= area.right && y >= area.top && y <= area.bottom) return;
    (scrollTarget(element) ?? element).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  };

  /** Not yet, for an element with no box a person could see. */
  const hidden: Outcome<never> = { kind: 'not-yet', reason: 'element is not visible' };

  /** Whether the element shows, before anything about a pointer: attached, laying out a box, and not `visibility: hidden`. */
  const shown = (element: Element): Outcome => {
    if (!element.isConnected) return { kind: 'detached' };
    const box = boxOf(element);
    return box.width === 0 || box.height === 0 || getComputedStyle(element).visibility === 'hidden' ? hidden : { kind: 'ok' };
  };

  /**
   * The box `read` answers once it held still for a frame: read in two
   * frames whose animation time differs, since a frame that repeats the
   * time shows no motion. Not yet while there is no box to read, or it
   * moved between the two.
   */
  const still = async (read: () => DOMRect | null): Promise<Outcome<{ box: DOMRect }>> => {
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const first = await frame();
    const before = read();
    if (before === null) return hidden;
    for (let tries = 0; tries < 5 && (await frame()) === first; tries += 1);
    const box = read();
    if (box === null) return hidden;
    const held = box.x === before.x && box.y === before.y && box.width === before.width && box.height === before.height;
    return held ? { kind: 'ok', box } : { kind: 'not-yet', reason: 'element is not stable' };
  };

  /** The element a pointer event for `element` must reach, as Playwright's hit check retargets it: the button or link that holds it, unless it is a field or an editing host. */
  const pointerTarget = (element: Element): Element =>
    element.matches('input, textarea, select') || (element as HTMLElement).isContentEditable
      ? element
      : (element.closest('button, [role=button], a, [role=link]') ?? element);

  /** The element a pointer event at `x`, `y` of this document hits, descending through open and recorded closed shadow roots. */
  const hitAt = (x: number, y: number): Element | null => {
    let hit = document.elementFromPoint(x, y);
    for (let root = hit === null ? null : shadowOf(hit); hit !== null && root !== null; root = shadowOf(hit)) {
      const inner = root.elementFromPoint(x, y);
      if (inner === null || inner === hit) break;
      hit = inner;
    }
    return hit;
  };

  /** Whether an event on `hit` reaches `target`: `target` is `hit` or one of its flat-tree ancestors. */
  const reaches = (hit: Element, target: Element): boolean => {
    for (let at: Element | null = hit; at !== null; at = parentOf(at)) if (at === target) return true;
    return false;
  };

  /** Not yet, for a pointer event that `hit` takes in place of the element it was meant for; undefined for something that is no element. */
  const interceptedBy = (hit: Element | undefined): Outcome<never> => ({
    kind: 'not-yet',
    reason: `${hit === undefined ? 'another element' : `<${hit.localName}${hit.id === '' ? '' : `#${hit.id}`}>`} intercepts pointer events`,
  });

  /** The element holding focus in this document, followed through open and recorded closed shadow roots. */
  const activeElement = (): Element | null => {
    let active = document.activeElement;
    for (let inner = active === null ? null : shadowOf(active)?.activeElement; inner !== null && inner !== undefined; inner = shadowOf(inner)?.activeElement) active = inner;
    return active;
  };

  /** Focuses `element`; whether focus landed on it, or on the editing host that holds it. */
  const focus = (element: Element): boolean => {
    (element as HTMLElement).focus();
    const active = activeElement();
    return active === element || ((element as HTMLElement).isContentEditable && active !== null && active.contains(element));
  };

  /** Fires the `input` and `change` an edit of `target` ends with, built with the page's own `Event` as the click watch's preload kept it, which a page may replace later. */
  const fireEdit = (target: Element): void => {
    const kept: typeof Event | undefined = Reflect.get(globalThis, Symbol.for('e2e.bidi.Event'));
    const EventClass = kept ?? Event;
    target.dispatchEvent(new EventClass('input', { bubbles: true, composed: true }));
    target.dispatchEvent(new EventClass('change', { bubbles: true }));
  };

  return { shadowOf, roots, parentOf, turned, rectsOf, boxOf, viewport, scrollTarget, clipped, visibleArea, scrollIfClipped, shown, still, pointerTarget, hitAt, reaches, interceptedBy, activeElement, focus, fireEdit };
}

/**
 * A page function that takes the shared DOM helpers before the arguments
 * the driver passes. Its source builds them from `createDom`'s own, over the
 * registry the closed-roots preload fills, so it stays self-contained and
 * the driver calls it with its arguments alone; it only runs in a page.
 */
export function withDom<A extends unknown[], R>(fn: (dom: ReturnType<typeof createDom>, ...args: A) => R): (...args: A) => R {
  const source = `(...args) => (${fn.toString()})((${createDom.toString()})(${JSON.stringify(CLOSED_SHADOW_ROOTS_KEY)}), ...args)`;
  const inPageOnly = (..._args: A): R => {
    throw new Error('a page function runs only in the page');
  };
  return Object.assign(inPageOnly, { toString: () => source });
}
