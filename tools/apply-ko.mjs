import fs from 'node:fs';

const [, , file, mapFile] = process.argv;
let src = fs.readFileSync(file, 'utf8');
const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
  .map(([zh, ko]) => ({ zh, ko }))
  .sort((a, b) => b.zh.length - a.zh.length);

let applied = 0;
const missing = [];
for (const { zh, ko } of map) {
  let hits = 0;
  for (const q of ["'", '"']) {
    const from = q + zh + q;
    const to = q + ko + q;
    const parts = src.split(from);
    hits += parts.length - 1;
    if (parts.length > 1) src = parts.join(to);
  }
  if (hits === 0) missing.push(zh);
  applied += hits;
}

function rep(from, to, label) {
  const parts = src.split(from);
  const n = parts.length - 1;
  if (n > 0) src = parts.join(to);
  console.log('[' + (n > 0 ? 'ok' : 'MISS') + '] ' + label + ' x' + n);
  return n;
}

rep("id: '@starplume/dsh-chat-mode'", "id: '@local/dsh-chat-mode-ko'", 'module loader id');
rep("toLocaleTimeString('zh-CN'", "toLocaleTimeString('ko-KR'", 'time locale');

// Korean aria-label selectors for the DSH titlebar buttons (ko UI locale).
const anchor = 'button[aria-label="New session"]\',';
const ind = '        ';
const koLines = [
  ind + '\'html[\' + DSH_SIDEBAR_HIDE_ATTR + \'="1"] button[aria-label="사이드바 접기"]\',',
  ind + '\'html[\' + DSH_SIDEBAR_HIDE_ATTR + \'="1"] button[aria-label="사이드바 열기"]\',',
  ind + '\'html[\' + DSH_SIDEBAR_HIDE_ATTR + \'="1"] [data-sidebar-collapsed="true"] button[aria-label="새 세션"]\',',
].join('\n');
rep(anchor, anchor + '\n' + koLines, 'korean titlebar selectors');

fs.writeFileSync(file, src, 'utf8');

// Re-scan for leftover CJK inside quoted literals.
const CJK = /[\u2E80-\u2FDF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const leftovers = new Map();
let i = 0, line = 1;
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
    const quote = ch, at = line;
    let j = i + 1, raw = '', closed = false;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { raw += c + (src[j + 1] ?? ''); j += 2; continue; }
      if (c === quote) { closed = true; break; }
      if (c === '\n') { if (quote !== '`') break; line += 1; }
      raw += c; j += 1;
    }
    if (closed) { if (CJK.test(raw)) leftovers.set(raw, at); i = j + 1; continue; }
    i += 1; continue;
  }
  i += 1;
}

console.log('\napplied replacements:', applied, '| map entries:', map.length);
console.log('unused map entries:', missing.length);
if (missing.length) for (const m of missing) console.log('  UNUSED:', m);
console.log('leftover CJK literals:', leftovers.size);
for (const [raw, at] of leftovers) console.log('  L' + at + ': ' + raw);