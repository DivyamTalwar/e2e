/**
 * Page functions that change what a control holds, and the reads that
 * decide them: focus, a field's value, a select's option, a file input's
 * files, a checkable's state, and text typed where focus is.
 */

import { withDom, type Outcome } from './dom.ts';

/**
 * Focuses an element, unless it is out of the document, where a key pressed
 * after would reach whatever else holds focus. One that takes no focus keeps
 * the old one, as Playwright's `focus` leaves it.
 */
export function focus(element: Element): Outcome {
  if (!element.isConnected) return { kind: 'detached' };
  (element as HTMLElement).focus();
  return { kind: 'ok' };
}

/**
 * A checkable's state and kind, as Playwright reads it: a checkable role
 * without `aria-checked` is unchecked. Refused for an element with no
 * checked state.
 */
export function checkState(element: Element): Outcome<{ checked: boolean; radio: 'native' | 'aria' | null }> {
  if (!element.isConnected) return { kind: 'detached' };
  const role = (element.getAttribute('role') ?? '').trim().split(/\s+/)[0] ?? '';
  const input = element.nodeName === 'INPUT' ? (element as HTMLInputElement) : null;
  const radio = input?.type === 'radio' ? 'native' : role === 'radio' || role === 'menuitemradio' ? 'aria' : null;
  if (input !== null && (input.type === 'checkbox' || input.type === 'radio')) return { kind: 'ok', checked: input.checked, radio };
  if (['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem'].includes(role)) return { kind: 'ok', checked: element.getAttribute('aria-checked') === 'true', radio };
  return { kind: 'refused', reason: 'Not a checkbox or radio button' };
}

/**
 * Fills an element as Playwright's `fill` does, with no key events: a text
 * field or editing host is focused, its content selected, and the value
 * inserted as one `insertText` edit (a delete for an empty value), so the app
 * sees the trusted `beforeinput` and `input` an edit fires. A date, color,
 * range, or similar input takes the value directly, with `input` and
 * `change`. Nothing changes until the element proved editable and took
 * focus, and nothing of an element out of the document. Not yet while the
 * field is disabled or read-only; refused for what no fill can do.
 */
export const fill = withDom((dom, element: Element, value: string): Outcome => {
  if (!element.isConnected) return { kind: 'detached' };
  const typed = ['', 'text', 'password', 'search', 'email', 'tel', 'url', 'number'];
  const unfocused: Outcome<never> = { kind: 'refused', reason: 'element could not be focused' };
  const field = element.nodeName === 'INPUT' || element.nodeName === 'TEXTAREA' ? (element as HTMLInputElement | HTMLTextAreaElement) : null;
  if (field !== null) {
    const type = field.nodeName === 'INPUT' ? (field as HTMLInputElement).type.toLowerCase() : 'textarea';
    if (['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image'].includes(type)) return { kind: 'refused', reason: `Input of type "${type}" cannot be filled` };
    if (field.disabled || field.readOnly) return { kind: 'not-yet', reason: 'element is not editable' };
    if (type === 'number' && Number.isNaN(Number(value.trim()))) return { kind: 'refused', reason: 'Cannot type text into input[type=number]' };
    if (!dom.focus(element)) return unfocused;
    if (type !== 'textarea' && !typed.includes(type)) {
      // As Playwright 1.65: the browser sanitizes what it does not take, as for a person's input.
      field.value = value.trim();
      dom.fireEdit(field);
      return { kind: 'ok' };
    }
    field.select();
  } else if ((element as HTMLElement).isContentEditable) {
    if (!dom.focus(element)) return unfocused;
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } else {
    return { kind: 'refused', reason: 'Element is not an <input>, <textarea> or [contenteditable] element' };
  }
  const edited = value === '' ? document.execCommand('delete') : document.execCommand('insertText', false, value);
  const number = field !== null && field.nodeName === 'INPUT' && (field as HTMLInputElement).type === 'number';
  if (field !== null && (!edited || (number && field.value !== value))) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value);
    dom.fireEdit(field);
  }
  if (number && field.value !== value) return { kind: 'refused', reason: 'Malformed value' };
  return { kind: 'ok' };
});

/** Which option `selectOption` picks: by its label, value, or index. */
export interface OptionChoice {
  readonly label?: string;
  readonly value?: string;
  readonly index?: number;
}

/**
 * Selects the option of a `<select>` matching `by` and fires `input` and
 * `change`, as Playwright's `selectOption` does. Nothing of an element out
 * of the document changes. Not yet while the select or the option is
 * disabled, or no option matches; refused for an element that is no
 * `<select>`.
 */
export const selectOption = withDom((dom, element: Element, by: OptionChoice): Outcome => {
  if (!element.isConnected) return { kind: 'detached' };
  if (element.nodeName !== 'SELECT') return { kind: 'refused', reason: 'Element is not a <select> element' };
  const select = element as HTMLSelectElement;
  if (select.disabled) return { kind: 'not-yet', reason: 'element is not enabled' };
  const options = [...select.options];
  const option = by.index !== undefined ? options[by.index]
    : by.value !== undefined ? options.find((each) => each.value === by.value)
    : options.find((each) => each.label === by.label || each.textContent?.trim() === by.label);
  if (option === undefined) return { kind: 'not-yet', reason: 'no option matches' };
  if (option.disabled || option.closest('optgroup')?.disabled === true) return { kind: 'not-yet', reason: 'option being selected is not enabled' };
  select.focus();
  for (const each of options) each.selected = each === option;
  dom.fireEdit(select);
  return { kind: 'ok' };
});

/** One file an upload sends a browser on another machine as bytes. */
export type FileBytes = {
  readonly name: string;
  readonly type: string;
  readonly lastModified: number;
  readonly base64: string;
};

/**
 * Gives a file input files sent to it as bytes, as a person picking them
 * would: each a `File` with its name, type, and last-modified time, then
 * `input` and `change`. For a browser on another machine, whose filesystem
 * holds none of them.
 */
export const setFileBytes = withDom((dom, element: Element, files: readonly FileBytes[]): void => {
  const input = element as HTMLInputElement;
  const transfer = new DataTransfer();
  for (const file of files) {
    const binary = atob(file.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    transfer.items.add(new File([bytes], file.name, { type: file.type, lastModified: file.lastModified }));
  }
  input.files = transfer.files;
  dom.fireEdit(input);
});

/** The file input an element is or labels; null for anything else. */
export function fileInput(element: Element): HTMLInputElement | null {
  const control = element instanceof HTMLInputElement ? element : element.closest('label')?.control;
  return control instanceof HTMLInputElement && control.type === 'file' ? control : null;
}

/** What a file input takes: a directory (`webkitdirectory`), and more than one file (`multiple`). */
export function fileInputTakes(element: Element): { directory: boolean; multiple: boolean } {
  const input = element as HTMLInputElement;
  return { directory: input.webkitdirectory === true, multiple: input.multiple };
}

/**
 * Inserts each of `graphemes` where focus is in this document, one edit
 * each, as an IME would commit it (Playwright's `insertText`): for
 * characters no key of the keyboard types. Answers how many it inserted. It
 * stops at the first this document does not take: it does not hold focus,
 * its focus is an iframe whose own document does, or the edit was refused.
 */
export const insertFocusedText = withDom((dom, graphemes: readonly string[]): number => {
  let inserted = 0;
  for (const text of graphemes) {
    if (!document.hasFocus()) break;
    const active = dom.activeElement();
    if (active === null || active.nodeName === 'IFRAME' || active.nodeName === 'FRAME') break;
    if (!document.execCommand('insertText', false, text)) break;
    inserted += 1;
  }
  return inserted;
});

/** Whether the focused element of this document takes keystrokes, following focus into open and recorded closed shadow roots. */
export const focusTakesKeys = withDom((dom): boolean => {
  const active = dom.activeElement();
  if (active === null || active === document.body || active === document.documentElement) return false;
  if (active instanceof HTMLInputElement) {
    return !active.disabled && !active.readOnly && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(active.type);
  }
  if (active instanceof HTMLTextAreaElement) return !active.disabled && !active.readOnly;
  if (active instanceof HTMLSelectElement || active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement ||
      active instanceof HTMLIFrameElement || active instanceof HTMLFrameElement) {
    return false;
  }
  return true;
});
