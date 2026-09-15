import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Test không được gọi mạng thật — mọi thứ đi qua MockProvider hoặc fetch giả.
    testTimeout: 10_000,
  },
});
