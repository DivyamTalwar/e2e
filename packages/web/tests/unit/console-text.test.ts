/**
 * The text of a console line from a browser's own account of the call's
 * arguments: CDP remote objects, with their previews, and BiDi remote
 * values, with the browser's text beside them.
 */

import { describe, expect, it } from 'vitest';
import type { Protocol } from 'devtools-protocol';
import type { Script } from 'webdriver-bidi-protocol';
import { bidiConsoleText, cdpConsoleText, cdpExceptionText } from '../../src/driver/console-text.ts';

type RemoteObject = Protocol.Runtime.RemoteObject;

const text = (value: string): RemoteObject => ({ type: 'string', value });
const number = (value: number): RemoteObject => ({ type: 'number', value, description: String(value) });

/** A CDP object of `className` with a preview of `properties`, cut short when `overflow`. */
function object(className: string, properties: Protocol.Runtime.PropertyPreview[], overflow = false): RemoteObject {
  return { type: 'object', className, description: className, preview: { type: 'object', description: className, overflow, properties } };
}

describe('cdpConsoleText', () => {
  it('joins the arguments by spaces, each primitive as it prints', () => {
    expect(cdpConsoleText([text('plain'), number(1), { type: 'boolean', value: true }, { type: 'undefined' }, { type: 'object', subtype: 'null', value: null }, { type: 'number', unserializableValue: 'NaN' }, { type: 'bigint', unserializableValue: '12n' }, { type: 'symbol', description: 'Symbol(s)' }, { type: 'function', className: 'Function', description: '() => 1' }]))
      .toBe('plain 1 true undefined null NaN 12n Symbol(s) function');
    expect(cdpConsoleText([])).toBe('');
  });

  it('fills the specifiers of a leading string, leaves one with no argument as written, and appends the arguments none took', () => {
    expect(cdpConsoleText([text('%s is %d, %i or %f'), text('x'), number(5.9), text('7px'), text('1.5em')])).toBe('x is 5, 7 or 1.5');
    expect(cdpConsoleText([text('%c styled'), text('color: red'), text('after'), number(2)])).toBe(' styled after 2');
    expect(cdpConsoleText([text('Sale: 10%off, %s left')])).toBe('Sale: 10%off, %s left');
    expect(cdpConsoleText([text('%o and %O'), object('Object', [{ name: 'a', type: 'number', value: '1' }]), text('raw')])).toBe('{a: 1} and raw');
    expect(cdpConsoleText([text('%d'), text('none')])).toBe('NaN');
  });

  it('shows an object\'s first fields, strings quoted, a nested object as its class, and an ellipsis for what the preview left out', () => {
    const fields: Protocol.Runtime.PropertyPreview[] = [
      { name: 'code', type: 'number', value: '1006' },
      { name: 'reason', type: 'string', value: '' },
      { name: 'wasClean', type: 'boolean', value: 'false' },
      { name: 'nested', type: 'object', value: 'Object' },
      { name: 'none', type: 'object', subtype: 'null', value: 'null' },
    ];
    expect(cdpConsoleText([object('Object', fields)])).toBe('{code: 1006, reason: "", wasClean: false, nested: Object, none: null}');
    expect(cdpConsoleText([object('Object', fields, true)])).toBe('{code: 1006, reason: "", wasClean: false, nested: Object, none: null, …}');
    expect(cdpConsoleText([object('Object', [...fields, { name: 'sixth', type: 'number', value: '6' }])])).toBe('{code: 1006, reason: "", wasClean: false, nested: Object, none: null, …}');
  });

  it('names the class of an instance before its fields, and an instance with no preview by its class alone', () => {
    expect(cdpConsoleText([object('Point', [{ name: 'x', type: 'number', value: '1' }])])).toBe('Point {x: 1}');
    expect(cdpConsoleText([{ type: 'object', className: 'Event', description: 'Event' }])).toBe('Event');
  });

  it('reads an error as its own description, a node as its tag, a date and a regular expression as written', () => {
    const error: RemoteObject = { type: 'object', subtype: 'error', className: 'Error', description: 'Error: boom\n    at app.js:1:7', preview: { type: 'object', subtype: 'error', description: 'Error: boom', overflow: false, properties: [{ name: 'stack', type: 'string', value: 'Error: boom' }] } };
    expect(cdpConsoleText([text('Failed'), error])).toBe('Failed Error: boom\n    at app.js:1:7');
    expect(cdpConsoleText([{ type: 'object', subtype: 'node', className: 'HTMLBodyElement', description: 'body' }])).toBe('<body>');
    expect(cdpConsoleText([{ type: 'object', subtype: 'regexp', className: 'RegExp', description: '/re/g', preview: { type: 'object', subtype: 'regexp', description: '/re/g', overflow: false, properties: [] } }])).toBe('/re/g');
  });

  it('shows an array\'s first items and a map\'s and a set\'s first entries with their size', () => {
    const items: Protocol.Runtime.PropertyPreview[] = [
      { name: '0', type: 'number', value: '1' },
      { name: '1', type: 'string', value: 'two' },
      { name: '2', type: 'object', value: 'Object' },
    ];
    expect(cdpConsoleText([{ type: 'object', subtype: 'array', className: 'Array', description: 'Array(3)', preview: { type: 'object', subtype: 'array', description: 'Array(3)', overflow: false, properties: items } }])).toBe('[1, "two", Object]');
    const entry = (type: Protocol.Runtime.ObjectPreview['type'], description: string): Protocol.Runtime.ObjectPreview => ({ type, description, overflow: false, properties: [] });
    expect(cdpConsoleText([{ type: 'object', subtype: 'map', className: 'Map', description: 'Map(1)', preview: { type: 'object', subtype: 'map', description: 'Map(1)', overflow: false, properties: [], entries: [{ key: entry('string', 'k'), value: entry('number', '1') }] } }])).toBe('Map(1) {"k" => 1}');
    expect(cdpConsoleText([{ type: 'object', subtype: 'set', className: 'Set', description: 'Set(1)', preview: { type: 'object', subtype: 'set', description: 'Set(1)', overflow: false, properties: [], entries: [{ value: entry('object', 'Object') }] } }])).toBe('Set(1) {Object}');
  });

  it('leaves a string Chromium may have cut inside a preview out of the line, and keeps a shorter one whole', () => {
    const cut = `${'n'.repeat(100)}…`;
    expect(cdpConsoleText([object('Object', [{ name: 'note', type: 'string', value: cut }, { name: 'short', type: 'string', value: 'n'.repeat(99) }])])).toBe(`{note: "…", short: "${'n'.repeat(99)}"}`);
    expect(cdpConsoleText([text('n'.repeat(500))])).toBe('n'.repeat(500));
  });
});

describe('cdpExceptionText', () => {
  it('reads an uncaught error as its own description, and anything else as Chromium\'s line for it', () => {
    const details = { exceptionId: 1, lineNumber: 0, columnNumber: 0 };
    expect(cdpExceptionText({ ...details, text: 'Uncaught', exception: { type: 'object', subtype: 'error', className: 'RangeError', description: 'RangeError: render loop exceeded\n    at app.js:8:30' } })).toBe('RangeError: render loop exceeded\n    at app.js:8:30');
    expect(cdpExceptionText({ ...details, text: 'Uncaught a string', exception: { type: 'string', value: 'a string' } })).toBe('Uncaught a string');
    expect(cdpExceptionText({ ...details, text: 'Uncaught SyntaxError: Unexpected token' })).toBe('Uncaught SyntaxError: Unexpected token');
  });
});

describe('bidiConsoleText', () => {
  const string = (value: string): Script.RemoteValue => ({ type: 'string', value });
  const count = (value: number): Script.RemoteValue => ({ type: 'number', value });

  it('keeps the browser\'s text for a line of primitives and errors, which holds the filled format string and an error\'s message', () => {
    expect(bidiConsoleText('x is 5', [string('x is 5')])).toBe('x is 5');
    expect(bidiConsoleText('Failed TypeError: bad thing', [string('Failed'), { type: 'error' }])).toBe('Failed TypeError: bad thing');
    expect(bidiConsoleText('object', [{ type: 'object' }])).toBe('object');
  });

  it('shows an object\'s first fields in place of its size, strings quoted, a nested object, array, map, and set as its kind', () => {
    const logged: Script.RemoteValue = { type: 'object', value: [
      ['a', count(1)],
      ['reason', string('')],
      ['nested', { type: 'object', value: [['b', count(2)]] }],
      ['list', { type: 'array', value: [count(1), count(2)] }],
      ['seen', { type: 'set', value: [count(1)] }],
      ['sixth', count(6)],
    ] };
    expect(bidiConsoleText('user Object(6)', [string('user'), logged])).toBe('user {a: 1, reason: "", nested: Object, list: Array(2), seen: Set(1), …}');
  });

  it('shows an array\'s first items and a map\'s and a set\'s first entries with their size', () => {
    expect(bidiConsoleText('Array(3)', [{ type: 'array', value: [count(1), string('two'), { type: 'null' }] }])).toBe('[1, "two", null]');
    expect(bidiConsoleText('Map(1) Set(1)', [{ type: 'map', value: [['k', count(1)]] }, { type: 'set', value: [string('a')] }])).toBe('Map(1) {"k" => 1} Set(1) {"a"}');
    expect(bidiConsoleText('Map(1)', [{ type: 'map', value: [[{ type: 'object', value: [] }, { type: 'undefined' }]] }])).toBe('Map(1) {Object => undefined}');
  });

  it('reads every other argument beside an object as its remote value: an error as its type, since BiDi serializes nothing of one', () => {
    const args: Script.RemoteValue[] = [
      { type: 'object', value: [] }, { type: 'error' }, { type: 'bigint', value: '12' }, { type: 'number', value: 'NaN' }, { type: 'boolean', value: false },
      { type: 'regexp', value: { pattern: 're', flags: 'g' } }, { type: 'date', value: '1970-01-01T00:00:00.000Z' }, { type: 'node', sharedId: 'n', value: { nodeType: 1, childNodeCount: 0, localName: 'div' } },
      { type: 'function' }, { type: 'symbol' }, { type: 'window', value: { context: 'c' } }, { type: 'undefined' }, { type: 'null' },
    ];
    expect(bidiConsoleText('ignored', args)).toBe('{} error 12n NaN false /re/g 1970-01-01T00:00:00.000Z <div> function symbol window undefined null');
  });
});
