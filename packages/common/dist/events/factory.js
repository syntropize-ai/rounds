// EventBusFactory - selects InMemory or Redis implementation based on config
import { InMemoryEventBus } from './memory.js';
import { RedisEventBus } from './redis.js';
export function createEventBus(config = { backend: 'memory' }) {
    if (config.backend === 'redis') {
        return new RedisEventBus(config.redis ?? {});
    }
    return new InMemoryEventBus();
}
/**
 * Convenience factory that reads REDIS_URL from the environment.
 * Falls back to InMemoryEventBus when REDIS_URL is not set.
 */
export function createEventBusFromEnv() {
    const redisUrl = process.env['REDIS_URL'];
    if (redisUrl) {
        return new RedisEventBus({ url: redisUrl });
    }
    return new InMemoryEventBus();
}
//# sourceMappingURL=factory.js.map