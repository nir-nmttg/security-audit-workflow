#!/usr/bin/env bash
# security-audit-verify-items の実行フォルダと作業ツリーを用意する。
#   prepare.sh <対象のリポジトリ> <VERIFY_SHA>   新しい実行フォルダを作る
#   prepare.sh --resume <実行フォルダ>           続きから始める実行フォルダの作業ツリーを、控えた SHA で作り直す
# 出力: 「run <実行フォルダ>」「worktree <作業ツリー>」と、コピーした .env* の数（値は出さない）。
# 実行フォルダは artifacts/security-audit-verify-items/<実行 ID>/ に作り、worktree/ items/ ledger/ issues/ refs/ を置く。
# refs/ には security-audit-sync-issues の references/ の書式と反映の規則（issue-templates.md・issue-sync.md・fix-issues.md）を写す（新規・--resume とも、ないものだけ）。
# .env* は、対象リポジトリの中の入れ子の作業ツリー（.git というファイルかフォルダを持つサブフォルダの中）からは写さない。
# このスキル集のメインの checkout が origin の既定ブランチより遅れていれば「skills_behind <遅れているコミット数>」を出す（fetch はしない。判定できなければ出さない）。
# 同じ対象リポジトリのほかの実行の作業ツリーは消さない（同時に動いている実行の作業ツリーを消さないため）。作業ツリーは各実行の cleanup.sh で消す。
# 作業ツリーが残っているほかの実行フォルダは「other_worktree <実行フォルダ>」として出す（止まった実行の片付けの目安）。
# 終了コード 1 は用意できない状態（理由を標準エラーに出す）、3 は引数の誤り。
set -euo pipefail

die() { printf '%s\n' "$*" >&2; exit 1; }
usage() { printf '%s\n' "使い方: prepare.sh <対象のリポジトリ> <VERIFY_SHA> | prepare.sh --resume <実行フォルダ>" >&2; exit 3; }

source "$(dirname "$0")/lib.sh"

agent="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents/security-audit-item-verifier.md"
[[ -f $agent ]] || die "サブエージェント security-audit-item-verifier が見つかりません（$agent）。このスキル集の scripts/link-skills.sh --claude でリンクしてください"
command -v jq >/dev/null || die "jq がありません（Security Audit Item Verifier の hook が使います）。brew install jq で入れてください"
# Security Audit Item Verifier の hook はリンク経由でこのスキルの guard.sh を呼ぶので、リンクがこのスキル集を指していることを確かめる
self_dir=$(cd -P "$(dirname "$0")" && pwd)
linked=$(cd -P "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/security-audit-verify-items/scripts" 2>/dev/null && pwd) || linked=""
[[ $linked == "$self_dir" ]] || die "~/.claude/skills/security-audit-verify-items がこのスキル集を指していません。このスキル集の scripts/link-skills.sh --claude でリンクしてください"

root=$(runs_root) || die "実行フォルダの置き場所を決められません"
mkdir -p "$root"
root=$(cd -P "$root" && pwd)

# 実行フォルダの refs/ に写す、security-audit-sync-issues の references/ のファイル
ref_files=(issue-templates.md issue-sync.md fix-issues.md)

# in_nested_worktree <対象のリポジトリ> <相対パス>  途中のフォルダに .git（ファイルかフォルダ）があれば 0（入れ子の作業ツリーの中）
in_nested_worktree() {
  local d=$2
  while [[ $d == */* ]]; do
    d=${d%/*}
    [[ -e $1/$d/.git ]] && return 0
  done
  return 1
}

copy_env() {
  local repo=$1 wt=$2 n=0 f
  while IFS= read -r -d '' f; do
    [[ $f == */node_modules/* || $f == node_modules/* ]] && continue
    in_nested_worktree "$repo" "$f" && continue
    mkdir -p "$wt/$(dirname "$f")"
    cp -p "$repo/$f" "$wt/$f"
    n=$((n + 1))
  done < <(git -C "$repo" ls-files -z --others -- ':(glob).env*' ':(glob)**/.env*')
  echo "env_copied $n"
}

# copy_refs <実行フォルダ>  security-audit-sync-issues の書式と反映の規則の写しを refs/ に入れる（ないものだけ写す。既にあるものは上書きしない）
copy_refs() {
  local run=$1 refs f
  refs="$(cd -P "$root/../.." && pwd)/.agents/skills/security-audit-sync-issues/references"
  for f in "${ref_files[@]}"; do
    [[ -f $refs/$f ]] || die "参照ファイルがありません: $refs/$f"
  done
  mkdir -p "$run/refs"
  for f in "${ref_files[@]}"; do
    [[ -e $run/refs/$f ]] || cp "$refs/$f" "$run/refs/$f"
  done
}

# skills_behind  このスキル集のメインの checkout の HEAD が origin の既定ブランチより遅れていれば知らせる（fetch はしない。判定できなければ何も出さない）
skills_behind() {
  local skills common main ref n
  skills=$(cd -P "$(dirname "$0")/../../../.." 2>/dev/null && pwd) || return 0
  common=$(git -C "$skills" rev-parse --git-common-dir 2>/dev/null) || return 0
  [[ $common == /* ]] || common=$skills/$common
  main=$(cd -P "$(dirname "$common")" 2>/dev/null && pwd) || return 0
  ref=$(git -C "$main" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null) || ref=refs/remotes/origin/main
  n=$(git -C "$main" rev-list --count "HEAD..$ref" 2>/dev/null) || return 0
  if [[ $n =~ ^[1-9][0-9]*$ ]]; then echo "skills_behind $n"; fi
  return 0
}

make_worktree() {
  local run=$1 repo sha
  repo=$(cat "$run/repo")
  sha=$(cat "$run/sha")
  remove_worktree "$run"
  git -C "$repo" worktree prune
  git -C "$repo" -c core.hooksPath=/dev/null worktree add --detach "$run/worktree" "$sha" >/dev/null ||
    die "作業ツリーを作れません（$repo の $sha）"
  echo "run $run"
  echo "worktree $run/worktree"
  copy_env "$repo" "$run/worktree"
}

if [[ ${1-} == --resume ]]; then
  [[ $# -eq 2 ]] || usage
  run=$(cd -P "$2" 2>/dev/null && pwd) || die "実行フォルダがありません: $2"
  [[ $run == "$root"/* && -f $run/repo && -f $run/sha ]] || die "このスキルの実行フォルダではありません: $2"
  copy_refs "$run"
  make_worktree "$run"
  skills_behind
  exit 0
fi

[[ $# -eq 2 ]] || usage
repo=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || die "git リポジトリではありません: $1"
repo=$(cd -P "$repo" && pwd)
sha=$2
[[ $sha =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || usage
git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null || die "コミットがありません: $sha（先に git fetch してください）"

# 同じ対象リポジトリで作業ツリーが残っているほかの実行フォルダを知らせる（消さない）
others=()
for old in "$root"/*/; do
  old=${old%/}
  [[ -f $old/repo && $(cat "$old/repo") == "$repo" && -d $old/worktree ]] || continue
  others+=("$old")
done

run="$root/$(date +%Y%m%d-%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
mkdir -p "$run/items" "$run/ledger" "$run/issues" "$run/refs"
# Security Audit Item Verifier は実行フォルダの外を読めないので、書式と反映の規則を写しておく
copy_refs "$run"
printf '%s\n' "$repo" >"$run/repo"
printf '%s\n' "$sha" >"$run/sha"
make_worktree "$run"
for old in "${others[@]+"${others[@]}"}"; do echo "other_worktree $old"; done
skills_behind
