import { defineConfig } from "vitest/config";
import path from "path";

/** The league-history rehearsal (see README.md) - never part of `npm test`. */
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    include: ["scripts/rehearsal/*.rehearsal.ts"],
    setupFiles: ["scripts/rehearsal/setup.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "../../src") } },
});
