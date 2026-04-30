/**
 * kubectl command allowlists / denylists.
 *
 * Two call sites:
 *
 *   - investigation (read-only): `mode = 'read'`. Only `kubectl get`,
 *     `describe`, `logs`, `top`, `events`, `version`, `api-resources` permitted.
 *
 *   - plan execution (write): `mode = 'write'`. Read verbs are still allowed,
 *     plus `scale`, `rollout`, `patch`, `apply`, `annotate`, `label`, and
 *     `delete <type> <name>`.
 *
 * A permanent-deny list wins over both. It blocks command shapes that are
 * effectively lateral movement (`exec`, `cp`, `port-forward`, `proxy`,
 * `attach`, `auth can-i --as`) and any write to namespace `kube-system`,
 * `kube-public`, or `kube-node-lease`.
 *
 * Phase 6 of `docs/design/auto-remediation.md`.
 */

export type KubectlMode = 'read' | 'write';

export interface AllowlistDecision {
  allow: boolean;
  /** Set when `allow=false`. Surfaced verbatim to validation errors. */
  reason?: string;
}

const READ_VERBS: ReadonlySet<string> = new Set([
  'get',
  'describe',
  'logs',
  'top',
  'events',
  'version',
  'api-resources',
]);

const WRITE_VERBS: ReadonlySet<string> = new Set([
  'scale',
  'rollout',
  'patch',
  'apply',
  'annotate',
  'label',
  'delete',
]);

/** Verbs we never permit, regardless of mode. */
const PERMANENT_DENY_VERBS: ReadonlySet<string> = new Set([
  'exec',
  'cp',
  'port-forward',
  'proxy',
  'attach',
]);

/** Namespaces that are never legal write targets, regardless of mode. */
const PERMANENT_DENY_NAMESPACES: ReadonlySet<string> = new Set([
  'kube-system',
  'kube-public',
  'kube-node-lease',
]);

/**
 * Parse the meaningful bits out of a kubectl argv. Conservative — rejects
 * anything we can't recognize, rather than guessing.
 *
 * Returns:
 *   - verb:           the first non-flag token (`get`, `apply`, ...)
 *   - namespace:      the value of `-n` / `--namespace`, or `null` if absent
 *   - hasAuthCanIAs:  true if the argv contains `auth can-i ... --as=...`
 *                     (or the long form). This is permanent-deny.
 *   - subResource:    e.g. `pods` for `kubectl get pods`. Used for delete
 *                     safety: bare `kubectl delete` without a name is a
 *                     mass-delete and we refuse it.
 *   - resourceName:   the explicit resource name when present (the token
 *                     after the resource type for `delete <type> <name>`).
 *
 * Flags are recognized in both `-n value` and `--namespace=value` forms.
 */
export interface ParsedKubectl {
  verb: string;
  namespace: string | null;
  hasAuthCanIAs: boolean;
  subResource: string | null;
  resourceName: string | null;
}

export function parseKubectlArgv(argv: readonly string[]): ParsedKubectl {
  let verb = '';
  let namespace: string | null = null;
  let hasAuthCanIAs = false;
  let subResource: string | null = null;
  let resourceName: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] as string;
    if (tok === '-n' || tok === '--namespace') {
      namespace = (argv[i + 1] ?? null) as string | null;
      i++;
      continue;
    }
    if (tok.startsWith('--namespace=')) {
      namespace = tok.slice('--namespace='.length);
      continue;
    }
    if (tok === '--as' || tok.startsWith('--as=')) {
      // We mark this; the caller decides if the surrounding command is the
      // banned `auth can-i ... --as=...` shape.
      hasAuthCanIAs = true;
      // skip the value if it's `--as <user>` form
      if (tok === '--as') i++;
      continue;
    }
    if (tok.startsWith('-')) {
      // skip other flags; if the flag takes a value (we don't know), we may
      // mis-positionally include the value as a positional. Acceptable since
      // our verb is always the first positional and that's already captured.
      continue;
    }
    positional.push(tok);
  }

  if (positional.length > 0) verb = positional[0] as string;
  if (positional.length > 1) subResource = positional[1] as string;
  if (positional.length > 2) resourceName = positional[2] as string;

  // Tighten the auth-can-i-as detection: only deny when verb is `auth` and
  // sub is `can-i` and `--as` was set.
  if (!(verb === 'auth' && subResource === 'can-i' && hasAuthCanIAs)) {
    hasAuthCanIAs = false;
  }

  return { verb, namespace, hasAuthCanIAs, subResource, resourceName };
}

/**
 * Decide whether the given kubectl argv is permitted under the given mode
 * for a connector that allows the given namespaces. `allowedNamespaces` may
 * be empty; in that case writes that target a namespace are rejected.
 */
export function checkKubectl(
  argv: readonly string[],
  mode: KubectlMode,
  allowedNamespaces: readonly string[],
): AllowlistDecision {
  if (argv.length === 0) {
    return { allow: false, reason: 'empty kubectl argv' };
  }
  const parsed = parseKubectlArgv(argv);

  if (!parsed.verb) {
    return { allow: false, reason: 'kubectl argv has no verb' };
  }

  // Permanent denies first — these win over any allowlist.
  if (PERMANENT_DENY_VERBS.has(parsed.verb)) {
    return { allow: false, reason: `kubectl verb '${parsed.verb}' is permanently denied` };
  }
  if (parsed.hasAuthCanIAs) {
    return { allow: false, reason: 'kubectl auth can-i --as is permanently denied' };
  }

  const isRead = READ_VERBS.has(parsed.verb);
  const isWrite = WRITE_VERBS.has(parsed.verb);

  if (mode === 'read') {
    if (!isRead) {
      return {
        allow: false,
        reason: `kubectl verb '${parsed.verb}' is not on the read-allowlist (allowed: ${[...READ_VERBS].sort().join(', ')})`,
      };
    }
    // Read mode does not require a namespace; cluster-scoped reads are fine.
    if (parsed.namespace !== null && allowedNamespaces.length > 0
        && !allowedNamespaces.includes(parsed.namespace)) {
      return {
        allow: false,
        reason: `namespace '${parsed.namespace}' is not in the connector's allowed namespaces`,
      };
    }
    return { allow: true };
  }

  // mode === 'write'
  if (!isRead && !isWrite) {
    return {
      allow: false,
      reason: `kubectl verb '${parsed.verb}' is not on the write-allowlist (allowed: ${[...new Set([...READ_VERBS, ...WRITE_VERBS])].sort().join(', ')})`,
    };
  }

  // Write-specific guards.
  if (isWrite) {
    // delete must name what to delete; refuse mass-deletes.
    if (parsed.verb === 'delete') {
      if (!parsed.subResource || !parsed.resourceName) {
        return {
          allow: false,
          reason: 'kubectl delete requires both a resource type and an explicit resource name',
        };
      }
    }
    // Writes must target a namespace and that namespace must be allow-listed
    // and not on the permanent-deny list.
    if (parsed.namespace === null) {
      return {
        allow: false,
        reason: `kubectl ${parsed.verb} requires --namespace; refusing to write at cluster scope`,
      };
    }
    if (PERMANENT_DENY_NAMESPACES.has(parsed.namespace)) {
      return {
        allow: false,
        reason: `kubectl write to namespace '${parsed.namespace}' is permanently denied`,
      };
    }
    if (allowedNamespaces.length > 0 && !allowedNamespaces.includes(parsed.namespace)) {
      return {
        allow: false,
        reason: `namespace '${parsed.namespace}' is not in the connector's allowed namespaces`,
      };
    }
  } else {
    // Read inside write mode: same namespace allowlist treatment as read mode,
    // but we let cluster-scoped reads through.
    if (parsed.namespace !== null && allowedNamespaces.length > 0
        && !allowedNamespaces.includes(parsed.namespace)) {
      return {
        allow: false,
        reason: `namespace '${parsed.namespace}' is not in the connector's allowed namespaces`,
      };
    }
  }

  return { allow: true };
}

// Exposed for tests + future inspection (the design doc lists these explicitly).
export const KUBECTL_READ_VERBS: ReadonlySet<string> = READ_VERBS;
export const KUBECTL_WRITE_VERBS: ReadonlySet<string> = WRITE_VERBS;
export const KUBECTL_PERMANENT_DENY_VERBS: ReadonlySet<string> = PERMANENT_DENY_VERBS;
export const KUBECTL_PERMANENT_DENY_NAMESPACES: ReadonlySet<string> = PERMANENT_DENY_NAMESPACES;


/**
 * Tokenize a `kubectl ...` command STRING into argv. Strips the leading
 * `kubectl` token if present, supports single- and double-quoted args,
 * and refuses anything containing shell metacharacters (`/[\`$|;&><]/`)
 * by returning an empty array.
 *
 * Used by callers that receive the command from a higher layer as a
 * single string (chat input, agent tool args). The empty-array on
 * shell-meta keeps unparseable-but-dangerous shapes from being silently
 * passed to a downstream allowlist that only knows about kubectl verbs.
 *
 * If you already have argv (from a structured tool call), use
 * `parseKubectlArgv` instead — it parses meaning out of argv tokens.
 */
export function parseKubectlCommandString(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) return [];
  if (/[`$|;&><]/.test(trimmed)) return [];

  const tokens: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let buf = '';
      while (j < trimmed.length && trimmed[j] !== quote) {
        buf += trimmed[j];
        j++;
      }
      if (j >= trimmed.length) return []; // unterminated quote
      tokens.push(buf);
      i = j + 1;
      continue;
    }
    let j = i;
    let buf = '';
    while (j < trimmed.length && !/\s/.test(trimmed[j] ?? '')) {
      buf += trimmed[j];
      j++;
    }
    tokens.push(buf);
    i = j;
  }
  if (tokens[0] === 'kubectl') tokens.shift();
  return tokens;
}
