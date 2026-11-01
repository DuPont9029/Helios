import { h, clear, icon, pickFile } from "./dom.js";
import { makeSleeve, validSleeve } from "../data/sleeve.js";
import { makePendulumIcons, pendulumIcons, mirrorFor } from "../data/pendulum.js";
import { MOAI_DEFAULT, MOAI_SHAPES, DRAWING_W, DRAWING_H, DRAWING_RECTS, moaiConfig, drawingFrom, drawDrawing } from "../data/moai.js";
import { toast, confirmModal, openModal } from "./modal.js";
import { hasDefaultTurn, settings, resetSettings, BUILD_SIGNAL_URL } from "../data/settings.js";
import { resolveIceServers } from "../net/signaling.js";
import { db } from "../data/db.js";
import { identity, importIdentity, newIdentity, profileKind, npubOf, nsec, passwordBackup, shortKey } from "../net/identity.js";
import { copyText } from "../net/clipboard.js";
import { statusChanged } from "../net/social.js";
import { eloRelays } from "../net/elo.js";
import { uploadHistory, rememberUpload, forgetUpload } from "../data/uploads.js";
import { fieldList, fieldsBase, fieldFiles, isZip, storedSize, forgetZips, useZipFile, BUILD_FIELDS_URL, BUILTIN_FIELDS } from "../data/fields3d.js";
import { COACHING } from "../data/features.js";

/** Copia un testo segreto: prima si conferma. */
async function copySecret(title, message, text) {
  if (!(await confirmModal(title, message, "Copy", "Cancel"))) return;
  toast((await copyText(typeof text === "function" ? text() : text)) ? "Copied to the clipboard" : "Copy failed", { kind: "ok" });
}

/** Le 12 parole del profilo, in griglia. */
function showSeed() {
  const words = identity().seed.split(" ");
  openModal({
    title: "Your seed words",
    className: "seed-modal",
    body: [
      h("p.status-box.error", "Write these words down in order and keep them private: whoever has them can play as you, and they are the only way to get your profile back (rating, friends) on another browser."),
      h("ol.seed-words", words.map((w) => h("li", w))),
    ],
    actions: [
      { label: "Copy", onClick: () => copyText(identity().seed).then((ok) => toast(ok ? "Seed words copied" : "Copy failed")) },
      { label: "Done", primary: true, value: true },
    ],
  });
}

/** Backup del profilo con una password (ncryptsec, NIP-49). */
async function exportWithPassword() {
  const a = h("input.input", { type: "password", autocomplete: "new-password", placeholder: "Password" });
  const b = h("input.input", { type: "password", autocomplete: "new-password", placeholder: "Repeat the password" });
  const err = h("p.muted.small");
  const v = await openModal({
    title: "Backup with a password",
    body: [h("p.muted.small", "The backup (ncryptsec1…) only works with this password: you can keep it somewhere less safe (a note, an email to yourself). Import it in Settings → Profile."), a, b, err],
    actions: [{ label: "Cancel", value: null }, {
      label: "Create backup",
      primary: true,
      onClick: (close) => {
        if (a.value.length < 8) return (err.textContent = "Use at least 8 characters.");
        if (a.value !== b.value) return (err.textContent = "The passwords do not match.");
        close(a.value);
      },
    }],
  }).result;
  if (!v) return;
  toast("Encrypting…");
  // scrypt richiede un attimo: si lascia disegnare il messaggio.
  await new Promise((r) => setTimeout(r, 30));
  const code = passwordBackup(v);
  openModal({
    title: "Password backup",
    body: [h("p.muted.small", "Your backup (it needs the password):"), h("textarea.code-area.mono", { readOnly: true }, code)],
    actions: [{ label: "Copy", onClick: () => copyText(code).then((ok) => toast(ok ? "Backup copied" : "Copy failed")) }, { label: "Done", primary: true, value: true }],
  });
}

/** Import del profilo: parole, nsec, backup con password o chiave esadecimale. */
async function importProfile(onDone) {
  const input = h("textarea.code-area.mono", { placeholder: "12 seed words, nsec1…, ncryptsec1… or 64 hexadecimal characters" });
  const pass = h("input.input", { type: "password", placeholder: "Backup password", hidden: true });
  const err = h("p.muted.small");
  input.addEventListener("input", () => (pass.hidden = profileKind(input.value) !== "ncryptsec"));
  const v = await openModal({
    title: "Import profile",
    body: [h("p.muted.small", "It replaces the profile of this browser (player key, rating, friends): export the current one first if you want to keep it."), input, pass, err],
    actions: [{ label: "Cancel", value: null }, {
      label: "Import",
      primary: true,
      onClick: (close) => {
        if (!profileKind(input.value)) return (err.textContent = "Not recognized: paste 12 seed words, an nsec1… key, a password backup (ncryptsec1…) or a 64-character hexadecimal key.");
        err.textContent = "Importing…";
        setTimeout(() => {
          try {
            importIdentity(input.value, pass.value);
            close(true);
          } catch (e) {
            err.textContent = e.message;
          }
        }, 30);
      },
    }],
  }).result;
  if (!v) return;
  toast("Profile imported: your friends and settings are loaded from the Nostr relays", { kind: "ok", ms: 4000 });
  onDone();
}

/** Sezione Profilo: chiave del giocatore (seed, nsec, backup), amici, classifica. */
function profileSection(field, area) {
  const box = h("section.card-box.profile-box");
  const draw = () => {
    const me = identity();
    clear(box).append(
      h("h3", "Profile (friends and ranking)"),
      h("p.muted.small", "Your player key identifies you to your friends and in the ELO ranking, with no account. It lives only in this browser: back it up to keep your rating and your friends on another browser. Whoever has it can play as you."),
      h("div.row", h("span", "Friend code "), h("code.mono", { title: npubOf(me.pk) }, shortKey(npubOf(me.pk))),
        h("button.btn.small", { onclick: () => copyText(npubOf(me.pk)).then((ok) => toast(ok ? "Friend code copied" : "Copy failed")) }, icon("content_copy"), " Copy")),
      h("h4", "Backup"),
      me.seed
        ? h("div.row", h("button.btn.small.primary", { onclick: async () => { if (await confirmModal("Show seed words", "Make sure nobody is looking at your screen.", "Show", "Cancel")) showSeed(); } }, icon("key"), " Show seed words"), h("span.muted.small", "12 words (NIP-06): the easiest way to restore your profile."))
        : h("p.muted.small", "This profile was created before seed words existed: back it up with the nsec key or a password backup."),
      h("div.row",
        h("button.btn.small", { onclick: () => copySecret("Export nsec key", "Your secret key (nsec1…) works in any Nostr app. Anyone with it can play as you: keep it private.", nsec) }, "Copy nsec key"),
        h("button.btn.small", { onclick: exportWithPassword }, "Backup with a password"),
        h("button.btn.small", { onclick: () => importProfile(draw) }, icon("upload_file"), " Import profile"),
        h("button.btn.small.ghost", {
          onclick: async () => {
            if (!(await confirmModal("New profile", "A new player key with new seed words: your rating and your friends stay with the old key, which is lost if you have not backed it up.", "Create", "Cancel", { danger: true }))) return;
            newIdentity();
            draw();
            toast("New profile created");
          },
        }, "New profile")),
      h("h4", "Friends"),
      h("label.check", h("input", { type: "checkbox", checked: settings.showOnline !== false, onchange: (e) => { settings.showOnline = e.target.checked; statusChanged(); } }), "Show my friends when I am online"),
      h("label.check", h("input", { type: "checkbox", checked: settings.allowSpectators !== false, onchange: (e) => (settings.allowSpectators = e.target.checked) }), `Let my friends watch my Duels (Vs CPU and online)${COACHING ? " and report my mistakes" : ""}`),
      field("Nostr relays (one per line)", area("eloRelays"), `Used for friends, invites and the ranking. Empty = ${eloRelays().length} public relays. Friends must share at least one relay.`)
    );
  };
  draw();
  return box;
}

/** Raccoglie i candidati ICE per verificare che STUN/TURN funzionino. */
async function testIce(out) {
  out.textContent = "Testing...";
  const servers = await resolveIceServers();
  const pc = new RTCPeerConnection({ iceServers: servers });
  const found = { host: 0, srflx: 0, relay: 0 };
  const lines = [];
  pc.createDataChannel("test");
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const t = e.candidate.type;
    if (t in found) found[t]++;
    if (t !== "host") lines.push(`${t}: ${e.candidate.address ?? "?"}:${e.candidate.port ?? ""} (${e.candidate.protocol})`);
  };
  // 701 = indirizzo non risolvibile (di solito la ricerca IPv6 su reti solo IPv4): normale, non va mostrato.
  pc.onicecandidateerror = (e) => e.errorCode !== 701 && lines.push(`error ${e.errorCode} on ${e.url}: ${e.errorText}`);
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => {
    const t = setTimeout(r, 8000);
    pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && (clearTimeout(t), r());
  });
  pc.close();
  out.textContent = [
    `Servers tested: ${servers.map((s) => [s.urls].flat().join(", ")).join(" | ")}`,
    `Local: ${found.host} · STUN (srflx): ${found.srflx} · TURN (relay): ${found.relay}`,
    found.srflx ? "✓ STUN works: direct P2P connection is possible." : "✗ No STUN candidates.",
    found.relay ? "✓ TURN works: relay is available even behind strict NATs." : "· No TURN relay (configure one if direct connection fails).",
    ...lines,
  ].join("\n");
}

/** Scelta del TURN: Cloudflare (predefinito del sito), un server proprio, oppure nessuno. */
function turnPicker(field, text) {
  const custom = h(
    "div.turn-custom",
    field("TURN server (URL)", text("turnUrl", { placeholder: "turn:turn.example.com:3478" }), "Separate multiple URLs with spaces."),
    h("div.form-grid", field("TURN username", text("turnUser")), field("TURN password", text("turnPass", { type: "password" })))
  );
  const hint = h("small.muted");
  const select = h(
    "select.select",
    { onchange: (e) => { settings.turnMode = e.target.value; update(); } },
    h("option", { value: "cloudflare" }, "Cloudflare (default)"),
    h("option", { value: "custom" }, "Custom TURN server"),
    h("option", { value: "off" }, "None (STUN only)")
  );
  const update = () => {
    select.value = settings.turnMode ?? "cloudflare";
    custom.hidden = select.value !== "custom";
    hint.textContent = {
      cloudflare: hasDefaultTurn()
        ? "Relay through Cloudflare's TURN when a direct connection is not possible. Credentials are temporary and fetched automatically."
        : "Cloudflare TURN is not configured in this build (VITE_ICE_SERVERS_URL): only STUN will be used.",
      custom: "Relay through your own TURN server when a direct connection is not possible.",
      off: "No relay: Duels may fail to connect if both players are behind strict NATs.",
    }[select.value];
  };
  update();
  return h("div.field", h("span", "TURN server"), select, hint, custom);
}

/**
 * Rubrica delle scelte precedenti di un'impostazione con upload: miniature (thumb(value)) da cliccare per
 * tornare a una scelta, con la × per toglierla. el.refresh() la ridisegna (dopo una scelta nuova).
 */
function previousChoices(kind, { thumb, title, onPick, current }) {
  const row = h("div.prev-choices-row");
  const el = h("div.prev-choices", { hidden: true }, h("small.muted", "Previous choices"), row);
  el.refresh = async () => {
    const list = await uploadHistory(kind);
    const now = JSON.stringify(current());
    el.hidden = !list.length;
    clear(row).append(...list.map(({ value }) =>
      h(`div.prev-choice${JSON.stringify(value) === now ? ".on" : ""}`,
        h("button.prev-choice-use", { title: title(value), onclick: () => { onPick(value); el.refresh(); } }, thumb(value)),
        h("button.prev-choice-del", { title: "Remove from the previous choices", onclick: async () => { await forgetUpload(kind, value); el.refresh(); } }, "×"))));
  };
  // La scelta attuale (anche di prima che ci fosse la rubrica) è tra le precedenti.
  if (current() != null) rememberUpload(kind, current()).then(el.refresh);
  else el.refresh();
  return el;
}

/** Sleeve: immagine usata come dorso delle tue carte; nei duelli online la vede anche l'avversario. */
function sleevePicker() {
  const preview = h("div.card.back.sleeve-preview", { dataset: { owner: "0" } }, h("div.card-back"));
  const status = h("small.muted");
  const box = h("div.sleeve-box.has-sleeve-0", preview, h("div.sleeve-side", status));
  const remove = h("button.btn.small.danger", { onclick: () => { settings.sleeve = null; update(); } }, icon("delete"), " Remove");
  let update = () => {
    const s = validSleeve(settings.sleeve);
    box.classList.toggle("has-sleeve-0", !!s);
    box.style.setProperty("--sleeve-0", s ? `url("${s}")` : "none");
    status.textContent = s ? `Custom sleeve (${Math.round((s.length * 3) / 4 / 1024)} KB). Your opponent sees it on your cards in online Duels.` : "Default card back.";
    remove.hidden = !s;
  };
  const choose = h("button.btn.primary.small", {
    onclick: async () => {
      const f = await pickFile("image/*");
      if (!f) return;
      try {
        settings.sleeve = await makeSleeve(f);
        await rememberUpload("sleeve", settings.sleeve);
        toast("Sleeve updated");
      } catch (e) {
        toast(e.message || "Unable to read the image", { kind: "error" });
      }
      update();
    },
  }, icon("image"), " Choose image");
  const prev = previousChoices("sleeve", {
    current: () => validSleeve(settings.sleeve),
    title: () => "Use this sleeve again",
    thumb: (v) => h("div.card.back.prev-sleeve", { style: { backgroundImage: `url("${validSleeve(v) ?? ""}")` } }),
    onPick: (v) => { if (validSleeve(v)) { settings.sleeve = v; update(); toast("Sleeve updated"); } },
  });
  const baseUpdate = update;
  update = () => { baseUpdate(); prev.refresh(); };
  box.lastChild.append(h("div.row", choose, remove), prev);
  update();
  return h("div.field", h("span", "Sleeve (card back)"), box);
}

/** Gemme delle zone Pendulum: una figura su sfondo bianco/trasparente diventa una gemma rossa e una blu. */
function pendulumPicker() {
  const gem = (color) => h(`div.pz-preview.${color}`);
  const red = gem("red");
  const blue = gem("blue");
  const status = h("small.muted");
  const remove = h("button.btn.small.danger", { onclick: () => { settings.pendulumIcon = null; update(); } }, icon("delete"), " Remove");
  // Per quale zona è disegnata l'immagine: nell'altra compare specchiata.
  const side = h(
    "select.select.pz-side",
    { onchange: () => { settings.pendulumIcon = { ...settings.pendulumIcon, side: side.value }; update(); } },
    h("option", { value: "left" }, "Image drawn for the left zone"),
    h("option", { value: "right" }, "Image drawn for the right zone")
  );
  let update = () => {
    const icons = pendulumIcons();
    for (const [el, color, scale] of [[blue, "blue", "left"], [red, "red", "right"]]) {
      // Anteprima: la gemma personalizzata oppure quella predefinita disegnata in CSS (come sul campo).
      clear(el).append(icons ? h(`img.pz-gem.${color}.custom${mirrorFor(icons, scale) ? ".mirror" : ""}`, { src: icons[color], alt: "" }) : h(`div.pz-gem.${color}.${scale}`, h("i")));
    }
    status.textContent = icons
      ? "Custom gems, shown in your Pendulum Zones (left scale blue, right scale red). The other zone shows the image mirrored. Like the sleeve, your opponent sees them on your side of the field."
      : "Default gems. Upload a figure on a white or transparent background: it is turned into a red and a blue gem. Your opponent sees your gems on your side of the field.";
    remove.hidden = !icons;
    side.hidden = !icons;
    if (icons) side.value = icons.side;
  };
  const choose = h("button.btn.primary.small", {
    onclick: async () => {
      const f = await pickFile("image/*");
      if (!f) return;
      try {
        const icons = await makePendulumIcons(f);
        const chosen = await askPendulumSide(icons);
        if (!chosen) return;
        settings.pendulumIcon = { ...icons, side: chosen };
        await rememberUpload("pendulum", settings.pendulumIcon);
        toast("Pendulum gems updated");
      } catch (e) {
        toast(e.message || "Unable to read the image", { kind: "error" });
      }
      update();
    },
  }, icon("image"), " Choose image");
  const prev = previousChoices("pendulum", {
    current: () => pendulumIcons(),
    title: () => "Use these gems again",
    thumb: (v) => h("span.prev-gems", h("img", { src: v.blue, alt: "" }), h("img", { src: v.red, alt: "" })),
    onPick: (v) => { settings.pendulumIcon = v; update(); toast("Pendulum gems updated"); },
  });
  const baseUpdate = update;
  update = () => { baseUpdate(); prev.refresh(); };
  update();
  return h("div.field", h("span", "Pendulum Zone gems"), h("div.pz-picker", h("div.pz-previews", blue, red), h("div.sleeve-side", status, side, h("div.row", choose, remove), prev)));
}

/**
 * Moai: il pet ai lati del campo 3D. Colori, forma del colpo e un disegno sulla faccia (a mano o da un'immagine);
 * nei duelli online l'avversario lo vede com'è qui. Anteprima 3D: cliccala per farlo sparare.
 */
function moaiPicker() {
  let cfg = moaiConfig();
  let preview = null;
  // Pennello o gomma: lo stesso interruttore sulla tela e a tutto schermo.
  let erasing = false;
  const switches = [];
  const setTool = (erase) => {
    erasing = erase;
    for (const [b, e] of switches) b.classList.toggle("on", e === erase);
  };
  const toolSwitch = () => {
    const pen = h("button.btn.small.on", { title: "Brush", onclick: () => setTool(false) }, icon("brush"));
    const rub = h("button.btn.small", { title: "Eraser", onclick: () => setTool(true) }, icon("ink_eraser"));
    switches.push([pen, false], [rub, true]);
    return h("div.moai-tool-switch", pen, rub);
  };
  const save = (patch, fire = false) => {
    cfg = { ...cfg, ...patch };
    settings.moai = cfg;
    preview?.setConfig(cfg);
    if (fire) preview?.fire();
    pad.style.backgroundColor = cfg.stone;
  };
  const box = h("div.moai-preview", { title: "Click to fire" });
  // Dipingere sul Moai: la testa 3D usa la stessa tela della faccia (le UV sono proiettate di fronte). Mentre si dipinge
  // l'anteprima occupa tutta la finestra (spostata nel body, poi rimessa al suo posto), con i suoi strumenti.
  const spot = document.createComment("moai-preview");
  const setPainting = (on) => {
    // Pittura o posizionamento di un'immagine (placing): stessa vista a tutto schermo, strumenti diversi.
    hint.textContent = placing
      ? "Drag on the Moai to move the image · scroll to resize · drag beside it to turn the Moai · Enter to apply · Esc to cancel"
      : "Drag on the Moai to paint · drag beside it to turn it · scroll to zoom · Esc to close";
    paintBtn.hidden = !!placing;
    paintBar.hidden = !on || !!placing;
    placeBar.hidden = !on || !placing;
    hint.hidden = !on;
    if (on === box.classList.contains("painting")) return;
    if (on) {
      box.replaceWith(spot);
      document.body.append(box);
      document.addEventListener("keydown", onKey);
    } else {
      spot.replaceWith(box);
      document.removeEventListener("keydown", onKey);
    }
    box.classList.toggle("painting", on);
    box.title = on ? "" : "Click to fire";
    paintBtn.replaceChildren(icon(on ? "check" : "brush"), on ? " Done" : " Paint");
    preview?.setPaintMode(on);
  };
  const onKey = (e) => {
    if (placing && (e.key === "Escape" || e.key === "Enter")) endPlace(e.key === "Enter");
    else if (e.key === "Escape") setPainting(false);
  };
  const paintBtn = h("button.btn.small.moai-paint", { onclick: () => setPainting(!box.classList.contains("painting")) }, icon("brush"), " Paint");
  const hint = h("small.moai-hint", { hidden: true }, "Drag on the Moai to paint · drag beside it to turn it · scroll to zoom · Esc to close");
  // Strumenti a tutto schermo: gli stessi della tela (inchiostro e spessore restano sincronizzati).
  const barInk = h("input", { type: "color", oninput: () => (ink.value = barInk.value) });
  const barBrush = h("input", { type: "range", min: 2, max: 18, oninput: () => (brush.value = barBrush.value) });
  const paintBar = h(
    "div.moai-paint-bar",
    { hidden: true },
    h("label.moai-color", barInk, "Ink"),
    h("label.moai-brush", "Size", barBrush),
    toolSwitch(),
    h("button.btn.small", { title: "Zoom in", onclick: () => preview?.zoom(0.75) }, icon("zoom_in")),
    h("button.btn.small", { title: "Zoom out", onclick: () => preview?.zoom(1 / 0.75) }, icon("zoom_out"))
  );
  // Immagine da sistemare sulla testa: centro (x, y) in pixel della texture, grandezza (s, 1 = adattata alla faccia) e
  // rotazione; `base` è il disegno com'era prima, l'immagine ci va sopra.
  let placing = null;
  let grab = null;
  const rotate = h("input", { type: "range", min: -180, max: 180, value: 0, oninput: () => placing && ((placing.rot = +rotate.value), renderPlace()) });
  const resize = (k) => {
    if (!placing) return;
    placing.s = Math.min(8, Math.max(0.1, placing.s * k));
    renderPlace();
  };
  const placeBar = h(
    "div.moai-paint-bar",
    { hidden: true },
    h("button.btn.small", { title: "Smaller", onclick: () => resize(1 / 1.15) }, icon("remove")),
    h("button.btn.small", { title: "Bigger", onclick: () => resize(1.15) }, icon("add")),
    h("label.moai-brush", "Rotate", rotate),
    h("button.btn.small", { title: "Fit to the face", onclick: () => placing && (Object.assign(placing, fitFace()), (rotate.value = 0), renderPlace()) }, icon("fit_screen"), " Fit"),
    h("button.btn.small", { onclick: () => endPlace(false) }, icon("close"), " Cancel"),
    h("button.btn.small.primary", { onclick: () => endPlace(true) }, icon("check"), " Apply")
  );
  box.append(paintBtn, paintBar, placeBar, hint);
  let stroke = null;
  import("../field3d/moai-preview.js")
    .then(({ MoaiPreview }) => {
      preview = new MoaiPreview(box, cfg);
      preview.onPaint = (u, v, start) => {
        if (placing) return moveImage(u, v, start);
        if (u == null) return void (stroke = null); // fuori dalla testa: il tratto si interrompe
        const p = [u * DRAWING_W, (1 - v) * DRAWING_H];
        // Un salto lungo (per esempio dal lato alla faccia) non diventa una riga attraverso la faccia.
        if (start || !stroke || Math.hypot(p[0] - stroke[0], p[1] - stroke[1]) > 30) dot(p);
        else line(stroke, p);
        stroke = p;
      };
      preview.onPaintEnd = () => {
        stroke = null;
        grab = null;
        if (!placing) commit();
      };
      preview.onWheel = (dy, pinch) => {
        if (!placing) return false;
        resize(Math.exp(-dy * (pinch ? 0.01 : 0.0015)));
        return true;
      };
    })
    .catch(() => (box.dataset.loading = "3D preview unavailable"));
  const color = (key, label) =>
    h("label.moai-color", h("input", { type: "color", value: cfg[key], oninput: (e) => save({ [key]: e.target.value }, key === "flame") }), label);
  const shape = h(
    "select.select",
    { onchange: () => save({ shape: shape.value }, true) },
    ...Object.entries(MOAI_SHAPES).map(([k, v]) => h("option", { value: k, selected: cfg.shape === k }, v))
  );

  // Disegno: `sheet` è tutta la texture della testa (faccia, fianchi, nuca, cima e mento, vedi DRAWING_RECTS); la tela
  // visibile mostra e modifica solo la faccia (in alto la fronte, in basso il mento). Sul Moai in 3D si dipinge ovunque.
  const sheet = h("canvas", { width: DRAWING_W, height: DRAWING_H });
  const ctx = sheet.getContext("2d");
  const FACE = DRAWING_RECTS.face;
  const pad = h("canvas.moai-pad", { width: 160, height: 288 });
  const padCtx = pad.getContext("2d");
  const showPad = () => {
    padCtx.clearRect(0, 0, pad.width, pad.height);
    padCtx.drawImage(sheet, FACE.x, FACE.y, FACE.w, FACE.h, 0, 0, pad.width, pad.height);
  };
  const ink = h("input", { type: "color", value: "#1a1a1a", oninput: () => (barInk.value = ink.value) });
  const brush = h("input", { type: "range", min: 2, max: 18, value: 6, oninput: () => (barBrush.value = brush.value) });
  barInk.value = ink.value;
  barBrush.value = brush.value;
  const status = h("small.muted");
  const load = (src) => {
    ctx.clearRect(0, 0, DRAWING_W, DRAWING_H);
    showPad();
    if (!src) return;
    const img = new Image();
    img.onload = () => {
      drawDrawing(ctx, img, DRAWING_W, DRAWING_H);
      showPad();
    };
    img.src = src;
  };
  const commit = () => {
    try {
      save({ drawing: drawingFrom(sheet) });
      status.textContent = cfg.drawing ? "Drawing saved. Your opponent sees it on your Moai in online Duels." : "";
    } catch (e) {
      status.textContent = e.message;
    }
  };
  // Pennello comune alla tela e alla testa 3D: punti in coordinate della tela; ogni tratto si vede subito sull'anteprima.
  // Con la gomma il tratto toglie il disegno (torna la pietra).
  const dot = (p) => {
    ctx.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    ctx.fillStyle = ink.value;
    ctx.beginPath();
    ctx.arc(p[0], p[1], brush.value / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    showPad();
    preview?.showDrawing(sheet);
  };
  const line = (a, b) => {
    ctx.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    ctx.strokeStyle = ink.value;
    ctx.lineWidth = +brush.value;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    showPad();
    preview?.showDrawing(sheet);
  };
  let last = null;
  const at = (e) => {
    const r = pad.getBoundingClientRect();
    return [FACE.x + ((e.clientX - r.left) / r.width) * FACE.w, FACE.y + ((e.clientY - r.top) / r.height) * FACE.h];
  };
  pad.addEventListener("pointerdown", (e) => {
    pad.setPointerCapture(e.pointerId);
    dot((last = at(e)));
  });
  pad.addEventListener("pointermove", (e) => {
    if (!last) return;
    const p = at(e);
    line(last, p);
    last = p;
  });
  const end = () => {
    if (!last) return;
    last = null;
    commit();
  };
  pad.addEventListener("pointerup", end);
  pad.addEventListener("pointercancel", end);
  // Posizionamento dell'immagine: trascinando sulla testa si sposta (di quanto si è mosso il punto della texture sotto il
  // puntatore), oltre i bordi della faccia continua sui fianchi, sulla fronte e sul mento.
  const fitFace = () => ({
    x: FACE.x + FACE.w / 2,
    y: FACE.y + FACE.h / 2,
    s: 1,
    rot: 0,
  });
  const renderPlace = () => {
    const { img, base, x, y, s, rot } = placing;
    const k = Math.min(FACE.w / img.naturalWidth, FACE.h / img.naturalHeight) * s;
    ctx.clearRect(0, 0, DRAWING_W, DRAWING_H);
    ctx.drawImage(base, 0, 0);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, (-img.naturalWidth * k) / 2, (-img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
    ctx.restore();
    showPad();
    preview?.showDrawing(sheet);
  };
  const moveImage = (u, v, start) => {
    if (u == null) return void (grab = null);
    const p = [u * DRAWING_W, (1 - v) * DRAWING_H];
    // Un salto lungo (da una parte all'altra della texture) riprende da lì invece di far saltare l'immagine.
    if (!start && grab && Math.hypot(p[0] - grab[0], p[1] - grab[1]) < 40) {
      placing.x += p[0] - grab[0];
      placing.y += p[1] - grab[1];
      renderPlace();
    }
    grab = p;
  };
  const endPlace = (apply) => {
    if (!placing) return;
    const { img, base } = placing;
    if (!apply) {
      ctx.clearRect(0, 0, DRAWING_W, DRAWING_H);
      ctx.drawImage(base, 0, 0);
      showPad();
      preview?.showDrawing(sheet);
    }
    URL.revokeObjectURL(img.src);
    placing = null;
    setPainting(false);
    if (apply) commit();
  };
  const image = h("button.btn.small", {
    onclick: async () => {
      const f = await pickFile("image/*");
      if (!f) return;
      const img = new Image();
      img.onload = () => {
        if (preview) {
          // Sul Moai a tutto schermo, da spostare, ingrandire e ruotare prima di applicarla.
          const base = h("canvas", { width: DRAWING_W, height: DRAWING_H });
          base.getContext("2d").drawImage(sheet, 0, 0);
          placing = { img, base, ...fitFace() };
          rotate.value = 0;
          setPainting(true);
          renderPlace();
          return;
        }
        // Senza anteprima 3D: adattata alla faccia, centrata, con le proporzioni originali.
        const k = Math.min(FACE.w / img.naturalWidth, FACE.h / img.naturalHeight);
        const w = img.naturalWidth * k;
        const hgt = img.naturalHeight * k;
        ctx.clearRect(FACE.x, FACE.y, FACE.w, FACE.h);
        ctx.drawImage(img, FACE.x + (FACE.w - w) / 2, FACE.y + (FACE.h - hgt) / 2, w, hgt);
        showPad();
        preview?.showDrawing(sheet);
        URL.revokeObjectURL(img.src);
        commit();
      };
      img.onerror = () => toast("Unsupported image format: use a JPG, PNG or WebP", { kind: "error" });
      img.src = URL.createObjectURL(f);
    },
  }, icon("image"), " Image");
  const wipe = h("button.btn.small.danger", { onclick: () => { load(""); commit(); } }, icon("delete"), " Clear");
  const reset = h("button.btn.small", {
    onclick: () => {
      save({ ...MOAI_DEFAULT });
      load("");
      settings.moai = null;
      for (const [k, input] of colors) input.querySelector("input").value = cfg[k];
      shape.value = cfg.shape;
      status.textContent = "";
    },
  }, icon("restart_alt"), " Default");
  const colors = [["stone", color("stone", "Stone")], ["eyes", color("eyes", "Eyes")], ["flame", color("flame", "Shot")]];
  load(cfg.drawing);
  pad.style.backgroundColor = cfg.stone;
  return h(
    "div.field",
    h("span", "Moai"),
    h(
      "div.moai-picker",
      box,
      h(
        "div.moai-side",
        h("small.muted", "Your Moai stands beside the 3D field: click it during a Duel to make it fire. In online Duels your opponent sees it and its shots."),
        h("div.row", ...colors.map(([, el]) => el)),
        h("label.moai-shape", h("span", "Shot"), shape),
        h("div.moai-draw", h("div.moai-face", pad), h("div.moai-tools", h("small.muted", "Draw on the face, or press Paint on the preview to paint on the Moai itself"), h("label.moai-color", ink, "Ink"), h("label.moai-brush", "Size", brush), toolSwitch(), h("div.row", image, wipe))),
        status,
        h("div.row", reset)
      )
    )
  );
}

/** Campo 3D: sorgente dei campi (cartella, link a uno .zip o .zip dal computer), scelta del campo e anteprima. */
function field3dPicker() {
  const status = h("small.muted");
  const select = h("select.select", { onchange: () => { settings.field3d = select.value; settings.field3dChosen = true; preview(); } });
  const box = h("div.field3d-preview", { hidden: true });
  const url = h("input.input", {
    value: settings.fieldsUrl ?? "",
    placeholder: BUILD_FIELDS_URL || "https://…/fields  or  https://…/fields.zip",
    spellcheck: false,
    onchange: () => { settings.fieldsUrl = url.value.trim(); refresh(); },
  });
  const upload = h("button.btn.small", {
    onclick: async () => {
      const f = await pickFile(".zip,application/zip");
      if (!f) return;
      status.textContent = "Reading the .zip file…";
      try {
        await useZipFile(f);
        url.value = settings.fieldsUrl;
        toast("3D fields saved in this browser");
      } catch (e) {
        toast(e.message || "Unable to read the .zip file", { kind: "error" });
      }
      refresh();
    },
  }, icon("upload_file"), " Upload .zip");
  const forget = h("button.btn.small.danger", {
    onclick: async () => {
      await forgetZips();
      if (settings.fieldsUrl.startsWith("file:")) settings.fieldsUrl = url.value = "";
      toast("Stored 3D fields deleted");
      refresh();
    },
  }, icon("delete"), " Delete stored .zip");
  let stage = null;
  let token = 0;
  const preview = async () => {
    const t = ++token;
    stage?.dispose();
    stage = null;
    const list = [...BUILTIN_FIELDS, ...(await fieldList().catch(() => []))];
    const f = list.find((x) => x.id === settings.field3d);
    box.hidden = !f;
    if (!f || t !== token) return;
    const { FieldStage } = await import("../field3d/stage.js");
    if (t !== token) return;
    stage = new FieldStage(box, { fx: settings.field3dFx });
    stage.showcase();
    box.dataset.loading = "Loading…";
    try {
      await (f.theme ? stage.loadHelios(f.theme) : stage.load(await fieldFiles(), f.id, f.sides));
      delete box.dataset.loading;
    } catch (e) {
      box.dataset.loading = `Unable to load this field (${e.message})`;
    }
  };
  const mb = (n) => `${Math.round(n / 1048576)} MB`;
  const refresh = async () => {
    const t = ++token;
    const src = fieldsBase();
    // Sempre: il campo 2D, i campi di Helios e uno a caso; poi quelli della sorgente, se c'è.
    clear(select).append(
      h("option", { value: "" }, "Standard field (2D)"),
      h("option", { value: "random" }, "Random field each duel"),
      ...BUILTIN_FIELDS.map((f) => h("option", { value: f.id }, f.name))
    );
    select.value = [...select.options].some((o) => o.value === settings.field3d) ? settings.field3d : "";
    forget.hidden = true;
    if (!src) {
      status.textContent = "More 3D fields: enter the address of a fields folder or of a .zip with it, or upload the .zip. An address must allow cross-site requests (e.g. GitHub Pages).";
      return preview();
    }
    status.textContent = isZip(src) ? "Opening the .zip…" : "Loading the list…";
    try {
      const list = await fieldList(src, (k, got) => {
        if (t === token) status.textContent = `Downloading the .zip… ${k == null ? mb(got) : Math.round(k * 100) + "%"} (only the first time)`;
      });
      select.append(...list.map((f) => h("option", { value: f.id }, f.name)));
      const stored = await storedSize(src).catch(() => 0);
      forget.hidden = !stored;
      // Indirizzi che funzionano nella rubrica (uno .zip dal computer no: nel browser se ne tiene uno solo).
      if (!src.startsWith("file:")) rememberUpload("fields", src).then(prev.refresh);
      status.textContent = `${list.length + BUILTIN_FIELDS.length} fields available${stored ? ` · ${mb(stored)} .zip stored in this browser` : ""}. Your opponent sees the field they chose.`;
    } catch (e) {
      status.textContent = `Unable to read the fields: ${e.message}`;
    }
    select.value = [...select.options].some((o) => o.value === settings.field3d) ? settings.field3d : "";
    preview();
  };
  const prev = previousChoices("fields", {
    current: () => null,
    title: (v) => `Use these 3D fields again: ${v}`,
    thumb: (v) => h("span.prev-source", v.replace(/^https?:\/\//, "").slice(0, 60)),
    onPick: (v) => { url.value = settings.fieldsUrl = v; refresh(); },
  });
  const fx = h("label.check", h("input", { type: "checkbox", checked: settings.field3dFx, onchange: (e) => { settings.field3dFx = e.target.checked; preview(); } }), "Particles and glow (turn off on slow computers)");
  const tilt = h("label.check", h("input", { type: "checkbox", checked: settings.field3dTilt, onchange: (e) => (settings.field3dTilt = e.target.checked) }), "Tilted view in the Duel (like Master Duel) instead of from above");
  refresh();
  return h(
    "div.field3d-picker",
    h(
      "label.field",
      h("span", "3D fields"),
      url,
      h("small.muted", "More fields: address of a fields folder or of a .zip with it (downloaded once and kept in this browser). The Helios fields are always there.")
    ),
    h("div.row", upload, forget),
    prev,
    h("label.field", h("span", "3D field"), select, status),
    box,
    fx,
    tilt
  );
}

/** Chiede per quale zona Pendulum è disegnata l'immagine appena caricata ("left"/"right", null = annulla). */
function askPendulumSide(icons) {
  const option = (scale, color, label) =>
    h("button.btn", { onclick: () => m.close(scale) }, h(`div.pz-preview.${color}`, h(`img.pz-gem.${color}.custom`, { src: icons[color], alt: "" })), label);
  const m = openModal({
    title: "Which side is this image for?",
    body: [
      h("p", "Is the image drawn for the left or the right Pendulum Zone? It is shown as it is there, and mirrored in the other zone."),
      h("div.pz-side-pick", option("left", "blue", "Left zone"), option("right", "red", "Right zone")),
    ],
    actions: [{ label: "Cancel", value: null }],
  });
  return m.result.then((v) => v ?? null);
}

export function showSettings(app) {
  const root = clear(app.root);
  const field = (label, input, hint) => h("label.field", h("span", label), input, hint && h("small.muted", hint));
  const text = (k, attrs = {}) => h("input.input", { value: settings[k] ?? "", ...attrs, oninput: (e) => (settings[k] = e.target.value) });
  const area = (k) => h("textarea.input", { rows: 3, value: settings[k] ?? "", oninput: (e) => (settings[k] = e.target.value) });
  const check = (k, label) => h("label.check", h("input", { type: "checkbox", checked: !!settings[k], onchange: (e) => (settings[k] = e.target.checked) }), label);
  const iceOut = h("pre.ice-out", "");

  root.append(
    h(
      "div.page.settings",
      h("div.page-head", h("button.btn.ghost.round.page-back", { title: "Menu (right-click)", onclick: () => app.home() }, icon("chevron_left")), h("h1", "Settings")),
      h(
        "div.settings-grid",
        h(
          "section.card-box",
          h("h3", "General"),
          field("Duelist name", text("name", { maxLength: 24 })),
          field("Card image URL", text("imageUrl"), "{code} = card code. If an image is unavailable, a CSS frame is drawn instead."),
          field("Animation speed", h("input", { type: "range", min: 0, max: 2, step: 0.25, value: settings.animSpeed, oninput: (e) => (settings.animSpeed = +e.target.value) }), "0 = off"),
          check("autoPlace", "Auto-pick the zone when summoning/setting"),
          check("fieldSelect", "Pick materials, targets and costs by clicking the cards on the field"),
          sleevePicker()
        ),
        h("section.card-box", h("h3", "Field"), field3dPicker(), moaiPicker(), pendulumPicker()),
        h(
          "section.card-box",
          h("h3", "Network (WebRTC)"),
          field("STUN servers (one per line)", area("stun"), "Used to discover your public address for direct connection."),
          turnPicker(field, text),
          check("forceRelay", "Force TURN relay (for testing)"),
          field("Signaling server", text("signalUrl", { placeholder: BUILD_SIGNAL_URL || location.origin }), BUILD_SIGNAL_URL ? "Used for Online Rooms. Leave empty to use this site's default server." : "Used for Online Rooms. Empty = same address as this page. The server can also provide temporary TURN credentials."),
          field(
            "Online Rooms",
            h(
              "select.select",
              { onchange: (e) => { settings.roomMode = e.target.value; settings.roomModeChosen = true; } },
              h("option", { value: "nostr", selected: settings.roomMode !== "server" }, "Nostr relays (decentralized, default)"),
              h("option", { value: "server", selected: settings.roomMode === "server" }, "Signaling server")
            ),
            "Where new Rooms are created. Nostr relays (default): public relays via Trystero, no server needed, 8-character codes. Signaling server: the server below, 6-character codes. You can always join a code of either kind."
          ),
          h("div.row", h("button.btn.primary", { onclick: () => testIce(iceOut).catch((e) => (iceOut.textContent = e.message)) }, "Test STUN/TURN")),
          iceOut
        ),
        profileSection(field, area),
        h(
          "section.card-box",
          h("h3", "Data"),
          h("p.muted", `Cards: ${db.cards.size} · Banlists: ${db.banlists.length} · Data version: ${db.manifest?.version}`),
          h("p.muted.small", `Built ${new Date(db.manifest?.built).toLocaleString("en-US")} from ProjectIgnis (CardScripts, BabelCDB, LFLists). Update with "npm run data".`),
          h("button.btn.danger", { onclick: async () => { if (await confirmModal("Reset Settings?", "Decks and data are not affected.", "Reset", "Cancel", { danger: true })) { resetSettings(); toast("Settings reset"); showSettings(app); } } }, "Reset Settings")
        )
      )
    )
  );
}
