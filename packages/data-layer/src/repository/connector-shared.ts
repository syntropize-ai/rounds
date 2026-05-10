import type {
  ConnectorCategory,
  ConnectorType,
  ConnectorConfig,
  ConnectorPolicyScope,
} from '@agentic-obs/common';
import { CONNECTOR_TEMPLATE_BY_TYPE } from '@agentic-obs/common';

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function toBool(value: number | boolean): boolean {
  return value === true || value === 1;
}

export function fromBool(value?: boolean): number {
  return value ? 1 : 0;
}

export function parseJson<T>(raw: string | T | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return raw;
  return JSON.parse(raw) as T;
}

export function stringifyJson(value: ConnectorConfig | ConnectorPolicyScope | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

export function capabilitiesForType(type: ConnectorType): string[] {
  return [...CONNECTOR_TEMPLATE_BY_TYPE[type].capabilities];
}

export function typeMatchesCategory(type: ConnectorType, category?: ConnectorCategory): boolean {
  if (!category) return true;
  return CONNECTOR_TEMPLATE_BY_TYPE[type].category.includes(category);
}
