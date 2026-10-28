'use strict';
/**
 * 派生：Excel 工作簿（四张表）
 * 数据源只有一个——data/jobs.jsonl。Excel 是给人看的视图，不再是"事实来源"。
 *
 * 表结构：
 *  1) 招聘信息：全部岗位（前 12 列与旧版兼容，后面追加岗位族/校招/截止/状态）
 *  2) 推荐投递：通过硬规则 + 总分 ≥ strong + 未过期/未关闭
 *  3) 投递情况：data/applications.json（手动维护）
 *  4) 汇总统计：分数分布/岗位族/城市/状态 + Top 20
 */

const path = require('node:path');
const ExcelJS = require('exceljs');
const { todayStr, parseDate } = require('../date');
const { matchLevelOf } = require('./level');

const JOBS_COLUMNS = [
  { header: '日期', key: 'first_seen', width: 12 },
  { header: '招聘单位名称', key: 'company', width: 34 },
  { header: '岗位名称', key: 'title', width: 40 },
  { header: '岗位要求（摘要，200字以内）', key: 'requirement', width: 60 },
  { header: '工作地点', key: 'location', width: 18 },
  { header: '招聘链接（URL）', key: 'url', width: 52 },
  { header: '匹配度评分（1-10分）', key: 'score10', width: 14 },
  { header: '备注', key: 'note', width: 40 },
  { header: '智能匹配分（0-100）', key: 'total', width: 12 },
  { header: '维度评分', key: 'dims', width: 36 },
  { header: '为什么投递', key: 'why_apply', width: 40 },
  { header: '简历修改建议', key: 'resume_tips', width: 40 },
  { header: '岗位族', key: 'job_family', width: 12 },
  { header: '是否校招', key: 'campus', width: 10 },
  { header: '截止日期', key: 'deadline', width: 12 },
  { header: '状态', key: 'status', width: 10 },
];

const APPLY_COLUMNS = [
  { header: '投递日期', key: 'date', width: 12 },
  { header: '招聘单位名称', key: 'company', width: 34 },
  { header: '岗位名称', key: 'title', width: 40 },
  { header: '投递状态', key: 'status', width: 12 },
  { header: '投递渠道', key: 'channel', width: 16 },
  { header: '跟进记录', key: 'note', width: 50 },
  { header: '下次跟进日期', key: 'next_follow_up', width: 14 },
];

const DIM_LABELS = {
  family: '岗位族',
  skill: '技能',
  campus: '校招',
  location: '城市',
  company: '公司',
  research: '方向',
};

function requirementSummary(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function dimsText(scores, evidence) {
  if (!scores) return '';
  const parts = Object.entries(DIM_LABELS)
    .filter(([k]) => typeof scores[k] === 'number')
    .map(([k, label]) => `${label}${scores[k]}`);
  const ev = evidence ? Object.values(evidence).filter(Boolean)[0] : '';
  return ev ? `${parts.join('/')}｜证据：${ev}` : parts.join('/');
}

function compareJobs(a, b) {
  const ta = typeof a.total === 'number' ? a.total : -1;
  const tb = typeof b.total === 'number' ? b.total : -1;
  if (tb !== ta) return tb - ta;
  return String(b.first_seen || '').localeCompare(String(a.first_seen || ''));
}

function levelOf(job, profile) {
  const th = profile?.thresholds || { strong: 88, consider: 70 };
  return matchLevelOf(job.total, th);
}

function isExpired(job, today) {
  if (!job.deadline) return false;
  const d = parseDate(job.deadline, { today });
  return d ? d < today : false;
}

function recommendJobs(jobs, profile, today) {
  const th = profile?.thresholds || { strong: 88 };
  return jobs
    .filter((j) => {
      if (j.gate?.action !== 'keep') return false;
      if (typeof j.total !== 'number' || j.total < th.strong) return false;
      if (j.status === 'closed') return false;
      if (j.is_search_url) return false;
      if (isExpired(j, today)) return false;
      return true;
    })
    .sort(compareJobs);
}

function summarize(jobs, profile, applications, today) {
  const month = today.slice(0, 7);
  const scored = jobs.filter((j) => typeof j.total === 'number');
  const buckets = [
    ['≥88', (j) => j.total >= 88],
    ['80-87', (j) => j.total >= 80 && j.total < 88],
    ['70-79', (j) => j.total >= 70 && j.total < 80],
    ['60-69', (j) => j.total >= 60 && j.total < 70],
    ['<60', (j) => j.total < 60],
  ].map(([label, fn]) => [label, scored.filter(fn).length]);
  const byFamily = {};
  const byCity = {};
  const byStatus = {};
  for (const j of jobs) {
    byFamily[j.job_family || '其他'] = (byFamily[j.job_family || '其他'] || 0) + 1;
    for (const c of j.cities?.length ? j.cities : ['未知']) byCity[c] = (byCity[c] || 0) + 1;
    byStatus[j.status || 'unknown'] = (byStatus[j.status || 'unknown'] || 0) + 1;
  }
  return {
    total: jobs.length,
    monthAdded: jobs.filter((j) => String(j.first_seen || '').startsWith(month)).length,
    scored: scored.length,
    unscored: jobs.length - scored.length,
    recommend: recommendJobs(jobs, profile, today).length,
    applications: applications.length,
    buckets,
    byFamily,
    byCity,
    byStatus,
    top: scored.sort(compareJobs).slice(0, 20),
    today,
  };
}

function styleSheet(ws, columns) {
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

/**
 * @param {string} root 仓库根目录
 * @param {{jobs?: object[], applications?: object[], profile?: object, outFile?: string, today?: string}} [opts]
 */
async function writeExcel(root, opts = {}) {
  const store = require('../store');
  const { loadConfig } = require('../config');
  const cfg = opts.profile ? { profile: opts.profile } : loadConfig(root);
  const profile = opts.profile || cfg.profile;
  const jobs = (opts.jobs || store.readJobs(root)).slice().sort(compareJobs);
  const applications = opts.applications || store.readApplications(root);
  const today = opts.today || todayStr();
  const outFile = opts.outFile || path.join(root, '求职记录.xlsx');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ob-search-vascular-stent';
  wb.created = new Date();

  // 1) 招聘信息
  const ws = wb.addWorksheet('招聘信息');
  styleSheet(ws, JOBS_COLUMNS);
  for (const job of jobs) {
    ws.addRow({
      first_seen: job.first_seen || '',
      company: job.company || '',
      title: job.title || '',
      requirement: requirementSummary(job.requirement),
      location: (job.cities || []).join('、') || job.city_raw || '',
      url: job.url_canonical || job.url || '',
      score10: typeof job.total === 'number' ? Math.round(job.total / 10) : '',
      note:
        typeof job.total === 'number'
          ? `智能匹配${job.total}分【${job.job_family || '其他'}】|${levelOf(job, profile)}|${(job.gate?.reasons || []).join(',') || '通过硬规则'}`
          : '待评分',
      total: typeof job.total === 'number' ? job.total : '',
      dims: dimsText(job.scores, job.evidence),
      why_apply: job.why_apply || '',
      resume_tips: job.resume_tips || '',
      job_family: job.job_family || '',
      campus: job.campus ? '是' : '否',
      deadline: job.deadline || '',
      status: job.status || 'unknown',
    });
  }
  ws.getColumn('url').eachCell((cell) => {
    const v = cell.value;
    if (typeof v === 'string' && /^https?:\/\//.test(v)) {
      cell.value = { text: v, hyperlink: v };
      cell.font = { color: { argb: 'FF1155CC' }, underline: true };
    }
  });
  ws.getColumn('requirement').eachCell((cell) => {
    cell.alignment = { wrapText: true, vertical: 'top' };
  });

  // 2) 推荐投递
  const rec = wb.addWorksheet('推荐投递');
  styleSheet(rec, JOBS_COLUMNS);
  for (const job of recommendJobs(jobs, profile, today)) {
    rec.addRow({
      first_seen: job.first_seen || '',
      company: job.company || '',
      title: job.title || '',
      requirement: requirementSummary(job.requirement),
      location: (job.cities || []).join('、') || job.city_raw || '',
      url: job.url_canonical || job.url || '',
      score10: Math.round(job.total / 10),
      note: `智能匹配${job.total}分【${job.job_family || '其他'}】|${levelOf(job, profile)}`,
      total: job.total,
      dims: dimsText(job.scores, job.evidence),
      why_apply: job.why_apply || '',
      resume_tips: job.resume_tips || '',
      job_family: job.job_family || '',
      campus: job.campus ? '是' : '否',
      deadline: job.deadline || '',
      status: job.status || 'unknown',
    });
  }

  // 3) 投递情况
  const app = wb.addWorksheet('投递情况');
  styleSheet(app, APPLY_COLUMNS);
  for (const row of applications) {
    app.addRow({
      date: row.date || row['投递日期'] || '',
      company: row.company || row['招聘单位名称'] || '',
      title: row.title || row['岗位名称'] || '',
      status: row.status || row['投递状态'] || '已投递',
      channel: row.channel || row['投递渠道'] || '',
      note: row.note || row['跟进记录'] || '',
      next_follow_up: row.next_follow_up || row['下次跟进日期'] || '',
    });
  }

  // 4) 汇总统计
  const sum = summarize(jobs, profile, applications, today);
  const stats = wb.addWorksheet('汇总统计');
  stats.columns = [
    { header: '指标', key: 'k', width: 26 },
    { header: '值', key: 'v', width: 60 },
  ];
  stats.getRow(1).font = { bold: true };
  const put = (k, v) => stats.addRow({ k, v: typeof v === 'object' ? JSON.stringify(v) : v });
  put('数据更新日期', today);
  put('岗位总数', sum.total);
  put('本月新增', sum.monthAdded);
  put('已评分', sum.scored);
  put('待评分', sum.unscored);
  put('推荐投递（硬规则+强推）', sum.recommend);
  put('投递记录', sum.applications);
  for (const [label, n] of sum.buckets) put(`分数分布 ${label}`, n);
  put('岗位族分布', sum.byFamily);
  put('城市分布', sum.byCity);
  put('状态分布', sum.byStatus);
  stats.addRow([]);
  stats.addRow(['Top 20（分数降序）']);
  stats.addRow(['排名', '公司', '岗位', '分数', '截止']);
  sum.top.forEach((j, i) => stats.addRow([i + 1, j.company, j.title, j.total, j.deadline || '']));
  stats.getRow(stats.rowCount - 21).font = { bold: true };

  await wb.xlsx.writeFile(outFile);
  return { file: outFile, stats: sum };
}

module.exports = { writeExcel, recommendJobs, summarize, JOBS_COLUMNS, requirementSummary, dimsText };
