import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120_000,  // 2 min for container spin-up
    hookTimeout: 120_000,
    pool: 'forks',         // avoid port conflicts between test files
    poolOptions: {
      forks: {
        singleFork: true,  // concurrency tests need isolated DB
      },
    },
    sequence: {
      sequential: true,
    },
  },
});
