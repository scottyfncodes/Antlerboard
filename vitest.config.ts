import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  css: {
    postcss: {
      plugins: [],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
