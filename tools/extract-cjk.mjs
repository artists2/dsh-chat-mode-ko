import fs from 'node:fs';

const [, , file, outFile] = process.argv;
const src = fs.readFileSync(file, 'utf8');
const CJK = /[\u2E80-\u2FDF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const found = new Map();
let i = 0, line = 1, missed = 0;

function record(raw, atLine) {
  const entry = found.get(raw);
  if (entry) {
    entry.count += 1;
    if (entry.lines.length < 12 && entry.lines[entry.lines.length - 1] !== atLine) entry.lines.push(atLine);
    return;
  }
  found.set(raw, { count: 1, lines: [atLine] });
}

while (i < src.length) {
  const ch = src[i];
  if (ch === '\n') { line += 1; i += 1; continue; }
  if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
  if (ch === '/' && src[i + 1] === '*') {
    i += 2;
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line += 1; i += 1; }
    i += 2; continue;
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    const quote = ch, startLine = line;
    let j = i + 1, raw = '', closed = false;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { raw += c + (src[j + 1] ?? ''); j += 2; continue; }
      if (c === quote) { closed = true; break; }
      if (c === '\n') { if (quote !== '`') break; line += 1; }
      raw += c; j += 1;
    }
    if (closed) { if (CJK.test(raw)) record(raw, startLine); i = j + 1; continue; }
    missed += 1; i += 1; continue;
  }
  i += 1;
}

const entries = [...found.entries()].map(([raw, info]) => ({ raw, count: info.count, lines: info.lines })).sort((a, b) => b.raw.length - a.raw.length);
fs.writeFileSync(outFile, JSON.stringify({ file, unique: entries.length, entries }, null, 2), 'utf8');
console.log('unique CJK literals:', entries.length, '| unterminated skipped:', missed);