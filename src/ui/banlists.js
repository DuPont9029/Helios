// Banlist personalizzate: la finestra per gestirle (nuova, da una ufficiale o vuota; modifica; codice; elimina) e la
// modifica, nella schermata del deck builder con quattro parti: Forbidden, Limited, Semi-Limited e Unlimited (il tasto
// destro sposta una carta alla parte dopo). I menu delle banlist (banlistSelect) hanno la voce "Custom banlists…".
import { h, clear, icon } from "./dom.js";
import { openModal, toast, confirmModal } from "./modal.js";
import { miniCards } from "./card.js";
import { db } from "../data/db.js";
import { customBanlists, saveCustomBanlist, deleteCustomBanlist, banlistToCode, banlistFromCode, BANLIST_PREFIX } from "../data/custom-banlists.js";
import { openCardCollector } from "./editor.js";

const MANAGE = "\u0000manage";
const LIMITS = [
  ["forbidden", "Forbidden", 0],
  ["limited", "Limited", 1],
  ["semi", "Semi-Limited", 2],
  ["unlimited", "Unlimited", 3],
];

/**
 * Menu delle banlist: "No banlist", le ufficiali, le personalizzate e "Custom banlists…" (apre la gestione; poi il
 * menu si aggiorna e, se se n'è creata o modificata una, la sceglie). cls: classi del select (es. "select").
 */
export function banlistSelect(cls = "select") {
  const sel = h(`select.${cls}`);
  let last = "";
  const fill = () => {
    const v = sel.value && sel.value !== MANAGE ? sel.value : last;
    const official = db.banlists.filter((b) => !b.custom);
    const custom = db.banlists.filter((b) => b.custom);
    clear(sel).append(
      h("option", { value: "" }, "No banlist"),
      ...official.map((b) => h("option", { value: b.name }, b.name)),
      custom.length ? h("optgroup", { label: "Custom" }, custom.map((b) => h("option", { value: b.name }, b.name))) : null,
      h("option", { value: MANAGE }, "Custom banlists…")
    );
    sel.value = db.banlists.some((b) => b.name === v) ? v : "";
    last = sel.value;
  };
  // La banlist di prima (anche se messa dal codice con sel.value = ...), da rimettere se si sceglie "Custom banlists…".
  for (const ev of ["focus", "pointerdown", "keydown"]) sel.addEventListener(ev, () => sel.value !== MANAGE && (last = sel.value));
  // Prima degli altri ascoltatori: la voce "Custom banlists…" non è una banlist da usare.
  sel.addEventListener("change", async (e) => {
    if (sel.value !== MANAGE) {
      last = sel.value;
      return;
    }
    e.stopImmediatePropagation();
    sel.value = last;
    const picked = await openBanlistManager();
    fill();
    if (picked && db.banlists.some((b) => b.name === picked)) sel.value = last = picked;
    sel.dispatchEvent(new Event("change"));
  });
  fill();
  return sel;
}

const counts = (b) => {
  const n = [0, 0, 0, 0];
  for (const v of Object.values(b.cards)) n[v]++;
  return n;
};

/** Finestra delle banlist personalizzate. Restituisce il nome dell'ultima creata o modificata (o null). */
export async function openBanlistManager() {
  let picked = null;
  const list = h("div.banlist-list");
  const render = () => {
    const all = customBanlists();
    clear(list).append(
      ...(all.length
        ? all.map((b) => {
            const [f, l, s, u] = counts(b);
            const forbidden = Object.entries(b.cards).filter(([, v]) => v === 0).map(([k]) => +k);
            return h(
              "div.banlist-row",
              h("div.banlist-info",
                h("b", b.name),
                h("span.muted.small", b.whitelist ? `Whitelist: ${u + s + l} allowed cards` : `${f} Forbidden · ${l} Limited · ${s} Semi-Limited${u ? ` · ${u} Unlimited` : ""}`),
                !b.whitelist && forbidden.length ? miniCards(forbidden.slice(0, 8)) : null),
              h("div.banlist-actions",
                h("button.btn.small.primary", { onclick: async () => { const v = await editBanlist(b); if (v) { picked = v.name; render(); } } }, icon("edit"), " Edit"),
                h("label.check.small", { title: "Only the listed cards can be used (the others are Forbidden)" }, h("input", { type: "checkbox", checked: b.whitelist, onchange: (e) => { picked = saveCustomBanlist({ ...b, whitelist: e.target.checked }).name; render(); } }), "Whitelist"),
                h("button.btn.small", { title: "Copy the banlist code (import it in another Helios)", onclick: () => copyCode(b) }, icon("content_copy")),
                h("button.btn.small.ghost", { title: "Rename", onclick: async () => { const n = await askName("Rename banlist", b.name); if (n) { picked = saveCustomBanlist({ ...b, name: n }).name; render(); } } }, icon("drive_file_rename_outline")),
                h("button.btn.small.ghost", { title: "Delete", onclick: async () => { if (await confirmModal("Delete banlist?", `"${b.name}" will be removed.`, "Delete", "Cancel")) { deleteCustomBanlist(b.id); if (picked === b.name) picked = null; render(); } } }, icon("delete")))
            );
          })
        : [h("p.muted", "No custom banlists yet. Start from an official banlist or from an empty one, then add cards as in the deck builder.")])
    );
  };
  render();
  const m = openModal({
    title: "Custom banlists",
    className: "wide banlist-manager",
    body: [h("p.muted.small", "Your banlists work everywhere: Deck builder, Duels against the CPU and online (your opponent receives the whole list)."), list],
    actions: [
      { label: "Close", value: null },
      { label: "Import a code", onClick: async () => { const b = await importCode(); if (b) { picked = b.name; render(); } } },
      { label: "New banlist", primary: true, onClick: async () => { const b = await newBanlist(); if (b) { picked = b.name; render(); } } },
    ],
  });
  await m.result;
  return picked;
}

async function askName(title, value = "") {
  const input = h("input.input", { value, maxLength: 50 });
  const v = await openModal({ title, body: [h("label.field", h("span", "Name"), input)], actions: [{ label: "Cancel", value: null }, { label: "OK", primary: true, onClick: (close) => close(input.value.trim()) }] }).result;
  return v || null;
}

/** Nuova banlist: nome e punto di partenza (una banlist ufficiale o vuota), poi la modifica. */
async function newBanlist() {
  const name = h("input.input", { value: "My banlist", maxLength: 50 });
  const from = h("select.select", h("option", { value: "" }, "Empty (all cards Unlimited)"), db.banlists.filter((b) => !b.points).map((b) => h("option", { value: b.name }, `Copy of ${b.name}`)));
  const ok = await openModal({
    title: "New banlist",
    body: [h("label.field", h("span", "Name"), name), h("label.field", h("span", "Start from"), from)],
    actions: [{ label: "Cancel", value: null }, { label: "Create", primary: true, onClick: (close) => close(true) }],
  }).result;
  if (!ok) return null;
  const base = db.banlists.find((b) => b.name === from.value);
  const b = saveCustomBanlist({ name: name.value, whitelist: !!base?.whitelist, cards: { ...(base?.cards ?? {}) } });
  return (await editBanlist(b)) ?? b;
}

/** Modifica nel deck builder: le carte nelle quattro parti; Save salva la banlist. */
async function editBanlist(b) {
  const parts = LIMITS.map(([key, label, lim]) => ({
    key,
    label,
    cards: Object.entries(b.cards).filter(([, v]) => v === lim).map(([k]) => +k).filter((c) => db.cards.has(c)),
    hint: lim === 3 ? (b.whitelist ? "Allowed with 3 copies" : "Free again (only to override a copied list)") : `${lim} ${lim === 1 ? "copy" : "copies"}`,
  }));
  const v = await openCardCollector({
    title: `Banlist: ${b.name}`,
    subtitle: `Click a card in the search to add it to the selected part; right-click a card to move it to the next part.${b.whitelist ? " Whitelist: the cards not listed are Forbidden." : ""}`,
    parts,
    noBanlist: true,
    contextNext: true,
    together: true,
    sortable: true,
  });
  if (!v) return null;
  // Le carte della lista che non sono nei dati del client (non si vedono nel deck builder) restano come erano.
  const cards = Object.fromEntries(Object.entries(b.cards).filter(([k]) => !db.cards.has(+k)));
  for (const [key, , lim] of LIMITS) for (const c of new Set(v[key])) if (cards[c] === undefined) cards[c] = lim;
  const saved = saveCustomBanlist({ ...b, cards });
  toast(`Banlist saved: "${saved.name}"`);
  return saved;
}

async function copyCode(b) {
  const code = banlistToCode(b);
  const show = () =>
    openModal({ title: "Banlist code", body: [h("p.muted.small", "Copy this code and import it in another Helios client (a banlist menu → Custom banlists… → Import a code)."), h("textarea.input.combo-code", { readOnly: true, rows: 5, value: code, onfocus: (e) => e.target.select() })], actions: [{ label: "Close", value: null, primary: true }] });
  if (!navigator.clipboard?.writeText) return show();
  navigator.clipboard.writeText(code).then(() => toast(`Banlist code copied: "${b.name}"`), show);
}

async function importCode() {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    /* appunti non accessibili */
  }
  if (!String(text).trim().startsWith(BANLIST_PREFIX)) {
    const area = h("textarea.input.combo-code", { rows: 5, placeholder: `${BANLIST_PREFIX}...` });
    const v = await openModal({ title: "Import a banlist", body: [h("p.muted.small", "Paste the banlist code:"), area], actions: [{ label: "Cancel", value: null }, { label: "Import", primary: true, onClick: (close) => close(area.value) }] }).result;
    if (!v) return null;
    text = v;
  }
  try {
    const b = saveCustomBanlist(banlistFromCode(text));
    toast(`Banlist imported: "${b.name}"`);
    return b;
  } catch (e) {
    openModal({ title: "Import a banlist", body: [h("p", e.message)], actions: [{ label: "Close", value: null, primary: true }] });
    return null;
  }
}
