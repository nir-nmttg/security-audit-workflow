import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CheckError, StructureError, assemble, check, checkBody, compose, fill, items, lock, lockRoot, retiredText, same, split, unlock } from "./summary-body.mjs";

const BASE = "https://github.com/o/r/issues/1#issuecomment-";
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "summary-body.mjs");

function details(id, filler = "") {
  return [`<details><summary><b>${id}</b> 題名${id}</summary>`, "", `- **概要**: 説明。${filler}`, `- **ID**: \`fp-${id}\``, "", "</details>"];
}

function full({ confirmed = ["A01"], needs = ["A02", "A03"], filler = "" } = {}) {
  const section = (name, ids) =>
    ids.length === 0
      ? [`## ${name}（0件）`, "", "0件。", ""]
      : [`## ${name}（${ids.length}件）`, "", "| No. | 題名 |", "| --- | --- |", ...ids.map((id) => `| ${id} | 題名${id} |`), "", ...ids.flatMap((id) => [...details(id, filler), ""])];
  return [
    "区画の前の追記",
    "<!-- security-audit:summary-begin -->",
    "<!-- security-audit:summary-id=audit-1 -->",
    "冒頭。",
    "",
    ...section("確定", confirmed),
    ...section("要検証", needs),
    ...section("未検証", []),
    ...section("棄却", []),
    ...section("未完了の工程・範囲", []),
    "## 調査の補足",
    "",
    "補足。",
    "<!-- security-audit:summary-end -->",
  ].join("\n");
}

// split の計画どおりにコメントを作ったものとして、本文とコメントを返す
function post(r, start = 1) {
  const comments = [];
  const urls = {};
  r.plan.forEach((p, i) => {
    if (p.op === "retire") return;
    const c = r.comments.find((x) => x.section === p.section && x.part === p.part);
    const id = p.comment_id ?? String(start + i);
    comments.push({ id, body: c.text, html_url: BASE + id });
    urls[`${p.section}:${p.part}`] = BASE + id;
  });
  return { body: fill(r.body, urls), comments };
}

test("リンクのない本文は compose しても変わらない", () => {
  // 前準備
  const text = full();
  // 実行・検証
  assert.equal(compose(text, []), text);
});

test("上限に収まり、まだ分けていない本文は分けない", () => {
  // 前準備
  const text = full();
  // 実行
  const r = split(text, text, []);
  // 検証
  assert.equal(r.mode, "single");
  assert.equal(r.body, text);
});

test("上限を超える全文は区分ごとに分け、部に分けても compose で元に戻る", () => {
  // 前準備
  const text = full({ filler: "あ".repeat(600) });
  // 実行
  const r = split(text, text, [], 1100);
  const { body, comments } = post(r);
  // 検証
  assert.equal(r.mode, "split");
  assert.ok(r.plan.filter((p) => p.section === "要検証").length >= 2);
  assert.ok(!body.includes("<details>"));
  assert.equal(compose(body, comments), text);
});

test("一度分けた本文は、全文が小さくなっても分けたままにし、変わらないコメントは書かない", () => {
  // 前準備
  const text = full({ filler: "あ".repeat(600) });
  const first = post(split(text, text, [], 1100));
  // 実行
  const r = split(text, first.body, first.comments);
  // 検証
  assert.equal(r.mode, "split");
  // 中身の変わる部は新しく作り、前のコメントは本文を書き換えたあとに retire する
  assert.ok(r.plan.some((p) => p.op === "create"));
  assert.ok(r.plan.some((p) => p.op === "retire"));
  assert.ok(r.plan.findIndex((p) => p.op === "retire") > r.plan.findLastIndex((p) => p.op !== "retire"));
  const again = post(r, 100);
  const r2 = split(text, again.body, again.comments);
  assert.ok(r2.plan.every((p) => p.op === "same"));
});

test("区分が空になったら、その詳細コメントは消さずに使わないものにする", () => {
  // 前準備
  const before = full({ filler: "あ".repeat(300) });
  const first = post(split(before, before, [], 1000));
  const after = full({ confirmed: [], needs: ["A02", "A03", "A01"], filler: "あ".repeat(300) });
  // 実行
  const r = split(after, first.body, first.comments, 1000);
  // 検証
  const retired = r.plan.find((p) => p.op === "retire");
  assert.equal(retired.section, "確定");
  assert.ok(retiredText("audit-1").includes("details-retired"));
});

test("リンク先のコメントが別の集約 Issue のものなら構造の異常にする", () => {
  // 前準備
  const text = full({ filler: "あ".repeat(300) });
  const { body, comments } = post(split(text, text, [], 1000));
  comments[0].body = comments[0].body.replace("summary-id=audit-1", "summary-id=other");
  // 実行・検証
  assert.throws(() => compose(body, comments), StructureError);
});

test("リンク先のコメントがなければ構造の異常にする", () => {
  // 前準備
  const text = full({ filler: "あ".repeat(300) });
  const { body } = post(split(text, text, [], 1000));
  // 実行・検証
  assert.throws(() => compose(body, []), StructureError);
});

test("URL を入れたあとの本文が上限を超えるときは fill が検査に外れる", () => {
  // 前準備
  const text = full({ filler: "あ".repeat(600) });
  const r = split(text, text, [], 1100);
  const urls = Object.fromEntries(r.plan.map((p) => [`${p.section}:${p.part}`, `${BASE}1`]));
  // 実行・検証
  assert.throws(() => fill(r.body, urls, r.body.length), CheckError);
});

test("1 項目だけで上限を超えるときは検査に外れる", () => {
  // 前準備
  const text = full({ filler: "あ".repeat(500) });
  // 実行・検証
  assert.throws(() => split(text, text, [], 400), CheckError);
});

// ここから、集約 Issue の全文の検査（check）・項目の移動（assemble）・番号の区切り・版・lock の確かめ

const HEADS = {
  確定: "| No. | 影響評価 | 題名 | 対応状況 |",
  要検証: "| No. | 領域 | 題名 | 判定に必要な確認 |",
  未検証: "| No. | 領域 | 題名 | 停止した工程 |",
  棄却: "| No. | 領域 | 題名 |",
  "未完了の工程・範囲": "| No. | 範囲 | 停止した工程 | 再開に必要なもの |",
};
const SECTION_NAMES = ["確定", "要検証", "未検証", "棄却", "未完了の工程・範囲"];
const CONCLUSION = "**結論**: 確定 1件、要検証 2件、未検証 0件、棄却 0件、未完了の工程・範囲 0件。";

// 項目の一覧表の行と詳細（2 列目は区分ごとの 2 列目：影響評価・領域・範囲）
const rowOf = (section, num, cell, title = `題名${num}`) => (section === "棄却" ? `| ${num} | ${cell} | ${title} |` : `| ${num} | ${cell} | ${title} | 項目 |`);
const detailOf = (num, extra = "") => [`<details><summary><b>${num}</b> 題名${num}</summary>`, "", `- **概要**: 説明${num}。${extra}`, `- **ID**: \`fp-${num}\``, "", "</details>"];

// 区分ごとの項目（[番号, 2 列目] の並び）から、集約 Issue の全文を組む。一覧表と詳細は渡した順に並べる
function summaryOf(sections, { conclusion = CONCLUSION, reverseDetails = false } = {}) {
  const out = ["区画の前の追記", "<!-- security-audit:summary-begin -->", "<!-- security-audit:summary-id=audit-1 -->", "<!-- security-audit:summary-revision=1 -->"];
  if (conclusion) out.push(conclusion);
  out.push("冒頭の説明。", "");
  for (const name of SECTION_NAMES) {
    if (name === "未完了の工程・範囲" && !(name in sections)) continue;
    const list = sections[name] ?? [];
    out.push(`## ${name}（${list.length}件）`, "");
    if (name === "未完了の工程・範囲") out.push("全体の状況を1〜2文で書く。", "");
    if (list.length === 0) {
      out.push("0件。", "");
      continue;
    }
    const cols = HEADS[name].split("|").length - 2;
    out.push(HEADS[name], `|${" --- |".repeat(cols)}`);
    for (const [num, cell] of list) out.push(rowOf(name, num, cell));
    out.push("");
    for (const [num] of reverseDetails ? [...list].reverse() : list) out.push(...detailOf(num), "");
  }
  out.push("## 調査の補足", "", "補足。", "<!-- security-audit:summary-end -->");
  return out.join("\n");
}

// 下書き（区分・一覧表の 1 行・詳細）の文字列
const draftText = (kind, num, cell, extra = "") => [`区分: ${kind}`, "", rowOf(kind, num, cell), "", ...detailOf(num, extra), ""].join("\n");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "summary-body-"));

function write(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text);
  return name;
}

function cli(args, input = "") {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test("check は正しい全文を通し、番号の重なり・件数・一覧表と詳細の順・区分の並び順の食い違いを理由の語で返す", () => {
  // 前準備
  const good = summaryOf({ 確定: [["A02", "critical"], ["A01", "medium"]], 要検証: [["A04", "決済"], ["A06", "決済"], ["A05", "認証"]] }, { conclusion: null });
  const dup = summaryOf({ 確定: [["A01", "high"]], 要検証: [["A01", "決済"]] }, { conclusion: null });
  const count = good.replace("## 確定（2件）", "## 確定（3件）");
  const order = summaryOf({ 確定: [["A01", "medium"], ["A02", "critical"]] }, { conclusion: null });
  const detailsOrder = summaryOf({ 要検証: [["A03", "決済"], ["A04", "決済"]] }, { conclusion: null, reverseDetails: true });
  // 実行・検証
  assert.deepEqual(check(good), []);
  assert.deepEqual(check(dup), ["duplicate_number:A01"]);
  assert.deepEqual(check(count), ["count_mismatch:確定"]);
  assert.deepEqual(check(order), ["order:確定"]);
  assert.deepEqual(check(detailsOrder), ["details_order:要検証"]);
  // 地域の区切りを崩した並び（決済・認証・決済）も止める
  assert.deepEqual(check(summaryOf({ 要検証: [["A04", "決済"], ["A05", "認証"], ["A06", "決済"]] }, { conclusion: null })), ["order:要検証"]);
  // 番号は数値で比べる（A9 < A10 < A100）
  assert.deepEqual(check(summaryOf({ 要検証: [["A9", "決済"], ["A10", "決済"], ["A100", "決済"]] }, { conclusion: null })), []);
  assert.deepEqual(check(summaryOf({ 要検証: [["A100", "決済"], ["A9", "決済"], ["A10", "決済"]] }, { conclusion: null })), ["order:要検証"]);
  const file = tmpDir();
  write(file, "bad.md", dup);
  assert.deepEqual(cli(["check", path.join(file, "bad.md")]), { code: 1, out: "duplicate_number:A01", err: "" });
  assert.deepEqual(cli(["check", path.join(file, "bad.md")]).code, 1);
  write(file, "good.md", good);
  assert.deepEqual(cli(["check", path.join(file, "good.md")]), { code: 0, out: "ok", err: "" });
});

test("assemble は項目を移し、一覧表と詳細を並び順の決まりで並べ、件数と結論と追記を直す", () => {
  // 前準備
  const dir = tmpDir();
  const before = summaryOf({ 確定: [["A01", "medium"]], 要検証: [["A04", "決済"], ["A05", "認証"], ["A06", "決済"]], "未完了の工程・範囲": [["U01", "範囲"]] }, { conclusion: "**結論**: 確定 1件、要検証 3件、未検証 0件、棄却 0件、未完了の工程・範囲 1件。" });
  write(dir, "a05.md", draftText("確定", "A05", "critical"));
  write(dir, "a07.md", draftText("要検証", "A07", "決済"));
  const plan = { items: [{ number: "A05", draft: "a05.md" }], new: [{ draft: "a07.md" }], note: "**2026-11-27 追記（手動）**: A05 を確定に移し、A07 を足した。" };
  // 実行
  const r = assemble(before, plan, dir);
  // 検証
  assert.deepEqual(check(r.text), []);
  assert.equal(r.conclusion, true);
  assert.deepEqual(r.counts, { 確定: 2, 要検証: 3, 未検証: 0, 棄却: 0, "未完了の工程・範囲": 1 });
  assert.ok(r.text.includes("**結論**: 確定 2件、要検証 3件、未検証 0件、棄却 0件、未完了の工程・範囲 1件。"));
  const ls = r.text.split("\n");
  assert.equal(ls[ls.findIndex((l) => l.startsWith("**結論**:")) + 1], plan.note);
  assert.ok(r.text.indexOf("| A05 |") < r.text.indexOf("| A01 |"));
  assert.ok(r.text.indexOf("| A04 |") < r.text.indexOf("| A06 |") && r.text.indexOf("| A06 |") < r.text.indexOf("| A07 |"));
  assert.ok(r.text.includes("## 未検証（0件）\n\n0件。"));
  assert.ok(r.text.includes("全体の状況を1〜2文で書く。"));
  assert.equal(items(r.text).items.A05.section, "確定");
});

test("assemble は 0 件の区分に入るときは表の見出しを作り、空になった区分は 0件。 にする", () => {
  // 前準備
  const dir = tmpDir();
  const before = summaryOf({ 確定: [["A01", "low"]] }, { conclusion: null });
  write(dir, "to-unverified.md", draftText("未検証", "A01", "機能"));
  // 実行
  const r = assemble(before, { items: [{ number: "A01", draft: "to-unverified.md" }] }, dir);
  // 検証
  assert.deepEqual(check(r.text), []);
  assert.ok(r.text.includes("## 未検証（1件）\n\n| No. | 領域 | 題名 | 停止した工程 |\n| --- | --- | --- | --- |\n| A01 | 機能 |"));
  assert.ok(r.text.includes("## 確定（0件）\n\n0件。"));
  assert.deepEqual(r.counts, { 確定: 0, 要検証: 0, 未検証: 1, 棄却: 0, "未完了の工程・範囲": 0 });
});

test("assemble は remove で統合して消す項目を表と詳細から消し、統合の記録がなければ止める", () => {
  // 前準備
  const dir = tmpDir();
  const before = summaryOf({ 要検証: [["A02", "認証"], ["A03", "認証"]] }, { conclusion: null });
  write(dir, "a02.md", draftText("要検証", "A02", "認証", "- **統合**: （統合: A03）"));
  // 実行
  const r = assemble(before, { items: [{ number: "A02", draft: "a02.md" }], remove: ["A03"] }, dir);
  // 検証
  assert.deepEqual(check(r.text), []);
  assert.equal(items(r.text).items.A03, undefined);
  assert.ok(r.text.includes("## 要検証（1件）"));
  // 統合の記録がないときは、消す項目を止める（書かずに終了コード 1）
  write(dir, "plain.md", draftText("要検証", "A02", "認証"));
  assert.throws(() => assemble(before, { items: [{ number: "A02", draft: "plain.md" }], remove: ["A03"] }, dir), (error) => error instanceof CheckError && error.message === "remove_without_merge_note:A03");
});

test("assemble は前の全文の形を変えず、検査に外れた計画は CheckError にする", () => {
  // 前準備
  const dir = tmpDir();
  const before = summaryOf({ 要検証: [["A02", "認証"], ["A03", "決済"]] });
  write(dir, "reuse.md", draftText("確定", "A02", "high"));
  write(dir, "placeholder.md", draftText("確定", "A02", "high", "{{ISSUE_URL:p1}}"));
  write(dir, "new-a01.md", draftText("要検証", "A01", "決済"));
  // 実行・検証
  assert.throws(() => assemble(before, { new: [{ draft: "new-a01.md" }] }, dir), (e) => e instanceof CheckError && e.message === "new_number_used:A01");
  assert.throws(() => assemble(before, { items: [{ number: "A02", draft: "placeholder.md" }] }, dir), (e) => e instanceof CheckError && e.message === "placeholder_left:ISSUE_URL:p1");
  assert.throws(() => assemble(before, { items: [{ number: "A03", draft: "reuse.md" }] }, dir), (e) => e instanceof CheckError && e.message === "draft_number:A03");
  assert.throws(() => assemble("not a summary", {}, dir), StructureError);
});

test("assemble は値を下書きに入れ、結論の行がなければ件数の 1 行を出して冒頭の最後の行のあとに追記を入れる（CLI）", () => {
  // 前準備
  const dir = tmpDir();
  const before = summaryOf({ 要検証: [["A02", "認証"]] }, { conclusion: null });
  write(dir, "a03.md", draftText("要検証", "A03", "{{REGION:p1}}"));
  write(dir, "plan.json", JSON.stringify({ items: [], new: [{ draft: "a03.md" }], values: { "REGION:p1": "決済" }, note: "**2026-11-27 追記（手動）**: A03 を足した。" }));
  write(dir, "before.md", before);
  // 実行
  const r = cli(["assemble", path.join(dir, "before.md"), path.join(dir, "plan.json"), path.join(dir, "out.md")]);
  // 検証
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "counts 確定=0 要検証=2 未検証=0 棄却=0 未完了の工程・範囲=0");
  const out = fs.readFileSync(path.join(dir, "out.md"), "utf8");
  assert.deepEqual(check(out), []);
  assert.ok(out.includes("| A03 | 決済 |"));
  const ls = out.split("\n");
  assert.equal(ls[ls.indexOf("冒頭の説明。") + 1], "**2026-11-27 追記（手動）**: A03 を足した。");
  // 壊れた前の全文は構造の異常（終了コード 2）、計画の JSON の形が違えば引数の誤り（終了コード 3）
  write(dir, "broken.md", before.replace("## 棄却（0件）", "## 棄却（1件）"));
  assert.equal(cli(["assemble", path.join(dir, "broken.md"), path.join(dir, "plan.json"), path.join(dir, "x.md")]).code, 2);
  write(dir, "badplan.json", "[]");
  assert.equal(cli(["assemble", path.join(dir, "before.md"), path.join(dir, "badplan.json"), path.join(dir, "x.md")]).code, 3);
  assert.equal(cli(["assemble", path.join(dir, "before.md"), path.join(dir, "plan.json"), path.join(dir, "x.md"), "--bump-revision", "0"]).code, 3);
  assert.equal(fs.existsSync(path.join(dir, "x.md")), false);
});

test("check-body の --bump-revision は版が開始時の版から +1 に変わるのだけを許す", () => {
  // 前準備
  const before = summaryOf({ 確定: [["A01", "high"]] });
  const bumped = before.replace("summary-revision=1", "summary-revision=2");
  // 実行・検証
  assert.deepEqual(checkBody(before, bumped, [], [], [], 1), []);
  assert.deepEqual(checkBody(before, bumped, [], [], []), ["audit_marker_changed"]);
  assert.deepEqual(checkBody(before, bumped, [], [], [], 2), ["audit_marker_changed"]);
  assert.deepEqual(checkBody(before, before.replace("summary-revision=1", "summary-revision=3"), [], [], [], 1), ["audit_marker_changed"]);
  assert.deepEqual(checkBody(before, bumped.replace("summary-id=audit-1", "summary-id=audit-2"), [], [], [], 1), ["audit_marker_changed"]);
});

test("check-body と same は番号をカンマ・空白・複数の引数のどの形でも受け付ける（CLI）", () => {
  // 前準備
  const dir = tmpDir();
  const before = summaryOf({ 要検証: [["A02", "認証"], ["A03", "決済"]] }, { conclusion: null });
  const after = summaryOf({ 確定: [["A02", "high"]], 要検証: [["A03", "新しい決済"]] }, { conclusion: null });
  write(dir, "before.md", before);
  write(dir, "after.md", after);
  write(dir, "start.json", JSON.stringify(items(before)));
  const b = path.join(dir, "before.md");
  const a = path.join(dir, "after.md");
  // 実行・検証
  assert.equal(cli(["check-body", b, a, "--targets", "A02"]).out, "item_changed:A03");
  assert.equal(cli(["check-body", b, a, "--targets", "A02,A03"]).out, "ok");
  assert.equal(cli(["check-body", b, a, "--targets", "A02 A03"]).out, "ok");
  assert.equal(cli(["check-body", b, a, "--targets", "A02", "A03"]).out, "ok");
  assert.equal(cli(["check-body", b, a, "--targets", "A02", "--new", "A09", "A10"]).code, 1);
  assert.deepEqual(cli(["same", path.join(dir, "start.json"), a, "A02", "A03"]), { code: 1, out: "A02 changed\nA03 changed", err: "" });
  assert.deepEqual(cli(["same", path.join(dir, "start.json"), a, "A02,A03"]), { code: 1, out: "A02 changed\nA03 changed", err: "" });
  assert.deepEqual(cli(["same", path.join(dir, "start.json"), a, "A02 A03"]), { code: 1, out: "A02 changed\nA03 changed", err: "" });
});

test("lock の置き場所は SECURITY_AUDIT_LOCK_DIR、なければリポジトリのルートの artifacts/security-audit-sync-issues/.locks で、シンボリックリンク経由でも同じ", () => {
  // 前準備
  const saved = process.env.SECURITY_AUDIT_LOCK_DIR;
  delete process.env.SECURITY_AUDIT_LOCK_DIR;
  try {
    const root = path.resolve(path.dirname(fs.realpathSync(SCRIPT)), "../../../..");
    // 実行・検証
    assert.equal(lockRoot(), path.join(root, "artifacts", "security-audit-sync-issues", ".locks"));
    // シンボリックリンク（名前は summary-body.mjs のまま）から、リンクのパスのまま読んでも同じ場所
    const link = path.join(tmpDir(), "summary-body.mjs");
    fs.symlinkSync(SCRIPT, link);
    const r = spawnSync(process.execPath, ["--preserve-symlinks", "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(link).href)}).then((m) => console.log(m.lockRoot()))`], { encoding: "utf8" });
    assert.equal(r.stdout.trim(), lockRoot());
  } finally {
    if (saved === undefined) delete process.env.SECURITY_AUDIT_LOCK_DIR;
    else process.env.SECURITY_AUDIT_LOCK_DIR = saved;
  }
});

test("lock は同じ集約 Issue なら、実行フォルダの場所によらず同じ lock になり、名前は小文字の host・owner・repo と番号", (t) => {
  // 前準備
  const root = tmpDir();
  const saved = process.env.SECURITY_AUDIT_LOCK_DIR;
  process.env.SECURITY_AUDIT_LOCK_DIR = path.join(root, "locks");
  t.after(() => {
    if (saved === undefined) delete process.env.SECURITY_AUDIT_LOCK_DIR;
    else process.env.SECURITY_AUDIT_LOCK_DIR = saved;
  });
  const runA = path.join(root, "a", "run-1");
  const runB = path.join(root, "x", "y", "run-2");
  for (const run of [runA, runB]) {
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, "repo"), "/x\n");
  }
  // 実行・検証
  assert.equal(lock(runA, "https://GitHub.com/Owner/Repo/issues/12"), "ok");
  assert.match(lock(runB, "https://github.com/owner/repo/issues/12"), /^locked /);
  process.exitCode = 0;
  assert.deepEqual(fs.readdirSync(path.join(root, "locks")), ["github.com_owner_repo_12"]);
  assert.equal(unlock(runA, "https://github.com/owner/repo/issues/12"), "ok");
  assert.equal(lock(runB, "https://github.com/owner/repo/issues/12"), "ok");
});

test("items と same は集約 Issue の項目を番号ごとに返す", () => {
  const text = summaryOf({ 確定: [["A01", "high"]], 要検証: [["A02", "認証"]] });
  const r = items(text);
  assert.deepEqual(r.default_targets, ["A02"]);
  assert.equal(r.items.A01.section, "確定");
  assert.deepEqual(same(r, text, ["A01", "A02", "A09"]), [
    ["A01", "same"],
    ["A02", "same"],
    ["A09", "missing"],
  ]);
  // 区画の終わりがなければ構造の異常（check も止める）
  assert.throws(() => check(text.replace("<!-- security-audit:summary-end -->", "")), (error) => error instanceof StructureError && error.message === "summary_block");
});

test("assemble の --bump-revision は版の行を +1 にし、続きの監査の追記の行を許す", () => {
  // 前準備
  const dir = tmpDir();
  const before = summaryOf({ 確定: [["A01", "high"]], 要検証: [["A02", "決済"]] }, { conclusion: "**結論**: 確定 1件、要検証 1件、未検証 0件、棄却 0件、未完了の工程・範囲 0件。" });
  write(dir, "a02.md", draftText("棄却", "A02", "決済"));
  const plan = { items: [{ number: "A02", draft: "a02.md" }], note: "**2026-11-27 追記（続きの監査）**: 0123456789ab で A02 を調べ直した。" };
  // 実行
  const r = assemble(before, plan, dir, 1);
  // 検証
  assert.ok(r.text.includes("<!-- security-audit:summary-revision=2 -->"));
  assert.ok(r.text.includes(plan.note));
  assert.throws(() => assemble(before.replace("summary-revision=1", "summary-revision=3"), plan, dir, 1), CheckError);
  assert.throws(() => assemble(before, { ...plan, note: "**2026-11-27 追記（自動）**: x" }, dir), CheckError);
});

test("assemble は informational と info を同じ順位にして、影響評価の高い順に並べる", () => {
  // 前準備
  const dir = tmpDir();
  const before = summaryOf({ 確定: [["A01", "informational"]], 要検証: [["A02", "決済"]] }, { conclusion: "**結論**: 確定 1件、要検証 1件、未検証 0件、棄却 0件、未完了の工程・範囲 0件。" });
  write(dir, "a02.md", draftText("確定", "A02", "low"));
  // 実行
  const r = assemble(before, { items: [{ number: "A02", draft: "a02.md" }] }, dir);
  // 検証
  assert.ok(r.text.indexOf("| A02 |") < r.text.indexOf("| A01 |"));
  assert.deepEqual(check(r.text), []);
});

test("lock は security-audit-sync-issues の実行フォルダ（run-metadata.json がある）でも使え、どちらでもないフォルダは断る", (t) => {
  // 前準備
  const root = tmpDir();
  const saved = process.env.SECURITY_AUDIT_LOCK_DIR;
  process.env.SECURITY_AUDIT_LOCK_DIR = path.join(root, "locks");
  t.after(() => {
    if (saved === undefined) delete process.env.SECURITY_AUDIT_LOCK_DIR;
    else process.env.SECURITY_AUDIT_LOCK_DIR = saved;
  });
  const codexRun = path.join(root, "security-audit-skill", "app", "run-3");
  const other = path.join(root, "other");
  fs.mkdirSync(codexRun, { recursive: true });
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(codexRun, "run-metadata.json"), "{}\n");
  // 実行・検証
  assert.equal(lock(codexRun, "https://github.com/o/r/issues/5"), "ok");
  assert.throws(() => lock(other, "https://github.com/o/r/issues/5"), /実行フォルダではありません/);
  assert.equal(unlock(codexRun, "https://github.com/o/r/issues/5"), "ok");
});

test("assemble は区分「削除」の U を統合の記録なしで消し、A の削除は統合の記録を求め、--targets の外の番号を断る", () => {
  // 前準備
  const dir = tmpDir();
  const before = summaryOf({ 要検証: [["A02", "認証"]], "未完了の工程・範囲": [["U01", "範囲"], ["U02", "範囲"]] }, { conclusion: null });
  write(dir, "u01.md", "区分: 削除\n");
  write(dir, "a02.md", "区分: 削除\n");
  write(dir, "a05.md", draftText("確定", "A05", "high"));
  // 実行・検証
  const r = assemble(before, { items: [{ number: "U01", draft: "u01.md" }], new: [{ draft: "a05.md" }] }, dir);
  assert.equal(items(r.text).items.U01, undefined);
  assert.ok(r.text.includes("## 未完了の工程・範囲（1件）"));
  assert.deepEqual(check(r.text), []);
  assert.throws(() => assemble(before, { items: [{ number: "A02", draft: "a02.md" }] }, dir), CheckError);
  assert.throws(() => assemble(before, { items: [{ number: "U01", draft: "u01.md" }] }, dir, null, ["U02"]), (error) => error instanceof CheckError && error.message === "not_approved:U01");
  assert.doesNotThrow(() => assemble(before, { items: [{ number: "U01", draft: "u01.md" }] }, dir, null, ["U01"]));
});

test("assemble の --targets は new の番号も確かめ、最後の U を消すと区分の説明も外し、結論の行の書き換えを通す", () => {
  // 前準備
  const dir = tmpDir();
  const before = summaryOf({ 要検証: [["A02", "認証"]], "未完了の工程・範囲": [["U01", "範囲"]] }, { conclusion: "**結論**: 確定 0件・要検証 1件・未検証 0件・棄却 0件、未完了の工程・範囲 1件。Issue 反映は pending。" });
  write(dir, "u01.md", "区分: 削除\n");
  write(dir, "a05.md", draftText("確定", "A05", "high"));
  const plan = { items: [{ number: "U01", draft: "u01.md" }], new: [{ draft: "a05.md" }] };
  // 実行・検証
  assert.throws(() => assemble(before, plan, dir, null, ["U01"]), (error) => error instanceof CheckError && error.message === "not_approved:A05");
  const r = assemble(before, plan, dir, null, ["U01", "A05"]);
  assert.ok(r.text.includes("## 未完了の工程・範囲（0件）\n\n0件。"));
  assert.ok(!r.text.includes("全体の状況を1〜2文で書く。"));
  const status = r.text.replace("Issue 反映は pending。", "Issue 反映は complete。");
  assert.deepEqual(checkBody(before, status, ["U01"], ["A05"], []), []);
});
