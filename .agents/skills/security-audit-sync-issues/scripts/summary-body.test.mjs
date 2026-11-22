import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckError, StructureError, compose, fill, retiredText, split } from "./summary-body.mjs";

const BASE = "https://github.com/o/r/issues/1#issuecomment-";

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
  const text = full({ filler: "あ".repeat(200) });
  // 実行
  const r = split(text, text, [], 700);
  const { body, comments } = post(r);
  // 検証
  assert.equal(r.mode, "split");
  assert.ok(r.plan.filter((p) => p.section === "要検証").length >= 2);
  assert.ok(!body.includes("<details>"));
  assert.equal(compose(body, comments), text);
});

test("一度分けた本文は、全文が小さくなっても分けたままにし、変わらないコメントは書かない", () => {
  // 前準備
  const text = full({ filler: "あ".repeat(200) });
  const first = post(split(text, text, [], 700));
  // 実行
  const r = split(text, first.body, first.comments);
  // 検証
  assert.equal(r.mode, "split");
  assert.ok(r.plan.some((p) => p.op === "update"));
  const again = post(r);
  const r2 = split(text, again.body, again.comments);
  assert.ok(r2.plan.every((p) => p.op === "same"));
});

test("区分が空になったら、その詳細コメントは消さずに使わないものにする", () => {
  // 前準備
  const before = full();
  const first = post(split(before, before, [], 520));
  const after = full({ confirmed: [], needs: ["A02", "A03", "A01"] });
  // 実行
  const r = split(after, first.body, first.comments, 520);
  // 検証
  const retired = r.plan.find((p) => p.op === "retire");
  assert.equal(retired.section, "確定");
  assert.ok(retiredText("audit-1").includes("details-retired"));
});

test("リンク先のコメントが別の集約 Issue のものなら構造の異常にする", () => {
  // 前準備
  const text = full();
  const { body, comments } = post(split(text, text, [], 520));
  comments[0].body = comments[0].body.replace("summary-id=audit-1", "summary-id=other");
  // 実行・検証
  assert.throws(() => compose(body, comments), StructureError);
});

test("リンク先のコメントがなければ構造の異常にする", () => {
  // 前準備
  const text = full();
  const { body } = post(split(text, text, [], 520));
  // 実行・検証
  assert.throws(() => compose(body, []), StructureError);
});

test("1 項目だけで上限を超えるときは検査に外れる", () => {
  // 前準備
  const text = full({ filler: "あ".repeat(500) });
  // 実行・検証
  assert.throws(() => split(text, text, [], 400), CheckError);
});
