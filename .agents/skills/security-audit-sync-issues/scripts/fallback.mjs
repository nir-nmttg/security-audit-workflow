#!/usr/bin/env node
// Worker が Codex の安全審査で止まったとき、同じ作業を別モデルの新しい Worker へ 1 回だけ頼み直すかを判定し、記録する。出力は決まった語・ID・モデル名だけにする。
import fs from "node:fs";
import path from "node:path";

const FALLBACK_FILE = "model-fallback.json";
const MODEL = "gpt-6.1-terra";
const STAGES = ["recon", "hunting", "critic", "validation", "final_verification"];
const RESULTS = ["pending", "completed", "invalid", "stopped", "failed", "unavailable", "interrupted", "skipped_duplicate", "skipped_budget", "skipped_unavailable", "skipped_fuse"];
const END_RESULTS = ["completed", "invalid", "stopped", "failed", "unavailable", "interrupted"];
// 起動（started）したあとでなければ終えられない結果。起動していない頼み直しは failed・unavailable・interrupted で終える
const NEEDS_START = ["completed", "invalid", "stopped"];
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CODEX_AGENT_ID = /^[^\s"'`]{1,256}$/;
const UNIT_ID = /^[\x21-\x7e]{1,4096}$/;
const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]*$/;
const TASK = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const USAGE = {
  init: "init <run_dir> [--resumed]",
  begin: "begin <run_dir> --stage <s> --stopped-agent <id> [--unit <u>]... [--fingerprint <fp>]... [--task <t>] [--no-budget]",
  started: "started <run_dir> <retry_agent_id> <codex_agent_id>",
  end: "end <run_dir> <retry_agent_id> <result>",
  pending: "pending <run_dir>",
};

class UsageError extends Error {}

function fail(message) {
  throw new UsageError(message);
}

function runDirOf(arg) {
  if (!arg || !path.isAbsolute(arg)) fail("run_dir は絶対パスで指定してください");
  const dir = path.resolve(arg);
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    fail(`run_dir がありません: ${dir}`);
  }
  if (!st.isDirectory()) fail(`run_dir がディレクトリではありません: ${dir}`);
  return dir;
}

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, missing: error.code === "ENOENT" };
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(tmp, file);
}

function now() {
  return new Date().toISOString();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function startedOf(attempt) {
  return typeof attempt.codex_agent_id === "string";
}

function goLine(retryId) {
  return `go retry_agent_id=${retryId} model=${MODEL}`;
}

// 記録の形を確かめて読む。形が崩れていれば判定しない
function loadFallback(dir) {
  const r = readJson(path.join(dir, FALLBACK_FILE));
  if (!r.ok) fail(r.missing ? "model-fallback.json がありません（init を先に実行してください）" : "model-fallback.json を読めません");
  const f = r.value;
  const attemptOk = (a) => isObject(a) && RESULTS.includes(a.result) && typeof a.stopped_agent_id === "string";
  if (!isObject(f) || typeof f.model !== "string" || typeof f.partial !== "boolean" || !Array.isArray(f.attempts) || !f.attempts.every(attemptOk)) fail("model-fallback.json の形が正しくありません");
  return f;
}

function saveFallback(dir, f) {
  writeJsonAtomic(path.join(dir, FALLBACK_FILE), f);
}

// 位置引数の数を確かめ、値つきのオプション（once は 1 回だけ、many は何回でも）とフラグを読む。知らないオプションと余分な引数は断る
function parse(command, args, { once = [], many = [], flags = [], count = 0 } = {}) {
  const values = new Map();
  const set = new Set();
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (flags.includes(arg)) {
      set.add(arg);
    } else if (once.includes(arg) || many.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} には値を指定してください`);
      values.set(arg, [...(values.get(arg) ?? []), value]);
      i += 1;
    } else if (arg.startsWith("--")) {
      fail(`知らないオプションです: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  for (const name of once) if ((values.get(name) ?? []).length > 1) fail(`${name} は 1 回だけ指定してください`);
  if (positional.length !== count) fail(`使い方: fallback.mjs ${USAGE[command]}`);
  return {
    positional,
    flag: (name) => set.has(name),
    one: (name) => values.get(name)?.[0],
    all: (name) => values.get(name) ?? [],
  };
}

// 値の形を確かめ、合えばそのまま返す。max は文字数の上限
function checked(value, label, pattern, max = Infinity) {
  if (typeof value !== "string" || value.length > max || !pattern.test(value)) fail(`${label} が正しくありません`);
  return value;
}

// 今回の依頼（工程・担当・task）と、記録の工程・担当が重なるか。担当の指定がないときは、担当の空な記録で同じ task のものと重なる
function overlaps(attempt, work) {
  if (attempt.stage !== work.stage) return false;
  const coverage = listOf(attempt.coverage_ids);
  const fps = listOf(attempt.fingerprints);
  if (work.units.length > 0 || work.fingerprints.length > 0) {
    return work.units.some((u) => coverage.includes(u)) || work.fingerprints.some((fp) => fps.includes(fp));
  }
  return coverage.length === 0 && fps.length === 0 && (attempt.task ?? null) === work.task;
}

// 頼み直しの Worker の ID。<停止した ID>-terra を使い、使えないときは terra-<n> にする。どの記録とも重ならず、agents/ に同じ名前のフォルダがないものを使う
function retryIdOf(dir, f, stoppedId) {
  const used = new Set([stoppedId, ...f.attempts.flatMap((a) => [a.stopped_agent_id, a.retry_agent_id])]);
  const usable = (id) => AGENT_ID.test(id) && !used.has(id) && !fs.existsSync(path.join(dir, "agents", id));
  if (usable(`${stoppedId}-terra`)) return `${stoppedId}-terra`;
  let n = f.attempts.length + 1;
  while (!usable(`terra-${n}`)) n += 1;
  return `terra-${n}`;
}

// 記録を 1 件作る。見送り（skipped_*）は retry_agent_id を null にし、記録した時刻を ended_at に入れる
function attemptOf(work, { retryId, result, at }) {
  return {
    stage: work.stage,
    stopped_agent_id: work.stoppedId,
    retry_agent_id: retryId,
    codex_agent_id: null,
    coverage_ids: work.units,
    fingerprints: work.fingerprints,
    task: work.task,
    result,
    recorded_at: at,
    launched_at: null,
    ended_at: result === "pending" ? null : at,
  };
}

function cmdInit(dir, args) {
  const opt = parse("init", args, { flags: ["--resumed"] });
  if (fs.existsSync(path.join(dir, FALLBACK_FILE))) {
    loadFallback(dir);
    return "exists";
  }
  saveFallback(dir, { model: MODEL, partial: opt.flag("--resumed"), attempts: [] });
  return "initialized";
}

function cmdBegin(dir, args) {
  const opt = parse("begin", args, {
    once: ["--stage", "--stopped-agent", "--task"],
    many: ["--unit", "--fingerprint"],
    flags: ["--no-budget"],
  });
  const stage = opt.one("--stage");
  const stoppedId = opt.one("--stopped-agent");
  if (stage === undefined || stoppedId === undefined) fail("begin には --stage と --stopped-agent が必要です");
  if (!STAGES.includes(stage)) fail("--stage が正しくありません");
  checked(stoppedId, "--stopped-agent", AGENT_ID);
  const task = opt.one("--task") === undefined ? null : checked(opt.one("--task"), "--task", TASK);
  const units = [...new Set(opt.all("--unit").map((u) => checked(u, "--unit", UNIT_ID)))].sort();
  const fingerprints = [...new Set(opt.all("--fingerprint").map((fp) => checked(fp, "--fingerprint", FINGERPRINT, 1024)))].sort();
  if (units.length === 0 && fingerprints.length === 0 && task === null) fail("--unit・--fingerprint・--task のどれかを指定してください");

  const f = loadFallback(dir);
  // 頼み直しの Worker 自身が止まった
  if (f.attempts.some((a) => a.retry_agent_id === stoppedId)) return "skip reason=retry_worker";
  // 同じ停止を扱い直した。記録は足さず、いまの状態に応じて答える（起動前の pending も、二重に起動しないよう handled にする）
  const same = f.attempts.find((a) => a.stopped_agent_id === stoppedId);
  if (same) {
    if (same.result.startsWith("skipped_")) return `skip reason=${same.result.slice("skipped_".length)}`;
    return `skip reason=handled result=${same.result}`;
  }

  // 以下は上から順に判定する
  const work = { stage, stoppedId, units, fingerprints, task };
  let reason = null;
  if (f.attempts.some((a) => overlaps(a, work))) reason = "duplicate";
  else if (f.attempts.some((a) => a.result === "unavailable")) reason = "unavailable";
  else if (f.attempts.filter((a) => a.result === "interrupted").length >= 2) reason = "fuse";
  else if (opt.flag("--no-budget")) reason = "budget";

  const at = now();
  if (reason !== null) {
    f.attempts.push(attemptOf(work, { retryId: null, result: `skipped_${reason}`, at }));
    saveFallback(dir, f);
    return `skip reason=${reason}`;
  }
  const retryId = retryIdOf(dir, f, stoppedId);
  f.attempts.push(attemptOf(work, { retryId, result: "pending", at }));
  saveFallback(dir, f);
  return goLine(retryId);
}

function cmdStarted(dir, args) {
  const [retryId, codexId] = parse("started", args, { count: 2 }).positional;
  checked(retryId, "retry_agent_id", AGENT_ID);
  checked(codexId, "codex_agent_id", CODEX_AGENT_ID);
  const f = loadFallback(dir);
  const attempt = f.attempts.find((a) => a.retry_agent_id === retryId);
  if (!attempt) fail("頼み直しの記録がありません");
  if (attempt.result !== "pending") fail(`pending ではないので started を記録できません: result=${attempt.result}`);
  if (startedOf(attempt)) fail("すでに started を記録しています");
  attempt.codex_agent_id = codexId;
  attempt.launched_at = now();
  saveFallback(dir, f);
  return `started retry_agent_id=${retryId}`;
}

function cmdEnd(dir, args) {
  const [retryId, result] = parse("end", args, { count: 2 }).positional;
  checked(retryId, "retry_agent_id", AGENT_ID);
  if (!END_RESULTS.includes(result)) fail("result が正しくありません");
  const f = loadFallback(dir);
  const attempt = f.attempts.find((a) => a.retry_agent_id === retryId);
  if (!attempt) fail("頼み直しの記録がありません");
  if (attempt.result !== "pending") fail(`すでに終わっているので end を記録できません: result=${attempt.result}`);
  if (NEEDS_START.includes(result) && !startedOf(attempt)) fail(`started していない頼み直しは ${result} にできません`);
  attempt.result = result;
  attempt.ended_at = now();
  saveFallback(dir, f);
  return `ended retry_agent_id=${retryId} result=${result}`;
}

function cmdPending(dir, args) {
  parse("pending", args);
  const lines = loadFallback(dir)
    .attempts.filter((a) => a.result === "pending")
    .map((a) => `pending retry_agent_id=${a.retry_agent_id} codex_agent_id=${startedOf(a) ? a.codex_agent_id : "not_started"}`);
  return lines.length > 0 ? lines.join("\n") : "none";
}

const COMMANDS = {
  init: (a) => cmdInit(runDirOf(a[0]), a.slice(1)),
  begin: (a) => cmdBegin(runDirOf(a[0]), a.slice(1)),
  started: (a) => cmdStarted(runDirOf(a[0]), a.slice(1)),
  end: (a) => cmdEnd(runDirOf(a[0]), a.slice(1)),
  pending: (a) => cmdPending(runDirOf(a[0]), a.slice(1)),
};

export function main(argv) {
  const [command, ...args] = argv;
  if (!Object.hasOwn(COMMANDS, command)) fail(`使い方: fallback.mjs <${Object.keys(COMMANDS).join("|")}> <run_dir> [...]`);
  return COMMANDS[command](args);
}

if (process.argv[1]?.endsWith("/fallback.mjs")) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`fallback.mjs: ${error instanceof UsageError ? error.message : "予期しないエラー"}\n`);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
}
