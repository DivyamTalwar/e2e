/**
 * The click watch: capture listeners a preload installs ahead of the page's
 * own scripts, which decide whether the input of a click reaches the element
 * it was aimed at and suppress it when it does not.
 */

import { withDom, type Outcome } from './dom.ts';

/** What `armHitInterceptor` leaves for the listeners: the element the input must reach, and their verdict once an event arrived. */
type HitWatch = { readonly target: Element; verdict: Outcome | undefined };

/**
 * Installs the capture listeners the click watch (`armHitInterceptor`)
 * decides through (they do nothing until a watch is armed), and keeps the
 * page's own `Event` constructor for the driver's edits, which a page may
 * replace later.
 */
const installHitInterceptor = withDom((dom): void => {
  Reflect.set(globalThis, Symbol.for('e2e.bidi.Event'), Event);
  const contains = (target: Element, x: number, y: number): boolean => {
    const hit = dom.hitAt(x, y);
    return hit !== null && dom.reaches(hit, target);
  };
  /** True for an element of any realm: one adopted from a frame may not be an `Element` of this window. */
  const isElement = (target: EventTarget | undefined): target is Element => target !== undefined && 'nodeType' in target && target.nodeType === 1;
  const listener = (event: MouseEvent): void => {
    const watch: HitWatch | undefined = Reflect.get(globalThis, Symbol.for('e2e.bidi.hit.active'));
    if (watch === undefined) return;
    if (watch.verdict === undefined) {
      const path = event.composedPath();
      // An event the page built itself (`new Event('click')`) carries no point.
      const reached = path.includes(watch.target) || ('clientX' in event && contains(watch.target, event.clientX, event.clientY));
      const [hit] = path;
      watch.verdict = reached ? { kind: 'ok' } : dom.interceptedBy(isElement(hit) ? hit : undefined);
    }
    if (watch.verdict.kind !== 'ok') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu'] as const) window.addEventListener(type, listener, { capture: true });
});

/** The preload that runs `installHitInterceptor` before the page's own scripts, so no listener of the app runs ahead of the watch's. */
export const HIT_INTERCEPTOR_INIT_SCRIPT = `(${installHitInterceptor.toString()})();`;

/**
 * Arms the click watch the init script installed, for the input about to
 * reach `element`, as Playwright's hit target interceptor: the first press,
 * release, or click decides whether the input reaches the element
 * (retargeted to its button or link, through slots, shadow hosts, and
 * recorded closed roots), and every later one is suppressed when it did not.
 * `hitInterceptorResult` reads the decision.
 */
export const armHitInterceptor = withDom((dom, element: Element): void => {
  const watch: HitWatch = { target: dom.pointerTarget(element), verdict: undefined };
  Reflect.set(globalThis, Symbol.for('e2e.bidi.hit.active'), watch);
});

/**
 * Ends the click watch: `ok` when the input reached the element, or when
 * the document it was armed in is gone (the click navigated, so it landed);
 * not yet, with what took the input, when it did not; `unseen` when no input
 * reached this document.
 */
export function hitInterceptorResult(): Outcome | { readonly kind: 'unseen' } {
  const watch: HitWatch | undefined = Reflect.get(globalThis, Symbol.for('e2e.bidi.hit.active'));
  Reflect.deleteProperty(globalThis, Symbol.for('e2e.bidi.hit.active'));
  if (watch === undefined) return { kind: 'ok' };
  return watch.verdict ?? { kind: 'unseen' };
}
