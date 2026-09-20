#!/usr/bin/env bash
# 幕间 MuJian - systemd 服务安装脚本（自动探测 node 与项目路径）
# 用法：
#   bash install-service.sh            # 自动查找 server.js 所在目录
#   bash install-service.sh /path/to   # 手动指定项目目录
set -u

# 1) 自动探测 node 可执行文件
NODE_BIN=""
for c in "$(command -v node 2>/dev/null)" \
         "$(ls -d /www/server/nodejs/*/bin/node 2>/dev/null | head -1)" \
         "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)" \
         /usr/local/bin/node /usr/bin/node; do
  if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: 找不到 node，请先确认已安装 Node（宝塔装的话通常在 /www/server/nodejs/）"
  exit 1
fi
echo "node  -> $NODE_BIN ($("$NODE_BIN" -v))"

# 2) 确定项目目录（server.js 所在目录）
PROJ_DIR="${1:-}"
if [ -z "$PROJ_DIR" ]; then
  SF="$(find /www/wwwroot /home /root /opt -maxdepth 4 -name server.js 2>/dev/null | head -1)"
  PROJ_DIR="$(dirname "$SF")"
fi
if [ ! -f "$PROJ_DIR/server.js" ]; then
  echo "ERROR: 在 $PROJ_DIR 找不到 server.js，请手动指定：bash install-service.sh /你的/项目/目录"
  exit 1
fi
echo "proj  -> $PROJ_DIR"

# 2.5) 访问口令：写入项目内 .env，由 systemd 的 EnvironmentFile 注入进程环境。
#      用 .env 而非 unit 里的 Environment= 直接写，避免口令含 # $ 空格 被 systemd 当注释/变量展开。
read -r -p "访问口令（留空=完全开放，任何人可读写数据）：" -s KEY 2>/dev/null || read -r KEY
echo
ENV_FILE="$PROJ_DIR/.env"
if [ -n "$KEY" ]; then
  printf 'ACCESS_KEY=%s\n' "$KEY" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "已写入 $ENV_FILE （权限 600，仅 root 可读；重装/备份请留意别外泄）"
else
  rm -f "$ENV_FILE"
  echo "未设置口令：服务将对所有人开放（不建议公网部署）"
fi

# 3) 写 systemd 单元
cat > /etc/systemd/system/mujian.service <<EOF
[Unit]
Description=MuJian Server (幕间)
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJ_DIR
ExecStart=$NODE_BIN $PROJ_DIR/server.js
Environment=PORT=8910
EnvironmentFile=-$ENV_FILE
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

# 4) 启用并（按是否已运行决定）启动/重启
systemctl daemon-reload
systemctl enable mujian
if systemctl is-active --quiet mujian; then
  systemctl restart mujian
  echo "服务已在运行 -> 已重启以加载新口令"
else
  systemctl start mujian
fi
sleep 1
systemctl status mujian --no-pager || true

echo "--- 自检 ---"
curl -s -o /dev/null -w "本地访问 http://127.0.0.1:8910/  -> HTTP %{http_code}\n" http://127.0.0.1:8910/ || true
echo "查看日志: journalctl -u mujian -f"
