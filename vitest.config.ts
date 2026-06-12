import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    env: {
      // Stub keys so module-level guards in ai.ts / aiBug.ts don't throw during
      // unit tests that only exercise pure formatting functions.
      OPENAI_API_KEY: "test-stub",
    },
  },
});
