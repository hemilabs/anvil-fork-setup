import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["_esm/**", "node_modules/**"],
    globalSetup: ["test/e2e/setup.ts"],
  },
});
