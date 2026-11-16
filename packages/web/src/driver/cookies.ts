/**
 * A user context's cookie jar over `storage.*`: the cookies as the browser
 * holds them, and as the `browser` fixture reads, sets, and clears them.
 */

import type { Network, Storage } from 'webdriver-bidi-protocol';
import type { BidiConnection } from './connection.ts';
import type { BidiSession } from './session.ts';

/** What every cookie carries, whichever way it names its site. */
export interface CookieFields {
  /** Cookie name. */
  name: string;
  /** Cookie value. */
  value: string;
  /** Unix timestamp in whole seconds. */
  expires?: number;
  /** HttpOnly flag. */
  httpOnly?: boolean;
  /** Secure flag. */
  secure?: boolean;
  /** SameSite attribute. */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** `url`, or `domain` with an optional `path`, never both. */
export type Cookie = CookieFields &
  (
    | { url: string; domain?: never; path?: never }
    | { url?: never; domain: string; path?: string }
  );

/** Cookie filters are combined; strings match exactly, RegExp matches the field. */
export interface CookieFilter {
  name?: string | RegExp;
  domain?: string | RegExp;
  path?: string | RegExp;
}

/** Where one cookie is set: on the URL it names, or on its domain and path. */
export type CookieTarget = { readonly url: string } | { readonly domain: string; readonly path: string };

/** The fields a cookie filter matches on. */
const FILTER_FIELDS = ['name', 'domain', 'path'] as const;

/** The attempt's cookies, as the fixture reports them. */
export async function readCookies(session: BidiSession): Promise<Cookie[]> {
  return (await storedCookies(session.connection, session.userContext)).map(toCookie);
}

/** Stores each of `cookies` on its target in `targets` (`cookieTargets`), in the attempt's user context. */
export async function writeCookies(session: BidiSession, cookies: readonly CookieFields[], targets: readonly CookieTarget[]): Promise<void> {
  for (const [index, cookie] of cookies.entries()) await storeCookie(session.connection, session.userContext, partialCookie(cookie, targets[index]!));
}

/**
 * Deletes the cookies every field of `filter` matches, a string exactly and
 * a RegExp by its text; no filter deletes every one. The browser matches
 * strings itself; a RegExp is matched here, against the cookies it holds.
 */
export async function deleteCookies(session: BidiSession, filter: CookieFilter | undefined): Promise<void> {
  const filters = FILTER_FIELDS.every((field) => typeof filter?.[field] !== 'object')
    ? [Object.fromEntries(FILTER_FIELDS.flatMap((field) => (filter?.[field] === undefined ? [] : [[field, filter[field]]])))]
    : (await storedCookies(session.connection, session.userContext))
        .filter((cookie) => FILTER_FIELDS.every((field) => {
          const wanted = filter?.[field];
          return wanted === undefined || (typeof wanted === 'string' ? cookie[field] === wanted : new RegExp(wanted.source, wanted.flags).test(cookie[field]));
        }))
        .map(({ name, domain, path }) => ({ name, domain, path }));
  for (const each of filters) await session.connection.send('storage.deleteCookies', { filter: each, partition: partition(session.userContext) });
}

/** The cookies of `userContext`, as the browser holds them. */
export async function storedCookies(connection: BidiConnection, userContext: string): Promise<Network.Cookie[]> {
  return (await connection.send('storage.getCookies', { partition: partition(userContext) })).cookies;
}

/** Stores one cookie in `userContext`'s jar. */
export async function storeCookie(connection: BidiConnection, userContext: string, cookie: Storage.PartialCookie): Promise<void> {
  await connection.send('storage.setCookie', { cookie, partition: partition(userContext) });
}

/** The cookie partition of a user context. */
function partition(userContext: string): Storage.StorageKeyPartitionDescriptor {
  return { type: 'storageKey', userContext };
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
