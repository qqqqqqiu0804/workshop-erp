'use strict';

/**
 * 生成自签 SSL 证书，供 server.js 通过环境变量启用 HTTPS。
 * 用法：node gencert.js
 * 成功后生成 ssl.key / ssl.crt（位于项目根目录）。
 * 启动 HTTPS：SSL_KEY=./ssl.key SSL_CERT=./ssl.crt npm start
 *
 * 注意：自签证书浏览器会报「非安全连接」警告，车间内网使用需手动信任；
 * 公网/正式环境请改用 CA 签发证书（如 Let's Encrypt）。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const KEY = path.join(__dirname, 'ssl.key');
const CRT = path.join(__dirname, 'ssl.crt');
const DAYS = 365;

function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function main() {
  if (!opensslAvailable()) {
    console.error('❌ 未找到 openssl，无法自动生成证书。');
    console.error('   请手动安装 OpenSSL 后重试，或使用以下命令（需 openssl 在 PATH 中）：');
    console.error(`   openssl req -x509 -newkey rsa:2048 -nodes ` +
      `-keyout ssl.key -out ssl.crt -days ${DAYS} -subj "/CN=workshop.local"`);
    process.exit(1);
  }

  if (fs.existsSync(KEY) || fs.existsSync(CRT)) {
    console.error('⚠️  已存在 ssl.key / ssl.crt，先删除再生成：');
    console.error('    del ssl.key ssl.crt   (Windows)');
    console.error('    rm ssl.key ssl.crt     (macOS/Linux)');
    process.exit(1);
  }

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY, '-out', CRT, '-days', String(DAYS),
      '-subj', '/CN=workshop.local',
    ], { stdio: 'inherit' });
    console.log('✅ 自签证书已生成：');
    console.log(`   ${KEY}`);
    console.log(`   ${CRT}`);
    console.log('');
    console.log('启用 HTTPS 启动服务：');
    console.log('   SSL_KEY=./ssl.key SSL_CERT=./ssl.crt npm start');
  } catch (e) {
    console.error('❌ 证书生成失败：', e.message);
    process.exit(1);
  }
}

main();
