import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "workspace",
      environment: "node",
      maxWorkers: 1,
      fileParallelism: false,
      include: ["tests/**/*.test.mjs"],
      passWithNoTests: true,
    },
  },
]);
