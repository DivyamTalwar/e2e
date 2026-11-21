/** The harness-side check of a `press` key against the contract's key grammar. */

import { KEY_MODIFIERS, KEY_NAMES, REMOTE_KEY_NAMES, parseKey, type RemoteKeyName } from '../engine/contract.ts';
import { ConfigurationError, TestError } from './errors.ts';

/** The keyboard key a remote button's name most likely meant on a target with no remote. */
const KEYBOARD_FOR_REMOTE: Readonly<Partial<Record<RemoteKeyName, string>>> = {
  home: 'Home',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  select: 'Enter',
  back: 'Escape',
};

/**
 * Throws `INVALID_ARGUMENT` for anything but a key in the grammar `parseKey`
 * accepts, and `UNSUPPORTED_CAPABILITY` for a TV remote key when the
 * target's engine does not declare `remoteKeys`, naming the keyboard key of
 * the same word when there is one.
 */
export function requireKey(key: unknown, remoteKeys: boolean): asserts key is string {
  const parsed = typeof key === 'string' ? parseKey(key) : undefined;
  if (parsed === undefined) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `press key ${JSON.stringify(key)} is not a key: use zero or more modifiers (${KEY_MODIFIERS.join(', ')}) ` +
        `and one key joined by "+", where the key is a single character or one of ${KEY_NAMES.join(', ')}, ` +
        `or one TV remote button with no modifier (${REMOTE_KEY_NAMES.join(', ')}) ` +
        '(for example "Enter", "Control+a", "Shift+Tab", "menu")',
    );
  }
  if (parsed.key.kind !== 'remote' || remoteKeys) return;
  const keyboard = KEYBOARD_FOR_REMOTE[parsed.key.name];
  throw new ConfigurationError(
    'UNSUPPORTED_CAPABILITY',
    `"${parsed.key.name}" is a TV remote key, and this target's engine does not declare remoteKeys` +
      (keyboard === undefined ? '' : `; for the keyboard key press "${keyboard}"`),
  );
}
