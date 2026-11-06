'use strict';

/** 统一同步错误处理：handler 内 throw 即返回 400 + 错误信息，便于车间快速定位。 */
function wrap(fn) {
  return (req, res) => {
    try {
      const r = fn(req, res);
      if (r !== undefined && !res.headersSent) res.json(r);
    } catch (e) {
      console.error('[API ERROR]', e);
      res.status(400).json({ error: e.message || '服务器错误' });
    }
  };
}

/** 必填字段校验 */
function requireFields(obj, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || obj[f] === '') {
      throw new Error(`字段「${f}」不能为空`);
    }
  }
}

/** 严格解析正整数 ID，非法抛错（防止 :id 被注入/误传） */
function parseId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error('非法 ID: ' + v);
  return n;
}

module.exports = { wrap, requireFields, parseId };
