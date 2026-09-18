import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    // Sharp-based image composition and crypto/DB helpers can spike past the
    // 5s default when the whole serial suite is under GC/IO pressure.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // scripts contains native node:test suites; run them with test:supervisor.
    exclude: [...configDefaults.exclude, "scripts/**"],
  },
});
