/**
 * The attempt's user context: the one in use, set up with everything scoped
 * to it (preload scripts, downloads, emulation, media), replaced by a clean
 * one or removed, the ones still owed removal, and what the attempt leaves
 * in the one in use: the init scripts a test added, the origins its
 * documents were at, and the permissions granted to them.
 */

import type { Emulation } from 'webdriver-bidi-protocol';
import { EngineError, obj } from '@e2e-dev/core/engine';
import type { BrowserTraits } from '../browsers.ts';
import { BidiError, cancelled, releaseQuietly } from '../errors.ts';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../in-page/closed-shadow.ts';
import { HIT_INTERCEPTOR_INIT_SCRIPT } from '../in-page/hit-interceptor.ts';
import { MODAL_ORDER_INIT_SCRIPT } from '../in-page/modal-dialogs.ts';
import { BUILTINS_INIT_SCRIPT, READERS_INIT_SCRIPT } from '../in-page/readers.ts';
import type { ConfiguredInitScripts } from '../init-scripts.ts';
import type { WebMedia } from '../options.ts';
import type { ProtectedApp } from '../protected-app.ts';
import type { BidiConnection } from './connection.ts';
import type { AttemptDownloads } from './downloads.ts';

/**
 * Refuses service worker registration, as Playwright's `serviceWorkers:
 * 'block'` does when headers are configured: a worker's requests bypass
 * request interception, so they would leave without the headers.
 */
const BLOCK_SERVICE_WORKERS = "if (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by e2e'); };";

/**
 * Which user context an attempt runs in: a fresh one it creates and
 * removes, the browser's default one (which a per-attempt lease's `prepare`
 * may have signed in), or the default one on the tab already open there,
 * which the attempt adopts and leaves open (`attachBrowser`).
 */
export type UserContextMode = 'fresh' | 'default' | 'adopt-tab';

/** The browser's own user context, which a lease's `prepare` signed in and which outlives every attempt. */
const DEFAULT_USER_CONTEXT = 'default';

/** The part of a worker's settings each user context of an attempt is set up with. */
export interface UserContextSettings {
  /** The user context an attempt runs in (`BrowserSource.userContext`). */
  readonly userContext: UserContextMode;
  readonly initScripts: ConfiguredInitScripts;
  readonly userAgent: string | undefined;
  readonly locale: string | undefined;
  readonly timezoneId: string | undefined;
  readonly media: WebMedia;
  readonly permissions: readonly string[];
}

/** What the attempt's user contexts are set up through and with. */
export interface UserContextHost {
  readonly connection: BidiConnection;
  readonly traits: BrowserTraits;
  readonly settings: UserContextSettings;
  /** The attempt's configured headers, which a service worker's requests would leave without. */
  readonly protectedApp: ProtectedApp;
  /** The attempt's downloads, whose directory each user context saves into. */
  readonly downloads: AttemptDownloads;
  /** Aborts when the attempt closes: no user context is set up after that, and one still being set up removes itself when it lands. */
  readonly lifetime: AbortSignal;
}

/** A user context the attempt set up, with the preload scripts scoped to it. */
interface ScopedUserContext {
  readonly userContext: string;
  readonly preloads: readonly string[];
}

/** The user context one attempt runs in, through every replacement, until the attempt's close removes it. */
export class AttemptUserContext {
  /** The web origins the attempt's documents have been at, whose storage a saved session keeps. */
  readonly visited = new Set<string>();
  private current = '';
  private preloads: string[] = [];
  /** User contexts this attempt created and has not yet seen removed, tried again by every later removal and by the attempt's close. */
  private readonly unremoved = new Set<string>();
  /**
   * Bumped by every user context the attempt starts to set up: one that
   * lands for an earlier generation (a reset a later one superseded)
   * removes itself instead of replacing the one in use.
   */
  private generation = 0;
  private readonly addedScripts: string[] = [];
  private readonly granted = new Map<string, Promise<void>>();
  /** The media features in effect: the configured ones, updated by `emulateMedia`. */
  private media: WebMedia;

  constructor(private readonly host: UserContextHost) {
    this.media = host.settings.media;
  }

  /** The user context in use; empty before the first is set up and once the attempt removed it. */
  get id(): string {
    return this.current;
  }

  /** Sets up the attempt's first user context. `signal` aborting, or the attempt closing, before it lands removes it. */
  async open(signal: AbortSignal): Promise<void> {
    await this.install(signal);
  }

  /**
   * Replaces the user context with a clean one, the added init scripts
   * carried over. The new one is set up in full before it takes the old
   * one's place in one step; `moved` then runs, for what the attempt keeps
   * per user context (its tabs, recording, and network), and only then is
   * the old one removed, so no step ever runs between the two. A `moved`
   * that fails still has the old one removed, and its own failure is the
   * one thrown. One whose `signal` aborted, or that a later replacement or
   * the attempt's close overtook, removes itself and leaves the user
   * context in use as it was.
   */
  async replace(signal: AbortSignal, moved: () => Promise<void>): Promise<void> {
    const previous = await this.install(signal);
    try {
      await moved();
    } catch (cause) {
      await releaseQuietly(this.drop(previous));
      throw cause;
    }
    await this.drop(previous);
  }

  /** Forgets the user context in use and removes it with its preload scripts. */
  async close(): Promise<void> {
    const current = { userContext: this.current, preloads: this.preloads };
    this.current = '';
    this.preloads = [];
    await this.drop(current);
  }

  /** Removes every user context still owed removal; one that fails stays owed, and the first failure is thrown. */
  async removeOwed(): Promise<void> {
    const { connection } = this.host;
    const pending = [...this.unremoved];
    const results = await Promise.allSettled(pending.map((userContext) => connection.send('browser.removeUserContext', { userContext })));
    pending.forEach((userContext, index) => {
      const result = results[index]!;
      if (result.status === 'fulfilled' || (result.reason instanceof BidiError && result.reason.error === 'no such user context')) this.unremoved.delete(userContext);
    });
    const failed = results.find((result, index) => result.status === 'rejected' && this.unremoved.has(pending[index]!));
    if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
  }

  /**
   * Changes the attempt's media features from the next paint on
   * (`browser.emulateMedia`). A browser that does not emulate reduced motion
   * (Firefox overrides only `prefers-color-scheme` over BiDi) refuses a
   * reduced-motion change; `web({ reducedMotion })` still applies at launch.
   */
  async emulateMedia(media: WebMedia): Promise<void> {
    if (!this.host.traits.emulatesReducedMotion && media.reducedMotion !== undefined) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', 'browser.emulateMedia({ reducedMotion }) is not supported on Firefox, which overrides only prefers-color-scheme over WebDriver BiDi; set web({ reducedMotion }) instead', { retryable: false });
    }
    this.media = { ...this.media, ...media };
    await this.applyMedia(this.current);
  }

  /** Adds an init script for every document of this user context from now on, and of every one that replaces it. */
  async addInitScript(source: string): Promise<void> {
    const { script } = await this.host.connection.send('script.addPreloadScript', {
      functionDeclaration: wrapAppScript(source),
      userContexts: [this.current],
    });
    this.addedScripts.push(source);
    this.preloads.push(script);
  }

  /**
   * Records a document of the attempt starting to load `url`: its origin is
   * remembered for a saved session, and granted the configured permissions,
   * once per origin and user context (BiDi grants per origin). Concurrent
   * calls for one origin share its grant.
   */
  visit(url: string): Promise<void> {
    if (!URL.canParse(url)) return Promise.resolve();
    const { origin, protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return Promise.resolve();
    this.visited.add(origin);
    const { connection, settings } = this.host;
    if (settings.permissions.length === 0) return Promise.resolve();
    let grant = this.granted.get(origin);
    if (grant === undefined) {
      const userContext = this.current;
      grant = Promise.all(settings.permissions.map((name) =>
        connection.send('permissions.setPermission', { descriptor: { name }, state: 'granted', origin, userContext }))).then(() => undefined);
      this.granted.set(origin, grant);
    }
    return grant;
  }

  /**
   * Creates a user context (the browser's own one when the settings ask for
   * it) and applies everything scoped to it: the preloaded scripts,
   * downloads, the emulated user agent, locale (and the `accept-language`
   * Playwright's locale sends), time zone, and media. Every step settles
   * before a failure is thrown, and a failed or overtaken setup removes what
   * it made. None is created once the attempt closed. Once set up, it is
   * published in place of the attempt's user context, whose scope is
   * returned.
   */
  private async install(signal: AbortSignal): Promise<ScopedUserContext> {
    const generation = ++this.generation;
    const { connection, settings, lifetime } = this.host;
    signal.throwIfAborted();
    if (lifetime.aborted) throw cancelled('the attempt closed before its user context opened');
    const { userContext } = settings.userContext === 'fresh' ? await connection.send('browser.createUserContext', {}) : { userContext: DEFAULT_USER_CONTEXT };
    const preloads: string[] = [];
    const overtaken = (): boolean => signal.aborted || lifetime.aborted || generation !== this.generation;
    try {
      if (overtaken()) throw cancelled('the attempt closed or gave up while its user context opened');
      const scoped = { userContexts: [userContext] as [string] };
      const sources = [
        wrapScript(BUILTINS_INIT_SCRIPT),
        wrapScript(READERS_INIT_SCRIPT),
        wrapScript(CLOSED_SHADOW_ROOTS_INIT_SCRIPT),
        wrapScript(MODAL_ORDER_INIT_SCRIPT),
        wrapScript(HIT_INTERCEPTOR_INIT_SCRIPT),
        ...(this.host.protectedApp.sendsHeaders ? [wrapScript(BLOCK_SERVICE_WORKERS)] : []),
        ...[...settings.initScripts.forAttempt(), ...this.addedScripts].map(wrapAppScript),
      ];
      const { userAgent, locale, timezoneId } = settings;
      const steps = await Promise.allSettled([
        ...sources.map(async (source) => {
          preloads.push((await connection.send('script.addPreloadScript', { functionDeclaration: source, ...scoped })).script);
        }),
        this.host.downloads.allow(userContext),
        userAgent === undefined ? undefined : connection.send('emulation.setUserAgentOverride', { userAgent, ...scoped }),
        locale === undefined ? undefined : connection.send('emulation.setLocaleOverride', { locale, ...scoped }),
        locale === undefined ? undefined : connection.send('network.setExtraHeaders', { headers: [{ name: 'accept-language', value: { type: 'string', value: locale } }], ...scoped }),
        timezoneId === undefined ? undefined : connection.send('emulation.setTimezoneOverride', { timezone: timezoneId, ...scoped }),
        this.applyMedia(userContext),
      ]);
      const failed = steps.find((step) => step.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
      if (overtaken()) throw cancelled('the attempt closed or gave up while its user context opened');
    } catch (cause) {
      await releaseQuietly(this.drop({ userContext, preloads }));
      throw cause;
    }
    const previous = { userContext: this.current, preloads: this.preloads };
    this.current = userContext;
    this.preloads = preloads;
    this.granted.clear();
    this.visited.clear();
    return previous;
  }

  /**
   * Removes a user context the attempt no longer uses, which closes its
   * tabs, then its preload scripts: removing a script from a live tab races
   * the tab's close inside the Chromium mapper. The browser's own user
   * context stays, with its tabs: the session closes the ones the attempt
   * opened there before it drops the scripts.
   */
  private async drop(dropped: ScopedUserContext): Promise<void> {
    const { connection } = this.host;
    if (dropped.userContext !== DEFAULT_USER_CONTEXT && dropped.userContext !== '') this.unremoved.add(dropped.userContext);
    try {
      await this.removeOwed();
    } finally {
      await Promise.all(dropped.preloads.map((script) => releaseQuietly(connection.send('script.removePreloadScript', { script }))));
    }
  }

  /**
   * Applies the media features to `userContext`
   * (`emulation.setMediaFeaturesOverride`); a browser that does not emulate
   * reduced motion takes it as a launch preference.
   */
  private async applyMedia(userContext: string): Promise<void> {
    if (this.media.colorScheme === undefined && this.media.reducedMotion === undefined) return;
    const features: Emulation.MediaFeatures = obj({
      'prefers-color-scheme': this.media.colorScheme === 'no-preference' ? null : this.media.colorScheme,
      'prefers-reduced-motion': this.host.traits.emulatesReducedMotion ? this.media.reducedMotion : undefined,
    });
    await this.host.connection.send('emulation.setMediaFeaturesOverride', { features, userContexts: [userContext] });
  }
}

/** The query parameter that marks a scratch document a saved-state read or write opens, which the app's init scripts skip. */
export const SCRATCH_PARAM = '__e2e_state_scratch';

/** A driver script's source as a preload script's function declaration. */
function wrapScript(source: string): string {
  return `() => {\n${source}\n}`;
}

/** An app init script's source as a preload script's function declaration: it runs in every document but a saved-state scratch one, which it must not change. */
function wrapAppScript(source: string): string {
  return `() => {\nif (new URLSearchParams(location.search).has(${JSON.stringify(SCRATCH_PARAM)})) return;\n${source}\n}`;
}
