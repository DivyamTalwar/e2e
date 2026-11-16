/**
 * Nested documents. An iframe's document is its own
 * browsing context, reached through the iframe element's `contentWindow`;
 * the surface remembers, for each child context it entered, the iframe
 * element that holds it, and each frame's document reads how it lays the
 * frame out (the `frame` reader), so a box measured inside the child can be
 * placed in the top-level viewport the pointer and the screenshot share.
 */

import { EngineError, TestError, type LocatorExpression, type SemanticNode } from '@e2e-dev/core/engine';
import { ChromiumCdp } from './cdp.ts';
import type { BrowserTraits } from '../browsers.ts';
import { compose, IDENTITY, invert, rectToQuad, scaleThenTranslate, type Point, type Projection } from './projection.ts';
import { chainParts, cssChains } from './selector-tokens.ts';
import type { FrameBox, ReadOptions, TurnedFrame } from '../in-page/readers.ts';
import type { PagePart } from '../in-page/select-chain.ts';
import type { BidiConnection } from './connection.ts';
import { callFunction, WindowRef, type CallOptions, type ElementRef } from './script.ts';
import type { BidiSession } from './session.ts';

/** An element and the browsing context whose document holds it. */
export interface NodeTarget {
  readonly element: ElementRef;
  readonly context: string;
  /** The expression that located the element as its only match, which an action checks still matches it alone. */
  readonly locator?: LocatorExpression;
}

type Rect = NonNullable<SemanticNode['rect']>;

/** A frame's viewport in the top-level one: where its coordinates start, how much they scale, and the part of it its holders show. */
export interface FrameView {
  readonly origin: Point;
  readonly scale: Point;
  readonly clip: Rect;
}

/** A rect in a frame's viewport, in the viewport `view` places that frame's in. */
function toParent(rect: Rect, view: Pick<FrameView, 'origin' | 'scale'>): Rect {
  return { x: view.origin.x + rect.x * view.scale.x, y: view.origin.y + rect.y * view.scale.y, width: rect.width * view.scale.x, height: rect.height * view.scale.y };
}

/** `rect` cut to `bounds`; undefined when nothing of it is inside. */
function clipTo(rect: Rect, bounds: Rect): Rect | undefined {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const width = Math.min(rect.x + rect.width, bounds.x + bounds.width) - x;
  const height = Math.min(rect.y + rect.height, bounds.y + bounds.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/**
 * Where the viewport of the document a frame chain leads to sits in the
 * top-level one (`FrameView`), from how each frame on the way is laid out,
 * outermost first. Undefined for the top level, null when a frame on the
 * way lays out no box, is turned, or shows none of it.
 */
export function frameView(boxes: readonly FrameBox[]): FrameView | null | undefined {
  let view: FrameView | undefined;
  for (const box of boxes) {
    if (box === null || 'turned' in box) return null;
    const { content, scale } = box;
    if (view === undefined) {
      view = { origin: { x: content.x, y: content.y }, scale, clip: content };
      continue;
    }
    const placed = toParent(content, view);
    const clip = clipTo(placed, view.clip);
    if (clip === undefined) return null;
    view = { origin: { x: placed.x, y: placed.y }, scale: { x: view.scale.x * scale.x, y: view.scale.y * scale.y }, clip };
  }
  return view;
}

/**
 * The `>>` chain parts of `selector` as the page reads them. Only the CSS and
 * XPath engines are supported, and only the last part may capture; anything
 * else is `INVALID_LOCATOR`.
 */
export function pageParts(selector: string): PagePart[] {
  const parts = chainParts(selector);
  if (parts.slice(0, -1).some((part) => part.capture)) {
    throw new TestError('INVALID_LOCATOR', 'a selector that captures with * (*css=article >> text=Hello) is not supported: use filter({ has }) instead');
  }
  return parts.map((part): PagePart => {
    if (part.engine === 'css') return { engine: 'css', body: part.body, chains: cssChains(part.body) };
    if (part.engine === 'xpath') return { engine: 'xpath', body: part.body };
    throw new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: the ${part.engine}= engine is not supported`);
  });
}

/** An iframe element's window, which serializes as its browsing context. Runs in the page. */
function contentWindow(element: HTMLIFrameElement): Window | null {
  return element.contentWindow;
}

/** The child browsing context of an iframe element, or undefined when it has no document; `options` names the realm that reads it. */
export async function contentContext(connection: BidiConnection, frame: NodeTarget, options?: CallOptions): Promise<string | undefined> {
  const window = await callFunction(connection, frame.context, contentWindow, [frame.element], options);
  return window instanceof WindowRef ? window.context : undefined;
}

/** The iframe that holds each child context the surface entered, by child context. */
export class FrameRegistry {
  private readonly holders = new Map<string, NodeTarget>();

  /** `read` asks the document that holds a frame how it lays the frame out (the `frameBox` reader). */
  constructor(private readonly read: (frame: NodeTarget) => Promise<FrameBox>) {}

  /** Records that `child` is the document of `frame`. */
  enter(child: string, frame: NodeTarget): void {
    this.holders.set(child, frame);
  }

  /** The iframes from the top-level document down to `context`, outermost first; empty for the top level. */
  chain(context: string): NodeTarget[] {
    const chain: NodeTarget[] = [];
    for (let holder = this.holders.get(context); holder !== undefined; holder = this.holders.get(holder.context)) {
      chain.unshift(holder);
    }
    return chain;
  }

  /**
   * Each iframe holding `context`, outermost first, as the map from the
   * viewport of the document it shows to the viewport of its own document,
   * the documents read at once. A frame turned by a rotation or a 3D
   * transform maps through the quad the browser lays its border box out on
   * (`turnedFrameMap`). Null when a frame on the way lays out no box, or the
   * browser reports no quad for a turned one.
   */
  async frameMaps(connection: BidiConnection, context: string, traits: BrowserTraits): Promise<Projection[] | null> {
    const chain = this.chain(context);
    const boxes: NonNullable<FrameBox>[] = [];
    for (const box of await Promise.all(chain.map((frame) => this.read(frame)))) {
      if (box === null) return null;
      boxes.push(box);
    }
    const sessions = traits.cdp && boxes.some((box) => 'turned' in box) ? await Promise.all(chain.map((frame) => ChromiumCdp.forContext(connection, frame.context))) : undefined;
    const maps: Projection[] = [];
    let root: Projection = IDENTITY;
    for (const [index, box] of boxes.entries()) {
      if (index > 0) root = sessions !== undefined && sessions[index]!.session !== sessions[index - 1]!.session ? IDENTITY : compose(root, maps[index - 1]!);
      const map = 'turned' in box ? await turnedFrameMap(chain[index]!, box.turned, sessions?.[index], root) : scaleThenTranslate(box.content, box.scale);
      if (map === undefined) return null;
      maps.push(map);
    }
    return maps;
  }

  /** Forgets every frame, when the documents that held them are gone. */
  clear(): void {
    this.holders.clear();
  }
}

/** The corners of a quad, top-left first and clockwise. */
type Quad = readonly [Point, Point, Point, Point];

/**
 * The map from the viewport of the document a turned frame shows to the
 * viewport of the frame's own document: its content inset, then the quad
 * its border box lays out on. Chromium reports the quad (CDP
 * `DOM.getContentQuads`) in the viewport of the frame's local root, the
 * outermost document its process renders, which `root` maps the frame's
 * document into, for the node chromium-bidi's shared id ends in
 * (`f.<frame>.d.<document>.e.<backend node id>`); Firefox reports it in the
 * frame's document (`getBoxQuads`, behind `layout.css.getBoxQuads.enabled`).
 * Undefined when the browser reports none.
 */
async function turnedFrameMap(frame: NodeTarget, box: TurnedFrame, cdp: ChromiumCdp | undefined, root: Projection): Promise<Projection | undefined> {
  let quad = box.quad === null ? null : quadOf(box.quad);
  let toDocument: Projection | undefined = IDENTITY;
  if (cdp !== undefined) {
    const backendNodeId = Number(/\.e\.(\d+)$/.exec(frame.element.sharedId)?.[1]);
    if (!Number.isInteger(backendNodeId)) return undefined;
    const [flat] = (await cdp.send('DOM.getContentQuads', { backendNodeId })).quads;
    quad = flat === undefined ? null : quadOf([0, 2, 4, 6].map((at) => ({ x: flat[at]!, y: flat[at + 1]! })));
    toDocument = invert(root);
  }
  if (quad === null || toDocument === undefined) return undefined;
  const border = rectToQuad(box.width, box.height, quad);
  if (border === undefined) return undefined;
  return compose(toDocument, compose(border, scaleThenTranslate(box.inset, { x: 1, y: 1 })));
}

/** The quad whose corners `points` lists, top-left first and clockwise; null unless there are four. */
function quadOf(points: readonly Point[]): Quad | null {
  const [p0, p1, p2, p3] = points;
  return points.length === 4 && p0 !== undefined && p1 !== undefined && p2 !== undefined && p3 !== undefined ? [p0, p1, p2, p3] : null;
}

/** The `INVALID_LOCATOR` of a selector the page could not parse, with the page's `reason`. */
export function unparsedSelector(selector: string, reason: string): TestError {
  return new TestError('INVALID_LOCATOR', `selector ${selector} is not a CSS or XPath selector: ${reason}`);
}

/** The document a frame chain leads to. */
export interface FramedDocument {
  readonly context: string;
  /** Whether a frame on the way reads as hidden, and so everything inside it. */
  readonly hidden: boolean;
  /** How each frame on the way is laid out, outermost first. */
  readonly boxes: readonly FrameBox[];
}

/**
 * The sandbox realm a locate reads a frame's window in. Read in the page's
 * own world, `contentWindow` creates the script context of a document the
 * frame has run no script in yet, its first, empty one. The browser keeps
 * that context for the document the frame then loads, without the listeners
 * the preload scripts added to it, so the click watch sees no click there.
 * Read in a sandbox, the window leaves the frame's own world alone, and the
 * locate's read of its document waits for that document's context.
 */
const FRAME_SANDBOX = 'e2e-frames';

/**
 * The document the innermost frame of `selectors` shows, each selector
 * matched in the document of the one before it (the `selectFrame` reader):
 * `FRAME_NOT_FOUND` (retryable, a frame loads) when one matches nothing or
 * has no document yet, `FRAME_AMBIGUOUS` when one matches more than one
 * iframe. Every frame on the way is recorded in the session's registry.
 */
export async function resolveFrames(session: BidiSession, selectors: readonly string[], options: ReadOptions): Promise<FramedDocument> {
  let context = session.requireContext();
  let hidden = false;
  const boxes: FrameBox[] = [];
  for (const selector of selectors) {
    const found = await session.reader('selectFrame', [pageParts(selector), options], context);
    if (typeof found === 'string') throw unparsedSelector(selector, found);
    if (found.count === 0) throw new EngineError('FRAME_NOT_FOUND', `no frame matches ${selector}`, { retryable: true });
    if (found.only === undefined) throw new EngineError('FRAME_AMBIGUOUS', `${found.count} frames match ${selector}`, { retryable: false });
    const frame = { element: found.only.element, context };
    const child = await contentContext(session.connection, frame, { sandbox: FRAME_SANDBOX });
    if (child === undefined) throw new EngineError('FRAME_NOT_FOUND', `frame ${selector} has no document yet`, { retryable: true });
    session.frames.enter(child, frame);
    context = child;
    hidden ||= found.only.hidden;
    boxes.push(found.only.box);
  }
  return { context, hidden, boxes };
}

/**
 * A locator expression split at its frames in one walk: the selectors of the
 * frames it descends through, outermost first, and the expression the
 * innermost frame's document answers, its `frame` steps removed. A union
 * whose branches, or a `has` or `hasNot` whose locator, names another frame
 * chain than its source is `UNSUPPORTED_CAPABILITY`.
 */
export function splitFrames(expression: LocatorExpression): { chain: string[]; inner: LocatorExpression } {
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((selector, index) => selector === b[index]);
  switch (expression.kind) {
    case 'frame': {
      const { chain, inner } = splitFrames(expression.source);
      return { chain: [expression.selector, ...chain], inner };
    }
    case 'query': {
      if (expression.scope === undefined) return { chain: [], inner: expression };
      const { chain, inner } = splitFrames(expression.scope);
      return { chain, inner: { ...expression, scope: inner } };
    }
    case 'filter': {
      const source = splitFrames(expression.source);
      const inners: { has?: LocatorExpression; hasNot?: LocatorExpression } = {};
      for (const key of ['has', 'hasNot'] as const) {
        const filter = expression[key];
        if (filter === undefined) continue;
        const { chain, inner } = splitFrames(filter);
        if (chain.length > 0 && !same(chain, source.chain)) {
          throw new EngineError('UNSUPPORTED_CAPABILITY', 'an inner has or hasNot locator must belong to the same frame as the locator it filters', { retryable: false });
        }
        inners[key] = inner;
      }
      return { chain: source.chain, inner: { ...expression, source: source.inner, ...inners } };
    }
    case 'index': {
      const { chain, inner } = splitFrames(expression.source);
      return { chain, inner: { ...expression, source: inner } };
    }
    case 'union': {
      const left = splitFrames(expression.left);
      const right = splitFrames(expression.right);
      if (!same(left.chain, right.chain)) {
        throw new EngineError('UNSUPPORTED_CAPABILITY', 'locator.or requires both branches in the same document', { retryable: false });
      }
      return { chain: left.chain, inner: { ...expression, left: left.inner, right: right.inner } };
    }
    case 'selector':
      return { chain: [], inner: expression };
  }
}

/**
 * A node read inside a frame, in the top-level viewport: its box shifted by
 * the frame's origin and scale and clipped to what the frame shows, dropped when the
 * frame has no box or the node lies outside it, and its frame path set.
 */
export function inViewport(node: SemanticNode, frame: FrameView | null | undefined, framePath: readonly string[]): SemanticNode {
  const withPath = framePath.length === 0 ? node : { ...node, framePath };
  if (frame === undefined || node.rect === undefined) return withPath;
  const { rect: _rect, ...rest } = withPath;
  const placed = frame === null ? undefined : clipTo(toParent(node.rect, frame), frame.clip);
  return placed === undefined ? rest : { ...rest, rect: placed };
}
