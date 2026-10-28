'use strict';

/**
 * 日期工具：所有"今天"都以北京时间（Asia/Shanghai）为准，
 * 不再依赖 CI 机器本地时区（旧实现用 new Date()，在 UTC runner 上会差 8 小时）。
 */

const TZ = 'Asia/Shanghai';
const DAY_MS = 24 * 3600 * 1000;

function todayStr(now = new Date()) {
  // en-CA 的日期格式就是 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/**
 * 把各种写法解析成 YYYY-MM-DD，解析不出返回 null。
 * 支持：2026-10-28 / 2026.10.28 / 2026/10/28 / 2026年10月28日 / 10月28日（按今年）
 * 注意：这里只做"日期字符串规范化"，不判断语义（发布时间 vs 发现时间由字段决定）。
 */
function parseDate(input, { today = todayStr() } = {}) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return today === null ? input.toISOString().slice(0, 10) : todayStr(input);
  }
  if (typeof input !== 'string') return null;
  const s = input.trim().replace(/\s+/g, ' ');
  if (!s) return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return fmt(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
  if (m) return fmt(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (m) return fmt(+today.slice(0, 4), +m[1], +m[2]);

  m = s.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (m) return fmt(+today.slice(0, 4), +m[1], +m[2]);

  // "2026-10-28 12:00:00"、"2026-10-28T00:00:00Z" 这类
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T\s]/);
  if (m) return fmt(+m[1], +m[2], +m[3]);

  return null;
}

function fmt(y, mo, d) {
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
  if (y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 距离 target 还有几天（负数=已过期），非法输入返回 null */
function daysUntil(target, today = todayStr()) {
  if (!isValidDateStr(target) || !isValidDateStr(today)) return null;
  return Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

function addDays(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 秋招季（8-11 月）或春招（2-4 月）：用于调整每日抓取预算 */
function isCampusSeason(today = todayStr()) {
  const month = Number(today.slice(5, 7));
  return (month >= 8 && month <= 11) || (month >= 2 && month <= 4);
}

module.exports = { TZ, todayStr, parseDate, isValidDateStr, daysUntil, addDays, isCampusSeason };
