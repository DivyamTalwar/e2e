/**
 * How the driver calls into the attempt's documents: a page function by its
 * source, one of the driver's typed page functions, or one of the readers a
 * document keeps (`in-page/readers.ts`) by name. A reader is called through
 * the copy the document's preload installed, gets installed with the call
 * where the preload never ran, and a read that fails is told apart from a
 * page that broke the readers.
 */

import { TestError } from '@e2e-dev/core/engine';
import { ScriptError } from '../errors.ts';
import { readerCall, readerInstallCall, READERS_MISSING, type ReaderName, type Readers } from '../in-page/readers.ts';
import type { BidiConnection } from './connection.ts';
import { callFunction, type CallOptions, type ElementRef, type PageArgument, type PageValue, type TypedPageFunction, type Wire } from './script.ts';

/** The sandbox realm a failed read runs again in, to tell a page that broke the readers from a fault of their own. */
const READER_PROBE_SANDBOX = 'e2e-reader-probe';

/** How a reader's answer is read: whole, however deep. */
const WHOLE: CallOptions = { maxObjectDepth: null };

/** What reader `K` takes, as it crosses the wire. */
type ReaderArgs<K extends ReaderName> = Wire<Parameters<Readers[K]>> & readonly PageArgument[];

/** What reader `K` answers, as it crosses the wire. */
type ReaderResult<K extends ReaderName> = Wire<ReturnType<Readers[K]>>;

/** The calls into one attempt's documents; a call that names no context goes to the tab the attempt shows. */
export class PageCalls {
  /** `shown` is the tab the attempt shows; it throws when none is open. */
  constructor(
    private readonly connection: BidiConnection,
    private readonly shown: () => string,
  ) {}

  /** Calls a page function in `context` (the tab by default). */
  call(declaration: string, args: readonly PageArgument[], options: CallOptions, context?: string): Promise<PageValue> {
    return callFunction(this.connection, context ?? this.shown(), declaration, args, options);
  }

  /**
   * Runs one of this driver's typed page functions in `context` (the tab by
   * default), with its element arguments as references and its result
   * converted back the same way; a promise it returns is awaited.
   */
  async run<F extends TypedPageFunction>(fn: F, args: Wire<Parameters<F>> & readonly PageArgument[], context?: string): Promise<Wire<Awaited<ReturnType<F>>>> {
    const value = await callFunction(this.connection, context ?? this.shown(), fn, args, { awaitPromise: true, maxObjectDepth: null });
    return value as Wire<Awaited<ReturnType<F>>>;
  }

  /** Calls the document's reader `name` in `context` (the tab by default) and reads its answer whole. */
  async reader<K extends ReaderName>(name: K, args: ReaderArgs<K>, context?: string): Promise<ReaderResult<K>> {
    return (await this.callReader(name, args, context)) as ReaderResult<K>;
  }

  /**
   * Calls the document's encoded reader `name` in `context` (the tab by
   * default) and decodes its metadata: one JSON string, or, when the page's
   * JSON cannot be trusted, the value itself, read whole in the same call.
   */
  async readEncoded<K extends 'tree' | 'locate'>(name: K, args: ReaderArgs<K>, context?: string): Promise<{ metadata: Exclude<ReaderResult<K>[0], string>; elements: ElementRef[] }> {
    const [metadata, elements] = (await this.callReader(name, args, context)) as ReaderResult<K>;
    // oxlint-disable-next-line e2e/no-unchecked-json -- page-reported metadata; each caller checks its alignment
    return { metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata, elements };
  }

  /**
   * Calls one of the document's readers through the copy its preload
   * installed; a document without one (open before the preload) gets them
   * with the call, and keeps them.
   */
  private async callReader(name: ReaderName, args: readonly PageArgument[], context: string | undefined): Promise<unknown> {
    try {
      const value = await this.call(readerCall(name), args, WHOLE, context);
      if (value !== READERS_MISSING) return value;
      return await this.call(readerInstallCall(name), args, WHOLE, context);
    } catch (cause) {
      throw (await this.pageBrokeReader(name, cause, args, context)) ?? cause;
    }
  }

  /**
   * The failure of a reader the page's own scripts broke, as the test's
   * `EVALUATE_FAILED`, or undefined when something else failed. A page that
   * replaces a built-in method the readers call (`Map.prototype.set`) breaks
   * them in its world. Told apart by reading again in a sandbox realm, whose
   * built-ins and DOM bindings no page script reaches: a read that throws in
   * the page's world and passes there failed because of the page.
   */
  private async pageBrokeReader(name: ReaderName, cause: unknown, args: readonly PageArgument[], context: string | undefined): Promise<TestError | undefined> {
    if (!(cause instanceof ScriptError)) return undefined;
    try {
      await this.call(readerInstallCall(name), args, { ...WHOLE, sandbox: READER_PROBE_SANDBOX }, context);
    } catch {
      return undefined;
    }
    return new TestError('EVALUATE_FAILED', `the ${name} read failed: the page deleted or replaced a JavaScript built-in that in-page automation code needs: ${cause.message}`, { cause });
  }
}
