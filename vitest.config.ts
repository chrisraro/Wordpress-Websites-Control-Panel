import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  // tsconfig.json sets jsx:"preserve" for Next.js; override it here so the
  // transform actually converts JSX when a .tsx file (e.g. the PDF document)
  // is pulled into the test module graph, instead of leaving raw JSX in the output.
  oxc: { jsx: { runtime: "automatic" } },
});
