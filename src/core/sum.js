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

/** Cerca una combinazione valida (per l'IA e per il pulsante "auto"). */
export function findSum(msg) {
  const n = msg.selects.length;
  if (n > 20) return null;
  // Prima le combinazioni con meno carte.
  const masks = [];
  for (let m = 1; m < 1 << n; m++) masks.push(m);
  masks.sort((a, b) => popcount(a) - popcount(b));
  for (const m of masks) {
    const sel = [];
    for (let i = 0; i < n; i++) if (m & (1 << i)) sel.push(i);
    if (isValidSum(msg, sel)) return sel;
  }
  return null;
}

function popcount(x) {
  let c = 0;
  while (x) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
}
