import { defineConfig } from 'vitest/config';

/**
 * Unit tests are pure and run fully in parallel. Integration tests own real
 * browser processes, so their concurrency is bounded: oversubscribing CPUs
 * starves them into timeouts that are indistinguishable from product failures.
 * The integration suite runs once on Chromium and once on Firefox; a test
 * gets its browser from `testBrowser` (`tests/helpers/web-session.ts`). A
 * file in `tests/integration/chromium/` runs on Chromium only: it attaches
 * to Chrome over CDP, reads Chrome's own accessibility tree, or installs
 * Chromium itself.
 */
const integration = {
  include: ['tests/integration/**/*.test.ts'],
  testTimeout: 30_000,
  hookTimeout: 30_000,
  pool: 'forks',
  maxWorkers: 3,
  minWorkers: 1,
  sequence: { groupOrder: 1 },
} as const;

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
      { test: { ...integration, name: 'integration' } },
      {
        test: {
          ...integration,
          name: 'integration-firefox',
          exclude: ['tests/integration/chromium/**'],
          env: { E2E_WEB_BROWSER: 'firefox' },
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
