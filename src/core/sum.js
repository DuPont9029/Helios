// Verifica di MSG_SELECT_SUM, identica a field::process(SelectSum) di ygopro-core.
// Ogni carta ha un parametro: 16 bit bassi = valore 1, 16 bit alti = valore alternativo.

function check1(params, index, acc) {
  if (acc <= 0 || index === params.length) return false;
  const o1 = params[index] & 0xffff;
  const o2 = params[index] >>> 16;
  if (index === params.length - 1) return acc === o1 || acc === o2;
  return (acc > o1 && check1(params, index + 1, acc - o1)) || (o2 > 0 && acc > o2 && check1(params, index + 1, acc - o2));
}

/**
 * @param msg       messaggio SELECT_SUM
 * @param selected  indici scelti tra msg.selects
 */
export function isValidSum(msg, selected) {
  const params = [...msg.selects_must.map((c) => c.amount), ...selected.map((i) => msg.selects[i].amount)];
  if (msg.select_max === 0) {
    // Somma esatta con un numero di carte tra min e max.
    if (selected.length < msg.min || selected.length > msg.max) return false;
    return check1(params, 0, msg.amount);
  }
  // Somma "almeno": deve raggiungere il valore ma senza carte superflue.
  let sum = 0;
  let mx = 0;
  let mn = 0x7fffffff;
  for (const op of params) {
    const o1 = op & 0xffff;
    const o2 = op >>> 16;
    const ms = o2 && o2 < o1 ? o2 : o1;
    sum += ms;
    mx += o2 > o1 ? o2 : o1;
    if (ms < mn) mn = ms;
  }
  return !(mx < msg.amount || sum - mn >= msg.amount);
}

// Valore più piccolo che una carta può dare alla somma.
const lowOf = (op) => {
  const o1 = op & 0xffff;
  const o2 = op >>> 16;
  return o2 && o2 < o1 ? o2 : o1;
};

/**
 * Cerca una combinazione valida (per l'IA e per il pulsante "auto"), prima quelle con meno carte. Anche con molte
 * carte tra cui scegliere (es. 35 copie della stessa nel Deck): le carte con lo stesso valore contano come una
 * sola scelta, e nella somma esatta si scarta subito un ramo che supera già il totale.
 */
export function findSum(msg) {
  const n = msg.selects.length;
  const exact = msg.select_max === 0;
  const order = [...Array(n).keys()].sort((a, b) => lowOf(msg.selects[a].amount) - lowOf(msg.selects[b].amount) || msg.selects[a].amount - msg.selects[b].amount);
  const base = msg.selects_must.reduce((s, c) => s + lowOf(c.amount), 0);
  let budget = 200000; // controlli al massimo: l'IA non deve bloccare la pagina
  const pick = [];
  const dfs = (start, k, acc) => {
    if (pick.length === k) return --budget >= 0 && isValidSum(msg, pick) ? [...pick] : null;
    for (let j = start; j <= n - (k - pick.length) && budget > 0; j++) {
      const i = order[j];
      if (j > start && msg.selects[i].amount === msg.selects[order[j - 1]].amount) continue;
      const a = acc + lowOf(msg.selects[i].amount);
      if (exact && a > msg.amount) break; // in ordine crescente: anche le successive superano il totale
      pick.push(i);
      const found = dfs(j + 1, k, a);
      pick.pop();
      if (found) return found;
    }
    return null;
  };
  const from = exact ? Math.max(1, msg.min) : 1;
  const to = exact ? Math.min(n, msg.max) : n;
  for (let k = from; k <= to && budget > 0; k++) {
    const found = dfs(0, k, base);
    if (found) return found;
  }
  return null;
}
