import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/collection/**/*.test.ts'], environment: 'node' },
});
