#!/usr/bin/env node
// security-audit-verify-items の定型の検査。親（このスキルを呼んだメインのセッション）が GitHub に書く前に使う。
// 集約 Issue の解析・検査・組み立て・lock は security-audit-sync-issues の scripts/summary-body.mjs にあり、ここからも同じ名前で呼べる。
//   pick                                  標準入力の gh issue list の JSON から、最新の集約 Issue の番号を出す
//   items <本文>                           （summary-body.mjs）項目ごとの区分・ID・全文と、番号を省いたときの対象を JSON で出す（調査開始時の控えに使う）
//   same <控えの JSON> <本文> <番号...>      （summary-body.mjs）項目の全文が控えと同じかを番号ごとに出す（違えば終了コード 1）
//   check-body <前の全文> <後の全文> --targets A03,U01 [--new A20,A21] [--remove A04] [--bump-revision <開始時の版>]
//                                         （summary-body.mjs）対象の項目・件数・追記の行のほかが変わっていないかを確かめる（外れたら終了コード 1）
//                                         文字数の上限は、本文とコメントに分ける split で確かめる
//                                         --remove は統合して消す対象の番号（残す項目の詳細に「（統合: A04）」が要る）
//   assemble <前の全文> <計画の JSON> <出力> [--targets <番号> [--new <番号>]] [--bump-revision <開始時の版>]
//                                         （summary-body.mjs）計画どおりに項目を移し、件数と並び順を直した全文を書く（外れたら書かずに終了コード 1）
//   check <全文>                           （summary-body.mjs）番号・件数・並び順を確かめる（外れたら理由を 1 行ずつ出して終了コード 1）
//   check-issue <下書き> --fingerprint <ID> --sha <SHA> --worktree <作業ツリー> --repo <host>/<owner>/<repo>
//                                         修正 Issue の下書きのタイトル・マーカー・コードのリンク・秘密らしい文字列を確かめる（外れたら終了コード 1）
//                                         対象リポジトリのリンクは --sha で固定する。ほかのリポジトリのリンクは、実行フォルダの ledger/deps.json に
//                                         同じ host/owner/repo と同じ SHA の記録があり、その path のフォルダにファイルと行があるときだけ通す
//   check-secrets <ファイル> --worktree <作業ツリー>
//                                         作業ツリーの .env* の値やトークンらしい文字列、置き換え忘れの {{...}} がないかを確かめる（外れたら終了コード 1）
//   extract / compose / split / fill       集約 Issue の本文と区分ごとの詳細コメントを行き来する（summary-body.mjs と同じ。使い方はそちらの冒頭）
//   lock <実行フォルダ> <集約 Issue の URL>   集約 Issue への書き込みを 1 つの実行に限る（ほかの実行が持っていれば終了コード 1）
//   unlock <実行フォルダ> <集約 Issue の URL> lock を外す
// 終了コード 2 は集約 Issue の構造の異常（出力は理由の語）、3 は引数の誤り。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { COMMANDS as SUMMARY_COMMANDS, CheckError, StructureError, UsageError, lines, readText } from "../../../../.agents/skills/security-audit-sync-issues/scripts/summary-body.mjs";

export { assemble, check, checkBody, items, lock, parse, same, unlock } from "../../../../.agents/skills/security-audit-sync-issues/scripts/summary-body.mjs";

const TITLE = /^\[(\d{4}-\d{2}-\d{2})\] セキュリティ監査の調査・判定一覧$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
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

// --repo の <host>/<owner>/<repo> を、大文字と小文字を区別しない鍵にする
function repoKey(repo) {
  const m = /^([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/.exec(repo ?? "");
  if (!m) fail(`--repo は <host>/<owner>/<repo> の形で指定してください: ${repo ?? ""}`);
  return m.slice(1).join("/").toLowerCase();
}

// 実行フォルダの ledger/deps.json の記録（別のリポジトリの remote・固定した SHA・置いたフォルダ）。読めなければ記録なし
function depsOf(run) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(path.join(run, "ledger", "deps.json"), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((d) => (typeof d?.remote === "string" && typeof d.sha === "string" && typeof d.path === "string" ? [{ remote: d.remote.toLowerCase(), sha: d.sha, path: d.path }] : []));
}

// 記録のフォルダの中のファイルの中身。フォルダの外を指すパスや読めないときは null
function readInside(dir, file) {
  const full = path.resolve(dir, file);
  if (!full.startsWith(`${path.resolve(dir)}${path.sep}`)) return null;
  try {
    return fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

// 修正 Issue の下書きを確かめる。対象リポジトリのコードのリンクは sha で固定し、ほかのリポジトリは実行フォルダの deps.json の記録と同じ SHA だけ通す
export function checkIssue(draft, fingerprint, sha, worktree, repo) {
  const reasons = [];
  const target = repoKey(repo);
  // 作業ツリーの親が実行フォルダ（ledger/deps.json と、記録の path の基準）
  const run = path.dirname(path.resolve(worktree));
  const deps = depsOf(run);
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
  const linkRe = /https?:\/\/([^\s<>"'()/]+)\/([^\s<>"'()/]+)\/([^\s<>"'()/]+)\/blob\/([^\s/<>"'()]+)\//g;
  const anchorRe = /#L(\d+)(?:-L(\d+))?/y;
  let pinned = 0;
  let m;
  while ((m = linkRe.exec(draft))) {
    const [, host, owner, name, ref] = m;
    const rest = draft.slice(linkRe.lastIndex).match(/^[^\s#<>"'?]*/)[0];
    const rawPath = trimPath(rest);
    let after = linkRe.lastIndex + rawPath.length;
    anchorRe.lastIndex = after;
    const a = anchorRe.exec(draft);
    const [from, to] = a ? [a[1], a[2]] : [];
    if (a) after = anchorRe.lastIndex;
    const url = draft.slice(m.index, after);
    linkRe.lastIndex = after;
    const key = `${host}/${owner}/${name}`.toLowerCase();
    const isTarget = key === target;
    const dep = isTarget ? null : deps.find((d) => d.remote === key && d.sha === ref);
    if (isTarget ? ref !== sha : !dep) {
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
    const content = isTarget ? git(worktree, ["show", `${sha}:${file}`]) : readInside(path.resolve(run, dep.path), file);
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

// 値を取るオプションを読む（それ以外の引数は _ に入れる）
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
  pick: () => {
    let list;
    try {
      list = JSON.parse(fs.readFileSync(0, "utf8"));
    } catch {
      fail("標準入力が JSON ではありません");
    }
    return pick(list);
  },
  "check-issue": (args) => {
    const o = options(args, ["fingerprint", "sha", "worktree", "repo"]);
    if (o._.length !== 1 || !o.fingerprint || !o.sha || !o.worktree || !o.repo) fail("使い方: verify.mjs check-issue <下書き> --fingerprint <ID> --sha <SHA> --worktree <作業ツリー> --repo <host>/<owner>/<repo>");
    if (!SHA.test(o.sha)) fail("--sha は完全なコミット SHA で指定してください");
    const reasons = checkIssue(readText(o._[0]), o.fingerprint, o.sha, worktreeArg(o.worktree), o.repo);
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
