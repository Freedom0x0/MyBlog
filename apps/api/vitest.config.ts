import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup-env.ts'],
    // Integration tests share one seeded database and Fastify instances; running
    // files concurrently against it makes ordering assertions (the page walk)
    // depend on other workers' writes.
    fileParallelism: false,
  },
})
