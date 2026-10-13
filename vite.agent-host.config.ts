import { defineConfig } from "vite";

// Builds the standalone agent host: one Node script with its dependencies
// bundled, run as `node dist-agent-host/buzz-agent-host.mjs run <pubkey>`.
export default defineConfig({
  publicDir: false,
  ssr: { noExternal: true, target: "node" },
  build: {
    outDir: "dist-agent-host",
    emptyOutDir: true,
    ssr: "src/agent-host/main.ts",
    rolldownOptions: {
      output: { entryFileNames: "buzz-agent-host.mjs", codeSplitting: false },
    },
  },
});
