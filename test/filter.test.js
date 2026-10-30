'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { extractCandidate } = require('../src/extract');
const { gate, parseExperience } = require('../src/filter');

const cfg = loadConfig(path.resolve(__dirname, '..'));
const TODAY = '2026-10-28';

const baseAnn = {
  source: 'xjtu_campus',
  kind: 'announcement',
  company: '深圳麦科田生物医疗技术股份有限公司',
  title: '深圳麦科田生物医疗技术股份有限公司2027年校园招聘',
  url: 'https://job.xjtu.edu.cn/f/recruitmentinfo/show?recruitmentId=abc123',
  city: '广东省深圳市',
  education: '硕士,博士',
  deadline: '2027-03-19',
};

const pos = (over = {}) =>
  extractCandidate(
    {
      source: 'endovastec_social',
      kind: 'position',
      company: '心脉医疗',
      title: '研发工程师',
      url: 'https://www.endovastec.com/SocialRecruitment/',
      city: '上海',
      ...over,
    },
    cfg,
    { now: new Date('2026-10-28T05:00:00Z') },
  );

test('公告：城市命中 + 相关 → keep', () => {
  const g = gate(extractCandidate(baseAnn, cfg), cfg, { today: TODAY });
  assert.equal(g.action, 'keep');
});

test('公告：城市未知 → review', () => {
  const g = gate(
    extractCandidate(
      { ...baseAnn, company: '麦科田生物医疗技术股份有限公司', title: '麦科田2027年校园招聘', city: '' },
      cfg,
    ),
    cfg,
    { today: TODAY },
  );
  assert.equal(g.action, 'review');
  assert.ok(g.reasons.includes('city_unknown'));
});

test('公告：截止日期已过 → skip expired', () => {
  const g = gate(extractCandidate({ ...baseAnn, deadline: '2026-01-01' }, cfg), cfg, { today: TODAY });
  assert.equal(g.action, 'skip');
  assert.ok(g.reasons.includes('expired'));
});

test('公告：博士后 → skip', () => {
  const g = gate(
    extractCandidate({ ...baseAnn, title: '深圳麦科田2027年博士后招聘', company: '深圳麦科田医疗' }, cfg),
    cfg,
    { today: TODAY },
  );
  assert.equal(g.action, 'skip');
  assert.ok(g.reasons.includes('postdoc'));
});

test('公告：无关组织/无关行业 → skip', () => {
  const g = gate(
    extractCandidate({ ...baseAnn, company: '海南师范大学', title: '海南师范大学2026年公开招聘' }, cfg),
    cfg,
    { today: TODAY },
  );
  assert.equal(g.action, 'skip');
  assert.ok(g.reasons.includes('org_excluded'));
});

test('岗位：城市不在名单 → skip city', () => {
  const g = gate(pos({ city: '武汉', title: '研发工程师（武汉）' }), cfg, { today: TODAY });
  assert.equal(g.action, 'skip');
  assert.ok(g.reasons.includes('city'));
});

test('岗位：要求 3 年以上非校招 → skip experience', () => {
  const g = gate(pos({ requirement: '要求3年以上相关工作经验，熟悉支架设计' }), cfg, { today: TODAY });
  assert.equal(g.action, 'skip');
  assert.ok(g.reasons.includes('experience'));
});

test('岗位：3 年以上但写了"优秀应届可放宽" → review experience_relax', () => {
  const g = gate(pos({ requirement: '3年以上经验，优秀应届可放宽，熟悉血管支架' }), cfg, { today: TODAY });
  assert.equal(g.action, 'review');
  assert.ok(g.reasons.includes('experience_relax'));
});

test('岗位：校招身份豁免经验限制', () => {
  const g = gate(pos({ requirement: '3年以上经验，熟悉血管支架' , title: '研发工程师（校园招聘）' }), cfg, { today: TODAY });
  assert.equal(g.action, 'keep');
});

test('岗位：搜索页 → skip url_invalid', () => {
  const g = gate(pos({ url: 'https://www.baidu.com/s?wd=血管支架研发' }), cfg, { today: TODAY });
  assert.equal(g.action, 'skip');
  assert.ok(g.reasons.includes('url_invalid'));
});

test('岗位：仅博士 → skip phd_only', () => {
  const g = gate(
    pos({ title: '血管支架研发工程师', education: '博士', requirement: '仅限博士研究生' }),
    cfg,
    { today: TODAY },
  );
  assert.equal(g.action, 'skip');
});

test('parseExperience 常见写法', () => {
  assert.deepEqual(parseExperience('3年以上工作经验'), { min: 3, max: null });
  assert.deepEqual(parseExperience('1-3年'), { min: 1, max: 3 });
  assert.equal(parseExperience('不限经验'), null);
  assert.equal(parseExperience(''), null);
});

test('岗位名排除：软件/算法/试剂/HR 直接丢，机械类靠方向词判定', () => {
  const sw = extractCandidate(
    {
      source: 'beisen',
      kind: 'position',
      company: '迈瑞医疗',
      title: '软件开发资深工程师（麻醉呼吸）',
      url: 'https://mindray.zhiye.com/social/detail/1',
      city: '深圳',
      requirement: '负责麻醉机软件模块开发，C++/QT。',
    },
    cfg,
    { now: new Date('2026-10-28T00:00:00+08:00') },
  );
  assert.deepEqual(gate(sw, cfg, { today: TODAY }), { action: 'skip', reasons: ['role_excluded'] });

  const generic = extractCandidate(
    {
      source: 'beisen',
      kind: 'position',
      company: '某医疗器械公司',
      title: '研发工程师（机械结构）',
      url: 'https://example.com/job/2',
      city: '上海',
      requirement: '负责设备结构设计，熟悉 SolidWorks 与有限元。',
    },
    cfg,
    { now: new Date('2026-10-28T00:00:00+08:00') },
  );
  const g = gate(generic, cfg, { today: TODAY });
  assert.equal(g.action, 'review');
  assert.ok(g.reasons.includes('direction_uncertain'));

  const hit = extractCandidate(
    {
      source: 'beisen',
      kind: 'position',
      company: '北芯生命',
      title: '器械研发工程师-机械和结构设计方向',
      url: 'https://insight-med.zhiye.com/social/detail/3',
      city: '深圳',
      requirement: '负责导管、球囊类血管介入器械的结构设计与力学仿真。',
    },
    cfg,
    { now: new Date('2026-10-28T00:00:00+08:00') },
  );
  assert.equal(gate(hit, cfg, { today: TODAY }).action, 'keep');
});
