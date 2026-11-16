/**
 * Actions: one locator action on a node, one pointer
 * action at a point, and keyboard input, each after the actionability
 * checks Playwright runs, with points placed in the top-level viewport.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Deadline,
  EngineError,
  TestError,
  type LocatorAction,
  type NodeRef,
  type PointerAction,
  type ViewportPoint,
  type ViewportSize,
} from '@e2e-dev/core/engine';
import { actionPoint, boxSize, elementShown, hitBlocker, labelStandIn, scrollIntoViewIfNeeded, wheelAim } from '../in-page/actionability.ts';
import { nextFrame } from '../in-page/document.ts';
import type { Outcome } from '../in-page/dom.ts';
import { checkState, directoryInput, fileInput, fill as fillElement, focus, focusTakesKeys, insertFocusedText, selectOption, setFileBytes, type FileBytes } from '../in-page/edits.ts';
import { armHitInterceptor, hitInterceptorResult } from '../in-page/hit-interceptor.ts';
import { SECURE_FIELD_SELECTOR } from '../in-page/read-node.ts';
import { chromiumDrag, firefoxDrag } from './drag.ts';
import { unlessStale } from '../errors.ts';
import type { NodeTarget } from './frames.ts';
import { invert, project } from './projection.ts';
import { ROOT_NODE_ID, stillLocated } from './observe.ts';
import { CONTENT_TYPES } from './content-types.ts';
import { type ClickOptions, clickSources, dragStepMs, moveSources, nearestPixel, swipeDistance, swipeSources, typeSource, wheelDelta } from './input-sources.ts';
import { pressStroke } from './keyboard.ts';
import type { BidiSession } from './session.ts';
import { ElementRef } from './script.ts';

/** How long a long press holds the button when the action names no duration. */
const DEFAULT_LONG_PRESS_MS = 500;
/** Pause between actionability checks of an element that is not ready yet. */
const POLL_MS = 50;
/** How a retry scrolls a covered element into view, as Playwright cycles them: as needed, then to the end, the centre, the start. */
const SCROLL_ALIGNMENTS = [
  undefined,
  { block: 'end', inline: 'end' },
  { block: 'center', inline: 'center' },
  { block: 'start', inline: 'start' },
] as const;

/**
 * One action on a located or observed node; a `swipe` on the observation
 * root is the viewport swipe at the pointer. A located node acts only while
 * its locator still matches it alone (`stillLocated`), which its locate
 * proved already when no input or test code ran since (`claimFresh`).
 */
export async function perform(session: BidiSession, ref: NodeRef, action: LocatorAction, timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (action.kind === 'swipe' && ref.id === ROOT_NODE_ID) {
    await wheel(session, session.input.pointer, await session.viewportSize(), action.direction, action.momentum ?? 'none', signal);
    return;
  }
  const deadline = new Deadline(timeoutMs);
  const target = session.refs.lookup(ref);
  if (!session.refs.claimFresh(ref)) await stillLocated(session, target);
  const held = 'modifiers' in action && action.modifiers !== undefined ? { modifiers: action.modifiers } : {};
  switch (action.kind) {
    case 'tap':
      return clickControl(session, target, deadline, held, signal, 'tap');
    case 'doubleTap':
      return click(session, target, deadline, { clicks: 2, ...held }, signal);
    case 'secondaryTap':
      return click(session, target, deadline, { button: 2, ...held }, signal);
    case 'longPress':
      return click(session, target, deadline, { holdMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS }, signal);
    case 'hover': {
      const point = await pointerPoint(session, target, deadline, false, signal);
      return session.input.send(moveSources(point.x, point.y), signal);
    }
    case 'fill':
      return fill(session, target, action.value, deadline, signal);
    case 'clear':
      return fill(session, target, '', deadline, signal);
    case 'press':
      await focusOn(session, target, signal);
      return session.input.press(action.key, signal);
    case 'focus':
      return focusOn(session, target, signal);
    case 'scrollIntoView':
      return scrollIntoView(session, target, deadline, signal);
    case 'check':
    case 'uncheck':
      return setChecked(session, target, action.kind === 'check', deadline, signal);
    case 'selectOption': {
      const by = typeof action.value === 'string' ? { label: action.value } : action.value;
      await waitVisibleEnabled(session, target, deadline, signal);
      return mutateWhenReady(session, deadline, signal, 'selectOption: ', () => session.page.run(selectOption, [target.element, by], target.context));
    }
    case 'setInputFiles':
      return setInputFiles(session, target, action.paths, deadline, signal);
    case 'dragTo':
      return dragTo(session, target, session.refs.lookup(action.target), deadline, signal);
    case 'swipe': {
      // A wheel the element already takes goes at once; only one something blocks waits for it to become actionable.
      const aimed = await session.page.run(wheelAim, [target.element], target.context);
      if (aimed.aim !== 'blocked') {
        const { box } = aimed;
        const at = aimed.aim === 'pointer' ? session.input.pointer : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        return wheel(session, at, box.width > 0 ? box : await session.viewportSize(), action.direction, action.momentum ?? 'none', signal);
      }
      const point = await pointerPoint(session, target, deadline, false, signal);
      const box = await session.page.run(boxSize, [target.element], target.context);
      if (box === null) throw new EngineError('NOT_ACTIONABLE', 'element has no visible bounding box', { retryable: false });
      return wheel(session, point, box.width > 0 ? box : await session.viewportSize(), action.direction, action.momentum ?? 'none', signal);
    }
  }
}

/** One pointer action at a viewport point with nothing resolved behind it. */
export async function performAt(session: BidiSession, point: ViewportPoint, action: PointerAction, signal: AbortSignal): Promise<void> {
  const at = nearestPixel(point);
  switch (action.kind) {
    case 'tap':
      return session.input.send(clickSources(at.x, at.y), signal);
    case 'doubleTap':
      return session.input.send(clickSources(at.x, at.y, { clicks: 2 }), signal);
    case 'secondaryTap':
      return session.input.send(clickSources(at.x, at.y, { button: 2 }), signal);
    case 'longPress':
      return session.input.send(clickSources(at.x, at.y, { holdMs: action.durationMs ?? DEFAULT_LONG_PRESS_MS }), signal);
    case 'hover':
      return session.input.send(moveSources(at.x, at.y), signal);
    case 'dragTo':
      return drag(session, at, async () => nearestPixel(action.target), 0, signal);
    case 'swipeTo':
      return drag(session, at, async () => nearestPixel(action.target), action.durationMs ?? 0, signal);
    case 'swipe':
      return wheel(session, at, await session.viewportSize(), action.direction, action.momentum ?? 'none', signal);
  }
}

/** Types into whatever holds focus, in any document of the tab, refusing when nothing there takes keystrokes. */
export async function typeText(session: BidiSession, text: string, replace: boolean, signal: AbortSignal): Promise<void> {
  const documents = await session.documentContexts(session.requireContext());
  const editable = await Promise.all(documents.map((context) =>
    unlessStale(session.page.run(focusTakesKeys, [], context), false)));
  if (!editable.includes(true)) {
    throw new EngineError(
      'NOT_ACTIONABLE',
      'nothing that takes keystrokes has focus: the typed text would reach no field. Tap the field first, or type into a listed input by id.',
      { retryable: false },
    );
  }
  if (replace) {
    await session.input.key(pressStroke('ControlOrMeta+a'), signal);
    await session.input.key(pressStroke('Delete'), signal);
  }
  await typeInto(session, text, signal);
}

/**
 * Types `text` into whatever holds focus, as Playwright's `keyboard.type`
 * does: a character the US keyboard has is a key press, anything else (an
 * emoji, a letter of another alphabet) is inserted as text in the document
 * holding focus, since no key types it.
 */
export async function typeInto(session: BidiSession, text: string, signal: AbortSignal): Promise<void> {
  let run = '';
  const flush = async (): Promise<void> => {
    if (run === '') return;
    await session.input.send([typeSource(run)], signal);
    run = '';
  };
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (/^[\x20-\x7e]$/.test(segment) || segment === '\n' || segment === '\r\n' || segment === '\t') {
      run += segment;
      continue;
    }
    await flush();
    signal.throwIfAborted();
    session.input.mutated();
    for (const context of await session.documentContexts(session.requireContext())) {
      if (await unlessStale(session.page.run(insertFocusedText, [segment], context), false)) break;
    }
  }
  await flush();
}

/** The element left the document: retryable, so the harness locates it again. */
function detached(): EngineError {
  return new EngineError('NODE_STALE', 'element is not attached to the DOM', { retryable: true });
}

/**
 * The one place an answer about acting on an element (`Outcome`) becomes
 * the action's. Runs `attempt` until it answers anything but not yet,
 * pausing between tries: `ok` is the result, an element out of the document
 * fails as `detached` does, and a refusal, or a not yet once the deadline
 * leaves no room for another try, fails with the answer's reason after
 * `prefix`. An attempt that throws ends the poll. Nothing runs once `signal`
 * aborted.
 */
async function settle<T extends object>(
  deadline: Deadline,
  signal: AbortSignal,
  attempt: () => Promise<Outcome<T>>,
  prefix = 'element did not become actionable in time: ',
): Promise<{ readonly kind: 'ok' } & T> {
  for (;;) {
    signal.throwIfAborted();
    const outcome = await attempt();
    if (outcome.kind === 'ok') return outcome;
    if (outcome.kind === 'detached') throw detached();
    if (outcome.kind === 'refused' || deadline.remaining() <= POLL_MS) throw new EngineError('NOT_ACTIONABLE', `${prefix}${outcome.reason}`, { retryable: false });
    await sleep(POLL_MS, undefined, { signal });
  }
}

/**
 * Waits until the element can take a pointer action, then clicks it with
 * the page watching where the input lands (`armHitInterceptor`): input an
 * overlay raised as the pointer arrived is suppressed in the page before any
 * listener of the app sees it, counts as never dispatched, and the click is
 * tried again until the deadline. Input no event of the element's document
 * saw may have reached another document, so it is reported as may have
 * committed, never replayed. A page that went away under the click counts as
 * reached.
 */
async function click(session: BidiSession, target: NodeTarget, deadline: Deadline, options: ClickOptions, signal: AbortSignal, atControl = false): Promise<void> {
  const aim = pointerAim(session, target, true, atControl);
  await settle(deadline, signal, async () => {
    const point = await aim();
    if (point.kind !== 'ok') return point;
    await session.page.run(armHitInterceptor, [target.element], target.context);
    const verdict = await session.input.sendSuppressible(
      clickSources(point.x, point.y, options),
      signal,
      () => unlessStale(session.page.run(hitInterceptorResult, [], target.context), { kind: 'ok' }),
      (seen) => seen.kind === 'not-yet',
    );
    if (verdict.kind === 'unseen') {
      throw new EngineError('ACTION_MAY_HAVE_COMMITTED', 'the click reached no event in the element\'s document, so another document (an overlay in a parent frame) may have taken it', { retryable: false });
    }
    return verdict;
  });
}

/**
 * Clicks a checkbox or radio through its own label when the page names one
 * standing in for it (`labelStandIn`), at the control's point, else clicks
 * the target as itself. The actionability checks then run on the label, so
 * anything else on top, such as a modal, still fails NOT_ACTIONABLE. The
 * choice is read again while neither the control nor a label renders,
 * within the deadline.
 */
async function clickControl(session: BidiSession, target: NodeTarget, deadline: Deadline, options: ClickOptions, signal: AbortSignal, verb: 'tap' | 'check' | 'uncheck'): Promise<void> {
  const { label } = await settle(deadline, signal, () => session.page.run(labelStandIn, [target.element], target.context), `${verb} did not become actionable in time: `);
  if (label === null) return click(session, target, deadline, options, signal);
  return click(session, { element: label, context: target.context }, deadline, options, signal, true);
}

/** Scrolls the element, and each frame holding it, into view as Playwright does, polling while it lays out no box or moves. */
async function scrollIntoView(session: BidiSession, target: NodeTarget, deadline: Deadline, signal: AbortSignal): Promise<void> {
  await settle(deadline, signal, async () => {
    await scrollFrames(session, target);
    return session.page.run(scrollIntoViewIfNeeded, [target.element], target.context);
  });
}

/** Focuses the element, a page change its focus handlers may make; an element that takes no focus keeps the old one, as Playwright's `focus` leaves it. */
async function focusOn(session: BidiSession, target: NodeTarget, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  session.input.mutated();
  await session.page.run(focus, [target.element], target.context);
}

/**
 * Scrolls each frame holding the element into view, outermost first,
 * without waiting for any to hold still: the element's own check waits
 * for that, and the hit test at its point sees every frame.
 */
async function scrollFrames(session: BidiSession, target: NodeTarget): Promise<void> {
  for (const frame of session.frames.chain(target.context)) {
    await session.page.run(actionPoint, [frame.element, { stable: false }], frame.context);
  }
}

/** Waits until the element shows and is enabled, for an action that types or selects: no pointer is involved, so neither stillness nor a point in view counts. */
async function waitVisibleEnabled(session: BidiSession, target: NodeTarget, deadline: Deadline, signal: AbortSignal): Promise<void> {
  await settle(deadline, signal, async () => {
    const enabled = await readEnabled(session, target);
    return enabled.kind === 'ok' ? session.page.run(elementShown, [target.element], target.context) : enabled;
  });
}

/** Whether the element is enabled, as the shared reader reads it, in the page functions' terms. */
async function readEnabled(session: BidiSession, target: NodeTarget): Promise<Outcome> {
  const options = { testIdAttribute: session.settings.testIdAttribute, secureFieldSelector: SECURE_FIELD_SELECTOR };
  const disabled = await session.page.reader('disabled', [target.element, options], target.context);
  if (disabled === null) return { kind: 'detached' };
  return disabled ? { kind: 'not-yet', reason: 'element is not enabled' } : { kind: 'ok' };
}

/**
 * One check of the element's actionability (`actionPoint`), each frame
 * holding it scrolled into view first: its point in its own document's
 * viewport, or why not yet.
 */
async function settledPoint(session: BidiSession, target: NodeTarget, enabled: boolean, align: (typeof SCROLL_ALIGNMENTS)[number], atControl: boolean): Promise<Outcome<{ x: number; y: number }>> {
  await scrollFrames(session, target);
  if (enabled) {
    const ready = await readEnabled(session, target);
    if (ready.kind !== 'ok') return ready;
  }
  return session.page.run(actionPoint, [target.element, { ...(align === undefined ? {} : { align }), ...(atControl ? { atControl } : {}) }], target.context);
}

/** The element's actionable point in the top-level viewport (`pointerAim`), polled until the deadline. */
async function pointerPoint(session: BidiSession, target: NodeTarget, deadline: Deadline, enabled: boolean, signal: AbortSignal): Promise<{ x: number; y: number }> {
  return settle(deadline, signal, pointerAim(session, target, enabled));
}

/**
 * Checks of the element's actionable point in the top-level viewport, each
 * answering the point once a pointer event there reaches it: the
 * whole-pixel point to be dispatched is projected back through every frame
 * holding the element, and the element is hit at that point in its
 * document, every iframe at it in its parent's. Each check after one that
 * found the element covered scrolls it into view another way
 * (`SCROLL_ALIGNMENTS`), as Playwright does to get an element out from
 * under a sticky header. `atControl` aims a label standing in for its
 * control at the control's point (`labelStandIn`).
 */
function pointerAim(session: BidiSession, target: NodeTarget, enabled: boolean, atControl = false): () => Promise<Outcome<{ x: number; y: number }>> {
  let covered = 0;
  return async () => {
    const local = await settledPoint(session, target, enabled, SCROLL_ALIGNMENTS[covered % SCROLL_ALIGNMENTS.length], atControl);
    if (local.kind !== 'ok') return local;
    const chain = session.frames.chain(target.context);
    const maps = await session.frames.frameMaps(session.connection, target.context, session.browser.traits);
    const inverses = maps?.map(invert);
    if (maps === null || inverses === undefined || inverses.includes(undefined)) {
      throw new EngineError('NOT_ACTIONABLE', 'element is in a frame that lays out no box, or whose transform the browser maps no point through', { retryable: false });
    }
    const point = maps.reduceRight((at, map) => project(map, at), { x: local.x, y: local.y });
    const top = { x: Math.round(point.x), y: Math.round(point.y) };
    const inDocuments: { x: number; y: number }[] = [];
    let projected = top;
    for (const [index, inverse] of inverses.entries()) {
      inDocuments[index] = projected;
      projected = project(inverse!, projected);
    }
    const checks = [
      session.page.run(hitBlocker, [target.element, projected.x, projected.y], target.context),
      ...chain.map((frame, index) => session.page.run(hitBlocker, [frame.element, inDocuments[index]!.x, inDocuments[index]!.y], frame.context)),
    ];
    const blocked = (await Promise.all(checks)).find((hit) => hit.kind !== 'ok');
    if (blocked === undefined) return { kind: 'ok', ...top };
    covered += 1;
    return blocked;
  };
}

/** Replaces the field's content with `value` in one edit, as a paste would, once it is visible, enabled, and editable (not still, nor in view: no pointer is involved); see the page's `fill`. */
async function fill(session: BidiSession, target: NodeTarget, value: string, deadline: Deadline, signal: AbortSignal): Promise<void> {
  await waitVisibleEnabled(session, target, deadline, signal);
  return mutateWhenReady(session, deadline, signal, '', () => session.page.run(fillElement, [target.element, value], target.context));
}

/**
 * Runs a page mutation, polling while the page answers not yet: such an
 * answer changed nothing, as one of a detached element did not, so neither
 * counts as dispatched. A mutation that ran, threw midway, or refused does:
 * a fill refuses a malformed number only once the field took it. Nothing
 * runs once `signal` aborted.
 */
async function mutateWhenReady(session: BidiSession, deadline: Deadline, signal: AbortSignal, prefix: string, mutate: () => Promise<Outcome>): Promise<void> {
  await settle(deadline, signal, async () => {
    let outcome: Outcome;
    try {
      outcome = await mutate();
    } catch (cause) {
      session.input.mutated();
      throw cause;
    }
    if (outcome.kind === 'ok' || outcome.kind === 'refused') session.input.mutated();
    return outcome;
  }, prefix);
}

/**
 * Clicks a checkable once when its state differs, then polls until it
 * reads `checked`. A control gone after the click took it: the app replaced
 * it on change. A native radio cannot be cleared by a click; an ARIA radio is
 * clicked like any control, and its script decides what the click does.
 */
async function setChecked(session: BidiSession, target: NodeTarget, checked: boolean, deadline: Deadline, signal: AbortSignal): Promise<void> {
  const before = await session.page.run(checkState, [target.element], target.context);
  if (before === 'detached') throw detached();
  if (before.checked === null) throw new EngineError('NOT_ACTIONABLE', 'Not a checkbox or radio button', { retryable: false });
  if (before.checked === checked) return;
  if (!checked && before.radio === 'native') {
    throw new EngineError('NOT_ACTIONABLE', 'uncheck cannot clear a radio button; select another radio in its group', { retryable: false });
  }
  const hint = !checked && before.radio === 'aria' ? '; a radio usually clears only when another radio in its group is selected' : '';
  await clickControl(session, target, deadline, {}, signal, checked ? 'check' : 'uncheck');
  let first = true;
  await settle(deadline, signal, async () => {
    const after = await unlessStale(session.page.run(checkState, [target.element], target.context), 'detached');
    if (after === 'detached' && !first) {
      throw new EngineError('NOT_ACTIONABLE', `${checked ? 'check' : 'uncheck'} clicked the control but its checked state did not change before the control was replaced`, { retryable: false });
    }
    first = false;
    if (after === 'detached' || after.checked === checked) return { kind: 'ok' };
    return { kind: 'not-yet', reason: `${checked ? 'check' : 'uncheck'} clicked the control but its checked state did not change${hint}` };
  }, '');
}

/**
 * Whether `files` name one directory (else only files), refusing what
 * Playwright's upload refuses before it reaches the page: a path that does
 * not exist, more than one directory, and a directory beside files.
 */
async function uploadKind(files: readonly string[]): Promise<boolean> {
  const kinds = await Promise.all(files.map(async (file) => {
    try {
      return (await stat(file)).isDirectory();
    } catch (cause) {
      throw new TestError('INVALID_ARGUMENT', cause instanceof Error ? cause.message : String(cause));
    }
  }));
  const directories = kinds.filter(Boolean).length;
  if (directories > 1) throw new TestError('INVALID_ARGUMENT', 'Multiple directories are not supported');
  if (directories === 1 && files.length > 1) throw new TestError('INVALID_ARGUMENT', 'File paths must be all files or a single directory');
  return directories === 1;
}

/**
 * Attaches files to a file input or one a `<label>` names directly; any
 * other control is clicked with the file chooser awaited
 * (`input.fileDialogOpened`), and the input that chooser serves takes the
 * files. A control that opens no chooser by the deadline fails, as
 * Playwright's upload does. `input.setFiles` takes paths on the browser's
 * own filesystem, so a browser on another machine gets the files' bytes
 * instead (`remoteFiles`), up to `MAX_REMOTE_UPLOAD_BYTES` in all; a
 * directory, whose files' relative paths a page cannot set, is refused there.
 */
async function setInputFiles(session: BidiSession, target: NodeTarget, paths: readonly string[], deadline: Deadline, signal: AbortSignal): Promise<void> {
  const connection = session.connection;
  const files = paths.map((file) => path.resolve(session.settings.projectRoot, file));
  const directory = await uploadKind(files);
  const remote = session.settings.remoteFiles ? await remoteUpload(files, directory) : undefined;
  const send = async (context: string, element: ElementRef): Promise<void> => {
    const takesDirectory = await session.page.run(directoryInput, [element], context);
    if (directory && !takesDirectory) throw new TestError('INVALID_ARGUMENT', 'File input does not support directories, pass individual files instead');
    if (!directory && takesDirectory) throw new TestError('INVALID_ARGUMENT', '[webkitdirectory] input requires passing a path to a directory');
    signal.throwIfAborted();
    session.input.mutated();
    if (remote === undefined) {
      await connection.send('input.setFiles', { context, element: { sharedId: element.sharedId }, files });
      return;
    }
    const refused = await session.page.run(setFileBytes, [element, remote], context);
    if (refused !== null) throw new TestError('INVALID_ARGUMENT', refused);
  };
  const input = await session.page.run(fileInput, [target.element], target.context);
  if (input instanceof ElementRef) {
    await send(target.context, input);
    return;
  }
  const timer = new AbortController();
  let off: () => void = () => undefined;
  const opened = new Promise<{ context: string; element?: { sharedId: string } } | undefined>((resolve) => {
    off = connection.on('input.fileDialogOpened', (info) => {
      if (session.onPage(info.context)) resolve(info);
    });
    timer.signal.addEventListener('abort', () => resolve(undefined));
  });
  const timeout = setTimeout(() => timer.abort(), Math.max(1, deadline.remaining()));
  const cancel = (): void => timer.abort();
  signal.addEventListener('abort', cancel);
  try {
    await click(session, target, deadline, {}, signal);
    const chooser = await opened;
    signal.throwIfAborted();
    if (chooser?.element === undefined) {
      throw new EngineError('NOT_ACTIONABLE', 'upload clicked the control but it opened no file chooser', { retryable: false });
    }
    await send(chooser.context, new ElementRef(chooser.element.sharedId));
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
    off();
  }
}

/** The most bytes, all files together, an upload sends a browser on another machine, as Playwright caps an in-memory upload. */
const MAX_REMOTE_UPLOAD_BYTES = 50 * 1024 * 1024;

/** The files of an upload to a browser on another machine, as bytes; a directory or more than `MAX_REMOTE_UPLOAD_BYTES` is refused. */
async function remoteUpload(files: readonly string[], directory: boolean): Promise<FileBytes[]> {
  if (directory) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', 'setInputFiles: a directory cannot be sent to a browser provider\'s browser on another machine; pass its files instead', { retryable: false });
  }
  const stats = await Promise.all(files.map((file) => stat(file)));
  const total = stats.reduce((sum, each) => sum + each.size, 0);
  if (total > MAX_REMOTE_UPLOAD_BYTES) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `setInputFiles: ${String(total)} bytes cannot be sent to a browser provider's browser on another machine; the limit is ${String(MAX_REMOTE_UPLOAD_BYTES)}`, { retryable: false });
  }
  return Promise.all(files.map(async (file, index) => ({
    name: path.basename(file),
    type: CONTENT_TYPES[path.extname(file).toLowerCase()] ?? '',
    lastModified: Math.round(stats[index]!.mtimeMs),
    base64: (await readFile(file)).toString('base64'),
  })));
}

/**
 * Drags the source onto the target as Playwright does: the source is
 * pressed once it is actionable, and only then is the target resolved, a
 * located one checked to still match its locator alone, then scrolled into
 * view and hit at its point like any pointer target, so a target in any
 * frame a tap reaches takes the drop.
 */
async function dragTo(session: BidiSession, source: NodeTarget, target: NodeTarget, deadline: Deadline, signal: AbortSignal): Promise<void> {
  const from = await pointerPoint(session, source, deadline, true, signal);
  await drag(session, from, async () => {
    await stillLocated(session, target);
    return pointerPoint(session, target, deadline, false, signal);
  }, 0, signal);
}

/**
 * Presses at `from`, reads where the drag goes (`to`), moves there over
 * `durationMs`, and releases there; a failure before the release lifts the
 * button where the mouse last was. On Chromium a drag the page starts
 * carries its data to the drop (`chromiumDrag`); on Firefox it is refused
 * (`firefoxDrag`).
 */
async function drag(session: BidiSession, from: ViewportPoint, to: () => Promise<ViewportPoint>, durationMs: number, signal: AbortSignal): Promise<void> {
  const context = session.requireContext();
  const documents = await session.documentContexts(context);
  if (session.browser.traits.cdp) await chromiumDrag(session.input, session.connection, context, documents, from, to, dragStepMs(durationMs), signal);
  else await firefoxDrag(session.input, session.connection, documents, from, to, dragStepMs(durationMs), signal);
}

/**
 * Moves the mouse to a viewport point and wheels there by a swipe of
 * `extent`'s size, in one call, then waits for the frame that renders it:
 * what the swipe scrolled is left hovered, as a person's swipe leaves it.
 */
async function wheel(
  session: BidiSession,
  at: ViewportPoint,
  extent: ViewportSize,
  direction: Parameters<typeof wheelDelta>[0],
  momentum: Parameters<typeof swipeDistance>[1],
  signal: AbortSignal,
): Promise<void> {
  const distance = swipeDistance(direction === 'up' || direction === 'down' ? extent.height : extent.width, momentum);
  const [deltaX, deltaY] = wheelDelta(direction, distance);
  const point = nearestPixel(at);
  await session.input.send(swipeSources(point.x, point.y, deltaX, deltaY), signal);
  await session.page.run(nextFrame, []);
}
