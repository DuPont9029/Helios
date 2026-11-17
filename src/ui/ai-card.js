// Carte personalizzate generate dall'IA (net/ai.js): l'utente descrive la carta e il modello ne scrive i dati, il
// testo e lo script Lua. Tre passi:
//  1. dati e testo della carta (in forma leggibile: "Dragon", "LIGHT", frecce Link...) e qualche carta ufficiale con
//     effetti simili;
//  2. lo script Lua, con gli script veri di quelle carte come esempio dell'API di EDOPro;
//  3. il motore prova lo script (checkScript): se ci sono errori il modello lo corregge (una volta).
import { h, icon } from "./dom.js";
import { openModal, toast } from "./modal.js";
import { db } from "../data/db.js";
import { settings } from "../data/settings.js";
import { TYPE, ATTRIBUTES, RACES } from "../core/constants.js";
import { aiJson, hasAiKey, AI_KEY_URL } from "../net/ai.js";
import { autoScript, checkScript, cardScript, TEMPLATES } from "./script-editor.js";

const FRAMES = { normal: TYPE.NORMAL, effect: TYPE.EFFECT, ritual: TYPE.RITUAL | TYPE.EFFECT, fusion: TYPE.FUSION | TYPE.EFFECT, synchro: TYPE.SYNCHRO | TYPE.EFFECT, xyz: TYPE.XYZ | TYPE.EFFECT, link: TYPE.LINK | TYPE.EFFECT };
const FRAME_BITS = TYPE.NORMAL | TYPE.EFFECT | TYPE.RITUAL | TYPE.FUSION | TYPE.SYNCHRO | TYPE.XYZ | TYPE.LINK;
const ABILITIES = { Tuner: TYPE.TUNER, Flip: TYPE.FLIP, Gemini: TYPE.GEMINI, Spirit: TYPE.SPIRIT, Union: TYPE.UNION, Toon: TYPE.TOON };
const SPELL_TYPES = { Normal: 0, "Quick-Play": TYPE.QUICKPLAY, Continuous: TYPE.CONTINUOUS, Equip: TYPE.EQUIP, Field: TYPE.FIELD, Ritual: TYPE.RITUAL };
const TRAP_TYPES = { Normal: 0, Continuous: TYPE.CONTINUOUS, Counter: TYPE.COUNTER };
const ARROWS = { "Top-Left": 0x40, Top: 0x80, "Top-Right": 0x100, Left: 0x8, Right: 0x20, "Bottom-Left": 0x1, Bottom: 0x2, "Bottom-Right": 0x4 };
const ATTR_NAMES = ATTRIBUTES.map(([, n]) => n);
const RACE_NAMES = RACES.map(([, n]) => n);

const keyOf = (obj, bit) => Object.keys(obj).find((k) => obj[k] === bit);
const setNames = () => Object.entries(db.strings.setname ?? {}).map(([code, name]) => [+code, String(name)]);
const archetypeName = (code) => setNames().find(([c]) => c === code)?.[1] ?? "";
const archetypeCode = (name) => {
  const n = String(name ?? "").trim().toLowerCase().replace(/^"|"$/g, "");
  return n ? setNames().find(([, x]) => x.toLowerCase() === n)?.[0] ?? null : null;
};

/** La carta in forma leggibile (per il modello). */
function friendly(c) {
  const kind = c.type & TYPE.MONSTER ? "monster" : c.type & TYPE.SPELL ? "spell" : "trap";
  const out = { name: c.name, kind, desc: c.desc };
  if (kind === "monster") {
    Object.assign(out, {
      frame: Object.keys(FRAMES).find((k) => (c.type & FRAME_BITS) === FRAMES[k]) ?? (c.type & TYPE.NORMAL ? "normal" : "effect"),
      abilities: Object.keys(ABILITIES).filter((k) => c.type & ABILITIES[k]),
      pendulum: !!(c.type & TYPE.PENDULUM),
      attribute: ATTRIBUTES.find(([b]) => b === c.attribute)?.[1] ?? "DARK",
      race: RACES.find(([b]) => b === c.race)?.[1] ?? "Dragon",
      level: c.level,
      atk: c.atk,
      def: c.def,
    });
    if (c.type & TYPE.LINK) out.linkArrows = Object.keys(ARROWS).filter((k) => c.linkMarker & ARROWS[k]);
    if (c.type & TYPE.PENDULUM) Object.assign(out, { lscale: c.lscale, rscale: c.rscale, pendText: c.pendText ?? "" });
  } else if (kind === "spell") out.spellType = keyOf(SPELL_TYPES, c.type & (TYPE.QUICKPLAY | TYPE.CONTINUOUS | TYPE.EQUIP | TYPE.FIELD | TYPE.RITUAL)) ?? "Normal";
  else out.trapType = keyOf(TRAP_TYPES, c.type & (TYPE.CONTINUOUS | TYPE.COUNTER)) ?? "Normal";
  const arch = archetypeName(c.setcodes?.[0]);
  if (arch) out.archetype = arch;
  return out;
}

const clampInt = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : d);
const stat = (v, d) => (v === "?" || v === -2 ? -2 : clampInt(v, 0, 1_000_000, d));

/** I campi della carta da quelli leggibili scritti dal modello (base: la carta di partenza, di cui restano codice e artwork). */
function fromFriendly(f, base) {
  const c = { ...base, name: String(f.name || base.name).slice(0, 60), desc: String(f.desc ?? "").slice(0, 3000) };
  if (f.kind === "spell") c.type = TYPE.SPELL | (SPELL_TYPES[f.spellType] ?? 0);
  else if (f.kind === "trap") c.type = TYPE.TRAP | (TRAP_TYPES[f.trapType] ?? 0);
  else {
    const frame = FRAMES[f.frame] ?? TYPE.EFFECT;
    let type = TYPE.MONSTER | frame;
    for (const a of f.abilities ?? []) type |= ABILITIES[a] ?? 0;
    const link = !!(frame & TYPE.LINK);
    if (f.pendulum && !link) type |= TYPE.PENDULUM;
    c.type = type;
    c.attribute = ATTRIBUTES.find(([, n]) => n === String(f.attribute).toUpperCase())?.[0] ?? base.attribute;
    c.race = RACES.find(([, n]) => n.toLowerCase() === String(f.race).toLowerCase())?.[0] ?? base.race;
    c.atk = stat(f.atk, 0);
    c.def = link ? 0 : stat(f.def, 0);
    c.linkMarker = link ? (f.linkArrows ?? []).reduce((m, a) => m | (ARROWS[a] ?? 0), 0) || 0x2 : 0;
    c.level = link ? Math.max(1, [...c.linkMarker.toString(2)].filter((x) => x === "1").length) : clampInt(f.level, 0, 13, 4);
    c.lscale = type & TYPE.PENDULUM ? clampInt(f.lscale, 0, 15, 4) : 0;
    c.rscale = type & TYPE.PENDULUM ? clampInt(f.rscale ?? f.lscale, 0, 15, 4) : 0;
    c.pendText = type & TYPE.PENDULUM ? String(f.pendText ?? "").slice(0, 1000) : "";
  }
  const arch = archetypeCode(f.archetype);
  c.setcodes = arch ? [arch] : [];
  return c;
}

// ---------------------------------------------------------------- richieste

const CARD_SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING" },
    kind: { type: "STRING", enum: ["monster", "spell", "trap"] },
    frame: { type: "STRING", enum: Object.keys(FRAMES) },
    abilities: { type: "ARRAY", items: { type: "STRING", enum: Object.keys(ABILITIES) } },
    pendulum: { type: "BOOLEAN" },
    attribute: { type: "STRING", enum: ATTR_NAMES },
    race: { type: "STRING", enum: RACE_NAMES },
    level: { type: "INTEGER", description: "Level, or Rank for Xyz (0-13). Ignored for Link." },
    atk: { type: "INTEGER" },
    def: { type: "INTEGER", description: "Ignored for Link monsters" },
    linkArrows: { type: "ARRAY", items: { type: "STRING", enum: Object.keys(ARROWS) } },
    lscale: { type: "INTEGER" },
    rscale: { type: "INTEGER" },
    pendText: { type: "STRING", description: "Pendulum Effect text (Pendulum monsters only)" },
    spellType: { type: "STRING", enum: Object.keys(SPELL_TYPES) },
    trapType: { type: "STRING", enum: Object.keys(TRAP_TYPES) },
    archetype: { type: "STRING", description: "Exact name of an existing archetype the card belongs to, or empty" },
    desc: { type: "STRING", description: "Card text: materials line (Extra Deck), then effects, in official Yu-Gi-Oh! PSCT wording" },
    similarCards: { type: "ARRAY", items: { type: "STRING" }, description: "Exact English names of 1-3 real official cards whose effects work most like this card's (used as scripting references)" },
  },
  required: ["name", "kind", "desc", "similarCards"],
};

const CARD_SYSTEM = `You design custom Yu-Gi-Oh! cards for a simulator based on EDOPro.
Write card text in official Problem-Solving Card Text (PSCT): "Once per turn:", "You can only use this effect of "<name>" once per turn.", conditions before ":", costs before ";", targets with "target", etc.
Extra Deck monsters start their text with their materials (e.g. "2 Level 4 monsters", "1 Tuner + 1+ non-Tuner monsters", "2+ Effect Monsters").
Keep the card balanced and playable unless the user asks otherwise. Use the language of the user's request only if they ask; otherwise write the card in English.
Fill only the fields that apply to the card kind. similarCards must be real official card names that exist in the TCG/OCG.`;

const SCRIPT_SCHEMA = {
  type: "OBJECT",
  properties: {
    script: { type: "STRING", description: "Complete EDOPro Lua script of the card" },
    strings: { type: "ARRAY", items: { type: "STRING" }, description: "Short effect descriptions, index n is aux.Stringid(id,n)" },
  },
  required: ["script", "strings"],
};

const scriptSystem = () => `You are an expert EDOPro (Project Ignis) card scripter. Write the Lua script for a custom card so it behaves exactly as its text says.
Rules:
- Structure: "--<card name>", "local s,id=GetID()", "function s.initial_effect(c) ... end", then helper functions named s.<something> (s.cost, s.target, s.operation, s.filter...). "id" is the card's own code.
- Use only functions and constants that exist in EDOPro's API (Effect.CreateEffect, Duel.*, Card methods, aux.*, EFFECT_*, EVENT_*, CATEGORY_*, LOCATION_*, REASON_*, HINTMSG_*...). Follow the patterns of the reference scripts: target functions with "if chk==0 then return ... end", "chkc" for targeting effects, Duel.SetOperationInfo, Duel.Hint + Duel.SelectMatchingCard / Duel.SelectTarget in operations, checks like c:IsRelateToEffect(e) and tc:IsRelateToEffect(e).
- Hard once per turn: e:SetCountLimit(1,id) for the first effect, {id,1} for the second, {id,2} for the third. Soft once per turn: e:SetCountLimit(1).
- Every activated/trigger effect gets e:SetDescription(aux.Stringid(id,n)); put the matching short description at index n of "strings".
- Archetype checks: c:IsSetCard(0x<hex setcode>), using the setcode given below.
- Keep the Summon procedure lines given in the starting script (Fusion/Synchro/Xyz/Link/Pendulum procedures, EnableReviveLimit), adapting their materials to the card text.
- No require, no Debug.*, no os/io functions, no comments other than short "--" ones above each effect.
Example of a complete script (an effect that draws 1 card when Summoned):
${TEMPLATES[0].code({ name: "Example", type: TYPE.MONSTER | TYPE.EFFECT, level: 4 })}`;

/** Script ufficiali delle carte simili (per nome), già tagliati: [{ name, code, script }]. */
async function references(names) {
  const out = [];
  for (const name of (names ?? []).slice(0, 4)) {
    const n = String(name).trim().toLowerCase();
    const card = db.list.find((x) => !x.custom && x.name.toLowerCase() === n);
    if (!card || out.some((r) => r.code === card.code)) continue;
    const script = await cardScript(card.code).catch(() => null);
    if (script) out.push({ name: card.name, code: card.code, desc: card.desc, script: script.slice(0, 7000) });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * Genera (o modifica) una carta. base: la carta di partenza (codice e artwork restano); edit: il modello parte dai
 * suoi dati; withScript: scrive anche lo script. progress(text): a che punto è. Restituisce la carta (non salvata).
 */
export async function generateCard({ request, base, edit, withScript, progress, signal }) {
  const say = progress;
  say("Designing the card…");
  const cardPrompt = edit
    ? `Current card:\n${JSON.stringify(friendly(base), null, 1)}\n\nChange it as requested (keep everything else): ${request}`
    : `Design this card: ${request}`;
  const f = await aiJson({ system: CARD_SYSTEM, prompt: cardPrompt, schema: CARD_SCHEMA, signal });
  const c = fromFriendly(f, base);
  if (!withScript || (c.type & TYPE.NORMAL && !(c.type & TYPE.PENDULUM))) {
    // mostro Normale (o niente script): solo le procedure di evocazione
    return { ...c, script: autoScript(c), scriptAuto: true, strings: [] };
  }

  say("Reading scripts of similar official cards…");
  const refs = await references(f.similarCards);
  const setcode = c.setcodes[0];
  const scriptPrompt = [
    `Card (code ${c.code}):`,
    JSON.stringify({ ...friendly(c), setcode: setcode ? `0x${setcode.toString(16)}` : undefined }, null, 1),
    edit && base.script && base.scriptAuto === false ? `\nCurrent script (update it to the new text):\n${base.script}` : `\nStarting script (Summon procedures):\n${autoScript(c)}`,
    ...refs.map((r) => `\nReference: official script of "${r.name}" (${r.code}), whose text is:\n${r.desc}\n--- script ---\n${r.script}`),
  ].join("\n");
  say(refs.length ? `Writing the Lua script (references: ${refs.map((r) => r.name).join(", ")})…` : "Writing the Lua script…");
  let s = await aiJson({ system: scriptSystem(), prompt: scriptPrompt, schema: SCRIPT_SCHEMA, temperature: 0.3, signal });
  let card = { ...c, script: String(s.script ?? "").slice(0, 32_000), strings: (s.strings ?? []).slice(0, 16).map((x) => String(x).slice(0, 200)), scriptAuto: false };

  say("Checking the script in the Duel engine…");
  let res = await checkScript(card);
  if (!res.ok) {
    say("Fixing the errors found by the engine…");
    s = await aiJson({ system: scriptSystem(), prompt: `${scriptPrompt}\n\nYour script:\n${card.script}\n\nThe EDOPro engine reported these errors when loading it:\n${res.errors.join("\n")}\n\nReturn the corrected complete script.`, schema: SCRIPT_SCHEMA, temperature: 0.2, signal });
    card = { ...card, script: String(s.script ?? card.script).slice(0, 32_000), strings: (s.strings ?? card.strings).slice(0, 16).map((x) => String(x).slice(0, 200)) };
    res = await checkScript(card);
  }
  return { ...card, scriptErrors: res.ok ? [] : res.errors };
}

// ---------------------------------------------------------------- finestra

/** Campo della chiave (finestra dell'IA e Settings). */
export function aiKeyFields(field) {
  const key = h("input.input.mono", { type: "password", value: settings.aiKey ?? "", placeholder: "Paste your API key", autocomplete: "off", oninput: (e) => (settings.aiKey = e.target.value.trim()) });
  const show = h("button.btn.small.ghost", { title: "Show / hide", onclick: (e) => { e.preventDefault(); key.type = key.type === "password" ? "text" : "password"; } }, icon("visibility"));
  return [
    field("AI key (Google AI Studio)", h("div.row", key, show), h("span", "Free: create one at ", h("a", { href: AI_KEY_URL, target: "_blank", rel: "noopener" }, "aistudio.google.com/apikey"), ". It stays only in this browser and is sent only to Google (model: Gemini Flash-Lite).")),
  ];
}

/**
 * Finestra "Generate with AI". card: la carta aperta (o null). Restituisce { card, asNew } o null (annullata):
 * card è la carta generata, da salvare.
 */
export function openAiCardDialog(card, makeBase) {
  const field = (label, el, hint) => h("label.field", h("span", label), el, hint ? h("small.muted", hint) : null);
  const request = h("textarea.input", { rows: 5, placeholder: "e.g. A LIGHT Dragon Synchro monster that can banish a card on the field once per turn when an opponent's monster activates its effect" });
  const editBox = h("input", { type: "checkbox", checked: !!card });
  const scriptBox = h("input", { type: "checkbox", checked: true });
  const out = h("p.muted.small.ai-progress");
  const keyBox = h("div", hasAiKey() ? [] : aiKeyFields(field));
  let ctrl = null;
  const m = openModal({
    title: "Generate with AI",
    className: "ai-card",
    body: [
      keyBox,
      field("Describe the card", request, "Type, effects, archetype, mood… The AI writes data, text and Lua script; add the artwork yourself."),
      card ? h("label.check", editBox, `Change the open card ("${card.name}") instead of making a new one`) : null,
      h("label.check", scriptBox, "Write the Lua script too (checked in the Duel engine)"),
      out,
    ].filter(Boolean),
    actions: [
      { label: "Cancel", onClick: (close) => { ctrl?.abort(); close(null); } },
      {
        label: "Generate",
        primary: true,
        onClick: async (close) => {
          if (!request.value.trim()) return (out.textContent = "Describe the card first."), request.focus();
          if (!hasAiKey()) return (out.textContent = "Paste your AI key first."), keyBox.replaceChildren(...aiKeyFields(field));
          const gen = m.buttons[1];
          gen.disabled = true;
          out.className = "muted small ai-progress";
          ctrl = new AbortController();
          const edit = !!card && editBox.checked;
          try {
            const res = await generateCard({ request: request.value.trim(), base: edit ? card : makeBase(), edit, withScript: scriptBox.checked, progress: (t) => (out.textContent = t), signal: ctrl.signal });
            close({ card: res, asNew: !edit });
          } catch (e) {
            if (e.name === "AbortError") return;
            out.className = "ai-progress error";
            out.textContent = e.message;
            gen.disabled = false;
          }
        },
      },
    ],
  });
  setTimeout(() => request.focus(), 30);
  return m.result.then((v) => v ?? null);
}

/** Dopo la generazione: avviso se lo script ha ancora errori. */
export function reportAiResult(card) {
  if (card.scriptErrors?.length) toast(`Card generated, but the engine still reports script errors: open "Edit script" and use "Check script"`, { kind: "error", ms: 7000 });
  else toast(`"${card.name}" generated${card.scriptAuto ? "" : ": script loaded by the engine without errors"}. Check that it plays as written!`, { kind: "ok", ms: 5000 });
}
