/**
 * The runner's side of its reporters: who gets each event, who shows the run
 * to a person, what the runner prints when nobody does, and how the
 * reporters finish once the report is written.
 */

import path from 'node:path';
import { leaveWorkBehind } from '@e2e-dev/core/lib/internal/abandoned';
import { errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { budgetText, withAbort } from '@e2e-dev/core/lib/internal/time';
import { pausedLine } from '../report/list-steps.ts';
import { writeTextReport } from '../report/write.ts';
import type { FinishedRun, ReportFile, Reporter, ReporterSummary } from '../run-types.ts';
import type { RunEvent, RunEventOf, RunEventSubscriber } from './events.ts';
import { uncaptured, writeTerminal, type RunnerOutput } from './process-output.ts';

/** Why a reporter's `onRunFinished` was given up on: the message is the stderr line. */
class ReporterAbandoned extends Error {}

/** What the host needs of the run beside its reporters. */
interface HostOptions {
  /** The process's user output; undefined in a run that claims none. */
  readonly processOutput: RunnerOutput | undefined;
  /** An embedded run: the runner prints no test's output itself. */
  readonly quiet: boolean;
  /** Masks the config's fixed secret values in a line the runner prints. */
  readonly redact: (text: string) => string;
}

/** A run's reporters as the runner drives them. */
export interface ReporterHost {
  /** The run's event sinks: each reporter's `onEvent`, then the runner's own printing for when no reporter shows the run. */
  readonly sinks: readonly RunEventSubscriber[];
  /** Whether an interactive reporter shows the run, so the runner prints no output, run error, or pause itself; false once its `onEvent` broke. */
  showsRun(): boolean;
  /** Calls a hook of `reporter`, past the capture of user output when it is interactive, so what it prints is what the terminal shows. */
  call<T>(reporter: Reporter, hook: () => T): T;
  /** Prints a line of the runner's own about a reporter, redacted like any other. */
  warn(line: string): void;
  /** Hands the run's summary rows to every reporter's `onSummary`, past the capture of user output: it is where a reporter prints. */
  summary(rows: ReporterSummary, finished: FinishedRun): void;
}

/**
 * Hosts `reporters` for one run. Every reporter with `onEvent` gets every
 * event, but only an interactive one stands in for the runner's own
 * printing: a reporter that only records never silences it, and once an
 * interactive reporter's `onEvent` throws or rejects, the runner prints
 * what it showed.
 *
 * What a sink prints while it is handed output, now or after an `await`,
 * goes to the terminal as written, never back to the sinks, so one that logs
 * what it is handed cannot feed itself.
 */
export function hostReporters(reporters: readonly Reporter[], options: HostOptions): ReporterHost {
  const { processOutput } = options;
  const call = <T,>(reporter: Reporter, hook: () => T): T => (reporter.interactive === true ? uncaptured(hook) : hook());
  const showing = new Set(reporters.filter((reporter) => reporter.interactive === true && reporter.onEvent !== undefined));
  const showsRun = (): boolean => showing.size > 0;
  // The runner's own line, outside any reporter's output context, so it is redacted like any other.
  const warn = (line: string): void => {
    const write = (): unknown => process.stderr.write(line);
    if (processOutput === undefined) write();
    else processOutput.captured(write);
  };
  const plain = plainView(showsRun, options);
  const sinks: RunEventSubscriber[] = reporters.flatMap((reporter) => {
    const { onEvent } = reporter;
    if (onEvent === undefined) return [];
    const hand = (event: RunEvent): void => call(reporter, () => onEvent.call(reporter, event));
    return [
      {
        name: reporter.name,
        onEvent: (event) => (event.type === 'output' && processOutput !== undefined ? processOutput.passThrough(() => hand(event)) : hand(event)),
        onQuarantine: () => {
          // The runner shows the pause the last interactive reporter was showing.
          if (showing.delete(reporter) && !showsRun()) plain.reshow();
        },
      },
    ];
  });
  const brokenSummary = new Set<Reporter>();
  return {
    sinks: [...sinks, { name: 'runner', onEvent: plain.onEvent }],
    showsRun,
    call,
    warn,
    summary(rows, finished) {
      for (const reporter of reporters) {
        if (reporter.onSummary === undefined || brokenSummary.has(reporter)) continue;
        const quarantine = (cause: unknown): void => {
          if (brokenSummary.has(reporter)) return;
          brokenSummary.add(reporter);
          warn(`e2e: reporter "${reporter.name}" threw in onSummary: ${errorMessage(cause)}; ignoring it for the rest of the run\n`);
        };
        try {
          // An async hook is never awaited, but its rejection is caught; a
          // thenable is adopted inside the hook's own output context.
          const result = uncaptured(() => {
            const value: unknown = reporter.onSummary?.(rows, finished);
            return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function' ? Promise.resolve(value) : undefined;
          });
          result?.catch(quarantine);
        } catch (cause) {
          quarantine(cause);
        }
      }
    },
  };
}

/**
 * What the runner prints itself while no interactive reporter shows the
 * run, always on stderr: what user code prints, a test's unless the run is
 * quiet, and a test waiting for a key as one line. A wait no keyboard
 * answers is printed by the commands that do.
 */
function plainView(showsRun: () => boolean, { processOutput, quiet, redact }: HostOptions): { onEvent(event: RunEvent): void; reshow(): void } {
  let waiting: RunEventOf<'paused'> | undefined;
  let printed: string | undefined;
  const showPause = (): void => {
    if (showsRun()) return;
    // Printed once per prompt and again when its keys change, as after `h`.
    const line = waiting === undefined || waiting.keys.length === 0 ? undefined : pausedLine(waiting);
    // Straight to the terminal, redacted here, so nothing holds it back while the run waits.
    if (line !== undefined && line !== printed) writeTerminal('stderr', `${redact(line)}\n`);
    printed = line;
  };
  return {
    onEvent(event) {
      switch (event.type) {
        case 'output':
          if (!showsRun() && (event.target === undefined || !quiet)) processOutput?.print(event.stream, event.text);
          break;
        case 'paused':
          waiting = event;
          showPause();
          break;
        case 'resumed':
          waiting = undefined;
          showPause();
          break;
        default:
      }
    },
    reshow: showPause,
  };
}

/** What a reporter's `reportFiles` has left once the run is forced to stop. */
const FORCED_REPORT_FILES_MS = 5_000;

/** How `finishReporters` treats the reporters it finishes. */
interface FinishOptions {
  /** Budget for each reporter's `reportFiles` and `onRunFinished`. */
  readonly timeoutMs: number;
  /** Aborts when the run is forced to stop. */
  readonly force: AbortSignal;
  readonly host: ReporterHost;
}

/**
 * Finishes every reporter: first the files each one's `reportFiles`
 * renders, which the runner writes, then every `onRunFinished` at once,
 * then every `onSummary` with the rows they all came back with. Each call
 * has `timeoutMs` and a signal that aborts on it; a forced stop also aborts
 * `onRunFinished`, except an interactive reporter's, whose output is local,
 * and leaves `reportFiles` a few seconds more, so the previous run's file
 * rarely stays beside this run's `report.json` and the stop never hangs on
 * one. A reporter given up on is work left
 * behind, which the CLI does not wait for. A reporter that throws, runs out
 * of time, or returns something other than files or rows is one line on
 * stderr; it can never change the run's outcome.
 */
export async function finishReporters(reporters: readonly Reporter[], finished: FinishedRun, options: FinishOptions): Promise<void> {
  const { timeoutMs, force, host } = options;
  const warn = (reporter: Reporter, detail: string): void => {
    process.stderr.write(`e2e: reporter "${reporter.name}" ${detail}\n`);
  };
  const budget = budgetText(timeoutMs);
  const forced = 'abandoned: the run was forced to stop';

  /**
   * Awaits `call` within the budget; undefined when it failed, a stderr line
   * said why. A forced stop leaves it `forcedGraceMs` more, none at all for
   * 0, and does not cut it short when undefined.
   */
  const bounded = async <T,>(reporter: Reporter, forcedGraceMs: number | undefined, call: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    if (forcedGraceMs === 0 && force.aborted) {
      warn(reporter, forced);
      return undefined;
    }
    const abandon = new AbortController();
    const timer = setTimeout(() => abandon.abort(new ReporterAbandoned(`did not finish within ${budget}`)), timeoutMs);
    let forcedTimer: NodeJS.Timeout | undefined;
    const onForce = (): void => {
      forcedTimer = setTimeout(() => abandon.abort(new ReporterAbandoned(forced)), forcedGraceMs);
    };
    if (forcedGraceMs !== undefined) {
      if (force.aborted) onForce();
      else force.addEventListener('abort', onForce, { once: true });
    }
    try {
      return await withAbort(() => call(abandon.signal), abandon.signal, () => abandon.signal.reason as ReporterAbandoned);
    } catch (cause) {
      if (cause instanceof ReporterAbandoned) leaveWorkBehind();
      warn(reporter, cause instanceof ReporterAbandoned ? cause.message : `failed: ${errorMessage(cause)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
      clearTimeout(forcedTimer);
      force.removeEventListener('abort', onForce);
    }
  };

  const fileRows = await Promise.all(
    reporters.map(async (reporter): Promise<ReporterSummary> => {
      const { reportFiles } = reporter;
      if (reportFiles === undefined) return [];
      const files = await bounded(reporter, FORCED_REPORT_FILES_MS, async (signal) => host.call(reporter, () => reportFiles.call(reporter, finished, signal)));
      if (files === undefined) return [];
      if (!Array.isArray(files) || !files.every(isReportFile)) {
        warn(reporter, 'returned something other than report files; wrote none');
        return [];
      }
      return writeReportFiles(reporter, files, finished, warn);
    }),
  );

  const finishedRows = await Promise.all(
    reporters.map(async (reporter): Promise<ReporterSummary> => {
      const { onRunFinished } = reporter;
      if (onRunFinished === undefined) return [];
      const result: unknown = await bounded(reporter, reporter.interactive === true ? undefined : 0, (signal) => Promise.resolve(host.call(reporter, () => onRunFinished.call(reporter, finished, signal))));
      if (result === undefined) return [];
      if (!Array.isArray(result)) {
        warn(reporter, 'returned something other than summary rows; dropped');
        return [];
      }
      const rows = result.filter(isSummaryRow);
      const dropped = result.length - rows.length;
      if (dropped > 0) warn(reporter, `returned ${dropped} row(s) without a label and text; dropped`);
      return rows;
    }),
  );

  host.summary(reporters.flatMap((_, index) => [...fileRows[index]!, ...finishedRows[index]!]), finished);
}

/**
 * Writes one reporter's files atomically, each whose path is not the
 * canonical report, and answers the rows naming the ones with a label. A
 * file that could not be written is one line on stderr.
 */
async function writeReportFiles(
  reporter: Reporter,
  files: readonly ReportFile[],
  finished: FinishedRun,
  warn: (reporter: Reporter, detail: string) => void,
): Promise<ReporterSummary> {
  const rows: { label: string; text: string }[] = [];
  for (const file of files) {
    const target = path.resolve(finished.projectRoot, file.path);
    if (finished.reportPath !== undefined && target === path.resolve(finished.reportPath)) {
      warn(reporter, `cannot write ${file.path}: it is the run's report`);
      continue;
    }
    try {
      await writeTextReport(target, file.content);
    } catch (cause) {
      warn(reporter, `could not write ${file.path}: ${errorMessage(cause)}`);
      continue;
    }
    if (file.label === undefined) continue;
    const shown = path.relative(finished.projectRoot, target) || target;
    rows.push({ label: file.label, text: file.note === undefined ? shown : `${shown} ${file.note}` });
  }
  return rows;
}

/** A report file is a non-empty path and string content, with an optional label and note; anything else came from untyped code. */
function isReportFile(value: unknown): value is ReportFile {
  if (typeof value !== 'object' || value === null) return false;
  const { path: file, content, label, note } = value as Record<keyof ReportFile, unknown>;
  const optionalText = (text: unknown): boolean => text === undefined || (typeof text === 'string' && text.length > 0);
  return typeof file === 'string' && file.length > 0 && typeof content === 'string' && optionalText(label) && optionalText(note);
}

/** A row is a non-empty label and non-empty text; anything else came from untyped code. */
function isSummaryRow(value: unknown): value is ReporterSummary[number] {
  if (typeof value !== 'object' || value === null) return false;
  const { label, text } = value as { label?: unknown; text?: unknown };
  return typeof label === 'string' && label.length > 0 && typeof text === 'string' && text.length > 0;
}

