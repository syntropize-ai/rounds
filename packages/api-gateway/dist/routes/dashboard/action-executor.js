export class ActionExecutor {
    store;
    sendEvent;
    constructor(store, sendEvent) {
        this.store = store;
        this.sendEvent = sendEvent;
    }
    async execute(dashboardId, actions) {
        for (const action of actions) {
            await this.applyAction(dashboardId, action);
        }
    }
    async applyAction(dashboardId, action) {
        const dashboard = await this.store.findById(dashboardId);
        if (!dashboard)
            throw new Error('Dashboard not found');
        switch (action.type) {
            case 'add_panels': {
                const newPanels = [...dashboard.panels, ...action.panels];
                await this.store.updatePanels(dashboardId, newPanels);
                for (const panel of action.panels) {
                    this.sendEvent({ type: 'panel_added', panel });
                }
                break;
            }
            case 'remove_panels': {
                const filtered = dashboard.panels.filter((p) => !action.panelIds.includes(p.id));
                await this.store.updatePanels(dashboardId, filtered);
                for (const id of action.panelIds) {
                    if (dashboard.panels.some((p) => p.id === id))
                        this.sendEvent({ type: 'panel_removed', panelId: id });
                }
                break;
            }
            case 'modify_panel': {
                const existed = dashboard.panels.some((p) => p.id === action.panelId);
                const panels = dashboard.panels.map((p) => p.id === action.panelId ? { ...p, ...action.patch } : p);
                await this.store.updatePanels(dashboardId, panels);
                if (existed) {
                    this.sendEvent({ type: 'panel_modified', panelId: action.panelId, patch: action.patch });
                }
                break;
            }
            case 'rearrange': {
                const panels = dashboard.panels.map((p) => {
                    const layout = action.layout.find((l) => l.panelId === p.id);
                    return layout
                        ? { ...p, row: layout.row, col: layout.col, width: layout.width, height: layout.height }
                        : p;
                });
                await this.store.updatePanels(dashboardId, panels);
                for (const layout of action.layout) {
                    this.sendEvent({ type: 'panel_modified', panelId: layout.panelId, patch: { row: layout.row, col: layout.col, width: layout.width, height: layout.height } });
                }
                break;
            }
            case 'add_variable': {
                const vars = [...(dashboard.variables ?? []), action.variable];
                await this.store.updateVariables(dashboardId, vars);
                this.sendEvent({ type: 'variable_added', variable: action.variable });
                break;
            }
            case 'set_title': {
                await this.store.update(dashboardId, {
                    title: action.title,
                    ...(action.description !== undefined ? { description: action.description } : {}),
                });
                this.sendEvent({ type: 'thinking', content: 'Dashboard title updated' });
                break;
            }
        }
    }
}
//# sourceMappingURL=action-executor.js.map