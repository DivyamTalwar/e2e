/**
 * The attempt's video as the session and the engine's `artifacts` drive it,
 * whoever records it: the driver, one segment per tab the attempt shows
 * (`DriverVideo`), or the browser's provider, one recording of the browser
 * (`ProviderVideo`). An attempt has exactly one, chosen when it starts.
 */

import type { VideoSegment, ViewportSize } from '@e2e-dev/core/engine';
import { releaseQuietly } from '../errors.ts';
import { DEFAULT_VIEWPORT } from '../options.ts';
import type { BidiVideo } from './video.ts';

/** The attempt's video, whoever records it. */
export interface AttemptVideo {
  /** What the attempt's close calls ending the recording, in the error of an end that hangs. */
  readonly closeStep: string;
  /** Starts recording. A start that finishes after `signal` aborted is stopped again, so no recording outlives the step that gave up on it. */
  start(signal: AbortSignal): Promise<void>;
  /** Finishes the recording and returns its segments. */
  stop(signal: AbortSignal): Promise<readonly VideoSegment[]>;
  /** The attempt shows `context`: a tab it opened, or the one it returned to. */
  contextOpened(context: string): Promise<void>;
  /** The shown tab is about to close. */
  contextClosing(): Promise<void>;
  /** The shown tab closed on its own. */
  contextClosed(): Promise<void>;
  /** Ends a recording the attempt's close found running; an end that leaves this machine gets `budgetMs`. */
  close(budgetMs: number): Promise<void>;
}

/** The tab the driver records, as the session shows it. */
export interface RecordedTab {
  /** The tab shown now, if any. */
  shown(): string | undefined;
  /** The shown tab's viewport in CSS pixels, which a segment of it is sized to. */
  viewport(): Promise<ViewportSize>;
}

/**
 * The driver's own recording of the attempt. Its recorder is made by the
 * first `start`: until a recording is asked for, nothing is recorded and no
 * tab is sized for a segment.
 */
export class DriverVideo implements AttemptVideo {
  readonly closeStep = 'video stop';
  private recorder: BidiVideo | undefined;

  /** `record` makes the attempt's recorder; `tab` reads the tab a segment starts on. */
  constructor(
    private readonly record: () => BidiVideo,
    private readonly tab: RecordedTab,
  ) {}

  /**
   * Records the shown tab now and every tab the attempt shows until it
   * stops. With no tab shown it only arms, and the size it arms with is not
   * used: the first tab shown starts the first segment at its own viewport.
   * The attempt's close stops a start that outlives it.
   */
  async start(signal: AbortSignal): Promise<void> {
    this.recorder ??= this.record();
    const viewport = this.tab.shown() === undefined ? DEFAULT_VIEWPORT : await this.tab.viewport();
    await this.recorder.arm(this.tab.shown(), viewport);
    if (signal.aborted) {
      await releaseQuietly(this.recorder.stop());
      signal.throwIfAborted();
    }
  }

  /** Ends the recording and returns every segment written, in order; none before the first start. */
  async stop(): Promise<readonly VideoSegment[]> {
    return (await this.recorder?.stop()) ?? [];
  }

  /** The next segment, on `context` at the viewport read for it. */
  async contextOpened(context: string): Promise<void> {
    await this.recorder?.contextOpened(context, await this.tab.viewport());
  }

  /** The recorded tab's segment ends while the tab can still flush it. */
  async contextClosing(): Promise<void> {
    await this.recorder?.contextClosing();
  }

  /** The recorded tab's segment ends with what it wrote. */
  async contextClosed(): Promise<void> {
    await this.recorder?.contextClosed();
  }

  /** Stops the recording with the attempt; a segment it lost is reported, as `stop` reports it. */
  async close(): Promise<void> {
    await this.recorder?.stop();
  }
}
