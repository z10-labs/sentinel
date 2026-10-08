import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scoped explicitly so copies of the repo under .claude/worktrees are never picked up.
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
});
