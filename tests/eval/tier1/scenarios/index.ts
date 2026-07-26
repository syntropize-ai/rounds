/**
 * The scenario library.
 *
 * The control is listed last but the runner interleaves it with the faults — a
 * night that asks about a healthy cluster ten times in a row measures
 * something different from one that alternates.
 */

import type { Scenario } from '../scenario.js';
import { bookinfoScenarios } from './bookinfo.js';
import { inProcessScenarios } from './in-process.js';
import { healthyControl } from './healthy-control.js';

export const SCENARIOS: Scenario[] = [
  ...bookinfoScenarios,
  ...inProcessScenarios,
  healthyControl,
];

/**
 * Everything the injections create, by the name that deletes it.
 *
 * Declared rather than derived so it can be checked against the ground truth:
 * a fault whose own resource name contains the answer is solved by `kubectl
 * get`, and the eval would be measuring whether the agent lists resources.
 * The runner also uses this to sweep leftovers from a crashed run.
 */
export const INJECTED_RESOURCE_NAMES = [
  // Istio VirtualServices in `default`, alongside the fixture's own.
  'rounds-eval-fault-1',
  'rounds-eval-fault-2',
  // The in-process faults get a whole namespace, which is also their sweep.
  'rounds-eval',
];
