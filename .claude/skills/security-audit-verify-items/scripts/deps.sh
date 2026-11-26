#!/usr/bin/env bash
# security-audit-verify-items の実行フォルダに、関連リポジトリ（共有 gem・インフラなど）を版を固定して写す。
#   deps.sh <実行フォルダ> <手元のリポジトリ> <rev> --source lockfile|submodule|default_branch [--adopted yes|no]
#     rev を完全な SHA にし、その SHA が手元のリポジトリの refs/remotes/origin/* から届くときだけ、
#     追跡されているファイルを <実行フォルダ>/deps/<name>@<sha>/ に展開する（git archive。作業ツリーの未追跡のファイルは写さない）。
#     ledger/deps.json に記録を 1 件足す（同じ remote と sha の記録があれば足さない）。出力は「dep <実行フォルダからの path>」。
#   deps.sh --resume <実行フォルダ>
#     ledger/deps.json の記録のうち deps/ に展開がないものを、記録の local から同じ SHA で写し直す。
#     SHA が届かなくなっていれば「dep_missing <path>」を出して続け、最後に終了コード 1。
# 手元のリポジトリは読むだけ（fetch・checkout はしない）。
# 終了コード 1 は用意できない状態（理由を標準エラーに出す）、3 は引数の誤り。
set -euo pipefail

die() { printf '%s\n' "$*" >&2; exit 1; }
usage() { printf '%s\n' "使い方: deps.sh <実行フォルダ> <手元のリポジトリ> <rev> --source lockfile|submodule|default_branch [--adopted yes|no] | deps.sh --resume <実行フォルダ>" >&2; exit 3; }

source "$(dirname "$0")/lib.sh"

# 引数の形を確かめる（誤りは終了コード 3）
resume=0
if [[ ${1-} == --resume ]]; then
  [[ $# -eq 2 ]] || usage
  resume=1
  run_arg=$2
else
  [[ $# -ge 3 ]] || usage
  run_arg=$1
  local_arg=$2
  rev=$3
  shift 3
  source_kind=""
  adopted="no"
  while (($# > 0)); do
    case $1 in
      --source) (($# >= 2)) || usage; source_kind=$2; shift 2 ;;
      --adopted) (($# >= 2)) || usage; adopted=$2; shift 2 ;;
      *) usage ;;
    esac
  done
  case $source_kind in lockfile | submodule | default_branch) ;; *) usage ;; esac
  case $adopted in yes) adopted_json=true ;; no) adopted_json=false ;; *) usage ;; esac
fi

# 実行フォルダの確かめ方は cleanup.sh と同じ（置き場所の中で、repo がある実行フォルダだけ）
root=$(cd -P "$(runs_root)" 2>/dev/null && pwd) || die "実行フォルダの置き場所がありません"
run=$(cd -P "$run_arg" 2>/dev/null && pwd) || die "実行フォルダがありません: $run_arg"
[[ $run == "$root"/* && -f $run/repo ]] || die "このスキルの実行フォルダではありません: $run_arg"
command -v jq >/dev/null || die "jq がありません。brew install jq で入れてください"
ledger=$run/ledger/deps.json

# reachable <手元のリポジトリ> <SHA>  その SHA が refs/remotes/origin/* のどれかから届くなら 0
reachable() {
  local out
  out=$(git -C "$1" branch -r --contains "$2" 2>/dev/null) || return 1
  grep -q '^[[:space:]]*origin/' <<<"$out"
}

# expand <手元のリポジトリ> <SHA> <展開先>  追跡されているファイルを展開する（失敗したら展開先を消す）
expand() {
  mkdir -p "$3"
  if ! git -C "$1" archive "$2" | tar -xf - -C "$3"; then
    rm -rf "$3"
    return 1
  fi
}

# parse_origin <origin の URL>  remote（host/owner/repo。小文字・.git なし）を key に、リポジトリ名を name に入れる
parse_origin() {
  local url=$1 host path
  url=${url%/}
  url=${url%.git}
  if [[ $url == *://* ]]; then
    url=${url#*://}
    host=${url%%/*}
    path=${url#*/}
  else
    host=${url%%:*}
    path=${url#*:}
  fi
  host=${host##*@}
  host=${host%%:*}
  path=${path#/}
  key=$(printf '%s/%s' "$host" "$path" | tr '[:upper:]' '[:lower:]')
  name=${path##*/}
}

if ((resume)); then
  [[ -f $ledger ]] || exit 0
  jq -e 'type == "array"' "$ledger" >/dev/null || die "記録を読めません: $ledger"
  missing=0
  while IFS=$'\t' read -r path sha src; do
    dest=$run/$path
    if [[ -d $dest ]]; then
      echo "dep $path"
    elif [[ -d $src ]] && reachable "$src" "$sha" && expand "$src" "$sha" "$dest"; then
      echo "dep $path"
    else
      echo "dep_missing $path"
      missing=1
    fi
  done < <(jq -r '.[] | [.path, .sha, .local] | @tsv' "$ledger")
  exit $missing
fi

src=$(git -C "$local_arg" rev-parse --show-toplevel 2>/dev/null) || die "git リポジトリではありません: $local_arg"
src=$(cd -P "$src" && pwd)
sha=$(git -C "$src" rev-parse --verify --quiet "$rev^{commit}") || die "コミットがありません: $rev"
reachable "$src" "$sha" || die "手元だけのコミットは写しません（origin から届く SHA を指定してください）: $sha"
url=$(git -C "$src" remote get-url origin 2>/dev/null) || die "origin の URL がありません: $src"
parse_origin "$url"
[[ -n $name ]] || die "origin の URL からリポジトリ名を求められません: $url"
path="deps/$name@$sha"
[[ -d $run/$path ]] || expand "$src" "$sha" "$run/$path" || die "展開できません: $sha"

mkdir -p "$run/ledger"
[[ -f $ledger ]] || echo '[]' >"$ledger"
jq -e 'type == "array"' "$ledger" >/dev/null || die "記録を読めません: $ledger"
if [[ $(jq --arg r "$key" --arg s "$sha" 'any(.[]; .remote == $r and .sha == $s)' "$ledger") != true ]]; then
  rec=$(jq -n --arg name "$name" --arg remote "$key" --arg sha "$sha" --arg source "$source_kind" \
    --argjson adopted "$adopted_json" --arg local "$src" --arg path "$path" \
    '{"name": $name, "remote": $remote, "sha": $sha, "source": $source, "adopted": $adopted, "local": $local, "path": $path}')
  jq --argjson rec "$rec" '. + [$rec]' "$ledger" >"$ledger.tmp" || die "記録を書けません: $ledger"
  mv "$ledger.tmp" "$ledger"
fi
echo "dep $path"
