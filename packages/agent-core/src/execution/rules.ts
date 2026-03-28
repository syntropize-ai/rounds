// Rule templates for action generation

import type { ActionRule } from './types.js';
import type { Action } from '@agentic-obs/common';

let _seq = 0;
function nextId(): string {
  return `act-${(++_seq).toString(36)}`;
}

// -- Deploy/rollback rule -------------------------------------------------

const DEPLOY_KEYWORDS = ['deploy', 'rollout', 'release', 'version', 'canary', 'upgrade', 'migration'];

export const rollbackRule: ActionRule = {
  name: 'rollback-on-deploy',

  matches(hypothesis) {
    const desc = hypothesis.description.toLowerCase();
    return DEPLOY_KEYWORDS.some((kw) => desc.includes(kw)) &&
      (hypothesis.status === 'supported' || hypothesis.confidence >= 0.5);
  },

  buildAction(hypothesis, _evidence, entity): Action {
    return {
      id: nextId(),
      investigationId: hypothesis.investigationId,
      type: 'rollback',
      description: `Rollback ${entity} to the previous stable version (before the suspected deploy)`,
      policyTag: 'approve_required',
      status: 'proposed',
      params: {
        service: entity,
        hypothesisId: hypothesis.id,
        confidence: hypothesis.confidence,
      },
      risk: 'low',
    };
  },

  rationale(hypothesis) {
    return `Hypothesis "${hypothesis.description}" (confidence ${hypothesis.confidence}) implicates a recent deployment. A rollback is the fastest path to service recovery. Requires operator approval before execution.`;
  },
};

// -- Resource saturation / scale rule -------------------------------------

const SATURATION_KEYWORDS = ['saturation', 'cpu', 'memory', 'throttl', 'queue', 'backpressure', 'overload', 'capacity'];

export const scaleRule: ActionRule = {
  name: 'scale-on-saturation',

  matches(hypothesis) {
    const desc = hypothesis.description.toLowerCase();
    return SATURATION_KEYWORDS.some((kw) => desc.includes(kw)) &&
      (hypothesis.status === 'supported' || hypothesis.confidence >= 0.5);
  },

  buildAction(hypothesis, _evidence, entity): Action {
    return {
      id: nextId(),
      investigationId: hypothesis.investigationId,
      type: 'scale',
      description: `Scale out ${entity} to relieve resource saturation`,
      policyTag: 'suggest',
      status: 'proposed',
      params: {
        service: entity,
        hypothesisId: hypothesis.id,
        scaleDirection: 'out',
        confidence: hypothesis.confidence,
      },
      risk: 'low',
    };
  },

  rationale(hypothesis) {
    return `Hypothesis "${hypothesis.description}" (confidence ${hypothesis.confidence}) indicates resource saturation. Scaling out should relieve pressure. This is a low-risk suggestion that can be acted on without full approval.`;
  },
};

// -- Config change review rule --------------------------------------------

const CONFIG_KEYWORDS = ['config', 'configuration', 'env', 'environment variable', 'feature flag', 'flag', 'setting', 'parameter'];

export const configReviewRule: ActionRule = {
  name: 'review-config-change',

  matches(hypothesis) {
    const desc = hypothesis.description.toLowerCase();
    return CONFIG_KEYWORDS.some((kw) => desc.includes(kw)) &&
      (hypothesis.status === 'supported' || hypothesis.confidence >= 0.4);
  },

  buildAction(hypothesis, _evidence, entity): Action {
    return {
      id: nextId(),
      investigationId: hypothesis.investigationId,
      type: 'feature_flag',
      description: `Review and revert recent configuration changes for ${entity}`,
      policyTag: 'suggest',
      status: 'proposed',
      params: {
        service: entity,
        hypothesisId: hypothesis.id,
        action: 'review_diff',
        confidence: hypothesis.confidence,
      },
      risk: 'low',
    };
  },

  rationale(hypothesis) {
    return `Hypothesis "${hypothesis.description}" (confidence ${hypothesis.confidence}) points to a configuration change as a possible cause. Review the recent config diff and consider reverting if a problematic change is identified.`;
  },
};

// -- High-confidence generic ticket rule ----------------------------------

export const genericTicketRule: ActionRule = {
  name: 'ticket-for-investigation',

  matches(hypothesis) {
    return hypothesis.confidence >= 0.7 && hypothesis.status !== 'refuted';
  },

  buildAction(hypothesis, _evidence, entity): Action {
    return {
      id: nextId(),
      investigationId: hypothesis.investigationId,
      type: 'ticket',
      description: `Open incident ticket for ${entity}: "${hypothesis.description}"`,
      policyTag: 'suggest',
      status: 'proposed',
      params: {
        service: entity,
        hypothesisId: hypothesis.id,
        confidence: hypothesis.confidence,
      },
      risk: 'low',
    };
  },

  rationale(hypothesis) {
    return `High-confidence hypothesis (${hypothesis.confidence}) warrants an incident ticket for tracking, escalation and post-mortem purposes.`;
  },
};

// -- Critical severity notify rule ----------------------------------------

export const criticalNotifyRule: ActionRule = {
  name: 'notify-on-critical',

  matches() {
    return false;
  },

  buildAction(hypothesis, _evidence, entity): Action {
    return {
      id: nextId(),
      investigationId: hypothesis.investigationId,
      type: 'notify',
      description: `Page oncall engineer - critical severity incident on ${entity}`,
      policyTag: 'approve_required',
      status: 'proposed',
      params: { service: entity, severity: 'critical' },
      risk: 'low',
    };
  },

  rationale() {
    return 'Critical severity warrants immediate oncall notification.';
  },
};

export const DEFAULT_RULES: ActionRule[] = [
  rollbackRule,
  scaleRule,
  configReviewRule,
  genericTicketRule,
];
