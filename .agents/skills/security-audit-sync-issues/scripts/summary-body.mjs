#!/usr/bin/env node
// 集約 Issue の本文と、区分ごとの詳細コメントを行き来する。
// 本文が上限を超える集約 Issue は、本文に一覧表を、区分ごとの詳細（<details> の並び）をコメントに置く。
// 読むときは compose で 1 つの全文に戻し、書くときは split で本文とコメントに分ける。全文は分ける前の書式と同じなので、
// 番号・件数・項目の検査は全文に対して行える。
//   extract <Issue の JSON> <出力>                 `gh api repos/<owner>/<repo>/issues/<番号>` の出力から本文をそのまま書き出す（--jq は末尾に改行を足すため）
//   compose <本文> <コメントの JSON> <出力>        本文に、リンクした詳細コメントの中身を戻した全文を書き出す
//   split <全文> <出力フォルダ> --body <今の本文> --comments <コメントの JSON> [--max 60000]
//                                                 全文を本文と詳細コメントに分け、書き込みの計画（plan.json）を出す
//   fill <本文> <出力> --url <区分>:<部>=<URL> ...  split が残した新しいコメントの URL の仮置きを埋める
// コメントの JSON は `gh api --paginate --slurp "repos/<owner>/<repo>/issues/<番号>/comments?per_page=100"` の出力（配列の配列でもよい）。
// 終了コード 1 は上限などの検査に外れた、2 は本文・コメントの構造の異常、3 は引数の誤り。
import fs from "node:fs";
import path from "node:path";

export const MAX_CHARS = 60000;
export const SECTIONS = ["確定", "要検証", "未検証", "棄却", "未完了の工程・範囲"];
// 人が書いた「詳細: 」で始まる文と見分けるため、リンクか仮置きで始まる行だけを詳細へのリンクとみなす
const LINK_LINE = /^詳細: \[[^\]]+\]\((https?:\/\/\S+#issuecomment-\d+|\{\{DETAILS_URL:[^}]+\}\})\)/;
const COMMENT_LINK = /\]\((https?:\/\/[^\s)]+#issuecomment-(\d+))\)/g;
const PLACEHOLDER = /\{\{DETAILS_URL:([^:}]+):(\d+)\}\}/g;
const NOTE = "一覧表と件数は集約 Issue の本文にある。項目を直すときは、このコメントの詳細と本文の一覧表をそろえて直す。";

export class UsageError extends Error {}
export class StructureError extends Error {}
export class CheckError extends Error {}

const broken = (reason) => {
  throw new StructureError(reason);
};
const fail = (message) => {
  throw new UsageError(message);
};
export const chars = (text) => [...text].length;
const lines = (text) => text.replace(/\r\n/g, "\n").split("\n");

// 区画の中の区分ごとに、見出しの行・次の見出しの行・詳細の範囲（最初の <details> から最後の </details> まで）・詳細へのリンクの行を探す
function sectionsOf(ls) {
  const b = ls.findIndex((l) => l.trim() === "<!-- security-audit:summary-begin -->");
  const e = ls.findIndex((l) => l.trim() === "<!-- security-audit:summary-end -->");
  if (b < 0 || e < 0 || b > e) broken("summary_block");
  const out = [];
  let cur = null;
  for (let i = b + 1; i < e; i++) {
    const l = ls[i];
    if (l.startsWith("## ")) {
      if (cur) cur.end = i;
      const m = /^## (.+?)（.*）\s*$/.exec(l);
      cur = m && SECTIONS.includes(m[1]) ? { name: m[1], head: i, first: -1, last: -1, links: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^<details>/.test(l) && cur.first < 0) cur.first = i;
    if (/<\/details>\s*$/.test(l)) cur.last = i;
    if (LINK_LINE.test(l) && (cur.first < 0 || i > cur.last)) cur.links.push(i);
  }
  if (cur) cur.end = e;
  const names = out.map((s) => s.name);
  if (new Set(names).size !== names.length) broken("section_duplicate");
  return { begin: b, end: e, sections: out };
}

function summaryIdOf(ls) {
  const ids = ls.flatMap((l) => {
    const m = /^<!-- security-audit:summary-id=(.+) -->$/.exec(l.trim());
    return m ? [m[1]] : [];
  });
  if (ids.length !== 1) broken("summary_id");
  return ids[0];
}

// 詳細へのリンクの行から、コメントの ID と URL を順に取り出す
function linksOf(line) {
  return [...line.matchAll(COMMENT_LINK)].map((m) => ({ url: m[1], id: m[2] }));
}

export function normalizeComments(raw) {
  if (!Array.isArray(raw)) fail("コメントの JSON 配列を渡してください");
  return raw.flat().map((c) => ({ id: String(c.id), body: String(c.body ?? ""), url: String(c.html_url ?? "") }));
}

// 詳細コメントの区分・部・中身（<details> の行の並び）を読む
export function parseComment(body, summaryId) {
  const ls = lines(body);
  const begins = ls.flatMap((l, i) => {
    const m = /^<!-- security-audit:details-begin summary-id=(\S+) section=(\S+) part=(\d+) -->$/.exec(l.trim());
    return m ? [{ i, summaryId: m[1], section: m[2], part: Number(m[3]) }] : [];
  });
  const ends = ls.flatMap((l, i) => (l.trim() === "<!-- security-audit:details-end -->" ? [i] : []));
  if (begins.length !== 1 || ends.length !== 1 || begins[0].i > ends[0]) return null;
  const head = begins[0];
  if (head.summaryId !== summaryId) return null;
  const inner = ls.slice(head.i + 1, ends[0]);
  // 見出し・空行・説明・空行の 4 行のあとが詳細。部の境目の空行も詳細に含めて、そのまま戻す
  if (!inner[0]?.startsWith("## ") || inner[1] !== "" || inner[3] !== "") return null;
  const details = inner.slice(4);
  if (!details.some((l) => /^<details>/.test(l)) || !/<\/details>\s*$/.test(details.at(-1) ?? "")) return null;
  return { section: head.section, part: head.part, details };
}

export function compose(bodyText, rawComments) {
  const ls = lines(bodyText);
  const comments = new Map(normalizeComments(rawComments).map((c) => [c.id, c]));
  const { sections } = sectionsOf(ls);
  const summaryId = summaryIdOf(ls);
  // 後ろの区分から置き換えて、前の行番号がずれないようにする
  const out = [...ls];
  for (const s of [...sections].reverse()) {
    if (s.links.length > 1) broken(`details_link_duplicate:${s.name}`);
    if (s.links.length === 0) continue;
    if (s.first >= 0) broken(`details_in_body_and_comment:${s.name}`);
    const links = linksOf(ls[s.links[0]]);
    if (links.length === 0) broken(`details_link_empty:${s.name}`);
    const parts = links.map((link, k) => {
      const c = comments.get(link.id);
      if (!c) broken(`details_comment_missing:${s.name}:${k + 1}`);
      const p = parseComment(c.body, summaryId);
      if (!p || p.section !== s.name || p.part !== k + 1) broken(`details_comment_broken:${s.name}:${k + 1}`);
      return p.details;
    });
    out.splice(s.links[0], 1, ...parts.flat());
  }
  return out.join("\n");
}

// 詳細の <details> の塊ごとに分ける
function blocksOf(detailLines) {
  const blocks = [];
  let cur = [];
  for (const l of detailLines) {
    cur.push(l);
    if (/<\/details>\s*$/.test(l)) {
      blocks.push(cur);
      cur = [];
    }
  }
  if (cur.length) blocks[blocks.length - 1]?.push(...cur);
  return blocks;
}

export function commentText(summaryId, section, part, total, detailLines) {
  return [
    `<!-- security-audit:details-begin summary-id=${summaryId} section=${section} part=${part} -->`,
    total > 1 ? `## ${section}の詳細（${part}/${total}）` : `## ${section}の詳細`,
    "",
    NOTE,
    "",
    ...detailLines,
    "<!-- security-audit:details-end -->",
  ].join("\n");
}

// 区分の詳細を、コメント 1 件が上限に収まるように分ける
function chunk(summaryId, section, detailLines, max) {
  const blocks = blocksOf(detailLines);
  const parts = [];
  let cur = [];
  for (const blk of blocks) {
    const next = [...cur, ...blk];
    if (cur.length && chars(commentText(summaryId, section, 99, 99, next)) > max) {
      parts.push(cur);
      cur = [...blk];
    } else cur = next;
  }
  if (cur.length) parts.push(cur);
  for (const p of parts) if (chars(commentText(summaryId, section, 99, 99, p)) > max) throw new CheckError(`details_too_long:${section}`);
  return parts;
}

// 全文を本文と詳細コメントに分ける。今の本文がまだ分けていない形で、全文が上限に収まるなら、分けずに全文を本文にする。
export function split(fullText, currentBody, rawComments, max = MAX_CHARS) {
  const full = lines(fullText);
  const cur = lines(currentBody);
  const summaryId = summaryIdOf(full);
  if (summaryIdOf(cur) !== summaryId) broken("summary_id_mismatch");
  const comments = new Map(normalizeComments(rawComments).map((c) => [c.id, c]));
  const curSections = new Map(sectionsOf(cur).sections.map((s) => [s.name, s]));
  const alreadySplit = [...curSections.values()].some((s) => s.links.length > 0);
  if (!alreadySplit && chars(fullText) <= max) return { mode: "single", body: fullText, comments: [], plan: [] };

  const { sections } = sectionsOf(full);
  const out = [...full];
  const files = [];
  const plan = [];
  for (const s of [...sections].reverse()) {
    if (s.links.length) broken(`details_link_in_full:${s.name}`);
    const existing = curSections.get(s.name)?.links.length ? linksOf(cur[curSections.get(s.name).links[0]]) : [];
    const parts = s.first >= 0 ? chunk(summaryId, s.name, full.slice(s.first, s.last + 1), max) : [];
    const urls = parts.map((p, k) => {
      const text = commentText(summaryId, s.name, k + 1, parts.length, p);
      const old = existing[k];
      const was = old && comments.get(old.id);
      const op = !old ? "create" : was && was.body.replace(/\r\n/g, "\n") === text ? "same" : "update";
      files.unshift({ section: s.name, part: k + 1, text });
      plan.unshift({ op, section: s.name, part: k + 1, comment_id: old?.id ?? null, url: old?.url ?? null });
      return old ? old.url : `{{DETAILS_URL:${s.name}:${k + 1}}}`;
    });
    // 使わなくなった詳細コメントは消さずに、使っていないことを書いて残す
    for (const old of existing.slice(parts.length)) plan.unshift({ op: "retire", section: s.name, part: null, comment_id: old.id, url: old.url });
    if (parts.length) {
      const label = (k) => (parts.length > 1 ? `${s.name}の詳細 ${k + 1}` : `${s.name}の詳細`);
      out.splice(s.first, s.last - s.first + 1, `詳細: ${urls.map((u, k) => `[${label(k)}](${u})`).join("・")}`);
    }
  }
  const body = out.join("\n");
  if (chars(body) > max) throw new CheckError(`too_long_body:${chars(body)}`);
  return { mode: "split", body, comments: files, plan };
}

export function retiredText(summaryId) {
  return [`<!-- security-audit:details-retired summary-id=${summaryId} -->`, "この詳細コメントは使っていない（集約 Issue の本文からリンクしていない）。"].join("\n");
}

export function fill(bodyText, urls) {
  const filled = bodyText.replace(PLACEHOLDER, (m, section, part) => {
    const u = urls[`${section}:${part}`];
    if (!u) fail(`URL がない: ${section}:${part}`);
    if (!/^https?:\/\/\S+#issuecomment-\d+$/.test(u)) fail(`コメントの URL ではない: ${u}`);
    return u;
  });
  return filled;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    fail(`ファイルを読めません: ${file}`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    fail(`JSON ではありません: ${file}`);
  }
}

function options(args, names, multi = []) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const name = a.slice(2);
    if (!names.includes(name) && !multi.includes(name)) fail(`知らないオプションです: ${a}`);
    if (i + 1 >= args.length) fail(`${a} の値がありません`);
    if (multi.includes(name)) (out[name] ??= []).push(args[++i]);
    else out[name] = args[++i];
  }
  return out;
}

export const COMMANDS = {
  extract: (args) => {
    if (args.length !== 2) fail("使い方: extract <Issue の JSON> <出力>");
    const issue = readJson(args[0]);
    if (typeof issue?.body !== "string") fail("Issue の JSON に body がありません");
    fs.writeFileSync(args[1], issue.body);
    return `ok ${chars(issue.body)}`;
  },
  compose: (args) => {
    if (args.length !== 3) fail("使い方: compose <本文> <コメントの JSON> <出力>");
    const text = compose(readText(args[0]), readJson(args[1]));
    fs.writeFileSync(args[2], text);
    return `ok ${chars(text)}`;
  },
  split: (args) => {
    const o = options(args, ["body", "comments", "max"]);
    if (o._.length !== 2 || !o.body || !o.comments) fail("使い方: split <全文> <出力フォルダ> --body <今の本文> --comments <コメントの JSON> [--max 60000]");
    const max = o.max ? Number(o.max) : MAX_CHARS;
    if (!Number.isInteger(max) || max <= 0) fail("--max は正の整数で指定してください");
    const r = split(readText(o._[0]), readText(o.body), readJson(o.comments), max);
    const dir = o._[1];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "body.md"), r.body);
    const summaryId = summaryIdOf(lines(r.body));
    const plan = r.plan.map((p, i) => {
      if (p.op === "retire") {
        const file = path.join(dir, `retire-${i + 1}.md`);
        fs.writeFileSync(file, retiredText(summaryId));
        return { ...p, file };
      }
      const c = r.comments.find((x) => x.section === p.section && x.part === p.part);
      const file = path.join(dir, `details-${SECTIONS.indexOf(p.section) + 1}-${p.part}.md`);
      fs.writeFileSync(file, c.text);
      return { ...p, file };
    });
    fs.writeFileSync(path.join(dir, "plan.json"), `${JSON.stringify({ mode: r.mode, plan }, null, 2)}\n`);
    const summary = [`mode ${r.mode}`, `body ${chars(r.body)}`];
    for (const p of plan) summary.push(`${p.op} ${p.section}${p.part ? `:${p.part}` : ""}${p.file ? ` ${chars(readText(p.file))}` : ""}`);
    return summary.join("\n");
  },
  fill: (args) => {
    const o = options(args, [], ["url"]);
    if (o._.length !== 2) fail("使い方: fill <本文> <出力> --url <区分>:<部>=<URL> ...");
    const urls = {};
    for (const u of o.url ?? []) {
      const m = /^(.+:\d+)=(.+)$/.exec(u);
      if (!m) fail(`--url は <区分>:<部>=<URL> の形で指定してください: ${u}`);
      urls[m[1]] = m[2];
    }
    fs.writeFileSync(o._[1], fill(readText(o._[0]), urls));
    return "ok";
  },
};

export function run(argv, commands = COMMANDS) {
  const [cmd, ...args] = argv;
  const fn = commands[cmd];
  if (!fn) fail(`使い方: summary-body.mjs <${Object.keys(commands).join("|")}> [...]`);
  return fn(args);
}

export function exitWith(error, name) {
  if (error instanceof StructureError) {
    process.stdout.write(`${error.message}\n`);
    process.exit(2);
  }
  if (error instanceof CheckError) {
    process.stdout.write(`${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`${name}: ${error instanceof UsageError ? error.message : `予期しないエラー: ${error?.message}`}\n`);
  process.exit(3);
}

if (process.argv[1]?.endsWith("/summary-body.mjs")) {
  try {
    const out = run(process.argv.slice(2));
    if (out) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  } catch (error) {
    exitWith(error, "summary-body.mjs");
  }
}
