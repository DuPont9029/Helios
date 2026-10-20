// Converte i dati di ProjectIgnis (CardScripts, BabelCDB, LFLists, strings.conf)
// in file statici serviti dal client web in public/data.
//
// Uso: npm run data            (clona/aggiorna i repo in vendor/ e genera public/data)
//      npm run data -- --offline  (usa solo quello che c'è già in vendor/)
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const VENDOR = path.join(ROOT, "vendor");
const OUT = path.join(ROOT, "public", "data");
const offline = process.argv.includes("--offline");

const REPOS = {
  CardScripts: "https://github.com/ProjectIgnis/CardScripts.git",
  BabelCDB: "https://github.com/ProjectIgnis/BabelCDB.git",
  LFLists: "https://github.com/ProjectIgnis/LFLists.git",
};
const STRINGS_URL =
  "https://raw.githubusercontent.com/ProjectIgnis/Distribution/master/config/strings.conf";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function syncRepos() {
  fs.mkdirSync(VENDOR, { recursive: true });
  for (const [name, url] of Object.entries(REPOS)) {
    const dir = path.join(VENDOR, name);
    if (offline) continue;
    if (fs.existsSync(path.join(dir, ".git"))) {
      console.log(`aggiorno ${name}...`);
      git(["fetch", "--depth", "1", "origin"], dir);
      git(["reset", "--hard", "FETCH_HEAD"], dir);
    } else {
      console.log(`clono ${name}...`);
      git(["clone", "--depth", "1", url, dir], VENDOR);
    }
  }
  const stringsFile = path.join(VENDOR, "strings.conf");
  if (!offline) {
    console.log("scarico strings.conf...");
    const res = await fetch(STRINGS_URL);
    if (!res.ok) throw new Error(`strings.conf: HTTP ${res.status}`);
    fs.writeFileSync(stringsFile, await res.text());
  }
}

// ---------------------------------------------------------------- carte

// Ordine di priorità: la prima occorrenza di un id vince.
const CDB_FILES = (dir) => {
  const all = fs.readdirSync(dir).filter((f) => f.endsWith(".cdb"));
  const pick = (re) => all.filter((f) => re.test(f)).sort();
  return [
    "cards.cdb",
    ...pick(/^release-.*\.cdb$/),
    ...pick(/^prerelease-(?!cards-rush).*\.cdb$/),
    "cards-unofficial.cdb",
  ].filter((f) => all.includes(f));
};

function buildCards() {
  const dir = path.join(VENDOR, "BabelCDB");
  const seen = new Map();
  for (const file of CDB_FILES(dir)) {
    const db = new DatabaseSync(path.join(dir, file), { readOnly: true });
    const stmt = db.prepare(
      `SELECT d.id, d.ot, d.alias, d.setcode, d.type, d.atk, d.def, d.level,
              d.race, d.attribute, d.category, t.*
       FROM datas d JOIN texts t ON t.id = d.id`
    );
    // setcode e category possono superare 2^53: li leggiamo come BigInt.
    stmt.setReadBigInts(true);
    const BIG = new Set(["setcode", "race", "category"]);
    let added = 0;
    for (const big of stmt.all()) {
      const r = {};
      for (const [k, v] of Object.entries(big)) {
        r[k] = typeof v === "bigint" && !BIG.has(k) ? Number(v) : v;
      }
      if (seen.has(r.id)) continue;
      const strs = [];
      for (let i = 1; i <= 16; i++) strs.push(r[`str${i}`] ?? "");
      while (strs.length && !strs[strs.length - 1]) strs.pop();
      // setcode: 4 setcode da 16 bit impacchettati in un intero a 64 bit
      const sc = BigInt.asUintN(64, BigInt(r.setcode));
      const setcodes = [];
      for (let i = 0n; i < 4n; i++) {
        const s = Number((sc >> (i * 16n)) & 0xffffn);
        if (s) setcodes.push(s);
      }
      seen.set(r.id, [
        r.id,
        r.ot,
        r.alias,
        setcodes,
        r.type,
        r.atk,
        r.def,
        r.level, // livello | scala sx << 24 | scala dx << 16
        Number(r.race), // la razza sta in 32 bit per tutte le carte attuali
        r.attribute,
        Number(BigInt.asUintN(64, BigInt(r.category)) & 0xffffffffn),
        r.name ?? "",
        r.desc ?? "",
        strs,
        file === "cards-unofficial.cdb" ? 1 : file.startsWith("prerelease") ? 2 : 0,
      ]);
      added++;
    }
    db.close();
    console.log(`  ${file}: ${added} carte`);
  }
  const cards = [...seen.values()];
  fs.writeFileSync(path.join(OUT, "cards.json"), JSON.stringify(cards));
  console.log(`cards.json: ${cards.length} carte`);
  return seen;
}

// ---------------------------------------------------------------- stringhe

function buildStrings() {
  const text = fs.readFileSync(path.join(VENDOR, "strings.conf"), "utf8");
  const out = { system: {}, victory: {}, counter: {}, setname: {} };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^!(system|victory|counter|setname)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const key = m[1] === "system" ? parseInt(m[2], 10) : parseInt(m[2], 16);
    if (Number.isNaN(key)) continue;
    out[m[1]][key] = m[3].trim();
  }
  fs.writeFileSync(path.join(OUT, "strings.json"), JSON.stringify(out));
  console.log(`strings.json: ${Object.keys(out.system).length} stringhe di sistema`);
}

// ---------------------------------------------------------------- banlist

function buildBanlists() {
  const dir = path.join(VENDOR, "LFLists");
  const lists = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".lflist.conf")).sort()) {
    let cur = null;
    for (const raw of fs.readFileSync(path.join(dir, file), "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("!")) {
        cur = { name: line.slice(1).trim(), file, whitelist: false, cards: {} };
        lists.push(cur);
        continue;
      }
      if (!cur) continue;
      if (line.startsWith("$whitelist")) {
        cur.whitelist = true;
        continue;
      }
      const m = line.match(/^(\d+)\s+(-?\d+)/);
      if (m) cur.cards[m[1]] = parseInt(m[2], 10);
    }
  }
  // Le banlist "correnti" (TCG/OCG) prima, poi le altre.
  const rank = (l) => (/TCG/.test(l.file) ? 0 : /OCG/.test(l.file) ? 1 : 2);
  lists.sort((a, b) => rank(a) - rank(b));
  fs.writeFileSync(path.join(OUT, "banlists.json"), JSON.stringify(lists));
  console.log(`banlists.json: ${lists.length} banlist`);
}

// ---------------------------------------------------------------- script lua

function buildScripts() {
  const src = path.join(VENDOR, "CardScripts");
  const dst = path.join(OUT, "script");
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  const copyLua = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".lua")) continue;
      const to = path.join(dst, f);
      if (fs.existsSync(to)) continue;
      fs.copyFileSync(path.join(dir, f), to);
      n++;
    }
  };
  copyLua(src); // constant.lua, utility.lua, proc_*.lua ...
  for (const sub of ["official", "pre-release", "unofficial"]) copyLua(path.join(src, sub));
  console.log(`script: ${n} file lua`);
}

// ---------------------------------------------------------------- deck di esempio

// Mazzi semplici costruiti per nome, così restano validi anche se cambiano i DB.
const STARTERS = {
  "Starter - Dark Magician": {
    level: "Basic",
    main: [
      ["Dark Magician", 3], ["Dark Magician Girl", 2], ["Magician's Rod", 3],
      ["Magicians' Souls", 2], ["Apprentice Illusion Magician", 2], ["Skilled Dark Magician", 1],
      ["Mystical Elf", 2], ["Summoned Skull", 2], ["Celtic Guardian", 2],
      ["Dark Magic Attack", 1], ["Thousand Knives", 1], ["Dark Magical Circle", 2],
      ["Illusion Magic", 1], ["Pot of Prosperity", 1], ["Mystical Space Typhoon", 2],
      ["Eternal Soul", 1], ["Dark Magic Veil", 1], ["Mirror Force", 1], ["Magician Navigation", 2],
      ["Dark Burning Attack", 1], ["Monster Reborn", 1], ["Kuriboh", 2], ["Trap Hole", 2],
      ["Swords of Revealing Light", 1], ["Magic Cylinder", 1],
    ],
    extra: [["Dark Paladin", 1], ["The Dark Magicians", 1], ["Ebon Illusion Magician", 1]],
  },
  "Starter - Blue-Eyes": {
    level: "Basic",
    main: [
      ["Blue-Eyes White Dragon", 3], ["Blue-Eyes Alternative White Dragon", 2],
      ["Sage with Eyes of Blue", 3], ["The White Stone of Ancients", 2], ["The White Stone of Legend", 3],
      ["Dragon Spirit of White", 2], ["Maiden with Eyes of Blue", 2],
      ["Trade-In", 3], ["The Melody of Awakening Dragon", 2], ["Return of the Dragon Lords", 2],
      ["Monster Reborn", 1], ["Mystical Space Typhoon", 2], ["Cosmic Cyclone", 1], ["Mirror Force", 1],
      ["Dragon Shrine", 2], ["Burst Stream of Destruction", 1], ["Lord of D.", 1],
      ["The Flute of Summoning Dragon", 1], ["Trap Hole", 2], ["Dark Hole", 1], ["Magic Cylinder", 1],
      ["Swords of Revealing Light", 1], ["Giant Soldier of Stone", 1],
    ],
    extra: [
      ["Blue-Eyes Twin Burst Dragon", 1], ["Blue-Eyes Ultimate Dragon", 1],
      ["Blue-Eyes Spirit Dragon", 1], ["Azure-Eyes Silver Dragon", 1],
    ],
  },
};

function buildStarters(cards) {
  const byName = new Map();
  for (const c of cards.values()) if (c[14] === 0 && !byName.has(c[11])) byName.set(c[11], c[0]);
  const decks = [];
  for (const [name, def] of Object.entries(STARTERS)) {
    // level: livello del mazzo base nel gioco (vedi src/data/base-content.js).
    const deck = { name, level: def.level, main: [], extra: [], side: [] };
    for (const part of ["main", "extra"]) {
      for (const [cardName, count] of def[part]) {
        const id = byName.get(cardName);
        if (!id) {
          if (count) console.warn(`  [starter] carta non trovata: ${cardName}`);
          continue;
        }
        for (let i = 0; i < count; i++) deck[part].push(id);
      }
    }
    decks.push(deck);
    console.log(`  ${name}: ${deck.main.length} main, ${deck.extra.length} extra`);
  }
  fs.writeFileSync(path.join(OUT, "starter-decks.json"), JSON.stringify(decks));
}

// ---------------------------------------------------------------- main

await syncRepos();
fs.mkdirSync(OUT, { recursive: true });
const cards = buildCards();
buildStrings();
buildBanlists();
buildScripts();
buildStarters(cards);

const manifest = { built: new Date().toISOString(), repos: {} };
for (const name of Object.keys(REPOS)) {
  manifest.repos[name] = git(["rev-parse", "HEAD"], path.join(VENDOR, name));
}
// Due peer devono avere gli stessi script per restare sincronizzati.
manifest.version = manifest.repos.CardScripts.slice(0, 10) + "-" + manifest.repos.BabelCDB.slice(0, 10);
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("manifest:", manifest.version);
