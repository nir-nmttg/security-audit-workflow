#!/usr/bin/env node
// security-audit-verify-items で GitHub に書く処理。親だけが使う。allowed-tools に入れず、呼ぶたびに権限モードの確認を通す。
// どのコマンドも、書く前に登録先（target で控えた GitHub のリポジトリ）が今も同じで、非公開・Issue 有効・アーカイブなしであることを確かめ、
// 予定と結果を <実行フォルダ>/ledger/write-log.jsonl に 1 行ずつ書く。
//   target <実行フォルダ> <host>/<owner>/<repo> <集約 Issue の URL>
//                         登録先と集約 Issue を確かめて ledger/target.json に控える（控えがあれば一致を確かめる）
//   create <実行フォルダ> <下書き> --item <番号> --key <key> --fingerprint <ID> --sha <VERIFY_SHA>
//                         修正 Issue を作る（check-issue・check-secrets・空の本文・重複・読み戻しを確かめる。ラベル agent:security-audit を付ける）
//   label <実行フォルダ> <Issue の URL> <agent:security-audit|agent:autofix>
//                         ラベルがなければ決まった色と説明で作り（あるラベルは変えない）、Issue に付ける
//   sub-issue <実行フォルダ> <Issue の URL>
//                         集約 Issue のサブ Issue にする（ほかの親があれば付け替えない）
//   comment <実行フォルダ> <Issue の URL> <ファイル>
//                         Issue にコメントを足す
//   edit-body <実行フォルダ> <Issue の URL> <新しい本文> --before <取り直した前の本文> [--title <タイトル>]
//                         今の本文が --before と同じときだけ本文（とタイトル）を書き換える。集約 Issue なら lock を取り直してから書く
//   comment-create <実行フォルダ> <ファイル>
//                         集約 Issue に詳細コメントを作り、URL を出す（lock を取り直してから書く）
//   comment-retire <実行フォルダ> <コメントの ID> <ファイル>
//                         集約 Issue の詳細コメントを書き換える（lock を取り直してから書く）
//   status <実行フォルダ>  write-log.jsonl から、予定だけで結果のない操作を出す（再開の照合に使う）
// 終了コード 0 は成功（出力は決まった語と URL）、1 は確かめた条件に外れて書かなかった・書けなかった（出力は理由の語）、3 は引数の誤り。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lock } from "./verify.mjs";

const SELF_DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(SELF_DIR, "../../../..");
// 実行フォルダの置き場所（lib.sh の runs_root と同じ）
const RUNS_ROOT = path.join(REPO_ROOT, "artifacts", "security-audit-verify-items");
// ラベルは無いときだけ、この色と説明で作る（あるラベルの色と説明は変えない）。security-audit-sync-issues の手順と同じファイルを使う
export const LABELS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".agents/skills/security-audit-sync-issues/scripts/labels.json"), "utf8"));
const ISSUE_URL = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)$/;
const REPO_ARG = /^([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/;

class UsageError extends Error {}
class Refused extends Error {}

const usage = (message) => {
  throw new UsageError(message);
};
const refuse = (reason) => {
  throw new Refused(reason);
};
const lower = (s) => String(s).toLowerCase();
const normalize = (text) => String(text ?? "").replace(/\r\n/g, "\n");

function runDir(run) {
  let real;
  try {
    real = fs.realpathSync(run);
  } catch {
    usage(`実行フォルダがありません: ${run}`);
  }
  let root;
  try {
    root = fs.realpathSync(RUNS_ROOT);
  } catch {
    usage(`実行フォルダの置き場所がありません: ${RUNS_ROOT}`);
  }
  if (!real.startsWith(`${root}${path.sep}`) || !fs.existsSync(path.join(real, "repo")) || !fs.existsSync(path.join(real, "ledger"))) usage(`このスキルの実行フォルダではありません: ${run}`);
  return real;
}

function gh(args, { allowFail = false } = {}) {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.error) refuse("gh_unavailable");
  if (r.status !== 0 && !allowFail) refuse(`gh_failed:${(r.stderr || r.stdout || "").trim().split("\n")[0].slice(0, 200)}`);
  return r;
}

function ghJson(args, opts) {
  const r = gh(args, opts);
  if (r.status !== 0) return { status: r.status, json: safeJson(r.stdout), stderr: r.stderr };
  const json = safeJson(r.stdout);
  if (json === undefined) refuse("gh_bad_json");
  return { status: 0, json };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// --paginate --slurp の出力（ページの配列）を 1 つの配列にする
const flat = (pages) => (Array.isArray(pages) ? pages.flat() : []);

function readTarget(run) {
  const file = path.join(run, "ledger", "target.json");
  if (!fs.existsSync(file)) refuse("no_target");
  const t = safeJson(fs.readFileSync(file, "utf8"));
  if (!t?.host || !t?.owner || !t?.repo || !t?.id || !t?.summary_number) refuse("bad_target");
  return t;
}

function repoInfo(host, owner, repo) {
  const r = ghJson(["api", "--hostname", host, `repos/${owner}/${repo}`], { allowFail: true });
  if (r.status !== 0) refuse("repo_unreadable");
  return r.json;
}

function checkRepo(info) {
  if (info.private !== true) refuse("not_private");
  if (info.has_issues !== true) refuse("issues_disabled");
  if (info.archived === true) refuse("archived");
}

// 書く前に毎回、登録先が控えと同じで条件を満たすことを確かめる
function ready(run) {
  const t = readTarget(run);
  const info = repoInfo(t.host, t.owner, t.repo);
  if (info.id !== t.id || lower(info.full_name) !== lower(`${t.owner}/${t.repo}`)) refuse("target_changed");
  checkRepo(info);
  return t;
}

function issueOf(t, url) {
  const m = ISSUE_URL.exec(String(url));
  if (!m) usage(`Issue の URL ではありません: ${url}`);
  if (lower(m[1]) !== lower(t.host) || lower(m[2]) !== lower(t.owner) || lower(m[3]) !== lower(t.repo)) refuse("other_repo");
  return Number(m[4]);
}

const api = (t, p) => `repos/${t.owner}/${t.repo}/${p}`;
const summaryUrl = (t) => `https://${t.host}/${t.owner}/${t.repo}/issues/${t.summary_number}`;

function log(run, entry) {
  fs.appendFileSync(path.join(run, "ledger", "write-log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function readLog(run) {
  const file = path.join(run, "ledger", "write-log.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => safeJson(l))
    .filter((e) => e && typeof e === "object");
}

function verifyMjs(args) {
  const r = spawnSync(process.execPath, [path.join(SELF_DIR, "verify.mjs"), ...args], { encoding: "utf8" });
  if (r.status !== 0) refuse(`${args[0]}:${(r.stdout || r.stderr).trim().split("\n").join(" ").slice(0, 300)}`);
}

function readFile(file) {
  try {
    return normalize(fs.readFileSync(file, "utf8"));
  } catch {
    usage(`ファイルを読めません: ${file}`);
  }
}

function checkText(run, file, text) {
  if (!text.trim()) refuse("empty_body");
  const left = /\{\{[A-Z_]+:[^}]*\}\}/.exec(text);
  if (left) refuse(`placeholder_left:${left[0]}`);
  verifyMjs(["check-secrets", file, "--worktree", path.join(run, "worktree")]);
}

function takeLock(run, t) {
  const out = lock(run, summaryUrl(t));
  process.exitCode = 0;
  if (!String(out).startsWith("ok")) refuse(`not_locked:${out}`);
}

function options(args, names) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!names.includes(name)) usage(`不明なオプション: ${a}`);
      if (i + 1 >= args.length) usage(`${a} の値がありません`);
      out[name] = args[++i];
    } else out._.push(a);
  }
  return out;
}

function ensureLabel(t, name) {
  const def = LABELS[name];
  if (!def) usage(`扱わないラベルです: ${name}`);
  const list = () => flat(ghJson(["api", "--hostname", t.host, "--paginate", "--slurp", api(t, "labels?per_page=100")]).json);
  if (list().some((l) => l?.name === name)) return "exists";
  const r = gh(["api", "--hostname", t.host, "-X", "POST", api(t, "labels"), "-f", `name=${name}`, "-f", `color=${def.color}`, "-f", `description=${def.description}`], { allowFail: true });
  if (r.status === 0) return "created";
  // ほかの実行が作った直後なら、それを使う
  if (list().some((l) => l?.name === name)) return "exists";
  refuse(`label_create_failed:${name}`);
}

function getIssue(t, number) {
  const r = ghJson(["api", "--hostname", t.host, api(t, `issues/${number}`)], { allowFail: true });
  if (r.status !== 0) refuse("issue_unreadable");
  return r.json;
}

// 監査用の区画の外（区画の前と後ろ）を返す。区画が 1 つに決まらなければ null
function outsideOf(text, [begin, end]) {
  const ls = normalize(text).split("\n");
  const b = ls.flatMap((l, i) => (l.trim() === begin ? [i] : []));
  const e = ls.flatMap((l, i) => (l.trim() === end ? [i] : []));
  if (b.length !== 1 || e.length !== 1 || b[0] > e[0]) return null;
  return [...ls.slice(0, b[0]), "\0", ...ls.slice(e[0] + 1)].join("\n");
}

function fingerprintsOf(body) {
  const out = [];
  for (const m of normalize(body).matchAll(/<!-- security-audit:fingerprint(?:-alias)?=([^\s>]+) -->/g)) out.push(m[1]);
  return out;
}

export const COMMANDS = {
  target(args) {
    if (args.length !== 3) usage("使い方: issue.mjs target <実行フォルダ> <host>/<owner>/<repo> <集約 Issue の URL>");
    const run = runDir(args[0]);
    const m = REPO_ARG.exec(args[1]);
    if (!m) usage(`<host>/<owner>/<repo> の形ではありません: ${args[1]}`);
    const [, host, owner, repo] = m;
    const s = ISSUE_URL.exec(args[2]);
    if (!s) usage(`Issue の URL ではありません: ${args[2]}`);
    if (lower(s[1]) !== lower(host) || lower(s[2]) !== lower(owner) || lower(s[3]) !== lower(repo)) refuse("summary_other_repo");
    const info = repoInfo(host, owner, repo);
    if (lower(info.full_name) !== lower(`${owner}/${repo}`)) refuse("target_changed");
    checkRepo(info);
    const target = { host: lower(host), owner: info.full_name.split("/")[0], repo: info.full_name.split("/")[1], id: info.id, summary_number: Number(s[4]) };
    const file = path.join(run, "ledger", "target.json");
    if (fs.existsSync(file)) {
      const saved = safeJson(fs.readFileSync(file, "utf8"));
      const same = saved && saved.host === target.host && lower(saved.owner) === lower(target.owner) && lower(saved.repo) === lower(target.repo) && saved.id === target.id && saved.summary_number === target.summary_number;
      if (!same) refuse("target_mismatch");
      return `ok ${target.host}/${target.owner}/${target.repo} #${target.summary_number}`;
    }
    fs.writeFileSync(file, `${JSON.stringify({ ...target, checked_at: new Date().toISOString() }, null, 2)}\n`);
    return `ok ${target.host}/${target.owner}/${target.repo} #${target.summary_number}`;
  },

  create(args) {
    const o = options(args, ["item", "key", "fingerprint", "sha"]);
    if (o._.length !== 2 || !o.item || !o.key || !o.fingerprint || !o.sha) usage("使い方: issue.mjs create <実行フォルダ> <下書き> --item <番号> --key <key> --fingerprint <ID> --sha <VERIFY_SHA>");
    const run = runDir(o._[0]);
    const draft = o._[1];
    const t = ready(run);
    const text = readFile(draft);
    const [first, ...rest] = text.split("\n");
    if (!first.startsWith("# ") || !first.slice(2).trim()) refuse("no_title");
    const title = first.slice(2).trim();
    const body = rest.join("\n").replace(/^\n+/, "");
    checkText(run, draft, body);
    verifyMjs(["check-issue", draft, "--fingerprint", o.fingerprint, "--sha", o.sha, "--worktree", path.join(run, "worktree"), "--repo", `${t.host}/${t.owner}/${t.repo}`]);
    const entries = readLog(run).filter((e) => e.op === "create" && e.fingerprint === o.fingerprint);
    const done = entries.find((e) => e.phase === "done" && e.url);
    if (done) return `exists ${done.url}`;
    const issues = flat(ghJson(["api", "--hostname", t.host, "--paginate", "--slurp", api(t, "issues?state=all&per_page=100")]).json).filter((i) => i && !i.pull_request);
    const dups = issues.filter((i) => !/<!-- security-audit:summary-id=/.test(normalize(i.body)) && fingerprintsOf(i.body).includes(o.fingerprint));
    if (dups.length) {
      // この実行で作りかけて結果を記録できなかったもの（予定だけがあり、本文が下書きと同じ 1 件）は、作ったものとして扱う
      const planned = entries.some((e) => e.phase === "planned");
      if (planned && dups.length === 1 && normalize(dups[0].body) === body && dups[0].title === title) {
        log(run, { op: "create", phase: "done", item: o.item, key: o.key, fingerprint: o.fingerprint, draft, url: dups[0].html_url, note: "recovered" });
        return `exists ${dups[0].html_url}`;
      }
      refuse(`duplicate ${dups.map((i) => i.html_url).join(" ")}`);
    }
    ensureLabel(t, "agent:security-audit");
    log(run, { op: "create", phase: "planned", item: o.item, key: o.key, fingerprint: o.fingerprint, draft });
    const bodyFile = path.join(run, "ledger", `create-${o.item}-${o.key}.md`);
    fs.writeFileSync(bodyFile, body);
    const r = ghJson(["api", "--hostname", t.host, "-X", "POST", api(t, "issues"), "-f", `title=${title}`, "-F", `body=@${bodyFile}`, "-f", "labels[]=agent:security-audit"], { allowFail: true });
    if (r.status !== 0 || !r.json?.html_url) {
      log(run, { op: "create", phase: "failed", item: o.item, key: o.key, fingerprint: o.fingerprint, draft });
      refuse("create_failed");
    }
    const back = getIssue(t, r.json.number);
    if (normalize(back.body) !== body || back.title !== title) {
      log(run, { op: "create", phase: "failed", item: o.item, key: o.key, fingerprint: o.fingerprint, draft, url: r.json.html_url, note: "readback_mismatch" });
      refuse(`readback_mismatch ${r.json.html_url}`);
    }
    log(run, { op: "create", phase: "done", item: o.item, key: o.key, fingerprint: o.fingerprint, draft, url: r.json.html_url });
    return `created ${r.json.html_url}`;
  },

  label(args) {
    if (args.length !== 3) usage("使い方: issue.mjs label <実行フォルダ> <Issue の URL> <ラベル>");
    const run = runDir(args[0]);
    const t = ready(run);
    const number = issueOf(t, args[1]);
    const name = args[2];
    const made = ensureLabel(t, name);
    const before = getIssue(t, number);
    if ((before.labels ?? []).some((l) => l?.name === name)) return `ok already ${args[1]} ${name}`;
    log(run, { op: "label", phase: "planned", target: args[1], label: name });
    gh(["api", "--hostname", t.host, "-X", "POST", api(t, `issues/${number}/labels`), "-f", `labels[]=${name}`]);
    if (!(getIssue(t, number).labels ?? []).some((l) => l?.name === name)) {
      log(run, { op: "label", phase: "failed", target: args[1], label: name });
      refuse("label_not_added");
    }
    log(run, { op: "label", phase: "done", target: args[1], label: name });
    return `ok added ${args[1]} ${name}${made === "created" ? " label_created" : ""}`;
  },

  "sub-issue"(args) {
    if (args.length !== 2) usage("使い方: issue.mjs sub-issue <実行フォルダ> <Issue の URL>");
    const run = runDir(args[0]);
    const t = ready(run);
    const number = issueOf(t, args[1]);
    if (getIssue(t, t.summary_number).state !== "open") refuse("summary_not_open");
    const parentOf = () => {
      const r = gh(["api", "--hostname", t.host, api(t, `issues/${number}/parent`)], { allowFail: true });
      if (r.status === 0) return safeJson(r.stdout) ?? refuse("gh_bad_json");
      if (`${r.stdout}${r.stderr}`.includes("No parent issue found")) return null;
      refuse("parent_unreadable");
    };
    const parent = parentOf();
    const isSummary = (p) => lower(p?.html_url ?? "") === lower(summaryUrl(t));
    if (parent) return isSummary(parent) ? `ok already ${args[1]}` : `other_parent ${parent.html_url}`;
    const id = getIssue(t, number).id;
    log(run, { op: "sub_issue", phase: "planned", target: args[1] });
    gh(["api", "--hostname", t.host, "-X", "POST", api(t, `issues/${t.summary_number}/sub_issues`), "-F", `sub_issue_id=${id}`], { allowFail: true });
    const after = parentOf();
    if (!isSummary(after)) {
      log(run, { op: "sub_issue", phase: "failed", target: args[1] });
      refuse("sub_issue_failed");
    }
    log(run, { op: "sub_issue", phase: "done", target: args[1] });
    return `ok added ${args[1]}`;
  },

  comment(args) {
    if (args.length !== 3) usage("使い方: issue.mjs comment <実行フォルダ> <Issue の URL> <ファイル>");
    const run = runDir(args[0]);
    const t = ready(run);
    const number = issueOf(t, args[1]);
    const text = readFile(args[2]);
    checkText(run, args[2], text);
    log(run, { op: "comment", phase: "planned", target: args[1], file: args[2] });
    const r = ghJson(["api", "--hostname", t.host, "-X", "POST", api(t, `issues/${number}/comments`), "-F", `body=@${args[2]}`], { allowFail: true });
    if (r.status !== 0 || normalize(r.json?.body) !== text) {
      log(run, { op: "comment", phase: "failed", target: args[1], file: args[2] });
      refuse("comment_failed");
    }
    log(run, { op: "comment", phase: "done", target: args[1], file: args[2], url: r.json.html_url });
    return `ok ${r.json.html_url}`;
  },

  "edit-body"(args) {
    const o = options(args, ["before", "title"]);
    if (o._.length !== 3 || !o.before) usage("使い方: issue.mjs edit-body <実行フォルダ> <Issue の URL> <新しい本文> --before <前の本文> [--title <タイトル>]");
    const run = runDir(o._[0]);
    const t = ready(run);
    const number = issueOf(t, o._[1]);
    const text = readFile(o._[2]);
    checkText(run, o._[2], text);
    if (number === t.summary_number) takeLock(run, t);
    const now = getIssue(t, number);
    const before = readFile(o.before);
    if (normalize(now.body) !== before) refuse("changed");
    if (now.state !== "open") refuse("not_open");
    // 書き換えてよいのは監査用の区画の中だけ（集約 Issue は summary-begin〜end、修正 Issue は begin〜end）。区画の外（人の追記）は変えない
    const marks = number === t.summary_number ? ["<!-- security-audit:summary-begin -->", "<!-- security-audit:summary-end -->"] : ["<!-- security-audit:begin -->", "<!-- security-audit:end -->"];
    const outside = outsideOf(before, marks);
    if (outside === null) refuse("no_audit_block");
    if (outsideOf(text, marks) !== outside) refuse("outside_changed");
    log(run, { op: "edit_body", phase: "planned", target: o._[1], file: o._[2] });
    const fields = ["-F", `body=@${o._[2]}`, ...(o.title ? ["-f", `title=${o.title}`] : [])];
    gh(["api", "--hostname", t.host, "-X", "PATCH", api(t, `issues/${number}`), ...fields], { allowFail: true });
    const back = getIssue(t, number);
    if (normalize(back.body) !== text || (o.title && back.title !== o.title)) {
      log(run, { op: "edit_body", phase: "failed", target: o._[1], file: o._[2] });
      refuse("readback_mismatch");
    }
    log(run, { op: "edit_body", phase: "done", target: o._[1], file: o._[2] });
    return `ok ${o._[1]}`;
  },

  "comment-create"(args) {
    if (args.length !== 2) usage("使い方: issue.mjs comment-create <実行フォルダ> <ファイル>");
    const run = runDir(args[0]);
    const t = ready(run);
    const text = readFile(args[1]);
    checkText(run, args[1], text);
    takeLock(run, t);
    log(run, { op: "comment_create", phase: "planned", target: summaryUrl(t), file: args[1] });
    const r = ghJson(["api", "--hostname", t.host, "-X", "POST", api(t, `issues/${t.summary_number}/comments`), "-F", `body=@${args[1]}`], { allowFail: true });
    if (r.status !== 0 || normalize(r.json?.body) !== text) {
      log(run, { op: "comment_create", phase: "failed", target: summaryUrl(t), file: args[1] });
      refuse("comment_failed");
    }
    log(run, { op: "comment_create", phase: "done", target: summaryUrl(t), file: args[1], url: r.json.html_url });
    return r.json.html_url;
  },

  "comment-retire"(args) {
    if (args.length !== 3 || !/^\d+$/.test(args[1])) usage("使い方: issue.mjs comment-retire <実行フォルダ> <コメントの ID> <ファイル>");
    const run = runDir(args[0]);
    const t = ready(run);
    const text = readFile(args[2]);
    checkText(run, args[2], text);
    takeLock(run, t);
    const c = ghJson(["api", "--hostname", t.host, api(t, `issues/comments/${args[1]}`)], { allowFail: true });
    if (c.status !== 0) refuse("comment_unreadable");
    if (!String(c.json?.issue_url ?? "").endsWith(`/repos/${t.owner}/${t.repo}/issues/${t.summary_number}`)) refuse("not_summary_comment");
    log(run, { op: "comment_retire", phase: "planned", target: args[1], file: args[2] });
    const r = ghJson(["api", "--hostname", t.host, "-X", "PATCH", api(t, `issues/comments/${args[1]}`), "-F", `body=@${args[2]}`], { allowFail: true });
    if (r.status !== 0 || normalize(r.json?.body) !== text) {
      log(run, { op: "comment_retire", phase: "failed", target: args[1], file: args[2] });
      refuse("comment_failed");
    }
    log(run, { op: "comment_retire", phase: "done", target: args[1], file: args[2] });
    return `ok ${args[1]}`;
  },

  status(args) {
    if (args.length !== 1) usage("使い方: issue.mjs status <実行フォルダ>");
    const run = runDir(args[0]);
    const entries = readLog(run);
    const key = (e) => [e.op, e.fingerprint ?? "", e.target ?? "", e.label ?? "", e.file ?? ""].join("\t");
    const last = new Map();
    for (const e of entries) last.set(key(e), e);
    const out = [];
    for (const e of last.values()) {
      if (e.phase === "done") continue;
      out.push(`${e.phase === "planned" ? "pending" : "failed"} ${e.op} ${e.item ?? ""} ${e.fingerprint ?? e.target ?? ""} ${e.url ?? ""}`.replace(/\s+/g, " ").trim());
    }
    const done = [...last.values()].filter((e) => e.phase === "done").length;
    return [...out, `done ${done}`].join("\n");
  },
};

function main(argv) {
  const [cmd, ...args] = argv;
  const fn = COMMANDS[cmd];
  if (!fn) usage(`使い方: issue.mjs <${Object.keys(COMMANDS).join("|")}> [...]`);
  return fn(args);
}

if (process.argv[1]?.endsWith("/issue.mjs")) {
  try {
    const out = main(process.argv.slice(2));
    if (out) process.stdout.write(`${out}\n`);
  } catch (error) {
    if (error instanceof Refused) {
      process.stdout.write(`${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`issue.mjs: ${error instanceof UsageError ? error.message : `予期しないエラー: ${error?.message ?? error}`}\n`);
    process.exit(3);
  }
}
