import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    environment: 'node',
    // The linger tests drive real timers (a 40ms hide window checked a few
    // renders later). Running spec files in parallel starves those callbacks
    // under CPU contention and they flake, so the suite runs one file at a
    // time — the suite is fast enough that the wall-clock cost is minor.
    fileParallelism: false,
  },
})