/**
 * The text of one console line, from what a browser hands over of the
 * call's arguments. Chromium's DevTools protocol gives each a remote object:
 * a class name, a preview of its first fields, an error's own description.
 * WebDriver BiDi gives a remote value: an object's entries, but no class
 * name and nothing of an error, so there the browser's own text stands
 * wherever it says more. Either way an object shows its own first fields,
 * never a nested one's, and a line stays one line of bounded parts; the
 * harness redacts and clips the whole.
 */

import type { Protocol } from 'devtools-protocol';
import type { Script } from 'webdriver-bidi-protocol';

/** How many fields, items, or entries of one logged object, array, map, or set a line shows before it ends in an ellipsis. */
const MAX_SHOWN = 5;

/**
 * The length from which Chromium cuts a string inside a preview. A string
 * that long is left out of the line: what is left of a secret the browser
 * cut would no longer match it, and so escape the harness's redaction.
 */
const PREVIEW_STRING_CUT = 100;

/** The first `MAX_SHOWN` of `parts`, with an ellipsis when there are more, or `more` says the browser left some out. */
function listed(parts: readonly string[], more = false): string {
  const shown = parts.slice(0, MAX_SHOWN);
  return more || parts.length > MAX_SHOWN ? [...shown, '…'].join(', ') : shown.join(', ');
}

/** A string as it reads inside an object or array: quoted, so an empty one and one with a comma stay apart from their neighbours. */
function quoted(text: string): string {
  return JSON.stringify(text);
}

/** One field, item, key, or value of a CDP preview, of `type` and printed by Chromium as `value`: a primitive as it is, a string quoted unless Chromium may have cut it, an object as its class name. */
function previewValue(type: string, value: string | undefined): string {
  if (type === 'string') return (value ?? '').length >= PREVIEW_STRING_CUT ? '"…"' : quoted(value ?? '');
  if (type === 'function') return 'function';
  return value ?? type;
}

/** A CDP preview of an object, array, map, or set as one bounded line; `name` is the class name it carries, none for a plain object or an array. */
function previewText(preview: Protocol.Runtime.ObjectPreview, name: string): string {
  const prefix = name === '' ? '' : `${name} `;
  if (preview.entries !== undefined) {
    const part = (side: Protocol.Runtime.ObjectPreview): string => previewValue(side.type, side.description);
    const entries = preview.entries.map((entry) => (entry.key === undefined ? part(entry.value) : `${part(entry.key)} => ${part(entry.value)}`));
    return `${prefix}{${listed(entries, preview.overflow)}}`;
  }
  if (preview.subtype === 'array' || preview.subtype === 'typedarray') return `${prefix}[${listed(preview.properties.map((item) => previewValue(item.type, item.value)), preview.overflow)}]`;
  return `${prefix}{${listed(preview.properties.map((property) => `${property.name}: ${previewValue(property.type, property.value)}`), preview.overflow)}}`;
}

/**
 * One CDP remote object as a console line shows it: a primitive as it
 * prints, an error as its own description (its message and stack), a node
 * as its tag, an object as its class name (none for a plain one) with its
 * first fields, an array as its first items, a map or set with its size and
 * first entries.
 */
function cdpText(object: Protocol.Runtime.RemoteObject): string {
  if (object.type === 'string') return String(object.value);
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.type === 'undefined' || object.type === 'function') return object.type;
  if (object.type !== 'object') return object.description ?? String(object.value);
  if (object.subtype === 'null') return 'null';
  if (object.subtype === 'node') return `<${object.description ?? 'node'}>`;
  const preview = object.preview;
  const described = object.description ?? object.className ?? 'Object';
  if (preview === undefined || object.subtype === 'error' || object.subtype === 'date' || object.subtype === 'regexp') return described;
  if (preview.entries !== undefined) return previewText(preview, described);
  if (preview.subtype === 'array') return previewText(preview, '');
  return previewText(preview, described === 'Object' ? '' : described);
}

/**
 * The line of one console call from its CDP arguments: the printf-style
 * specifiers of a leading string are filled from the arguments after it as
 * the console fills them (`%s`, `%d`, `%i`, `%f`, `%o`, `%O`; `%c` takes its
 * style and prints nothing), one with no argument left stays as written,
 * and the arguments no specifier took follow, joined by spaces.
 */
export function cdpConsoleText(args: readonly Protocol.Runtime.RemoteObject[]): string {
  const [first, ...rest] = args;
  if (first?.type !== 'string') return args.map(cdpText).join(' ');
  const left = [...rest];
  const head = String(first.value).replace(/%[sdifoOc]/g, (specifier) => {
    const arg = left.shift();
    if (arg === undefined) return specifier;
    if (specifier === '%c') return '';
    if (specifier === '%d' || specifier === '%i') return String(Number.parseInt(cdpText(arg), 10));
    if (specifier === '%f') return String(Number.parseFloat(cdpText(arg)));
    return cdpText(arg);
  });
  return [head, ...left.map(cdpText)].join(' ');
}

/**
 * The text of an exception nothing caught, from CDP's details of it: the
 * thrown error's own description (its message and stack) when Chromium
 * hands the error over, else Chromium's line for it (`Uncaught ...`).
 */
export function cdpExceptionText(details: Protocol.Runtime.ExceptionDetails): string {
  return details.exception?.subtype === 'error' ? cdpText(details.exception) : details.text;
}

/** Whether a BiDi remote value is an object, array, map, or set whose entries the browser serialized. */
function hasEntries(value: Script.RemoteValue): boolean {
  return (value.type === 'object' || value.type === 'array' || value.type === 'map' || value.type === 'set') && value.value !== undefined;
}

/** A BiDi remote value inside an object, array, map, or set: a primitive as it prints, a string quoted, anything with fields of its own as its kind. */
function nestedText(value: Script.RemoteValue | string): string {
  if (typeof value === 'string') return value;
  if (value.type === 'string') return quoted(value.value);
  if (value.type === 'object') return 'Object';
  if ((value.type === 'array' || value.type === 'map' || value.type === 'set') && value.value !== undefined) return `${kindOf(value.type)}(${String(value.value.length)})`;
  return bidiText(value);
}

/** `Array`, `Map`, `Set`: a BiDi type name as the class it names. */
function kindOf(type: string): string {
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

/**
 * One BiDi remote value as a console line shows it: a primitive as it
 * prints, an object with its first fields, an array with its first items, a
 * map or set with its size and first entries, a node as its tag, a regular
 * expression and a date as written, and anything BiDi serializes nothing of
 * (an error, a function, an instance of a platform class) as its type.
 */
function bidiText(value: Script.RemoteValue): string {
  switch (value.type) {
    case 'string':
    case 'boolean':
    case 'date':
      return String(value.value);
    case 'number':
      return String(value.value);
    case 'bigint':
      return `${value.value}n`;
    case 'regexp':
      return `/${value.value.pattern}/${value.value.flags ?? ''}`;
    case 'node':
      return `<${value.value?.localName ?? 'node'}>`;
    case 'object':
      return value.value === undefined ? 'object' : `{${listed(value.value.map(([key, field]) => `${nestedText(key)}: ${nestedText(field)}`))}}`;
    case 'array':
      return value.value === undefined ? 'array' : `[${listed(value.value.map(nestedText))}]`;
    case 'map':
      return value.value === undefined ? 'map' : `Map(${String(value.value.length)}) {${listed(value.value.map(([key, field]) => `${typeof key === 'string' ? quoted(key) : nestedText(key)} => ${nestedText(field)}`))}}`;
    case 'set':
      return value.value === undefined ? 'set' : `Set(${String(value.value.length)}) {${listed(value.value.map(nestedText))}}`;
    default:
      return value.type;
  }
}

/**
 * The line of one BiDi console entry: the browser's own `text`, which holds
 * the filled format string and an error's message, unless an argument is an
 * object, array, map, or set, of which that text gives only a size
 * (`Object(2)`); then every argument reads as its remote value does, where
 * an error is its type alone, since BiDi serializes nothing of one.
 */
export function bidiConsoleText(text: string, args: readonly Script.RemoteValue[]): string {
  return args.some(hasEntries) ? args.map(bidiText).join(' ') : text;
}
