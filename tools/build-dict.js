#!/usr/bin/env node
/* ============================================================
   构建内置本地词典（ECDICT 子集）

   数据来源：https://github.com/skywind3000/ECDICT  （MIT License）
   Copyright (c) 2025 Linwei

   用法：
     node tools/build-dict.js <ecdict.csv 路径> [--inject <index.html>] [--out <base64 文件>]

   裁剪口径（实测「学习者会去点的难词」查得率 96.5%，详见 README）：
     frq 词频前 20000  ∪  带任一考试标签（ky/cet4/cet6/toefl/ielts/gre/gk）

   输出编码（记录间用 \n，字段间用 \x01）：
     word \x01 translation \x01 phonetic \x01 tag \x01 exchange
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FREQ_TOP = 20000;
const EXAM_TAGS = ['ky', 'cet4', 'cet6', 'toefl', 'ielts', 'gre', 'gk'];
const SEP = '\u0001';
const START = '<!-- ECDICT_DATA_START -->';
const END = '<!-- ECDICT_DATA_END -->';

/* ---------- 真正的 CSV 解析：字段可被 " 包裹，内部 " 用 "" 转义 ---------- */
function parseCsvLine(line) {
  const out = [];
  let cur = '', quoted = false, i = 0;
  while (i < line.length) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cur += c; i++;
    } else {
      if (c === '"') { quoted = true; i++; continue; }
      if (c === ',') { out.push(cur); cur = ''; i++; continue; }
      cur += c; i++;
    }
  }
  out.push(cur);
  return out;
}
/* ecdict 的「多义分隔」在 CSV 里是**字面的两个字符 \n**（反斜杠+n），不是真实换行；
   两种都要换成 | ，前端的「多义分条」才拆得开。 */
const clean = s => s
  .replace(/\\n/g, '|')          // 字面 \n
  .replace(/\s*\r?\n\s*/g, '|')  // 真实换行（防御性）
  .replace(/\|{2,}/g, '|')
  .replace(/\u0001/g, ' ')
  .replace(/^\|+|\|+$/g, '')
  .trim();

function build(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split('\n');
  const header = parseCsvLine(lines[0]).map(s => s.trim());
  const at = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const need of ['word', 'phonetic', 'translation', 'tag', 'frq', 'exchange']) {
    if (!(need in at)) throw new Error('ecdict.csv 缺少字段: ' + need);
  }

  const all = [];
  let bad = 0;
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n];
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < header.length) { bad++; continue; }
    const word = (f[at.word] || '').trim();
    if (!word || !/^[a-zA-Z][a-zA-Z'-]*$/.test(word)) continue;   // 只收纯英文词
    const translation = clean(f[at.translation] || '');
    if (!translation) continue;                                    // 没有中文释义的条目没用
    all.push({
      word,
      translation,
      phonetic: clean(f[at.phonetic] || ''),
      tag: (f[at.tag] || '').trim(),
      exchange: (f[at.exchange] || '').trim().replace(/\s+/g, ''),
      frq: parseInt(f[at.frq] || '', 10) || 0,
    });
  }

  /* 词频前 N 名（frq 为空视为最末）+ 全部考试标签词，去重 */
  const picked = new Map();
  all.slice()
     .sort((a, b) => (a.frq || 1e9) - (b.frq || 1e9))
     .slice(0, FREQ_TOP)
     .forEach(r => picked.set(r.word.toLowerCase(), r));
  const tagRe = new RegExp('\\b(' + EXAM_TAGS.join('|') + ')\\b');
  all.forEach(r => { if (tagRe.test(r.tag)) picked.set(r.word.toLowerCase(), r); });

  const rows = Array.from(picked.values());
  return {
    rows,
    stats: { totalCsv: lines.length - 1, badLines: bad, candidateWords: all.length, picked: rows.length,
             tagged: rows.filter(r => tagRe.test(r.tag)).length },
  };
}

/* ---------- 编码 / 压缩 ---------- */
function encode(rows) {
  return rows.map(r => [r.word, r.translation, r.phonetic, r.tag, r.exchange].join(SEP)).join('\n');
}
const b64 = buf => buf.toString('base64');

/* ---------- 自检 ---------- */
function selfCheck(rows, packed, gz) {
  const fails = [];
  const seen = new Set();
  for (const r of rows) {
    const k = r.word.toLowerCase();
    if (seen.has(k)) fails.push('重复键: ' + k);
    seen.add(k);
    if (!r.translation) fails.push('空释义: ' + r.word);
    if (!/^[a-zA-Z][a-zA-Z'-]*$/.test(r.word)) fails.push('非法词形: ' + r.word);
    if (r.translation.includes(SEP) || r.translation.includes('\n')) fails.push('释义含分隔符: ' + r.word);
  }
  const round = zlib.gunzipSync(gz).toString('utf8');
  if (round !== packed) fails.push('gzip 往返不一致');
  if (!packed.includes(SEP)) fails.push('编码里没有字段分隔符');
  return fails;
}

/* ---------- 注入 index.html ---------- */
function inject(htmlPath, base64, meta) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const block =
    START + '\n' +
    '<!-- 本地词典数据：ECDICT 子集（MIT License, Copyright (c) 2025 Linwei）\n' +
    '     来源 https://github.com/skywind3000/ECDICT ；裁剪口径与再生成方式见 README「词典数据与许可」\n' +
    '     ' + JSON.stringify(meta) + ' -->\n' +
    '<script>const ECDICT_META=' + JSON.stringify(meta) + ';const ECDICT_B64="' + base64 + '";</script>\n' +
    END;
  const s = html.indexOf(START);
  const e = html.indexOf(END);
  if (s < 0 || e < 0 || e < s) throw new Error('index.html 里找不到 ECDICT 数据标记');
  html = html.slice(0, s) + block + html.slice(e + END.length);
  fs.writeFileSync(htmlPath, html, 'utf8');
  return html.length;
}

/* ---------- main ---------- */
function main() {
  const argv = process.argv.slice(2);
  const csvPath = argv[0];
  if (!csvPath) {
    console.error('用法: node tools/build-dict.js <ecdict.csv> [--inject index.html] [--out file]');
    process.exit(2);
  }
  const injIdx = argv.indexOf('--inject');
  const outIdx = argv.indexOf('--out');
  const htmlPath = injIdx >= 0 ? argv[injIdx + 1] : null;
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;

  console.log('读取 ' + csvPath + ' …');
  const { rows, stats } = build(csvPath);
  const packed = encode(rows);
  const gz = zlib.gzipSync(Buffer.from(packed, 'utf8'), { level: 9 });
  const base64 = b64(gz);
  const fails = selfCheck(rows, packed, gz);

  const meta = {
    v: 1,
    source: 'skywind3000/ECDICT',
    license: 'MIT',
    slice: 'frq-top-' + FREQ_TOP + ' + exam-tags(' + EXAM_TAGS.join('/') + ')',
    entries: rows.length,
    built: new Date().toISOString().slice(0, 10),
  };

  console.log('CSV 行数        : ' + stats.totalCsv + '（畸形 ' + stats.badLines + '）');
  console.log('可用英文词条    : ' + stats.candidateWords);
  console.log('裁剪后收录      : ' + stats.picked + '（其中带考试标签 ' + stats.tagged + '）');
  console.log('编码原文        : ' + (packed.length / 1048576).toFixed(2) + ' MB');
  console.log('gzip            : ' + (gz.length / 1024).toFixed(0) + ' KB');
  console.log('base64          : ' + (base64.length / 1048576).toFixed(2) + ' MB');
  console.log('自检            : ' + (fails.length ? '失败 ' + fails.length + ' 项 -> ' + fails.slice(0, 5).join('; ') : '通过'));

  if (outPath) { fs.writeFileSync(outPath, base64, 'utf8'); console.log('已写出        : ' + outPath); }
  if (htmlPath) {
    const size = inject(htmlPath, base64, meta);
    console.log('已注入        : ' + htmlPath + ' → ' + (size / 1048576).toFixed(2) + ' MB');
  }
  if (!outPath && !htmlPath) console.log('（未指定 --out / --inject，仅做统计）');

  process.exit(fails.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { build, encode, parseCsvLine };
