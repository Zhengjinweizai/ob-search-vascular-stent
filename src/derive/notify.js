'use strict';
/**
 * 派生：微信推送（ServerChan / PushPlus）
 * 与旧版区别：不再上传第三方临时网盘；只推"今日新增 + 强推 + 截止提醒"；
 * 失败信息全部返回给调用方，由工作流决定是否告警。
 */

const path = require('node:path');
const { todayStr, parseDate, daysUntil } = require('../date');
const { matchLevelOf } = require('./level');
const { recommendJobs } = require('./excel');

const DEFAULT_TIMEOUT_MS = 10000;

function siteUrl() {
  const repo = process.env.GITHUB_REPOSITORY || '';
  if (!repo.includes('/')) return '';
  const [owner, name] = repo.split('/');
  return `https://${owner}.github.io/${name}/`;
}

function excelRawUrl() {
  const repo = process.env.GITHUB_REPOSITORY || '';
  if (!repo.includes('/')) return '';
  return `https://raw.githubusercontent.com/${repo}/main/求职记录.xlsx`;
}

function loadServerChanKeys() {
  const raw = process.env.SERVERCHAN_SENDKEY || '';
  if (raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  const file = path.join(process.cwd(), 'serverchan.key');
  if (require('node:fs').existsSync(file)) {
    return require('node:fs')
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  }
  return [];
}

function loadPushPlus() {
  const token = process.env.PUSHPLUS_TOKEN || '';
  return token.trim() ? { token: token.trim(), topic: process.env.PUSHPLUS_TOPIC || '' } : null;
}

async function postJson(url, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, text, json };
}

function daysLeft(job, today) {
  if (!job.deadline) return null;
  const d = parseDate(job.deadline, { today });
  return d ? daysUntil(d, today) : null;
}

/** 生成推送内容（纯函数，便于测试） */
function buildMessage(jobs, profile, { today = todayStr(), maxStrong = 5, maxToday = 8 } = {}) {
  const month = today.slice(0, 7);
  const strong = recommendJobs(jobs, profile, today);
  const todayNew = jobs
    .filter((j) => j.first_seen === today)
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
  const monthNew = jobs.filter((j) => String(j.first_seen || '').startsWith(month));
  const closing = strong
    .map((j) => ({ job: j, left: daysLeft(j, today) }))
    .filter((x) => x.left !== null && x.left >= 0 && x.left <= 7)
    .sort((a, b) => a.left - b.left);
  const campusNew = todayNew.filter((j) => j.campus);

  const title = `📊 【求职日报】${today} · 新增${todayNew.length} 强推${strong.length}`;
  const lines = [];
  lines.push(`### 今日新增 ${todayNew.length} 条（校招 ${campusNew.length}）｜本月 ${monthNew.length} 条｜强推 ${strong.length} 条`);
  if (todayNew.length) {
    lines.push('');
    for (const j of todayNew.slice(0, maxToday)) {
      const score = typeof j.total === 'number' ? j.total : '待评分';
      lines.push(`- **${j.title}** @ ${j.company}（${(j.cities || []).join('、') || '地点未知'}）${j.campus ? ' [校招]' : ''} · ${score} 分`);
      lines.push(`  ${j.url_canonical || j.url}${j.deadline ? ` · 截止 ${j.deadline}` : ''}`);
    }
    if (todayNew.length > maxToday) lines.push(`- …还有 ${todayNew.length - maxToday} 条，见网页`);
  } else {
    lines.push('', '今天没有抓到新岗位（可能不是校招季，或源站没有更新）。');
  }
  if (strong.length) {
    lines.push('', `### 值得优先投（总分 ≥ ${profile?.thresholds?.strong ?? 88} 且通过硬规则）`);
    for (const j of strong.slice(0, maxStrong)) {
      lines.push(`- **${j.title}** @ ${j.company} · ${j.total} 分 · ${matchLevelOf(j.total, profile?.thresholds)}${j.deadline ? ` · 截止 ${j.deadline}` : ''}`);
    }
    if (strong.length > maxStrong) lines.push(`- …共 ${strong.length} 条强推`);
  }
  if (closing.length) {
    lines.push('', '### ⏰ 7 天内截止');
    for (const { job, left } of closing.slice(0, 5)) {
      lines.push(`- ${job.title} @ ${job.company} · ${left === 0 ? '今天截止' : `剩 ${left} 天`}`);
    }
  }
  const site = siteUrl();
  if (site) lines.push('', `[完整日报](${site})`);
  const xlsx = excelRawUrl();
  if (xlsx) lines.push(`[Excel 表格](${xlsx})`);

  return {
    title,
    markdown: lines.join('\n'),
    counts: { todayNew: todayNew.length, strong: strong.length, closing: closing.length, monthNew: monthNew.length },
  };
}

async function sendServerChan(key, title, markdown) {
  const url = `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`;
  const res = await postJson(url, { title, desp: markdown });
  const ok = res.ok && (res.json?.code === 0 || res.json?.data?.pushid);
  return { channel: 'serverchan', ok, status: res.status, detail: res.text.slice(0, 200) };
}

async function sendPushPlus({ token, topic }, title, markdown) {
  const body = { token, title, content: markdown, template: 'markdown' };
  if (topic) body.topic = topic;
  const res = await postJson('https://www.pushplus.plus/send', body);
  const ok = res.ok && res.json?.code === 200;
  return { channel: 'pushplus', ok, status: res.status, detail: res.text.slice(0, 200) };
}

/**
 * @param {string} root
 * @param {{jobs?: object[], profile?: object, today?: string, dryRun?: boolean, log?: Function}} [opts]
 */
async function notify(root, opts = {}) {
  const store = require('../store');
  const { loadConfig } = require('../config');
  const profile = opts.profile || loadConfig(root).profile;
  const jobs = opts.jobs || store.readJobs(root);
  const today = opts.today || todayStr();
  const log = opts.log || console.log;
  const { title, markdown, counts } = buildMessage(jobs, profile, { today });
  const dryRun = opts.dryRun ?? (process.env.DRY_RUN === '1' || process.env.NOTIFY_DRY_RUN === '1');
  log(`== 推送内容：${title}`);
  log(`   今日新增 ${counts.todayNew}｜强推 ${counts.strong}｜7 天内截止 ${counts.closing}`);
  if (dryRun) {
    log(markdown);
    return { dryRun: true, counts, results: [] };
  }
  const results = [];
  for (const key of loadServerChanKeys()) results.push(await sendServerChan(key, title, markdown));
  const pushplus = loadPushPlus();
  if (pushplus) results.push(await sendPushPlus(pushplus, title, markdown));
  if (!results.length) {
    log('!! 未配置 SERVERCHAN_SENDKEY / PUSHPLUS_TOKEN，跳过推送');
  }
  for (const r of results) log(`   ${r.channel}: ${r.ok ? 'ok' : 'FAILED'} (${r.status}) ${r.detail}`);
  const okCount = results.filter((r) => r.ok).length;
  return { counts, results, okCount, failed: results.length - okCount };
}

module.exports = { notify, buildMessage, sendServerChan, sendPushPlus, siteUrl, excelRawUrl, loadServerChanKeys };
