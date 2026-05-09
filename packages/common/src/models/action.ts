export interface Action {
  id: string;
  investigationId: string;
  type: 'rollback' | 'scale' | 'restart' | 'ticket' | 'notify' | 'runbook' | 'feature_flag';
  description: string;
  policyTag: 'suggest' | 'approve_required' | 'deny';
  status: 'proposed' | 'approved' | 'executing' | 'completed' | 'failed' | 'denied';
  params: Record<string, unknown>;
  result?: {
    success: boolean;
    message?: string;
    executedAt?: string;
  };
  risk: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// GuardedAction — central decision model for action execution.
//
// Distinguishes user-driven confirmation from background-agent formal
// approval. The guard returns a GuardDecision; the caller honors it:
//
//   allow + confirmationMode='none'                → execute now
//   allow + confirmationMode='user_confirm'        → ask once in chat
//   allow + confirmationMode='strong_user_confirm' → dry-run + diff + ask
//   allow + confirmationMode='formal_approval'     → create ApprovalRequest
//   deny                                            → refuse
//
// Permission denial NEVER silently downgrades — denied permission is a hard
// deny, not a "maybe ask harder".
// ---------------------------------------------------------------------------

export type ActionSource =
  | 'user_conversation'
  | 'background_agent'
  | 'manual_ui'
  | 'system';

export type ConfirmationMode =
  | 'none'
  | 'user_confirm'
  | 'strong_user_confirm'
  | 'formal_approval';

export type ActionRisk = 'low' | 'medium' | 'high' | 'critical';

export interface ActionResource {
  kind: string;
  name: string;
  namespace?: string;
}

/**
 * What the caller is asking the guard to evaluate. The guard does NOT
 * execute — it only decides.
 */
export interface ProposedAction {
  /** Set when source is user-driven; null for background_agent / system. */
  actorUserId?: string;
  orgId: string;
  connectorId: string;
  /** Capability name from AdapterCapability (e.g. 'k8s.write'). */
  capability: string;
  /** Verb within the capability (e.g. 'scale', 'delete', 'apply'). */
  verb: string;
  resource?: ActionResource;
  /** Free-form scope hints (region, cluster). */
  scope?: Record<string, unknown>;
  params: Record<string, unknown>;
  risk: ActionRisk;
  source: ActionSource;
}

export type GuardedDecision =
  | {
      kind: 'allow';
      confirmationMode: ConfirmationMode;
      reason?: string;
      auditId?: string;
    }
  | {
      kind: 'deny';
      reason: string;
      auditId?: string;
    };

/**
 * Sanitize params for audit storage. Drops keys whose names look like
 * secrets. Conservative substring match — callers with stricter needs
 * can pre-redact.
 */
const SECRET_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'credential',
  'privatekey',
  'private_key',
];

export function redactParamsForAudit(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    const lc = k.toLowerCase();
    if (SECRET_KEY_PATTERNS.some((p) => lc.includes(p))) {
      out[k] = '[REDACTED]';
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactParamsForAudit(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
