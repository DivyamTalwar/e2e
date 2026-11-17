/**
 * A navigation Chromium aborts, over a scripted peer: after a response a
 * download can come from, the abort waits for the download's announcement
 * and fails as a starting download; after a No Content response it stands
 * as it is, decided before anything else can be announced.
 */

import { describe, expect, it } from 'vitest';
import type { BrowsingContext, Network } from 'webdriver-bidi-protocol';
import { OwnNavigations } from '../../src/driver/own-navigations.ts';
import type { BidiSession } from '../../src/driver/session.ts';
import { goto } from '../../src/driver/steering.ts';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';

const TARGET = 'http://app.test/export';

/** The navigation to `TARGET` in the tab, as its events name it. */
const NAVIGATION: BrowsingContext.NavigationInfo = { context: 'tab', navigation: 'n1', timestamp: 0, url: TARGET, userContext: 'mine' };

/** The parts of a session a navigation reads, its tab `tab` open on `fake`. */
function session(fake: FakeBidi): BidiSession {
  return {
    connection: fake.connection,
    navigations: new OwnNavigations(),
    ensureContext: async () => 'tab',
    userContext: { visit: async () => undefined },
  } as unknown as BidiSession;
}

/** The start of the navigation's response, with `status`. */
function responseStarted(status: number): Network.ResponseStartedParameters {
  const timings = { timeOrigin: 0, requestTime: 0, redirectStart: 0, redirectEnd: 0, fetchStart: 0, dnsStart: 0, dnsEnd: 0, connectStart: 0, connectEnd: 0, tlsStart: 0, requestStart: 0, responseStart: 0, responseEnd: 0 };
  return {
    context: 'tab',
    isBlocked: false,
    navigation: 'n1',
    redirectCount: 0,
    timestamp: 0,
    request: { request: 'r1', url: TARGET, method: 'GET', headers: [], cookies: [], headersSize: 0, bodySize: 0, destination: 'document', initiatorType: null, timings },
    response: { url: TARGET, protocol: 'http/1.1', status, statusText: '', fromCache: false, headers: [], mimeType: '', bytesReceived: 0, headersSize: 0, bodySize: 0, content: { size: 0 } },
  };
}

/**
 * Starts a navigation to `TARGET` that `fake` answers as Chromium does one
 * it stopped after a response of `status`: the navigation starts, its
 * response starts, and the command fails `net::ERR_ABORTED`. Resolves with
 * what the navigation failed with, after the download announced once the
 * abort was delivered.
 */
async function abortedThenAnnounced(status: number): Promise<unknown> {
  const fake = new FakeBidi().on('browsingContext.navigate', () => {
    fake.emit('browsingContext.navigationStarted', NAVIGATION);
    fake.emit('network.responseStarted', responseStarted(status));
    return { error: 'unknown error', message: 'net::ERR_ABORTED' };
  });
  const failure = goto(session(fake), TARGET, 'load', new AbortController().signal).then(() => undefined, (cause: unknown) => cause);
  await settle();
  fake.emit('browsingContext.downloadWillBegin', { ...NAVIGATION, download: 'd1', suggestedFilename: 'export.csv' });
  return failure;
}

describe('a navigation the browser aborts', () => {
  it('fails as a starting download when the announcement follows the abort of a navigation that got a response', async () => {
    expect(await abortedThenAnnounced(200)).toMatchObject({ code: 'ENGINE_FAILURE', message: `navigation to ${TARGET} failed: Download is starting` });
  });

  it.each([204, 205])('keeps the abort after a %i response, with no wait for a download to be announced', async (status) => {
    // An abort still waiting for an announcement would have taken this one and failed as a starting download.
    expect(await abortedThenAnnounced(status)).toMatchObject({ name: 'BidiError', message: 'browsingContext.navigate: unknown error: net::ERR_ABORTED' });
  });
});
