/** The BiDi `browser` fixture's own adapters: Playwright key names as WebDriver key sources. */

import { describe, expect, it } from 'vitest';
import { fixtureKeyStroke, strokeSource, type KeyPhase } from '../../src/driver/keyboard.ts';

const SHIFT = '';

/** The BiDi key source of one `browser.keyboard` call, with Shift held before it or not. */
function fixtureKeySource(key: string, phase: KeyPhase, shiftHeld: boolean) {
  return strokeSource(fixtureKeyStroke(key, phase), shiftHeld);
}

describe('fixtureKeyStroke', () => {
  it('holds a bare modifier and upper-cases a letter while Shift is held', () => {
    expect(fixtureKeySource('Shift', 'keyDown', false).actions).toEqual([{ type: 'keyDown', value: SHIFT }]);
    expect(fixtureKeySource('KeyB', 'press', true).actions).toEqual([{ type: 'keyDown', value: 'B' }, { type: 'keyUp', value: 'B' }]);
    expect(fixtureKeySource('KeyB', 'press', false).actions).toEqual([{ type: 'keyDown', value: 'b' }, { type: 'keyUp', value: 'b' }]);
    expect(fixtureKeySource('Digit7', 'press', false).actions[0]).toEqual({ type: 'keyDown', value: '7' });
    expect(fixtureKeySource('A', 'press', false).actions[0]).toEqual({ type: 'keyDown', value: 'A' });
    expect(fixtureKeySource('a', 'press', true).actions[0]).toEqual({ type: 'keyDown', value: 'A' });
  });

  it('presses modifiers around the key of a combination, including the plus key itself', () => {
    expect(fixtureKeySource('Shift+KeyA', 'press', false).actions).toEqual([
      { type: 'keyDown', value: SHIFT },
      { type: 'keyDown', value: 'A' },
      { type: 'keyUp', value: 'A' },
      { type: 'keyUp', value: SHIFT },
    ]);
    expect(fixtureKeySource('Shift++', 'press', false).actions[1]).toEqual({ type: 'keyDown', value: '+' });
  });

  it('refuses a combination to hold, a non-modifier prefix, and an unknown name', () => {
    expect(() => fixtureKeySource('Shift+a', 'keyDown', false)).toThrow('keyboard.down cannot read the key "Shift+a"');
    expect(() => fixtureKeySource('a+b', 'press', false)).toThrow('"a" in "a+b" is not a modifier');
    expect(() => fixtureKeySource('Hyper', 'press', false)).toThrow('Unknown key: "Hyper"');
  });
});
