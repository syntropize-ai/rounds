/**
 * Which agent tools reach outside the deployment, and how to switch them off.
 *
 * `web_search` is wired by default, needs no configuration, and calls
 * duckduckgo.com. The prompt actively tells the agent to use it when the
 * knowledge base has no entry for a named system — so in ordinary use the
 * queries it sends carry the user's own service names, metric names and error
 * strings out of the cluster.
 *
 * There was no way to turn that off. For an operator running Rounds precisely
 * because it is self-hosted — an air-gapped install, a regulated environment,
 * anyone who has to answer for what leaves the network — "you cannot disable
 * it" is not a setting they can work around.
 *
 * The default stays on: it is useful, and flipping it silently would degrade
 * every existing install. What changes is that turning it off is now possible,
 * and the README no longer claims nothing leaves the perimeter when this is
 * running.
 *
 * Note what this does *not* cover. The model itself is egress: every metric
 * value, log line and command output the agent reads is sent to whichever LLM
 * endpoint is configured. Only a local endpoint keeps that inside the
 * perimeter, and no flag here changes it.
 */

/** Tools that make requests to hosts outside the deployment. */
export const EGRESS_TOOLS: readonly string[] = ['web_search'];

/**
 * Read once at startup. Any of the usual truthy spellings, because an operator
 * setting this has a specific intent and should not have to guess the syntax.
 */
export function webSearchDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env['ROUNDS_DISABLE_WEB_SEARCH']?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Remove the outbound tools from an agent's ceiling.
 *
 * Applied to `allowedTools` rather than to the adapter alone: leaving the tool
 * advertised and failing at call time would spend a turn, and would tell the
 * model the capability exists when the operator has said it does not.
 */
export function applyEgressPolicy(
  tools: readonly string[],
  disabled = webSearchDisabled(),
): string[] {
  if (!disabled) return [...tools];
  return tools.filter((tool) => !EGRESS_TOOLS.includes(tool));
}
