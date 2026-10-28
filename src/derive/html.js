'use strict';
/**
 * 派生：静态日报网页（GitHub Pages）
 * 与旧版区别：不再 slice(200)/slice(500)；支持关键词搜索、岗位族/城市/校招筛选、截止日期倒计时。
 * 数据全部内联在页面里（约 600 条 < 500KB），不依赖外部请求。
 */

const fs = require('node:fs');
const path = require('node:path');
const { todayStr, parseDate, daysUntil } = require('../date');
const { matchLevelOf } = require('./level');
const { recommendJobs } = require('./excel');

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function daysLeftText(job, today) {
  if (!job.deadline) return '';
  const d = parseDate(job.deadline, { today });
  if (!d) return '';
  const left = daysUntil(d, today);
  if (left < 0) return '已截止';
  if (left === 0) return '今天截止';
  return `剩 ${left} 天`;
}

function jobCard(job, profile, today) {
  const level = matchLevelOf(job.total, profile?.thresholds || {});
  const dims = Object.entries(job.scores || {})
    .map(([k, v]) => `<span class="dim">${esc(k)} ${esc(v)}</span>`)
    .join('');
  const cities = (job.cities || []).join('、');
  const left = daysLeftText(job, today);
  const haystack = [job.company, job.title, job.requirement, cities, job.job_family].join(' ').toLowerCase();
  return `<article class="job" data-family="${esc(job.job_family || '其他')}" data-cities="${esc(cities)}" data-campus="${job.campus ? 1 : 0}" data-total="${typeof job.total === 'number' ? job.total : -1}" data-haystack="${esc(haystack)}">
  <header>
    <h3><a href="${esc(job.url_canonical || job.url)}" target="_blank" rel="noopener">${esc(job.title || '(无标题)')}</a></h3>
    <div class="meta"><strong>${esc(job.company || '')}</strong>${cities ? ` · ${esc(cities)}` : ''}${job.deadline ? ` · 截止 ${esc(job.deadline)}` : ''}${left ? ` · <em>${esc(left)}</em>` : ''}</div>
    <div class="tags"><span class="level ${typeof job.total === 'number' && job.total >= (profile?.thresholds?.strong ?? 88) ? 'hot' : ''}">${typeof job.total === 'number' ? `${job.total} · ${level}` : '待评分'}</span>${job.campus ? '<span class="tag">校招</span>' : ''}<span class="tag">${esc(job.job_family || '其他')}</span>${dims}</div>
  </header>
  <details>
    <summary>岗位要求 / 匹配依据 / 简历建议</summary>
    <p class="req">${esc(job.requirement || '（无岗位要求文本）')}</p>
    ${job.why_apply ? `<p><b>为什么投递：</b>${esc(job.why_apply)}</p>` : ''}
    ${job.resume_tips ? `<p><b>简历建议：</b>${esc(job.resume_tips)}</p>` : ''}
    ${job.evidence ? `<p class="ev"><b>证据：</b>${Object.entries(job.evidence).map(([k, v]) => `${esc(k)}：${esc(v)}`).join('；')}</p>` : ''}
    <p class="src">来源：${esc(job.source || '')}${job.url_status ? ` · HTTP ${esc(job.url_status)}` : ''}</p>
  </details>
</article>`;
}

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1f2328;--muted:#6b7280;--line:#e5e7eb;--hot:#c2410c;--accent:#1d4ed8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
header.top{padding:20px 24px;background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
h1{margin:0 0 6px;font-size:20px}.sub{color:var(--muted);font-size:13px}
.cards{display:flex;gap:12px;flex-wrap:wrap;padding:16px 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:150px}
.card b{display:block;font-size:22px}.card span{color:var(--muted);font-size:12px}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;padding:0 24px 12px}
.toolbar input,.toolbar select{padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;font-size:14px}
.toolbar input{flex:1;min-width:200px}
section{padding:0 24px 32px}
section h2{font-size:17px;margin:22px 0 12px}
.job{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.job h3{margin:0 0 6px;font-size:16px}.job h3 a{color:var(--accent);text-decoration:none}
.meta{color:var(--muted);font-size:13px}.meta em{color:var(--hot);font-style:normal}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.level{background:#eef2ff;color:#3730a3;border-radius:999px;padding:2px 10px;font-size:12px}
.level.hot{background:#ffedd5;color:var(--hot);font-weight:600}
.tag,.dim{background:#f3f4f6;color:#374151;border-radius:999px;padding:2px 9px;font-size:12px}
details{margin-top:10px}summary{cursor:pointer;color:var(--muted);font-size:13px}
.req{white-space:pre-wrap}.ev,.src{color:var(--muted);font-size:13px}
.empty{color:var(--muted);padding:20px 0}
footer{padding:20px 24px 40px;color:var(--muted);font-size:12px}
`;

const SCRIPT = `
(function(){
  var q=document.getElementById('q'), fam=document.getElementById('fam'), city=document.getElementById('city'), campus=document.getElementById('campus');
  var jobs=[].slice.call(document.querySelectorAll('.job'));
  function apply(){
    var kw=(q.value||'').trim().toLowerCase(), f=fam.value, c=city.value, onlyCampus=campus.checked;
    jobs.forEach(function(el){
      var ok=true;
      if(kw && (el.dataset.haystack||'').indexOf(kw)<0) ok=false;
      if(ok && f && el.dataset.family!==f) ok=false;
      if(ok && c && (el.dataset.cities||'').indexOf(c)<0) ok=false;
      if(ok && onlyCampus && el.dataset.campus!=='1') ok=false;
      el.style.display=ok?'':'none';
    });
    var visible=jobs.filter(function(el){return el.style.display!=='none'}).length;
    document.getElementById('count').textContent=visible;
  }
  ['input','change'].forEach(function(ev){ q.addEventListener(ev,apply); });
  fam.addEventListener('change',apply); city.addEventListener('change',apply); campus.addEventListener('change',apply);
  apply();
})();
`;

/**
 * @param {string} root
 * @param {{jobs?: object[], profile?: object, today?: string, outFile?: string}} [opts]
 */
function writeHtml(root, opts = {}) {
  const store = require('../store');
  const { loadConfig } = require('../config');
  const profile = opts.profile || loadConfig(root).profile;
  const jobs = (opts.jobs || store.readJobs(root)).slice();
  const today = opts.today || todayStr();
  const outFile = opts.outFile || path.join(root, 'index.html');

  const withScore = jobs.filter((j) => typeof j.total === 'number').sort((a, b) => b.total - a.total);
  const rec = recommendJobs(jobs, profile, today);
  const todayJobs = jobs.filter((j) => j.first_seen === today);
  const unexpired = withScore.filter((j) => !j.deadline || daysLeftText(j, today) !== '已截止');
  const families = [...new Set(jobs.map((j) => j.job_family || '其他'))].sort();
  const cities = [...new Set(jobs.flatMap((j) => j.cities || []))].sort();

  const sections = [
    rec.length
      ? `<section><h2>强烈推荐（${rec.length}）</h2>${rec.map((j) => jobCard(j, profile, today)).join('\n')}</section>`
      : '',
    todayJobs.length
      ? `<section><h2>今日新增（${todayJobs.length}）</h2>${todayJobs.map((j) => jobCard(j, profile, today)).join('\n')}</section>`
      : '',
    `<section><h2>全部岗位（<span id="count">${jobs.length}</span> / 共 ${jobs.length} 条）</h2>${withScore
      .concat(jobs.filter((j) => typeof j.total !== 'number'))
      .map((j) => jobCard(j, profile, today))
      .join('\n')}</section>`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>求职日报 ${esc(today)}</title>
<style>${STYLE}</style></head>
<body>
<header class="top">
  <h1>求职日报 · ${esc(today)}</h1>
  <div class="sub">生物医学工程硕士（血管支架方向）· 每天自动更新 · 数据来自 jobs.jsonl，脚本生成，可回放</div>
</header>
<div class="cards">
  <div class="card"><b>${jobs.length}</b><span>累计岗位</span></div>
  <div class="card"><b>${rec.length}</b><span>强烈推荐</span></div>
  <div class="card"><b>${todayJobs.length}</b><span>今日新增</span></div>
  <div class="card"><b>${unexpired.length}</b><span>未截止</span></div>
</div>
<div class="toolbar">
  <input id="q" type="search" placeholder="搜索公司 / 岗位 / 地点 / 要求关键词…">
  <select id="fam"><option value="">全部岗位族</option>${families.map((f) => `<option>${esc(f)}</option>`).join('')}</select>
  <select id="city"><option value="">全部城市</option>${cities.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
  <label style="align-self:center;font-size:14px"><input id="campus" type="checkbox"> 只看校招</label>
</div>
${sections}
<footer>生成时间 ${esc(today)} · 推荐口径：通过硬规则（未过期/城市/学历/经验/岗位族）且总分 ≥ ${esc(profile?.thresholds?.strong ?? 88)} · 分数只用于排序，不代表录用概率</footer>
<script>${SCRIPT}</script>
</body></html>`;

  fs.writeFileSync(outFile, html);
  return { file: outFile, total: jobs.length, recommend: rec.length, todayAdded: todayJobs.length };
}

module.exports = { writeHtml, jobCard, esc };
