import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Unit tests for the pure lib/* modules (planner engine). Node environment — no
// DOM needed. tsconfigPaths honours the "@/*" alias from tsconfig.json so tests
// resolve imports exactly as the app does. (.mts so the ESM-only tsconfigPaths
// plugin loads correctly in this CommonJS package.)
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
