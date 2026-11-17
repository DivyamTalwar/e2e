/**
 * The selector chain the readers resolve a `selector` and a frame selector
 * with. Self-contained, so its source is spliced into the readers a document
 * keeps (`readers.ts`).
 */

import type { Dom } from './dom.ts';

/** A CSS combinator between two compounds; `' '` is the descendant one. */
export type CssCombinator = ' ' | '>' | '+' | '~';

/** One compound of a complex CSS selector and the combinator joining it to the compound before it, null for the first. */
export type CssStep = { readonly compound: string; readonly combinator: CssCombinator | null };

/** One `>>` chain part as the page reads it: CSS as its complex selectors (`cssChains`), or an XPath expression. */
export type PagePart =
  | { readonly engine: 'css'; readonly body: string; readonly chains: CssStep[][] }
  | { readonly engine: 'xpath'; readonly body: string };

/**
 * The elements a `>>` chain (`pageParts`) matches, each part evaluated inside
 * every element the part before it matched, as Playwright's engines read it.
 * CSS pierces open shadow roots: the last compound is queried natively in the
 * scope and in each shadow root under it, and matched against the scope
 * element too, which a native query never answers; the compounds before it
 * are matched right to left up the composed tree (`dom.parentOrHostOf`),
 * memoized per element and compound, with every combinator stopping at the
 * scope element, which only a `:scope` compound matches. XPath stays in the
 * light DOM, a leading `/` read from the scope element. The result is a set:
 * its order means nothing, and `locate` answers matches in its own. A
 * selector the page cannot parse is its error message.
 */
export function selectChain(dom: Dom, parts: readonly PagePart[]): Element[] | string {
  const queryCss = (scope: Document | Element, chains: readonly (readonly CssStep[])[], into: Set<Element>): void => {
    const roots: (Document | Element | ShadowRoot)[] = [];
    const collect = (root: Document | Element | ShadowRoot): void => {
      roots.push(root);
      if (root.nodeType === 1 && (root as Element).shadowRoot !== null) collect((root as Element).shadowRoot!);
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot !== null) collect(element.shadowRoot);
    };
    collect(scope);
    const scopeElement = scope.nodeType === 1 ? (scope as Element) : null;
    const isScope = (element: Element): boolean => (scope.nodeType === 9 ? element === (scope as Document).documentElement : element === scope);
    const matchesCompound = (element: Element, compound: string): boolean => (compound.includes(':scope') ? isScope(element) : element !== scope) && element.matches(compound);
    const parentOf = (element: Element): Element | null => (element === scope ? null : dom.parentOrHostOf(element));
    const previousOf = (element: Element): Element | null => (element === scope ? null : element.previousElementSibling);
    for (const chain of chains) {
      const memo = new Map<Element, (boolean | undefined)[]>();
      const matchesBefore = (element: Element, index: number): boolean => {
        if (index === 0) return true;
        const known = memo.get(element)?.[index];
        if (known !== undefined) return known;
        const { combinator } = chain[index]!;
        const before = chain[index - 1]!;
        let result = false;
        if (combinator === '>' || combinator === '+') {
          const next = combinator === '>' ? parentOf(element) : previousOf(element);
          result = next !== null && matchesCompound(next, before.compound) && matchesBefore(next, index - 1);
        } else {
          const step = combinator === '~' ? previousOf : parentOf;
          for (let at = step(element); at !== null; at = step(at)) {
            if (!matchesCompound(at, before.compound)) continue;
            if (matchesBefore(at, index - 1)) {
              result = true;
              break;
            }
            if (before.combinator === combinator) break;
          }
        }
        const entry = memo.get(element) ?? [];
        entry[index] = result;
        memo.set(element, entry);
        return result;
      };
      const last = chain[chain.length - 1]!;
      for (const root of roots) {
        for (const element of root.querySelectorAll(last.compound)) if (matchesBefore(element, chain.length - 1)) into.add(element);
      }
      if (scopeElement !== null && matchesCompound(scopeElement, last.compound) && matchesBefore(scopeElement, chain.length - 1)) into.add(scopeElement);
    }
  };
  const queryXpath = (scope: Document | Element, body: string, into: Set<Element>): void => {
    const expression = scope.nodeType !== 9 && body.startsWith('/') ? `.${body}` : body;
    const found = (scope.ownerDocument ?? (scope as Document)).evaluate(expression, scope, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE);
    for (let node = found.iterateNext(); node !== null; node = found.iterateNext()) if (node.nodeType === 1) into.add(node as Element);
  };
  try {
    let matched: (Document | Element)[] = [document];
    for (const part of parts) {
      if (part.engine === 'css') document.querySelector(part.body);
      const found = new Set<Element>();
      for (const scope of matched) {
        if (part.engine === 'css') queryCss(scope, part.chains, found);
        else queryXpath(scope, part.body, found);
      }
      matched = [...found];
    }
    return matched as Element[];
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}
