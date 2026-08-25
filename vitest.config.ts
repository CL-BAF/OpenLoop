import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";

export default defineConfig({
  resolve: {
    // Runtime tests import the plugin source, which in turn imports the core
    // workspace package by name. Point that import at source so tests cannot
    // accidentally exercise a stale packages/core/dist build.
    alias: {
      "@openloop/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
  },
});
