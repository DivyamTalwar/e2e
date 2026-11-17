/**
 * Fixes for four faults of the chromium-bidi mapper (still present in 159.0.8147) and one of
 * Chrome's, applied to the CDP stream the mapper reads and the commands it sends.
 *
 * Redirect pauses: Chrome sends a redirect hop's `Fetch.requestPaused` and
 * its `Network.requestWillBeSent` in either order, and the mapper handles a
 * pause that comes first only for a request's first hop: a later hop's early
 * pause lands on the previous hop, which already reported
 * `network.beforeRequestSent`, so the mapper continues the hop untouched and
 * never reports it, and a route's header overrides never reach the redirect.
 * A redirect hop's pause names the pause of the hop before it
 * (`redirectedRequestId`), and each such pause is held until its hop is
 * sent. A request that never sends `Network.requestWillBeSent` is never held.
 *
 * Restarted loads: Chrome pauses a hop again, under a new Fetch id and with
 * no new `Network.requestWillBeSent`, when the renderer starts the hop's
 * load over. Blink does so for a web font: it asks the HTTP cache alone
 * first, and on a miss loads the font again from the network. The mapper
 * continues the second pause with no overrides, so what the first pause was
 * continued with (a route's headers, the configured headers, a rewritten
 * URL) never reaches the server. Such a pause names no
 * `redirectedRequestId`: it is never held, and the mapper's continue of it
 * is sent with what the mapper continued the hop's first pause with.
 *
 * Early response ExtraInfo: Chrome sends `Network.responseReceivedExtraInfo`
 * out of band, so the next hop's can arrive before the redirect's
 * `Network.requestWillBeSent`, and the mapper gives the redirect hop that
 * response (a 302 reported as the 200 it led to, under the first URL). A hop
 * gets one such event, so a second one before the next hop is held until that
 * hop is sent, or until the request's own response or end.
 *
 * Site icons: the mapper drops every event of a request whose URL ends in
 * `/favicon.ico` (`NetworkRequest#isIgnoredEvent`), yet still blocks it when
 * an intercept covers it, so the request would stay paused with no driver
 * ever told. Its pauses are answered here, as the mapper answers a request no
 * intercept blocks, and never reach the mapper.
 *
 * Request bodies: Chrome answers `Network.getRequestPostData` from the
 * renderer, which leaves a form's file read from disk out of the body
 * without a word, and has no answer for a body that is one such file. The
 * pause carries the body as the browser will send it (`postDataEntries`,
 * one entry without bytes for each part it cannot report: a file on disk, a
 * stream). For a request paused at the request stage the command is
 * answered here from its pause, and never reaches the browser: the bytes of
 * every entry, `NO_POST_DATA` for a request without a body, as Chrome
 * answers, and `UNREPORTED_POST_DATA` when an entry has no bytes.
 */

/** Chrome's own failure of `Network.getRequestPostData` for a request without a body. */
export const NO_POST_DATA = 'No post data available for the request';

/** The failure of `Network.getRequestPostData` for a paused request whose body has a part Chrome reports no bytes of. */
export const UNREPORTED_POST_DATA = 'A part of the post data has no bytes';

/** One part of a paused request's body, as `Fetch.requestPaused` lists it: its bytes in base64, or none Chrome reports. */
interface PostDataEntry {
  readonly bytes?: string;
}

/** What the fixups keep of one request of a CDP session, from its first event until its load ends. */
interface RequestHops {
  /** Whether a `Network.requestWillBeSent` announced any hop of it. */
  sent: boolean;
  /** How many redirect hops were announced, and how many of their pauses were handed on. */
  redirects: number;
  redirectPauses: number;
  /** The redirect pauses waiting for their hop. */
  held: string[];
  /** The response ExtraInfo events the hop in flight got, and the next hops' held behind them. */
  infos: number;
  heldInfos: string[];
  /** The Fetch ids the hop in flight was paused under, oldest first: more than one once its load restarted. */
  pauses: string[];
  /** What the mapper continued the first of `pauses` with, beside the id. */
  overrides?: Record<string, unknown>;
  /** The body the latest of `pauses` reported, part by part, as one part without bytes when it listed none; undefined for a request without one. */
  posted?: readonly PostDataEntry[];
}

/** The requests of one CDP session, by request id, and the ones a pause handed on belongs to, by Fetch id. */
interface SessionRequests {
  readonly byId: Map<string, RequestHops>;
  readonly byPause: Map<string, RequestHops>;
}

/** What the fixups read of a CDP message. */
interface CdpMessage {
  readonly method?: string;
  readonly sessionId?: string;
  readonly params?: {
    readonly requestId?: string;
    readonly networkId?: string;
    readonly redirectedRequestId?: string;
    readonly sessionId?: string;
    readonly responseStatusCode?: number;
    readonly responseErrorReason?: string;
    readonly request?: { readonly url?: string; readonly hasPostData?: boolean; readonly postDataEntries?: readonly PostDataEntry[] };
    readonly redirectResponse?: unknown;
  };
}

/** The mapper's CDP connection with the fixups applied, in both directions. */
export interface CdpFixups {
  /** Takes a message from the browser, and hands the mapper what it may read of it. */
  readonly receive: (message: string) => void;
  /** Takes a command of the mapper's, and sends the browser what it should get of it. */
  readonly send: (message: string) => void;
}

const WATCHED = [
  '"Network.requestWillBeSent"',
  '"Network.responseReceivedExtraInfo"',
  '"Network.responseReceived"',
  '"Fetch.requestPaused"',
  '"Fetch.authRequired"',
  '"Network.loadingFinished"',
  '"Network.loadingFailed"',
  '"Target.detachedFromTarget"',
];

/** The ids of the fixups' own CDP commands, far above any the mapper numbers up from 0, so no answer reaches a command of its. */
const FIRST_COMMAND_ID = 2_000_000_000;

/** A CDP message from the browser; only optional fields are read. */
function parse(message: string): CdpMessage {
  // oxlint-disable-next-line e2e/no-unchecked-json -- a CDP message from the browser; only optional fields are read
  return JSON.parse(message) as CdpMessage;
}

/** A CDP command the mapper sends. */
interface CdpCommand {
  readonly id?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** A CDP command of the mapper's, whole, so it can be sent on with other parameters, or answered. */
function parseCommand(message: string): CdpCommand {
  // oxlint-disable-next-line e2e/no-unchecked-json -- the mapper's own serialized command; only optional fields are read
  return JSON.parse(message) as CdpCommand;
}

/** The commands of the mapper's the fixups change or answer. */
const SENT = ['"Fetch.continueRequest"', '"Network.getRequestPostData"'];

/**
 * What `Network.getRequestPostData` answers for a request paused with the
 * body `posted`: its bytes, the failure Chrome answers a request without a
 * body with, or the failure that tells a part has no bytes.
 */
function postDataAnswer(posted: readonly PostDataEntry[] | undefined): { readonly result: { readonly postData: string; readonly base64Encoded: true } } | { readonly error: { readonly code: number; readonly message: string } } {
  if (posted === undefined) return { error: { code: -32000, message: NO_POST_DATA } };
  const parts = posted.flatMap((entry) => (entry.bytes === undefined ? [] : [Buffer.from(entry.bytes, 'base64')]));
  if (parts.length < posted.length) return { error: { code: -32000, message: UNREPORTED_POST_DATA } };
  return { result: { postData: Buffer.concat(parts).toString('base64'), base64Encoded: true } };
}

/** Whether the mapper ignores every event of the request `message` pauses, its own rule. */
function isSiteIcon(message: CdpMessage): boolean {
  return message.params?.request?.url?.endsWith('/favicon.ico') === true;
}

/**
 * The mapper's CDP connection with the fixups on it. `receive` takes each
 * message of the browser's and hands the mapper's handler (`deliver`) what
 * it may read: a redirect hop's request-stage `Fetch.requestPaused` after
 * the hop's `Network.requestWillBeSent`, a response ExtraInfo with its own
 * hop, and none of a site icon's pauses, which are answered on `write`, the
 * mapper's CDP socket. `send` takes each command of the mapper's and writes
 * it, its continue of a restarted load with what the load's first pause was
 * continued with; its `Network.getRequestPostData` for a paused request is
 * answered from the pause instead. Every other message passes through in
 * order, unparsed unless it names one of the events or commands the fixups
 * depend on.
 */
export function cdpFixups(deliver: (message: string) => void, write: (message: string) => void): CdpFixups {
  const sessions = new Map<string, SessionRequests>();
  let nextId = FIRST_COMMAND_ID;
  const command = (sessionId: string, method: string, params: Record<string, unknown>): void => {
    write(JSON.stringify({ id: nextId++, method, params, ...(sessionId === '' ? {} : { sessionId }) }));
  };
  const requestsOf = (session: string): SessionRequests => {
    let requests = sessions.get(session);
    if (requests === undefined) sessions.set(session, (requests = { byId: new Map(), byPause: new Map() }));
    return requests;
  };
  const hopsOf = (session: string, request: string): RequestHops => {
    const { byId } = requestsOf(session);
    let hops = byId.get(request);
    if (hops === undefined) byId.set(request, (hops = { sent: false, redirects: 0, redirectPauses: 0, held: [], infos: 0, heldInfos: [], pauses: [] }));
    return hops;
  };
  /**
   * Hands a request-stage pause on: to the mapper, or for a site icon,
   * straight back to the browser. One the mapper gets is kept by its Fetch
   * id for the mapper's continue of it, with the body it reports: a
   * redirect hop's starts the hop in flight, any other joins the pauses
   * that hop already has.
   */
  const pause = (message: string, parsed: CdpMessage = parse(message)): void => {
    const { sessionId = '', params } = parsed;
    const hops = params?.networkId === undefined ? undefined : hopsOf(sessionId, params.networkId);
    const redirect = params?.redirectedRequestId !== undefined;
    if (hops !== undefined && redirect) hops.redirectPauses++;
    if (isSiteIcon(parsed) && params?.requestId !== undefined) {
      command(sessionId, 'Fetch.continueRequest', { requestId: params.requestId });
      return;
    }
    if (hops !== undefined && params?.requestId !== undefined) {
      const { byPause } = requestsOf(sessionId);
      if (redirect) {
        for (const id of hops.pauses.splice(0)) byPause.delete(id);
        delete hops.overrides;
      }
      hops.pauses.push(params.requestId);
      byPause.set(params.requestId, hops);
      if (params.request?.hasPostData === true) hops.posted = params.request.postDataEntries ?? [{}];
      else delete hops.posted;
    }
    deliver(message);
  };
  const receive = (message: string): void => {
    if (!WATCHED.some((method) => message.includes(method))) {
      deliver(message);
      return;
    }
    const parsed = parse(message);
    const { method, sessionId = '', params } = parsed;
    if (method === 'Fetch.authRequired' && isSiteIcon(parsed) && params?.requestId !== undefined) {
      command(sessionId, 'Fetch.continueWithAuth', { requestId: params.requestId, authChallengeResponse: { response: 'Default' } });
      return;
    }
    if (method === 'Fetch.requestPaused' && params?.responseStatusCode === undefined && params?.responseErrorReason === undefined) {
      const hops = params?.networkId === undefined ? undefined : hopsOf(sessionId, params.networkId);
      if (hops !== undefined && params?.redirectedRequestId !== undefined && hops.sent && hops.redirectPauses >= hops.redirects) {
        hops.held.push(message);
        return;
      }
      pause(message, parsed);
      return;
    }
    if (method === 'Network.responseReceivedExtraInfo' && params?.requestId !== undefined) {
      const hops = hopsOf(sessionId, params.requestId);
      if (hops.infos > 0) {
        hops.heldInfos.push(message);
        return;
      }
      hops.infos++;
      deliver(message);
      return;
    }
    if (method === 'Network.responseReceived' || method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const hops = params?.requestId === undefined ? undefined : sessions.get(sessionId)?.byId.get(params.requestId);
      for (const info of hops?.heldInfos.splice(0) ?? []) deliver(info);
    }
    deliver(message);
    if (method === 'Network.requestWillBeSent' && params?.requestId !== undefined) {
      const hops = hopsOf(sessionId, params.requestId);
      hops.sent = true;
      if (params.redirectResponse === undefined) return;
      hops.infos = 0;
      const info = hops.heldInfos.shift();
      if (info !== undefined) {
        hops.infos++;
        deliver(info);
      }
      hops.redirects++;
      const held = hops.held.shift();
      if (held !== undefined) pause(held);
    } else if ((method === 'Network.loadingFinished' || method === 'Network.loadingFailed') && params?.requestId !== undefined) {
      const requests = sessions.get(sessionId);
      const hops = requests?.byId.get(params.requestId);
      if (requests === undefined || hops === undefined) return;
      for (const held of hops.held.splice(0)) pause(held);
      for (const id of hops.pauses) requests.byPause.delete(id);
      requests.byId.delete(params.requestId);
    } else if (method === 'Target.detachedFromTarget' && params?.sessionId !== undefined) {
      sessions.delete(params.sessionId);
    }
  };
  const send = (message: string): void => {
    if (!SENT.some((method) => message.includes(method))) {
      write(message);
      return;
    }
    const parsed = parseCommand(message);
    const requests = sessions.get(parsed.sessionId ?? '');
    const named = parsed.params?.['requestId'];
    if (parsed.method === 'Network.getRequestPostData' && typeof named === 'string') {
      const paused = requests?.byId.get(named);
      if (paused === undefined || paused.pauses.length === 0) write(message);
      else deliver(JSON.stringify({ id: parsed.id, ...postDataAnswer(paused.posted), ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }) }));
      return;
    }
    const pauseId = parsed.method === 'Fetch.continueRequest' ? named : undefined;
    const hops = typeof pauseId === 'string' ? requests?.byPause.get(pauseId) : undefined;
    if (hops === undefined) {
      write(message);
      return;
    }
    if (hops.pauses[0] === pauseId) {
      const { requestId: _requestId, ...overrides } = parsed.params ?? {};
      hops.overrides = overrides;
      write(message);
      return;
    }
    write(JSON.stringify({ ...parsed, params: { ...hops.overrides, ...parsed.params } }));
  };
  return { receive, send };
}
