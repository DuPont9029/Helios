// Impostazioni utente salvate in localStorage.

const KEY = "ygoweb.settings";

export const DEFAULT_ICE = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const DEFAULTS = {
  name: "Duelist",
  // {code} viene sostituito con il codice della carta.
  imageUrl: "https://images.ygoprodeck.com/images/cards/{code}.jpg",
  artUrl: "https://images.ygoprodeck.com/images/cards_cropped/{code}.jpg",
  animSpeed: 1,
  chainMode: "auto", // auto | always | never
  autoPlace: false,
  stun: DEFAULT_ICE.flatMap((s) => [s.urls].flat()).join("\n"),
  turnUrl: "",
  // TURN da usare: "cloudflare" (predefinito del sito), "custom" (turnUrl/turnUser/turnPass) o "off" (solo STUN).
  turnMode: "cloudflare",
  turnUser: "",
  turnPass: "",
  forceRelay: false,
  signalUrl: "", // vuoto = stesso host (server/signal.mjs)
  // Online Rooms: "server" = server di segnalazione (codici di 6 caratteri), "nostr" = stanze decentralizzate
  // sui relay Nostr pubblici (src/net/nostr-room.js, codici di 8 caratteri).
  roomMode: "server",
  lastDeck: null,
  lastBanlist: null,
  lastTimer: "omega",
  lastBestOf: 1, // partita: 1 (duello singolo), 3 o 5 (al meglio di) // chiave di TIMER_PRESETS (src/duel/clock.js)
  sleeve: null, // immagine del dorso delle proprie carte (data URL JPEG, vedi src/data/sleeve.js)
  fieldsUrl: "", // cartella dei campi 3D su un sito esterno (vedi src/data/fields3d.js); vuoto = VITE_FIELDS_URL
  field3d: "random", // campo 3D del duello: "" (campo 2D), "random" o l'id di un campo (es. "Mat_001")
  field3dFx: true, // campo 3D: particelle e bagliore
  pendulumIcon: null, // figura per le gemme delle zone Pendulum (data URL PNG con trasparenza)
  testDrawOrder: "random", // Test Duel: "random" o "ordered" (entrambi i giocatori pescano nell'ordine del mazzo)
  testOpponent: "deck", // Test Duel: "deck" (il giocatore 2 ha un mazzo) o "none" (nessun mazzo, passa sempre il turno)
  lastDrawOrder: "random", // contro la CPU: "random" o "ordered" (si pesca nell'ordine del mazzo)
  bookmarks: [], // editor: codici delle carte salvate tra i preferiti (scheda "Bookmarks")
  bookmarksSeeded: [], // preferiti predefiniti già proposti (vedi src/data/bookmarks.js)
  editorView: "grid", // editor: risultati della ricerca come carte ("grid") o come lista ("list")
  fieldSelect: true, // duello: le carte chieste da summon ed effetti si scelgono cliccandole sul campo (se sono tutte lì)
  comboStrict: false, // Combo Trainer: modalità strict (le azioni diverse dalla combo vengono bloccate)
  editorFilters: true, // editor: filtri della ricerca aperti (false = ridotti per avere più spazio per la lista)
};

let current = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    // Impostazioni salvate prima della scelta del TURN: chi aveva già un suo server continua a usarlo.
    if (!saved.turnMode && saved.turnUrl) saved.turnMode = "custom";
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = new Proxy(
  {},
  {
    get: (_, k) => current[k],
    set: (_, k, v) => {
      current[k] = v;
      try {
        localStorage.setItem(KEY, JSON.stringify(current));
      } catch {
        /* storage non disponibile */
      }
      return true;
    },
  }
);

export function resetSettings() {
  current = { ...DEFAULTS };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// TURN predefinito del sito ("cloudflare" nelle impostazioni), scelto al momento della build
// (vedi .env.production). Di solito è VITE_ICE_SERVERS_URL: il Worker in cloudflare/turn-credentials,
// che restituisce credenziali temporanee del TURN di Cloudflare senza esporre il token.
// In alternativa credenziali fisse:
//   VITE_TURN_URLS="turn:host:3478?transport=udp turns:host:5349"  VITE_TURN_USERNAME  VITE_TURN_CREDENTIAL
// Attenzione: in un sito statico questi valori finiscono nel JavaScript pubblicato e chiunque può leggerli.
const ENV = import.meta.env ?? {};
export const BUILD_TURN = (() => {
  const urls = String(ENV.VITE_TURN_URLS || "").split(/\s+/).filter(Boolean);
  return urls.length ? { urls, username: ENV.VITE_TURN_USERNAME || undefined, credential: ENV.VITE_TURN_CREDENTIAL || undefined } : null;
})();
// URL che restituisce i server ICE (JSON: [{urls, username, credential}] oppure {iceServers: [...]}),
// per i provider che danno credenziali TURN temporanee (es. Metered).
export const BUILD_ICE_URL = ENV.VITE_ICE_SERVERS_URL || "";
// Server di segnalazione predefinito (stanze online con codice corto), es. lo stesso Worker di Cloudflare.
// Vuoto = stesso indirizzo della pagina (server/signal.mjs). Le Settings possono indicarne un altro.
export const BUILD_SIGNAL_URL = ENV.VITE_SIGNAL_URL || "";

/** true se il sito ha un TURN predefinito configurato nella build. */
export const hasDefaultTurn = () => !!(BUILD_TURN || BUILD_ICE_URL);

/** Server ICE dalle impostazioni locali (STUN + TURN scelto in turnMode). */
export function localIceServers() {
  const out = [];
  const stun = String(settings.stun || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (stun.length) out.push({ urls: stun });
  if (settings.turnMode === "custom") {
    const turn = String(settings.turnUrl || "").split(/\s+/).filter(Boolean);
    if (turn.length) out.push({ urls: turn, username: settings.turnUser, credential: settings.turnPass });
  } else if (settings.turnMode !== "off" && BUILD_TURN) {
    out.push(BUILD_TURN);
  }
  return out;
}

export function imageUrl(code) {
  return settings.imageUrl.replace("{code}", code);
}

export function artUrl(code) {
  return settings.artUrl.replace("{code}", code);
}
