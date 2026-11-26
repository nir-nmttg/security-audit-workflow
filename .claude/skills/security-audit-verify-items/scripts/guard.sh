#!/usr/bin/env bash
# security-audit-item-verifier の PreToolUse hook。Security Audit Item Verifier が実行フォルダの外を読む・書く事故と、GitHub への書き込みを止める。
# 悪意のある回避（sh -c で包むなど）は想定しない。監視はメインのセッションの権限（auto モードの分類器など）に任せる。
#
# 標準入力に hook の JSON を受け取り、許可なら終了コード 0、止めるなら理由を標準エラーに出して終了コード 2 で終わる。
# 実行フォルダとして認めるのは、置き場所（このリポジトリ直下の artifacts/security-audit-verify-items）のうち、
# prepare.sh で用意した（repo と worktree がある）フォルダだけ。
# - Read / Grep / Glob: パスが実行フォルダの中でなければ止める（Grep / Glob の path の省略も止める）
# - Write: 実体のパスが実行フォルダの items/ の中でなければ止める
# - Bash: 先頭が「cd <実行フォルダの中> &&」でなければ止める。gh、リポジトリの状態を変える git、依存を入れるコマンドも止める
#   git は、git のあとのグローバルオプション（-C・-c など）を飛ばした最初の語（サブコマンド）で判定する。-C・--git-dir・--work-tree の先は cd と同じ実行フォルダの中に限る。
#   git branch は一覧の形（-a・-r・--contains など）だけ通す。git remote・git config は止める
# 判定できないときも止める（hook は 2 以外の終了コードだと素通りになるため）。
set -uo pipefail

deny() { printf '%s\n' "$*" >&2; exit 2; }

source "$(dirname "$0")/lib.sh" || deny "security-audit-verify-items の guard.sh: lib.sh を読み込めないため止めました"
command -v jq >/dev/null || deny "security-audit-verify-items の guard.sh: jq がないため止めました（brew install jq）"
command -v perl >/dev/null || deny "security-audit-verify-items の guard.sh: perl がないため止めました"

input=$(cat)
field() { jq -r "$1 // \"\"" <<<"$input" 2>/dev/null || deny "security-audit-verify-items の guard.sh: hook の入力を読めないため止めました"; }
tool=$(field .tool_name) || exit 2
cwd=$(field .cwd) || exit 2

root=$(runs_root) || deny "security-audit-verify-items の guard.sh: 実行フォルダの置き場所を決められないため止めました"
root_real=$(cd -P "$root" 2>/dev/null && pwd) || deny "実行フォルダの置き場所 $root がありません。prepare.sh で用意した実行フォルダで作業してください"

# real <path>  実体のパスを出力する（相対パスは hook の cwd から）。.. の要素を含むパスは判定を誤りうるので止める
real() {
  [[ /$1/ == */../* ]] && deny "パスに .. を含めないでください: $1"
  [[ $1 == /* ]] && real_path "$1" || (cd "${cwd:-$PWD}" 2>/dev/null && real_path "$1")
}

# run_of <実体のパス>  そのパスを含む、用意済みの実行フォルダを出力する
run_of() {
  local p=$1 run
  [[ $p == "$root_real"/* ]] || return 1
  run=${p#"$root_real"/}
  run=${run%%/*}
  [[ -n $run && -f $root_real/$run/repo && -d $root_real/$run/worktree ]] || return 1
  printf '%s\n' "$root_real/$run"
}

hint="作業場所は依頼で渡された実行フォルダです"

# SEP は words_of が引用符の外の ; & | と改行に入れる印（語ではない）。これで git の引数の並びが切れる。
# ( ) ` $( <( は語の区切りにするだけで SEP にはしない（git の引数は続く。中の git は別に見つかる）
SEP=$'\001'

# word_end  words_of で組み立てている語を終える（リダイレクトの先の語なら捨てる）。words_of の変数を使う
word_end() {
  if ((have)); then
    if ((redir)); then redir=0; else W+=("$w"); fi
  fi
  w=""
  have=0
}

# words_of <文字列>  引用符と \ を外し、空白で区切った語を配列 W に入れる。引用符の外の ; & | と改行は SEP にする。
# リダイレクト（> や 2>・>&・&>）とその先の語は入れない。<(や >( は、< か > を語にして ( で区切る（引数の並びは続く））
words_of() {
  local s=$1 n=${#1} i=0 ch nx w="" have=0 q="" redir=0 op=0 prev_op=0 resume="" depth=0
  W=()
  while ((i < n)); do
    ch=${s:i:1}
    nx=${s:i + 1:1}
    i=$((i + 1))
    if [[ $q == "'" ]]; then
      if [[ $ch == "'" ]]; then q=""; else w+=$ch; fi
      continue
    fi
    if [[ $q == '"' ]]; then
      if [[ $ch == '"' ]]; then
        q=""
      elif [[ $ch == '`' ]]; then
        # 二重引用符の中のコマンド置換（`…` と $(…)）の中は、引用符の外と同じに語を分ける（中の git を見つけるため）。
        # 閉じたら二重引用符の中に戻る
        word_end
        q=""
        resume='`'
      elif [[ $ch == '$' && $nx == '(' ]]; then
        word_end
        i=$((i + 1))
        q=""
        resume=")"
        depth=0
      elif [[ $ch == '\' ]] && ((i < n)); then
        w+=${s:i:1}
        i=$((i + 1))
      else
        w+=$ch
      fi
      continue
    fi
    prev_op=$op
    op=0
    case $ch in
      "'" | '"') q=$ch; have=1 ;;
      '\') if ((i < n)); then w+=${s:i:1}; i=$((i + 1)); have=1; fi ;;
      '<' | '>')
        if [[ $nx == '(' ]]; then
          w+=$ch
          have=1
        else
          # 2> の 2 は出力先の番号なので捨てる
          if ((have)) && [[ $w =~ ^[0-9]+$ ]]; then w=""; have=0; fi
          word_end
          redir=1
          op=1
        fi ;;
      '&' | '|')
        if ((prev_op)); then
          : # >&1 や >|file の一部
        elif [[ $ch == '&' && $nx == '>' ]]; then
          word_end
          redir=1
          op=1
        else
          word_end
          redir=0
          W+=("$SEP")
        fi ;;
      ';' | $'\n') word_end; redir=0; W+=("$SEP") ;;
      '#')
        if ((have)); then
          w+=$ch
        else
          # 語頭の # はコメント。行末まで捨てる
          while ((i < n)) && [[ ${s:i:1} != $'\n' ]]; do i=$((i + 1)); done
        fi ;;
      '(')
        word_end
        [[ $resume == ")" ]] && depth=$((depth + 1)) ;;
      ')')
        word_end
        if [[ $resume == ")" ]]; then
          if ((depth > 0)); then depth=$((depth - 1)); else resume=""; q='"'; have=1; fi
        fi ;;
      '`')
        word_end
        if [[ $resume == '`' ]]; then resume=""; q='"'; have=1; fi ;;
      *) if [[ $ch == [[:space:]] ]]; then word_end; else w+=$ch; have=1; fi ;;
    esac
  done
  word_end
  # 引用符やコマンド置換が閉じていない（heredoc・入れ子など）と、後ろの git を見落としうるので判定できないものとして止める
  [[ -z $q && -z $resume ]] || deny "引用符かコマンド置換の閉じ方を判定できないため止めました。1 行の単純なコマンドに分けてください。${hint}"
  return 0
}

# git_path_check <パス>  git の -C などの先が、cd の先（cd_base）と同じ実行フォルダ（cd_run）の中かを確かめる
git_path_check() {
  local d=$1 rp=""
  [[ -n $d ]] || deny "git -C などの先のフォルダがありません。${hint}"
  [[ /$d/ == */../* ]] && deny "パスに .. を含めないでください: $d"
  case $d in
    *[\$\`*?\[{}]* | \~*) deny "展開されるパスは判定できないため止めました: $d" ;;
  esac
  if [[ $d == /* ]]; then rp=$(real_path "$d"); else rp=$(cd "$cd_base" 2>/dev/null && real_path "$d"); fi
  [[ -n $rp && $(run_of "$rp" 2>/dev/null) == "$cd_run" ]] ||
    deny "git の先は cd の先と同じ実行フォルダの中だけ使えます: $d。${hint}"
}

# check_branch <開始の位置>  git branch の引数（SEP まで）が一覧の形（-a・-r・-v・--no-color・--format=…・--contains <rev>・--list [パターン]）だけか確かめる
check_branch() {
  local k=$1 n=${#W[@]} w listing=0
  local msg="git branch は一覧の形（-a・-r・-v・--no-color・--format=…・--contains <rev>・--list [パターン]）だけ使えます。作成・削除・名前の変更はできません。必要なら報告に書いてください"
  while ((k < n)) && [[ ${W[k]} != "$SEP" ]]; do
    w=${W[k]}
    k=$((k + 1))
    [[ $w == *\$* ]] && deny "$msg"
    if [[ $w =~ ^-[arvl]+$ ]]; then
      [[ $w == *l* ]] && listing=1
      continue
    fi
    case $w in
      --all | --remotes | --no-color | --format=*) ;;
      --list) listing=1 ;;
      --contains | --no-contains)
        [[ $k -lt $n && ${W[k]} != "$SEP" && ${W[k]} != -* ]] || deny "$msg"
        k=$((k + 1)) ;;
      --contains=* | --no-contains=*) ;;
      -*) deny "$msg" ;;
      *) ((listing)) || deny "$msg" ;;
    esac
  done
  return 0
}

# check_git <git の語の位置>  git の呼び出し（SEP まで）を判定する。グローバルオプションを飛ばした最初の語（サブコマンド）で決める
check_git() {
  local j=$(($1 + 1)) n=${#W[@]} w sub=""
  while ((j < n)) && [[ ${W[j]} != "$SEP" ]]; do
    w=${W[j]}
    case $w in
      -C | --git-dir | --work-tree)
        [[ $((j + 1)) -lt $n && ${W[j + 1]} != "$SEP" ]] || deny "git $w の先のフォルダがありません。${hint}"
        git_path_check "${W[j + 1]}"
        j=$((j + 2)) ;;
      --git-dir=* | --work-tree=*)
        git_path_check "${w#*=}"
        j=$((j + 1)) ;;
      -c | --namespace | --super-prefix | --config-env)
        [[ ${W[j + 1]-} != "$SEP" ]] || break
        # 別名は任意のコマンドを動かせるので、-c で別名を決める形は止める
        [[ $w == -c && ${W[j + 1]-} == alias.* ]] && deny "git -c alias.… は使えません。${hint}"
        j=$((j + 2)) ;;
      -*) j=$((j + 1)) ;;
      *) sub=$w; break ;;
    esac
  done
  [[ -n $sub && $sub == *[\$*?\[{}]* ]] && deny "git のサブコマンドを判定できないため止めました: $sub。${hint}"
  # 読み取りだけのサブコマンドを許し、ほかは止める（状態を変えるものを並べて止める形では漏れが出るため）
  case $sub in
    "") ;;
    branch) check_branch $((j + 1)) ;;
    log | show | diff | diff-tree | diff-files | diff-index | range-diff | blame | annotate | grep | ls-files | ls-tree | cat-file | rev-parse | rev-list | \
      describe | shortlog | status | merge-base | name-rev | for-each-ref | show-ref | whatchanged | cherry | count-objects | check-ignore | check-attr | version | help) ;;
    *) deny "git $sub は使えません（使えるのは log・show・diff・blame・grep・ls-files・cat-file・rev-parse・branch の一覧など、読み取りだけ）。必要なら報告に書いてください" ;;
  esac
  return 0
}

case $tool in
  Read)
    path=$(field .tool_input.file_path) || exit 2
    [[ -n $path ]] || deny "file_path がありません"
    [[ /$path/ == */../* ]] && deny "パスに .. を含めないでください: $path"
    p=$(real "$path") || deny "パスを解決できないため止めました: $path"
    run_of "$p" >/dev/null || deny "実行フォルダの外は読めません: ${path}。${hint}"
    ;;
  Grep | Glob)
    path=$(field .tool_input.path) || exit 2
    [[ -n $path ]] || deny "path を指定してください（省略するとメインの作業フォルダが対象になります）。${hint}"
    p=$(real "$path") || deny "パスを解決できないため止めました: $path"
    run_of "$p" >/dev/null || deny "実行フォルダの外は検索できません: ${path}。${hint}"
    ;;
  Write)
    path=$(field .tool_input.file_path) || exit 2
    [[ -n $path ]] || deny "file_path がありません"
    p=$(real "$path") || deny "パスを解決できないため止めました: $path"
    run=$(run_of "$p") || deny "実行フォルダの外には書けません: ${path}。${hint}"
    [[ $p == "$run/items/"* ]] || deny "書けるのは実行フォルダの items/ の中だけです: $path"
    ;;
  Bash)
    cmd=$(field .tool_input.command) || exit 2
    cd_re='^[[:space:]]*cd[[:space:]]+("[^"]+"|'"'"'[^'"'"']+'"'"'|[^[:space:];&|]+)[[:space:]]*&&'
    [[ $cmd =~ $cd_re ]] ||
      deny "Bash は毎回メインの作業フォルダで始まります（cd は引き継がれません）。先頭に「cd <実行フォルダの中> &&」を付けてください。${hint}"
    dir=${BASH_REMATCH[1]}
    dir=${dir#[\"\']}
    dir=${dir%[\"\']}
    p=$(real "$dir") || deny "cd 先を解決できないため止めました: $dir"
    cd_run=$(run_of "$p") || deny "cd 先が実行フォルダの外です: ${dir}。${hint}"
    cd_base=$p
    sep='(^|[;&|(`[:space:]/])'
    grep -Eq "${sep}gh([[:space:]]|$)" <<<"$cmd" &&
      deny "gh は使えません。Issue のデータは実行フォルダの issues/ にあります"
    grep -q 'issue\.mjs' <<<"$cmd" &&
      deny "GitHub に書くスクリプト（issue.mjs）は親だけが使います。必要なら報告に書いてください"
    # git の呼び出しは、語の中の git（または /…/git）から、区切り（SEP）までの語で判定する
    words_of "$cmd"
    for ((i = 0; i < ${#W[@]}; i++)); do
      case ${W[i]} in git | /*/git) check_git "$i" ;; esac
    done
    opts='([[:space:]]+-[^[:space:]]+)*'
    pkg_re="${sep}((npm|pnpm)${opts}[[:space:]]+(install|i|ci|add|update|up|upgrade|uninstall|remove|rm|un)|yarn${opts}[[:space:]]+(add|install|remove|upgrade|up)|bundle${opts}[[:space:]]+(install|update|add)|gem${opts}[[:space:]]+install|pip3?${opts}[[:space:]]+(install|uninstall)|python3?${opts}[[:space:]]+-m[[:space:]]+pip${opts}[[:space:]]+(install|uninstall)|uv${opts}[[:space:]]+(add|remove|sync|lock|pip[[:space:]]+(install|uninstall|sync))|poetry${opts}[[:space:]]+(add|remove|install|update|lock|sync)|composer${opts}[[:space:]]+(install|require|update|remove)|cargo${opts}[[:space:]]+(add|install|update|remove)|go${opts}[[:space:]]+get|brew${opts}[[:space:]]+(install|upgrade))([[:space:]]|$)"
    grep -Eq "$pkg_re" <<<"$cmd" &&
      deny "依存パッケージのインストール・更新はできません。必要なら報告に書いてください"
    ;;
  *)
    deny "このツールは使えません: $tool"
    ;;
esac
exit 0
