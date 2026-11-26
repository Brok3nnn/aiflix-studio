import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['server/src/**/*.ts', 'shared/**/*.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
});
