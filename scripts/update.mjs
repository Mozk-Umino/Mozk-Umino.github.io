#!/usr/bin/env node
// 週1で index.html の id="data" を書き換える（GitHub Actions から。手元でも node scripts/update.mjs で動く）
//   - activities[].latest … 各活動の最新1本
//   - schedule[].freq     … 更新の頻度（実績の本数から）
//   - リンク確認          … data にある URL を全部開く
// 書き換えたあと、禁止語とリンク切れがあれば一覧を出して exit 1（Actions が失敗として知らせる）
import fs from 'node:fs';
import assert from 'node:assert';

const FILE = new URL('../index.html', import.meta.url);
// 載せない語。中身は公開できないので環境変数 BANNED_WORDS（リポジトリの secret。1行1つの正規表現）から読む
// 取ってきた記事のタイトル・URL に当たったら載せない。無ければ守れないので動かない
const BANNED = (process.env.BANNED_WORDS || '').split('\n').map(s => s.trim()).filter(Boolean).map(s => new RegExp(s, 'i'));
// 動かないのに 403 を返すだけのもの（BOOTH のショップトップはプログラムからだと 403）
const BOT_BLOCKED = [/^https:\/\/mozk-latex\.booth\.pm\/$/];

const UA = {'User-Agent': 'Mozilla/5.0 (mozk-umino.github.io update)'};
// 一時的な接続切れで騒がないよう、失敗したら10秒おいて1回だけやり直す
const open = async (url) => {
  try { return await fetch(url, {headers: UA}); }
  catch { await new Promise(r => setTimeout(r, 10e3)); return fetch(url, {headers: UA}); }
};
const get = async (url) => {
  const r = await open(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
};
const jst = (d) => new Date(new Date(d).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const tag = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(m => m[1]);
const unxml = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

// 各ソースは [{title, url, date}] を新しい順で返す
const SOURCES = [
  {activity: 'もずくの本屋さん', where: 'もずくの本屋さん', weekly: true, fetch: async () =>
    tag(await get('https://mozk-books.com/rss.xml'), 'item').map(i => ({title: unxml(tag(i, 'title')[0]), url: unxml(tag(i, 'link')[0]), date: tag(i, 'pubDate')[0]}))},
  {activity: 'もずくゆらゆらぶろぐ（はてなブログ）', where: 'はてなブログ', fetch: async () =>
    tag(await get('https://mozukuofsea.hateblo.jp/feed'), 'entry').map(e => ({title: unxml(tag(e, 'title')[0]), url: e.match(/<link href="([^"]+)"/)[1], date: tag(e, 'published')[0]}))},
  {activity: 'Qiita', where: 'Qiita', fetch: async () =>
    JSON.parse(await get('https://qiita.com/api/v2/users/TechnoKuRo/items?per_page=100')).map(i => ({title: i.title, url: i.url, date: i.created_at}))},
  {activity: 'note', where: 'note', fetch: async () =>
    JSON.parse(await get('https://note.com/api/v2/creators/100_99_1e12/contents?kind=note&page=1')).data.contents.map(c => ({title: c.name, url: `https://note.com/100_99_1e12/n/${c.key}`, date: c.publishAt}))},
];

export function freq(items, weekly, now = Date.now()) {
  const since = (days) => items.filter(i => now - new Date(i.date) < days * 864e5).length;
  if (weekly) return `週${Math.round(since(56) / 8)}本前後（直近8週の平均）`;
  const n = since(90);
  return n ? `不定期（直近3か月で${n}本）` : '不定期（直近3か月は更新なし）';
}

async function main() {
  if (!BANNED.length) { console.log('BANNED_WORDS が無いので止めた'); process.exit(1); }
  const html = fs.readFileSync(FILE, 'utf8');
  const m = html.match(/(<script type="application\/json" id="data">\n)([\s\S]*?)(\n<\/script>)/);
  const data = JSON.parse(m[2]);
  const alerts = [];

  for (const s of SOURCES) {
    let items;
    try { items = await s.fetch(); } catch (e) { alerts.push(`取得失敗（前回の値のまま）: ${s.activity}: ${e.message}`); continue; }
    const bad = items.filter(i => BANNED.some(b => b.test(i.title) || b.test(i.url)));
    for (const i of bad) alerts.push(`禁止語に当たったので載せなかった: ${i.title} ${i.url}`);
    const ok = items.filter(i => !bad.includes(i)).sort((a, b) => new Date(b.date) - new Date(a.date));
    const act = data.activities.find(a => a.name === s.activity);
    if (ok[0]) act.latest = {title: ok[0].title, url: ok[0].url, date: jst(ok[0].date)};
    data.schedule.find(x => x.where === s.where).freq = freq(items, s.weekly);
  }

  // JSON は1件1行の今の形を保つため、変わったフィールドだけ文字列で差し替える
  let block = m[2];
  for (const a of data.activities) {
    if (!a.latest) continue;
    // 活動の公式 url は works 配列の閉じ "]" の直後にある。その後ろの latest を付け替える
    const re = /\], "url": "[^"]+"(, "latest": \{[^}]*\})?/g;
    re.lastIndex = block.indexOf(`"name": ${JSON.stringify(a.name)}`);
    const hit = re.exec(block);
    const latest = `{"title": ${JSON.stringify(a.latest.title)}, "url": ${JSON.stringify(a.latest.url)}, "date": "${a.latest.date}"}`;
    const repl = `], "url": ${JSON.stringify(a.url)}, "latest": ${latest}`;
    block = block.slice(0, hit.index) + repl + block.slice(hit.index + hit[0].length);
  }
  for (const s of data.schedule) {
    block = block.replace(new RegExp(`("where": ${JSON.stringify(s.where).replace(/[()]/g, '\\$&')}, "what": "[^"]*", "freq": )"[^"]*"`), `$1${JSON.stringify(s.freq)}`);
  }
  JSON.parse(block); // 壊していないか
  const out = html.replace(m[0], m[1] + block + m[3]);
  for (const b of BANNED) if (b.test(out)) alerts.push(`ページ全体に禁止語がある: ${b}`);
  fs.writeFileSync(FILE, out);

  const urls = new Set();
  JSON.stringify(data, (k, v) => (typeof v === 'string' && /^https?:\/\//.test(v) && urls.add(v), v));
  for (const u of urls) {
    if (BOT_BLOCKED.some(b => b.test(u))) continue;
    await new Promise(r => setTimeout(r, 1e3)); // 同じサイトに続けて当てると切られる（はてなで確認）
    try {
      const r = await open(u);
      if (!r.ok) alerts.push(`リンク切れ ${r.status}: ${u}`);
    } catch (e) { alerts.push(`リンク切れ（接続できない）: ${u}`); }
  }

  console.log(`リンク ${urls.size}件を確認。問題 ${alerts.length}件`);
  if (alerts.length) {
    console.log(alerts.join('\n'));
    process.exitCode = 1;
  }
}

if (process.argv[2] === 'test') {
  const now = Date.parse('2026-11-01T00:00:00Z');
  const d = (days) => new Date(now - days * 864e5).toISOString();
  assert.ok(freq([{date: d(1)}, {date: d(10)}, {date: d(100)}], false, now) === '不定期（直近3か月で2本）');
  assert.ok(freq([{date: d(100)}], false, now) === '不定期（直近3か月は更新なし）');
  assert.ok(freq(Array.from({length: 24}, (_, i) => ({date: d(i * 2)})), true, now) === '週3本前後（直近8週の平均）');
  console.log('test ok');
} else {
  await main();
}
