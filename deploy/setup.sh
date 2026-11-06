#!/bin/bash
# =============================================================
# workshop-app 腾讯云轻量服务器初始化脚本
# 适用环境：Ubuntu 22.04 LTS，以 ubuntu 用户执行（脚本内部使用 sudo）
# 用法：bash setup.sh
# =============================================================
set -e

APP_DIR="/home/ubuntu/workshop-app"

echo "=== [1/6] 设置时区 Asia/Shanghai ==="
echo "    单据号（YS+日期 / YW+日期）依赖系统本地时间，时区错则单号全乱"
sudo timedatectl set-timezone Asia/Shanghai
date

echo ""
echo "=== [2/6] 系统更新 ==="
sudo apt update -y && sudo apt upgrade -y

echo ""
echo "=== [3/6] 安装 Node.js 22（node:sqlite 要求 >= 22.5.0）==="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
fi
node -v
npm -v

echo ""
echo "=== [4/6] 安装 Nginx 与 Git ==="
sudo apt install -y nginx git

echo ""
echo "=== [5/6] 防火墙：只放行 22 / 80 / 443 ==="
echo "    ⚠️ 绝不放行 3000 —— 应用绑定 0.0.0.0:3000，放行等于把明文登录口暴露公网"
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow 80/tcp comment 'HTTP'
sudo ufw allow 443/tcp comment 'HTTPS'
sudo ufw --force enable
sudo ufw status

echo ""
echo "=== [6/6] 应用目录与日志目录 ==="
sudo mkdir -p "$APP_DIR"
sudo mkdir -p /var/log/workshop
sudo chown -R ubuntu:ubuntu "$APP_DIR" /var/log/workshop
# Nginx 以 www-data 运行，需能 traverse 到 public/ 读取静态资源
sudo chmod 755 /home/ubuntu

echo ""
echo "============================================="
echo "初始化完成。下一步："
echo "  1) 把代码放到 $APP_DIR"
echo "  2) cd $APP_DIR && npm install && npm run build:pages"
echo "  3) sudo cp deploy/workshop.service /etc/systemd/system/"
echo "  4) sudo systemctl daemon-reload && sudo systemctl enable --now workshop"
echo "  5) 配置 Nginx + certbot，见 deploy/nginx-workshop.conf 顶部注释"
echo "============================================="
