#!/usr/bin/env bash
#
# migrate-data-ownership.sh — 迁移图片生成工作台数据目录的属主/权限。
#
# ##############################################################################
# ##  警告：只能对“已停止写入的数据副本”执行，绝不能对唯一生产原件运行。      ##
# ##  正确流程见 README「NAS 数据、快照与回滚」：先停容器/阻止写入 → 对        ##
# ##  app-data.json 与 images/ 做同一冻结点的一致快照 → 只在可写副本上运行     ##
# ##  本脚本 → 用同一 UID:GID 做读写探针 → 验证新镜像 → 再正式切换。          ##
# ##  在业务仍可写入时 chown/chmod 生产原件会造成账目损坏，且无法安全回滚。    ##
# ##############################################################################
#
# 用法：
#   deploy/migrate-data-ownership.sh --uid <UID> --gid <GID> --dir <数据副本目录> [--dry-run|--apply]
#
#   --uid   目标非 root 用户 UID（必填，正整数）
#   --gid   目标组 GID（必填，正整数）
#   --dir   数据副本根目录（必填，须已存在；通常是快照副本，如 /path/to/snapshot-data）
#   --dry-run  仅打印将执行的 chown/chmod（默认）
#   --apply    真正执行 chown/chmod（递归 chown 到 UID:GID，目录 700、文件 600）
#
# 退出码：0 成功；非 0 表示参数错误或执行失败。

set -euo pipefail

UID_ARG=""
GID_ARG=""
DIR_ARG=""
MODE="dry-run"

die() { echo "错误：$*" >&2; exit 1; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --uid) UID_ARG="${2:-}"; shift 2 ;;
    --gid) GID_ARG="${2:-}"; shift 2 ;;
    --dir) DIR_ARG="${2:-}"; shift 2 ;;
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    -h|--help) usage 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

[ -n "$UID_ARG" ] || die "缺少 --uid"
[ -n "$GID_ARG" ] || die "缺少 --gid"
[ -n "$DIR_ARG" ] || die "缺少 --dir"
case "$UID_ARG" in ''|*[!0-9]*) die "--uid 必须是非负整数：$UID_ARG" ;; esac
case "$GID_ARG" in ''|*[!0-9]*) die "--gid 必须是非负整数：$GID_ARG" ;; esac
[ "$UID_ARG" != "0" ] || die "拒绝迁移到 root(0)：容器必须以非 root 运行。"
[ "$GID_ARG" != "0" ] || die "拒绝迁移到 gid 0：请提供非 root 组。"
[ -d "$DIR_ARG" ] || die "目录不存在或不是目录：$DIR_ARG"

# 归一化为绝对路径，避免相对路径误伤。
DIR_ABS="$(cd "$DIR_ARG" && pwd)"
[ "$DIR_ABS" != "/" ] || die "拒绝对根目录 / 执行迁移。"

echo "==============================================================================="
echo " 数据属主迁移（模式：$MODE）"
echo " 目标身份：${UID_ARG}:${GID_ARG}"
echo " 数据副本：${DIR_ABS}"
echo "==============================================================================="
echo
echo "!!! 提醒：本脚本只能对停止写入后的数据副本执行，参照 README 的一致快照流程。"
echo "!!! 若这是唯一生产原件，请立即 Ctrl-C 停止。"
echo

echo "--- 当前属主状况（root 目录、app-data.json、images/ 抽样） ---"
ls -ldn "$DIR_ABS" || true
[ -e "$DIR_ABS/app-data.json" ] && ls -ln "$DIR_ABS/app-data.json" || echo "（无 app-data.json）"
if [ -d "$DIR_ABS/images" ]; then
  ls -ldn "$DIR_ABS/images" || true
  echo "images/ 内非 ${UID_ARG}:${GID_ARG} 属主的条目数："
  find "$DIR_ABS/images" -mindepth 1 \( ! -uid "$UID_ARG" -o ! -gid "$GID_ARG" \) 2>/dev/null | wc -l
else
  echo "（无 images/ 子目录）"
fi
echo

echo "--- 计划执行的操作 ---"
echo "chown -R ${UID_ARG}:${GID_ARG} ${DIR_ABS}"
echo "find ${DIR_ABS} -type d -exec chmod 700 {} +   # 目录 700"
echo "find ${DIR_ABS} -type f -exec chmod 600 {} +   # 文件 600"
echo

if [ "$MODE" = "dry-run" ]; then
  echo ">>> dry-run：未做任何修改。确认无误后用 --apply 重新运行。"
else
  echo ">>> apply：开始执行 ..."
  chown -R "${UID_ARG}:${GID_ARG}" "$DIR_ABS"
  find "$DIR_ABS" -type d -exec chmod 700 {} +
  find "$DIR_ABS" -type f -exec chmod 600 {} +
  echo ">>> 完成。迁移后属主抽样："
  ls -ldn "$DIR_ABS"
  [ -e "$DIR_ABS/app-data.json" ] && ls -ln "$DIR_ABS/app-data.json" || true
fi

echo
echo "--- 下一步：以同一身份对该副本做读写探针（复制执行） ---"
cat <<EOF
docker run --rm --user "${UID_ARG}:${GID_ARG}" -v "${DIR_ABS}:/data:rw" node:22-alpine \\
  sh -c 'test -r /data/app-data.json && test -d /data/images && test -x /data/images \\
    && probe=/data/.permission-probe-\$\$ && : > "\$probe" && rm "\$probe" && echo "探针通过：可读可写可遍历"'
EOF
echo
echo "探针通过后，再按 README 用同一 UID:GID 启动新容器验证历史账目/图片，最后正式切换。"
