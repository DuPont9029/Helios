// Prove del contratto HeliosNames su una blockchain locale (ganache): regole dei nomi, commit-reveal, attacchi
// (copia del reveal, riuso di firme e impronte, chiave Nostr di un altro), amico che paga con firma EIP-712, card
// soulbound e immagine SVG. Dipendenze solo per questa prova (non nel progetto):
//   npm i --no-save ganache@7.9.2 ethers@6.13.4 && npm run contracts && node contracts/test-names.mjs
// Scrive l'SVG della card di prova in contracts/card-test.svg (ignorato da git).
import ganache from "ganache";
import { ethers } from "ethers";
import fs from "node:fs";
const art = JSON.parse(fs.readFileSync(new URL("../src/data/names-contract.json", import.meta.url), "utf8"));
const g = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "merge" }, wallet: { totalAccounts: 6, defaultBalance: 100, deterministic: true } });
const keys = Object.fromEntries(Object.entries(g.getInitialAccounts()).map(([a, x]) => [a.toLowerCase(), x.secretKey]));
const signTyped = async (signer, d, t, v) => new ethers.Wallet(keys[(await signer.getAddress()).toLowerCase()]).signTypedData(d, t, v);
const provider = new ethers.BrowserProvider(g);
const [friend, alice, bob, eve, carol, dave] = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));
const factory = new ethers.ContractFactory(art.abi, art.bytecode, friend);
const c = await factory.deploy();
const dr = await c.deploymentTransaction().wait();
const as = (s) => c.connect(s);
let pass = 0, fail = 0;
const ok = (cond, msg) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); };
const errData = (e) => { for (const d of [e?.data, e?.data?.result, e?.info?.error?.data, e?.info?.error?.data?.result, e?.error?.data, e?.error?.data?.result]) if (typeof d === "string" && d.startsWith("0x")) return d; return null; };
const errName = (e) => { if (e?.revert?.name) return e.revert.name; const d = errData(e); if (d) { try { return c.interface.parseError(d)?.name ?? d; } catch { return d; } } return e?.shortMessage ?? String(e); };
const reverts = async (p, err, msg) => { try { await (await p).wait?.(); ok(false, `${msg} (did not revert)`); } catch (e) { const name = errName(e); ok(String(name).includes(err), `${msg} → ${name}`); } };
const wait = async (s) => { await g.request({ method: "evm_increaseTime", params: [s] }); await g.request({ method: "evm_mine", params: [] }); };
const nostr = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
const secret = () => ethers.hexlify(ethers.randomBytes(32));
const gas = {};
async function registerAs(s, name, nk, { skipWait = false } = {}) {
  const sec = secret();
  const cm = await c.makeCommitment(name, await s.getAddress(), nk, sec, await s.getAddress());
  const t1 = await (await as(s).commit(cm)).wait(); gas.commit = t1.gasUsed;
  if (!skipWait) await wait(61);
  // simulazione sull'ultimo blocco (ha il tempo giusto: la stima del gas di ganache ignora evm_increaseTime): se fallisce, l'errore è quello vero del contratto
  await as(s).register.staticCall(name, nk, sec, { blockTag: "latest" });
  const t2 = await (await as(s).register(name, nk, sec, { gasLimit: 400000 })).wait(); gas.register = t2.gasUsed;
  return sec;
}
console.log("deploy gas:", dr.gasUsed.toString());

// nomi
await reverts(as(alice).register("Alice", nostr(1), secret()), "BadCommitment", "register senza commit");
{ const sec = secret(); await (await as(alice).commit(await c.makeCommitment("Alice", await alice.getAddress(), nostr(1), sec, await alice.getAddress()))).wait();
  await reverts(as(alice).register("Alice", nostr(1), sec), "BadCommitment", "register subito dopo il commit (prima di 60 s)");
  // front-running del reveal: Eve copia nome e segreto dalla transazione di Alice nel mempool
  await wait(61);
  await reverts(as(eve).register("Alice", nostr(1), sec), "BadCommitment", "Eve copia il reveal di Alice (impronta legata al wallet)");
  await (await as(alice).register("Alice", nostr(1), sec, { gasLimit: 400000 })).wait();
  ok((await c.lookup("alice")).owner === await alice.getAddress(), "Alice registrata, lookup senza maiuscole");
  await reverts(as(alice).register("Alice", nostr(1), sec), "BadCommitment", "riuso dello stesso commit"); }
for (const bad of ["Duelist", "duelist", "DUELIST", "ab", "a-b-c", "x".repeat(21), "àbcd", "bad name", ""]) await reverts(c.keyOf(bad), "BadName", `nome non valido ${JSON.stringify(bad)}`);
await reverts(registerAs(bob, "ALICE", nostr(2)), "NameTaken", "Bob prova ALICE (stesso nome con maiuscole diverse)");
await registerAs(bob, "Bob_99", nostr(2));
ok((await c.lookup("BOB_99")).display === "Bob_99" && Number((await c.lookup("bob_99")).number) === 2, "Bob_99 registrato (numero 2), nome mostrato come scritto");
await reverts(registerAs(bob, "Bobby", nostr(2)), "AlreadyRegistered", "secondo nome sullo stesso wallet");
// la chiave Nostr non si può occupare: Eve usa la chiave di Carol, Carol registra lo stesso
await registerAs(eve, "EveName", nostr(4));
await registerAs(carol, "Carol", nostr(4));
ok((await c.lookup("carol")).owner === await carol.getAddress(), "Carol registra anche se Eve ha dichiarato la sua chiave Nostr");
{ const cm = ethers.keccak256("0x1234"); await (await as(eve).commit(cm)).wait(); await reverts(as(eve).commit(cm), "BadCommitment", "rinnovo di un commit ancora valido"); }
// un amico paga: Dave firma (EIP-712), Friend manda commit e register
const domain = { name: "HeliosNames", version: "1", chainId: (await provider.getNetwork()).chainId, verifyingContract: await c.getAddress() };
const REG = { Register: [{ name: "name", type: "string" }, { name: "nostr", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
const MINT = { Mint: [{ name: "color", type: "bytes3" }, { name: "pattern", type: "uint8" }, { name: "bio", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
const now = async () => (await provider.getBlock("latest")).timestamp;
async function friendPays(payer, owner, signer, name, nk, { deadline, nonce } = {}) {
  deadline ??= (await now()) + 3600;
  nonce ??= await c.nonces(await owner.getAddress());
  const sig = await signTyped(signer, domain, REG, { name, nostr: nk, nonce, deadline });
  const sec = secret();
  await (await as(payer).commit(await c.makeCommitment(name, await owner.getAddress(), nk, sec, await payer.getAddress()))).wait();
  await wait(61);
  const args = [name, await owner.getAddress(), nk, sec, deadline, sig];
  await as(payer).registerFor.staticCall(...args, { blockTag: "latest" });
  const r = await (await as(payer).registerFor(...args, { gasLimit: 500000 })).wait();
  gas.registerFor = r.gasUsed;
  return { args, sig };
}
await reverts(friendPays(friend, dave, eve, "Dave", nostr(9)), "BadSignature", "registerFor con la firma di un altro (Eve firma per Dave)");
await reverts(friendPays(friend, dave, dave, "Dave", nostr(9), { deadline: (await now()) + 30 }), "Expired", "registerFor con autorizzazione scaduta");
await reverts(friendPays(friend, dave, dave, "Dave", nostr(9), { nonce: 5n }), "BadSignature", "registerFor con nonce sbagliato");
const { sig: daveSig } = await friendPays(friend, dave, dave, "Dave", nostr(9));
ok((await c.lookup("dave")).owner === await dave.getAddress() && (await c.nonces(await dave.getAddress())) === 1n, `l'amico paga il nome di Dave (gas ${gas.registerFor})`);
// riuso della stessa firma dopo il release (nonce consumato)
await (await as(dave).release()).wait();
{ const sec = secret(); const dl = (await now()) + 3600;
  await (await as(eve).commit(await c.makeCommitment("Dave", await dave.getAddress(), nostr(9), sec, await eve.getAddress()))).wait(); await wait(61);
  await reverts(as(eve).registerFor.staticCall("Dave", await dave.getAddress(), nostr(9), sec, dl, daveSig, { blockTag: "latest" }), "BadSignature", "riuso della firma di Dave dopo il release (nonce già usato)"); }
// copia del reveal dell'amico da parte di Eve (impronta legata a chi paga)
{ const dl = (await now()) + 3600; const nonce = await c.nonces(await dave.getAddress());
  const sig = await signTyped(dave, domain, REG, { name: "DaveTwo", nostr: nostr(9), nonce, deadline: dl }); const sec = secret();
  await (await as(friend).commit(await c.makeCommitment("DaveTwo", await dave.getAddress(), nostr(9), sec, await friend.getAddress()))).wait(); await wait(61);
  await reverts(as(eve).registerFor.staticCall("DaveTwo", await dave.getAddress(), nostr(9), sec, dl, sig, { blockTag: "latest" }), "BadCommitment", "Eve copia il reveal dell'amico (impronta legata a chi paga)");
  await (await as(friend).registerFor("DaveTwo", await dave.getAddress(), nostr(9), sec, dl, sig, { gasLimit: 500000 })).wait();
  ok((await c.lookup("davetwo")).owner === await dave.getAddress(), "il reveal dell'amico va a buon fine"); }
// card
await reverts(as(friend).mint("0x38c6ff", 0, "hi"), "NotRegistered", "mint senza nome");
await reverts(as(alice).mint.staticCall("0x38c6ff", 0, "hi", { value: 1n }), "0x", "mint con ETH: rifiutato (la funzione non accetta pagamenti, revert senza dati)");
await reverts(as(alice).mint("0x38c6ff", 6, "hi"), "BadPattern", "mint con motivo inesistente");
await reverts(as(alice).mint("0x38c6ff", 0, "<script>"), "BadBio", "frase con < (iniezione SVG)");
await reverts(as(alice).mint("0x38c6ff", 0, 'a"b'), "BadBio", "frase con \" (iniezione JSON)");
await reverts(as(alice).mint("0x38c6ff", 0, "x".repeat(49)), "BadBio", "frase di 49 caratteri");
const mr = await (await as(alice).mint("0xff7ad9", 3, "Melorbius is love, Helios is Life")).wait();
// card pagata da un amico con la firma di Dave
{ const dl = (await now()) + 3600; const nonce = await c.nonces(await dave.getAddress());
  const sig = await signTyped(dave, domain, MINT, { color: "0x7dffb0", pattern: 1, bio: "paid by a friend", nonce, deadline: dl });
  await reverts(as(friend).mintFor(await dave.getAddress(), "0x7dffb0", 1, "changed bio", dl, sig), "BadSignature", "mintFor con una frase diversa da quella firmata");
  const r = await (await as(friend).mintFor(await dave.getAddress(), "0x7dffb0", 1, "paid by a friend", dl, sig)).wait();
  ok((await c.cardOf(await dave.getAddress())).bio === "paid by a friend", `l'amico paga la card di Dave (gas ${r.gasUsed})`);
  await reverts(as(friend).mintFor(await dave.getAddress(), "0x7dffb0", 1, "paid by a friend", dl, sig), "BadSignature", "riuso della firma del mint"); }
gas.mint = mr.gasUsed;
const id = BigInt((await c.keyOfOwner(await alice.getAddress())));
ok((await c.ownerOf(id)) === await alice.getAddress() && (await c.totalSupply()) === 2n, "card coniata sul wallet di Alice (2 in tutto, con quella di Dave)");
await reverts(as(alice).mint("0xff7ad9", 3, "x"), "CardExists", "seconda card");
const uri = await c.tokenURI(id);
const meta = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
const svg = Buffer.from(meta.image.split(",")[1], "base64").toString();
fs.writeFileSync(new URL("card-test.svg", import.meta.url), svg);
ok(meta.name === "#1 Alice - Helios Player Card" && svg.includes(">Alice<") && svg.includes("#ff7ad9") && svg.startsWith("<svg"), "tokenURI: JSON valido e SVG con numero, nome e colore");
ok(meta.attributes.some((a) => a.trait_type === "Number" && a.value === 1) && meta.attributes.some((a) => a.trait_type === "OG" && a.value === "Yes") && svg.includes(">#1<") && svg.includes(">OG<"), "card #1: numero e badge OG nei metadati e nell'immagine");
ok(Number((await c.cardOf(await alice.getAddress())).number) === 1, "cardOf restituisce il numero della registrazione");
for (const [f, args] of [["transferFrom", [await alice.getAddress(), await bob.getAddress(), id]], ["approve", [await bob.getAddress(), id]], ["setApprovalForAll", [await bob.getAddress(), true]]])
  await reverts(as(alice)[f](...args), "Soulbound", `soulbound: ${f}`);
await reverts(as(alice)["safeTransferFrom(address,address,uint256)"](await alice.getAddress(), await bob.getAddress(), id), "Soulbound", "soulbound: safeTransferFrom");
ok((await c.locked(id)) === true && (await c.supportsInterface("0xb45a3c0e")) && (await c.supportsInterface("0x80ac58cd")) && (await c.supportsInterface("0x5b5e139f")), "EIP-5192 locked e interfacce ERC-721");
await reverts(as(bob).setStyle("0x000000", 0, "x"), "ERC721NonexistentToken", "setStyle senza card");
await (await as(alice).setStyle("0x7dffb0", 4, "new line")).wait();
ok((await c.cardOf(await alice.getAddress())).bio === "new line", "setStyle della propria card");
ok(!art.abi.some((x) => ["withdraw", "owner", "setPrice", "transferOwnership"].includes(x.name)), "nessuna funzione di admin (withdraw, owner)");
// release
await (await as(alice).release()).wait();
ok((await c.totalSupply()) === 1n && (await c.lookup("alice")).owner === ethers.ZeroAddress, "release: card bruciata e nome libero (resta quella di Dave)");
await reverts(c.tokenURI(id), "ERC721NonexistentToken", "tokenURI di una card bruciata");
await reverts(registerAs(eve, "Alice", nostr(5)), "AlreadyRegistered", "Eve (che ha già un nome) non prende Alice liberato");
await registerAs(friend, "Alice", nostr(8));
ok((await c.lookup("alice")).owner === await friend.getAddress(), "dopo il release Alice si può registrare da un altro wallet");
ok(Number((await c.lookup("alice")).number) === Number(await c.namesRegistered()) && Number((await c.lookup("alice")).number) > 1, "il nome ripreso ha un numero nuovo (il #1 non si riassegna)");
console.log(`\n${pass} passed, ${fail} failed · gas: commit ${gas.commit}, register ${gas.register}, registerFor ${gas.registerFor}, mint ${gas.mint}`);
process.exit(fail ? 1 : 0);
