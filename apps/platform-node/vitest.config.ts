import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*_test.ts'],
    restoreMocks: false,
    testTimeout: 10_000,
  },
});
