/**
 * `afterTrigger`, the one wait on a test's own trigger: its timeout is told
 * whether the trigger had resolved and after how long, the trigger's own
 * error leaves wrapped for `guard` to hand back, and cancellation ends it.
 */

import { describe, expect, it } from 'vitest';
import { afterTrigger, TriggerFailure } from '../../src/driver/budget.ts';

const never = new Promise<never>(() => undefined);
const budget = (timeoutMs: number, signal = new AbortController().signal) => ({ timeoutMs, signal });
const timedOut = (triggerMs: number | undefined): Error => new Error(triggerMs === undefined ? 'trigger pending' : `trigger took ${typeof triggerMs}`);

describe('afterTrigger', () => {
  it('resolves with the wait once the trigger returned too, whichever finished first', async () => {
    let release: () => void = () => undefined;
    const trigger = new Promise<void>((resolve) => (release = resolve));
    const waited = afterTrigger(() => trigger, Promise.resolve('tab'), budget(1_000), timedOut);
    const early = await Promise.race([waited, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 20))]);
    expect(early).toBe('still waiting');
    release();
    expect(await waited).toBe('tab');
  });

  it('tells its timeout whether the trigger had resolved', async () => {
    await expect(afterTrigger(() => never, never, budget(20), timedOut)).rejects.toThrow('trigger pending');
    await expect(afterTrigger(async () => undefined, never, budget(20), timedOut)).rejects.toThrow('trigger took number');
  });

  it('wraps what the trigger threw, a synchronous throw included, without waiting out the budget', async () => {
    const failure = new Error('trigger broke');
    const thrown = (await afterTrigger(async () => { throw failure; }, never, budget(10_000), timedOut).catch((cause: unknown) => cause)) as TriggerFailure;
    expect(thrown).toBeInstanceOf(TriggerFailure);
    expect(thrown.thrown).toBe(failure);
    const sync = (() => { throw failure; }) as () => Promise<void>;
    await expect(afterTrigger(sync, never, budget(10_000), timedOut)).rejects.toMatchObject({ thrown: failure });
  });

  it('ends as CANCELLED once its signal aborts', async () => {
    const controller = new AbortController();
    const waited = afterTrigger(() => never, never, budget(10_000, controller.signal), timedOut);
    controller.abort();
    await expect(waited).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
