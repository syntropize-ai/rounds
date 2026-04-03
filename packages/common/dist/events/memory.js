// InMemoryEventBus - EventEmitter-backed, single-process implementation
import { EventEmitter } from 'events';
export class InMemoryEventBus {
    emitter = new EventEmitter();
    constructor() {
        // Increase default max listeners to accommodate multiple subscribers per topic
        this.emitter.setMaxListeners(100);
    }
    async publish(topic, event) {
        this.emitter.emit(topic, event);
    }
    subscribe(topic, handler) {
        const listener = (event) => {
            void handler(event);
        };
        this.emitter.on(topic, listener);
        return () => {
            this.emitter.off(topic, listener);
        };
    }
    async close() {
        this.emitter.removeAllListeners();
    }
}
//# sourceMappingURL=memory.js.map