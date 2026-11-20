/**
 * The object form of `app.launchArguments` (`EngineAppInfo.namedLaunchArguments`),
 * spelled as iOS process arguments, `-name value`, which the app reads
 * through `NSUserDefaults`. Android takes the list form only: an `am start`
 * extra carries a type the app's `Intent` getter must match, and an object's
 * value does not say which (`1` could be an int, a long, or a float). A list
 * is handed over as it is.
 */

import { TestError, checkLaunchArguments, type LaunchArgumentValue, type ResolvedLaunchArguments } from '@e2e-dev/core/engine';
import type { MobilePlatform } from './options.ts';

/** What an old-style plist string may hold unquoted. `NSUserDefaults` reads a bare value that starts with `-` as the next argument's name. */
const PLIST_UNQUOTED = /^[A-Za-z0-9_$/:.][A-Za-z0-9_$/:.-]*$/;

/**
 * The launch arguments a test hands `device.openApp`, checked like the
 * target's: the declared shape, then the object form refused on Android,
 * with `INVALID_ARGUMENT`.
 */
export function launchArgumentsForOpen(platform: MobilePlatform, declared: unknown): ResolvedLaunchArguments | undefined {
  const label = 'device.openApp({ launchArguments })';
  const launchArguments = checkLaunchArguments(label, declared, 'INVALID_ARGUMENT');
  if (platform === 'android' && launchArguments !== undefined && !Array.isArray(launchArguments)) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `${label} is an object, which only an iOS app takes; on Android give the am start arguments as a list, such as ['--ez', 'e2e', 'true']`,
    );
  }
  return launchArguments;
}

/** The arguments a launch passes the platform's launch command; undefined when there are none. */
export function launchArgumentList(launchArguments: ResolvedLaunchArguments | undefined): readonly string[] | undefined {
  if (launchArguments === undefined) return undefined;
  const list = Array.isArray(launchArguments) ? launchArguments : Object.entries(launchArguments).flatMap(([name, value]) => iosArgument(name, value));
  return list.length === 0 ? undefined : list;
}

/**
 * `-name value` as `NSUserDefaults` reads it: `YES` or `NO` for a boolean,
 * an old-style plist array for a list, and a quoted plist string for a
 * value the parser would otherwise misread, such as `(draft)` or `-1`.
 */
function iosArgument(name: string, value: LaunchArgumentValue): string[] {
  if (typeof value === 'boolean') return [`-${name}`, value ? 'YES' : 'NO'];
  if (typeof value === 'number' || typeof value === 'string') return [`-${name}`, plistString(String(value))];
  return [`-${name}`, `(${value.map(plistString).join(', ')})`];
}

/** An old-style plist string: bare when its characters allow, else quoted with `\\` and `"` escaped. */
function plistString(item: string): string {
  return PLIST_UNQUOTED.test(item) ? item : `"${item.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
