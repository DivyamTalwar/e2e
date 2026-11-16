/**
 * What one operation may spend, and the two ways it is bounded: the driver's
 * deadline (`withDeadline`), or, for a wait on the test's own trigger, the
 * wait itself (`afterTrigger`), whose timeout says what it still waited for.
 */

import { EngineError, raceAbort, withTimeout } from '@e2e-dev/core/engine';
import { abortError } from '../errors.ts';

/** What an operation may spend: its signal and the milliseconds left. */
export interface OperationBudget {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * How much sooner than an operation's deadline the driver's own timeout
 * fires: its error names what blocked an action, or that the input was
 * already dispatched, and this lead lets that answer arrive before the
 * deadline does. The deadline is for the calls the browser never answers: an
 * evaluate, which takes no timeout, and a point tap on a page whose renderer
 * is stuck in a script. A budget shorter than twice the lead splits in half.
 */
const DRIVER_TIMEOUT_LEAD_MS = 250;

/**
 * Bounds one operation by its budget: work still pending at the deadline is
 * aborted and abandoned as `OPERATION_TIMEOUT` instead of holding the test
 * until its own timeout. `work` gets a signal that aborts at the deadline or
 * on cancellation, and the time to pass the driver's own timeouts, which
 * fire `DRIVER_TIMEOUT_LEAD_MS` sooner.
 */
export async function withDeadline<T>(operation: OperationBudget, label: string, work: (budget: OperationBudget) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([operation.signal, controller.signal]);
  const expire = (): void => controller.abort(new EngineError('OPERATION_TIMEOUT', `${label} timed out`, { retryable: false }));
  if (operation.timeoutMs <= 0) expire();
  const timer = setTimeout(expire, Math.max(0, operation.timeoutMs));
  try {
    if (signal.aborted) throw abortError(signal, label);
    const lead = Math.min(DRIVER_TIMEOUT_LEAD_MS, operation.timeoutMs / 2);
    return await raceAbort(() => work({ signal, timeoutMs: Math.ceil(operation.timeoutMs - lead) }), signal, label);
  } catch (cause) {
    if (signal.aborted) throw abortError(operation.signal.aborted ? operation.signal : signal, label);
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

/** What the test's own trigger threw, which `guard` throws on as it was: test code keeps its classification, or its lack of one. */
export class TriggerFailure extends Error {
  constructor(readonly thrown: unknown) {
    super('the trigger failed', { cause: thrown });
  }
}

/**
 * Runs the test's `trigger` and resolves with `wait` once both have
 * finished, within `budget`. The trigger is test code that runs its own
 * steps, so the wait owns the deadline: when the budget runs out it fails
 * with what `timedOut` builds from how long the trigger took, undefined
 * while it is still pending. What the trigger throws leaves as a
 * `TriggerFailure`.
 */
export async function afterTrigger<T>(
  trigger: () => Promise<void>,
  wait: Promise<T>,
  budget: OperationBudget,
  timedOut: (triggerMs: number | undefined) => Error,
): Promise<T> {
  const started = Date.now();
  let triggerMs: number | undefined;
  const triggered = (async (): Promise<void> => {
    try {
      await trigger();
    } catch (cause) {
      throw new TriggerFailure(cause);
    }
    triggerMs = Date.now() - started;
  })();
  const [result] = await withTimeout(raceAbort(Promise.all([wait, triggered]), budget.signal, 'trigger wait'), budget.timeoutMs, () => timedOut(triggerMs));
  return result;
}
