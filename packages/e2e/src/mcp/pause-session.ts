/**
 * Handles `e2e mcp` sessions attached to a test paused at `screen.pause()`.
 * The sessions live beside the attempt in the run's worker. Each is an
 * interactive step with a catalog over the attempt's engine session, so
 * the agent can drive the paused test's app. The runner sends requests here
 * from its socket (`cli/step-control.ts`).
 *
 * As with a normal session, tool arguments are checked against the schema
 * before a call runs. Replies pass through the attempt's secret ledger.
 * `run_code` isn't available because it runs on normal session fixtures.
 * Recording tools aren't available because the run records the video.
 */

import { loadAiSdkIfInstalled } from '@e2e-dev/core/lib/agent/ai-sdk';
import type { AgentContext } from '@e2e-dev/core/lib/agent/invocation';
import { ScreenPresenter } from '@e2e-dev/core/lib/agent/screen-update';
import type { ResolvedConfig, ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import type { TargetSession } from '@e2e-dev/core/lib/engine/surface';
import { classifyError, ConfigurationError, E2EError, errorMessage } from '@e2e-dev/core/lib/internal/errors';
import type { SourceLocation } from '@e2e-dev/core/lib/internal/source';
import { MAX_TIMER_MS } from '@e2e-dev/core/lib/internal/time';
import { LocatorEngine } from '@e2e-dev/core/lib/locator/engine';
import type { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { openInteractiveStep, type InteractiveStep } from '../agent/interactive-step.ts';
import {
  catalogLines,
  createSessionCatalog,
  describeCatalog,
  fillLines,
  isGrammarVerb,
  secretParams,
  unknownTool,
  type SessionCatalog,
} from './catalog.ts';
import { actionResult, errorResult, invokeTool, redactResult, textResult, type McpToolResult } from './tools.ts';
import type { AttachRequest } from './wire.ts';

/** The instruction recorded for the attached session in the test's steps. */
const INSTRUCTION = 'Attached session: a coding agent drove the app over MCP while the test was paused.';

/** The paused attempt and its session settings. */
export interface PauseSessionsOptions {
  readonly runtime: AgentContext;
  readonly session: TargetSession;
  readonly budget: AttemptBudget;
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly runId: string;
  readonly attemptId: string;
  /** The attempt's artifact directory, used before `screenshot` copies an image out. */
  readonly artifactsDir: string;
  /** The paused test's title path, joined with ` › `. */
  readonly title: string;
  /** Where the test paused. */
  readonly source: SourceLocation | undefined;
  readonly warn: (message: string) => void;
}

/** The current attached session. */
interface Attached {
  readonly step: InteractiveStep;
  readonly catalog: SessionCatalog;
  /**
   * Aborts calls when the session closes. Their answers are no longer read,
   * and a slow call could keep the test paused.
   */
  readonly calls: AbortController;
}

/** Handles one session at a time on a pause and answers its requests in order. */
export class PauseSessions {
  private attached: Attached | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PauseSessionsOptions) {}

  /**
   * Answers one request and redacts every reply through the attempt's secret
   * ledger. Most failures return an error result. If opening fails, the
   * promise rejects so `open_session` fails. Closing first aborts calls
   * still in flight.
   */
  request(request: AttachRequest): Promise<McpToolResult> {
    const { redact } = this.options.runtime;

    if (request.type === 'close') {
      this.attached?.calls.abort();
    }

    const answer = this.queue.then(() => this.answer(request)).then(
      (result) => redactResult(result, redact),
      (cause: unknown) => {
        if (request.type !== 'open') {
          return redactResult(errorResult(cause), redact);
        }

        const error = classifyError(cause);
        throw new E2EError(error.category, error.code, redact(error.message));
      },
    );

    this.queue = answer.catch(() => undefined);

    return answer;
  }

  private async answer(request: AttachRequest): Promise<McpToolResult> {
    switch (request.type) {
      case 'open':
        return textResult(await this.open());
      case 'tools':
        return textResult(describeCatalog(this.live().catalog, 'Attached session', this.options.target.name, request.tool));
      case 'call':
        return this.call(request.tool, request.args);
      case 'close':
        await this.close();
        return textResult('Detached; the test stays paused.');
    }
  }

  /** Opens a session on the paused attempt and returns its test, catalog, and screen. */
  private async open(): Promise<string> {
    const { runtime, session, budget, config, target, source } = this.options;
    // Load the optional SDK before rendering the catalog, which is synchronous.
    await loadAiSdkIfInstalled();
    // The pause excludes waiting time from the test's clock, but the deadline
    // still applies to actions. Give them room to run. `AttemptHolds` restores
    // the test's budget when the pause ends.
    budget.resetDeadline(MAX_TIMER_MS);

    const params = secretParams(config);

    const step = await openInteractiveStep(runtime, {
      instruction: INSTRUCTION,
      ...(params === undefined ? {} : { params }),
      timeout: MAX_TIMER_MS,
      source,
    });

    const screen = new ScreenPresenter();

    const catalog = createSessionCatalog({
      context: step.context,
      screen,
      session,
      tools: config.agent.tools,
      redaction: { redact: runtime.redact, redactCut: runtime.redactCut },
      projectRoot: config.projectRoot,
      attemptDir: this.options.artifactsDir,
      recorder: undefined,
      appBase: target.app.base,
      fills: {
        credentials: [...config.credentials.values()].map((credential) => ({
          name: credential.name,
          username: credential.username,
          password: credential.password.name,
        })),
        secrets: [...config.secrets.keys()],
      },
      locator: new LocatorEngine({
        session,
        budget,
        runId: this.options.runId,
        attemptId: this.options.attemptId,
        actionTimeout: config.actionTimeout,
        assertionTimeout: config.assertionTimeout,
      }),
      warn: this.options.warn,
    });

    this.attached = { step, catalog, calls: new AbortController() };

    let first: string;

    try {
      first = screen.initial(await step.run(() => catalog.context.observe()));
    } catch (cause) {
      first = `No screen to show: ${errorMessage(cause)}`;
    }

    const at = source === undefined ? '' : ` at ${source.file}:${source.line}`;

    const lines = [
      `Attached to "${this.options.title}" on target "${target.name}", paused${at}. close_session only detaches, so the test stays paused. To resume the test, run npx e2e run --step next in the run's directory, or npx e2e run --step stop to end the run. The session ends then, so attach again at the next pause.`,
      ...fillLines(config),
      `Tools (run one with call {tool, args}; tools {tool} shows a tool's arguments):`,
      ...catalogLines(catalog),
      'Node ids ("n42") are valid only for the newest observation; every action reports what changed on screen and the test line that repeats it (test_lines returns them all). To keep what you did, put those lines where the test calls screen.pause().',
    ];

    return `${lines.join('\n')}\n\n${first}`;
  }

  /** Runs one catalog tool inside the session's step. */
  private async call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const { step, catalog, calls } = this.live();
    const tool = catalog.tools[name];

    if (tool === undefined) {
      throw unknownTool(catalog, this.options.target.name, name);
    }

    const signal = AbortSignal.any([this.options.budget.signal, calls.signal]);
    const result = await step.run(() => invokeTool(name, tool, args, { signal }));

    return isGrammarVerb(name) ? actionResult(name, result) : result;
  }

  /** Ends the session's step as passed in the test's steps. The test stays paused. */
  private async close(): Promise<void> {
    const attached = this.attached;

    this.attached = undefined;
    await attached?.step.end({ status: 'passed', summary: 'the attached session ended' });
  }

  private live(): Attached {
    if (this.attached === undefined) {
      throw new ConfigurationError('NO_SESSION', 'no session is attached to this pause. Call open_session {attach: true} first');
    }

    return this.attached;
  }
}
