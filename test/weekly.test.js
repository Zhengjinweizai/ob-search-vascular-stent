'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { buildWeekly, startOfWeek, weekly } = require('../src/derive/weekly');

const cfg = loadConfig(path.resolve(__dirname, '..'));
const profile = cfg.profile;

test('startOfWeek：周三应落到本周一', () => {
  assert.equal(startOfWeek('2026-10-28'), '2026-10-26');
  assert.equal(startOfWeek('2026-10-26'), '2026-10-26');
  assert.equal(startOfWeek('2026-11-01'), '2026-10-26');
});

test('buildWeekly：统计本周新增、截止提醒与投递漏斗', () => {
  const jobs = [
    {
      id: '1',
      company: '心脉医疗',
      title: '血管支架研发工程师',
      first_seen: '2026-10-27',
      cities: ['上海'],
      job_family: '研发',
      campus: true,
      deadline: '2026-10-31',
      gate: { action: 'keep', reasons: [] },
      total: 90,
      scores: { family: 90 },
      url_canonical: 'https://a.com/1',
    },
    {
      id: '2',
      company: '某公司',
      title: '注册专员',
      first_seen: '2026-10-20',
      cities: ['苏州'],
      job_family: '注册法规',
      gate: { action: 'keep', reasons: [] },
      total: 70,
      url_canonical: 'https://a.com/2',
    },
  ];
  const apps = [{ status: '已投递' }, { status: '已投递' }, { status: '面试中' }];
  const report = buildWeekly(jobs, apps, profile, { today: '2026-10-28' });
  assert.equal(report.weekStart, '2026-10-26');
  assert.equal(report.counts.weekNew, 1);
  assert.equal(report.funnel['已投递'], 2);
  assert.ok(report.markdown.includes('校招季'));
  assert.ok(report.markdown.includes('7 天内截止'));
  assert.ok(report.markdown.includes('心脉医疗'));
});

test('weekly：落盘到 data/reports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-weekly-'));
  const outDir = path.join(dir, 'reports');
  const res = weekly(dir, { jobs: [], applications: [], profile, today: '2026-10-28', outDir });
  assert.ok(fs.existsSync(res.file));
  const text = fs.readFileSync(res.file, 'utf8');
  assert.match(text, /求职周报/);
});
