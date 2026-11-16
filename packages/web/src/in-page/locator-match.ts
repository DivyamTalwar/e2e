/**
 * The reads a locate matches elements by. Serialized into the page beside
 * the semantic reader they read through, so this is one self-contained
 * function under the rule `read-semantics.ts` states.
 */

import type { createSemanticReader } from './read-semantics.ts';

/**
 * What a locate matches an element by, under one reader: the reader's own
 * reads, and beside them the ones Playwright's engines read differently
 * from the tree: an element's text as the text engine joins it (shadow
 * roots included), whether the role engine counts it hidden
 * (`isElementHiddenForAria`), its ARIA states with `mixed` and absent kept
 * apart from false (`getAriaChecked`, `getAriaPressed`, `getAriaExpanded`,
 * `getAriaSelected`), and its level (`getAriaLevel`: a heading tag's before
 * `aria-level`, none without either). Each read is computed when first
 * asked and kept for the rest of the read, so a query pays only for what it
 * compares.
 */
export const createLocatorReads = (reader: ReturnType<typeof createSemanticReader>, secureFieldSelector: string) => {
  /** Per-node memo, as the semantic reader keeps its own. */
  const memoized = <N extends Node, T>(compute: (node: N) => T): ((node: N) => T) => {
    const cache = new Map<N, T>();
    return (node) => {
      if (cache.has(node)) return cache.get(node) as T;
      const value = compute(node);
      cache.set(node, value);
      return value;
    };
  };
  const joinedTextOf = memoized((root: Element | ShadowRoot): string => {
    let full = '';
    const skipped = root.nodeType === 1 && (['SCRIPT', 'NOSCRIPT', 'STYLE'].indexOf(root.nodeName) !== -1 || (document.head !== null && document.head.contains(root)));
    if (!skipped) {
      if (root.nodeName === 'INPUT' && ['submit', 'button', 'reset'].indexOf((root as HTMLInputElement).type) !== -1) {
        full = (root as HTMLInputElement).value;
      } else {
        for (let child = root.firstChild; child !== null; child = child.nextSibling) {
          if (child.nodeType === 3) full += child.nodeValue ?? '';
          else if (child.nodeType === 1) full += joinedTextOf(child as Element);
        }
        const shadow = root.nodeType === 1 ? (root as Element).shadowRoot : null;
        if (shadow !== null) full += joinedTextOf(shadow);
      }
    }
    return full;
  });
  const belongsHidden = memoized((el: Element): boolean => {
    if (el.parentElement !== null && el.parentElement.shadowRoot !== null && el.assignedSlot === null) return true;
    if (el.ownerDocument.defaultView?.getComputedStyle(el).display === 'none' || (el.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true') return true;
    const root = el.getRootNode();
    const parent = el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    return parent !== null && belongsHidden(parent);
  });
  const hiddenForAria = memoized((el: Element): boolean => {
    if (['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE'].indexOf(el.nodeName) !== -1) return true;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (style === undefined) return true;
    const slot = el.nodeName === 'SLOT';
    if (style.display === 'contents' && !slot) {
      for (let child = el.firstChild; child !== null; child = child.nextSibling) {
        if (child.nodeType === 1 && !hiddenForAria(child as Element)) return false;
        if (child.nodeType === 3 && (child.nodeValue ?? '').trim() !== '') return false;
      }
      return true;
    }
    const option = el.nodeName === 'OPTION' && el.closest('select') !== null;
    const styleVisible = (typeof el.checkVisibility !== 'function' || el.checkVisibility()) && style.visibility === 'visible';
    if (!option && !slot && !styleVisible) return true;
    return belongsHidden(el);
  });
  const CHECKED_ROLES = ['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem'];
  const EXPANDED_ROLES = ['application', 'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem', 'row', 'rowheader', 'tab', 'treeitem', 'columnheader', 'menuitemcheckbox', 'menuitemradio', 'switch'];
  const SELECTED_ROLES = ['gridcell', 'option', 'row', 'tab', 'rowheader', 'columnheader', 'treeitem'];
  const ariaState = (el: Element, attribute: string): boolean | 'mixed' => {
    const value = el.getAttribute(attribute);
    return value === 'true' ? true : value === 'mixed' ? 'mixed' : false;
  };
  return {
    ...reader,
    /** The element's text as Playwright's text engine joins it: its shadow roots included, whitespace collapsed. */
    text: (el: Element): string => joinedTextOf(el).replace(/\u200b/g, '').trim().replace(/\s+/g, ' '),
    /** Whether Playwright's role engine leaves the element out as hidden from the accessibility tree. */
    hiddenForAria,
    /** The element's ARIA states, read for `role`: `mixed` and absent kept apart from false. */
    states: (el: Element, role: string) => {
      const input = el instanceof HTMLInputElement ? el : null;
      let checked: boolean | 'mixed' = false;
      if (input !== null && input.indeterminate) checked = 'mixed';
      else if (input !== null && (input.type === 'checkbox' || input.type === 'radio')) checked = input.checked;
      else if (CHECKED_ROLES.indexOf(role) !== -1) checked = ariaState(el, 'aria-checked');
      let expanded: boolean | null = null;
      if (el instanceof HTMLDetailsElement) expanded = el.open;
      else if (EXPANDED_ROLES.indexOf(role) !== -1 && el.hasAttribute('aria-expanded')) expanded = el.getAttribute('aria-expanded') === 'true';
      return {
        checked,
        pressed: role === 'button' ? ariaState(el, 'aria-pressed') : false,
        expanded,
        selected: el instanceof HTMLOptionElement ? el.selected : SELECTED_ROLES.indexOf(role) !== -1 && (el.getAttribute('aria-selected') ?? '').toLowerCase() === 'true',
      };
    },
    /** The level a role query compares, as Playwright reads it: a heading tag's, else a whole `aria-level` of at least 1, else none. */
    level: (el: Element): number | null => {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) return Number(tag.slice(1));
      const attribute = el.getAttribute('aria-level');
      const level = attribute === null ? Number.NaN : Number(attribute);
      return Number.isInteger(level) && level >= 1 ? level : null;
    },
    /** The value a display-value query compares: an input's (but a checkbox's or radio's), a textarea's, or a select's; null for a secure field and anything else. */
    displayValue: (el: Element): string | null =>
      el.matches('input:not([type="checkbox" i]):not([type="radio" i]), textarea, select') && !el.matches(secureFieldSelector)
        ? (el as HTMLInputElement).value
        : null,
  };
};
