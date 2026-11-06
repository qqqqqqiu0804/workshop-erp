'use strict';

/**
 * workshop-app 数据库热备份脚本（零 npm 依赖）
 *
 * ── 实测结论（2026-08-31 / Node 22.22.2 / SQLite 3.51.2）───────────────
 * node:sqlite 的 DatabaseSync **没有 backup() 方法**，实例方法仅有：
 *   open / close / prepare / exec / function / location / aggregate
 *   createSession / applyChangeset / enableLoadExtension / loadExtension
 * 因此本脚本采用 SQLite 原生 `VACUUM INTO` 做在线热备份：
 *   - 生成一致性快照，不阻塞源库读写
 *   - 目标文件是完整可用数据库，恢复时直接替换即可
 *   - 无需系统 sqlite3 CLI，与 node:sqlite 同引擎，无版本错配风险
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node --experimental-sqlite --disable-warning=ExperimentalWarning backup.js
 *
 * ── 环境变量 ──────────────────────────────────────────────────────────
 *   DB_PATH         源库路径，默认 <项目>/data/workshop.db
 *   BACKUP_DIR      备份目录，默认 <项目>/backup
 *   KEEP_DAYS       本地保留天数，默认 7
 *   COS_UPLOAD_CMD  COS 上传命令（可选），含 %s 占位符会被替换为备份文件路径。
 *                   例：coscli cp %s cos://workshop-backup-125xxxxxxx/
 *                   留空则只落本地备份。
 */

const { DatabaseSync } = require('node:sqlite');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'workshop.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backup');
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 7);
const COS_UPLOAD_CMD = process.env.COS_UPLOAD_CMD || '';

/** 本地时间戳（服务器时区须为 Asia/Shanghai，否则文件名时间与业务时间对不上） */
function stampLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 统计库内表数量，用于备份后一致性校验 */
function countTables(dbFile) {
  const db = new DatabaseSync(dbFile);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get();
    return row ? row.n : 0;
  } finally {
    db.close();
  }
}

function main() {
  const t0 = Date.now();

  if (!fs.existsSync(DB_PATH)) {
    console.error(`[backup] 失败：源库不存在 ${DB_PATH}`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const target = path.join(BACKUP_DIR, `workshop_${stampLocal()}.db`);
  // VACUUM INTO 要求目标文件不存在，否则报错
  if (fs.existsSync(target)) fs.unlinkSync(target);

  const srcTables = countTables(DB_PATH);

  // 热备份：一致性快照，源库可继续读写
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec(`VACUUM INTO '${target.replace(/\\/g, '/')}'`);
  } finally {
    db.close();
  }

  if (!fs.existsSync(target)) {
    console.error('[backup] 失败：备份文件未生成');
    process.exit(1);
  }

  // 校验：备份必须能打开，且表数量与源库一致
  const bakTables = countTables(target);
  const bytes = fs.statSync(target).size;
  if (bakTables === 0 || bakTables !== srcTables) {
    console.error(`[backup] 校验失败：源库 ${srcTables} 张表，备份 ${bakTables} 张表`);
    process.exit(1);
  }

  console.log(
    `[backup] OK ${path.basename(target)} ` +
      `${(bytes / 1024).toFixed(1)}KB tables=${bakTables} ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s`
  );

  // 可选：上传对象存储（通过外部命令，避免引入 npm 依赖）
  if (COS_UPLOAD_CMD) {
    const cmd = COS_UPLOAD_CMD.replace('%s', `"${target}"`);
    try {
      execSync(cmd, { stdio: 'inherit' });
      console.log('[backup] COS 上传完成');
    } catch (e) {
      console.error('[backup] COS 上传失败：', e.message);
      process.exit(1);
    }
  }

  // 清理过期备份
  const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!/^workshop_\d{8}_\d{6}\.db$/.test(f)) continue;
    const fp = path.join(BACKUP_DIR, f);
    if (fs.statSync(fp).mtimeMs < cutoff) {
      // 阶段4「数据长期保存」拍板：每月 1 日的备份永久保留（月度冷备），其余按 KEEP_DAYS 轮换
      if (f.slice(15, 17) === '01') continue;
      fs.unlinkSync(fp);
      removed += 1;
    }
  }
  if (removed) console.log(`[backup] 清理过期备份 ${removed} 份（保留 ${KEEP_DAYS} 天）`);
}

main();
