import { defineConfig } from 'vitest/config';

/**
 * Docker integration tier (RFC 0001 §Verification gates). Deliberately
 * separate from vitest.config.ts: tests live under src/celld/integration/
 * (NOT __tests__/), so `pnpm test` and CI stay Docker-free. Run with
 * `pnpm test:celld:integration`.
 */
export default defineConfig({
  test: {
    include: ['src/celld/integration/**/*.test.ts'],
    globalSetup: ['./src/celld/integration/global-setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    // The gauntlet is one ordered scenario over one stack.
    sequence: { concurrent: false },
  },
});
