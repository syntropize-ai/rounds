/**
 * Escape double-quote characters inside a label value.
 * Prevents injection through label matchers like `service="..."`.
 */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
