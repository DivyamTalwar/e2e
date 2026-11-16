/**
 * `cookieTargets`, where each cookie of `browser.setCookies` lands: a cookie
 * that names its own `url` or `domain` needs no app URL, so it is set on a
 * target with none (`attachBrowser`), and one that names neither is refused
 * by name.
 */

import { describe, expect, it } from 'vitest';
import { ConfigurationError, type EngineFixtureContext } from '@e2e-dev/core/engine';
import { cookieTargets } from '../../src/fixture/arguments.ts';
import type { Cookie } from '../../src/fixture/types.ts';

/** A fixture context whose app resolves URLs as the harness does: against `base`, or `APP_URL_REQUIRED` for a relative one without it. */
function contextOf(base: string | undefined): EngineFixtureContext {
  const resolveUrl = (url: string): string => {
    if (base === undefined && !URL.canParse(url)) throw new ConfigurationError('APP_URL_REQUIRED', `navigation to "${url}" needs an app URL; the target declares no app.url`);
    return new URL(url, base).href;
  };
  return { app: { ...(base === undefined ? {} : { site: new URL(base).hostname }), resolveUrl } } as unknown as EngineFixtureContext;
}

describe('cookieTargets', () => {
  it('lands a url cookie on the URL it resolves to and a domain cookie on its domain and path', () => {
    expect(cookieTargets([
      { name: 'a', value: '1', url: '/account' },
      { name: 'b', value: '2', domain: '.app.test' },
      { name: 'c', value: '3', domain: 'app.test', path: '/admin' },
    ], contextOf('https://app.test/'))).toEqual([{ url: 'https://app.test/account' }, { domain: '.app.test', path: '/' }, { domain: 'app.test', path: '/admin' }]);
  });

  it('needs no app URL for a cookie that names its own url or domain', () => {
    expect(cookieTargets([
      { name: 'a', value: '1', url: 'https://other.test/account' },
      { name: 'b', value: '2', domain: 'other.test' },
    ], contextOf(undefined))).toEqual([{ url: 'https://other.test/account' }, { domain: 'other.test', path: '/' }]);
  });

  it('refuses a relative url without an app URL, a target that is not http(s), and a cookie that names neither', () => {
    expect(() => cookieTargets([{ name: 'a', value: '1', url: '/account' }], contextOf(undefined))).toThrow(expect.objectContaining({ code: 'APP_URL_REQUIRED' }));
    expect(() => cookieTargets([{ name: 'a', value: '1', url: 'about:blank' }], contextOf(undefined))).toThrow(expect.objectContaining({ code: 'POLICY_DENIED', message: 'cookie URL must be http(s): about:blank' }));
    for (const base of ['https://app.test/', undefined]) {
      expect(() => cookieTargets([{ name: 'nowhere', value: '1' } as unknown as Cookie], contextOf(base))).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT', message: 'browser.setCookies: cookie "nowhere" needs a url or a domain' }),
      );
    }
  });
});
