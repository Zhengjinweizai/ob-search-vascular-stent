'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { parseDimensions, dedupe, makeId, legacyJobsFromSheet } = require('../scripts/import-legacy');
const { loadConfig } = require('../src/config');
const { isValidDateStr } = require('../src/date');

const ROOT = path.resolve(__dirname, '..');

test('parseDimensions 解析旧的"研究95/技能100"格式', () => {
  assert.deepEqual(parseDimensions('研究95/技能100/学历100/行业100/企业100'), {
    研究: 95,
    技能: 100,
    学历: 100,
    行业: 100,
    企业: 100,
  });
  assert.deepEqual(parseDimensions(''), {});
  assert.deepEqual(parseDimensions('研究: 90，技能: 80'), { 研究: 90, 技能: 80 });
});

test('makeId 对同一 canonical url 稳定，对不同岗位不同', () => {
  const a = makeId({ urlCanonical: 'https://a.com/job/1', companyNorm: 'A', titleNorm: '研发工程师' });
  const b = makeId({ urlCanonical: 'https://a.com/job/1', companyNorm: 'A', titleNorm: '研发工程师' });
  const c = makeId({ urlCanonical: 'https://a.com/job/2', companyNorm: 'A', titleNorm: '研发工程师' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{40}$/);
});

test('dedupe：同 URL + 同公司合并；泛称岗位不按公司+岗位合并', () => {
  const base = {
    company_norm: '心脉医疗',
    company: '心脉医疗',
    title: '研发工程师',
    title_norm: '研发工程师',
    url_canonical: 'https://www.endovastec.com/SocialRecruitment',
    first_seen: '2026-10-01',
    last_seen: '2026-10-01',
  };
  const rows = [
    { ...base, id: '1', legacy: { row: 2 } },
    { ...base, id: '2', legacy: { row: 3 } }, // 同 URL 同公司 → 合并
    { ...base, id: '3', legacy: { row: 4 } },
  ];
  const res = dedupe(rows);
  assert.equal(res.merged.length, 1);
  assert.equal(res.merged[0].duplicates.length, 2);

  // 泛称岗位 + 不同 URL：视为不同 opening，不合并
  const generic = [
    { ...base, id: 'a', url_canonical: 'https://a.com/job/1', legacy: { row: 10 } },
    { ...base, id: 'b', url_canonical: 'https://a.com/job/2', legacy: { row: 11 } },
  ];
  assert.equal(dedupe(generic).merged.length, 2);

  // 具体岗位 + 不同 URL、同公司同岗位 → 合并（同岗位重复发布）
  const specific = [
    { ...base, id: 'c', title_norm: '血管支架研发工程师', url_canonical: 'https://a.com/job/1', legacy: { row: 12 } },
    { ...base, id: 'd', title_norm: '血管支架研发工程师', url_canonical: 'https://a.com/job/2', legacy: { row: 13 } },
  ];
  assert.equal(dedupe(specific).merged.length, 1);
});

test('从真实 求职记录.xlsx 迁移：行数、日期、公司/岗位字段完整', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(ROOT, '求职记录.xlsx'));
  const ws = wb.getWorksheet('招聘信息');
  const { jobs } = legacyJobsFromSheet(ws, loadConfig(ROOT));
  assert.equal(jobs.length, 595);
  for (const job of jobs) {
    assert.ok(job.id);
    assert.ok(job.company);
    assert.ok(job.title);
    assert.ok(isValidDateStr(job.first_seen), `${job.company}/${job.title} 日期非法：${job.first_seen}`);
    assert.ok(job.job_family);
  }
  // 历史数据里确实存在搜索页 URL，必须被识别出来
  assert.ok(jobs.some((j) => j.url.includes('sogou.com') || j.url.includes('baidu.com')));
});
