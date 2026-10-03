"""Fine-tune a BERT for PER/ORG/LOC on Collection3 plus augmentations of it, and English CoNLL-2003.

usage: [BASE=hf-id] [FRAG=0.3] [EN=5000] [AUG=1] [CPU=1] train_model.py <out-dir>   then: convert-model.sh <out-dir> public/models/ner-x

Why each augmentation (all made from Collection3 itself, so the grammar stays real):
  fragments     speech-to-text cuts a sentence into cues and capitalises each ("Пошуршал в логах", "Будешь с ним работать");
                a model trained on news only takes such a capitalised word for a name
  surname first documents write "Кузнецова Валерия Игоревна"; news almost never does, and the model starts a new person at the first name
  quotes        companies in quotes without ООО: "работает в «Пятёрочке»", "аналитик «Атона»"
  title case    headings and lists capitalise every word ("Итоги Года: Рост Выручки"), all caps ("ХАРАКТЕРИСТИКА"): not entities
  EN            CoNLL-2003 (MISC → O): rubert-tiny2 knows English, so English names come at no size cost
"""
import os
import random
import sys

import torch
from datasets import Dataset, load_dataset
from seqeval.metrics import classification_report
from transformers import (AutoModelForTokenClassification, AutoTokenizer, DataCollatorForTokenClassification,
                          Trainer, TrainingArguments)

BASE = os.environ.get("BASE", "cointegrated/rubert-tiny2")
LABELS = ["O", "B-PER", "I-PER", "B-ORG", "I-ORG", "B-LOC", "I-LOC"]
random.seed(0)
out = sys.argv[1]


def collection3(split):
    d = load_dataset("RCC-MSU/collection3", revision="refs/convert/parquet")[split]
    return [(r["tokens"], [LABELS[t] for t in r["ner_tags"]]) for r in d]


def conll(split, n):
    d = load_dataset("eriktks/conll2003", revision="refs/convert/parquet")[split]
    names = d.features["ner_tags"].feature.names
    rows = [(r["tokens"], ["O" if "MISC" in names[t] else names[t] for t in r["ner_tags"]]) for r in d if len(r["tokens"]) > 3]
    random.shuffle(rows)
    return rows[:n]


def spans(labels):
    out, i = [], 0
    while i < len(labels):
        if labels[i].startswith("B-"):
            j = i + 1
            while j < len(labels) and labels[j] == "I-" + labels[i][2:]:
                j += 1
            out.append((i, j, labels[i][2:]))
            i = j
        else:
            i += 1
    return out


def surname_first(words, labels):
    """Валерия Игоревна Кузнецова → Кузнецова Валерия Игоревна"""
    ps = [(s, e) for s, e, t in spans(labels) if t == "PER" and 2 <= e - s <= 3 and all(w[:1].isupper() for w in words[s:e])]
    if not ps:
        return None
    s, e = random.choice(ps)
    return words[:s] + [words[e - 1]] + words[s:e - 1] + words[e:], labels


def quoted(words, labels):
    """в Газпроме → в «Газпроме»"""
    os_ = [(s, e) for s, e, t in spans(labels) if t == "ORG" and words[max(s - 1, 0)] not in ("«", '"') and s > 0]
    if not os_:
        return None
    s, e = random.choice(os_)
    return words[:s] + ["«"] + words[s:e] + ["»"] + words[e:], labels[:s] + ["O"] + labels[s:e] + ["O"] + labels[e:]


def heading(words, labels):
    """a run of ordinary words as a heading: Рост Выручки И Новые Клиенты, or РОСТ ВЫРУЧКИ"""
    runs, i = [], 0
    while i < len(words):
        j = i
        while j < len(words) and labels[j] == "O" and words[j].isalpha():
            j += 1
        if j - i >= 2:
            runs.append((i, j))
        i = j + 1
    if not runs:
        return None
    s, e = random.choice(runs)
    e = min(e, s + random.randint(2, 5))
    w = [x.upper() for x in words[s:e]] if random.random() < 0.3 else [x[:1].upper() + x[1:] for x in words[s:e]]
    return w, ["O"] * len(w)


def fragment(words, labels):
    """a speech-to-text cue: cut mid-sentence at an O word and capitalise it; entities are never cut"""
    starts = [i for i in range(1, len(words)) if labels[i] == "O" and words[i][0].isalpha()]
    if not starts:
        return None
    k = random.choice(starts)
    e = min(len(words), k + random.randint(1, 12))
    while e < len(words) and labels[e].startswith("I-"):
        e += 1
    w = words[k:e]
    w[0] = w[0][0].upper() + w[0][1:]
    return w, labels[k:e]


def some(fn, rows, share):
    return [f for f in (fn(*r) for r in rows if random.random() < share) if f]


c3 = collection3("train")  # adding NEREL made it worse: its ORG is broader, names got missed
train = c3 + some(fragment, c3, float(os.environ.get("FRAG", "0.3")))
if os.environ.get("AUG", "1") == "1":
    train += some(surname_first, c3, 0.15) + some(quoted, c3, 0.3) + some(heading, c3, 0.15)
train += conll("train", int(os.environ.get("EN", "5000")))
random.shuffle(train)
test = collection3("test")
print("train", len(train), "test", len(test))

tok = AutoTokenizer.from_pretrained(BASE)
model = AutoModelForTokenClassification.from_pretrained(
    BASE, num_labels=len(LABELS), id2label=dict(enumerate(LABELS)), label2id={l: i for i, l in enumerate(LABELS)})


def encode(rows):
    enc = tok([w for w, _ in rows], is_split_into_words=True, truncation=True, max_length=128)
    enc["labels"] = []
    for i, (_, labels) in enumerate(rows):
        prev, ids = None, []
        for w in enc.word_ids(i):  # only the first piece of a word is labelled, like aggregate.ts reads it
            ids.append(-100 if w is None or w == prev else LABELS.index(labels[w]))
            prev = w
        enc["labels"].append(ids)
    return Dataset.from_dict(dict(enc))


trainer = Trainer(
    model=model,
    args=TrainingArguments(out, num_train_epochs=5, learning_rate=1e-4, per_device_train_batch_size=32,
                           warmup_ratio=0.1, weight_decay=0.01, save_strategy="no", logging_steps=200, report_to=[], seed=0, use_cpu=os.environ.get("CPU") == "1"),
    train_dataset=encode(train),
    data_collator=DataCollatorForTokenClassification(tok),
)
trainer.train()
trainer.save_model(out)
tok.save_pretrained(out)

model = model.to("cpu").eval()
for name, rows in [("Collection3 test", test), ("CoNLL-2003 test", conll("test", 1000))]:
    y_true, y_pred = [], []
    for words, labels in rows:
        enc = tok(words, is_split_into_words=True, truncation=True, max_length=128, return_tensors="pt")
        with torch.no_grad():
            p = model(**enc).logits[0].argmax(-1).tolist()
        pred, prev = [], None
        for i, w in enumerate(enc.word_ids()):
            if w is not None and w != prev:
                pred.append(LABELS[p[i]])
            prev = w
        y_true.append(labels[:len(pred)])
        y_pred.append(pred)
    print(name)
    print(classification_report(y_true, y_pred, digits=3))
