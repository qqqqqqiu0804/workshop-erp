# deploy/ 部署配置目录

轻量化云端部署的全部配置文件。完整方案见 [`docs/轻量化云端部署方案.md`](../docs/轻量化云端部署方案.md)。

## 文件清单

| 文件 | 用途 | 目标位置 |
|---|---|---|
| `setup.sh` | 服务器初始化（时区 / Node 22 / Nginx / 防火墙 / 目录） | 在服务器上执行 |
| `workshop.service` | systemd 服务单元（开机自启 + 崩溃自动重启） | `/etc/systemd/system/workshop.service` |
| `nginx-workshop.conf` | Nginx 站点（HTTPS 终结 + 静态资源直出 + 反向代理） | `/etc/nginx/sites-available/workshop` |
| `backup.js` | 数据库热备份（SQLite `VACUUM INTO`，零 npm 依赖） | 项目内 `deploy/backup.js`，由 cron 每日调用 |

## 执行顺序

```bash
# 1. 初始化服务器
bash setup.sh

# 2. 部署代码
cd /home/ubuntu/workshop-app
git clone <你的仓库> .          # 或 scp / sftp 上传
npm install
npm run build:pages            # ⚠️ 必须执行：前端 pages.bundle.js 是构建产物

# 3. 托管服务
sudo cp deploy/workshop.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now workshop
sudo systemctl status workshop
curl http://127.0.0.1:3000/api/health    # 期望返回 {"ok":true}

# 4. Nginx + HTTPS
sudo cp deploy/nginx-workshop.conf /etc/nginx/sites-available/workshop
sudo ln -s /etc/nginx/sites-available/workshop /etc/nginx/sites-enabled/workshop
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 备份

`backup.js` 使用 SQLite 原生 `VACUUM INTO` 生成一致性快照，**不阻塞源库读写**；
产出的是完整可用数据库，恢复时直接替换 `data/workshop.db` 即可。

### 手动执行一次

```bash
DB_PATH=/home/ubuntu/workshop-app/data/workshop.db \
BACKUP_DIR=/home/ubuntu/workshop-app/backup \
/usr/bin/node --experimental-sqlite --disable-warning=ExperimentalWarning \
  /home/ubuntu/workshop-app/deploy/backup.js
```

期望输出：`[backup] OK workshop_20260831_103550.db 8.0KB tables=NN 0.1s`

### 配置每日定时任务

```bash
crontab -e
# 每天凌晨 2:00
0 2 * * * DB_PATH=/home/ubuntu/workshop-app/data/workshop.db BACKUP_DIR=/home/ubuntu/workshop-app/backup /usr/bin/node --experimental-sqlite --disable-warning=ExperimentalWarning /home/ubuntu/workshop-app/deploy/backup.js >> /var/log/workshop/backup.log 2>&1
```

### 可选：上传腾讯云 COS（异地第二副本）

安装腾讯云官方 CLI [coscli](https://cloud.tencent.com/document/product/436/63144)
（单文件 Go 二进制，**不引入 npm 依赖**），配置密钥后设置环境变量即可自动上传：

```bash
COS_UPLOAD_CMD='coscli cp %s cos://workshop-backup-125xxxxxxx/'
```

脚本会用备份文件路径替换 `%s` 后执行该命令，上传失败退出非零码（便于监控发现）。

## 备份恢复

```bash
sudo systemctl stop workshop
cp /home/ubuntu/workshop-app/backup/workshop_YYYYMMDD_HHMMSS.db \
   /home/ubuntu/workshop-app/data/workshop.db
sudo systemctl start workshop
```

> ⚠️ 恢复后立刻登录系统抽查最近单据，确认数据时间点符合预期。

## 常用运维命令

```bash
sudo systemctl status workshop          # 服务状态
sudo journalctl -u workshop -f          # 实时日志
sudo journalctl -u workshop --since today | grep -i 'locked\|error'   # 查 SQLite 锁/报错
sudo systemctl restart workshop         # 重启（改代码 / 改配置后）
tail -f /var/log/workshop/backup.log    # 备份日志
```
