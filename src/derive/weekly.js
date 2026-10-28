'use strict';
/**
 * 派生：周报（每周一推送 + 落盘）
 * 内容：本周新增 / 本周强推 / 7 天内截止 / 投递漏斗（已投-面试-拒绝）/ 校招季提示。
 */

const fs = require('node:fs');
const path = require('node:path');
const { todayStr, parseDate, daysUntil, isCampusSeason } = require('../date');
const { matchLevelOf } = require('./level');
const { recommendJobs } = require('./excel');

const STATUS_ORDER = ['已投递', '面试中', '已面试', '已拒绝', '已offer', '放弃'];

function startOfWeek(today) {
  const d = new Date(`${today}T00:00:00Z`);
  const dow = d.getUTCDay() || 7; // 周一=1 … 周日=7
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

function buildWeekly(jobs, applications, profile, { today = todayStr() } = {}) {
  const weekStart = startOfWeek(today);
  const weekNew = jobs.filter((j) => j.first_seen >= weekStart).sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
  const month = today.slice(0, 7);
  const monthNew = jobs.filter((j) => String(j.first_seen || '').startsWith(month));
  const strong = recommendJobs(jobs, profile, today);
  const closing = strong
    .map((j) => ({ job: j, left: daysUntil(parseDate(j.deadline, { today }), today) }))
    .filter((x) => x.left !== null && x.left >= 0 && x.left <= 7)
    .sort((a, b) => a.left - b.left);
  const funnel = {};
  for (const a of applications) {
    const s = a.status || a['投递状态'] || '已投递';
    funnel[s] = (funnel[s] || 0) + 1;
  }
  const funnelLines = STATUS_ORDER.filter((s) => funnel[s]).map((s) => `${s} ${funnel[s]}`);
  const campus = isCampusSeason(today);

  const title = `📅 求职周报 ${weekStart} ~ ${today}`;
  const lines = [];
  lines.push(`### 本周新增 ${weekNew.length} 条｜本月 ${monthNew.length} 条｜强推累计 ${strong.length} 条`);
  if (campus) lines.push('', '> 当前处于校招季（8–11 月），重点盯高校就业网与 2027 届专项公告。');
  if (weekNew.length) {
    lines.push('', '#### 本周新增（前 10）');
    for (const j of weekNew.slice(0, 10)) {
      lines.push(
        `- **${j.title}** @ ${j.company}（${(j.cities || []).join('、') || '地点未知'}）${typeof j.total === 'number' ? ` · ${j.total} 分` : ' · 待评分'}${j.campus ? ' [校招]' : ''}`,
      );
    }
  }
  if (strong.length) {
    lines.push('', `#### 强推（总分 ≥ ${profile?.thresholds?.strong ?? 88} 且通过硬规则）`);
    for (const j of strong.slice(0, 8)) {
      lines.push(`- ${j.title} @ ${j.company} · ${j.total} 分（${matchLevelOf(j.total, profile?.thresholds)}）${j.deadline ? ` · 截止 ${j.deadline}` : ''}`);
    }
  }
  if (closing.length) {
    lines.push('', '#### ⏰ 7 天内截止');
    for (const { job, left } of closing.slice(0, 8)) {
      lines.push(`- ${job.title} @ ${job.company} · ${left === 0 ? '今天截止' : `剩 ${left} 天`}`);
    }
  }
  lines.push('', '#### 投递漏斗');
  lines.push(funnelLines.length ? funnelLines.join(' · ') : '暂无投递记录（在 求职记录.xlsx 的「投递情况」表里维护）');
  const site = process.env.GITHUB_REPOSITORY ? `https://${process.env.GITHUB_REPOSITORY.split('/')[0]}.github.io/${process.env.GITHUB_REPOSITORY.split('/')[1]}/` : '';
  if (site) lines.push('', `[完整日报](${site})`);

  return {
    title,
    markdown: lines.join('\n'),
    weekStart,
    counts: { weekNew: weekNew.length, monthNew: monthNew.length, strong: strong.length, closing: closing.length, applications: applications.length },
    funnel,
  };
}

function writeWeekly(root, weekly, { outDir } = {}) {
  const dir = outDir || path.join(root, 'data', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `weekly-${weekly.weekStart}.md`);
  fs.writeFileSync(file, `# ${weekly.title}\n\n${weekly.markdown}\n`);
  return file;
}

/**
 * @param {string} root
 * @param {{jobs?: object[], applications?: object[], profile?: object, today?: string, outDir?: string}} [opts]
 */
function weekly(root, opts = {}) {
  const store = require('../store');
  const { loadConfig } = require('../config');
  const profile = opts.profile || loadConfig(root).profile;
  const jobs = opts.jobs || store.readJobs(root);
  const applications = opts.applications || store.readApplications(root);
  const today = opts.today || todayStr();
  const report = buildWeekly(jobs, applications, profile, { today });
  const file = writeWeekly(root, report, { outDir: opts.outDir });
  return { ...report, file };
}

module.exports = { weekly, buildWeekly, startOfWeek, writeWeekly, STATUS_ORDER };
