/**
 * The attempt's cookies as the `browser` fixture reads, sets, and clears
 * them: the fixture's cookie shapes over `storage.*` in the attempt's user
 * context.
 */

import type { Network, Storage } from 'webdriver-bidi-protocol';
import type { Cookie, CookieFields, CookieFilter } from '../fixture/types.ts';
import type { BidiSession } from './session.ts';

/** Where one cookie is set: on the URL it names, or on its domain and path. */
export type CookieTarget = { readonly url: string } | { readonly domain: string; readonly path: string };

/** The fields a cookie filter matches on. */
const FILTER_FIELDS = ['name', 'domain', 'path'] as const;

/** The attempt's cookies, as the fixture reports them. */
export async function readCookies(session: BidiSession): Promise<Cookie[]> {
  return (await storedCookies(session)).map(toCookie);
}

/** Stores each of `cookies` on its target in `targets` (`cookieTargets`), in the attempt's user context. */
export async function writeCookies(session: BidiSession, cookies: readonly CookieFields[], targets: readonly CookieTarget[]): Promise<void> {
  for (const [index, cookie] of cookies.entries()) {
    await session.connection.send('storage.setCookie', { cookie: partialCookie(cookie, targets[index]!), partition: session.partition() });
  }
}

/**
 * Deletes the cookies every field of `filter` matches, a string exactly and
 * a RegExp by its text; no filter deletes every one. The browser matches
 * strings itself; a RegExp is matched here, against the cookies it holds.
 */
export async function deleteCookies(session: BidiSession, filter: CookieFilter | undefined): Promise<void> {
  const filters = FILTER_FIELDS.every((field) => typeof filter?.[field] !== 'object')
    ? [Object.fromEntries(FILTER_FIELDS.flatMap((field) => (filter?.[field] === undefined ? [] : [[field, filter[field]]])))]
    : (await storedCookies(session))
        .filter((cookie) => FILTER_FIELDS.every((field) => {
          const wanted = filter?.[field];
          return wanted === undefined || (typeof wanted === 'string' ? cookie[field] === wanted : new RegExp(wanted.source, wanted.flags).test(cookie[field]));
        }))
        .map(({ name, domain, path }) => ({ name, domain, path }));
  for (const each of filters) await session.connection.send('storage.deleteCookies', { filter: each, partition: session.partition() });
}

/** The cookies of the attempt's user context, as the browser holds them. */
async function storedCookies(session: BidiSession): Promise<Network.Cookie[]> {
  return (await session.connection.send('storage.getCookies', { partition: session.partition() })).cookies;
}

/** A fixture cookie as the browser stores it on `target`: a URL gives its host, its directory as the path, and `secure` for `https:`. */
function partialCookie(cookie: CookieFields, target: CookieTarget): Storage.PartialCookie {
  const url = 'url' in target ? new URL(target.url) : undefined;
  return {
    name: cookie.name,
    value: { type: 'string', value: cookie.value },
    domain: url?.hostname ?? ('domain' in target ? target.domain : ''),
    path: url === undefined ? ('path' in target ? target.path : '/') : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1),
    ...(cookie.expires !== undefined && cookie.expires >= 0 ? { expiry: Math.floor(cookie.expires) } : {}),
    ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
    secure: cookie.secure ?? url?.protocol === 'https:',
    ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite.toLowerCase() as Network.SameSite } : {}),
  };
}

/** A BiDi cookie as the fixture reports it. */
function toCookie(cookie: Network.Cookie): Cookie {
  return {
    name: cookie.name,
    value: cookie.value.type === 'string' ? cookie.value.value : Buffer.from(cookie.value.value, 'base64').toString(),
    domain: cookie.domain,
    path: cookie.path,
    ...(cookie.expiry === undefined ? {} : { expires: cookie.expiry }),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(cookie.sameSite === 'default' ? {} : { sameSite: (cookie.sameSite[0]!.toUpperCase() + cookie.sameSite.slice(1)) as NonNullable<Cookie['sameSite']> }),
  };
}
