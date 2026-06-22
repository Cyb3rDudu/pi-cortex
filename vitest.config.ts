import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/pi-*/test/**/*.test.ts"],
    environment: "node",
  },
});
