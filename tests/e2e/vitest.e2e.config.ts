import { defineConfig } from 'vitest/config';

// Real-cluster e2e scenarios. Sequential against a single port-forwarded
// gateway (set up by tests/e2e/kit.sh up).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/scenarios/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    maxConcurrency: 1,
  },
});
