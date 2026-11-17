// Modello di IA dell'utente (Google AI Studio, Gemini): la chiave la mette l'utente (Settings o editor delle carte
// personalizzate) e resta solo in questo browser (settings.aiKey, mai sui relay). Le richieste partono dal browser
// direttamente verso Google (l'API accetta il CORS con la chiave nell'intestazione).
import { settings } from "../data/settings.js";

// Solo Gemini Flash-Lite: è nel piano gratuito e risponde anche quando Flash è sovraccarico (503) e Pro senza quota.
const MODEL = "gemini-flash-lite-latest";
export const AI_KEY_URL = "https://aistudio.google.com/apikey";
const API = "https://generativelanguage.googleapis.com/v1beta/models/";

export const hasAiKey = () => !!String(settings.aiKey ?? "").trim();

/** Errore leggibile dalla risposta di Google. */
function failure(status, body) {
  const msg = body?.error?.message ?? "";
  if (status === 400 && /api key/i.test(msg)) return "The AI key is not valid: check it in Settings → AI";
  if (status === 401 || status === 403) return "The AI key was refused (revoked or without access to this model)";
  if (status === 429) return "AI quota used up for now (free tier limit): wait a minute and try again";
  if (status === 503) return "The AI is overloaded right now (busy hours): try again in a minute";
  if (status >= 500) return "The AI service is not answering right now: try again";
  return msg || `AI request failed (${status})`;
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))), { once: true });
});

const CALL_MS = 60_000; // oltre, la chiamata vale come "sovraccarico"

/** Una chiamata a un modello: { ok, status, body }. */
async function call(model, key, payload, signal) {
  const timeout = AbortSignal.timeout(CALL_MS);
  let res;
  try {
    res = await fetch(`${API}${encodeURIComponent(model)}:generateContent`, { method: "POST", signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(payload) });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    if (signal?.aborted) throw e;
    if (timeout.aborted) return { ok: false, status: 503, body: null };
    throw new Error("Cannot reach the AI service: check your connection");
  }
}

/** Una richiesta al modello che risponde in JSON (schema: OpenAPI ridotto di Gemini). Restituisce l'oggetto. */
export async function aiJson({ system, prompt, schema, temperature = 0.7, signal }) {
  const key = String(settings.aiKey ?? "").trim();
  if (!key) throw new Error("Add your AI key first (free from Google AI Studio)");
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature, responseMimeType: "application/json", ...(schema ? { responseSchema: schema } : {}) },
  };
  // errore momentaneo (sovraccarico): si riprova due volte, aspettando sempre di più
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await call(MODEL, key, payload, signal);
    if (last.ok || ![500, 503].includes(last.status)) break;
    if (attempt < 2) await wait(2000 * (attempt + 1), signal);
  }
  if (!last.ok) throw new Error(failure(last.status, last.body));
  const cand = last.body?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  if (!text) throw new Error(cand?.finishReason === "SAFETY" ? "The AI refused this request" : "The AI gave an empty answer: try again");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The AI answer was cut or malformed: try again");
  }
}
