# Dal materiale registrato (clips/<scena>/clip.json) costruisce timeline.js:
# per ogni scena l'elenco dei fotogrammi a 30 fps, con le attese tagliate e la velocità adattata alle battute.
import json, os, sys

FPS = 30
BAR = 2.4
HERE = os.path.dirname(os.path.abspath(__file__))  # compose.html è qui: i percorsi dei fotogrammi sono relativi a questa cartella
WORK = os.environ.get("TRAILER_WORK", os.path.join(HERE, "work"))
KEEP_AFTER_CUT = 0.25  # di un'attesa tagliata resta solo l'ultimo istante

# fermi immagine: scena -> [(tempo utile, durata)]
HOLDS = {}

# scena: (inizio in secondi di tempo "utile", fine o None, battute)
SCENES = {
    "home": (0.5, None, 4),
    "deck": (0.3, None, 5),
    "record": (0.3, None, 14),
    "edit": (0.3, None, 6),
    "practice": (0.3, None, 6),
    "auto": (0.3, None, 5),
    "sheet": (0.3, None, 6),
    "hdpc": (0.3, None, 5),
    "online": (0.3, None, 3),
}


def kept_segments(clip):
    fr = clip["frames"]
    t0, t1 = fr[0]["t"], fr[-1]["t"]
    cuts, open_ = [], {}
    for m in clip["marks"]:
        kind, label = m["label"].split(":", 1)
        if kind == "cut":
            open_[label] = m["t"]
        else:
            cuts.append((open_.pop(label), m["t"]))
    segs, cur = [], t0
    for a, b in sorted(cuts):
        segs.append((cur, a))
        cur = max(a, b - KEEP_AFTER_CUT)
    segs.append((cur, max(t1, cur)))
    return segs, cuts, t0


def src_time(segs, k):
    """Tempo sorgente corrispondente a k secondi di tempo utile."""
    for a, b in segs:
        if k <= b - a:
            return a + k
        k -= b - a
    return segs[-1][1] + k  # oltre la fine: si tiene l'ultimo fotogramma


out = {}
for name, (tin, tout, bars) in SCENES.items():
    clip = json.load(open(f"{WORK}/clips/{name}/clip.json"))
    segs, cuts, t0 = kept_segments(clip)
    useful = sum(b - a for a, b in segs)
    tout = useful if tout is None else min(tout, useful)
    dur = bars * BAR
    holds = HOLDS.get(name, [])
    speed = (tout - tin) / (dur - sum(h for _, h in holds))
    speed = max(speed, 0.0)
    frames = clip["frames"]
    times = [f["t"] for f in frames]
    seq, j = [], 0
    n = round(dur * FPS)
    cut_flags = []
    for i in range(n):
        o = i / FPS
        for at, h in holds:  # dopo un fermo immagine il tempo utile riparte da dove si era fermato
            start = (at - tin) / speed
            if o > start:
                o = max(start, o - h)
        k = tin + o * speed
        s = src_time(segs, k)
        while j + 1 < len(times) and times[j + 1] <= s:
            j += 1
        if j > 0 and times[j] > s:
            j -= 1
        seq.append(os.path.relpath(frames[j]["file"], HERE))
        cut_flags.append(s - t0)
    out[name] = {"bars": bars, "speed": round(speed, 3), "frames": seq, "src": [round(x, 2) for x in cut_flags]}
    print(f"{name:10s} {bars} battute · velocità {speed:.2f}x · {n} fotogrammi")

with open(f"{WORK}/timeline.js", "w") as f:
    f.write("window.CLIPS = " + json.dumps(out) + ";\n")
