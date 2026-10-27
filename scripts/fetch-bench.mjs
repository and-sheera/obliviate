// node scripts/fetch-bench.mjs — downloads two independent Russian PII benchmarks into tests/ext/ (git-ignored)
// and writes both as [{ text, spans: [{ start, end, type }] }], type ∈ NAME | ID | CONTACT | PLACE.
//   redmadrobot-rnd/pii_benchmark (MIT)   token BIO tags → character offsets
//   hivetrace/pii-bench (Apache-2.0)      character spans; held-out data: evaluation only, never train on it
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../tests/ext/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const KIND = {
  FIRST_NAME: 'NAME', LAST_NAME: 'NAME', MIDDLE_NAME: 'NAME', NAME: 'NAME', PERSON: 'NAME', FULL_NAME: 'NAME',
  PASSPORT: 'ID', DRIVER_LICENSE: 'ID', BIRTH_CERTIFICATE: 'ID', MILITARY_ID: 'ID', INN: 'ID', SNILS: 'ID', OMS: 'ID', CREDIT_CARD: 'ID',
  EMAIL: 'CONTACT', PHONE: 'CONTACT', PHONE_NUMBER: 'CONTACT', IP_ADDRESS: 'CONTACT',
};
const kind = (t) => KIND[t] ?? (/CARD|INN|SNILS|PASSPORT|OGRN|KPP/.test(t) ? 'ID' : 'PLACE');

function parseCsv(s) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.slice(1);
}

// redmadrobot: tokens are the text split with spaces; find each token in order
const csv = await (await fetch('https://huggingface.co/datasets/redmadrobot-rnd/pii_benchmark/resolve/main/test.csv')).text();
const rmr = parseCsv(csv).map(([text, tokens, tags]) => {
  const ts = JSON.parse(tokens), gs = JSON.parse(tags), spans = [];
  let pos = 0, cur = null;
  ts.forEach((t, i) => {
    const at = text.indexOf(t, pos);
    if (at < 0) return;
    pos = at + t.length;
    const tag = gs[i];
    if (tag.startsWith('I-') && cur && cur.type === tag.slice(2)) cur.end = pos;
    else { cur = null; if (tag !== 'O') spans.push((cur = { start: at, end: pos, type: tag.slice(2) })); }
  });
  return { text, spans: spans.map((s) => ({ ...s, type: kind(s.type) })) };
});
writeFileSync(new URL('redmadrobot.json', OUT), JSON.stringify(rmr));

// hivetrace: pages of 100 through the datasets server
const hive = [];
for (const split of ['entity', 'domain']) {
  for (let off = 0; ; off += 100) {
    const r = await (await fetch(`https://datasets-server.huggingface.co/rows?dataset=hivetrace/pii-bench&config=default&split=${split}&offset=${off}&length=100`)).json();
    for (const { row } of r.rows) hive.push({ text: row.text, spans: row.entities.map((e) => ({ start: e.start, end: e.end, type: kind(e.type), raw: e.type })) });
    if (r.rows.length < 100) break;
  }
}
writeFileSync(new URL('hivetrace.json', OUT), JSON.stringify(hive));
console.log(`redmadrobot: ${rmr.length} texts, hivetrace: ${hive.length} texts → tests/ext/`);
