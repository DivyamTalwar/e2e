/**
 * Fixes for four faults of the chromium-bidi mapper (still present in 159.0.8147), applied to
 * the CDP stream it reads and the commands it sends.
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
 */

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
    readonly request?: { readonly url?: string };
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

/** A CDP command of the mapper's, whole, so it can be sent on with other parameters. */
function parseCommand(message: string): { readonly method?: string; readonly sessionId?: string; readonly params?: Readonly<Record<string, unknown>> } {
  // oxlint-disable-next-line e2e/no-unchecked-json -- the mapper's own serialized command; only optional fields are read
  return JSON.parse(message) as { readonly method?: string; readonly sessionId?: string; readonly params?: Readonly<Record<string, unknown>> };
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
 * continued with. Every other message passes through in order, unparsed
 * unless it names one of the events or the command the fixups depend on.
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
   * id for the mapper's continue of it: a redirect hop's starts the hop in
   * flight, any other joins the pauses that hop already has.
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
    if (!message.includes('"Fetch.continueRequest"')) {
      write(message);
      return;
    }
    const parsed = parseCommand(message);
    const pauseId = parsed.method === 'Fetch.continueRequest' ? parsed.params?.['requestId'] : undefined;
    const hops = typeof pauseId === 'string' ? sessions.get(parsed.sessionId ?? '')?.byPause.get(pauseId) : undefined;
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
