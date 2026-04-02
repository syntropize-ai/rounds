// Cache layer types and TTL policy constants
// — TTL policy by domain entity type —
export const CACHE_TTL = {
  /** Active investigations change frequently — 5 minute window. */
  INVESTIGATION: 5 * 60,
  /** Sessions are longer-lived — 30 minute window. */
  SESSION: 30 * 60,
  /** Incidents are queried often but change less — 10 minute window. */
  INCIDENT: 10 * 60,
  /** Cases are relatively stable — 15 minute window. */
  CASE: 15 * 60,
};
//# sourceMappingURL=types.js.map
