#!/usr/bin/env node
// security-audit-verify-items の定型の検査。親（このスキルを呼んだメインのセッション）が GitHub に書く前に使う。
//   pick                                  標準入力の gh issue list の JSON から、最新の集約 Issue の番号を出す
//   items <本文>                           項目ごとの区分・ID・全文と、番号を省いたときの対象を JSON で出す（調査開始時の控えに使う）
//   same <控えの JSON> <本文> <番号...>      項目の全文が控えと同じかを番号ごとに出す（違えば終了コード 1）
//   check-body <前の全文> <後の全文> --targets A03,U01 [--new A20,A21] [--remove A04]
//                                         対象の項目・件数・追記の行のほかが変わっていないかを確かめる（外れたら終了コード 1）
//                                         文字数の上限は、本文とコメントに分ける split で確かめる
//                                         --remove は統合して消す対象の番号（残す項目の詳細に「（統合: A04）」が要る）
//   check-issue <下書き> --fingerprint <ID> --sha <SHA> --worktree <作業ツリー>
//                                         修正 Issue の下書きのタイトル・マーカー・コードのリンク・秘密らしい文字列を確かめる（外れたら終了コード 1）
//   check-secrets <ファイル> --worktree <作業ツリー>
//                                         作業ツリーの .env* の値やトークンらしい文字列、置き換え忘れの {{...}} がないかを確かめる（外れたら終了コード 1）
//   extract / compose / split / fill       集約 Issue の本文と区分ごとの詳細コメントを行き来する（security-audit-sync-issues の
//                                         scripts/summary-body.mjs と同じ。使い方はそちらの冒頭）。ほかの検査は compose した全文に対して行う
//   lock <実行フォルダ> <集約 Issue の URL>   集約 Issue への書き込みを 1 つの実行に限る（ほかの実行が持っていれば終了コード 1）
//   unlock <実行フォルダ> <集約 Issue の URL> lock を外す
// 終了コード 2 は集約 Issue の構造の異常（出力は理由の語）、3 は引数の誤り。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { COMMANDS as SUMMARY_COMMANDS, CheckError, StructureError, UsageError, lines, readText } from "../../../../.agents/skills/security-audit-sync-issues/scripts/summary-body.mjs";

// lock を持ったまま止まった実行があっても、この時間が過ぎたら引き継ぐ
const LOCK_STALE_MS = 30 * 60 * 1000;
const SECTIONS = { 確定: "confirmed", 要検証: "needs_validation", 未検証: "unverified", 棄却: "rejected", "未完了の工程・範囲": "incomplete" };
const REQUIRED = ["確定", "要検証", "未検証", "棄却"];
// 番号を省いたときに調べる区分（この順に並べる）
const DEFAULT_SECTIONS = ["要検証", "未検証", "未完了の工程・範囲"];
const TITLE = /^\[(\d{4}-\d{2}-\d{2})\] セキュリティ監査の調査・判定一覧$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const NUMBER = /^[AU]\d{2,}$/;
// 冒頭の追記の行（数字は伏せたあとの形）
const NOTE = /^\*\*#-#-# 追記（手動）\*\*:/;
const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[abposr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function fail(message) {
  throw new UsageError(message);
}

function broken(reason) {
  throw new StructureError(reason);
}

// 集約 Issue の本文を、区画の外・区画のマーカー・項目でない行・区分・項目（一覧表の行と詳細）に分ける。
export function parse(text) {
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

  const sections = {};
  const items = new Map();
  // 区画の中で、区分の見出しと項目の行・詳細のほかの行（冒頭は件数が変わるので数字を伏せる）
  const rest = [];
  // 未完了の工程・範囲の見出しの下の状況の説明（U の項目を直すときは変わってよい）
  const incompleteNote = [];
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
      const name = m && Object.hasOwn(SECTIONS, m[1]) ? m[1] : null;
      if (name) {
        if (sections[name]) broken(`section_duplicate:${SECTIONS[name]}`);
        const count = /^(\d+)件$/.exec(m[2]);
        sections[name] = { count: count ? Number(count[1]) : null, rows: [], details: [] };
        current = name;
      } else {
        current = null;
        rest.push(line);
      }
      continue;
    }
    if (/^<details>/.test(line)) detailsOpen++;
    if (/<\/details>\s*$/.test(line)) detailsClose++;
    const row = current && !openDetails ? /^\|\s*([AU]\d+)\s*\|/.exec(line) : null;
    if (row) {
      sections[current].rows.push(row[1]);
      itemOf(items, row[1]).rows.push({ section: current, line });
      continue;
    }
    const open = current && !openDetails ? /^<details><summary><b>([AU]\d+)<\/b>/.exec(line) : null;
    if (open) openDetails = { id: open[1], start: i };
    if (openDetails) {
      if (/<\/details>\s*$/.test(line)) {
        sections[current].details.push(openDetails.id);
        itemOf(items, openDetails.id).details.push({ section: current, lines: block.slice(openDetails.start, i + 1) });
        openDetails = null;
      }
      continue;
    }
    if (line.trim() === "" || line.startsWith("<!-- security-audit:")) continue;
    if (!seenHeading) {
      rest.push(line.replace(/\d+/g, "#"));
      continue;
    }
    // 区分が空になる・空でなくなるときに増減する行（「0件。」・一覧表の見出しと区切り）は比べない
    if (line.trim() === "0件。" || /^\|\s*(No\.|-{3,})/.test(line)) continue;
    if (current === "未完了の工程・範囲") incompleteNote.push(line);
    else rest.push(line);
  }
  if (openDetails) broken("details_unclosed");
  if (detailsOpen !== detailsClose) broken("details_count");
  for (const name of REQUIRED) if (!sections[name]) broken(`section_missing:${SECTIONS[name]}`);
  for (const [name, s] of Object.entries(sections)) {
    if (s.rows.length !== s.details.length) broken(`count_mismatch:${SECTIONS[name]}`);
    if (s.count !== null && s.count !== s.rows.length) broken(`count_mismatch:${SECTIONS[name]}`);
  }
  for (const [num, it] of items) {
    if (it.rows.length !== 1 || it.details.length !== 1) broken(`item_duplicate_or_missing:${num}`);
    if (it.rows[0].section !== it.details[0].section) broken(`item_section_mismatch:${num}`);
    it.section = it.rows[0].section;
    it.text = [it.rows[0].line, ...it.details[0].lines].join("\n");
    const idLine = it.details[0].lines.find((l) => /^- \*\*ID\*\*:/.test(l));
    const m = idLine ? /`([^`]+)`/.exec(idLine) : null;
    it.id = m ? m[1] : null;
  }
  return { outside, auditMarkers, rest, incompleteNote, sections, items };
}

function itemOf(items, num) {
  if (!items.has(num)) items.set(num, { rows: [], details: [] });
  return items.get(num);
}

function numberOf(num) {
  return Number(num.slice(1));
}

export function pick(list) {
  if (!Array.isArray(list)) fail("Issue の一覧の JSON 配列を渡してください");
  const candidates = list
    .filter((x) => x && x.state !== "CLOSED" && typeof x.title === "string" && TITLE.test(x.title))
    .filter((x) => typeof x.body === "string" && /<!-- security-audit:summary-id=.+ -->/.test(x.body))
    .map((x) => ({ number: x.number, date: TITLE.exec(x.title)[1], createdAt: String(x.createdAt ?? "") }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  if (candidates.length === 0) broken("no_summary_issue");
  return String(candidates[0].number);
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

// 書き込む前の確認。対象の項目・件数・追記の行のほかが変わっていないこと。
export function checkBody(beforeText, afterText, targets, added = [], removed = []) {
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
  if (before.auditMarkers.join("\n") !== after.auditMarkers.join("\n")) reasons.push("audit_marker_changed");
  // 追記の行は足すだけにする（前からある行は残す）
  const kept = [...before.rest];
  const rest = after.rest.filter((l) => {
    const at = kept.indexOf(l);
    if (at >= 0) {
      kept.splice(at, 1);
      return true;
    }
    return !NOTE.test(l);
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

function git(worktree, args) {
  const r = spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

// 秘密でないことがはっきりしている値（環境名・ログの段階・真偽値）
const PLAIN_VALUES = /^(development|production|staging|test|testing|local|debug|info|warn|warning|error|true|false)$/i;

// 作業ツリーの未追跡の .env*（対象リポジトリからコピーしたもの）の値。秘密でないありふれた値は除く。列挙できなければ null
function envValues(worktree) {
  const out = [];
  const list = git(worktree, ["ls-files", "-z", "--others", "--", ":(glob).env*", ":(glob)**/.env*"]);
  if (list === null) return null;
  for (const file of list.split("\0").filter(Boolean)) {
    if (/(^|\/)node_modules\//.test(file)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(worktree, file), "utf8");
    } catch {
      continue;
    }
    for (const line of lines(text)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (v.length < 8 || PLAIN_VALUES.test(v) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(v)) continue;
      out.push({ file, key: m[1], value: v });
    }
  }
  return out;
}

function worktreeArg(worktree) {
  if (git(worktree, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") fail(`--worktree が git の作業ツリーではありません: ${worktree}`);
  return worktree;
}

export function checkSecrets(text, worktree) {
  const reasons = [];
  const values = envValues(worktree);
  if (values === null) reasons.push("env_list_failed");
  for (const { file, key, value } of values ?? []) if (text.includes(value)) reasons.push(`env_value_present:${file}:${key}`);
  for (const re of TOKEN_PATTERNS) if (re.test(text)) reasons.push(`token_like:${re.source.replace(/^\(\?<!\[A-Za-z0-9\]\)/, "").slice(0, 12)}`);
  if (/\{\{[A-Z_]+:[^}]*\}\}/.test(text)) reasons.push("placeholder_left");
  return [...new Set(reasons)];
}

// Markdown のリンクの閉じ括弧を、パスの括弧と釣り合わない分だけ外す
function trimPath(p) {
  let open = 0;
  let end = p.length;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "(") open++;
    else if (p[i] === ")") {
      if (open === 0) {
        end = i;
        break;
      }
      open--;
    }
  }
  return p.slice(0, end);
}

export function checkIssue(draft, fingerprint, sha, worktree) {
  const reasons = [];
  const ls = lines(draft).map((l) => l.trim());
  if (!/^# \[[a-z]+\] \S/.test(ls[0] ?? "")) reasons.push("title_line");
  const count = (re) => ls.filter((l) => re.test(l)).length;
  if (count(/^<!-- security-audit:begin -->$/) !== 1 || count(/^<!-- security-audit:end -->$/) !== 1) reasons.push("marker_begin_end");
  const fps = ls.flatMap((l) => {
    const m = /^<!-- security-audit:fingerprint=(.+) -->$/.exec(l);
    return m ? [m[1]] : [];
  });
  if (fps.length !== 1 || fps[0] !== fingerprint) reasons.push("fingerprint_mismatch");
  const shas = ls.flatMap((l) => {
    const m = /^<!-- security-audit:source-sha=(.+) -->$/.exec(l);
    return m ? [m[1]] : [];
  });
  if (shas.length !== 1 || shas[0] !== sha) reasons.push("source_sha_mismatch");
  if (count(/^<!-- security-audit:completed-at=/) > 0) reasons.push("completed_at_present");
  // リンクの前半（ref まで）を見つけ、パスは Markdown の閉じ括弧と釣り合う分だけを取る。次の走査はパスの直後から始める
  const linkRe = /https?:\/\/[^\s<>"'()]+?\/blob\/([^\s/<>"'()]+)\//g;
  const anchorRe = /#L(\d+)(?:-L(\d+))?/y;
  let pinned = 0;
  let m;
  while ((m = linkRe.exec(draft))) {
    const ref = m[1];
    const rest = draft.slice(linkRe.lastIndex).match(/^[^\s#<>"'?]*/)[0];
    const rawPath = trimPath(rest);
    let after = linkRe.lastIndex + rawPath.length;
    anchorRe.lastIndex = after;
    const a = anchorRe.exec(draft);
    const [from, to] = a ? [a[1], a[2]] : [];
    if (a) after = anchorRe.lastIndex;
    const url = draft.slice(m.index, after);
    linkRe.lastIndex = after;
    if (ref !== sha) {
      reasons.push(`link_not_pinned:${url}`);
      continue;
    }
    let file;
    try {
      file = decodeURIComponent(rawPath);
    } catch {
      reasons.push(`link_path_invalid:${url}`);
      continue;
    }
    const content = git(worktree, ["show", `${sha}:${file}`]);
    if (content === null) {
      reasons.push(`link_path_missing:${url}`);
      continue;
    }
    const total = content.endsWith("\n") ? lines(content).length - 1 : lines(content).length;
    const last = Number(to ?? from ?? 0);
    if (last > total || (from && to && Number(to) < Number(from))) reasons.push(`link_line_out_of_range:${url}`);
    else pinned++;
  }
  if (pinned === 0) reasons.push("no_code_link");
  return [...new Set([...reasons, ...checkSecrets(draft, worktree)])];
}

function lockDir(run, url) {
  let real;
  try {
    real = fs.realpathSync(run);
  } catch {
    fail(`実行フォルダがありません: ${run}`);
  }
  if (!fs.existsSync(path.join(real, "repo"))) fail(`このスキルの実行フォルダではありません: ${run}`);
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(url);
  if (!m) fail(`集約 Issue の URL を https://<host>/<owner>/<repo>/issues/<番号> の形で指定してください: ${url}`);
  // GitHub のホスト・owner・リポジトリ名は大文字と小文字を区別しないので、そろえてから鍵にする
  return { run: real, dir: path.join(path.dirname(real), ".locks", m.slice(1).join("_").toLowerCase()) };
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

function listArg(value) {
  if (!value) return [];
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const n of list) if (!NUMBER.test(n)) fail(`番号は A03・U01 の形で指定してください: ${n}`);
  return list;
}

function options(args, names) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!names.includes(name)) fail(`知らないオプションです: ${a}`);
      if (i + 1 >= args.length) fail(`${a} の値がありません`);
      out[name] = args[++i];
    } else out._.push(a);
  }
  return out;
}

const COMMANDS = {
  ...SUMMARY_COMMANDS,
  lock: (args) => {
    if (args.length !== 2) fail("使い方: verify.mjs lock <実行フォルダ> <集約 Issue の URL>");
    return lock(args[0], args[1]);
  },
  unlock: (args) => {
    if (args.length !== 2) fail("使い方: verify.mjs unlock <実行フォルダ> <集約 Issue の URL>");
    return unlock(args[0], args[1]);
  },
  pick: () => {
    let list;
    try {
      list = JSON.parse(fs.readFileSync(0, "utf8"));
    } catch {
      fail("標準入力が JSON ではありません");
    }
    return pick(list);
  },
  items: (args) => {
    if (!args[0]) fail("使い方: verify.mjs items <本文のファイル>");
    return JSON.stringify(items(readText(args[0])), null, 2);
  },
  same: (args) => {
    if (args.length < 3) fail("使い方: verify.mjs same <控えの JSON> <本文のファイル> <番号...>");
    let start;
    try {
      start = JSON.parse(readText(args[0]));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      fail("控えが JSON ではありません");
    }
    const nums = listArg(args.slice(2).join(","));
    const result = same(start, readText(args[1]), nums);
    if (result.some(([, s]) => s !== "same")) process.exitCode = 1;
    return result.map(([n, s]) => `${n} ${s}`).join("\n");
  },
  "check-body": (args) => {
    const o = options(args, ["targets", "new", "remove"]);
    if (o._.length !== 2 || !o.targets) fail("使い方: verify.mjs check-body <前の本文> <後の本文> --targets A03,U01 [--new A20] [--remove A04]");
    const reasons = checkBody(readText(o._[0]), readText(o._[1]), listArg(o.targets), listArg(o.new), listArg(o.remove));
    if (reasons.length) process.exitCode = 1;
    return reasons.length ? reasons.join("\n") : "ok";
  },
  "check-issue": (args) => {
    const o = options(args, ["fingerprint", "sha", "worktree"]);
    if (o._.length !== 1 || !o.fingerprint || !o.sha || !o.worktree) fail("使い方: verify.mjs check-issue <下書き> --fingerprint <ID> --sha <SHA> --worktree <作業ツリー>");
    if (!SHA.test(o.sha)) fail("--sha は完全なコミット SHA で指定してください");
    const reasons = checkIssue(readText(o._[0]), o.fingerprint, o.sha, worktreeArg(o.worktree));
    if (reasons.length) process.exitCode = 1;
    return reasons.length ? reasons.join("\n") : "ok";
  },
  "check-secrets": (args) => {
    const o = options(args, ["worktree"]);
    if (o._.length !== 1 || !o.worktree) fail("使い方: verify.mjs check-secrets <ファイル> --worktree <作業ツリー>");
    const reasons = checkSecrets(readText(o._[0]), worktreeArg(o.worktree));
    if (reasons.length) process.exitCode = 1;
    return reasons.length ? reasons.join("\n") : "ok";
  },
};

function main(argv) {
  const [cmd, ...args] = argv;
  const fn = COMMANDS[cmd];
  if (!fn) fail(`使い方: verify.mjs <${Object.keys(COMMANDS).join("|")}> [...]`);
  return fn(args);
}

if (process.argv[1]?.endsWith("/verify.mjs")) {
  try {
    const out = main(process.argv.slice(2));
    if (out) process.stdout.write(`${out}\n`);
  } catch (error) {
    if (error instanceof StructureError) {
      process.stdout.write(`${error.message}\n`);
      process.exit(2);
    }
    if (error instanceof CheckError) {
      process.stdout.write(`${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`verify.mjs: ${error instanceof UsageError ? error.message : "予期しないエラー"}\n`);
    process.exit(3);
  }
}
