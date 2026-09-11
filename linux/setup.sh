#!/bin/sh
# Claude Desktop (Linux) 一键入口：检查 Node，然后进入交互菜单或透传子命令
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "  [x] 未找到 node，请先安装 Node.js >= 18 (https://nodejs.org)"
  exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "  [x] Node.js 版本过低 ($(node -v))，需要 >= 18"
  exit 1
fi

if [ $# -gt 0 ]; then
  exec node "$DIR/setup.js" "$@"
fi

cat <<'EOF'

  Claude Desktop (Linux) 免登录 / 补丁工具
  ==========================================
  1) 方案 1  仅写配置，不改文件（HTTPS 端点，或 localhost 的 HTTP 端点）  [推荐]
  2) 方案 2  打补丁允许任意 HTTP 端点（生成便携副本 claude-portable/）
  3) 方案 3  官方登录模式功能解锁（实验性）
  s) 查看状态
  u) 卸载（移除配置 / 便携副本 / 原地补丁）
  q) 退出

EOF
printf "  选择: "
read -r choice
case "$choice" in
  1) exec node "$DIR/setup.js" config ;;
  2) exec node "$DIR/setup.js" http-patch ;;
  3) exec node "$DIR/setup.js" full-patch ;;
  s|S) exec node "$DIR/setup.js" status ;;
  u|U) exec node "$DIR/setup.js" uninstall ;;
  *) exit 0 ;;
esac
