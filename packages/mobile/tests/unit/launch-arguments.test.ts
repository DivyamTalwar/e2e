import { describe, expect, it } from 'vitest';
import { launchArgumentList, launchArgumentsForOpen } from '../../src/launch-arguments.ts';

describe('launchArgumentList', () => {
  it('passes a list through as given and sends nothing for none', () => {
    expect(launchArgumentList(['-e2e', 'YES'])).toEqual(['-e2e', 'YES']);
    expect(launchArgumentList(['--ez', 'e2e', 'true'])).toEqual(['--ez', 'e2e', 'true']);
    expect(launchArgumentList(undefined)).toBeUndefined();
    expect(launchArgumentList([])).toBeUndefined();
    expect(launchArgumentList({})).toBeUndefined();
  });

  it('spells an object as iOS process arguments', () => {
    expect(launchArgumentList({ AppleLocale: 'fr_FR', e2e: true, dark: false, retries: 3, ratio: 1.5, url: 'http://localhost:8081/x.json' })).toEqual([
      '-AppleLocale', 'fr_FR',
      '-e2e', 'YES',
      '-dark', 'NO',
      '-retries', '3',
      '-ratio', '1.5',
      '-url', 'http://localhost:8081/x.json',
    ]);
    expect(launchArgumentList({ AppleLanguages: ['fr'] })).toEqual(['-AppleLanguages', '(fr)']);
    expect(launchArgumentList({ AppleLanguages: ['fr', 'en-GB', 'zh-Hans'] })).toEqual(['-AppleLanguages', '(fr, en-GB, zh-Hans)']);
  });

  it('quotes a string NSUserDefaults would otherwise read as a plist, as a value and as a list item', () => {
    expect(launchArgumentList({ title: '(draft)', greeting: 'a b', json: '{a=b;}', quoted: 'say "hi"' })).toEqual([
      '-title', '"(draft)"',
      '-greeting', '"a b"',
      '-json', '"{a=b;}"',
      '-quoted', '"say \\"hi\\""',
    ]);
    expect(launchArgumentList({ names: ['a b', 'say "hi"', 'back\\slash', 'x,y', 'ok_1.2:3/4-5$'] })).toEqual([
      '-names',
      '("a b", "say \\"hi\\"", "back\\\\slash", "x,y", ok_1.2:3/4-5$)',
    ]);
    expect(launchArgumentList({ empty: [] })).toEqual(['-empty', '()']);
  });

  it('quotes a value that starts with a dash, which NSUserDefaults would read as the next name', () => {
    expect(launchArgumentList({ offset: -1, ratio: -0.5, mode: '-x', range: 'a-b' })).toEqual([
      '-offset', '"-1"',
      '-ratio', '"-0.5"',
      '-mode', '"-x"',
      '-range', 'a-b',
    ]);
    expect(launchArgumentList({ flags: ['-x', 'y'] })).toEqual(['-flags', '("-x", y)']);
  });
});

describe('launchArgumentsForOpen', () => {
  it('checks the declared shape, refuses an object on Android, and leaves out an undefined value', () => {
    expect(launchArgumentsForOpen('ios', { reset: true, env: undefined })).toEqual({ reset: true });
    expect(launchArgumentsForOpen('ios', ['-reset'])).toEqual(['-reset']);
    expect(launchArgumentsForOpen('ios', undefined)).toBeUndefined();
    expect(() => launchArgumentsForOpen('ios', { env: null })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: 'device.openApp({ launchArguments }).env must be a string, number, boolean, or array of strings, got null' }),
    );
    expect(() => launchArgumentsForOpen('ios', ['-a', 1])).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => launchArgumentsForOpen('android', { e2e: true })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('is an object, which only an iOS app takes') }),
    );
    expect(launchArgumentsForOpen('android', ['--ez', 'e2e', 'true'])).toEqual(['--ez', 'e2e', 'true']);
  });
});
