import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Plain Vite config, deliberately not Astro's getViteConfig(): the unit-tested modules are pure and
// import Supabase types only, so no Astro virtual module is needed.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
