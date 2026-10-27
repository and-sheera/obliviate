"""Names, surnames and places of the OpenCorpora dictionary (CC BY-SA 3.0, opencorpora.org) as word stems → src/core/lexicon.json.
"en" — the commonest English first names (US Census 1990, public domain, via the `names` package) for latin names in russian text.

usage: pip install pymorphy3 pymorphy3-dicts-ru names && python scripts/build_lexicon.py
The stem is the same as keyStem() in src/core/replace.ts (case endings stripped), so "Иванову" and the lemma "иванов" meet.
Patronymics are not listed: -ович/-овна are recognised by their ending.
"""
import json
import re
import sys

import os

import names
import pymorphy3

GROUPS = {"Name": "name", "Surn": "surn", "Geox": "geo"}
# "как", "какие", "нажимаем"-like stems of ordinary words must not match a rare name: drop what a function word or any form of a verb also stems to
ORDINARY = {"CONJ", "PREP", "PRCL", "ADVB", "NPRO", "INTJ", "PRED", "NUMR", "COMP", "VERB", "INFN", "GRND", "PRTF", "PRTS"}
ENDING = re.compile(r"(?:ами|ями|ом|ем|ам|ям|ах|ях|ым|им|ых|их|ми|[аеиоуыэюяьй])$")


def stem(word):
    w = word.lower().replace("ё", "е")
    for _ in range(3):
        n = ENDING.sub("", w)
        if len(n) < 3 or n == w:
            break
        w = n
    return w


d = pymorphy3.MorphAnalyzer().dictionary
seen = {}  # (paradigm, form) → grammemes we care about; most of the 5M forms repeat a few thousand tags
out = {v: set() for v in GROUPS.values()}
ordinary = set()

for _word, tag, lemma, para_id, idx in d.iter_known_words():
    g = seen.get((para_id, idx))
    if g is None:
        grammemes = set(re.split(r"[ ,]", str(tag)))
        g = seen[(para_id, idx)] = [v for k, v in GROUPS.items() if k in grammemes] + (["ordinary"] if grammemes & ORDINARY else [])
    for v in g:
        if v == "ordinary":
            if re.fullmatch(r"[а-яё-]+", _word):
                ordinary.add(stem(_word))
            continue
        if re.fullmatch(r"[а-яё-]+", lemma) and len(lemma) >= 3:
            out[v].add(stem(lemma))
for k, v in out.items():
    if k != "geo":  # places are few and well known ("Сочи" stems like the verb forms of "сочиться"); the other lists hold many ordinary words
        v -= ordinary
out["en"] = set()
for f, top in (("dist.male.first", 800), ("dist.female.first", 1500)):
    with open(os.path.join(os.path.dirname(names.__file__), f)) as fh:
        out["en"] |= {line.split()[0].lower() for line in list(fh)[:top]}
json.dump({k: sorted(v) for k, v in out.items()}, open(sys.argv[1] if len(sys.argv) > 1 else "src/core/lexicon.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print({k: len(v) for k, v in out.items()})
