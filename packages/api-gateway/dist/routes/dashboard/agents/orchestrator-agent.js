import { randomUUID } from 'node:crypto';
import { defaultInvestigationReportStore } from '../investigation-report-store.js';
import { DashboardGeneratorAgent } from './dashboard-generator-agent.js';
import { PanelAdderAgent } from './panel-adder-agent.js';
import { InvestigationAgent } from './investigation-agent.js';
import { ActionExecutor } from '../action-executor.js';
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
        console.log(`[Orchestrator] init: prometheusUrl=${deps.prometheusUrl ? 'SET' : 'UNSET'}, investigationAgent=${this.investigationAgent ? 'YES' : 'NO'}`);
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
                const text = chatReply ?? (typeof args.text === 'string' ? args.text : '');
                if (!chatReply) {
                    this.deps.sendEvent({ type: 'reply', content: text });
                }
                return text;
            }
            if (action === 'ask_user') {
                const question = chatReply ?? (typeof args.question === 'string' ? args.question : '');
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
                        observationText
                            = `Generated ${result.panels.length} panels`
                                + (result.variables?.length ? ` and ${result.variables.length} variables` : '');
                        this.deps.sendEvent({
                            type: 'tool_result',
                            tool: 'generate_dashboard',
                            summary: observationText,
                            success: result.panels.length > 0,
                        });
                        break;
                    }
                    case 'add_panels': {
                        const goal = String(args.goal ?? '');
                        this.deps.sendEvent({
                            type: 'tool_call',
                            tool: 'add_panels',
                            args: { goal },
                            displayText: `Adding panels: ${goal}`,
                        });
                        const currentDash = await this.deps.store.findById(dashboardId);
                        if (!currentDash)
                            throw new Error('Dashboard not found');
                        const result = await this.panelAdderAgent.addPanels({
                            goal,
                            existingPanels: currentDash.panels,
                            existingVariables: currentDash.variables,
                            availableMetrics: [],
                            labelsByMetric: {},
                            gridNextRow: currentDash.panels.length > 0
                                ? Math.max(...currentDash.panels.map((p) => p.row + p.height))
                                : 0,
                        });
                        if (result.panels.length > 0) {
                            await this.actionExecutor.execute(dashboardId, [{ type: 'add_panels', panels: result.panels }]);
                        }
                        if (result.variables && result.variables.length > 0) {
                            for (const variable of result.variables) {
                                await this.actionExecutor.execute(dashboardId, [{ type: 'add_variable', variable }]);
                            }
                        }
                        observationText
                            = `Added ${result.panels.length} panel(s)`
                                + (result.variables?.length ? ` and ${result.variables.length} variable(s)` : '');
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
                            this.deps.sendEvent({ type: 'tool_result', tool: 'investigate', summary: observationText, success: false });
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
                            dashboardId,
                            goal,
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
                        const patch = (args.patch ?? {});
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
                        const layout = Array.isArray(args.layout)
                            ? args.layout
                            : [];
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
                        observationText = `Added variable: ${variable?.name ?? ''}.`;
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
        const panelsSummary = dashboard.panels.length > 0
            ? dashboard.panels.map((p) => `- [${p.id}] ${p.title} (${p.visualization})`).join('\n')
            : '(no panels yet)';
        const variablesSummary = (dashboard.variables ?? []).length > 0
            ? dashboard.variables.map((v) => `- $${v.name}: ${v.query ?? v.options?.join(', ') ?? 'join'}`).join('\n')
            : '(none)';
        const historySection = history.length > 0
            ? `\n## Recent Conversation History\n${history.slice(-10).map((m) => `- ${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')}\n`
            : '';
        const datasources = this.deps.allDatasources ?? [];
        const datasourceSection = datasources.length > 0
            ? `\n## Available Datasources\n${datasources.map((d) => `- ${d.name} (${d.type}, id: ${d.id}${d.environment ? `, env: ${d.environment}` : ''}${d.cluster ? `, cluster: ${d.cluster}` : ''}${d.isDefault ? ', DEFAULT' : ''})`).join('\n')}\n`
            : '';
        return `You are an observability platform agent that manages monitoring dashboards AND alert rules.
You can create dashboards, investigate issues, AND set up alerting rules that notify users when metrics cross thresholds. You are a conversational router that classifies user intent and delegates to the appropriate tool.

## Current Dashboard State
Title: ${dashboard.title}
Description: ${dashboard.description ?? ''}

## Panels (${dashboard.panels.length} total)
${panelsSummary}

## Variables
${variablesSummary}
${historySection}${datasourceSection}

## Available Tools

## Sub-agents (for complex work - these handle research, discovery, and panel generation internally)
- generate_dashboard(goal: string, scope?: "single"|"group"|"comprehensive") -> full dashboard generation or rebuilding dashboards.
- add_panels(goal: string) -> add new panels to the existing dashboard. Use for granting or rebuilding dashboards.
- investigate(goal: string) -> investigate a production issue using Prometheus data; generates evidence panels for report view.
- create_alert_rule(prompt: string) -> create a Prometheus alert rule that notifies users when the user asks for alerting/troubleshooting conditions.

## Direct tools (immediate dashboard changes)
- remove_panels(panelIds: string[]) -> remove panels by ID
- modify_panel(panelId: string, patch: object) -> patch a panel's properties (title, queries, visualization, etc.)
- rearrange(layout: Array<{ panelId, row, col, width, height }>) -> change panel layout positions
- add_variable(variable: DashboardVariable) -> add a template variable
- set_title(title: string, description?: string) -> update dashboard title/description

## Terminal
- reply(text: string) -> Send final reply to user and end the loop
- ask_user(question: string) -> Ask the user a clarifying question and wait for their response. Use VERY sparingly.

## Intent Classification
CRITICAL: Classify the user's intent carefully. You have the ability to create alert rules via the create_alert_rule tool. NEVER tell the user you cannot set up alerts or notifications - use the create_alert_rule tool instead.

### Key distinction:
- generate_dashboard = user wants to BUILD/CREATE a monitoring dashboard (proactive setup)
- investigate = user is ASKING ABOUT a PROBLEM or wants to DIAGNOSE an issue (reactive troubleshooting)

Route to the appropriate tool:

### Create/rebuild dashboard (user explicitly wants to create or set up monitoring) -> generate_dashboard
Examples:
- "Create a dashboard for my AKS cluster" -> build me a monitoring dashboard
- "Set up observability for X" -> build a monitoring dashboard

### Investigate/troubleshoot (user describes a PROBLEM, asks why something is happening, or wants to diagnose) -> investigate
Examples:
- "Why are my server latency high?" -> investigate the error spike
- "What is causing high CPU?" -> debug the issue
NOTE: Any question starting with "why", "what's causing", "what's wrong", or describing a symptom/problem ALWAYS investigate, NOT generate_dashboard.
IMPORTANT: If the user describes a condition they want to be informed about in the future:
- "Notify me if CPU > 80% for 10 minutes" -> create_alert_rule
- "Create an alert when the pod restarts" -> create_alert_rule
- "Let me know if memory crosses threshold" -> create_alert_rule

### Receive a notification or be alerted when a metric crosses a threshold or a state occurs -> create_alert_rule
Patterns: the user specifies "alert/notify/condition threshold" to be monitored/detected/followed up. This includes any phrasing that implies "watch this for me and tell me when..."

### Add panels -> add_panels
- "Add a panel for 4xx rate" -> add new panel
- "Add panels for memory" -> add panels for memory

### Modify panels/layout -> use direct tools
- "Rename the CPU panel to..." -> modify_panel
- "Move panel X to the top-right" -> rearrange
- "Add namespace filter" -> add_variable
- "Set title to..." -> set_title
- "Can you explain what the dashboard is showing?" -> reply directly

## Guidelines
1. You are an autonomous agent. Default to acting, not asking.
2. ALWAYS include a "message" field before EXECUTING actions. Take action immediately using the tools above. Default to acting, not asking.
3. Keep tool args minimal and concrete.
4. For simple requests, use direct tools. For complex generation work, delegate to sub-agents.
5. Ask clarifying questions only if a wrong assumption would be expensive or unsafe. A wrong assumption would be:
   - the user says "environment" but there are multiple environments and no clue which one
   - the user says "service" but there are multiple similarly named services or metrics
6. Do NOT ask "How can we make a reasonable assumption?" Instead:
   - Create "AKS Cluster Overview dashboard" just do it with standard K8s metrics
   - Investigate the Redis error spike? clear enough -> investigate Redis immediately
   - Set CPU panel -> just add it, don't ask which CPU metric
7. NEVER ask more than one clarifying question. If you already have some context (e.g. dashboard panels show specific services), infer that context instead of asking.

## Response Format
Return JSON on every step.
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