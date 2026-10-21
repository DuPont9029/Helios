import { defineConfig, loadEnv } from "vite";

// Content Security Policy del sito (solo nel build: in sviluppo Vite usa script inline e websocket propri).
// Script solo dal sito (più la compilazione del WASM del motore); niente plugin, base o form esterni.
// Immagini, relay Nostr, TURN e GitHub (banlist) sono esterni: si permettono https:/wss: per connessioni e immagini.
// Il file singolo ha la sua (con l'impronta dello script incorporato): vedi scripts/build-standalone.mjs.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' https: wss: data: blob:",
  "img-src 'self' https: data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const cspPlugin = {
  name: "helios-csp",
  apply: "build",
  transformIndexHtml: (html, ctx) =>
    ctx.server ? html : html.replace(/<meta charset="utf-8" \/>/, (m) => `${m}\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

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
    // Il file singolo mette la sua CSP (con l'impronta dello script incorporato).
    plugins: standalone ? [] : [cspPlugin],
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
