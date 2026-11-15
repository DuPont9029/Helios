// Pagina dello script Lua di una carta personalizzata (aperta dall'editor della carta, a parte): l'editor Lua
// (ui/lua-editor.js: evidenziazione, autocompletamento e suggerimenti sull'API di EDOPro, errori di sintassi mentre si
// scrive), gli esempi pronti, il controllo nel motore e, accanto, gli script delle altre carte (ufficiali e
// personalizzate) scelti con il deck builder, da cui copiare o inserire le parti che servono.
// Lo script e i testi degli effetti (aux.Stringid) si salvano da soli mentre si scrive.
import { h, clear, icon } from "./dom.js";
import { toast } from "./modal.js";
import { cardFace } from "./card.js";
import { getCard, cardName, DATA_URL } from "../data/db.js";
import { TYPE, DUEL_MODES } from "../core/constants.js";
import { STANDALONE, loadArchive, archiveText } from "../data/bundle.js";
import { EngineClient } from "../duel/engine-client.js";
import { saveCustomCard, getCustomCard, isCustomCode, defaultScript, cleanCard, cardRow } from "../data/custom-cards.js";
import { createLuaEditor } from "./lua-editor.js";
import { openCardCollector } from "./editor.js";

/** Script di una carta: quello della carta personalizzata o il file ufficiale (dati del client). */
export async function cardScript(code) {
  if (isCustomCode(code)) return getCustomCard(code)?.script || null;
  const c = getCard(code);
  for (const x of [code, c?.alias].filter(Boolean)) {
    const name = `script/c${x}.lua`;
    try {
      const text = STANDALONE ? archiveText(await loadArchive(), name) : await fetch(DATA_URL + name).then((r) => (r.ok ? r.text() : null));
      if (text && !/^\s*</.test(text)) return text;
    } catch {
      /* si prova con il codice base */
    }
  }
  return null;
}

/**
 * Pagina dello script di una carta. onBack(card): torna all'editor della carta (con la carta aggiornata).
 */
export async function showScriptPage(app, card, { onBack }) {
  let c = structuredClone(card);
  const root = clear(app.root);
  const status = h("span.muted.small.cc-saved", "Saved");
  let saveTimer = 0;
  const saveSoon = () => {
    status.textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        c = await saveCustomCard(c);
        status.textContent = "Saved";
      } catch (e) {
        status.textContent = e.message;
      }
    }, 600);
  };
  const flush = async () => {
    clearTimeout(saveTimer);
    c = await saveCustomCard(c);
    return c;
  };

  const mainBox = h("div.se-editor");
  const refBox = h("div.se-editor.ref");
  const tabs = h("div.se-tabs");
  const checkOut = h("pre.cc-check", { hidden: true });
  const strings = h("textarea.input.cc-strings", {
    rows: 4,
    value: (c.strings ?? []).join("\n"),
    placeholder: "One per line: texts of the effects and prompts (aux.Stringid(id,0), aux.Stringid(id,1)…)",
    oninput: (e) => {
      c.strings = e.target.value.split("\n").slice(0, 16);
      saveSoon();
    },
  });
  const templates = h("select.select.small", h("option", { value: "" }, "Insert an example…"), TEMPLATES.map((t, i) => h("option", { value: i }, t.label)));

  root.append(
    h(
      "div.page.se-page",
      h(
        "div.page-head",
        h("button.btn.ghost.round.page-back", { title: "Back to the card", onclick: async () => onBack(await flush()) }, icon("chevron_left")),
        h("span.se-card", cardFace(c.code)),
        h("h1", `Script: ${c.name}`),
        status,
        h(
          "div.page-tools",
          templates,
          h("button.btn", { title: "Load the script in the Duel engine and show its errors", onclick: () => check() }, icon("bug_report"), " Check script"),
          h("button.btn.primary", { onclick: async () => onBack(await flush()) }, icon("check"), " Done")
        )
      ),
      h(
        "div.se-body",
        h("div.se-main", mainBox, checkOut, h("label.field", h("span", "Effect texts"), strings)),
        h(
          "div.se-side",
          h(
            "div.se-side-head",
            h("b", "Card scripts"),
            h("button.btn.small", { title: "Choose cards in the Deck builder (official or custom) and read their scripts", onclick: () => openRefs() }, icon("search"), " Open cards…")
          ),
          tabs,
          refBox,
          h(
            "div.se-side-actions",
            h("button.btn.small", { title: "Insert the selected part (or the whole script) at the cursor of your script", onclick: () => insertRef() }, icon("input"), " Insert selection"),
            h("button.btn.small.ghost", { title: "Copy the selected part (or the whole script)", onclick: () => copyRef() }, icon("content_copy"), " Copy")
          ),
          h("p.muted.small", "Select the lines you need in a card script, then Insert selection (or Ctrl+C / Ctrl+V).")
        )
      )
    )
  );

  status.textContent = "Loading the editor…";
  const main = await createLuaEditor(mainBox, {
    value: c.script || autoScript(c),
    onChange: (v) => {
      c.script = v;
      // scritto a mano: non segue più il tipo della carta
      if (v !== autoScript(c)) c.scriptAuto = false;
      saveSoon();
    },
  });
  const ref = await createLuaEditor(refBox, { value: "-- Open cards… to read the script of another card here.", readOnly: true });
  status.textContent = "Saved";

  templates.addEventListener("change", () => {
    const t = TEMPLATES[+templates.value];
    templates.value = "";
    if (!t) return;
    main.editor.setValue(t.code(c));
    if (t.strings && !(c.strings ?? []).some(Boolean)) {
      c.strings = t.strings;
      strings.value = t.strings.join("\n");
    }
    saveSoon();
  });

  // ---- script delle altre carte
  const open = []; // [{ code, text }]
  let current = null;
  const paintTabs = () => {
    clear(tabs).append(
      ...open.map((r) =>
        h(
          `div.se-tab${r === current ? ".on" : ""}`,
          { title: cardName(r.code), onclick: () => show(r) },
          h("span.se-tab-card", cardFace(r.code)),
          h("span.se-tab-name", cardName(r.code)),
          h("button.se-tab-x", { title: "Close", onclick: (e) => { e.stopPropagation(); open.splice(open.indexOf(r), 1); if (current === r) current = open[0] ?? null; current ? show(current) : ref.editor.setValue(""); paintTabs(); } }, "×")
        )
      )
    );
  };
  const show = (r) => {
    current = r;
    ref.editor.setValue(r.text);
    paintTabs();
  };
  const openRefs = async () => {
    const v = await openCardCollector({ title: "Card scripts", subtitle: "Choose the cards whose scripts you want to read (search the database or your custom cards), then Done", parts: [{ key: "main", label: "Scripts to open", cards: open.map((r) => r.code), max: 30 }], noBanlist: true, together: true });
    if (!v) return;
    for (const code of [...new Set(v.main)]) {
      if (open.some((r) => r.code === code)) continue;
      const text = await cardScript(code);
      open.push({ code, text: text ?? `-- ${cardName(code)}: no script (Normal monster or missing file)` });
    }
    if (open.length) show(open.find((r) => !current || r === current) ?? open[open.length - 1]);
    paintTabs();
  };
  const refText = () => ref.selection() || ref.value();
  const insertRef = () => (current ? main.insert(refText()) : toast("Open a card script first", { kind: "error" }));
  const copyRef = () => current && navigator.clipboard?.writeText(refText()).then(() => toast("Copied"));

  const check = async () => {
    checkOut.hidden = false;
    checkOut.className = "cc-check";
    checkOut.textContent = "Checking the script in the engine…";
    const res = await checkScript({ ...c, script: main.value() });
    checkOut.classList.add(res.ok ? "ok" : "bad");
    checkOut.textContent = res.ok ? "✓ The engine loaded the script without errors." : res.errors.join("\n");
  };
}

// ---------------------------------------------------------------- script

/** Script di base per il tipo della carta: le procedure di evocazione (Fusion, Synchro, Xyz, Link, Pendulum). */
export function autoScript(c) {
  const t = c.type;
  const lines = [];
  if (t & TYPE.MONSTER && t & (TYPE.FUSION | TYPE.SYNCHRO | TYPE.XYZ | TYPE.LINK | TYPE.RITUAL)) lines.push("\tc:EnableReviveLimit()");
  if (t & TYPE.FUSION) lines.push("\t--Fusion Materials: 2 monsters", "\tFusion.AddProcMixN(c,true,true,aux.TRUE,2)");
  if (t & TYPE.SYNCHRO) lines.push("\t--1 Tuner + 1+ non-Tuner monsters", "\tSynchro.AddProcedure(c,nil,1,1,Synchro.NonTuner(nil),1,99)");
  if (t & TYPE.XYZ) lines.push(`\t--2 Level ${c.level || 4} monsters`, `\tXyz.AddProcedure(c,nil,${c.level || 4},2)`);
  if (t & TYPE.LINK) lines.push(`\t--${c.level}+ monsters`, `\tLink.AddProcedure(c,nil,${Math.max(1, c.level)},${Math.max(1, c.level)})`);
  if (t & TYPE.PENDULUM) lines.push("\tPendulum.AddProcedure(c)");
  if (t & (TYPE.SPELL | TYPE.TRAP)) lines.push("\t--Activate", "\tlocal e1=Effect.CreateEffect(c)", "\te1:SetType(EFFECT_TYPE_ACTIVATE)", "\te1:SetCode(EVENT_FREE_CHAIN)", "\tc:RegisterEffect(e1)");
  if (!lines.length) return defaultScript(c);
  return `-- ${c.name}\nlocal s,id=GetID()\nfunction s.initial_effect(c)\n${lines.join("\n")}\nend\n`;
}

const head = (c) => `-- ${c.name}\nlocal s,id=GetID()\nfunction s.initial_effect(c)\n`;
const procs = (c) => autoScript(c).split("\n").filter((l) => /^\t(c:EnableReviveLimit|Fusion\.|Synchro\.|Xyz\.|Link\.|Pendulum\.|--(Fusion|1 Tuner|2 Level|\d+\+))/.test(l)).join("\n");
/** Esempi di effetti (API di EDOPro), adattati al tipo della carta. */
export const TEMPLATES = [
  {
    label: "Monster: draw 1 card when Summoned",
    strings: ["Draw 1 card"],
    code: (c) => `${head(c)}${procs(c) ? procs(c) + "\n" : ""}\t--When this card is Normal or Special Summoned: Draw 1 card
\tlocal e1=Effect.CreateEffect(c)
\te1:SetDescription(aux.Stringid(id,0))
\te1:SetCategory(CATEGORY_DRAW)
\te1:SetType(EFFECT_TYPE_SINGLE+EFFECT_TYPE_TRIGGER_O)
\te1:SetCode(EVENT_SUMMON_SUCCESS)
\te1:SetProperty(EFFECT_FLAG_DELAY+EFFECT_FLAG_PLAYER_TARGET)
\te1:SetCountLimit(1,id)
\te1:SetTarget(s.drtg)
\te1:SetOperation(s.drop)
\tc:RegisterEffect(e1)
\tlocal e2=e1:Clone()
\te2:SetCode(EVENT_SPSUMMON_SUCCESS)
\tc:RegisterEffect(e2)
end
function s.drtg(e,tp,eg,ep,ev,re,r,rp,chk)
\tif chk==0 then return Duel.IsPlayerCanDraw(tp,1) end
\tDuel.SetTargetPlayer(tp)
\tDuel.SetTargetParam(1)
\tDuel.SetOperationInfo(0,CATEGORY_DRAW,nil,0,tp,1)
end
function s.drop(e,tp,eg,ep,ev,re,r,rp)
\tlocal p,d=Duel.GetChainInfo(0,CHAININFO_TARGET_PLAYER,CHAININFO_TARGET_PARAM)
\tDuel.Draw(p,d,REASON_EFFECT)
end
`,
  },
  {
    label: "Monster: gains 500 ATK (continuous)",
    code: (c) => `${head(c)}${procs(c) ? procs(c) + "\n" : ""}\t--This card gains 500 ATK
\tlocal e1=Effect.CreateEffect(c)
\te1:SetType(EFFECT_TYPE_SINGLE)
\te1:SetProperty(EFFECT_FLAG_SINGLE_RANGE)
\te1:SetRange(LOCATION_MZONE)
\te1:SetCode(EFFECT_UPDATE_ATTACK)
\te1:SetValue(500)
\tc:RegisterEffect(e1)
end
`,
  },
  {
    label: "Monster: Quick Effect, negate an activation (once per turn)",
    strings: ["Negate the activation"],
    code: (c) => `${head(c)}${procs(c) ? procs(c) + "\n" : ""}\t--Quick Effect: negate the activation of a card or effect, and destroy it
\tlocal e1=Effect.CreateEffect(c)
\te1:SetDescription(aux.Stringid(id,0))
\te1:SetCategory(CATEGORY_NEGATE+CATEGORY_DESTROY)
\te1:SetType(EFFECT_TYPE_QUICK_O)
\te1:SetCode(EVENT_CHAINING)
\te1:SetProperty(EFFECT_FLAG_DAMAGE_STEP+EFFECT_FLAG_DAMAGE_CAL)
\te1:SetRange(LOCATION_MZONE)
\te1:SetCountLimit(1,id)
\te1:SetCondition(s.negcon)
\te1:SetTarget(s.negtg)
\te1:SetOperation(s.negop)
\tc:RegisterEffect(e1)
end
function s.negcon(e,tp,eg,ep,ev,re,r,rp)
\treturn rp==1-tp and not e:GetHandler():IsStatus(STATUS_BATTLE_DESTROYED) and Duel.IsChainNegatable(ev)
end
function s.negtg(e,tp,eg,ep,ev,re,r,rp,chk)
\tif chk==0 then return true end
\tDuel.SetOperationInfo(0,CATEGORY_NEGATE,eg,1,0,0)
\tif re:GetHandler():IsDestructable() and re:GetHandler():IsRelateToEffect(re) then
\t\tDuel.SetOperationInfo(0,CATEGORY_DESTROY,eg,1,0,0)
\tend
end
function s.negop(e,tp,eg,ep,ev,re,r,rp)
\tif Duel.NegateActivation(ev) and re:GetHandler():IsRelateToEffect(re) then
\t\tDuel.Destroy(eg,REASON_EFFECT)
\tend
end
`,
  },
  {
    label: "Spell: draw 2 cards",
    code: (c) => `${head(c)}\t--Draw 2 cards
\tlocal e1=Effect.CreateEffect(c)
\te1:SetCategory(CATEGORY_DRAW)
\te1:SetType(EFFECT_TYPE_ACTIVATE)
\te1:SetCode(EVENT_FREE_CHAIN)
\te1:SetProperty(EFFECT_FLAG_PLAYER_TARGET)
\te1:SetTarget(s.target)
\te1:SetOperation(s.activate)
\tc:RegisterEffect(e1)
end
function s.target(e,tp,eg,ep,ev,re,r,rp,chk)
\tif chk==0 then return Duel.IsPlayerCanDraw(tp,2) end
\tDuel.SetTargetPlayer(tp)
\tDuel.SetTargetParam(2)
\tDuel.SetOperationInfo(0,CATEGORY_DRAW,nil,0,tp,2)
end
function s.activate(e,tp,eg,ep,ev,re,r,rp)
\tlocal p,d=Duel.GetChainInfo(0,CHAININFO_TARGET_PLAYER,CHAININFO_TARGET_PARAM)
\tDuel.Draw(p,d,REASON_EFFECT)
end
`,
  },
  {
    label: "Spell/Trap: destroy 1 monster on the field (target)",
    code: (c) => `${head(c)}\t--Target 1 monster on the field; destroy it
\tlocal e1=Effect.CreateEffect(c)
\te1:SetCategory(CATEGORY_DESTROY)
\te1:SetType(EFFECT_TYPE_ACTIVATE)
\te1:SetCode(EVENT_FREE_CHAIN)
\te1:SetProperty(EFFECT_FLAG_CARD_TARGET)
\te1:SetTarget(s.target)
\te1:SetOperation(s.activate)
\tc:RegisterEffect(e1)
end
function s.target(e,tp,eg,ep,ev,re,r,rp,chk,chkc)
\tif chkc then return chkc:IsLocation(LOCATION_MZONE) end
\tif chk==0 then return Duel.IsExistingTarget(nil,tp,LOCATION_MZONE,LOCATION_MZONE,1,nil) end
\tDuel.Hint(HINT_SELECTMSG,tp,HINTMSG_DESTROY)
\tlocal g=Duel.SelectTarget(tp,nil,tp,LOCATION_MZONE,LOCATION_MZONE,1,1,nil)
\tDuel.SetOperationInfo(0,CATEGORY_DESTROY,g,1,0,0)
end
function s.activate(e,tp,eg,ep,ev,re,r,rp)
\tlocal tc=Duel.GetFirstTarget()
\tif tc and tc:IsRelateToEffect(e) then Duel.Destroy(tc,REASON_EFFECT) end
end
`,
  },
  {
    label: "Spell: add 1 monster from Deck to hand",
    code: (c) => `${head(c)}\t--Add 1 monster from your Deck to your hand
\tlocal e1=Effect.CreateEffect(c)
\te1:SetCategory(CATEGORY_TOHAND+CATEGORY_SEARCH)
\te1:SetType(EFFECT_TYPE_ACTIVATE)
\te1:SetCode(EVENT_FREE_CHAIN)
\te1:SetCountLimit(1,id,EFFECT_COUNT_CODE_OATH)
\te1:SetTarget(s.target)
\te1:SetOperation(s.activate)
\tc:RegisterEffect(e1)
end
function s.filter(c)
\treturn c:IsMonster() and c:IsAbleToHand()
end
function s.target(e,tp,eg,ep,ev,re,r,rp,chk)
\tif chk==0 then return Duel.IsExistingMatchingCard(s.filter,tp,LOCATION_DECK,0,1,nil) end
\tDuel.SetOperationInfo(0,CATEGORY_TOHAND,nil,1,tp,LOCATION_DECK)
end
function s.activate(e,tp,eg,ep,ev,re,r,rp)
\tDuel.Hint(HINT_SELECTMSG,tp,HINTMSG_ATOHAND)
\tlocal g=Duel.SelectMatchingCard(tp,s.filter,tp,LOCATION_DECK,0,1,1,nil)
\tif #g>0 then
\t\tDuel.SendtoHand(g,nil,REASON_EFFECT)
\t\tDuel.ConfirmCards(1-tp,g)
\tend
end
`,
  },
];

/**
 * Prova dello script nel motore: un duello con la carta nei mazzi di entrambi (il motore carica lo script quando la
 * carta entra in gioco). Errori di sintassi e di esecuzione arrivano nel registro del motore.
 */
export async function checkScript(card) {
  const c = cleanCard(card);
  if (!c) return { ok: false, errors: ["Invalid card data"] };
  const engine = new EngineClient();
  try {
    await engine.call("init", { dataUrl: DATA_URL, archive: STANDALONE ? (await loadArchive()).bytes : null });
    await engine.send("custom", { rows: [cardRow(c)], scripts: { [`c${c.code}.lua`]: c.script || defaultScript(c) } });
    const extra = !!(c.type & (TYPE.FUSION | TYPE.SYNCHRO | TYPE.XYZ | TYPE.LINK));
    const deck = { main: extra ? [] : [c.code, c.code, c.code], extra: extra ? [c.code] : [] };
    const res = await engine.call("start", { flags: String(DUEL_MODES.MR5.flags), seed: ["1", "2", "3", "4"], lp: 8000, hand: 3, draw: 1, decks: [deck, deck] });
    const errors = [...new Set((res.logs ?? []).map((l) => l.text).filter((t) => /error|attempt|nil|unexpected|expected/i.test(t)))];
    return { ok: !errors.length, errors };
  } catch (e) {
    return { ok: false, errors: [e.message] };
  } finally {
    engine.terminate();
  }
}

