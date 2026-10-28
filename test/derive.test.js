'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { loadConfig } = require('../src/config');
const { writeExcel } = require('../src/derive/excel');
const { writeHtml } = require('../src/derive/html');
const { buildMessage, notify } = require('../src/derive/notify');

const cfg = loadConfig(path.resolve(__dirname, '..'));
const profile = cfg.profile;
const TODAY = '2026-10-28';

const scores = { family: 90, skill: 88, campus: 85, location: 95, company: 80, research: 92 };
const evidence = { family: '研发工程师', skill: '有限元分析', campus: '2027届校园招聘', location: '上海', company: '上市公司', research: '血管支架' };

const jobs = [
  {
    id: 'a',
    company: '心脉医疗',
    title: '血管支架研发工程师',
    requirement: '负责血管支架结构设计、有限元分析与生物相容性评价。',
    cities: ['上海'],
    url_canonical: 'https://www.endovastec.com/SocialRecruitment/',
    first_seen: TODAY,
    job_family: '研发',
    campus: true,
    deadline: '2026-10-31',
    gate: { action: 'keep', reasons: [] },
    scores,
    evidence,
    total: 89,
    why_apply: '方向完全对口',
    resume_tips: '突出支架结构设计与有限元项目',
  },
  {
    id: 'b',
    company: '某医疗器械公司',
    title: '注册专员',
    requirement: '负责医疗器械注册资料撰写。',
    cities: ['苏州'],
    url_canonical: 'https://www.example.com/job/2',
    first_seen: '2026-10-01',
    job_family: '注册法规',
    campus: false,
    deadline: '2026-10-20',
    gate: { action: 'keep', reasons: [] },
    scores: { ...scores, family: 60 },
    evidence,
    total: 72,
  },
  {
    id: 'c',
    company: '某公司',
    title: '销售代表',
    requirement: '负责区域销售。',
    cities: ['北京'],
    url_canonical: 'https://www.example.com/job/3',
    first_seen: '2026-10-01',
    gate: { action: 'skip', reasons: ['family'] },
    total: 40,
  },
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obs-'));
}

test('writeExcel：四张表、兼容旧 12 列并追加新列', async () => {
  const dir = tmpDir();
  const outFile = path.join(dir, '求职记录.xlsx');
  const res = await writeExcel(dir, { jobs, applications: [{ date: '2026-07-29', company: '微创医疗', title: '血管支架研发工程师', status: '已投递' }], profile, today: TODAY, outFile });
  assert.equal(res.stats.total, 3);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(outFile);
  const names = wb.worksheets.map((w) => w.name);
  assert.deepEqual(names, ['招聘信息', '推荐投递', '投递情况', '汇总统计']);

  const ws = wb.getWorksheet('招聘信息');
  assert.equal(ws.getRow(1).getCell(1).value, '日期');
  assert.equal(ws.getRow(1).getCell(12).value, '简历修改建议');
  assert.equal(ws.getRow(1).getCell(13).value, '岗位族');
  assert.equal(ws.getRow(1).getCell(16).value, '状态');
  assert.equal(ws.rowCount, 4);
  // 按总分降序
  assert.equal(ws.getRow(2).getCell(2).value, '心脉医疗');
  assert.equal(ws.getRow(2).getCell(7).value, 9, '1-10 分应为 round(total/10)');

  const rec = wb.getWorksheet('推荐投递');
  assert.equal(rec.rowCount, 2, '只有 a 通过（b 已过期且低于 88）');
  assert.equal(rec.getRow(2).getCell(2).value, '心脉医疗');

  const apps = wb.getWorksheet('投递情况');
  assert.equal(apps.rowCount, 2);
  assert.equal(apps.getRow(2).getCell(2).value, '微创医疗');
});

test('writeHtml：不截断、含筛选控件与全部岗位', () => {
  const dir = tmpDir();
  const outFile = path.join(dir, 'index.html');
  const res = writeHtml(dir, { jobs, profile, today: TODAY, outFile });
  assert.equal(res.total, 3);
  const html = fs.readFileSync(outFile, 'utf8');
  assert.ok((html.match(/<article class="job"/g) || []).length >= 3, '岗位卡片不截断');
  assert.ok(html.includes('id="q"') && html.includes('id="fam"') && html.includes('id="city"') && html.includes('id="campus"'));
  assert.ok(html.includes('心脉医疗'));
  assert.ok(html.includes('已截止') || html.includes('剩'), '应有截止倒计时');
  assert.ok(!/slice(0,s*(200|500))/.test(html), '不应有 200/500 截断逻辑残留');
});

test('buildMessage：标题含新增/强推计数，含截止提醒', () => {
  const msg = buildMessage(jobs, profile, { today: TODAY });
  assert.match(msg.title, /新增1/);
  assert.match(msg.title, /强推1/);
  assert.ok(msg.markdown.includes('心脉医疗'));
  assert.ok(msg.markdown.includes('7 天内截止'));
});

test('notify：dry-run 不外发并返回统计', async () => {
  const logs = [];
  const res = await notify(tmpDir(), { jobs, profile, today: TODAY, dryRun: true, log: (m) => logs.push(m) });
  assert.equal(res.dryRun, true);
  assert.equal(res.counts.todayNew, 1);
  assert.equal(res.counts.strong, 1);
  assert.ok(logs.join('\n').includes('求职日报'));
});

test('deliveryExitCode：有一个渠道送达就算成功（ServerChan 额度耗尽是常态）', () => {
  const { deliveryExitCode } = require('../src/derive/notify');
  assert.equal(deliveryExitCode({ results: [{ ok: false, quota: true }, { ok: true }], okCount: 1 }), 0);
  assert.equal(deliveryExitCode({ results: [{ ok: false }, { ok: false }], okCount: 0 }), 1, '全失败才失败');
  assert.equal(deliveryExitCode({ results: [], okCount: 0 }), 1, '没配渠道视为失败');
});
