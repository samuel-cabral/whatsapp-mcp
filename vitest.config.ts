import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // better-sqlite3 is a native module and crashes vitest's worker threads;
    // child-process isolation avoids that.
    pool: "forks",
  },
});
