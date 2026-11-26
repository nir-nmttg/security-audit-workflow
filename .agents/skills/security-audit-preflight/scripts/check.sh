#!/usr/bin/env bash
# Codex スキルの基本環境を確かめ、Markdown で結果と、足りないものへの対処を出力する。環境やリンクは変更しない。
# すべてそろっていれば 1 行だけを出す。❌・⚠️ があるときは、表と対処方法を出す。
# 個別の前提・設定内容は SKILL.md の手順で確認する。不足があっても終了コードは 0。
# git worktree の中から実行したときは、リンクの向き先のメインの checkout のスキルで判定する。
set -euo pipefail

if (( $# > 0 )); then
  echo '使い方: bash scripts/check.sh' >&2
  exit 2
fi

repo_root=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)

# メインの checkout か。worktree のときは、リンクの向き先になるメインの checkout のスキルで判定する
main_checkout=false
main_root=$repo_root
if command -v git >/dev/null 2>&1 &&
  gd=$(cd "$repo_root" && git rev-parse --git-dir 2>/dev/null) &&
  gcd=$(cd "$repo_root" && git rev-parse --git-common-dir 2>/dev/null); then
  if [[ $(cd "$repo_root" && cd -P "$gd" && pwd) == "$(cd "$repo_root" && cd -P "$gcd" && pwd)" ]]; then
    main_checkout=true
  fi
  main_root=$(cd "$repo_root" && cd -P "$gcd/.." && pwd) || main_root=$repo_root
fi
skills_dir="$main_root/.agents/skills"
link_dir="$HOME/.agents/skills"
link_script="$main_root/scripts/link-skills.sh"
link_note=""
$main_checkout || link_note="（git worktree からは実行できないので、メインの checkout で実行する）"

# パスや版の文字列を表のセルに入れられる形にする（| と改行で表が崩れないようにする）
cell() {
  local value=$1
  value=${value//|/\&#124;}
  value=${value//$'\n'/ }
  value=${value//$'\r'/ }
  printf '%s' "$value"
}

# コマンドの出力の 1 行目を出す（失敗しても終了しない）
first_line() { "$@" 2>/dev/null | head -1 || true; }

marks=()     # 結果の表の行。状態・項目・詳細・使うスキルを、同じ番号の要素に入れる
items=()
details=()
useds=()
ng=0         # 足りないもの（❌）の数
warned=0     # 確認が必要なもの（⚠️）の数
fixes=()     # 対処方法の行

# 結果を記録する: add <状態 ok|ng|warn> <項目> <詳細> <使うスキル> [対処方法]
add() {
  local state=$1 item=$2 detail=$3 used_by=$4 fix=${5:-} mark
  case $state in
    ok) mark='✅' ;;
    ng) mark='❌'; ng=$((ng + 1)) ;;
    warn) mark='⚠️'; warned=$((warned + 1)) ;;
  esac
  marks+=("$mark"); items+=("$item"); details+=("$detail"); useds+=("$used_by")
  [[ $state == ok || -z $fix ]] || fixes+=("- **$item**: $fix")
}

# 表を出す。「使うスキル」の列は、全行が同じ値なら省く
print_table() {
  local i same=true
  for i in "${!useds[@]}"; do
    [[ ${useds[i]} == "${useds[0]}" ]] || same=false
  done
  if $same; then
    echo "| | 項目 | 状態 |"
    echo "| --- | --- | --- |"
    for i in "${!marks[@]}"; do echo "| ${marks[i]} | ${items[i]} | ${details[i]} |"; done
  else
    echo "| | 項目 | 状態 | 使うスキル |"
    echo "| --- | --- | --- | --- |"
    for i in "${!marks[@]}"; do echo "| ${marks[i]} | ${items[i]} | ${details[i]} | ${useds[i]} |"; done
  fi
}

# --- コマンド・ログイン・保存先 ------------------------------------------------

used_sync='security-audit-sync-issues'
issue_used='security-audit-sync-issues（Issue の反映）'

if location=$(command -v git); then
  add ok '`git`' "$(cell "$location")" "$used_sync"
else
  add ng '`git`' '見つかりません' "$used_sync" '`xcode-select --install`（または `brew install git`）'
fi

if command -v node >/dev/null 2>&1; then
  add ok '`node`' "$(cell "$(first_line node --version)")" "$used_sync"
else
  add ng '`node`' '見つかりません' "$used_sync" '`brew install node`'
fi

if command -v gh >/dev/null 2>&1; then
  add ok '`gh`' "$(cell "$(first_line gh --version)")" "$issue_used"
  if gh auth status >/dev/null 2>&1; then
    add ok 'GitHub（gh）のログイン' 'ログイン済み' "$issue_used"
  else
    add warn 'GitHub（gh）のログイン' '未ログイン' "$issue_used" '`gh auth login`（ブラウザでの操作が要る）'
  fi
  # 全ページの取得に使うオプションは、ヘルプに載っているかで確かめる（GitHub には問い合わせない）
  api_help=$(gh api --help 2>/dev/null || true)
  if [[ $api_help == *--paginate* && $api_help == *--slurp* ]]; then
    add ok '`gh api` の `--paginate --slurp`' '対応' "$issue_used"
  else
    add warn '`gh api` の `--paginate --slurp`' '未対応（gh が古い）' "$issue_used" '`brew upgrade gh`'
  fi
else
  add warn '`gh`' '見つかりません' "$issue_used" '`brew install gh` のあと `gh auth login`'
fi

# 上流の Cloudflare の security-audit（監査に必要。主要ファイルがそろっているかを確かめる）
cloudflare_skill="$link_dir/security-audit"
cloudflare_item='Cloudflare `security-audit`'
cloudflare_fix='README の「はじめに」の手順 1 のとおりに入れる（`npx skills add cloudflare/security-audit-skill --skill security-audit -g -a codex -y`）'
if [[ -L $cloudflare_skill && ! -e $cloudflare_skill ]]; then
  add ng "$cloudflare_item" "リンク先を参照できません（$(cell "$cloudflare_skill")）" "$used_sync" "$cloudflare_fix"
elif [[ ! -e $cloudflare_skill ]]; then
  add ng "$cloudflare_item" "標準の配置先にありません（$(cell "$cloudflare_skill")）" "$used_sync" "$cloudflare_fix"
elif [[ ! -d $cloudflare_skill ]]; then
  add ng "$cloudflare_item" "配置先がディレクトリではありません（$(cell "$cloudflare_skill")）" "$used_sync" "$cloudflare_fix"
else
  missing_files=''
  for required_file in SKILL.md RECONNAISSANCE.md HUNTING.md ATTACK-CLASSES.md \
    VALIDATION-AND-REPORTING.md report-schema.json validate-coverage-ledger.cjs validate-findings.cjs; do
    path="$cloudflare_skill/$required_file"
    if [[ ! -f $path || ! -r $path || ! -s $path ]]; then
      missing_files+="${missing_files:+、}$required_file"
    fi
  done
  if [[ -n $missing_files ]]; then
    add ng "$cloudflare_item" "配置が不完全です（$(cell "$cloudflare_skill")）。不足・読み取り不可・空のファイル: $missing_files" "$used_sync" "$cloudflare_fix"
  else
    add ok "$cloudflare_item" "主要ファイルを参照可能（$(cell "$cloudflare_skill")）" "$used_sync"
  fi
fi

# 監査結果の保存先（SKILL.md の ~/security-audit-skill/）に書けるか。-w で判定し、ディレクトリもファイルも作らない
save_dir="$HOME/security-audit-skill"
save_used="$used_sync（監査結果の保存）"
save_fix='`ls -ld ~/security-audit-skill` で権限を確かめ、書き込めるようにする'
if [[ -d $save_dir ]]; then
  if [[ -w $save_dir ]]; then
    add ok '監査結果の保存先' "書き込めます（$(cell "$save_dir")）" "$save_used"
  else
    add ng '監査結果の保存先' "書き込めません（$(cell "$save_dir")）" "$save_used" "$save_fix"
  fi
elif [[ -e $save_dir || -L $save_dir ]]; then
  add ng '監査結果の保存先' "ディレクトリではないか、リンク切れです（$(cell "$save_dir")）" "$save_used" "$save_fix"
elif [[ -w $HOME ]]; then
  add ok '監査結果の保存先' "まだありません（$(cell "$HOME") に作成できます）" "$save_used"
else
  add ng '監査結果の保存先' "作成できません（$(cell "$HOME") に書き込めません）" "$save_used" "$save_fix"
fi

# --- スキルの定義とリンク ------------------------------------------------------

count=0
for skill in "$skills_dir"/*/; do
  [[ -d $skill ]] || continue
  skill=${skill%/}
  name=${skill##*/}
  count=$((count + 1))

  # 定義: SKILL.md を読めて、フォルダ名と name・参照する補助ファイルが合い、呼び出し設定を読めるか
  reason=''
  ui_note=''
  if [[ ! -f $skill/SKILL.md || ! -r $skill/SKILL.md ]]; then
    reason='SKILL.md がないか読み取れません'
  else
    frontmatter=$(awk '/^---$/ { n++; next } n == 1' "$skill/SKILL.md")
    declared=$(sed -n 's/^name:[[:space:]]*//p' <<<"$frontmatter")
    [[ $declared == "$name" ]] || reason="name（${declared:-なし}）がフォルダ名と違う"
    refs=$(grep -o '](\([^)]*\))' "$skill/SKILL.md" | sed 's/^](//; s/)$//; s/#.*$//' | grep -v -e '^https:' -e '^http:' -e '^$' || true)
    while IFS= read -r ref; do
      [[ -z $ref || -e $skill/$ref ]] && continue
      reason+="${reason:+、}参照ファイルがない: $ref"
    done <<<"$refs"
    # 呼び出し設定: スキルはすべて明示指定専用（AGENTS.md）なので、agents/openai.yaml と allow_implicit_invocation: false が要る
    ui="$skill/agents/openai.yaml"
    if [[ -f $ui && -r $ui ]]; then
      if grep -Eq '^[[:space:]]+allow_implicit_invocation:[[:space:]]*false[[:space:]]*$' "$ui"; then
        ui_note='明示指定専用'
      else
        reason+="${reason:+、}agents/openai.yaml に allow_implicit_invocation: false がない"
      fi
    elif [[ -e $ui || -L $ui ]]; then
      reason+="${reason:+、}agents/openai.yaml を読み取れません"
    else
      reason+="${reason:+、}agents/openai.yaml がない"
    fi
  fi
  if [[ -n $reason ]]; then
    add ng "\`$name\` の定義" "$(cell "$reason")" "$name" 'このリポジトリのスキルの定義を直す（フォルダ名と name・参照ファイル・agents/openai.yaml の呼び出し設定を合わせる）'
  else
    add ok "\`$name\` の定義" "SKILL.md・name・参照ファイルを確認済み（$ui_note）" "$name"
  fi

  # リンク: 監査するプロジェクトで使うための ~/.agents/skills/<名前>（メインの checkout のスキルを指すこと）
  dest="$link_dir/$name"
  if [[ -L $dest && $dest -ef $skill ]]; then
    add ok "\`~/.agents/skills/$name\` のリンク" 'このスキルにリンク済み' '監査するプロジェクトで使うとき'
  else
    if [[ -L $dest && ! -e $dest ]]; then
      link_state='リンク切れ'
    elif [[ -L $dest ]]; then
      link_state='別の場所へのリンクあり'
    elif [[ -e $dest ]]; then
      link_state='同名のファイル・ディレクトリあり'
    else
      link_state='未リンク'
    fi
    add warn "\`~/.agents/skills/$name\` のリンク" "$link_state" '監査するプロジェクトで使うとき' "\`$link_script --codex\`${link_note}"
  fi
done
if ((count == 0)); then
  add ng 'Codex スキル' "見つかりません（$(cell "$skills_dir")）" '—'
fi

# --- 出力 ---------------------------------------------------------------------

if ((ng + warned == 0)); then
  echo "✅ すべての前提を満たしています（${#marks[@]} 項目）"
  exit 0
fi

if ((ng > 0)); then
  echo "**足りないものが ${ng} 件あります。** 下の「対処方法」を読んで対応してください。"
else
  echo "**確認が必要なものが ${warned} 件あります。** 下の「対処方法」を読んで対応してください。"
fi
echo
print_table
echo
echo "定義・設定の内容、スキル固有の依存関係、対象プロジェクトの検証環境は別途確認が必要です。"
if ((${#fixes[@]} > 0)); then
  echo
  echo "## 対処方法"
  echo
  printf '%s\n' "${fixes[@]}"
fi
exit 0
