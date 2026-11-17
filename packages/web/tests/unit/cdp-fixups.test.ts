/**
 * The CDP fixups in front of the chromium-bidi mapper: a redirect hop's
 * request-stage pause reaches the mapper after the hop's
 * `Network.requestWillBeSent`, whichever Chrome sent first, a load the
 * renderer starts over is continued with what its first pause was continued
 * with, and a site icon's pauses, whose events the mapper drops, are
 * answered instead.
 */

import { describe, expect, it } from 'vitest';
import { cdpFixups } from '../../src/driver/cdp-fixups.ts';

const willBeSent = (requestId: string, sessionId = 's'): string => JSON.stringify({ method: 'Network.requestWillBeSent', sessionId, params: { requestId } });
const redirected = (requestId: string, sessionId = 's'): string => JSON.stringify({ method: 'Network.requestWillBeSent', sessionId, params: { requestId, redirectResponse: { status: 302 } } });
/** The Fetch id Chrome gives the pause of hop `hop` of a load: one job per load, numbered by hop. */
const pauseId = (networkId: string, hop = 0, job = 'job'): string => `${job}-${networkId}.${String(hop)}`;
/** A request-stage pause of hop `hop` of request `networkId`; a redirect hop's names the pause of the hop before it, as Chrome's does. */
const paused = (networkId: string, hop = 0, sessionId = 's', extra: Record<string, unknown> = {}): string => JSON.stringify({
  method: 'Fetch.requestPaused',
  sessionId,
  params: { requestId: pauseId(networkId, hop), networkId, ...(hop === 0 ? {} : { redirectedRequestId: pauseId(networkId, hop - 1) }), ...extra },
});
/** The pause of a load of `networkId` the renderer started over: a new job, the same hop, no redirect named. */
const restarted = (networkId: string, sessionId = 's'): string => JSON.stringify({ method: 'Fetch.requestPaused', sessionId, params: { requestId: pauseId(networkId, 0, 'again'), networkId } });
const finished = (requestId: string, sessionId = 's'): string => JSON.stringify({ method: 'Network.loadingFinished', sessionId, params: { requestId } });
/** The mapper's continue of the pause `requestId`, with `overrides`. */
const continued = (requestId: string, overrides: Record<string, unknown> = {}, sessionId = 's'): { mapper: string } => ({
  mapper: JSON.stringify({ id: 7, method: 'Fetch.continueRequest', params: { requestId, ...overrides }, sessionId }),
});

/**
 * Runs `messages` through the fixups, the browser's as strings and the
 * mapper's commands as `{ mapper }`, and returns what the mapper received,
 * in order, and what was sent to the browser.
 */
function fix(messages: (string | { mapper: string })[]): { delivered: string[]; sent: unknown[] } {
  const delivered: string[] = [];
  const sent: unknown[] = [];
  const fixups = cdpFixups((message) => delivered.push(message), (message) => sent.push(JSON.parse(message)));
  for (const message of messages) {
    if (typeof message === 'string') fixups.receive(message);
    else fixups.send(message.mapper);
  }
  return { delivered, sent };
}

/** What the mapper received of `messages`, in order. */
const reorder = (messages: string[]): string[] => fix(messages).delivered;

const responseInfo = (requestId: string, statusCode: number, sessionId = 's'): string => JSON.stringify({ method: 'Network.responseReceivedExtraInfo', sessionId, params: { requestId, statusCode } });
const received = (requestId: string, sessionId = 's'): string => JSON.stringify({ method: 'Network.responseReceived', sessionId, params: { requestId, response: { status: 200 } } });

describe('cdpFixups response ExtraInfo', () => {
  it('passes the usual redirect order through', () => {
    const messages = [willBeSent('r'), responseInfo('r', 302), redirected('r'), responseInfo('r', 200), received('r'), finished('r')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('holds the next hop\'s response ExtraInfo that arrives before the redirect until the redirect is sent', () => {
    expect(reorder([willBeSent('r'), responseInfo('r', 302), responseInfo('r', 200), redirected('r'), received('r'), finished('r')]))
      .toEqual([willBeSent('r'), responseInfo('r', 302), redirected('r'), responseInfo('r', 200), received('r'), finished('r')]);
  });

  it('keeps a redirect\'s late ExtraInfo and the next hop\'s in the order Chrome sent them', () => {
    const messages = [willBeSent('r'), redirected('r'), responseInfo('r', 302), responseInfo('r', 200), received('r'), finished('r')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('keeps a hop answered twice without a redirect, as an auth retry is, in order before its response', () => {
    const messages = [willBeSent('r'), responseInfo('r', 401), responseInfo('r', 200), received('r'), finished('r')];
    expect(reorder(messages)).toEqual(messages);
  });
});

describe('cdpFixups', () => {
  it('passes the usual order through', () => {
    const messages = [willBeSent('r'), paused('r'), redirected('r'), paused('r', 1), finished('r')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('lets a first hop\'s early pause through, which the mapper handles', () => {
    const messages = [paused('r'), willBeSent('r')];
    expect(reorder(messages)).toEqual(messages);
  });

  it('holds a redirect hop\'s early pause until the hop is sent', () => {
    const extra = JSON.stringify({ method: 'Network.requestWillBeSentExtraInfo', sessionId: 's', params: { requestId: 'r' } });
    expect(reorder([willBeSent('r'), paused('r'), paused('r', 1), extra, redirected('r')]))
      .toEqual([willBeSent('r'), paused('r'), extra, redirected('r'), paused('r', 1)]);
  });

  it('holds each early pause of a chain of redirects for its own hop', () => {
    expect(reorder([willBeSent('r'), paused('r'), paused('r', 1), redirected('r'), paused('r', 2), redirected('r'), finished('r')]))
      .toEqual([willBeSent('r'), paused('r'), redirected('r'), paused('r', 1), redirected('r'), paused('r', 2), finished('r')]);
  });

  it('never holds a response-stage pause', () => {
    const response = paused('r', 1, 's', { responseStatusCode: 302 });
    expect(reorder([willBeSent('r'), paused('r'), response])).toEqual([willBeSent('r'), paused('r'), response]);
  });

  it('keeps each session\'s request ids apart', () => {
    expect(reorder([willBeSent('r', 'a'), paused('r', 0, 'a'), paused('r', 1, 'b')]))
      .toEqual([willBeSent('r', 'a'), paused('r', 0, 'a'), paused('r', 1, 'b')]);
  });

  it('hands a held pause on when its request ends without another hop', () => {
    expect(reorder([willBeSent('r'), paused('r'), paused('r', 1), finished('r')]))
      .toEqual([willBeSent('r'), paused('r'), finished('r'), paused('r', 1)]);
  });

  it('continues a site icon\'s request-stage pause itself and never hands it to the mapper', () => {
    const icon = (networkId: string, url: string): string => JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 's', params: { requestId: `fetch-${networkId}`, networkId, request: { url } } });
    const page = icon('p', 'http://app.test/favicon.ico?v=1');
    const { delivered, sent } = fix([willBeSent('i'), icon('i', 'http://app.test/assets/favicon.ico'), willBeSent('p'), page]);
    expect(delivered).toEqual([willBeSent('i'), willBeSent('p'), page]);
    expect(sent).toEqual([{ id: 2_000_000_000, method: 'Fetch.continueRequest', params: { requestId: 'fetch-i' }, sessionId: 's' }]);
  });

  it('continues a site icon\'s early redirect-hop pause once its hop is sent', () => {
    const icon = paused('r', 1, 's', { request: { url: 'http://app.test/favicon.ico' } });
    const { delivered, sent } = fix([willBeSent('r'), paused('r'), icon]);
    expect(delivered).toEqual([willBeSent('r'), paused('r')]);
    expect(sent).toEqual([]);
    const after = fix([willBeSent('r'), paused('r'), icon, redirected('r')]);
    expect(after.sent).toEqual([{ id: 2_000_000_000, method: 'Fetch.continueRequest', params: { requestId: pauseId('r', 1) }, sessionId: 's' }]);
  });

  it('answers a site icon\'s auth challenge with the browser\'s default', () => {
    const challenge = JSON.stringify({ method: 'Fetch.authRequired', sessionId: 's', params: { requestId: 'fetch-i', request: { url: 'http://app.test/favicon.ico' } } });
    const other = JSON.stringify({ method: 'Fetch.authRequired', sessionId: 's', params: { requestId: 'fetch-o', request: { url: 'http://app.test/private' } } });
    const { delivered, sent } = fix([challenge, other]);
    expect(delivered).toEqual([other]);
    expect(sent).toEqual([{ id: 2_000_000_000, method: 'Fetch.continueWithAuth', params: { requestId: 'fetch-i', authChallengeResponse: { response: 'Default' } }, sessionId: 's' }]);
  });
});

describe('cdpFixups restarted loads', () => {
  /** What Chrome sent for a web font under an intercept: one request announced once and paused twice, each pause a job of its own. */
  const font = (job: number): string => JSON.stringify({
    method: 'Fetch.requestPaused',
    sessionId: 's',
    params: { requestId: `interception-job-${String(job)}.0`, networkId: '75650.2', resourceType: 'Font', request: { url: 'http://app.test/font.woff2', method: 'GET' } },
  });
  const headers = [{ name: 'x-gate', value: 'open' }];

  it('hands the second pause of a font to the mapper at once', () => {
    const messages = [willBeSent('75650.2'), font(2), font(3)];
    expect(reorder(messages)).toEqual(messages);
  });

  it('sends the mapper\'s continue of the second pause with what the first was continued with', () => {
    const { delivered, sent } = fix([
      willBeSent('75650.2'),
      font(2),
      continued('interception-job-2.0', { headers, url: 'http://cdn.test/font.woff2' }),
      font(3),
      continued('interception-job-3.0'),
    ]);
    expect(delivered).toEqual([willBeSent('75650.2'), font(2), font(3)]);
    expect(sent).toEqual([
      { id: 7, method: 'Fetch.continueRequest', params: { requestId: 'interception-job-2.0', headers, url: 'http://cdn.test/font.woff2' }, sessionId: 's' },
      { id: 7, method: 'Fetch.continueRequest', params: { requestId: 'interception-job-3.0', headers, url: 'http://cdn.test/font.woff2' }, sessionId: 's' },
    ]);
  });

  it('sends a continue of a restart as it is when the first pause was continued untouched', () => {
    const { sent } = fix([willBeSent('r'), paused('r'), continued(pauseId('r')), restarted('r'), continued(pauseId('r', 0, 'again'))]);
    expect(sent).toEqual([
      { id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('r') }, sessionId: 's' },
      { id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('r', 0, 'again') }, sessionId: 's' },
    ]);
  });

  it('gives a redirect hop its own continue, not the one of the hop before it', () => {
    const { sent } = fix([
      willBeSent('r'),
      paused('r'),
      continued(pauseId('r'), { headers }),
      redirected('r'),
      paused('r', 1),
      continued(pauseId('r', 1), { method: 'GET' }),
    ]);
    expect(sent.at(-1)).toEqual({ id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('r', 1), method: 'GET' }, sessionId: 's' });
  });

  it('keeps each session\'s pauses apart', () => {
    const { sent } = fix([
      willBeSent('r', 'a'),
      paused('r', 0, 'a'),
      continued(pauseId('r'), { headers }, 'a'),
      willBeSent('r', 'b'),
      paused('r', 0, 'b'),
      restarted('r', 'b'),
      continued(pauseId('r', 0, 'again'), {}, 'b'),
    ]);
    expect(sent.at(-1)).toEqual({ id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('r', 0, 'again') }, sessionId: 'b' });
  });

  it('forgets a request once its load ends', () => {
    const { sent } = fix([willBeSent('r'), paused('r'), continued(pauseId('r'), { headers }), restarted('r'), finished('r'), continued(pauseId('r', 0, 'again'))]);
    expect(sent.at(-1)).toEqual({ id: 7, method: 'Fetch.continueRequest', params: { requestId: pauseId('r', 0, 'again') }, sessionId: 's' });
  });

  it('sends every other command of the mapper as it wrote it', () => {
    const evaluate = { id: 9, method: 'Runtime.evaluate', params: { expression: '"Fetch.continueRequest"' }, sessionId: 's' };
    const { sent } = fix([willBeSent('r'), paused('r'), { mapper: JSON.stringify(evaluate) }, { mapper: JSON.stringify({ id: 10, method: 'Fetch.failRequest', params: { requestId: pauseId('r'), errorReason: 'Failed' }, sessionId: 's' }) }]);
    expect(sent).toEqual([evaluate, { id: 10, method: 'Fetch.failRequest', params: { requestId: pauseId('r'), errorReason: 'Failed' }, sessionId: 's' }]);
  });
});
