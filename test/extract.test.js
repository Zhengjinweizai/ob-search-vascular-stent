'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { extractCandidate } = require('../src/extract');

const cfg = loadConfig(path.resolve(__dirname, '..'));

const annRaw = {
  source: 'xjtu_campus',
  kind: 'announcement',
  company: '深圳麦科田生物医疗技术股份有限公司',
  title: '深圳麦科田生物医疗技术股份有限公司2027年校园招聘',
  url: 'https://job.xjtu.edu.cn/f/recruitmentinfo/show?recruitmentId=abc123',
  city: '广东省深圳市',
  education: '硕士,博士',
  major: '材料科学与工程(研究生),生物医学工程(研究生),机械工程(本科生)',
  posted_at: '2026-10-20',
  deadline: '2027-03-19',
};

test('公告抽取：公司/标题/城市/截止日期/相关度', () => {
  const job = extractCandidate(annRaw, cfg, { now: new Date('2026-10-28T05:00:00Z') });
  assert.equal(job.company, annRaw.company);
  assert.equal(job.cities[0], '深圳');
  assert.equal(job.deadline, '2027-03-19');
  assert.equal(job.campus, true);
  assert.equal(job.kind, 'announcement');
  assert.equal(job.first_seen, '2026-10-28');
  assert.equal(job.is_search_url, false);
  assert.equal(job.medical_relevant, true);
});

test('岗位族只看标题/要求，不被专业列表污染（回归）', () => {
  const noise = {
    ...annRaw,
    company: '中国出版传媒股份有限公司',
    title: '中国出版集团2027届校园招聘',
    major: '力学(研究生),材料工程(研究生),机械工程(本科生)',
  };
  const job = extractCandidate(noise, cfg);
  assert.equal(job.job_family, '其他');
});

test('搜索页 URL 被识别为无效链接', () => {
  const job = extractCandidate(
    {
      ...annRaw,
      kind: 'position',
      title: '研发工程师',
      url: 'https://www.sogou.com/web?query=血管支架',
    },
    cfg,
  );
  assert.equal(job.is_search_url, true);
});

test('同一 URL 的 id 稳定', () => {
  const a = extractCandidate(annRaw, cfg);
  const b = extractCandidate({ ...annRaw, fetched_at: new Date().toISOString() }, cfg);
  assert.equal(a.id, b.id);
});

test('专业方向匹配：标题/要求命中支架/导管/介入等才算方向相关', () => {
  const stent = extractCandidate(
    {
      source: 'beisen',
      kind: 'position',
      company: '北芯生命',
      title: '导管研发工程师-复杂介入',
      url: 'https://insight-med.zhiye.com/social/detail/123',
      city: '深圳',
      requirement: '负责血管介入导管的结构设计与验证，熟悉球囊、导丝。',
    },
    cfg,
    { now: new Date('2026-10-28T00:00:00+08:00') },
  );
  assert.equal(stent.direction_match, true);
  assert.ok(stent.direction_hits.includes('导管'));
  assert.equal(stent.role_excluded, false);

  const it = extractCandidate(
    {
      source: 'beisen',
      kind: 'position',
      company: '迈瑞医疗',
      title: '软件开发资深工程师（麻醉呼吸）',
      url: 'https://mindray.zhiye.com/social/detail/456',
      city: '深圳',
      requirement: '负责麻醉机软件模块开发，C++/QT。',
    },
    cfg,
    { now: new Date('2026-10-28T00:00:00+08:00') },
  );
  assert.equal(it.role_excluded, true);
  assert.equal(it.direction_match, false);
});
