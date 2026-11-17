/**
 * What a page logs, as the app log reads it on both BiDi browsers: a
 * browser's own line for a failed WebSocket connection, an error with its
 * message, an object with its first fields, a format string filled, a line
 * whose format string and arguments do not pair up, and what each browser
 * hands over of a class instance. Chromium's lines come off its DevTools
 * protocol; Firefox's off `log.entryAdded`, which gives no class name and
 * labels its own lines as errors of the page.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppLogEntry } from '@e2e-dev/core/engine';
import { onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';

describe('app log console lines', () => {
  let page: WebSession;
  const entries: AppLogEntry[] = [];
  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 10_000, startAttempt: false, attempt: { appLog: (entry) => entries.push(entry) } });
  });
  beforeEach(async () => {
    await page.startAttempt();
    entries.length = 0;
  });
  afterAll(async () => {
    await page.close();
  });

  /** Runs `script` in a blank page and resolves with the app log's lines once it holds `count` of them, each without where it was logged. */
  async function logged(script: string, count: number): Promise<AppLogEntry[]> {
    await page.setContent('<p>log</p>');
    await page.browser.evaluate(`void (() => { ${script} })()`);
    await expect.poll(() => entries.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(count);
    return entries.map((entry) => ({ ...entry, text: entry.text.replace(/ \(at \S+\)$/, '') }));
  }

  it('reports the browser\'s own line for a WebSocket connection that failed: a console error on Chromium, an error of the page on Firefox', async () => {
    const lines = await logged('new WebSocket("ws://127.0.0.1:1/?token=abc");', 1);
    expect(lines).toEqual([onFirefox
      ? { source: 'error', level: 'error', text: 'Firefox can’t establish a connection to the server at ws://127.0.0.1:1/?token=abc.' }
      : { source: 'console', level: 'error', text: expect.stringMatching(/^WebSocket connection to 'ws:\/\/127\.0\.0\.1:1\/\?token=abc' failed: /) }]);
  });

  it('reports the browser\'s own line of a tab the app opened, from its first', async () => {
    page.serve('/chatty', '<!doctype html><script>console.log("popup first line"); new WebSocket("ws://127.0.0.1:1/popup");</script>');
    const lines = await logged('window.open("/chatty");', 2);
    expect(lines.map((line) => line.text)).toEqual(expect.arrayContaining([
      'popup first line',
      expect.stringMatching(onFirefox ? /^Firefox can’t establish a connection to the server at ws:\/\/127\.0\.0\.1:1\/popup/ : /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:1\/popup' failed: /),
    ]));
  });

  it('reports the lines of a frame of another site and of a worker, the browser\'s own among them', async () => {
    page.serve('/worker.js', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end('console.error(new Error("worker boom"));');
    });
    const frame = page.serve('/cross-site-frame', '<!doctype html><script>console.log("from the frame"); new WebSocket("ws://127.0.0.1:1/frame");</script>').replace('127.0.0.1', 'localhost');
    const lines = await logged(`document.body.append(Object.assign(document.createElement('iframe'), { src: ${JSON.stringify(frame)} })); new Worker('/worker.js');`, 3);
    expect(lines.map((line) => line.text)).toEqual(expect.arrayContaining([
      'from the frame',
      expect.stringMatching(onFirefox ? /^Firefox can’t establish a connection to the server at ws:\/\/127\.0\.0\.1:1\/frame/ : /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:1\/frame' failed: /),
      expect.stringMatching(/^Error: worker boom/),
    ]));
  });

  it('reports a logged error with its message', async () => {
    const [line] = await logged('console.error(new Error("boom"));', 1);
    expect(line).toEqual({ source: 'console', level: 'error', text: expect.stringMatching(/^Error: boom/) });
  });

  it('reports a logged error beside a string with its message', async () => {
    const [line] = await logged('console.error("Failed to save", new TypeError("bad thing"));', 1);
    expect(line!.text).toMatch(/^Failed to save TypeError: bad thing/);
  });

  it('shows a logged object\'s own first fields, a nested object as its kind', async () => {
    const lines = await logged('console.log({ a: 1, nested: { b: 2 } }); console.log({ code: 1006, reason: "", wasClean: false });', 2);
    expect(lines.map((line) => line.text)).toEqual(['{a: 1, nested: Object}', '{code: 1006, reason: "", wasClean: false}']);
  });

  it('fills a format string from the arguments after it', async () => {
    const [line] = await logged('console.log("%s is %d", "x", 5);', 1);
    expect(line).toEqual({ source: 'console', level: 'info', text: 'x is 5' });
  });

  it('bounds an object of 100 fields to its first five', async () => {
    const [line] = await logged('console.log(Object.fromEntries(Array.from({ length: 100 }, (_, index) => ["field" + index, index])));', 1);
    expect(line!.text).toBe('{field0: 0, field1: 1, field2: 2, field3: 3, field4: 4, …}');
  });

  it('shows the first items of an array and the first entries of a map and a set', async () => {
    const [line] = await logged('console.log([1, "two", { three: 3 }, [4], null, undefined, 7], new Map([["k", 1]]), new Set(["a"]));', 1);
    expect(line!.text).toBe('[1, "two", Object, Array(1), null, …] Map(1) {"k" => 1} Set(1) {"a"}');
  });

  it('names the class of a logged instance on Chromium; BiDi hands Firefox an object with no class and no fields of a platform one', async () => {
    const lines = await logged('console.log(new Event("close")); console.log(new (class Point { constructor() { this.x = 1; this.y = 2; } })());', 2);
    expect(lines.map((line) => line.text)).toEqual(onFirefox
      ? ['object', '{x: 1, y: 2}']
      : ['Event {isTrusted: false, type: "close", target: null, currentTarget: null, eventPhase: 0, …}', 'Point {x: 1, y: 2}']);
  });

  it('reports a line whose format string has fewer specifiers than arguments, after a logged object, and stays connected', async () => {
    const lines = await logged('console.log({ a: 1 }); console.log("%c styled", "color: red", "after"); console.log("Sale: 10%off today");', 3);
    expect(lines.map((line) => line.text)).toEqual(['{a: 1}', ' styled after', 'Sale: 10%off today']);
    expect(await page.browser.evaluate('1 + 1')).toBe(2);
  });

  it('hands the harness a secret inside a logged object whole, for it to redact, and leaves a string the browser may have cut out of the line', async () => {
    const [line] = await logged('console.log({ token: "tok-9f31c7a2", note: "n".repeat(150) + "tok-9f31c7a2" });', 1);
    // Chromium cuts a string of a preview at 100 characters, which would leave the head of a secret unredacted; Firefox gives it whole.
    expect(line!.text).toBe(onFirefox ? `{token: "tok-9f31c7a2", note: "${'n'.repeat(150)}tok-9f31c7a2"}` : '{token: "tok-9f31c7a2", note: "…"}');
  });
});
