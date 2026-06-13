import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // node:sqlite is newer than vite's builtin list; load it natively, unbundled.
    server: {
      deps: {
        external: [/node:sqlite/],
      },
    },
  },
});
