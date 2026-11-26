#!/usr/bin/env node
// 集約 Issue の本文の解析・検査・組み立てと、本文と詳細コメントの行き来をまとめる。
// security-audit-verify-items の verify.mjs も、ここにある関数とコマンドを使う。
// 本文が上限を超える集約 Issue は、本文に一覧表を、区分ごとの詳細（<details> の並び）をコメントに置く。
// 読むときは compose で 1 つの全文に戻し、書くときは split で本文とコメントに分ける。全文は分ける前の書式と同じなので、
// 番号・件数・項目の検査は全文に対して行える。
//   extract <Issue の JSON> <出力>                 `gh api repos/<owner>/<repo>/issues/<番号>` の出力から本文をそのまま書き出す（--jq は末尾に改行を足すため）
//   compose <本文> <コメントの JSON> <出力>        本文に、リンクした詳細コメントの中身を戻した全文を書き出す
//   split <全文> <出力フォルダ> [--body <今の本文> --comments <コメントの JSON>] [--max 60000]
//                                                 全文を本文と詳細コメントに分け、書き込みの計画（plan.json。create・same のあとに本文、retire の順に書く）を出す
//                                                 集約 Issue を新しく作るときは --body と --comments を省く
//   fill <本文> <出力> --url <区分>:<部>=<URL> ... [--max 60000]
//                                                 split が残した新しいコメントの URL の仮置きを埋める
//   items <全文>                                   項目ごとの区分・ID・全文と、番号を省いたときの対象を JSON で出す（調査開始時の控えに使う）
//   same <控えの JSON> <全文> <番号...>             項目の全文が控えと同じかを番号ごとに出す（違えば終了コード 1）
//   check-body <前の全文> <後の全文> --targets A03,U01 [--new A20,A21] [--remove A04] [--bump-revision <開始時の版>]
//                                                 対象の項目・件数・追記の行のほかが変わっていないかを確かめる（外れたら終了コード 1）
//                                                 --remove は統合して消す対象の番号（残す項目の詳細に「（統合: A04）」が要る）
//                                                 --bump-revision を付けたときだけ、版が <開始時の版> から +1 に変わることを許す
//   check <全文>                                   番号の一意、件数、一覧表と詳細の数・順、区分の並び順を確かめる（外れたら理由を 1 行ずつ出して終了コード 1）
//   assemble <前の全文> <計画の JSON> <出力> [--targets <番号> [--new <番号>]] [--bump-revision <開始時の版>]
//                                                 --targets を渡すと、計画の items・remove がその中に、new の番号が --new の中に収まることも確かめる（了承していない項目を書かないため）
//                                                 区分「削除」の下書きは、U の項目なら統合の記録なしで消す（調べ終えた範囲）。A の項目は remove と同じく統合の記録が要る
//                                                 前の全文に計画（項目の移動・追加・削除と下書き）を当てた全文を書く（検査に外れたら書かずに終了コード 1）
//   lock <実行フォルダ> <集約 Issue の URL>        集約 Issue への書き込みを 1 つの実行に限る（ほかの実行が持っていれば終了コード 1）
//   unlock <実行フォルダ> <集約 Issue の URL>      lock を外す
//                                                 lock は このリポジトリの artifacts/security-audit-sync-issues/.locks に置く（SECURITY_AUDIT_LOCK_DIR があればそこ）。鍵は集約 Issue の URL（host・owner・repo は小文字）
// コメントの JSON は `gh api --paginate --slurp "repos/<owner>/<repo>/issues/<番号>/comments?per_page=100"` の出力（配列の配列でもよい）。
// 計画の JSON は {"items": [{"number": "A03", "draft": "<下書き>"}], "new": [{"draft": "<下書き>"}], "remove": ["A04"],
//   "values": {"<キー>": "<値>"}, "note": "<追記の 1 行>"}（どれも省略できる）。下書きのパスは計画の JSON のあるフォルダからの相対パスか絶対パス。
// 下書きは 1 行目が「区分: <確定|要検証|未検証|棄却|未完了の工程・範囲|削除>」、空行、一覧表の 1 行、空行、<details> から </details> までの詳細。削除のときは表と詳細はなくてよい。
// 終了コード 1 は上限・計画・検査などに外れた（出力は理由）、2 は集約 Issue の構造の異常（出力は理由の語）、3 は引数の誤り。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_CHARS = 60000;
// 仮置きを埋めるコメントの URL の長さとして見込む文字数（https://github.com/<owner>/<repo>/issues/<番号>#issuecomment-<ID> に余裕を持たせる）
const URL_RESERVE = 200;
export const SECTIONS = ["確定", "要検証", "未検証", "棄却", "未完了の工程・範囲"];
// 人が書いた「詳細: 」で始まる文と見分けるため、リンクか仮置きで始まる行だけを詳細へのリンクとみなす
const LINK_LINE = /^詳細: \[[^\]]+\]\((https?:\/\/\S+#issuecomment-\d+|\{\{DETAILS_URL:[^}]+\}\})\)/;
const COMMENT_LINK = /\]\((https?:\/\/[^\s)]+#issuecomment-(\d+))\)/g;
const PLACEHOLDER = /\{\{DETAILS_URL:([^:}]+):(\d+)\}\}/g;
const NOTE = "一覧表と件数は集約 Issue の本文にある。項目を直すときは、このコメントの詳細と本文の一覧表をそろえて直す。";

// 区分の内部の名前（検査の理由に使う英語の名前）
const SECTION_KEY = { 確定: "confirmed", 要検証: "needs_validation", 未検証: "unverified", 棄却: "rejected", "未完了の工程・範囲": "incomplete" };
// 書けば必ずある区分（未完了の工程・範囲は、項目がなければ見出しもないことがある）
const REQUIRED = ["確定", "要検証", "未検証", "棄却"];
// 番号を省いたときに調べる区分（この順に並べる）
const DEFAULT_SECTIONS = ["要検証", "未検証", "未完了の工程・範囲"];
// 0 件だった区分に項目を入れるときの表の見出し行と区切り行（集約 Issue の書式どおり）
const TABLE_HEAD = {
  確定: ["| No. | 影響評価 | 題名 | 対応状況 |", "| --- | --- | --- | --- |"],
  要検証: ["| No. | 領域 | 題名 | 判定に必要な確認 |", "| --- | --- | --- | --- |"],
  未検証: ["| No. | 領域 | 題名 | 停止した工程 |", "| --- | --- | --- | --- |"],
  棄却: ["| No. | 領域 | 題名 |", "| --- | --- | --- |"],
  "未完了の工程・範囲": ["| No. | 範囲 | 停止した工程 | 再開に必要なもの |", "| --- | --- | --- | --- |"],
};
// 確定の並び順（影響評価の高い順）
// informational は書式の正式な値、info は短い書き方（同じ順位）
const IMPACT = ["critical", "high", "medium", "low", "informational"];
const KINDS = [...SECTIONS, "削除"];
const NUMBER = /^[AU]\d{2,}$/;
const ROW = /^\|\s*([AU]\d+)\s*\|/;
const HEAD_ROW = /^\|\s*(No\.|-{3,})/;
// 冒頭の追記の行（数字は伏せたあとの形）
// 追記の行。security-audit-verify-items は「手動」、security-audit-sync-issues の続きの監査は「続きの監査」と書く
const ADDED_NOTE = /^\*\*#-#-# 追記（(?:手動|続きの監査)）\*\*:/;
const REVISION_MARKER = /^<!-- security-audit:summary-revision=(\d+) -->$/;
// lock を持ったまま止まった実行があっても、この時間が過ぎたら引き継ぐ
const LOCK_STALE_MS = 30 * 60 * 1000;
// このファイルはリポジトリの .agents/skills/<skill>/scripts/ にあるので、実体のパスから 4 つ上がリポジトリのルート
const REPO_ROOT = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "../../../..");

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
export const lines = (text) => text.replace(/\r\n/g, "\n").split("\n");

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
// 計画は書く順に並ぶ: create（新しいコメント）→ 本文の書き換え → retire。リンク中のコメントは書き換えない。
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
  const retire = [];
  for (const s of [...sections].reverse()) {
    if (s.links.length) broken(`details_link_in_full:${s.name}`);
    const existing = curSections.get(s.name)?.links.length ? linksOf(cur[curSections.get(s.name).links[0]]) : [];
    const parts = s.first >= 0 ? chunk(summaryId, s.name, full.slice(s.first, s.last + 1), max) : [];
    const sectionFiles = [];
    const sectionPlan = [];
    const urls = parts.map((p, k) => {
      const text = commentText(summaryId, s.name, k + 1, parts.length, p);
      const old = existing[k];
      const was = old && comments.get(old.id);
      sectionFiles.push({ section: s.name, part: k + 1, text });
      if (old && was && was.body.replace(/\r\n/g, "\n") === text) {
        sectionPlan.push({ op: "same", section: s.name, part: k + 1, comment_id: old.id, url: old.url });
        return old.url;
      }
      // 中身の変わる部は、リンク中のコメントを書き換えずに新しく作る。本文を書き換えるまで、今の本文とコメントの組がそのまま読めるようにするため
      if (old) retire.push({ op: "retire", section: s.name, part: null, comment_id: old.id, url: old.url });
      sectionPlan.push({ op: "create", section: s.name, part: k + 1, comment_id: null, url: null });
      return `{{DETAILS_URL:${s.name}:${k + 1}}}`;
    });
    files.unshift(...sectionFiles);
    plan.unshift(...sectionPlan);
    // 使わなくなった詳細コメントは消さずに、使っていないことを書いて残す
    for (const old of existing.slice(parts.length)) retire.push({ op: "retire", section: s.name, part: null, comment_id: old.id, url: old.url });
    if (parts.length) {
      const label = (k) => (parts.length > 1 ? `${s.name}の詳細 ${k + 1}` : `${s.name}の詳細`);
      out.splice(s.first, s.last - s.first + 1, `詳細: ${urls.map((u, k) => `[${label(k)}](${u})`).join("・")}`);
    }
  }
  const body = out.join("\n");
  // 仮置きは fill で URL になるので、URL の長さの分を見込んで測る
  const reserved = chars(body.replace(PLACEHOLDER, "x".repeat(URL_RESERVE)));
  if (reserved > max) throw new CheckError(`too_long_body:${reserved}`);
  // 書く順は、新しいコメントを作る → 本文を書き換える → 使わなくなったコメントを retire する
  return { mode: "split", body, comments: files, plan: [...plan, ...retire.reverse()] };
}

export function retiredText(summaryId) {
  return [`<!-- security-audit:details-retired summary-id=${summaryId} -->`, "この詳細コメントは使っていない（集約 Issue の本文からリンクしていない）。"].join("\n");
}

export function fill(bodyText, urls, max = MAX_CHARS) {
  const filled = bodyText.replace(PLACEHOLDER, (m, section, part) => {
    const u = urls[`${section}:${part}`];
    if (!u) fail(`URL がない: ${section}:${part}`);
    if (!/^https?:\/\/\S+#issuecomment-\d+$/.test(u)) fail(`コメントの URL ではない: ${u}`);
    return u;
  });
  if (chars(filled) > max) throw new CheckError(`too_long_body:${chars(filled)}`);
  return filled;
}

export function readText(file) {
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

// 集約 Issue の全文の形（区画・区分・項目）を分ける。構造が書式どおりでなければ StructureError。件数・番号・並び順は見ない（validated と check が見る）
function scan(text) {
  const ls = lines(text);
  const begins = ls.flatMap((l, i) => (l.trim() === "<!-- security-audit:summary-begin -->" ? [i] : []));
  const ends = ls.flatMap((l, i) => (l.trim() === "<!-- security-audit:summary-end -->" ? [i] : []));
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) broken("summary_block");
  const [b, e] = [begins[0], ends[0]];
  const block = ls.slice(b + 1, e);
  const outside = [...ls.slice(0, b + 1), "\0", ...ls.slice(e)].join("\n");
  const auditMarkers = block.filter((l) => l.startsWith("<!-- security-audit:"));
  const ids = block.flatMap((l) => {
    const m = /^<!-- security-audit:summary-id=(.+) -->$/.exec(l.trim());
    return m ? [m[1]] : [];
  });
  if (ids.length !== 1) broken("summary_id");

  // segments は本文の行を並べたもの。区分の外の行（文字の塊）と、区分（見出し・表の見出し・行・詳細・そのほかの行）
  const segments = [];
  const sections = {};
  const items = new Map();
  // 冒頭は件数が変わるので数字を伏せる。区分の外の文章（区分の見出しと一覧表の行を除く）
  const rest = [];
  // 未完了の工程・範囲の見出しの下の状況の説明（U の項目を直すときは変わってよい）
  const incompleteNote = [];
  const textLine = (line) => {
    const last = segments.at(-1);
    if (last?.type === "text") last.lines.push(line);
    else segments.push({ type: "text", lines: [line] });
  };
  let seenHeading = false;
  let current = null;
  let openDetails = null;
  let detailsOpen = 0;
  let detailsClose = 0;
  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    if (line.startsWith("## ")) {
      if (openDetails) broken("details_unclosed");
      seenHeading = true;
      const m = /^## (.+?)（(.*)）\s*$/.exec(line);
      const name = m && Object.hasOwn(SECTION_KEY, m[1]) ? m[1] : null;
      if (name) {
        if (sections[name]) broken(`section_duplicate:${SECTION_KEY[name]}`);
        const count = /^(\d+)件$/.exec(m[2]);
        current = { type: "section", name, heading: line, count: count ? Number(count[1]) : null, rows: [], details: [], rowLines: [], detailLines: [], head: [], pre: [] };
        sections[name] = current;
        segments.push(current);
      } else {
        current = null;
        textLine(line);
        rest.push(line);
      }
      continue;
    }
    if (/^<details>/.test(line)) detailsOpen++;
    if (/<\/details>\s*$/.test(line)) detailsClose++;
    const row = current && !openDetails ? ROW.exec(line) : null;
    if (row) {
      current.rows.push(row[1]);
      current.rowLines.push({ num: row[1], line });
      itemOf(items, row[1]).rows.push({ section: current.name, line });
      continue;
    }
    const open = current && !openDetails ? /^<details><summary><b>([AU]\d+)<\/b>/.exec(line) : null;
    if (open) openDetails = { id: open[1], start: i };
    if (openDetails) {
      if (/<\/details>\s*$/.test(line)) {
        const detail = block.slice(openDetails.start, i + 1);
        current.details.push(openDetails.id);
        current.detailLines.push({ num: openDetails.id, lines: detail });
        itemOf(items, openDetails.id).details.push({ section: current.name, lines: detail });
        openDetails = null;
      }
      continue;
    }
    if (current) {
      // 区分の中の空行・0件・表の見出しは、区分の並べ直しで作り直す。そのほかの行は区分の前に残す
      if (line.trim() === "") continue;
      if (HEAD_ROW.test(line)) {
        current.head.push(line);
        continue;
      }
      if (line.trim() === "0件。") continue;
      current.pre.push(line);
      if (line.startsWith("<!-- security-audit:")) continue;
      if (current.name === "未完了の工程・範囲") incompleteNote.push(line);
      else rest.push(line);
      continue;
    }
    if (line.trim() === "" || line.startsWith("<!-- security-audit:")) {
      textLine(line);
      continue;
    }
    textLine(line);
    if (!seenHeading) {
      // 結論の行は件数と Issue 反映の状況をまとめた行で、書くたびに変わってよい（中身は assemble と書き手が決める）
      rest.push(line.startsWith("**結論**:") ? "**結論**:" : line.replace(/\d+/g, "#"));
      continue;
    }
    if (line.trim() === "0件。" || HEAD_ROW.test(line)) continue;
    rest.push(line);
  }
  if (openDetails) broken("details_unclosed");
  if (detailsOpen !== detailsClose) broken("details_count");
  return { lines: ls, begin: b, end: e, outside, auditMarkers, rest, incompleteNote, sections, items, segments };
}

// 区分の見出し・項目の対応を確かめて、解析の結果にする（構造の異常は StructureError。語は今までどおり）
function validated(p) {
  for (const name of REQUIRED) if (!p.sections[name]) broken(`section_missing:${SECTION_KEY[name]}`);
  for (const [name, s] of Object.entries(p.sections)) {
    if (s.rows.length !== s.details.length) broken(`count_mismatch:${SECTION_KEY[name]}`);
    if (s.count !== null && s.count !== s.rows.length) broken(`count_mismatch:${SECTION_KEY[name]}`);
  }
  for (const [num, it] of p.items) {
    if (it.rows.length !== 1 || it.details.length !== 1) broken(`item_duplicate_or_missing:${num}`);
    if (it.rows[0].section !== it.details[0].section) broken(`item_section_mismatch:${num}`);
    it.section = it.rows[0].section;
    it.text = [it.rows[0].line, ...it.details[0].lines].join("\n");
    const idLine = it.details[0].lines.find((l) => /^- \*\*ID\*\*:/.test(l));
    const m = idLine ? /`([^`]+)`/.exec(idLine) : null;
    it.id = m ? m[1] : null;
  }
  return p;
}

function itemOf(items, num) {
  if (!items.has(num)) items.set(num, { rows: [], details: [] });
  return items.get(num);
}

function numberOf(num) {
  return Number(num.slice(1));
}

// 番号の大小（数値で比べる。同じ数字なら文字）
function compareNumbers(a, b) {
  return numberOf(a) - numberOf(b) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

// 一覧表の行を「｜」で割った列（先頭の番号は 0 番目、2 列目は 1 番目）
const cellsOf = (line) => line.split("|").slice(1, -1).map((c) => c.trim());

const impactRank = (line) => {
  const v = (cellsOf(line)[1] ?? "").toLowerCase();
  const i = IMPACT.indexOf(v === "info" ? "informational" : v);
  return i < 0 ? IMPACT.length : i;
};

// 区分の並び順の決まり。確定は影響評価の高い順、ほかは領域ごとに（領域どうしは最小の番号の順）、未完了の工程・範囲は今の順
function ordered(name, list) {
  if (name === "未完了の工程・範囲") return list;
  if (name === "確定") return [...list].sort((a, b) => impactRank(a.line) - impactRank(b.line) || compareNumbers(a.num, b.num));
  const groups = new Map();
  for (const e of list) {
    const region = cellsOf(e.line)[1] ?? "";
    groups.set(region, [...(groups.get(region) ?? []), e]);
  }
  return [...groups.values()]
    .map((g) => [...g].sort((a, b) => compareNumbers(a.num, b.num)))
    .sort((a, b) => compareNumbers(a[0].num, b[0].num))
    .flat();
}

export function parse(text) {
  return validated(scan(text));
}

export function items(text) {
  const p = parse(text);
  const out = { default_targets: DEFAULT_SECTIONS.flatMap((name) => p.sections[name]?.rows ?? []), items: {} };
  for (const [num, it] of p.items) out.items[num] = { section: it.section, id: it.id, text: it.text };
  return out;
}

export function same(start, text, nums) {
  const p = parse(text);
  return nums.map((num) => {
    const was = start.items?.[num];
    const now = p.items.get(num);
    if (!was || !now) return [num, "missing"];
    return [num, was.section === now.section && was.text === now.text ? "same" : "changed"];
  });
}

// 監査用マーカーの並びが変わっていないか。bump があるときだけ、版の行が bump から bump+1 に変わることを許す
function markersSame(before, after, bump) {
  if (before.length !== after.length) return false;
  return before.every((b, i) => {
    const a = after[i];
    if (b === a) return true;
    const rb = REVISION_MARKER.exec(b.trim());
    const ra = REVISION_MARKER.exec(a.trim());
    return bump !== null && rb !== null && ra !== null && Number(rb[1]) === bump && Number(ra[1]) === bump + 1;
  });
}

// 書く前の確認。対象の項目・件数・追記の行のほかが変わっていないこと。bump は開始時の版（指定したときだけ版の +1 を許す）
export function checkBody(beforeText, afterText, targets, added = [], removed = [], bump = null) {
  const reasons = [];
  let before;
  let after;
  try {
    before = parse(beforeText);
  } catch (error) {
    if (error instanceof StructureError) return [`before:${error.message}`];
    throw error;
  }
  try {
    after = parse(afterText);
  } catch (error) {
    if (error instanceof StructureError) return [`after:${error.message}`];
    throw error;
  }
  if (before.outside !== after.outside) reasons.push("outside_changed");
  if (!markersSame(before.auditMarkers, after.auditMarkers, bump)) reasons.push("audit_marker_changed");
  // 追記の行は足すだけにする（前からある行は残す）
  const kept = [...before.rest];
  const rest = after.rest.filter((l) => {
    const at = kept.indexOf(l);
    if (at >= 0) {
      kept.splice(at, 1);
      return true;
    }
    return !ADDED_NOTE.test(l);
  });
  if (kept.length || rest.join("\n") !== before.rest.join("\n")) reasons.push("other_text_changed");
  if (!targets.some((n) => n.startsWith("U")) && before.incompleteNote.join("\n") !== after.incompleteNote.join("\n")) reasons.push("other_text_changed");
  if (/\{\{[A-Z_]+:[^}]*\}\}/.test(afterText)) reasons.push("placeholder_left");
  for (const num of targets) {
    if (!before.items.has(num)) reasons.push(`target_not_in_before:${num}`);
    // 未完了の工程・範囲の項目と、統合して消す項目は、ユーザーと決めて消すことがある
    if (num.startsWith("A") && !removed.includes(num) && !after.items.has(num)) reasons.push(`target_not_in_after:${num}`);
  }
  for (const num of removed) {
    if (!targets.includes(num)) reasons.push(`remove_not_target:${num}`);
    else if (after.items.has(num)) reasons.push(`remove_still_present:${num}`);
    else if (![...after.items.values()].some((it) => it.text.includes(`（統合: ${num}）`))) reasons.push(`remove_without_merge_note:${num}`);
  }
  for (const [num, it] of before.items) {
    if (targets.includes(num)) continue;
    const a = after.items.get(num);
    if (!a) reasons.push(`item_removed:${num}`);
    else if (a.section !== it.section || a.text !== it.text) reasons.push(`item_changed:${num}`);
  }
  const maxA = Math.max(0, ...[...before.items.keys()].filter((n) => n.startsWith("A")).map(numberOf));
  for (const num of added) {
    if (!num.startsWith("A")) reasons.push(`new_not_a:${num}`);
    else if (before.items.has(num) || numberOf(num) <= maxA) reasons.push(`new_number_used:${num}`);
    if (!after.items.has(num)) reasons.push(`new_not_in_after:${num}`);
  }
  for (const num of after.items.keys()) if (!before.items.has(num) && !added.includes(num)) reasons.push(`item_added:${num}`);
  return reasons;
}

// 全文の検査。番号の一意、区分の件数（見出し・表の行・詳細）、一覧表と詳細の順、区分の並び順を見る。外れた理由の語を返す
export function check(text) {
  const p = scan(text);
  for (const name of REQUIRED) if (!p.sections[name]) broken(`section_missing:${SECTION_KEY[name]}`);
  const reasons = [];
  for (const [num, it] of p.items) if (it.rows.length > 1 || it.details.length > 1) reasons.push(`duplicate_number:${num}`);
  for (const name of SECTIONS) {
    const s = p.sections[name];
    if (!s) continue;
    if (s.count !== null && s.count !== s.rows.length) reasons.push(`count_mismatch:${name}`);
    if (s.rows.length !== s.details.length) reasons.push(`count_mismatch:${name}`);
    const want = ordered(name, s.rowLines).map((r) => r.num);
    if (!sameList(want, s.rows)) reasons.push(`order:${name}`);
    if (s.rows.length === s.details.length && !sameList(s.rows, s.details)) reasons.push(`details_order:${name}`);
  }
  return [...new Set(reasons)];
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// 下書きの 1 行目の区分・一覧表の 1 行・詳細を読む。書式に合わなければ CheckError（draft_kind・draft_format）
function draftOf(file, text) {
  const ls = lines(text);
  const kind = /^区分: (.+?)\s*$/.exec(ls[0] ?? "")?.[1];
  if (!KINDS.includes(kind)) throw new CheckError(`draft_kind:${file}`);
  if (kind === "削除") return { kind, num: null, line: null, details: [] };
  const body = trimBlank(ls.slice(1));
  const line = body[0] ?? "";
  const num = ROW.exec(line)?.[1];
  const details = trimBlank(body.slice(1));
  const detailNum = /^<details><summary><b>([AU]\d+)<\/b>/.exec(details[0] ?? "")?.[1];
  const closes = details.filter((l) => /<\/details>\s*$/.test(l));
  if (!num || detailNum !== num || closes.length !== 1 || !/<\/details>\s*$/.test(details.at(-1) ?? "")) throw new CheckError(`draft_format:${file}`);
  return { kind, num, line, details };
}

const trimBlank = (ls) => {
  let s = 0;
  let e = ls.length;
  while (s < e && ls[s].trim() === "") s++;
  while (e > s && ls[e - 1].trim() === "") e--;
  return ls.slice(s, e);
};

// 下書きの {{キー}} を値に置き換える
const applyValues = (text, values) => Object.entries(values).reduce((t, [k, v]) => t.split(`{{${k}}}`).join(v), text);

// 計画の JSON の形を確かめる（形が違えば引数の誤り）
function planOf(value) {
  const bad = () => fail("計画の JSON の形が違います（items・new・remove・values・note を指定できます）");
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad();
  const planItems = value.items ?? [];
  const added = value.new ?? [];
  const remove = value.remove ?? [];
  const values = value.values ?? {};
  if (!Array.isArray(planItems) || !Array.isArray(added) || !Array.isArray(remove) || typeof values !== "object" || Array.isArray(values)) bad();
  for (const it of planItems) if (!it || typeof it.number !== "string" || !NUMBER.test(it.number) || typeof it.draft !== "string") bad();
  for (const n of added) if (!n || typeof n.draft !== "string") bad();
  for (const n of remove) if (typeof n !== "string" || !NUMBER.test(n)) bad();
  for (const v of Object.values(values)) if (typeof v !== "string") bad();
  if (value.note !== undefined && (typeof value.note !== "string" || /[\r\n]/.test(value.note))) bad();
  const nums = [...planItems.map((it) => it.number), ...remove];
  if (new Set(nums).size !== nums.length) fail("items と remove に同じ番号があります");
  return { items: planItems, added, remove, values, note: value.note ?? "" };
}

// 区分の見出しの件数だけを書き換える（見出しの件数の形でなければそのまま）
const withCount = (heading, n) => heading.replace(/(\d+)件）(\s*)$/, `${n}件）$2`);

// 区分の全体。項目がなければ 0件。だけ（説明も外す）、あれば表と詳細。見出しと表の間の説明（未完了の工程・範囲など）は残す
function sectionLines(name, heading, pre, head, list) {
  const out = [withCount(heading, list.length), ""];
  if (list.length === 0) return [...out, "0件。", ""];
  const note = trimBlank(pre);
  if (note.length) out.push(...note, "");
  out.push(...(head.length ? head : TABLE_HEAD[name]), ...list.map((e) => e.line), "");
  for (const e of list) out.push(...e.details, "");
  return out;
}

// 結論の行の件数を書き換える。件数の書き方がない区分の名前を返す
function conclusionOf(line, counts) {
  let out = line;
  const missing = [];
  for (const name of SECTIONS) {
    const re = new RegExp(`(^|[^\\p{L}])(${name} ?)\\d+件`, "u");
    if (!re.test(out)) {
      missing.push(name);
      continue;
    }
    out = out.replace(re, (m, pre, label) => `${pre}${label}${counts[name]}件`);
  }
  return { line: out, missing };
}

// 前の全文に計画を当てた全文を作り、検査してから返す（検査に外れたら CheckError。書く前に止める）
// approved は了承した番号（{ targets: 書き換える番号, added: 新しく足す番号 }）。null なら照合しない
export function assemble(beforeText, plan, baseDir, bump = null, approved = null) {
  const p = validated(scan(beforeText));
  const spec = planOf(plan);
  if (approved) {
    const outside = [...spec.items.map((it) => it.number), ...spec.remove].filter((n) => !approved.targets.includes(n));
    if (outside.length) throw new CheckError(outside.map((n) => `not_approved:${n}`).join("\n"));
  }
  const draftAt = (file) => draftOf(file, applyValues(readText(path.resolve(baseDir, file)), spec.values));
  // 前の全文の項目（区分・一覧表の行・詳細）
  const entries = new Map();
  for (const name of SECTIONS) {
    const s = p.sections[name];
    if (!s) continue;
    for (const r of s.rowLines) entries.set(r.num, { num: r.num, section: name, line: r.line, details: s.detailLines.find((d) => d.num === r.num).lines });
  }
  const targets = [];
  const removed = new Set();
  const gone = new Set();
  const moved = [];
  for (const it of spec.items) {
    targets.push(it.number);
    const d = draftAt(it.draft);
    if (d.kind === "削除") {
      // 調べ終えた未完了の工程・範囲（U）は統合先がないので、統合の記録を求めない
      gone.add(it.number);
      if (!it.number.startsWith("U")) removed.add(it.number);
      continue;
    }
    if (d.num !== it.number) throw new CheckError(`draft_number:${it.number}`);
    const orig = entries.get(it.number);
    // 同じ区分の項目は、その場で書き換える（未完了の工程・範囲は順を保つため）
    if (orig?.section === d.kind) {
      orig.line = d.line;
      orig.details = d.details;
      continue;
    }
    if (orig) gone.add(it.number);
    moved.push({ num: d.num, section: d.kind, line: d.line, details: d.details });
  }
  for (const n of spec.remove) {
    targets.push(n);
    removed.add(n);
    gone.add(n);
  }
  const added = [];
  for (const n of spec.added) {
    const d = draftAt(n.draft);
    if (d.kind === "削除") throw new CheckError(`draft_format:${n.draft}`);
    if (approved && !approved.added.includes(d.num)) throw new CheckError(`not_approved:${d.num}`);
    added.push(d.num);
    moved.push({ num: d.num, section: d.kind, line: d.line, details: d.details });
  }
  // 区分ごとの並び。前からの項目は残し、入ってくる項目は後ろに足してから並べ直す
  const lists = new Map(SECTIONS.map((name) => [name, []]));
  for (const e of entries.values()) if (!gone.has(e.num)) lists.get(e.section).push(e);
  for (const e of moved) lists.get(e.section).push(e);
  for (const name of SECTIONS) lists.set(name, ordered(name, lists.get(name)));
  // 区画の中の行を前の並びのまま作り直す（区分は並べ直し、区分以外の行と見出しの間の説明は残す）
  const out = [];
  let end = -1;
  const seen = new Set();
  for (const seg of p.segments) {
    if (seg.type === "text") {
      out.push(...seg.lines);
      continue;
    }
    seen.add(seg.name);
    out.push(...sectionLines(seg.name, seg.heading, seg.pre, seg.head, lists.get(seg.name)));
    end = out.length;
  }
  // 前の全文になかった区分に項目が入るときは、最後の区分の後ろに作る
  let at = end < 0 ? out.length : end;
  for (const name of SECTIONS) {
    if (seen.has(name) || lists.get(name).length === 0) continue;
    const created = sectionLines(name, `## ${name}（0件）`, [], [], lists.get(name));
    out.splice(at, 0, ...created);
    at += created.length;
  }
  const counts = Object.fromEntries(SECTIONS.map((name) => [name, lists.get(name).length]));
  // 冒頭の結論の行の件数、追記の行は結論のあと（なければ冒頭の最後の空でない行のあと）
  const firstHeading = out.findIndex((l) => l.startsWith("## "));
  const head = firstHeading < 0 ? out.length : firstHeading;
  const conclusion = out.slice(0, head).findIndex((l) => l.startsWith("**結論**:"));
  let insertAt = head;
  while (insertAt > 0 && out[insertAt - 1].trim() === "") insertAt--;
  if (conclusion >= 0) {
    const result = conclusionOf(out[conclusion], counts);
    if (result.missing.length) throw new CheckError(result.missing.map((n) => `conclusion_count_missing:${n}`).join("\n"));
    out[conclusion] = result.line;
    insertAt = conclusion + 1;
  }
  const note = applyValues(spec.note, spec.values);
  if (note) out.splice(insertAt, 0, note);
  // 版を上げるときは、開始時の版の行を +1 にする（今の版が開始時と違えば、ほかの実行が書いたので止める）
  if (bump !== null) {
    const at = out.findIndex((l) => REVISION_MARKER.test(l.trim()) && Number(REVISION_MARKER.exec(l.trim())[1]) === bump);
    if (at < 0) throw new CheckError("revision_changed");
    out[at] = out[at].replace(/=\d+ -->/, `=${bump + 1} -->`);
  }
  const full = [...p.lines.slice(0, p.begin + 1), ...out, ...p.lines.slice(p.end)].join("\n");
  const left = [...new Set([...full.matchAll(/\{\{([A-Z_]+:[^}]*)\}\}/g)].map((m) => m[1]))];
  if (left.length) throw new CheckError(left.map((k) => `placeholder_left:${k}`).join("\n"));
  const reasons = checkBody(beforeText, full, targets, added, [...removed], bump);
  if (reasons.length) throw new CheckError(reasons.join("\n"));
  const order = check(full);
  if (order.length) throw new CheckError(order.join("\n"));
  return { text: full, counts, conclusion: conclusion >= 0 };
}

// lock の置き場所。SECURITY_AUDIT_LOCK_DIR があればそこ（テスト用）、なければこのリポジトリの artifacts/security-audit-sync-issues/.locks（両スキルが同じ場所を使う）
export function lockRoot() {
  return process.env.SECURITY_AUDIT_LOCK_DIR || path.join(REPO_ROOT, "artifacts", "security-audit-sync-issues", ".locks");
}

function lockDir(run, url) {
  let real;
  try {
    real = fs.realpathSync(run);
  } catch {
    fail(`実行フォルダがありません: ${run}`);
  }
  // security-audit-verify-items の実行フォルダ（repo がある）か、security-audit-sync-issues の実行フォルダ（run-metadata.json がある）
  if (!fs.existsSync(path.join(real, "repo")) && !fs.existsSync(path.join(real, "run-metadata.json"))) fail(`このスキル集の実行フォルダではありません: ${run}`);
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(url);
  if (!m) fail(`集約 Issue の URL を https://<host>/<owner>/<repo>/issues/<番号> の形で指定してください: ${url}`);
  // GitHub のホスト・owner・リポジトリ名は大文字と小文字を区別しないので、そろえてから鍵にする
  return { run: real, dir: path.join(lockRoot(), m.slice(1).join("_").toLowerCase()) };
}

function readOwner(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

// owner.json は一時ファイルに書いてから置き換え、書きかけを読まないようにする
function writeOwner(dir, real, now) {
  const tmp = path.join(dir, `.owner-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(tmp, `${JSON.stringify({ run: real, at: new Date(now).toISOString() })}\n`);
  fs.renameSync(tmp, path.join(dir, "owner.json"));
}

// 持ち主の実行は、書き込みの区切りごとに lock を呼び直して時刻を更新する（30 分止まった lock だけが引き継がれる）
export function lock(run, url, now = Date.now(), retried = false) {
  const { run: real, dir } = lockDir(run, url);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (createLock(dir, real, now)) return "ok";
  const owner = readOwner(dir);
  if (owner?.run === real) {
    writeOwner(dir, real, now);
    return "ok";
  }
  let since;
  try {
    since = lockTime(dir, owner);
  } catch (error) {
    // 消えた直後なら取り直す（続けて消えるときは、ほかの実行が取り合っているので待つ）
    if (error.code === "ENOENT") return retried ? locked(owner) : lock(run, url, now, true);
    throw error;
  }
  if (now - since <= LOCK_STALE_MS) return locked(owner);
  // 古い lock は名前を変えてから取り直す。名前の変更は 1 つの実行だけが成功する
  const stale = `${dir}.stale-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.renameSync(dir, stale);
  } catch (error) {
    // 消えた直後なら取り直す（続けて消えるときは、ほかの実行が取り合っているので待つ）
    if (error.code === "ENOENT") return retried ? locked(owner) : lock(run, url, now, true);
    throw error;
  }
  // 古いと判断してから名前を変えるまでに、別の実行が引き継いで新しい lock を作っていることがある。
  // 名前を変えた lock を見直し、古くなければ元に戻して、持ち主がいるものとして扱う
  const moved = readOwner(stale);
  if (now - lockTime(stale, moved) <= LOCK_STALE_MS) {
    try {
      fs.renameSync(stale, dir);
    } catch {
      // 戻せなければ（さらに別の実行が lock を作った）、その持ち主は次の lock の呼び直しで止まる
      fs.rmSync(stale, { recursive: true, force: true });
    }
    return locked(moved);
  }
  fs.rmSync(stale, { recursive: true, force: true });
  if (!createLock(dir, real, now)) return locked(readOwner(dir));
  return `ok taken_over:${moved?.run ?? "unknown"}`;
}

// lock は一時フォルダに owner.json を置いてから名前を変えて置く（持ち主の書かれていない lock を作らないため）。
// 名前の変更は、owner.json のある lock がすでにあれば失敗する
function createLock(dir, real, now) {
  const tmp = `${dir}.new-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.mkdirSync(tmp);
  try {
    writeOwner(tmp, real, now);
    fs.renameSync(tmp, dir);
    return true;
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (error.code === "ENOTEMPTY" || error.code === "EEXIST") return false;
    throw error;
  }
}

// lock を最後に更新した時刻。owner.json が読めない（壊れている）ときはフォルダの時刻で見る
function lockTime(dir, owner) {
  const at = Date.parse(owner?.at ?? "");
  return Number.isNaN(at) ? fs.statSync(dir).mtimeMs : at;
}

function locked(owner) {
  process.exitCode = 1;
  return `locked ${owner?.run ?? "unknown"} ${owner?.at ?? ""}`.trim();
}

export function unlock(run, url) {
  const { run: real, dir } = lockDir(run, url);
  if (!fs.existsSync(dir)) return "ok not_locked";
  const owner = readOwner(dir);
  if (owner?.run !== real) return locked(owner);
  fs.rmSync(dir, { recursive: true, force: true });
  return "ok";
}

// 番号の並び。A03,A04 / "A03 A04" / 複数の引数（配列）のどれでもよい
function numbersOf(values) {
  if (values === undefined) return [];
  const out = [];
  for (const v of [values].flat()) {
    for (const n of String(v).split(/[\s,]+/).filter(Boolean)) {
      if (!NUMBER.test(n)) fail(`番号は A03・U01 の形で指定してください: ${n}`);
      out.push(n);
    }
  }
  return [...new Set(out)];
}

// 番号の並びとして読める引数か（--targets A03 A04 の続きの引数を値に取るため）
const isNumberToken = (t) => !t.startsWith("--") && t.trim() !== "" && t.split(/[\s,]+/).filter(Boolean).every((n) => NUMBER.test(n));

// オプションを読む。multi は何度でも書ける値、numbers は続く番号の引数も値に取る（配列になる）
function options(args, names, multi = [], numbers = []) {
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
    if (numbers.includes(name)) {
      const values = (out[name] ??= []);
      values.push(args[++i]);
      while (i + 1 < args.length && isNumberToken(args[i + 1])) values.push(args[++i]);
    } else if (multi.includes(name)) (out[name] ??= []).push(args[++i]);
    else out[name] = args[++i];
  }
  return out;
}

function maxOf(value) {
  if (value === undefined) return MAX_CHARS;
  const max = Number(value);
  if (!Number.isInteger(max) || max <= 0) fail("--max は正の整数で指定してください");
  return max;
}

// 版（1 から始まる整数）。指定がなければ null
function bumpOf(o) {
  if (o["bump-revision"] === undefined) return null;
  if (!/^[1-9]\d*$/.test(o["bump-revision"])) fail("--bump-revision は 1 以上の整数で指定してください");
  return Number(o["bump-revision"]);
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
    if (o._.length !== 2 || (o.body === undefined) !== (o.comments === undefined)) fail("使い方: split <全文> <出力フォルダ> [--body <今の本文> --comments <コメントの JSON>] [--max 60000]");
    const fullText = readText(o._[0]);
    // 新しく作るとき（--body・--comments を省いたとき）は、今の本文を全文、コメントをなしとして分ける
    const r = o.body !== undefined ? split(fullText, readText(o.body), readJson(o.comments), maxOf(o.max)) : split(fullText, fullText, [], maxOf(o.max));
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
    const o = options(args, ["max"], ["url"]);
    if (o._.length !== 2) fail("使い方: fill <本文> <出力> --url <区分>:<部>=<URL> ... [--max 60000]");
    const urls = {};
    for (const u of o.url ?? []) {
      const m = /^(.+:\d+)=(.+)$/.exec(u);
      if (!m) fail(`--url は <区分>:<部>=<URL> の形で指定してください: ${u}`);
      urls[m[1]] = m[2];
    }
    fs.writeFileSync(o._[1], fill(readText(o._[0]), urls, maxOf(o.max)));
    return "ok";
  },
  items: (args) => {
    if (!args[0]) fail(`使い方: items <本文のファイル>`);
    return JSON.stringify(items(readText(args[0])), null, 2);
  },
  same: (args) => {
    if (args.length < 3) fail(`使い方: same <控えの JSON> <本文のファイル> <番号...>`);
    let start;
    try {
      start = JSON.parse(readText(args[0]));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      fail("控えが JSON ではありません");
    }
    const result = same(start, readText(args[1]), numbersOf(args.slice(2)));
    if (result.some(([, s]) => s !== "same")) process.exitCode = 1;
    return result.map(([n, s]) => `${n} ${s}`).join("\n");
  },
  "check-body": (args) => {
    const o = options(args, ["targets", "new", "remove", "bump-revision"], [], ["targets", "new", "remove"]);
    const targets = numbersOf(o.targets);
    if (o._.length !== 2 || targets.length === 0) fail(`使い方: check-body <前の本文> <後の本文> --targets A03,U01 [--new A20] [--remove A04] [--bump-revision <開始時の版>]`);
    const reasons = checkBody(readText(o._[0]), readText(o._[1]), targets, numbersOf(o.new), numbersOf(o.remove), bumpOf(o));
    if (reasons.length) process.exitCode = 1;
    return reasons.length ? reasons.join("\n") : "ok";
  },
  check: (args) => {
    if (args.length !== 1) fail(`使い方: check <全文のファイル>`);
    const reasons = check(readText(args[0]));
    if (reasons.length) throw new CheckError(reasons.join("\n"));
    return "ok";
  },
  assemble: (args) => {
    const o = options(args, ["targets", "new", "bump-revision"], [], ["targets", "new"]);
    if (o._.length !== 3 || (o.new !== undefined && o.targets === undefined)) fail(`使い方: assemble <前の全文> <計画の JSON> <出力> [--targets <番号> [--new <番号>]] [--bump-revision <開始時の版>]`);
    const approved = o.targets === undefined ? null : { targets: numbersOf(o.targets), added: numbersOf(o.new) };
    if (approved && approved.targets.length === 0) fail("--targets に番号を 1 つ以上指定してください（check-body と同じ）");
    const r = assemble(readText(o._[0]), readJson(o._[1]), path.dirname(path.resolve(o._[1])), bumpOf(o), approved);
    fs.writeFileSync(o._[2], r.text);
    if (r.conclusion) return "ok";
    return `counts ${Object.entries(r.counts).map(([name, n]) => `${name}=${n}`).join(" ")}`;
  },
  lock: (args) => {
    if (args.length !== 2) fail(`使い方: lock <実行フォルダ> <集約 Issue の URL>`);
    return lock(args[0], args[1]);
  },
  unlock: (args) => {
    if (args.length !== 2) fail(`使い方: unlock <実行フォルダ> <集約 Issue の URL>`);
    return unlock(args[0], args[1]);
  },
};

function run(argv) {
  const [cmd, ...args] = argv;
  const fn = COMMANDS[cmd];
  if (!fn) fail(`使い方: summary-body.mjs <${Object.keys(COMMANDS).join("|")}> [...]`);
  return fn(args);
}

function exitWith(error) {
  if (error instanceof StructureError) {
    process.stdout.write(`${error.message}\n`);
    process.exit(2);
  }
  if (error instanceof CheckError) {
    process.stdout.write(`${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`summary-body.mjs: ${error instanceof UsageError ? error.message : `予期しないエラー: ${error?.message}`}\n`);
  process.exit(3);
}

if (process.argv[1]?.endsWith("/summary-body.mjs")) {
  try {
    const out = run(process.argv.slice(2));
    if (out) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  } catch (error) {
    exitWith(error);
  }
}
