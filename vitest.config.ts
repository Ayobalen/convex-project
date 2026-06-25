import { defineConfig } from "vitest/config";

/**
 * convex-test runs your real functions against an in-memory Convex backend on
 * the edge-runtime environment. `server.deps.inline` ensures convex-test is
 * transformed by Vite so `import.meta.glob` module discovery works.
 */
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["convex/**/*.test.ts"],
  },
});
