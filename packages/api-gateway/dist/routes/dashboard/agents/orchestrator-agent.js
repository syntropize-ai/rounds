import { randomUUID } from 'node:crypto';
import { defaultInvestigationReportStore } from '../investigation-report-store.js';
import { DashboardGeneratorAgent } from './dashboard-generator-agent.js';
import { PanelAdderAgent } from './panel-adder-agent.js';
import { InvestigationAgent } from './investigation-agent.js';
import { ActionExecutor } from './action-executor.js';
import { AlertRuleAgent } from './alert-rule-agent.js';
import { defaultAlertRuleStore } from '../../alert-rule-store.js';

const MAX_ITERATIONS = 15;

export class OrchestratorAgent {
  deps;
  actionExecutor;
  generatorAgent;
  panelAdderAgent;
  investigationAgent;
  alertRuleAgent;

  constructor(deps) {
    this.deps = deps;
    this.actionExecutor = new ActionExecutor(deps.store, deps.sendEvent);
    const subAgentDeps = {
      gateway: deps.gateway,
      model: deps.model,
      prometheusUrl: deps.prometheusUrl,
      prometheusHeaders: deps.prometheusHeaders,
      sendEvent: deps.sendEvent,
    };
    this.generatorAgent = new DashboardGeneratorAgent(subAgentDeps);
    this.panelAdderAgent = new PanelAdderAgent(subAgentDeps);
    if (deps.prometheusUrl) {
      this.investigationAgent = new InvestigationAgent({
        gateway: deps.gateway,
        model: deps.model,
        prometheusUrl: deps.prometheusUrl,
        prometheusHeaders: deps.prometheusHeaders,
        sendEvent: deps.sendEvent,
      });
    }
    this.alertRuleAgent = new AlertRuleAgent({
      gateway: deps.gateway,
      model: deps.model,
      prometheusUrl: deps.prometheusUrl,
      prometheusHeaders: deps.prometheusHeaders,
    });
    console.log(`[Orchestrator] init: prometheusUrl=${deps.prometheusUrl ? 'set' : 'unset'}, investigationAgent=${this.investigationAgent ? 'YES' : 'NO'}`);
  }

  async handleMessage(dashboardId, message) {
    const dashboard = await this.deps.store.findById(dashboardId);
    if (!dashboard)
      throw new Error(`Dashboard ${dashboardId} not found`);
    // Always use the ReAct loop - LLM classifies intent (generate, investigate, add panels, etc.)
    return this.runReActLoop(dashboardId, dashboard, message);
  }

  // ReAct loop - classifies intent and delegates to appropriate tool
  async runReActLoop(dashboardId, dashboard, message) {
    const history = this.deps.conversationStore.getMessages(dashboardId);
    const systemPrompt = this.buildSystemPrompt(dashboard, history);
    const observations = [];
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const messages = this.buildMessages(systemPrompt, message, observations);
      let step;
      try {
        const resp = await this.deps.gateway.complete(messages, {
          model: this.deps.model,
          maxTokens: 2048,
          temperature: 0,
          responseFormat: 'json',
        });
        const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        step = JSON.parse(cleaned);
      }
      catch {
        observations.push({ action: 'parse_error', args: {}, result: 'LLM returned invalid JSON - retrying.' });
        continue;
      }

      const { thought, message: chatReply, action, args } = step;
      console.log(`[Orchestrator] ReAct step ${i}: action="${action}" message="${chatReply?.slice(0, 80)}" args=${JSON.stringify(args).slice(0, 200)}`);
      // thought is internal reasoning - not sent to the user
      // Send conversational message to user before executing the action
      if (chatReply) {
        this.deps.sendEvent({ type: 'reply', content: chatReply });
      }

      if (action === 'reply') {
        const text = chatReply ?? (typeof args?.text === 'string' ? args.text : '');
        if (!chatReply) {
          this.deps.sendEvent({ type: 'reply', content: text });
        }
        return text;
      }

      if (action === 'ask_user') {
        const question = chatReply ?? (typeof args?.question === 'string' ? args.question : '');
        if (!chatReply && question) {
          this.deps.sendEvent({ type: 'reply', content: question });
        }
        // Break the loop - the user will respond in their next message
        return question;
      }

      let observationText;
      try {
        switch (action) {
          case 'generate_dashboard': {
            const goal = String(args.goal ?? '');
            const scopeArg = args.scope;
            const scope = ['single', 'group', 'comprehensive'].includes(scopeArg)
              ? scopeArg
              : 'comprehensive';
            this.deps.sendEvent({
              type: 'tool_call',
              tool: 'generate_dashboard',
              args: { goal, scope },
              displayText: `Generating dashboard: ${goal} (${scope})`,
            });
            const currentDash = await this.deps.store.findById(dashboardId);
            if (!currentDash)
              throw new Error('Dashboard not found');
            const onGroupDone = async (panels) => {
              await this.actionExecutor.execute(dashboardId, [{ type: 'add_panels', panels }]);
            };
            const result = await this.generatorAgent.generate({
              goal,
              scope,
              existingPanels: currentDash.panels,
              existingVariables: currentDash.variables,
            }, onGroupDone);
            // Apply title if provided
            if (result.title) {
              await this.actionExecutor.execute(dashboardId, [{
                type: 'set_title',
                title: result.title,
                ...(result.description ? { description: result.description } : {}),
              }]);
            }
            // Panels already added progressively via onGroupDone
            // Apply variables
            if (result.variables && result.variables.length > 0) {
              for (const variable of result.variables) {
                await this.actionExecutor.execute(dashboardId, [{ type: 'add_variable', variable }]);
              }
            }
            observationText = `Generated ${result.panels.length} panels${result.variables?.length ? ` and ${result.variables.length} variables` : ''}.`;
            this.deps.sendEvent({
              type: 'tool_result',
              tool: 'add_panels',
              summary: observationText,
              success: result.panels.length > 0,
            });
            break;
          }

          case 'investigate': {
            const goal = String(args.goal ?? '');
            this.deps.sendEvent({
              type: 'tool_call',
              tool: 'investigate',
              args: { goal },
              displayText: `Investigating: ${goal}`,
            });
            if (!this.investigationAgent) {
              observationText = 'Investigation requires Prometheus - no Prometheus URL configured.';
              this.deps.sendEvent({
                type: 'tool_result',
                tool: 'investigate',
                summary: observationText,
                success: false,
              });
              break;
            }
            const currentDash = await this.deps.store.findById(dashboardId);
            if (!currentDash)
              throw new Error('Dashboard not found');
            const result = await this.investigationAgent.investigate({
              goal,
              existingPanels: currentDash.panels,
              gridNextRow: currentDash.panels.length > 0
                ? Math.max(...currentDash.panels.map((p) => p.row + p.height))
                : 0,
            });
            // Investigation panels are only shown in the report view, NOT added to the dashboard
            // Mark this as an investigation and set a meaningful title
            await this.deps.store.update(dashboardId, { type: 'investigation' });
            await this.actionExecutor.execute(dashboardId, [{
              type: 'set_title',
              title: `Investigation: ${goal.length > 60 ? goal.slice(0, 60) + '...' : goal}`,
            }]);
            // Emit the full investigation report for left-side report view
            this.deps.sendEvent({ type: 'investigation_report', report: result.report });
            // Persist the report so it can be retrieved later via API
            defaultInvestigationReportStore.save({
              id: randomUUID(),
              summary: result.summary,
              sections: result.report.sections,
              createdAt: new Date().toISOString(),
            });
            observationText = result.summary;
            this.deps.sendEvent({
              type: 'tool_result',
              tool: 'investigate',
              summary: `Investigation complete - ${result.panels.length} evidence panels added`,
              success: true,
            });
            break;
          }

          case 'remove_panels': {
            const panelIds = Array.isArray(args.panelIds) ? args.panelIds : [];
            this.deps.sendEvent({
              type: 'tool_call',
              tool: 'remove_panels',
              args: { panelIds },
              displayText: `Removing ${panelIds.length} panel(s)`,
            });
            const removeAction = { type: 'remove_panels', panelIds };
            await this.actionExecutor.execute(dashboardId, [removeAction]);
            observationText = `Removed ${panelIds.length} panel(s).`;
            this.deps.sendEvent({
              type: 'tool_result',
              tool: 'remove_panels',
              summary: `Removed ${panelIds.length} panels`,
              success: true,
            });
            break;
          }

          case 'modify_panel': {
            const panelId = String(args.panelId ?? '');
            const patch = args.patch ?? {};
            this.deps.sendEvent({
              type: 'tool_call',
              tool: 'modify_panel',
              args: { panelId, patch },
              displayText: `Modifying panel: ${panelId}`,
            });
            const modifyAction = { type: 'modify_panel', panelId, patch };
            await this.actionExecutor.execute(dashboardId, [modifyAction]);
            observationText = `Modified panel ${panelId}.`;
            this.deps.sendEvent({
              type: 'tool_result',
              tool: 'modify_panel',
              summary: `Panel ${panelId} modified`,
              success: true,
            });
            break;
          }

          case 'rearrange': {
            const layout = Array.isArray(args.layout) ? args.layout : [];
            this.deps.sendEvent({
              type: 'tool_call',
              tool: 'rearrange',
              args: { layout },
              displayText: `Rearranging ${layout.length} panel(s)`,
            });
            const rearrangeAction = { type: 'rearrange', layout };
            await this.actionExecutor.execute(dashboardId, [rearrangeAction]);
            observationText = `Rearranged ${layout.length} panel(s).`;
            this.deps.sendEvent({
              type: 'tool_result',
              tool: 'rearrange',
              summary: `Rearranged ${layout.length} panels`,
              success: true,
            });
            break;
          }

          case 'add_variable': {
            const variable = args.variable;
            this.deps.sendEvent({
              type: 'tool_call',
              tool: 'add_variable',
              args: { variable },
              displayText: `Adding variable: ${variable?.name ?? ''}`,
            });
            const addVarAction = { type: 'add_variable', variable };
            await this.actionExecutor.execute(dashboardId, [addVarAction]);
            observationText = `Added variable ${variable?.name ?? ''}.`;
            this.deps.sendEvent({
              type: 'tool_result',
              tool: 'add_variable',
              summary: `Variable ${variable?.name ?? ''} added`,
              success: true,
            });
            break;
          }

          case 'set_title': {
            const title = String(args.title ?? '');
            const description = typeof args.description === 'string' ? args.description : undefined;
            this.deps.sendEvent({
              type: 'tool_call',
              tool: 'set_title',
              args: { title, ...(description !== undefined ? { description } : {}) },
              displayText: `Setting title: "${title}"`,
            });
            const titleAction = {
              type: 'set_title',
              title,
              ...(description !== undefined ? { description } : {}),
            };
            await this.actionExecutor.execute(dashboardId, [titleAction]);
            observationText = `Title set to "${title}".`;
            this.deps.sendEvent({
              type: 'tool_result',
              tool: 'set_title',
              summary: `Title updated to "${title}"`,
              success: true,
            });
            break;
          }

          case 'create_alert_rule': {
            const prompt = String(args.prompt ?? args.goal ?? '');
            this.deps.sendEvent({
              type: 'tool_call',
              tool: 'create_alert_rule',
              args: { prompt },
              displayText: `Creating alert rule: ${prompt.slice(0, 60)}`,
            });
            // Extract dashboard context - existing queries, variables, title
            const currentDash = await this.deps.store.findById(dashboardId);
            const existingQueries = (currentDash?.panels ?? [])
              .flatMap((p) => (p.queries ?? []).map((q) => q.expr))
              .filter(Boolean);
            const variables = (currentDash?.variables ?? []).map((v) => ({
              name: v.name,
              value: v.current,
            }));
            const generated = await this.alertRuleAgent.generate(prompt, {
              dashboardId,
              dashboardTitle: currentDash?.title,
              existingQueries: existingQueries.length > 0 ? existingQueries : undefined,
              variables: variables.length > 0 ? variables : undefined,
            });
            // Save to store - include dashboard context in labels
            const rule = defaultAlertRuleStore.create({
              name: generated.name,
              description: generated.description,
              originalPrompt: prompt,
              condition: generated.condition,
              evaluationIntervalSec: generated.evaluationIntervalSec,
              severity: generated.severity,
              labels: {
                ...generated.labels,
                ...(dashboardId ? { dashboardId } : {}),
              },
              createdBy: 'llm',
            });
            observationText = `Created alert rule "${rule.name}" (${rule.severity}, evaluating every ${rule.evaluationIntervalSec}s). Rule: ${rule.condition.query} ${rule.condition.operator} ${rule.condition.threshold} for ${rule.condition.forDurationSec}s.${generated.autoInvestigate ? ' Auto-investigation enabled on fire.' : ''}`;
            this.deps.sendEvent({
              type: 'tool_result',
              tool: 'create_alert_rule',
              summary: `Alert rule "${rule.name}" created`,
              success: true,
            });
            break;
          }

          default: {
            observationText = `Unknown action "${action}" - skipping.`;
          }
        }
      }
      catch (err) {
        observationText = `Action "${action}" failed: ${err instanceof Error ? err.message : String(err)}`;
        this.deps.sendEvent({
          type: 'tool_result',
          tool: action,
          summary: observationText,
          success: false,
        });
      }

      observations.push({ action, args: step.args ?? {}, result: observationText });
    }

    // Max iterations reached - emit a fallback reply
    const fallback = 'I have completed the requested changes to your dashboard.';
    this.deps.sendEvent({ type: 'reply', content: fallback });
    return fallback;
  }

  buildSystemPrompt(dashboard, history) {
    const panelsSummary = dashboard.panels.length
      ? dashboard.panels.map((p) => `- [${p.id}] ${p.title} (${p.visualization})`).join('\n')
      : '(no panels)';
    const variablesSummary = (dashboard.variables ?? []).length
      ? dashboard.variables.map((v) => `- ${v.name}: ${v.query ?? ''}`).join('\n')
      : '(no variables)';
    const historySection = history.length > 0
      ? history.slice(-10).map((h) => `- ${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n')
      : '(none)';
    const datasourceSection = (dashboard.datasources ?? []).length > 0
      ? dashboard.datasources.map((d) => `- ${d.name} (${d.type})`).join('\n')
      : '(none)';

    return `You are an observability platform agent for a monitoring dashboard.
You can create dashboards, investigate issues, add alerting rules that notify users when metrics cross thresholds. You are a conversational router that classifies user intent and delegates to the appropriate tool.

Dashboard State
Title: "${dashboard.title}"
Description: ${dashboard.description ?? '(none)'}

## Panels (${dashboard.panels.length} total)
${panelsSummary}

## Variables
${variablesSummary}

## Recent Conversation History
${historySection}

## Available Datasources
${datasourceSection}

## Available Tools

## Sub-agents (for complex work - these handle research/discovery/LLM generation internally)
- generate_dashboard(goal string, scope? 'single'|'group'|'comprehensive') -> full dashboard generation
- add_panels(goal string) -> add new panels to the existing dashboard
- investigate(goal string) -> investigate a problem/issue using Prometheus data
- create_alert_rule(prompt string) -> create a Prometheus alert rule

## Direct tools (immediate dashboard changes)
- remove_panels(panelIds string[]) -> remove panels by id
- modify_panel(panelId string, patch object) -> patch panel properties
- rearrange(layout Array<{panelId,row,col,width,height}>) -> change panel layout
- add_variable(variable object) -> add/update variable
- set_title(title string, description? string) -> update dashboard title/description

## Terminal
- reply(text string) -> send final reply to user and end the loop
- ask_user(question string) -> ask the user a clarifying question and wait for their response. Use VERY sparingly.

Intent Classify the user's intent carefully:
- Generate dashboard = user wants to BUILD/CREATE a monitoring dashboard
- Investigate dashboard = user asks about a PROBLEM or wants to diagnose an issue

Guidelines
1. Default to acting, not asking.
2. Always include a message field: a brief, friendly, conversational reply to the user.
3. For simple direct user requests, use direct tools. For complex generation work, delegate to sub-agents.
4. Ask clarifying questions only when truly necessary.

Response Format
Return JSON every step:
{ "thought": "internal reasoning (hidden from user)", "message": "conversational reply shown to user", "action": "tool_name", "args": { ... } }

For the final reply:
{ "thought": "done", "message": "Here's a summary of what I did...", "action": "reply", "args": {} }`;
  }

  buildMessages(systemPrompt, userMessage, observations) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
    for (const obs of observations) {
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ action: obs.action, args: obs.args }),
      });
      messages.push({
        role: 'user',
        content: `Observation: ${obs.result}`,
      });
    }
    return messages;
  }
}
//# sourceMappingURL=orchestrator-agent.js.map
