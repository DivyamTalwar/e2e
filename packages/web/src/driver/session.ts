/**
 * One attempt: its user context, its tabs and the one it shows, the
 * refs it minted, and the network, downloads, dialogs, and video scoped to
 * it, with the primitives every other module drives the page through.
 */

import { EngineError, withTimeout, type AppLogEntry, type EngineSnapshot, type ViewportPoint, type ViewportSize } from '@e2e-dev/core/engine';
import { DialogRouter } from './dialogs.ts';
import type { WebScreencastOptions } from '../options.ts';
import type { ProtectedApp } from '../protected-app.ts';
import { BidiInput } from './input.ts';
import { ArtifactPaths } from './artifact-paths.ts';
import type { ContextTree } from './context-tree.ts';
import { AttemptDownloads } from './downloads.ts';
import { BidiError, ErrorLatch, invalidState, releaseQuietly, unlessStale } from '../errors.ts';
import { FrameRegistry } from './frames.ts';
import type { BidiBrowser } from './launch.ts';
import { AttemptNetwork } from './network.ts';
import { OwnNavigations } from './own-navigations.ts';
import { PageCalls } from './page-calls.ts';
import { BidiRefs } from './refs.ts';
import { AttemptTabs, type AttemptTab } from './tabs.ts';
import { AttemptUserContext, type UserContextSettings } from './user-context.ts';
import { viewportSize } from '../in-page/document.ts';
import { BidiVideo } from './video.ts';
import { ProviderVideo } from './provider-video.ts';
import { DriverVideo, type AttemptVideo } from './attempt-video.ts';
import type { LeaseDownloads, LeaseRecording } from '../provider.ts';
import type { BidiConnection } from './connection.ts';
import type { PageArgument, PageValue } from './script.ts';

/** How long one step of closing an attempt may take before the next runs. */
const CLOSE_STEP_MS = 10_000;

/** What every attempt of a worker is configured with. */
export interface SessionSettings extends UserContextSettings {
  readonly viewport: ViewportSize | null;
  readonly screencast: WebScreencastOptions;
  readonly testIdAttribute: string;
  readonly site: string | undefined;
  readonly projectRoot: string;
  /** Whether the browser runs on another machine (a provider's lease), whose filesystem local paths do not reach. */
  readonly remoteFiles: boolean;
  /** The run's environment, which names the tools the driver spawns (ffmpeg). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** What one attempt starts with. */
export interface AttemptSettings {
  readonly artifactsDir: string;
  readonly appLog: (entry: AppLogEntry) => void;
  /** Tells the trace where the app went on its own. */
  readonly navigation: (line: string) => void;
  /** Hands the trace a screen read after an action; absent when the attempt keeps no trace. */
  readonly screen: ((snapshot: EngineSnapshot) => void) | undefined;
  /** The configured headers and the basic-auth credentials the attempt reaches a protected app with. */
  readonly protectedApp: ProtectedApp;
  /** The provider that serves downloads off a remote browser's disk; undefined for a local browser. */
  readonly remoteDownloads?: LeaseDownloads | undefined;
  /** Why no download can be read back, when the browser's source serves none (`BrowserSource.downloadLimit`). */
  readonly downloadLimit?: string | undefined;
  /** How the browser's provider records the attempt, in place of the driver's own recording (`BrowserSource.recorder`); undefined when it records none. */
  readonly recorder: ((signal: AbortSignal) => Promise<LeaseRecording>) | undefined;
}

/**
 * One attempt on a BiDi browser: its user context, its tabs and the one it
 * shows, and the refs, frames, network, downloads, dialogs, and video
 * scoped to it.
 */
export class BidiSession {
  /** The user context the attempt runs in, with what is scoped to it. */
  readonly userContext: AttemptUserContext;
  /** The attempt's open tabs, in the order they opened. */
  readonly tabs: AttemptTabs;
  /** The tab's keyboard and mouse, the only sender of input. */
  readonly input: BidiInput;
  /** The calls into the attempt's documents: page functions, and the readers each document keeps. */
  readonly page: PageCalls;
  /** The node refs the attempt minted, each with the element behind it. */
  readonly refs = new BidiRefs(() => this.input.dispatches);
  readonly frames = new FrameRegistry((frame) => this.page.reader('frameBox', [frame.element], frame.context));
  readonly latch = new ErrorLatch();
  readonly dialogs = new DialogRouter(this.latch);
  readonly network: AttemptNetwork;
  readonly downloads: AttemptDownloads;
  /** The attempt's recording: the provider's when it records the browser, else the driver's own. */
  readonly video: AttemptVideo;
  /** The navigations the driver itself has in flight in the tab. */
  readonly navigations = new OwnNavigations();
  /** The viewport `browser.setViewport` set for the rest of the attempt; the configured one until then. */
  private viewport: ViewportSize | null;
  /** The tab the attempt shows: the one its tabs publish (`TabHost.publish`), or its own once that opened. */
  private shown: string | undefined;
  private creating: Promise<string> | undefined;
  /** The tab the attempt found open and adopted (`existingTab`), which it never closes. */
  private adopted: string | undefined;
  private readonly ended = new AbortController();
  /** Where the attempt's screenshots and downloads are written. */
  readonly artifacts: ArtifactPaths;

  constructor(
    readonly browser: BidiBrowser,
    readonly settings: SessionSettings,
    readonly attempt: AttemptSettings,
    private readonly contexts: ContextTree,
  ) {
    this.artifacts = new ArtifactPaths(attempt.artifactsDir);
    this.page = new PageCalls(browser.connection, () => this.requireContext());
    this.viewport = settings.viewport;
    this.input = new BidiInput({ connection: browser.connection, traits: browser.traits, context: () => this.requireContext(), viewport: () => this.viewportSize() });
    this.network = new AttemptNetwork(browser.connection, {
      protectedApp: attempt.protectedApp,
      ours: (event) => this.owns(event.context),
      onPage: (context) => this.onPage(context),
      contexts,
      exclusive: browser.exclusive,
      traits: browser.traits,
      onFailure: (error) => this.latch.latch(error),
      onNavigationAbort: (context, url) => {
        if (context === this.context) this.navigations.aborted(url);
      },
      lifetime: this.lifetime,
    });
    this.downloads = new AttemptDownloads(browser.connection, attempt.remoteDownloads, attempt.downloadLimit);
    this.userContext = new AttemptUserContext({
      connection: browser.connection,
      traits: browser.traits,
      settings,
      protectedApp: attempt.protectedApp,
      downloads: this.downloads,
      ownTab: () => (this.context === this.adopted ? undefined : this.context),
    });
    this.video = attempt.recorder === undefined
      ? new DriverVideo(
          () => new BidiVideo(browser.connection, browser.traits, attempt.artifactsDir, settings.screencast, settings.env),
          { shown: () => this.context, viewport: () => this.viewportSize() },
        )
      : new ProviderVideo(attempt.recorder, attempt.artifactsDir, this.lifetime);
    this.tabs = new AttemptTabs({
      shown: () => this.context,
      prepare: async (context) => {
        if (this.viewport !== null) await this.connection.send('browsingContext.setViewport', { context, viewport: this.viewport });
        await this.connection.send('browsingContext.activate', { context });
      },
      publish: (context) => {
        this.retireContext();
        this.shown = context;
      },
      record: async (context, closed) => {
        if (closed) await this.video.contextClosed();
        if (context !== undefined) await this.video.contextOpened(context);
      },
      close: async (context) => {
        await this.connection.send('browsingContext.close', { context });
      },
    });
  }

  /** Aborts when the attempt closes, ending work it started that nothing awaits any more. */
  get lifetime(): AbortSignal {
    return this.ended.signal;
  }

  /** The browser's BiDi connection. */
  get connection(): BidiConnection {
    return this.browser.connection;
  }

  /** The tab the attempt shows, which every read and action is on. */
  get context(): string | undefined {
    return this.shown;
  }

  /** Whether `context` belongs to this attempt's user context. */
  owns(context: string | null | undefined): boolean {
    return context != null && this.contexts.owner(context) === this.userContext.id;
  }

  /** Whether `context` is the attempt's tab or a frame in it: what a page-scoped wait listens to, not a tab the app opened. */
  onPage(context: string | null | undefined): boolean {
    return context != null && this.context !== undefined && this.contexts.top(context) === this.context;
  }

  /**
   * Sets up the attempt's first user context, binds the network to it, and,
   * when the attempt adopts the open tab, reads that tab before anything
   * navigates. `signal` aborting, or `close`, before it lands removes it.
   */
  async openUserContext(signal: AbortSignal): Promise<void> {
    await this.userContext.open(signal);
    await this.network.bind(this.userContext.id);
    if (this.settings.userContext === 'adopt-tab') await this.ensureContext();
  }

  /**
   * Replaces the user context with a clean one, the test's routes and added
   * init scripts carried over (`AttemptUserContext.replace`). Once the new
   * one is in use, the tabs of the old one are forgotten, its recording
   * ends, and the network binds to the new one, before the old one is
   * removed. One whose `signal` aborted, or that a later replacement or
   * `close` overtook, leaves all of that as it was.
   */
  async replaceUserContext(signal: AbortSignal): Promise<void> {
    await this.userContext.replace(signal, async () => {
      this.tabs.clear();
      this.retireContext();
      await this.video.contextClosing();
      await this.network.bind(this.userContext.id);
    });
  }

  /** Ends the recording of the attempt's tab, forgets its tabs, and removes its user context with its preload scripts. */
  private async closeUserContext(): Promise<void> {
    await this.video.contextClosing();
    this.tabs.clear();
    try {
      await this.userContext.close();
    } finally {
      this.retireContext();
    }
  }

  /** The attempt's tab; `INVALID_STATE` before the first open. */
  requireContext(): string {
    if (this.context === undefined) throw invalidState('no app page is open; call app.open() or browser.goto() first');
    return this.context;
  }

  /**
   * The attempt's tab, created on first use at the attempt's viewport, with
   * the network covering it and a video segment started when recording.
   * Concurrent first uses share one creation.
   */
  ensureContext(): Promise<string> {
    if (this.context !== undefined) return Promise.resolve(this.context);
    this.creating ??= this.createContext().finally(() => {
      this.creating = undefined;
    });
    return this.creating;
  }

  /**
   * Opens the attempt's tab in its user context, or adopts the one already
   * open there when the settings ask for it, at the attempt's viewport.
   */
  private async createContext(): Promise<string> {
    const userContext = this.userContext.id;
    if (userContext === '') throw invalidState('the attempt has no user context to open a tab in');
    this.adopted = this.settings.userContext === 'adopt-tab' ? await this.existingTab(userContext) : undefined;
    const context = await this.openTab(userContext, this.adopted);
    if (this.viewport !== null) await this.connection.send('browsingContext.setViewport', { context, viewport: this.viewport });
    this.shown = context;
    this.tabs.own(context, true);
    this.input.reset();
    await this.video.contextOpened(context);
    return context;
  }

  /**
   * A tab in `userContext` that the network covers: `adopted`, the tab the
   * attempt found open there, else a new one. One that opened after the
   * attempt replaced its user context is closed again, unless adopted, and
   * refused.
   */
  private async openTab(userContext: string, adopted: string | undefined): Promise<string> {
    const connection = this.connection;
    const context = adopted ?? (await connection.send('browsingContext.create', { type: this.browser.traits.newContext, userContext })).context;
    if (userContext !== this.userContext.id) {
      if (context !== adopted) await releaseQuietly(connection.send('browsingContext.close', { context }));
      throw new EngineError('NODE_STALE', 'the attempt replaced its user context while a tab opened', { retryable: true });
    }
    await this.network.addContext(context);
    return context;
  }

  /**
   * Opens a blank tab in the attempt's user context, sharing its cookies
   * and storage, and shows it (`browser.newTab`); before the attempt has a
   * tab, that is its own.
   */
  async newTab(): Promise<AttemptTab> {
    if (this.context === undefined) {
      const own = await this.ensureContext();
      return this.tabs.find(own) ?? this.tabs.own(own, true);
    }
    const tab = this.tabs.own(await this.openTab(this.userContext.id, undefined), false);
    try {
      await this.tabs.show(tab);
    } catch (cause) {
      await releaseQuietly(this.tabs.close(tab));
      throw cause;
    }
    return tab;
  }

  /**
   * A top-level browsing context of the attempt closed: a tab leaves the
   * tabs, and when it was the shown one the tab shown next takes its place
   * (`AttemptTabs.destroyed`). A shown context that was no tab is forgotten,
   * so the next use opens a fresh one.
   */
  contextClosed(context: string): void {
    if (!this.tabs.destroyed(context) && context === this.context) this.retireContext();
  }

  /**
   * Runs a read of the shown tab. A tab that closes under the read makes it
   * stale, as a navigation does: nothing was dispatched, and the read
   * repeats on the tab shown next. `read` is told the tab it reads.
   */
  async readTab<T>(read: (tab: AttemptTab | undefined) => Promise<T>): Promise<T> {
    const tab = this.tabs.active();
    try {
      return await read(tab);
    } catch (cause) {
      if (tab !== undefined && (await this.tabGone(tab).catch(() => false))) {
        throw new EngineError('NODE_STALE', 'the tab closed while it was read', { retryable: true, cause });
      }
      throw cause;
    }
  }

  /** Whether `tab` has closed, asking the browser when no event has told it yet. */
  async tabGone(tab: AttemptTab): Promise<boolean> {
    if (tab.closed) return true;
    try {
      await this.connection.send('browsingContext.getTree', { root: tab.context, maxDepth: 0 });
      return false;
    } catch (cause) {
      if (cause instanceof BidiError && cause.error === 'no such frame') return true;
      throw cause;
    }
  }

  /** The first top-level tab already open in `userContext`, if any. */
  private async existingTab(userContext: string): Promise<string | undefined> {
    const { contexts } = await this.connection.send('browsingContext.getTree', { maxDepth: 0 });
    return contexts.find((info) => info.userContext === userContext)?.context;
  }

  /** Resizes the shown tab, and every tab shown after it, to `size`. */
  async setViewport(size: ViewportSize): Promise<void> {
    this.viewport = { width: size.width, height: size.height };
    // Before the first page the size is only kept: the tab opens at it, and no page opens early.
    if (this.context === undefined) return;
    await this.connection.send('browsingContext.setViewport', { context: this.context, viewport: this.viewport });
  }

  /**
   * Closes the tab and every tab the app opened, keeping the user context's
   * storage, as a restart closes every page. Nothing more is closed once
   * `signal` aborted.
   */
  async closeContext(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.video.contextClosing();
    this.tabs.clear();
    this.retireContext();
    const { contexts } = await this.connection.send('browsingContext.getTree', { maxDepth: 0 });
    signal.throwIfAborted();
    const tabs = contexts.filter((info) => info.userContext === this.userContext.id).map((info) => info.context);
    await Promise.all(tabs.map(async (context) => {
      await this.network.removeContext(context);
      await unlessStale(this.connection.send('browsingContext.close', { context }), undefined);
    }));
  }

  /** Calls a page function the test compiled (`compileEvaluation`) with `arg` and returns its whole result; the test's code may change the page, as input would. */
  evaluate(declaration: string, arg: PageArgument | undefined): Promise<PageValue> {
    this.mutated();
    return this.page.call(declaration, arg === undefined ? [] : [arg], { awaitPromise: true, maxObjectDepth: null });
  }

  /**
   * Forgets the shown tab, which closed, is closing, or is no longer shown:
   * its refs, frames, and input state, so the next use opens a fresh one
   * unless another tab is shown.
   */
  private retireContext(): void {
    this.shown = undefined;
    this.refs.clear();
    this.frames.clear();
    this.input.reset();
  }

  /** Input sends and page mutations so far (`BidiInput.dispatches`). */
  get dispatches(): number {
    return this.input.dispatches;
  }

  /** Where the mouse last moved in the tab. */
  get pointer(): ViewportPoint {
    return this.input.pointer;
  }

  /** Counts a change the driver or the test's code made in the page (a fill, a select, an evaluate), which may have reached the app. */
  mutated(): void {
    this.input.mutated();
  }

  /** The viewport in CSS pixels: the attempt's, else the window's. */
  async viewportSize(): Promise<ViewportSize> {
    if (this.viewport !== null) return this.viewport;
    return this.page.run(viewportSize, []);
  }

  /** The URL of `context` (the shown tab by default), as the browser reports it. */
  async currentUrl(context = this.requireContext()): Promise<string> {
    const { contexts } = await this.connection.send('browsingContext.getTree', { root: context, maxDepth: 0 });
    return contexts[0]?.url ?? '';
  }

  /** `context` and every frame document under it. */
  async documentContexts(context: string): Promise<string[]> {
    const { contexts } = await this.connection.send('browsingContext.getTree', { root: context });
    const out: string[] = [];
    const walk = (info: (typeof contexts)[number]): void => {
      out.push(info.context);
      for (const child of info.children ?? []) walk(child);
    };
    for (const info of contexts) walk(info);
    return out;
  }

  /**
   * Ends the attempt: its video, user context, network, and download
   * directory, each attempted whatever the others did; the first failure is
   * reported once all ran, each remote step bounded so a hung one never keeps
   * the rest from running. A browser already gone leaves only local work. A
   * replacement user context still opening removes itself when it lands.
   */
  async close(): Promise<void> {
    this.userContext.overtake();
    this.ended.abort();
    const gone = this.connection.isClosed;
    const step = (label: string, work: () => unknown): (() => Promise<unknown>) => () =>
      withTimeout(Promise.resolve().then(work), CLOSE_STEP_MS, () => new EngineError('OPERATION_TIMEOUT', `${label} did not finish within ${CLOSE_STEP_MS}ms`, { retryable: false }));
    const results = await settleEach([
      step(this.video.closeStep, () => this.video.close(CLOSE_STEP_MS)),
      step('user context removal', () => (gone ? undefined : this.closeUserContext())),
      step('earlier user contexts', () => (gone ? undefined : this.userContext.removeOwed())),
      step('network release', () => this.network.dispose()),
      () => this.downloads.dispose(),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }
}

/** Runs each step in order whatever the earlier ones did, and settles with every outcome. */
async function settleEach(steps: readonly (() => unknown)[]): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];
  for (const step of steps) {
    try {
      results.push({ status: 'fulfilled', value: await step() });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  return results;
}
