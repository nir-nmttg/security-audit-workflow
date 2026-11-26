import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "./fallback.mjs";

const CLI = fileURLToPath(new URL("./fallback.mjs", import.meta.url));
const FILE = "model-fallback.json";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function runDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fallback-test-"));
}

// init 済みの実行フォルダ
function ready() {
  const dir = runDir();
  main(["init", dir]);
  return dir;
}

function text(dir) {
  return fs.readFileSync(path.join(dir, FILE), "utf8");
}

function read(dir) {
  return JSON.parse(text(dir));
}

function write(dir, value) {
  fs.writeFileSync(path.join(dir, FILE), typeof value === "string" ? value : JSON.stringify(value));
}

function begin(dir, ...args) {
  return main(["begin", dir, ...args]);
}

// 時刻は実行ごとに変わるので、比べるときは外す
function withoutTimes(attempt) {
  const rest = { ...attempt };
  delete rest.recorded_at;
  delete rest.launched_at;
  delete rest.ended_at;
  return rest;
}

test("init は記録を作り、2 回目は exists を返す。--resumed で partial になる", () => {
  const dir = runDir();
  assert.equal(main(["init", dir]), "initialized");
  assert.deepEqual(read(dir), { model: "gpt-6.1-terra", partial: false, attempts: [] });
  assert.equal(main(["init", dir]), "exists");
  assert.equal(main(["init", dir, "--resumed"]), "exists");
  assert.equal(read(dir).partial, false);
  const resumed = runDir();
  assert.equal(main(["init", resumed, "--resumed"]), "initialized");
  assert.equal(read(resumed).partial, true);
});

test("begin は go を出して記録し、started・end で流れが進む", () => {
  const dir = ready();
  assert.equal(
    begin(dir, "--stage", "hunting", "--stopped-agent", "hunter-auth-01", "--unit", "b", "--unit", "a", "--unit", "a"),
    "go retry_agent_id=hunter-auth-01-terra model=gpt-6.1-terra",
  );
  const [first] = read(dir).attempts;
  assert.deepEqual(withoutTimes(first), {
    stage: "hunting",
    stopped_agent_id: "hunter-auth-01",
    retry_agent_id: "hunter-auth-01-terra",
    codex_agent_id: null,
    coverage_ids: ["a", "b"],
    fingerprints: [],
    task: null,
    result: "pending",
  });
  assert.match(first.recorded_at, ISO);
  assert.equal(first.launched_at, null);
  assert.equal(first.ended_at, null);

  assert.equal(main(["started", dir, "hunter-auth-01-terra", "codex-thread-1"]), "started retry_agent_id=hunter-auth-01-terra");
  const started = read(dir).attempts[0];
  assert.equal(started.codex_agent_id, "codex-thread-1");
  assert.match(started.launched_at, ISO);
  assert.equal(started.result, "pending");

  assert.equal(main(["end", dir, "hunter-auth-01-terra", "completed"]), "ended retry_agent_id=hunter-auth-01-terra result=completed");
  const ended = read(dir).attempts[0];
  assert.equal(ended.result, "completed");
  assert.match(ended.ended_at, ISO);
  assert.equal(main(["pending", dir]), "none");
});

test("担当が重なる頼み直しは duplicate になり、工程が違えば重ならない", () => {
  const dir = ready();
  assert.match(begin(dir, "--stage", "hunting", "--stopped-agent", "w1", "--unit", "a", "--unit", "b"), /^go /);
  // 担当の組み替え
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "w2", "--unit", "a"), "skip reason=duplicate");
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "w3", "--unit", "b", "--unit", "c"), "skip reason=duplicate");
  assert.equal(read(dir).attempts[2].result, "skipped_duplicate");
  // fingerprint の重なり
  assert.match(begin(dir, "--stage", "hunting", "--stopped-agent", "w4", "--unit", "x", "--fingerprint", "fp-1"), /^go /);
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "w5", "--unit", "y", "--fingerprint", "fp-1"), "skip reason=duplicate");
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "w6", "--fingerprint", "fp-1"), "skip reason=duplicate");
  // 工程が違えば重複にならない
  assert.match(begin(dir, "--stage", "critic", "--stopped-agent", "w7", "--unit", "a", "--fingerprint", "fp-1"), /^go /);
});

test("--task だけの作業は、同じ工程・同じ task で担当の空な記録と重なれば duplicate になる", () => {
  const dir = ready();
  assert.match(begin(dir, "--stage", "recon", "--stopped-agent", "r1", "--task", "recon-main"), /^go /);
  assert.equal(begin(dir, "--stage", "recon", "--stopped-agent", "r2", "--task", "recon-main"), "skip reason=duplicate");
  assert.match(begin(dir, "--stage", "recon", "--stopped-agent", "r3", "--task", "recon-sub"), /^go /);
  assert.match(begin(dir, "--stage", "critic", "--stopped-agent", "c1", "--task", "recon-main"), /^go /);
  // 担当のある記録とは、担当の空な依頼でも重ならない
  assert.match(begin(dir, "--stage", "validation", "--stopped-agent", "v1", "--unit", "a", "--task", "val"), /^go /);
  assert.match(begin(dir, "--stage", "validation", "--stopped-agent", "v2", "--task", "val"), /^go /);
});

test("同じ停止の扱い直しは記録を増やさず、いまの状態に応じて答える", () => {
  const dir = ready();
  const work = ["--stage", "hunting", "--stopped-agent", "s1", "--unit", "a"];
  assert.equal(begin(dir, ...work), "go retry_agent_id=s1-terra model=gpt-6.1-terra");
  // 起動前（started の前）に扱い直しても、二重に起動しないよう go を出し直さない
  assert.equal(begin(dir, ...work), "skip reason=handled result=pending");
  assert.equal(read(dir).attempts.length, 1);
  main(["started", dir, "s1-terra", "codex-1"]);
  assert.equal(begin(dir, ...work), "skip reason=handled result=pending");
  main(["end", dir, "s1-terra", "stopped"]);
  assert.equal(begin(dir, ...work), "skip reason=handled result=stopped");

  // 見送った停止は、同じ停止を扱い直しても同じ見送りのまま
  const budget = ["--stage", "hunting", "--stopped-agent", "s2", "--unit", "z", "--no-budget"];
  assert.equal(begin(dir, ...budget), "skip reason=budget");
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "s2", "--unit", "z"), "skip reason=budget");
  assert.equal(read(dir).attempts.length, 2);
});

test("頼み直しの Worker 自身が止まったら retry_worker とし、記録を変えない", () => {
  const dir = ready();
  begin(dir, "--stage", "hunting", "--stopped-agent", "s1", "--unit", "a");
  const before = text(dir);
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "s1-terra", "--unit", "q"), "skip reason=retry_worker");
  assert.equal(text(dir), before);
});

test("unavailable の頼み直しがあると、以後の頼み直しは skipped_unavailable になる", () => {
  const dir = ready();
  begin(dir, "--stage", "hunting", "--stopped-agent", "u1", "--unit", "a");
  assert.equal(main(["end", dir, "u1-terra", "unavailable"]), "ended retry_agent_id=u1-terra result=unavailable");
  assert.equal(begin(dir, "--stage", "critic", "--stopped-agent", "u2", "--unit", "b"), "skip reason=unavailable");
  assert.equal(read(dir).attempts[1].result, "skipped_unavailable");
});

test("interrupted が 2 件たまると skipped_fuse になり、1 件では止めない", () => {
  const dir = ready();
  begin(dir, "--stage", "hunting", "--stopped-agent", "i1", "--unit", "a");
  main(["end", dir, "i1-terra", "interrupted"]);
  assert.match(begin(dir, "--stage", "hunting", "--stopped-agent", "i2", "--unit", "b"), /^go /);
  main(["end", dir, "i2-terra", "interrupted"]);
  assert.equal(begin(dir, "--stage", "critic", "--stopped-agent", "i3", "--unit", "c"), "skip reason=fuse");
  assert.equal(read(dir).attempts[2].result, "skipped_fuse");
});

test("--no-budget は頼み直しを起こさず、skipped_budget の記録を残す", () => {
  const dir = ready();
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "b1", "--unit", "a", "--no-budget"), "skip reason=budget");
  const [skipped] = read(dir).attempts;
  assert.equal(skipped.result, "skipped_budget");
  assert.equal(skipped.retry_agent_id, null);
  assert.equal(skipped.codex_agent_id, null);
  assert.match(skipped.ended_at, ISO);
  assert.equal(main(["pending", dir]), "none");
});

test("頼み直しの ID は <停止した ID>-terra を使い、使えないときは terra-<n> にする", () => {
  const dir = ready();
  // agents/ に同じ名前のフォルダがある
  fs.mkdirSync(path.join(dir, "agents", "s1-terra"), { recursive: true });
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "s1", "--unit", "a"), "go retry_agent_id=terra-1 model=gpt-6.1-terra");
  // 64 文字を超える（59 文字 + "-terra" = 65 文字）
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "a".repeat(59), "--unit", "b"), "go retry_agent_id=terra-2 model=gpt-6.1-terra");
  // ちょうど 64 文字は使える
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "b".repeat(58), "--unit", "c"), `go retry_agent_id=${"b".repeat(58)}-terra model=gpt-6.1-terra`);
  // 別の停止の ID と同じ
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "s3-terra", "--unit", "d"), "go retry_agent_id=s3-terra-terra model=gpt-6.1-terra");
  assert.equal(begin(dir, "--stage", "hunting", "--stopped-agent", "s3", "--unit", "e"), "go retry_agent_id=terra-5 model=gpt-6.1-terra");
});

test("started は pending で未開始の頼み直しだけ受け付ける", () => {
  const dir = ready();
  begin(dir, "--stage", "hunting", "--stopped-agent", "s1", "--unit", "a");
  assert.equal(main(["started", dir, "s1-terra", "codex-1"]), "started retry_agent_id=s1-terra");
  assert.throws(() => main(["started", dir, "s1-terra", "codex-2"]), /すでに started/);
  assert.equal(main(["end", dir, "s1-terra", "failed"]), "ended retry_agent_id=s1-terra result=failed");
  assert.throws(() => main(["started", dir, "s1-terra", "codex-3"]), /pending ではない/);
  assert.throws(() => main(["started", dir, "nope-terra", "codex-3"]), /記録がありません/);
});

test("end は二重に更新せず、started していない頼み直しを completed・stopped で終えさせない", () => {
  const dir = ready();
  begin(dir, "--stage", "hunting", "--stopped-agent", "e1", "--unit", "a");
  assert.throws(() => main(["end", dir, "e1-terra", "completed"]), /started/);
  assert.throws(() => main(["end", dir, "e1-terra", "stopped"]), /started/);
  assert.equal(main(["end", dir, "e1-terra", "interrupted"]), "ended retry_agent_id=e1-terra result=interrupted");
  assert.throws(() => main(["end", dir, "e1-terra", "interrupted"]), /すでに終わって/);

  begin(dir, "--stage", "hunting", "--stopped-agent", "e2", "--unit", "b");
  main(["started", dir, "e2-terra", "codex-2"]);
  assert.equal(main(["end", dir, "e2-terra", "completed"]), "ended retry_agent_id=e2-terra result=completed");
  assert.throws(() => main(["end", dir, "e2-terra", "completed"]), /すでに終わって/);
  assert.throws(() => main(["end", dir, "e2-terra", "pending"]), /result/);
});

test("pending は実行中の頼み直しを記録の順に出し、ファイルを変えない", () => {
  const dir = ready();
  assert.equal(main(["pending", dir]), "none");
  begin(dir, "--stage", "hunting", "--stopped-agent", "p1", "--unit", "a");
  begin(dir, "--stage", "hunting", "--stopped-agent", "p2", "--unit", "b");
  begin(dir, "--stage", "hunting", "--stopped-agent", "p3", "--unit", "c");
  main(["started", dir, "p2-terra", "codex-p2"]);
  main(["end", dir, "p3-terra", "failed"]);
  const before = text(dir);
  assert.equal(
    main(["pending", dir]),
    "pending retry_agent_id=p1-terra codex_agent_id=not_started\npending retry_agent_id=p2-terra codex_agent_id=codex-p2",
  );
  assert.equal(text(dir), before);
});

test("形の崩れた model-fallback.json は止まり、init がない実行では止まる", () => {
  const dir = runDir();
  assert.throws(() => begin(dir, "--stage", "hunting", "--stopped-agent", "s1", "--unit", "a"), /init を先に実行してください/);
  assert.throws(() => main(["pending", dir]), /init を先に実行してください/);
  assert.throws(() => main(["started", dir, "s1-terra", "codex-1"]), /init を先に実行してください/);

  const shapes = [
    { model: 1, partial: false, attempts: [] },
    { model: "gpt-6.1-terra", partial: "no", attempts: [] },
    { model: "gpt-6.1-terra", partial: false, attempts: {} },
    { model: "gpt-6.1-terra", partial: false, attempts: [null] },
    { model: "gpt-6.1-terra", partial: false, attempts: [{ stopped_agent_id: "s1", result: "bogus" }] },
    { model: "gpt-6.1-terra", partial: false, attempts: [{ result: "pending" }] },
    [],
    null,
  ];
  for (const value of shapes) {
    write(dir, value);
    assert.throws(() => main(["init", dir]), /形が正しくありません/);
    assert.throws(() => begin(dir, "--stage", "hunting", "--stopped-agent", "s1", "--unit", "a"), /形が正しくありません/);
  }
  write(dir, "{");
  assert.throws(() => main(["pending", dir]), /読めません/);
});

test("不正な値・オプション・組み合わせは断り、記録を変えない", () => {
  const dir = ready();
  assert.throws(() => begin(dir, "--stage", "review", "--stopped-agent", "s1", "--unit", "a"), /--stage/);
  assert.throws(() => begin(dir, "--stage", "hunting", "--stopped-agent", "Bad ID", "--unit", "a"), /--stopped-agent/);
  assert.throws(() => begin(dir, "--stage", "hunting", "--stopped-agent", "s1", "--unit", "has space"), /--unit/);
  assert.throws(() => begin(dir, "--stage", "hunting", "--stopped-agent", "s1", "--fingerprint", "-fp"), /--fingerprint/);
  assert.throws(() => begin(dir, "--stage", "hunting", "--stopped-agent", "s1", "--fingerprint", "f".repeat(1025)), /--fingerprint/);
  assert.throws(() => begin(dir, "--stage", "hunting", "--stopped-agent", "s1", "--task", "Bad Task"), /--task/);
  assert.throws(() => begin(dir, "--stage", "hunting", "--stopped-agent", "s1"), /--unit・--fingerprint・--task/);
  assert.throws(() => begin(dir, "--stage", "hunting", "--stopped-agent", "s1", "--unit", "a", "--bogus"), /知らないオプション/);
  assert.throws(() => begin(dir, "--stage", "hunting", "--unit", "a"), /--stopped-agent が必要/);
  assert.throws(() => begin(dir, "--stage", "hunting", "--stage", "critic", "--stopped-agent", "s1", "--unit", "a"), /1 回だけ/);
  assert.throws(() => begin(dir, "--stage", "hunting", "--stopped-agent", "s1", "--unit"), /値を指定/);
  assert.throws(() => main(["begin", "relative/dir", "--stage", "hunting", "--stopped-agent", "s1", "--unit", "a"]), /絶対パス/);
  assert.throws(() => main(["started", dir, "BAD", "codex-1"]), /retry_agent_id/);
  assert.throws(() => main(["started", dir, "s1-terra", "codex 1"]), /codex_agent_id/);
  assert.throws(() => main(["started", dir, "s1-terra", "x".repeat(257)]), /codex_agent_id/);
  assert.throws(() => main(["end", dir, "s1-terra", "skipped_budget"]), /result/);
  assert.throws(() => main(["init", dir, "--bogus"]), /知らないオプション/);
  assert.throws(() => main(["pending", dir, "extra"]), /使い方/);
  assert.throws(() => main(["nothing", dir]), /使い方/);
  assert.equal(read(dir).attempts.length, 0);
});

test("CLI は結果を出力し、使い方の誤りを終了コード 2 で返す", () => {
  const dir = runDir();
  const init = spawnSync(process.execPath, [CLI, "init", dir], { encoding: "utf8" });
  assert.equal(init.status, 0);
  assert.equal(init.stdout, "initialized\n");
  const bad = spawnSync(process.execPath, [CLI, "pending", "relative/dir"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /絶対パス/);
});
