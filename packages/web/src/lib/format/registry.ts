import type { ValueFormatter } from './types';
import {
  formatDecimal,
  formatPercent,
  formatPercentUnit,
  formatShort,
} from './number';
import { formatBitsSI, formatBytes, formatBytesSI } from './bytes';
import { formatDateTime, formatDurationMs, formatDurationSeconds } from './time';
import { makeRateFormatter } from './formatRate';

/** Opaque unit id string. Known values are documented in the README and below. */
export type UnitId = string;

interface RegistryEntry {
  fmt: ValueFormatter;
  label: string;
}

const registry = new Map<UnitId, RegistryEntry>();

/** Default formatter used when a requested unit id is unknown or undefined. */
const DEFAULT_FORMATTER: ValueFormatter = formatShort;

/**
 * Register (or replace) a formatter for a unit id.
 * Replacing is intentional so tests and plugins can override built-ins.
 */
export function registerFormatter(
  id: UnitId,
  fmt: ValueFormatter,
  label?: string,
): void {
  const existingLabel = registry.get(id)?.label;
  registry.set(id, { fmt, label: label ?? existingLabel ?? id });
}

/** Lookup a formatter; returns the default (formatShort) for unknown ids. */
export function getFormatter(id: UnitId | undefined): ValueFormatter {
  if (!id) return DEFAULT_FORMATTER;
  const entry = registry.get(id);
  return entry ? entry.fmt : DEFAULT_FORMATTER;
}

/** Enumerate registered units for UI pickers. Order is insertion order. */
export function listUnits(): Array<{ id: UnitId; label: string }> {
  const out: Array<{ id: UnitId; label: string }> = [];
  for (const [id, entry] of registry) {
    out.push({ id, label: entry.label });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-in registrations. Runs once at module load. Pure w.r.t. external state.
// ---------------------------------------------------------------------------

registerFormatter('none', (v, d) => formatDecimal(v, d ?? 2), 'None');
registerFormatter('short', formatShort, 'Short (SI)');

registerFormatter('percent', formatPercent, 'Percent (0-100)');
registerFormatter('percentunit', formatPercentUnit, 'Percent (0.0-1.0)');

registerFormatter('bytes', formatBytes, 'Bytes (IEC)');
registerFormatter('decbytes', formatBytes, 'Bytes (IEC)');
registerFormatter('bytes_si', formatBytesSI, 'Bytes (SI)');
registerFormatter('decbytes_si', formatBytesSI, 'Bytes (SI)');

registerFormatter('bps', formatBitsSI, 'Bits/sec (SI)');
registerFormatter('Bps', makeRateFormatter('B'), 'Bytes/sec');
registerFormatter('bytesps', makeRateFormatter('B'), 'Bytes/sec');

registerFormatter('s', formatDurationSeconds, 'Seconds');
registerFormatter('seconds', formatDurationSeconds, 'Seconds');
registerFormatter('ms', formatDurationMs, 'Milliseconds');
registerFormatter('milliseconds', formatDurationMs, 'Milliseconds');

registerFormatter('reqps', makeRateFormatter('req'), 'Requests/sec');
registerFormatter('rps', makeRateFormatter('req'), 'Requests/sec');
registerFormatter('qps', makeRateFormatter('req'), 'Requests/sec');
registerFormatter('req/s', makeRateFormatter('req'), 'Requests/sec');
registerFormatter('ops', makeRateFormatter('ops'), 'Operations/sec');
registerFormatter('opsps', makeRateFormatter('ops'), 'Operations/sec');
registerFormatter('ops/s', makeRateFormatter('ops'), 'Operations/sec');

registerFormatter('dateTime', formatDateTime, 'Date & time');
