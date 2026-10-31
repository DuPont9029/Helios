# Helios Bundle Draft — Implementation Guide

Audience: the developer building the draft client.
Companion document: "Helios Draft Rules Sheet" (player-facing; contains no implementation detail).

## 0. Guiding Principle

Where the format leaves room for tuning, expose the knob to the host / cube manager rather than hard-coding it. A host should be able to shape the experience without a developer. Items marked **[host-configurable]** below follow this principle.

## 1. Format Summary

- **Players:** variable; N seats. Optimized for 8.
- **Packs:** exactly N packs per round, one per seat.
- **Pack size:** exactly 15 items per pack, both rounds. Independent of player count.
- **Rounds:** 2. Round 1 = bundles; Round 2 = singles.
- **Passes:** 15 per round; round ends when all packs are empty.
- **Picks per player:** exactly 30 (15 + 15). Collection size is standardized **in items only**; card counts vary by bundles drafted.
- **Pass direction:** Round 1 left; Round 2 right.
- **Hidden information:** all picks go to a private binder; opponents never see picks.

## 2. Pack Generation — Cube-Style

- **Method:** uniform random draw of 15 items from the host's curated pool (bundles for Round 1, singles for Round 2). No rarity-weighted slot system; rarity does not drive composition.
- **[host-configurable] Special rules:** the host may define constraints such as exclusion rules ("X and Y never in the same pack"), inclusion rules ("every pack has ≥1 mana-fixer"), or category quotas ("≤1 'Power'-tagged item per pack"). Rules are validated **client-side at upload**; an unsatisfiable rule set cannot be published.
- **Rarity metadata:** each item carries exactly one rarity tag, used for display and for timer auto-pick ranking (see §4). Rarity never affects pack composition.
- **Failsafe behavior (hard-coded):**
  1. If the pool has fewer distinct items than 15, **duplicates are allowed** to fill the pack.
  2. If a special rule cannot be satisfied for a specific pack despite passing upload validation (e.g., pool edited afterward), **drop that rule for that pack and log the event**; the pack still generates.

### Bundle constraints (Round 1)
- Variable card count per bundle.
- **≥2 Main Deck cards per bundle** (Extra Deck cards excluded from the count).
- **Enforced client-side at upload** — a violating bundle cannot be saved or published.

## 3. Draft Flow & UI

- **Pick:** exactly one item per turn; locking in claims all cards in that bundle/card.
- **Secret binder:** contents transfer instantly to the player's private binder on lock-in.
- **Auto sorting:** the client distinguishes card types and splits the pool into:
  - *Main Deck tab* — Main Deck monsters, spells, traps.
  - *Extra Deck tab* — Fusion, Synchro, Xyz, Link monsters.
- **Re-clumping:** a toggle regroups cards into their original pre-constructed bundles. Applies **only to cards that originated in a bundle** (Round 1). Round 2 cards (singles) never re-clump; the toggle is hidden/no-op in Round 2.
- **Async queue:** no synchronized lock-ins. On lock-in, remaining items pass immediately to the next seat's queue. A slow player's passed packs accumulate as an **ordered waiting stack**; fast players continue without waiting. Queue order follows the round's pass direction.

## 4. Pick Timer & Auto-Resolution

- **Start:** timer begins **on pack arrival** at the player's screen (not on first interaction).
- **Formula (continuous float):** `time = T_start − (T_start − T_end) × (items_remaining_before_pick / 15)`.
- **Defaults:** `T_start = 90s`, `T_end = 10s`. **[host-configurable]** (approximates MTGO Vintage Cube behavior).
- **Display:** round the continuous value to whole seconds in the UI.
- **On expiry, no selection:** auto-select at random among the items at the **highest rarity present in the pack** (ties random). Rarity tiers are host-defined and strictly ordered lowest→highest; each item has at least one rarity, items with no rarity are treated as if their rarity were lower than every item that does. If a pack somehow has no rarity data, fall back to uniform random across all items.
- **On expiry, unconfirmed selection:** auto-confirm the pending selection.
- **Ghost seats:** a ghost uses the **full host timer** (no shortened ghost timer).

## 5. Network Architecture — P2P Ring

- **Topology:** a ring of peer-to-peer connections. Each seat needs only its immediate neighbours.
- **Normal operation:** direct P2P passing; no central coordinator required.
- **Protocol choice:** **left to the implementer.** The behaviors below are required; the discovery/signaling/transport mechanism is the implementer's design.
- **Seat identity:** a **session token** is issued to each seat at draft start. A reconnecting player must present their token to reclaim their seat.
- **Local heal on disconnect:** if adjacent peers fail to detect each other for a timeout (**duration left to the implementer's discretion**), only the two adjacent seats act. For ring A→B→C, if B drops, **A and C form a direct connection (A→C)**. Only A's "next" pointer and C's "previous" pointer change; the rest of the ring is untouched — no ring-wide consensus or re-broadcast.
- **Ghost player:**
  - When B drops, **C spawns a ghost in B's seat**. The ghost never selects and never confirms; every pick resolves via the timer.
  - The ghost **keeps the ring intact**; no state replay or stack surgery is needed.
  - **Ghost picks are saved to B's binder, held in trust by C** — not C's property and therefore not visible by that player; stored in the background solely to return to B.
  - Ghost picks are held **in memory on C and die with C** (consistent with the abort rule below).
  - **Reconnect:** B presents its session token, takes over the ghost seat, and inherits the held picks (B's pool = pre-drop binder + ghost picks), then resumes normal play.
  - **No reconnect:** the ghost finishes the draft on B's behalf; accumulated picks remain B's abandoned pool.
- **Abort condition (background behavior; not player-facing):** a single disconnect is survivable via ghost. If a **second disconnect occurs adjacent to an already-ghosted seat** — i.e., the peer hosting the ghost also disconnects — the draft is **immediately aborted and all draft state deleted**. No recovery is attempted. This is the only abort condition.

## 6. Deck Construction & Match Rules

- **Main Deck:** minimum 30 cards, no upper limit.
- **Extra Deck:** maximum 15 cards.
- **Sideboard:** all drafted cards not in the starting deck; **no size limit**.
- **Between games (best-of-2n+1):** card-for-card swaps only. **Main Deck and Extra Deck sizes are locked for the whole match** — the client should reject any sideboard change that alters either count.
- **Copy limit:** none. Any number of copies of a card is legal, up to the number drafted.
- **Legality:** all card interactions, mechanics, and bans are dictated by the host's curated pool. Official banlists are overridden.

## 7. Open Items for the Implementer

These are deliberately unspecified; the implementer chooses and documents:
1. **P2P discovery/signaling/transport** (required behaviors in §5).
2. **Disconnect-detection timeout duration** (§5).
3. **Wire format for a pack pass and for ghost-pick transfer** (§5).

Resolved design decisions that must **not** be changed without host sign-off: timer formula/defaults (§4), heal model A→C (§5), ghost behavior (§5), abort condition (§5), re-clumping scope (§3), copy limit (§6), between-game size lock (§6).