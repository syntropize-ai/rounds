export class AdapterRegistry {
    adapters = [];
    register(adapter) {
        this.adapters.push(adapter);
    }
    getByCapability(capability) {
        return this.adapters.filter((a) => a.capabilities().includes(capability));
    }
    getAll() {
        return [...this.adapters];
    }
}
//# sourceMappingURL=adapter-registry.js.map