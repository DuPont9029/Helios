import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // npm run standalone: tutto in un solo bundle (worker e import dinamici compresi), poi
  // scripts/build-standalone.mjs lo incolla in un unico HTML insieme ai dati.
  const standalone = mode === "standalone";
  const single = { output: { inlineDynamicImports: true } };
  // Stessa configurazione pubblica del sito (TURN e segnalazione di .env.production), non .env.standalone.
  if (standalone) Object.assign(process.env, { ...loadEnv("production", process.cwd(), "VITE_"), ...process.env });
  return {
    // Percorsi relativi: il build funziona anche in una sottocartella (es. GitHub Pages).
    base: "./",
    publicDir: standalone ? false : "public",
    // Da file:// Chrome non avvia i worker "module" creati da un blob: nel file singolo il worker è classico (iife).
    worker: standalone ? { format: "iife", rollupOptions: single } : { format: "es" },
    build: {
      target: "es2022",
      chunkSizeWarningLimit: standalone ? 100000 : 2000,
      ...(standalone && { outDir: "dist-standalone", rollupOptions: single, assetsInlineLimit: 1e9, cssCodeSplit: false, modulePreload: false }),
    },
    server: {
      port: 5173,
      // In sviluppo il server di segnalazione (npm run signal) gira sulla 8787.
      proxy: {
        "/ws": { target: "ws://localhost:8787", ws: true },
        "/api": { target: "http://localhost:8787" },
      },
    },
  };
});
