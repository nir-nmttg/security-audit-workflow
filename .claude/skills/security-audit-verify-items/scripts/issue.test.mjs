// issue.mjs のテスト。gh の代わりに、状態を JSON に持つ偽の gh を PATH の先頭に置いて動かす。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ISSUE = path.join(DIR, "issue.mjs");
// issue.mjs は所定の置き場所の中の実行フォルダだけを受け付けるので、テストの実行フォルダもそこに作り、終わったら消す
const RUNS_ROOT = path.join(fs.realpathSync(path.resolve(DIR, "../../../..")), "artifacts", "security-audit-verify-items");
const created = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_GH_STATE;
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
if (args[0] !== "api") process.exit(4);
let method = "GET", p = "", fields = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--hostname") i++;
  else if (a === "-X") method = args[++i];
  else if (a === "--paginate" || a === "--slurp") {}
  else if (a === "-f" || a === "-F") {
    const [k, ...rest] = args[++i].split("=");
    let v = rest.join("=");
    if (a === "-F" && v.startsWith("@")) v = fs.readFileSync(v.slice(1), "utf8");
    else if (a === "-F" && /^\d+$/.test(v)) v = Number(v);
    if (k.endsWith("[]")) (fields[k.slice(0, -2)] ??= []).push(v);
    else fields[k] = v;
  } else p = a;
}
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const out = (v) => { process.stdout.write(JSON.stringify(v)); save(); process.exit(0); };
const notFound = (m = "Not Found") => { process.stdout.write(JSON.stringify({ message: m })); process.stderr.write("gh: " + m + " (HTTP 404)\n"); process.exit(1); };
const base = "repos/" + s.repo.full_name;
const url = (n) => "https://github.com/" + s.repo.full_name + "/issues/" + n;
const view = (i) => ({ number: i.number, id: i.id, title: i.title, body: i.body, state: i.state, labels: i.labels.map((name) => ({ name })), html_url: url(i.number) });
const issue = (n) => s.issues.find((i) => i.number === Number(n));
const route = p.split("?")[0];
let m;
if (route.toLowerCase() === base.toLowerCase()) out(s.repo);
if (route === base + "/issues" && method === "GET") out([s.issues.map(view)]);
if (route === base + "/issues" && method === "POST") {
  const n = s.issues.length + 1;
  const i = { number: n, id: 1000 + n, title: fields.title, body: fields.body, state: "open", labels: fields.labels ?? [] };
  s.issues.push(i);
  out(view(i));
}
if ((m = route.match(/\/issues\/(\d+)$/)) && route.startsWith(base)) {
  const i = issue(m[1]);
  if (!i) notFound();
  if (method === "PATCH") { if (fields.body !== undefined) i.body = fields.body; if (fields.title !== undefined) i.title = fields.title; }
  out(view(i));
}
if (route === base + "/labels" && method === "GET") out([s.labels]);
if (route === base + "/labels" && method === "POST") {
  if (s.labels.some((l) => l.name === fields.name)) { process.stderr.write("gh: Validation Failed (HTTP 422)\n"); process.exit(1); }
  s.labels.push({ name: fields.name, color: fields.color, description: fields.description });
  out(s.labels.at(-1));
}
if ((m = route.match(/\/issues\/(\d+)\/labels$/))) { const i = issue(m[1]); for (const l of fields.labels) if (!i.labels.includes(l)) i.labels.push(l); out(i.labels.map((name) => ({ name }))); }
if ((m = route.match(/\/issues\/(\d+)\/parent$/))) { const i = issue(m[1]); if (!i.parent) notFound("No parent issue found"); out(view(issue(i.parent))); }
if ((m = route.match(/\/issues\/(\d+)\/sub_issues$/))) { const child = s.issues.find((i) => i.id === fields.sub_issue_id); child.parent = Number(m[1]); out(view(issue(m[1]))); }
if ((m = route.match(/\/issues\/comments\/(\d+)$/))) {
  const c = s.comments.find((x) => x.id === Number(m[1]));
  if (!c) notFound();
  if (method === "PATCH") c.body = fields.body;
  out({ id: c.id, body: c.body, issue_url: "https://api.github.com/" + base + "/issues/" + c.issue, html_url: url(c.issue) + "#issuecomment-" + c.id });
}
if ((m = route.match(/\/issues\/(\d+)\/comments$/)) && method === "POST") {
  const c = { id: 5000 + s.comments.length, issue: Number(m[1]), body: fields.body };
  s.comments.push(c);
  out({ id: c.id, body: c.body, html_url: url(c.issue) + "#issuecomment-" + c.id });
}
notFound();
`;

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function setup({ repo = {}, issues = [], labels = [] } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "issue-test-")));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  fs.mkdirSync(RUNS_ROOT, { recursive: true });
  const run = fs.mkdtempSync(path.join(RUNS_ROOT, "issue-test-"));
  created.push(run, tmp);
  const wt = path.join(run, "worktree");
  fs.mkdirSync(path.join(run, "ledger"), { recursive: true });
  fs.mkdirSync(path.join(run, "items"));
  fs.mkdirSync(wt);
  git(wt, "init", "-q");
  fs.writeFileSync(path.join(wt, "app.rb"), "puts 1\n");
  git(wt, "add", ".");
  git(wt, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  const sha = git(wt, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(run, "repo"), `${wt}\n`);
  fs.writeFileSync(path.join(run, "sha"), `${sha}\n`);
  const state = path.join(tmp, "state.json");
  const summary = { number: 1, id: 1001, title: "[2026-11-27] セキュリティ監査の調査・判定一覧", body: "<!-- security-audit:summary-id=x -->\n", state: "open", labels: [] };
  fs.writeFileSync(state, JSON.stringify({ repo: { id: 77, full_name: "Org/App", private: true, has_issues: true, archived: false, ...repo }, issues: [summary, ...issues], labels, comments: [] }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, SECURITY_AUDIT_LOCK_DIR: path.join(tmp, "locks") };
  const call = (...a) => spawnSync(process.execPath, [ISSUE, ...a], { encoding: "utf8", env });
  const read = () => JSON.parse(fs.readFileSync(state, "utf8"));
  const write = (s) => fs.writeFileSync(state, JSON.stringify(s));
  return { tmp, run, sha, call, read, write };
}

function draft(t, body, fp = "fp-1") {
  body ??= `## 対象機能と守るべきルール\n\n説明。\n\n## コード上の根拠\n\n[app.rb:1](https://github.com/org/app/blob/${t.sha}/app.rb#L1)\n`;
  const file = path.join(t.run, "items", `A01-p1-issue.md`);
  fs.writeFileSync(file, `# [high] テストの題名\n\n<!-- security-audit:begin -->\n<!-- security-audit:fingerprint=${fp} -->\n<!-- security-audit:source-sha=${t.sha} -->\n${body}<!-- security-audit:end -->\n`);
  return file;
}

const SUMMARY = "https://github.com/org/app/issues/1";

test("target は非公開でない登録先を断り、条件を満たせば控える", () => {
  const bad = setup({ repo: { private: false } });
  const r1 = bad.call("target", bad.run, "github.com/org/app", SUMMARY);
  assert.equal(r1.status, 1);
  assert.equal(r1.stdout.trim(), "not_private");
  const t = setup();
  const r2 = t.call("target", t.run, "github.com/org/app", SUMMARY);
  assert.equal(r2.status, 0, r2.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(t.run, "ledger", "target.json"), "utf8"));
  assert.equal(saved.id, 77);
  assert.equal(saved.summary_number, 1);
  const r3 = t.call("target", t.run, "github.com/org/app", "https://github.com/org/app/issues/2");
  assert.equal(r3.stdout.trim(), "target_mismatch");
});

test("所定の置き場所の外の実行フォルダは受け付けない", () => {
  const t = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "issue-outside-"));
  created.push(outside);
  fs.mkdirSync(path.join(outside, "ledger"));
  fs.writeFileSync(path.join(outside, "repo"), "/x\n");
  const r = t.call("status", outside);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /実行フォルダではありません/);
});

test("控えのない実行フォルダでは書かない", () => {
  const t = setup();
  const r = t.call("create", t.run, draft(t), "--item", "A01", "--key", "p1", "--fingerprint", "fp-1", "--sha", t.sha);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), "no_target");
});

test("create は修正 Issue を作って読み戻し、同じ fingerprint は作り直さない", () => {
  const t = setup();
  t.call("target", t.run, "github.com/org/app", SUMMARY);
  const d = draft(t);
  const r1 = t.call("create", t.run, d, "--item", "A01", "--key", "p1", "--fingerprint", "fp-1", "--sha", t.sha);
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /^created https:\/\/github\.com\/Org\/App\/issues\/2$/m);
  const s = t.read();
  assert.equal(s.issues[1].title, "[high] テストの題名");
  assert.deepEqual(s.issues[1].labels, ["agent:security-audit"]);
  assert.equal(s.labels[0].color, "b60205");
  const r2 = t.call("create", t.run, d, "--item", "A01", "--key", "p1", "--fingerprint", "fp-1", "--sha", t.sha);
  assert.match(r2.stdout, /^exists /);
  assert.equal(t.read().issues.length, 2);
  const log = fs.readFileSync(path.join(t.run, "ledger", "write-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(log.map((e) => e.phase), ["planned", "done"]);
});

test("create は空の本文・GitHub の重複・登録先の変化を断る", () => {
  const t = setup({ issues: [{ number: 2, id: 1002, title: "[high] 既存", body: "<!-- security-audit:fingerprint=fp-1 -->\n", state: "closed", labels: [] }] });
  t.call("target", t.run, "github.com/org/app", SUMMARY);
  const empty = path.join(t.run, "items", "empty.md");
  fs.writeFileSync(empty, "# [high] 題名\n\n\n");
  const r1 = t.call("create", t.run, empty, "--item", "A01", "--key", "p1", "--fingerprint", "fp-1", "--sha", t.sha);
  assert.equal(r1.stdout.trim(), "empty_body");
  const r2 = t.call("create", t.run, draft(t), "--item", "A01", "--key", "p1", "--fingerprint", "fp-1", "--sha", t.sha);
  assert.equal(r2.stdout.trim(), "duplicate https://github.com/Org/App/issues/2");
  const s = t.read();
  s.repo.id = 78;
  t.write(s);
  const r3 = t.call("create", t.run, draft(t, undefined, "fp-2"), "--item", "A01", "--key", "p1", "--fingerprint", "fp-2", "--sha", t.sha);
  assert.equal(r3.stdout.trim(), "target_changed");
});

test("label は無いラベルだけを決まった色で作り、別リポジトリの Issue には書かない", () => {
  const t = setup({ issues: [{ number: 2, id: 1002, title: "[high] a", body: "x", state: "open", labels: [] }], labels: [{ name: "agent:security-audit", color: "ededed", description: "" }] });
  t.call("target", t.run, "github.com/org/app", SUMMARY);
  const r1 = t.call("label", t.run, "https://github.com/org/app/issues/2", "agent:autofix");
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  const s = t.read();
  assert.equal(s.labels.find((l) => l.name === "agent:autofix").color, "0e8a16");
  assert.deepEqual(s.issues[1].labels, ["agent:autofix"]);
  t.call("label", t.run, "https://github.com/org/app/issues/2", "agent:security-audit");
  assert.equal(t.read().labels.find((l) => l.name === "agent:security-audit").color, "ededed");
  const r2 = t.call("label", t.run, "https://github.com/org/other/issues/2", "agent:autofix");
  assert.equal(r2.stdout.trim(), "other_repo");
});

test("sub-issue は親がなければ足し、別の親があれば付け替えない", () => {
  const t = setup({
    issues: [
      { number: 2, id: 1002, title: "a", body: "x", state: "open", labels: [] },
      { number: 3, id: 1003, title: "b", body: "y", state: "open", labels: [], parent: 9 },
      { number: 9, id: 1009, title: "old", body: "z", state: "closed", labels: [] },
    ],
  });
  t.call("target", t.run, "github.com/org/app", SUMMARY);
  const r1 = t.call("sub-issue", t.run, "https://github.com/org/app/issues/2");
  assert.equal(r1.stdout.trim(), "ok added https://github.com/org/app/issues/2");
  const r2 = t.call("sub-issue", t.run, "https://github.com/org/app/issues/2");
  assert.match(r2.stdout, /^ok already/);
  const r3 = t.call("sub-issue", t.run, "https://github.com/org/app/issues/3");
  assert.equal(r3.stdout.trim(), "other_parent https://github.com/Org/App/issues/9");
});

test("edit-body は本文が変わっていれば書かず、区画の中だけを書き換えて読み戻す", () => {
  const block = (x) => `<!-- security-audit:begin -->\n${x}\n<!-- security-audit:end -->\n`;
  const old = `担当者のメモ\n${block("old")}追記\n`;
  const t = setup({ issues: [{ number: 2, id: 1002, title: "a", body: old, state: "open", labels: [] }, { number: 3, id: 1003, title: "b", body: "区画なし\n", state: "open", labels: [] }] });
  t.call("target", t.run, "github.com/org/app", SUMMARY);
  const before = path.join(t.run, "ledger", "before.md");
  const after = path.join(t.run, "ledger", "after.md");
  fs.writeFileSync(before, "older\n");
  fs.writeFileSync(after, `担当者のメモ\n${block("new")}追記\n`);
  const r1 = t.call("edit-body", t.run, "https://github.com/org/app/issues/2", after, "--before", before);
  assert.equal(r1.stdout.trim(), "changed");
  fs.writeFileSync(before, old);
  const dropped = path.join(t.run, "ledger", "dropped.md");
  fs.writeFileSync(dropped, block("new"));
  const r0 = t.call("edit-body", t.run, "https://github.com/org/app/issues/2", dropped, "--before", before);
  assert.equal(r0.stdout.trim(), "outside_changed");
  const r2 = t.call("edit-body", t.run, "https://github.com/org/app/issues/2", after, "--before", before);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.equal(t.read().issues[1].body, `担当者のメモ\n${block("new")}追記\n`);
  fs.writeFileSync(before, "区画なし\n");
  const r4 = t.call("edit-body", t.run, "https://github.com/org/app/issues/3", after, "--before", before);
  assert.equal(r4.stdout.trim(), "no_audit_block");
  const r3 = t.call("edit-body", t.run, SUMMARY, after, "--before", path.join(t.run, "ledger", "missing.md"));
  assert.equal(r3.status, 3);
});

test("集約 Issue への書き込みは lock を取り直し、ほかの実行が持っていれば書かない", () => {
  const t = setup();
  t.call("target", t.run, "github.com/org/app", SUMMARY);
  const file = path.join(t.run, "ledger", "details.md");
  fs.writeFileSync(file, "<!-- security-audit:details-begin summary-id=x section=確定 part=1 -->\n詳細\n<!-- security-audit:details-end -->\n");
  const r1 = t.call("comment-create", t.run, file);
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /#issuecomment-5000$/m);
  const other = setup();
  other.call("target", other.run, "github.com/org/app", SUMMARY);
  const env = { ...process.env, SECURITY_AUDIT_LOCK_DIR: path.join(t.tmp, "locks") };
  const verify = path.join(DIR, "verify.mjs");
  const held = spawnSync(process.execPath, [verify, "lock", other.run, SUMMARY], { encoding: "utf8", env });
  assert.match(held.stdout, /^locked /);
  // ほかの実行が lock を持っている間は、集約 Issue に書かない
  const blocked = setup();
  blocked.call("target", blocked.run, "github.com/org/app", SUMMARY);
  const benv = { ...process.env, SECURITY_AUDIT_LOCK_DIR: path.join(blocked.tmp, "locks") };
  spawnSync(process.execPath, [verify, "lock", other.run, SUMMARY], { encoding: "utf8", env: benv });
  const bfile = path.join(blocked.run, "ledger", "details.md");
  fs.writeFileSync(bfile, "詳細\n");
  const r2 = blocked.call("comment-create", blocked.run, bfile);
  assert.equal(r2.status, 1);
  assert.match(r2.stdout, /^not_locked:locked /);
  assert.deepEqual(blocked.read().comments, []);
});

test("仮置きの形でない {{ }}（テンプレートの書き方）を含む本文は書ける", () => {
  const t = setup();
  t.call("target", t.run, "github.com/org/app", SUMMARY);
  const d = draft(t, `## コード上の根拠\n\n[app.rb:1](https://github.com/org/app/blob/${t.sha}/app.rb#L1) の \`\${{ secrets.TOKEN_NAME }}\` を使う。\n`);
  const r = t.call("create", t.run, d, "--item", "A01", "--key", "p1", "--fingerprint", "fp-1", "--sha", t.sha);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("status は予定だけで結果のない操作を出す", () => {
  const t = setup();
  fs.writeFileSync(path.join(t.run, "ledger", "write-log.jsonl"), [
    JSON.stringify({ op: "create", phase: "planned", item: "A01", fingerprint: "fp-1" }),
    JSON.stringify({ op: "label", phase: "planned", target: "u", label: "agent:autofix" }),
    JSON.stringify({ op: "label", phase: "done", target: "u", label: "agent:autofix" }),
  ].join("\n") + "\n");
  const r = t.call("status", t.run);
  assert.equal(r.stdout.trim(), "pending create A01 fp-1\ndone 1");
});
