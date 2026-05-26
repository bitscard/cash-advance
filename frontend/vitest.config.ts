import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest config — keep it lean. JSDOM for component tests, a single
// setup file that pulls in @testing-library/jest-dom matchers and any
// browser-API stubs.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/e2e/**"],
  },
});
