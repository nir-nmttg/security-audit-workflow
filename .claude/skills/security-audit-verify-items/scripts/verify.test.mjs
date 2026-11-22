import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkBody, checkIssue, checkSecrets, items, lock, parse, pick, same, unlock } from "./verify.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "verify.mjs");
const SHA2 = "b".repeat(40);

function details(id, title, extra = []) {
  return [`<details><summary><b>${id}</b> ${title}</summary>`, "", "- **概要**: 説明。", ...extra, `- **ID**: \`fp-${id}\``, "", "</details>", ""];
}

function body({ confirmed = [], needs = ["A02", "A03"], unverified = [], rejected = [], incomplete = [], notes = [], extra = {}, incompleteNote = [] } = {}) {
  const section = (name, ids, header, note = []) => {
    if (ids.length === 0) return [`## ${name}（0件）`, "", "0件。", ""];
    return [
      `## ${name}（${ids.length}件）`,
      "",
      ...note,
      header,
      "| --- | --- | --- |",
      ...ids.map((id) => `| ${id} | 領域 | 題名${id} |`),
      "",
      ...ids.flatMap((id) => details(id, `題名${id}`, extra[id] ?? [])),
    ];
  };
  return [
    "人の追記",
    "<!-- security-audit:summary-begin -->",
    "<!-- security-audit:summary-id=audit-1 -->",
    "<!-- security-audit:summary-revision=1 -->",
    `<!-- security-audit:source-sha=${SHA2} -->`,
    `冒頭の説明。確定 ${confirmed.length} 件、要検証 ${needs.length} 件。`,
    ...notes,
    "",
    ...section("確定", confirmed, "| No. | 影響評価 | 題名 | 対応状況 |"),
    ...section("要検証", needs, "| No. | 領域 | 題名 | 判定に必要な確認 |"),
    ...section("未検証", unverified, "| No. | 領域 | 題名 | 停止した工程 |"),
    ...section("棄却", rejected, "| No. | 領域 | 題名 |"),
    ...section("未完了の工程・範囲", incomplete, "| No. | 範囲 | 停止した工程 | 再開に必要なもの |", incompleteNote),
    "## 調査の補足",
    "",
    "補足の文。",
    "<!-- security-audit:summary-end -->",
    "区画の後の追記",
  ].join("\n");
}

function tmp(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-items-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

function run(args, input = "") {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test("parse は項目ごとに区分と ID を取り出す", () => {
  const p = parse(body({ confirmed: ["A01"], needs: ["A02"] }));
  assert.equal(p.items.get("A01").section, "確定");
  assert.equal(p.items.get("A02").id, "fp-A02");
});

test("parse は件数と一覧表の行数の食い違いを構造の異常にする", () => {
  const text = body({ needs: ["A02", "A03"] }).replace("## 要検証（2件）", "## 要検証（3件）");
  const r = run(["items", tmp("b.md", text)]);
  assert.equal(r.code, 2);
  assert.equal(r.out, "count_mismatch:needs_validation");
});

test("pick はタイトルの日付が最も新しい集約 Issue を選び、マーカーのないものと閉じたものを除く", () => {
  const ok = "<!-- security-audit:summary-id=x -->";
  const list = [
    { number: 1, title: "[2026-11-10] セキュリティ監査の調査・判定一覧", body: ok, state: "OPEN", createdAt: "2026-11-10T00:00:00Z" },
    { number: 2, title: "[2026-11-16] セキュリティ監査の調査・判定一覧", body: "マーカーなし", state: "OPEN", createdAt: "2026-11-16T00:00:00Z" },
    { number: 3, title: "[2026-11-15] セキュリティ監査の調査・判定一覧", body: ok, state: "CLOSED", createdAt: "2026-11-15T00:00:00Z" },
    { number: 4, title: "[2026-11-12] セキュリティ監査の調査・判定一覧", body: ok, state: "OPEN", createdAt: "2026-11-12T00:00:00Z" },
    { number: 5, title: "[2026-11-12] セキュリティ監査の調査・判定一覧", body: ok, state: "OPEN", createdAt: "2026-11-12T09:00:00Z" },
  ];
  assert.equal(pick(list), "5");
  assert.equal(run(["pick"], JSON.stringify(list)).out, "5");
  assert.equal(run(["pick"], "[]").code, 2);
});

test("items と same で、調査開始時からの項目の変化を見つける", () => {
  const start = items(body({ needs: ["A02", "A03"] }));
  assert.deepEqual(start.default_targets, ["A02", "A03"]);
  const now = body({ needs: ["A02", "A03"], extra: { A03: ["- **人の追記**: 足した。"] } });
  assert.deepEqual(same(start, now, ["A02", "A03", "A09"]), [
    ["A02", "same"],
    ["A03", "changed"],
    ["A09", "missing"],
  ]);
  const r = run(["same", tmp("s.json", JSON.stringify(start)), tmp("b.md", now), "A02", "A03"]);
  assert.equal(r.code, 1);
  assert.equal(r.out, "A02 same\nA03 changed");
});

test("items は番号を省いたときの対象を要検証・未検証・未完了の工程・範囲の順に出す", () => {
  const all = items(body({ confirmed: ["A01"], needs: ["A05"], unverified: ["A03"], rejected: ["A04"], incomplete: ["U01", "U02"] }));
  assert.deepEqual(all.default_targets, ["A05", "A03", "U01", "U02"]);
  const noIncomplete = body({ needs: ["A02"] }).replace(/## 未完了の工程・範囲[\s\S]*?(?=## 調査の補足)/, "");
  assert.deepEqual(items(noIncomplete).default_targets, ["A02"]);
});

test("check-body は対象の移動・件数・追記の行だけの変更を通す", () => {
  const before = body({ confirmed: ["A01"], needs: ["A02", "A03"] });
  const after = body({ confirmed: ["A01", "A02"], needs: ["A03"], notes: ["**2026-11-16 追記（手動）**: A02 を確定に移した。"] });
  assert.deepEqual(checkBody(before, after, ["A02"]), []);
  assert.equal(run(["check-body", tmp("a.md", before), tmp("b.md", after), "--targets", "A02"]).out, "ok");
});

test("check-body は対象外の項目と区画の外の変更、前からある追記の行の削除を止める", () => {
  const before = body({ needs: ["A02", "A03"], notes: ["**2026-11-10 追記（手動）**: 前の追記。"] });
  const changed = body({ needs: ["A02", "A03"], notes: ["**2026-11-10 追記（手動）**: 前の追記。"], extra: { A03: ["- **概要2**: 書き換え。"] } });
  assert.deepEqual(checkBody(before, changed, ["A02"]), ["item_changed:A03"]);
  assert.deepEqual(checkBody(before, before.replace("区画の後の追記", "書き換え"), ["A02"]), ["outside_changed"]);
  const noteRemoved = body({ needs: ["A02", "A03"] });
  assert.deepEqual(checkBody(before, noteRemoved, ["A02"]), ["other_text_changed"]);
});

test("check-body は新しい番号を最大の番号より後に限り、届け出ていない追加を止める", () => {
  const before = body({ needs: ["A02", "A03"], incomplete: ["U01"] });
  const after = body({ confirmed: ["A04"], needs: ["A02", "A03"] });
  assert.deepEqual(checkBody(before, after, ["U01"], ["A04"]), []);
  assert.deepEqual(checkBody(before, after, ["U01"]), ["item_added:A04"]);
  const reused = body({ confirmed: ["A03"], needs: ["A02"] });
  assert.ok(checkBody(before, reused, ["U01"], ["A03"]).includes("new_number_used:A03"));
});

test("check-body は対象の A 番号の項目が消えたときに止め、全文の長さでは止めない", () => {
  const before = body({ needs: ["A02", "A03"] });
  assert.deepEqual(checkBody(before, body({ needs: ["A03"] }), ["A02"]), ["target_not_in_after:A02"]);
  // 上限は本文とコメントに分ける split で確かめる
  const long = body({ needs: ["A02", "A03"], extra: { A02: [`- **概要2**: ${"あ".repeat(60000)}`] } });
  assert.deepEqual(checkBody(before, long, ["A02"]), []);
});

test("verify.mjs から compose と split を呼べ、上限を超える全文は分けて戻すと元に戻る", () => {
  // 前準備
  const full = body({ needs: ["A02", "A03"], extra: { A02: [`- **概要2**: ${"あ".repeat(1200)}`] } });
  const dir = path.dirname(tmp("full.md", full));
  const fullFile = path.join(dir, "full.md");
  const comments = path.join(dir, "comments.json");
  fs.writeFileSync(comments, "[]");
  // 実行
  const r = run(["split", fullFile, path.join(dir, "out"), "--body", fullFile, "--comments", comments, "--max", "1600"]);
  // 検証
  assert.equal(r.code, 0, r.out + r.err);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "out", "plan.json"), "utf8")).plan;
  assert.ok(plan.length >= 1);
  const base = "https://github.com/o/r/issues/1#issuecomment-";
  fs.writeFileSync(comments, JSON.stringify(plan.map((p, i) => ({ id: i + 1, body: fs.readFileSync(p.file, "utf8"), html_url: base + (i + 1) }))));
  const urls = plan.flatMap((p, i) => ["--url", `${p.section}:${p.part}=${base}${i + 1}`]);
  assert.equal(run(["fill", path.join(dir, "out", "body.md"), path.join(dir, "body.md"), ...urls]).code, 0);
  assert.equal(run(["compose", path.join(dir, "body.md"), comments, path.join(dir, "back.md")]).code, 0);
  assert.equal(fs.readFileSync(path.join(dir, "back.md"), "utf8"), full);
});

test("split は --body と --comments を省くと、新しく作る集約 Issue として分ける", () => {
  // 前準備
  const full = body({ needs: ["A02", "A03"], extra: { A02: [`- **概要2**: ${"あ".repeat(1200)}`] } });
  const file = tmp("full.md", full);
  const dir = path.dirname(file);
  const comments = path.join(dir, "c.json");
  fs.writeFileSync(comments, "[]");
  // 実行
  const created = run(["split", file, path.join(dir, "new"), "--max", "1600"]);
  const given = run(["split", file, path.join(dir, "given"), "--body", file, "--comments", comments, "--max", "1600"]);
  const half = run(["split", file, path.join(dir, "half"), "--body", file]);
  // 検証
  assert.equal(created.code, 0, created.out + created.err);
  assert.equal(created.out, given.out);
  assert.match(created.out, /^mode split\n/);
  assert.equal(fs.readFileSync(path.join(dir, "new", "body.md"), "utf8"), fs.readFileSync(path.join(dir, "given", "body.md"), "utf8"));
  assert.equal(half.code, 3);
});

test("split と fill は --max に正の整数でない値を受け付けない", () => {
  const file = tmp("full.md", body({ needs: ["A02"] }));
  assert.equal(run(["split", file, path.join(path.dirname(file), "out"), "--max", "abc"]).code, 3);
  assert.equal(run(["fill", file, path.join(path.dirname(file), "out.md"), "--max", "abc"]).code, 3);
});

test("split は本文だけで上限を超えるとき終了コード 1 で止める", () => {
  const full = body({ needs: ["A02"] });
  const file = tmp("full.md", full);
  const comments = path.join(path.dirname(file), "c.json");
  fs.writeFileSync(comments, "[]");
  const r = run(["split", file, path.join(path.dirname(file), "out"), "--body", file, "--comments", comments, "--max", "100"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^(too_long_body|details_too_long):/);
});

function lockRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-items-lock-"));
  const make = (name) => {
    const run = path.join(root, name);
    fs.mkdirSync(run);
    fs.writeFileSync(path.join(run, "repo"), "/x\n");
    return run;
  };
  return { a: make("a"), b: make("b") };
}

test("lock はほかの実行が持っている間は取れず、持ち主が外すと取れる", () => {
  // 前準備
  const { a, b } = lockRun();
  const url = "https://github.com/o/r/issues/1";
  // 実行・検証
  assert.equal(lock(a, url), "ok");
  assert.equal(lock(a, url), "ok");
  process.exitCode = 0;
  assert.match(lock(b, url), /^locked /);
  process.exitCode = 0;
  assert.match(unlock(b, url), /^locked /);
  process.exitCode = 0;
  assert.equal(unlock(a, url), "ok");
  assert.equal(lock(b, url), "ok");
});

test("lock は 30 分を過ぎた持ち主から引き継ぐ", () => {
  // 前準備
  const { a, b } = lockRun();
  const url = "https://github.com/o/r/issues/1";
  lock(a, url, Date.now() - 31 * 60 * 1000);
  // 実行
  const r = lock(b, url);
  // 検証
  assert.match(r, /^ok taken_over:/);
});

test("古い lock を引き継いだあとは、ほかの実行は引き継げない", () => {
  // 前準備
  const { a, b } = lockRun();
  const c = path.join(path.dirname(a), "c");
  fs.mkdirSync(c);
  fs.writeFileSync(path.join(c, "repo"), "/x\n");
  const url = "https://github.com/O/R/issues/1";
  lock(a, url, Date.now() - 31 * 60 * 1000);
  // 実行
  const first = lock(b, url);
  const second = lock(c, "https://github.com/o/r/issues/1");
  process.exitCode = 0;
  // 検証
  assert.match(first, /^ok taken_over:/);
  assert.match(second, /^locked /);
});

test("lock を置く直前に別の実行が置いたら、置かずに locked を返す", (t) => {
  // 前準備
  const { a, b } = lockRun();
  const url = "https://github.com/o/r/issues/1";
  const rename = fs.renameSync;
  let bResult;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (bResult === undefined && from.includes(".new-") && to.endsWith("github.com_o_r_1")) {
      fs.renameSync.mock.restore();
      bResult = lock(b, url);
    }
    return rename(from, to);
  });
  // 実行
  const aResult = lock(a, url);
  process.exitCode = 0;
  // 検証
  assert.equal(bResult, "ok");
  assert.match(aResult, new RegExp(`^locked ${fs.realpathSync(b)} `));
  assert.deepEqual(fs.readdirSync(path.join(fs.realpathSync(path.dirname(a)), ".locks")), ["github.com_o_r_1"]);
});

test("古い lock を読んでから名前を変えるまでに別の実行が引き継いだら、その lock を奪わない", (t) => {
  // 前準備
  const { a, b } = lockRun();
  const c = path.join(path.dirname(a), "c");
  fs.mkdirSync(c);
  fs.writeFileSync(path.join(c, "repo"), "/x\n");
  const url = "https://github.com/o/r/issues/1";
  lock(a, url, Date.now() - 31 * 60 * 1000);
  // b が古い lock の名前を変える直前に、c が引き継ぎを済ませる
  const rename = fs.renameSync;
  let cResult;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (cResult === undefined && to.includes(".stale-")) {
      fs.renameSync.mock.restore();
      cResult = lock(c, url);
    }
    return rename(from, to);
  });
  // 実行
  const bResult = lock(b, url);
  process.exitCode = 0;
  // 検証
  assert.match(cResult, /^ok taken_over:/);
  assert.match(bResult, new RegExp(`^locked ${fs.realpathSync(c)} `));
  assert.equal(lock(c, url), "ok");
  assert.deepEqual(
    fs.readdirSync(path.join(fs.realpathSync(path.dirname(a)), ".locks")).filter((n) => n.includes(".stale-")),
    [],
  );
});

test("check-body は冒頭の件数の桁が変わっても通す", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `A${String(i + 1).padStart(2, "0")}`);
  const before = body({ confirmed: nine, needs: ["A10"] });
  const after = body({ confirmed: [...nine, "A10"], needs: [] });
  assert.deepEqual(checkBody(before, after, ["A10"]), []);
});

test("check-body は U の項目を直すときだけ、未完了の工程・範囲の説明の変更を通す", () => {
  const before = body({ incomplete: ["U01"], incompleteNote: ["1 件が初期調査で止まっている。", ""] });
  const after = body({ incomplete: [] });
  assert.deepEqual(checkBody(before, after, ["U01"]), []);
  const otherChanged = body({ incomplete: ["U01"], incompleteNote: ["書き換えた。", ""] });
  assert.deepEqual(checkBody(before, otherChanged, ["A02"]), ["other_text_changed"]);
});

test("check-body は統合の記録があるときだけ、統合した項目を消すのを通す", () => {
  const before = body({ needs: ["A02", "A03"] });
  const merged = body({ confirmed: ["A02"], needs: [], extra: { A02: ["- **統合**: （統合: A03）"] } });
  assert.deepEqual(checkBody(before, merged, ["A02", "A03"], [], ["A03"]), []);
  const noNote = body({ confirmed: ["A02"], needs: [] });
  assert.deepEqual(checkBody(before, noNote, ["A02", "A03"], [], ["A03"]), ["remove_without_merge_note:A03"]);
  assert.deepEqual(checkBody(before, noNote, ["A02", "A03"]), ["target_not_in_after:A03"]);
});

test("check-body は置き換え忘れの印を止める", () => {
  const before = body({ needs: ["A02", "A03"] });
  const after = body({ confirmed: ["A02"], needs: ["A03"], extra: { A02: ["- **反映結果**: {{REFLECTION:p1}}"] } });
  assert.deepEqual(checkBody(before, after, ["A02"]), ["placeholder_left"]);
});

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-items-repo-"));
  const g = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g("init", "-q");
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app", "a.rb"), "line1\nline2\nline3\n");
  g("add", ".");
  g("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(dir, ".env"), "SECRET_KEY='abcdefgh12345'\nSHORT=abc\nNODE_ENV=development\nURL=http://localhost:3000\nDB_PASSWORD=ExampleSecretPassword\n");
  fs.mkdirSync(path.join(dir, "app", "(auth)"));
  fs.writeFileSync(path.join(dir, "app", "(auth)", "page.tsx"), "a\nb\nc\n");
  g("add", "app");
  g("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "route group");
  const sha = g("rev-parse", "HEAD").stdout.trim();
  return { dir, sha };
}

function draft(sha, { fp = "fp-A02", extra = "" } = {}) {
  return [
    "# [high] 管理画面を開ける",
    "<!-- security-audit:begin -->",
    `<!-- security-audit:fingerprint=${fp} -->`,
    `<!-- security-audit:source-sha=${sha} -->`,
    "## コード上の根拠",
    `[app/a.rb:2-3](https://github.com/o/r/blob/${sha}/app/a.rb#L2-L3)`,
    extra,
    "<!-- security-audit:end -->",
  ].join("\n");
}

test("check-issue は正しい下書きを通す", () => {
  const { dir, sha } = repo();
  assert.deepEqual(checkIssue(draft(sha), "fp-A02", sha, dir), []);
  const r = run(["check-issue", tmp("d.md", draft(sha)), "--fingerprint", "fp-A02", "--sha", sha, "--worktree", dir]);
  assert.equal(r.out, "ok");
});

test("check-issue はマーカーの食い違い・タイトルの形・completed-at を止める", () => {
  const { dir, sha } = repo();
  assert.deepEqual(checkIssue(draft(sha, { fp: "fp-other" }), "fp-A02", sha, dir), ["fingerprint_mismatch"]);
  assert.deepEqual(checkIssue(draft(sha).replace("# [high] ", "# "), "fp-A02", sha, dir), ["title_line"]);
  assert.deepEqual(checkIssue(draft(sha, { extra: "<!-- security-audit:completed-at=2026-11-16T00:00:00+09:00 -->" }), "fp-A02", sha, dir), ["completed_at_present"]);
});

test("check-issue は固定されていないリンクとリンクのない下書きを止め、括弧を含むパスを通す", () => {
  const { dir, sha } = repo();
  const branch = draft(sha, { extra: "https://github.com/o/r/blob/main/app/a.rb#L2" });
  assert.deepEqual(checkIssue(branch, "fp-A02", sha, dir), ["link_not_pinned:https://github.com/o/r/blob/main/app/a.rb#L2"]);
  const none = draft(sha).replace(/^\[app.*$/m, "");
  assert.deepEqual(checkIssue(none, "fp-A02", sha, dir), ["no_code_link"]);
  const paren = draft(sha, { extra: `[app/(auth)/page.tsx:3](https://github.com/o/r/blob/${sha}/app/(auth)/page.tsx#L3)` });
  assert.deepEqual(checkIssue(paren, "fp-A02", sha, dir), []);
});

test("check-issue は存在しないパスと行の範囲外のリンクを止める", () => {
  const { dir, sha } = repo();
  const missing = draft(sha, { extra: `https://github.com/o/r/blob/${sha}/app/none.rb#L1` });
  assert.deepEqual(checkIssue(missing, "fp-A02", sha, dir), [`link_path_missing:https://github.com/o/r/blob/${sha}/app/none.rb#L1`]);
  const out = draft(sha, { extra: `https://github.com/o/r/blob/${sha}/app/a.rb#L4` });
  assert.deepEqual(checkIssue(out, "fp-A02", sha, dir), [`link_line_out_of_range:https://github.com/o/r/blob/${sha}/app/a.rb#L4`]);
});

test("check-issue は .env の値とトークンらしい文字列を止める", () => {
  const { dir, sha } = repo();
  assert.deepEqual(checkIssue(draft(sha, { extra: "鍵は abcdefgh12345 だった" }), "fp-A02", sha, dir), ["env_value_present:.env:SECRET_KEY"]);
  assert.deepEqual(checkIssue(draft(sha, { extra: "development 環境の http://localhost:3000 で確かめた。src/task-management-controller-service.ts" }), "fp-A02", sha, dir), []);
  const token = draft(sha, { extra: `ghp_${"x".repeat(30)}` });
  assert.equal(checkIssue(token, "fp-A02", sha, dir).length, 1);
  assert.ok(checkIssue(token, "fp-A02", sha, dir)[0].startsWith("token_like:"));
});

test("check-issue は英字だけの秘密の値も止める", () => {
  const { dir, sha } = repo();
  assert.deepEqual(checkIssue(draft(sha, { extra: "ExampleSecretPassword で入れた" }), "fp-A02", sha, dir), ["env_value_present:.env:DB_PASSWORD"]);
});

test("check-issue は隣り合うリンクのそれぞれを検査する", () => {
  const { dir, sha } = repo();
  const two = draft(sha, { extra: `[a](https://github.com/o/r/blob/${sha}/app/a.rb)、[b](https://github.com/o/r/blob/main/app/a.rb)` });
  assert.deepEqual(checkIssue(two, "fp-A02", sha, dir), ["link_not_pinned:https://github.com/o/r/blob/main/app/a.rb"]);
  const paren = draft(sha, { extra: `[c](https://github.com/o/r/blob/${sha}/app/(auth)/page.tsx)` });
  assert.deepEqual(checkIssue(paren, "fp-A02", sha, dir), []);
});

test("check-secrets は bare リポジトリを作業ツリーとして受け付けない", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "verify-items-bare-"));
  spawnSync("git", ["init", "-q", "--bare", bare]);
  assert.equal(run(["check-secrets", tmp("x.md", "x"), "--worktree", bare]).code, 3);
});

test("check-secrets は本文の秘密らしい文字列と置き換え忘れを止める", () => {
  const { dir } = repo();
  assert.deepEqual(checkSecrets("値 abcdefgh12345 と {{ISSUE_URL:p1}}", dir), ["env_value_present:.env:SECRET_KEY", "placeholder_left"]);
  assert.equal(run(["check-secrets", tmp("x.md", "問題なし"), "--worktree", dir]).out, "ok");
  assert.equal(run(["check-secrets", tmp("x.md", "x"), "--worktree", path.join(dir, "none")]).code, 3);
});

test("引数の誤りは終了コード 3", () => {
  assert.equal(run(["check-body", "a"]).code, 3);
  assert.equal(run(["same", "a", "b", "X1"]).code, 3);
  assert.equal(run(["nope"]).code, 3);
});
