/**
 * Handles `open_session {attach: true}` for `e2e mcp`. It connects to the
 * run's socket in the server's directory (`run/step-socket.ts`) and asks to
 * attach to a paused test. It then sends each session call in order, one
 * line at a time. The run handles the other end in `cli/step-control.ts`.
 */

import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigurationError, InfrastructureError } from '@e2e-dev/core/lib/internal/errors';
import { NOT_PAUSED } from '../run/step-hold.ts';
import { parseLine, stepAddress } from '../run/step-socket.ts';
import type { McpToolResult } from './tools.ts';
import { AttachReply, type AttachCall, type AttachStart } from './wire.ts';
import type { z } from 'zod';

/** How long detaching waits for the run to hang up before closing the connection. */
const HANG_UP_MS = 5_000;

/** An `e2e mcp` session attached to a test paused at `screen.pause()`. */
export interface PauseAttachment {
  /** The target of the paused test. */
  readonly target: string;
  /** The opening result with the paused test, catalog, and screen. */
  readonly opening: McpToolResult;
  /** Sends a call after earlier calls and returns the run's answer. */
  request(call: AttachCall): Promise<McpToolResult>;
  /**
   * Detaches by hanging up. It resolves when the run hangs up its side, or
   * after `HANG_UP_MS`. The test stays paused, so another session can attach.
   */
  close(): Promise<void>;
  /** A promise that settles when the run hangs up. The session ends then. */
  readonly ended: Promise<void>;
}

/**
 * Attaches a session to a test paused at `screen.pause()` in the run in `cwd`.
 * It resolves after the worker opens the session.
 *
 * - If no run is listening, or the run hangs up before the session opens,
 *   it rejects with `NO_SESSION`.
 * - If the run refuses the attach, it rejects with the run's reason.
 * - If `signal` aborts before the session opens, it rejects with `CANCELLED`.
 */
export function attachToPause(cwd: string, signal: AbortSignal): Promise<PauseAttachment> {
  return new Promise((resolve, reject) => {
    const address = stepAddress(cwd);
    /** Calls waiting for answers, in the order they were sent. */
    const pending: { readonly resolve: (result: McpToolResult) => void; readonly reject: (cause: unknown) => void }[] = [];
    let opened = false;
    let received = '';
    /** Why calls fail once the connection is closed. */
    let why = NOT_PAUSED;

    const connection = net.connect(address.socket);
    connection.setEncoding('utf8');
    connection.on('error', () => undefined);

    const ended = new Promise<void>((resolveEnded) => {
      connection.once('close', () => resolveEnded());
    });

    const cancel = (): void => {
      connection.destroy();
      reject(new InfrastructureError('CANCELLED', 'attaching the session was cancelled'));
    };

    if (signal.aborted) {
      cancel();
    } else {
      signal.addEventListener('abort', cancel, { once: true });
    }

    /** Sends one call and waits for its answer. */
    const request = (call: AttachCall): Promise<McpToolResult> =>
      new Promise((resolveAnswer, rejectAnswer) => {
        if (connection.destroyed) {
          rejectAnswer(new ConfigurationError('NO_SESSION', `the attached session ended: ${why}`));
          return;
        }

        pending.push({ resolve: resolveAnswer, reject: rejectAnswer });
        connection.write(`${JSON.stringify(call)}\n`);
      });

    connection.on('connect', () => {
      connection.write(`${JSON.stringify({ attach: true } satisfies z.infer<typeof AttachStart>)}\n`);
    });

    connection.on('data', (chunk: string) => {
      received += chunk;

      for (let end = received.indexOf('\n'); end !== -1; end = received.indexOf('\n')) {
        const line = received.slice(0, end);
        received = received.slice(end + 1);

        const reply = parseLine(line, AttachReply);

        if (reply === undefined) {
          connection.destroy();
          return;
        }

        if (!opened) {
          opened = true;
          signal.removeEventListener('abort', cancel);

          if ('error' in reply) {
            connection.end();
            reject(new ConfigurationError(reply.error.code, reply.error.message));
            return;
          }

          resolve({
            target: reply.target,
            opening: reply.result,
            request,
            close: async () => {
              why = 'the session was closed';
              connection.end();
              await Promise.race([ended, sleep(HANG_UP_MS, undefined, { ref: false })]);
              connection.destroy();
            },
            ended,
          });

          continue;
        }

        const waiting = pending.shift();

        if ('error' in reply) {
          waiting?.reject(new ConfigurationError(reply.error.code, reply.error.message));
        } else {
          waiting?.resolve(reply.result);
        }
      }
    });

    connection.on('close', () => {
      signal.removeEventListener('abort', cancel);
      // The run hangs up before the opening when it isn't waiting at a pause.
      // After the attach resolves, rejecting it doesn't do anything.
      reject(
        new ConfigurationError(
          'NO_SESSION',
          `no e2e run is waiting at screen.pause() in ${cwd}: the run has ended, hasn't paused yet, or was started with --step. Attach while a test is paused in a run without --step`,
        ),
      );

      for (const waiting of pending.splice(0)) {
        waiting.reject(new ConfigurationError('NO_SESSION', `the attached session ended: ${why}`));
      }
    });
  });
}
