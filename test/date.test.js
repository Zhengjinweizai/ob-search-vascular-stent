'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { todayStr, parseDate, daysUntil, isValidDateStr, addDays, isCampusSeason } = require('../src/date');

test('todayStr 使用北京时间而不是机器时区', () => {
  // UTC 2026-10-28T20:00Z = 北京 2026-10-29 04:00
  assert.equal(todayStr(new Date('2026-10-28T20:00:00Z')), '2026-10-29');
  assert.equal(todayStr(new Date('2026-10-28T15:59:00Z')), '2026-10-28');
  // 旧实现（本地时区）在 UTC runner 上会得到 2026-10-28，这里必须得到 10-29
  assert.notEqual(todayStr(new Date('2026-10-28T20:00:00Z')), '2026-10-28');
});

test('parseDate 支持常见中文/英文日期写法', () => {
  assert.equal(parseDate('2026-10-28'), '2026-10-28');
  assert.equal(parseDate('2026.10.28'), '2026-10-28');
  assert.equal(parseDate('2026/10/28'), '2026-10-28');
  assert.equal(parseDate('2026年10月28日'), '2026-10-28');
  assert.equal(parseDate('10月28日', { today: '2026-10-01' }), '2026-10-28');
  assert.equal(parseDate('2026-10-28 12:00:00'), '2026-10-28');
  assert.equal(parseDate('2026-10-28T00:00:00Z'), '2026-10-28');
});

test('parseDate 对非法日期返回 null', () => {
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('长期'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate(null), null);
  assert.equal(parseDate('2026-13-01'), null);
});

test('daysUntil 计算截止倒计时', () => {
  assert.equal(daysUntil('2026-10-31', '2026-10-28'), 3);
  assert.equal(daysUntil('2026-10-27', '2026-10-28'), -1);
  assert.equal(daysUntil('2026-10-28', '2026-10-28'), 0);
  assert.equal(daysUntil(null), null);
});

test('addDays / isValidDateStr / isCampusSeason', () => {
  assert.equal(addDays('2026-10-28', 4), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(isValidDateStr('2026-10-28'), true);
  assert.equal(isValidDateStr('2026-2-8'), false);
  assert.equal(isCampusSeason('2026-09-15'), true);
  assert.equal(isCampusSeason('2026-06-15'), false);
});
