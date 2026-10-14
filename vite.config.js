import { defineConfig } from "vite";

export default defineConfig({
  // Percorsi relativi: il build funziona anche in una sottocartella (es. GitHub Pages).
  base: "./",
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    // In sviluppo il server di segnalazione (npm run signal) gira sulla 8787.
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
      "/api": { target: "http://localhost:8787" },
    },
  },
});
