const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const EXCEL_FILE = '求职记录.xlsx';
const STATE_FILE = '.searched-queries.json';
const CONFIG_FILE = 'portals.yml';
const PROFILE_FILE = 'profile_model.yml';

const MATCH_WEIGHTS = {
  research: 0.35,
  skill: 0.30,
  education: 0.15,
  industry: 0.10,
  company: 0.10,
};
const STRONG_THRESHOLD = 80;
const WORTH_THRESHOLD = 60;

function computeMatchScore(job) {
  const dims = {
    research: Number(job.d_research) || 0,
    skill: Number(job.d_skill) || 0,
    education: Number(job.d_edu) || 0,
    industry: Number(job.d_industry) || 0,
    company: Number(job.d_company) || 0,
  };
  const score = Math.round(
    dims.research * MATCH_WEIGHTS.research +
    dims.skill * MATCH_WEIGHTS.skill +
    dims.education * MATCH_WEIGHTS.education +
    dims.industry * MATCH_WEIGHTS.industry +
    dims.company * MATCH_WEIGHTS.company
  );
  return { score, dims };
}

function matchLevel(score) {
  if (score >= STRONG_THRESHOLD) return '强烈推荐';
  if (score >= WORTH_THRESHOLD) return '值得考虑';
  return '暂不推荐';
}

function dimsText(dims) {
  return `研究${dims.research}/技能${dims.skill}/学历${dims.education}/行业${dims.industry}/企业${dims.company}`;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.text !== undefined) v = v.text;
    else if (v.result !== undefined) v = v.result;
    else if (v.richText) v = v.richText.map(r => r.text).join('');
    else v = '';
  }
  let s = String(v);
  s = s.replace(/\r?\n/g, ' ').trim();
  if (/[",]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function ensureMatchHeaders(ws) {
  const headers = {
    9: '智能匹配分（0-100）',
    10: '维度评分',
    11: '为什么投递',
    12: '简历修改建议',
  };
  for (const [col, text] of Object.entries(headers)) {
    const c = Number(col);
    if (!ws.getCell(1, c).value) ws.getCell(1, c).value = text;
    if (!ws.getColumn(c).width) {
      const widths = { 9: 16, 10: 45, 11: 42, 12: 42 };
      ws.getColumn(c).width = widths[c];
    }
  }
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.appendFileSync('daily-log.txt', `[${ts}] ${msg}\n`);
  console.log(`[${ts}] ${msg}`);
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  return yaml.load(raw);
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return { searched_queries: [], last_run: null };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

async function getExistingJobs() {
  try {
    if (!fs.existsSync(EXCEL_FILE)) return [];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(EXCEL_FILE);
    const ws = wb.getWorksheet('招聘信息');
    if (!ws) return [];

    const jobs = [];
    ws.eachRow((row, ri) => {
      if (ri === 1) return;
      const c2 = (row.getCell(2).value || '').toString().trim();
      const c3 = (row.getCell(3).value || '').toString().trim();
      if (c2 && c3) {
        jobs.push({ company: c2, position: c3 });
      }
    });
    return jobs;
  } catch (e) {
    log(`读取已有职位失败: ${e.message}`);
    return [];
  }
}

async function readExcel() {
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(EXCEL_FILE)) {
    await wb.xlsx.readFile(EXCEL_FILE);
  } else {
    const ws = wb.addWorksheet('招聘信息');
    ws.columns = [
      { header: '日期', key: 'date', width: 14 },
      { header: '招聘单位名称', key: 'company', width: 22 },
      { header: '岗位名称', key: 'position', width: 30 },
      { header: '岗位要求（摘要，200字以内）', key: 'requirement', width: 45 },
      { header: '工作地点', key: 'location', width: 14 },
      { header: '招聘链接（URL）', key: 'url', width: 50 },
      { header: '匹配度评分（1-10分）', key: 'score', width: 16 },
      { header: '备注', key: 'note', width: 35 },
      { header: '智能匹配分（0-100）', key: 'match_score', width: 16 },
      { header: '维度评分', key: 'dims', width: 45 },
      { header: '为什么投递', key: 'apply_reason', width: 42 },
      { header: '简历修改建议', key: 'resume_advice', width: 42 },
    ];
  }
  return wb;
}

async function appendJobs(jobs) {
  const wb = await readExcel();
  let ws = wb.getWorksheet('招聘信息');
  if (!ws) {
    ws = wb.addWorksheet('招聘信息');
    ws.columns = [
      { header: '日期', key: 'date', width: 14 },
      { header: '招聘单位名称', key: 'company', width: 22 },
      { header: '岗位名称', key: 'position', width: 30 },
      { header: '岗位要求（摘要，200字以内）', key: 'requirement', width: 45 },
      { header: '工作地点', key: 'location', width: 14 },
      { header: '招聘链接（URL）', key: 'url', width: 50 },
      { header: '匹配度评分（1-10分）', key: 'score', width: 16 },
      { header: '备注', key: 'note', width: 35 },
      { header: '智能匹配分（0-100）', key: 'match_score', width: 16 },
      { header: '维度评分', key: 'dims', width: 45 },
      { header: '为什么投递', key: 'apply_reason', width: 42 },
      { header: '简历修改建议', key: 'resume_advice', width: 42 },
    ];
  }

  const existingKeys = new Set();
  ws.eachRow((row, ri) => {
    if (ri === 1) return;
    const c2 = (row.getCell(2).value || '').toString().trim();
    const c3 = (row.getCell(3).value || '').toString().trim();
    if (c2 && c3) existingKeys.add(`${c2}|||${c3}`);
  });

  let added = 0;
  let hasMatch = false;
  for (const job of jobs) {
    const key = `${job.company}|||${job.position}`;
    if (existingKeys.has(key)) continue;

    const lastRow = ws.rowCount + 1;
    ws.getCell(lastRow, 1).value = job.date || new Date().toISOString().slice(0, 10);
    ws.getCell(lastRow, 2).value = job.company;
    ws.getCell(lastRow, 3).value = job.position;
    ws.getCell(lastRow, 4).value = (job.requirement || '').slice(0, 200);
    ws.getCell(lastRow, 5).value = job.location || '';
    ws.getCell(lastRow, 6).value = job.url || '';

    if (job.d_research !== undefined || job.d_skill !== undefined || job.d_edu !== undefined ||
        job.d_industry !== undefined || job.d_company !== undefined || job.match_score !== undefined) {
      const m = computeMatchScore(job);
      const matchScore = job.match_score !== undefined ? Number(job.match_score) : m.score;
      const level = matchLevel(matchScore);
      const jt = job.job_type ? `【${job.job_type}】` : '';
      const reason = job.match_reason ? `|${job.match_reason}` : '';
      ws.getCell(lastRow, 7).value = Math.round(matchScore / 10);
      ws.getCell(lastRow, 8).value = `智能匹配${matchScore}分${jt}|${level}${reason}`;
      ws.getCell(lastRow, 9).value = matchScore;
      ws.getCell(lastRow, 10).value = dimsText(m.dims);
      ws.getCell(lastRow, 11).value = job.apply_reason || '';
      ws.getCell(lastRow, 12).value = job.resume_advice || '';
      hasMatch = true;
    } else {
      ws.getCell(lastRow, 7).value = job.score || 0;
      ws.getCell(lastRow, 8).value = job.note || '';
    }

    existingKeys.add(key);
    added++;
  }

  if (hasMatch) ensureMatchHeaders(ws);

  await wb.xlsx.writeFile(EXCEL_FILE);
  log(`新增 ${added} 条记录，总计 ${existingKeys.size} 条`);
  return added;
}

async function rebuildRecommendSheet(wb) {
  const src = wb.getWorksheet('招聘信息');
  if (!src) return 0;

  const recs = [];
  src.eachRow((row, ri) => {
    if (ri === 1) return;
    const matchScore = parseInt(row.getCell(9).value) || 0;
    if (matchScore < STRONG_THRESHOLD) return;
    const company = (row.getCell(2).value || '').toString().trim();
    if (!company) return;
    recs.push({
      level: matchLevel(matchScore),
      match_score: matchScore,
      date: row.getCell(1).value || '',
      company,
      position: (row.getCell(3).value || '').toString(),
      requirement: (row.getCell(4).value || '').toString(),
      location: (row.getCell(5).value || '').toString(),
      url: (row.getCell(6).value || '').toString(),
      dims: (row.getCell(10).value || '').toString(),
      apply_reason: (row.getCell(11).value || '').toString(),
      resume_advice: (row.getCell(12).value || '').toString(),
    });
  });

  recs.sort((a, b) => b.match_score - a.match_score || String(a.date).localeCompare(String(b.date)));

  const old = wb.getWorksheet('推荐投递');
  if (old) wb.removeWorksheet(old.id);
  const ws = wb.addWorksheet('推荐投递');

  const headers = ['推荐级别', '匹配分', '日期', '招聘单位名称', '岗位名称', '工作地点', '招聘链接（URL）', '维度评分', '为什么投递', '简历修改建议', '岗位要求'];
  for (let i = 0; i < headers.length; i++) {
    const cell = ws.getCell(1, i + 1);
    cell.value = headers[i];
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC00000' } };
    cell.alignment = { horizontal: 'center' };
  }

  recs.forEach((r, i) => {
    const row = i + 2;
    ws.getCell(row, 1).value = r.level;
    ws.getCell(row, 2).value = r.match_score;
    ws.getCell(row, 3).value = r.date;
    ws.getCell(row, 4).value = r.company;
    ws.getCell(row, 5).value = r.position;
    ws.getCell(row, 6).value = r.location;
    ws.getCell(row, 7).value = r.url;
    ws.getCell(row, 8).value = r.dims;
    ws.getCell(row, 9).value = r.apply_reason;
    ws.getCell(row, 10).value = r.resume_advice;
    ws.getCell(row, 11).value = r.requirement;
  });

  const widths = [12, 8, 12, 26, 28, 14, 42, 32, 48, 48, 50];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  log(`推荐投递表已更新: ${recs.length} 条强烈推荐职位`);
  return recs.length;
}

async function updateSummary() {
  const wb = await readExcel();
  const ws = wb.getWorksheet('招聘信息');
  if (!ws) { log('招聘信息表不存在'); return; }

  const rows = [];
  ws.eachRow((row, ri) => {
    if (ri === 1) return;
    rows.push({
      date: row.getCell(1).value,
      company: (row.getCell(2).value || '').toString(),
      position: (row.getCell(3).value || '').toString(),
      requirement: (row.getCell(4).value || '').toString(),
      location: (row.getCell(5).value || '').toString(),
      url: (row.getCell(6).value || '').toString(),
      score: parseInt(row.getCell(7).value) || 0,
      note: (row.getCell(8).value || '').toString(),
    });
  });

  const scores = rows.map(r => r.score);
  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '0.0';
  const scoreDist = {};
  for (let i = 1; i <= 10; i++) scoreDist[i] = 0;
  scores.forEach(s => { if (s >= 1 && s <= 10) scoreDist[s]++; });

  const topJobs = [...rows].sort((a, b) => b.score - a.score || a.date?.localeCompare?.(b.date) || 0);

  // Remove old summary sheet if exists
  const oldSheet = wb.getWorksheet('汇总统计');
  if (oldSheet) wb.removeWorksheet(oldSheet.id);

  const sumSheet = wb.addWorksheet('汇总统计');

  let r = 1;
  // Title
  sumSheet.mergeCells(`A${r}:F${r}`);
  const titleCell = sumSheet.getCell(`A${r}`);
  titleCell.value = '求职信息汇总统计';
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: 'center' };
  r += 2;

  // Overall stats
  sumSheet.getCell(`A${r}`).value = '统计项目';
  sumSheet.getCell(`B${r}`).value = '数值';
  sumSheet.getCell(`A${r}`).font = sumSheet.getCell(`B${r}`).font = { bold: true };
  r++;

  const stats = [
    ['职位总数', rows.length],
    ['平均匹配度', avgScore],
    ['最高匹配度', scores.length ? Math.max(...scores) : 0],
    ['最低匹配度', scores.length ? Math.min(...scores) : 0],
    ['9-10分（高度匹配）', scoreDist[9] + scoreDist[10]],
    ['8分（方向匹配）', scoreDist[8]],
    ['7分（相关可投）', scoreDist[7]],
    ['数据更新日期', new Date().toISOString().slice(0, 10)],
  ];

  for (const [label, val] of stats) {
    sumSheet.getCell(`A${r}`).value = label;
    sumSheet.getCell(`B${r}`).value = val;
    r++;
  }

  r += 2;

  // Score distribution chart data
  sumSheet.mergeCells(`A${r}:F${r}`);
  sumSheet.getCell(`A${r}`).value = '匹配度评分分布';
  sumSheet.getCell(`A${r}`).font = { bold: true, size: 12 };
  r++;

  sumSheet.getCell(`A${r}`).value = '评分';
  sumSheet.getCell(`B${r}`).value = '数量';
  sumSheet.getCell(`A${r}`).font = sumSheet.getCell(`B${r}`).font = { bold: true };
  r++;

  for (let i = 10; i >= 1; i--) {
    sumSheet.getCell(`A${r}`).value = `${i} 分`;
    sumSheet.getCell(`B${r}`).value = scoreDist[i] || 0;
    if (scoreDist[i] > 0) {
      sumSheet.getCell(`B${r}`).font = { bold: true };
    }
    r++;
  }

  r += 2;

  // Top jobs list (up to 200)
  sumSheet.mergeCells(`A${r}:H${r}`);
  sumSheet.getCell(`A${r}`).value = '职位列表（按匹配度降序，最多200条）';
  sumSheet.getCell(`A${r}`).font = { bold: true, size: 12 };
  r++;

  const headers = ['排名', '日期', '招聘单位名称', '岗位名称', '工作地点', '招聘链接（URL）', '匹配度评分', '备注'];
  for (let i = 0; i < headers.length; i++) {
    const cell = sumSheet.getCell(r, i + 1);
    cell.value = headers[i];
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center' };
  }
  r++;

  const displayJobs = topJobs.slice(0, 200);
  for (let i = 0; i < displayJobs.length; i++) {
    const job = displayJobs[i];
    sumSheet.getCell(r, 1).value = i + 1;
    sumSheet.getCell(r, 2).value = job.date || '';
    sumSheet.getCell(r, 3).value = job.company;
    sumSheet.getCell(r, 4).value = job.position;
    sumSheet.getCell(r, 5).value = job.location;
    sumSheet.getCell(r, 6).value = job.url || '';
    sumSheet.getCell(r, 7).value = job.score;
    sumSheet.getCell(r, 8).value = job.note;
    r++;
  }

  // Set column widths for summary sheet
  sumSheet.getColumn(1).width = 8;
  sumSheet.getColumn(2).width = 14;
  sumSheet.getColumn(3).width = 22;
  sumSheet.getColumn(4).width = 30;
  sumSheet.getColumn(5).width = 14;
  sumSheet.getColumn(6).width = 55;
  sumSheet.getColumn(7).width = 14;
  sumSheet.getColumn(8).width = 35;

  await wb.xlsx.writeFile(EXCEL_FILE);
  log(`汇总统计表已更新: ${rows.length} 条职位，平均分 ${avgScore}`);
}

// --- CLI ---
const mode = process.argv[2];

if (mode === 'check') {
  const config = loadConfig();

  const result = {
    search_mode: 'daily-full',
    search_queries: config.search_queries.filter(q => q.enabled !== false).map(q => ({ name: q.name, query: q.query })),
    university_career_sites: config.university_career_sites.filter(s => s.enabled !== false).map(s => ({
      name: s.name, url: s.url
    })),
    wechat_accounts: config.wechat_accounts.filter(a => a.enabled !== false).map(a => a.name),
    tracked_companies: config.tracked_companies.filter(c => c.enabled !== false).map(c => ({
      name: c.name, careers_url: c.careers_url
    })),
    existing_job_count: 0,
  };

  getExistingJobs().then(jobs => {
    result.existing_job_count = jobs.length;
    console.log(JSON.stringify(result, null, 2));
  });

} else if (mode === 'done') {
  // Mark queries as searched
  const names = process.argv.slice(3);
  const state = loadState();
  const searched = new Set(state.searched_queries || []);
  names.forEach(n => searched.add(n));
  state.searched_queries = [...searched];
  state.last_run = new Date().toISOString();
  saveState(state);
  log(`已标记 ${names.length} 个查询为已完成`);
  console.log(JSON.stringify({ status: 'ok', searched: state.searched_queries.length }));

} else if (mode === 'append') {
  // Append jobs from stdin JSON
  let data = '';
  process.stdin.on('data', chunk => data += chunk);
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(data);
      if (!input.jobs || !Array.isArray(input.jobs)) {
        console.error('需要 jobs 数组');
        process.exit(1);
      }
      const added = await appendJobs(input.jobs);
      const queryNames = input.queries || [];
      if (queryNames.length > 0) {
        const state = loadState();
        const searched = new Set(state.searched_queries || []);
        queryNames.forEach(n => searched.add(n));
        state.searched_queries = [...searched];
        state.last_run = new Date().toISOString();
        saveState(state);
      }
      log(`追加完成: 新增 ${added} 条`);
      console.log(JSON.stringify({ added }));
    } catch (e) {
      console.error(`追加失败: ${e.message}`);
      process.exit(1);
    }
  });

} else if (mode === 'append-file') {
  // Append jobs from a JSON file read directly via fs (no stdin/pipe, avoids encoding issues)
  const filePath = process.argv[3];
  if (!filePath) {
    console.error('用法: node search-engine.cjs append-file <json文件路径>');
    process.exit(1);
  }
  (async () => {
    try {
      const input = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!input.jobs || !Array.isArray(input.jobs)) {
        console.error('需要 jobs 数组');
        process.exit(1);
      }
      const added = await appendJobs(input.jobs);
      const queryNames = input.queries || [];
      if (queryNames.length > 0) {
        const state = loadState();
        const searched = new Set(state.searched_queries || []);
        queryNames.forEach(n => searched.add(n));
        state.searched_queries = [...searched];
        state.last_run = new Date().toISOString();
        saveState(state);
      }
      log(`追加完成: 新增 ${added} 条`);
      console.log(JSON.stringify({ added }));
    } catch (e) {
      console.error(`追加失败: ${e.message}`);
      process.exit(1);
    }
  })();

} else if (mode === 'match') {
  // 智能匹配: 读含 5 维评分的 new-jobs.json -> 加权算分 -> 追加写入 -> 重建推荐投递 -> 更新汇总
  const filePath = process.argv[3];
  if (!filePath) {
    console.error('用法: node search-engine.cjs match <json文件路径>');
    process.exit(1);
  }
  (async () => {
    try {
      const input = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!input.jobs || !Array.isArray(input.jobs)) {
        console.error('需要 jobs 数组');
        process.exit(1);
      }
      const added = await appendJobs(input.jobs);
      const wb = await readExcel();
      const recCount = await rebuildRecommendSheet(wb);
      await wb.xlsx.writeFile(EXCEL_FILE);
      const queryNames = input.queries || [];
      if (queryNames.length > 0) {
        const state = loadState();
        const searched = new Set(state.searched_queries || []);
        queryNames.forEach(n => searched.add(n));
        state.searched_queries = [...searched];
        state.last_run = new Date().toISOString();
        saveState(state);
      }
      await updateSummary();
      log(`智能匹配完成: 新增 ${added} 条，强烈推荐 ${recCount} 条`);
      console.log(JSON.stringify({ added, strong_recommend: recCount }));
    } catch (e) {
      console.error(`智能匹配失败: ${e.message}`);
      process.exit(1);
    }
  })();

} else if (mode === 'export') {
  // 导出第7列 >= 7 的历史职位到 json（供回填评分用）
  const filePath = process.argv[3] || 'backfill-input.json';
  (async () => {
    const wb = await readExcel();
    const ws = wb.getWorksheet('招聘信息');
    const out = [];
    if (ws) {
      ws.eachRow((row, ri) => {
        if (ri === 1) return;
        const score = parseInt(row.getCell(7).value) || 0;
        if (score < 7) return;
        out.push({
          company: (row.getCell(2).value || '').toString().trim(),
          position: (row.getCell(3).value || '').toString().trim(),
          requirement: (row.getCell(4).value || '').toString(),
          location: (row.getCell(5).value || '').toString(),
          url: (row.getCell(6).value || '').toString(),
          old_score: score,
          old_note: (row.getCell(8).value || '').toString(),
        });
      });
    }
    fs.writeFileSync(filePath, JSON.stringify({ jobs: out }, null, 2), 'utf-8');
    console.log(`已导出 ${out.length} 条高分职位到 ${filePath}`);
  })().catch(e => { console.error(`导出失败: ${e.message}`); process.exit(1); });

} else if (mode === 'export-csv') {
  // 导出 招聘信息 sheet 到 CSV 文本（UTF-8 带 BOM），供 GitHub 自动提交
  const outFile = process.argv[3] || '求职记录';
  (async () => {
    const wb = await readExcel();
    const ws = wb.getWorksheet('招聘信息');
    if (!ws) { console.error('招聘信息表不存在'); process.exit(1); }
    const lines = [];
    ws.eachRow(row => {
      const vals = [];
      for (let c = 1; c <= 12; c++) vals.push(csvCell(row.getCell(c).value));
      lines.push(vals.join(','));
    });
    const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
    fs.writeFileSync(outFile, csv, 'utf-8');
    const count = Math.max(0, lines.length - 1);
    log(`已导出 ${count} 条职位 → ${outFile}`);
  })().catch(e => { console.error(`导出失败: ${e.message}`); process.exit(1); });

} else if (mode === 'backfill') {
  // 按 单位+岗位 匹配，回填第9-12列并重建推荐投递
  const filePath = process.argv[3];
  if (!filePath) {
    console.error('用法: node search-engine.cjs backfill <json文件路径>');
    process.exit(1);
  }
  (async () => {
    try {
      const input = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!input.jobs || !Array.isArray(input.jobs)) {
        console.error('需要 jobs 数组');
        process.exit(1);
      }
      const wb = await readExcel();
      const ws = wb.getWorksheet('招聘信息');
      if (!ws) { console.error('招聘信息表不存在'); process.exit(1); }
      const byKey = new Map();
      input.jobs.forEach(j => byKey.set(`${String(j.company).trim()}|||${String(j.position).trim()}`, j));
      let updated = 0;
      ws.eachRow((row, ri) => {
        if (ri === 1) return;
        const key = `${String(row.getCell(2).value || '').trim()}|||${String(row.getCell(3).value || '').trim()}`;
        const j = byKey.get(key);
        if (!j) return;
        const m = computeMatchScore(j);
        const matchScore = j.match_score !== undefined ? Number(j.match_score) : m.score;
        const level = matchLevel(matchScore);
        const jt = j.job_type ? `【${j.job_type}】` : '';
        const reason = j.match_reason ? `|${j.match_reason}` : '';
        row.getCell(7).value = Math.round(matchScore / 10);
        row.getCell(8).value = `智能匹配${matchScore}分${jt}|${level}${reason}`;
        row.getCell(9).value = matchScore;
        row.getCell(10).value = dimsText(m.dims);
        row.getCell(11).value = j.apply_reason || '';
        row.getCell(12).value = j.resume_advice || '';
        updated++;
      });
      if (updated > 0) ensureMatchHeaders(ws);
      const recCount = await rebuildRecommendSheet(wb);
      await wb.xlsx.writeFile(EXCEL_FILE);
      await updateSummary();
      log(`回填完成: 更新 ${updated} 条，推荐投递 ${recCount} 条`);
      console.log(JSON.stringify({ updated, strong_recommend: recCount }));
    } catch (e) {
      console.error(`回填失败: ${e.message}`);
      process.exit(1);
    }
  })();

} else if (mode === 'summary') {
  updateSummary().catch(e => log(`更新汇总失败: ${e.message}`));

} else if (mode === 'cleanup') {
  const lockFile = `~$${path.basename(EXCEL_FILE)}`;
  if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
    log(`已删除临时锁文件: ${lockFile}`);
  } else {
    log('无临时锁文件需要清理');
  }

} else if (mode === 'daily') {
  // Full daily run: cleanup + list all channels (daily-full re-search) + append + summary
  const lockFile = `~$${path.basename(EXCEL_FILE)}`;
  if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
    log(`已清理锁文件: ${lockFile}`);
  }
  log('每日搜索准备就绪');
  const config = loadConfig();
  console.log(JSON.stringify({
    status: 'ready',
    search_mode: 'daily-full',
    search_queries: config.search_queries.filter(q => q.enabled !== false).map(q => ({ name: q.name, query: q.query })),
    university_career_sites: config.university_career_sites.filter(s => s.enabled !== false).map(s => ({
      name: s.name, url: s.url
    })),
    wechat_accounts: config.wechat_accounts.filter(a => a.enabled !== false).map(a => a.name),
    tracked_companies: config.tracked_companies.filter(c => c.enabled !== false).map(c => ({
      name: c.name, careers_url: c.careers_url
    })),
  }));

} else {
  console.log(`用法:
  node search-engine.cjs check          - 检查待搜索的查询
  node search-engine.cjs done <names>   - 标记查询为已完成
  node search-engine.cjs append         - 从 stdin 读取 JSON 并追加职位
  node search-engine.cjs append-file <f> - 从 JSON 文件追加职位（推荐，避免管道乱码）
  node search-engine.cjs match <f>      - 智能匹配：5 维评分 -> 加权算分 -> 写入 + 重建推荐投递 + 汇总
  node search-engine.cjs export [f]     - 导出高分历史职位（第7列>=7）供回填评分
  node search-engine.cjs export-csv [f] - 导出 招聘信息 到 CSV 文本（默认 求职记录，UTF-8 带 BOM）
  node search-engine.cjs backfill <f>   - 回填智能匹配分（按 单位+岗位 匹配更新）
  node search-engine.cjs summary        - 更新汇总统计表
  node search-engine.cjs cleanup        - 清理临时锁文件
  node search-engine.cjs daily          - 每日搜索准备`);
}
