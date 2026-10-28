'use strict';

/**
 * 把历史 求职记录.xlsx 迁移进新主库 data/jobs.jsonl + data/applications.json。
 *
 * 用法：
 *   node scripts/import-legacy.js                 # 写入 data/
 *   node scripts/import-legacy.js --dry-run       # 只打印统计
 *   node scripts/import-legacy.js --root <repo>   # 指定仓库根目录（测试用）
 *
 * 原则：迁移只做规范化，不丢原始值（原文保存在 requirement 与 legacy 字段里），
 * 去重规则与线上一致：canonicalUrl 优先，其次 公司归一+岗位归一。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');

const { canonicalUrl, isSearchOrPortalUrl, companyNorm, titleNorm, extractCity, guessJobFamily, looksCampus } = require('../src/normalize');
const { loadConfig, allCities, familyAllowed } = require('../src/config');
const { parseDate, todayStr } = require('../src/date');
const store = require('../src/store');

const LEGACY_XLSX = '求职记录.xlsx';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(name);

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.text) return String(v.text).trim();
    if (v.richText) return v.richText.map((t) => t.text).join('').trim();
    if (v.result != null) return String(v.result).trim();
    if (v.hyperlink && v.text) return String(v.text).trim();
  }
  return String(v).trim();
}

function parseDimensions(text) {
  // "研究95/技能100/学历100/行业100/企业100"
  const out = {};
  if (!text) return out;
  for (const part of String(text).split(/[\/／、,，]/)) {
    const m = part.match(/(研究|技能|学历|行业|企业|岗位族|校招|城市|公司|方向|family|skill|campus|location|company|research)\s*[:：]?\s*(\d{1,3})/i);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

const DIM_MAP = {
  研究: 'research',
  技能: 'skill',
  学历: 'education',
  行业: 'industry',
  企业: 'company',
  岗位族: 'family',
  校招: 'campus',
  城市: 'location',
  公司: 'company',
  方向: 'research',
};

function dimsToScores(dims) {
  const s = {};
  for (const [k, v] of Object.entries(dims)) {
    const key = DIM_MAP[k] || (k in DIM_MAP ? DIM_MAP[k] : k);
    s[key] = v;
  }
  return s;
}

function makeId({ urlCanonical, companyNorm, titleNorm }) {
  const base = urlCanonical || `${companyNorm || ''}|${titleNorm || ''}`;
  return crypto.createHash('sha1').update(base).digest('hex');
}

async function readWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb;
}

function legacyJobsFromSheet(ws, config) {
  const { search } = config;
  const cities = allCities(search);
  const jobs = [];
  const problems = { badDate: 0, noUrl: 0, searchUrl: 0, fuzzyUrl: 0, noScore: 0, skippedRow: 0 };

  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const dateRaw = cellText(row.getCell(1).value);
    const companyRaw = cellText(row.getCell(2).value);
    const titleRaw = cellText(row.getCell(3).value);
    const requirement = cellText(row.getCell(4).value);
    const locationRaw = cellText(row.getCell(5).value);
    const urlRaw = cellText(row.getCell(6).value);
    const legacyScore7 = Number(cellText(row.getCell(7).value)) || null;
    const remark = cellText(row.getCell(8).value);
    const totalRaw = Number(cellText(row.getCell(9).value));
    const dimsText = cellText(row.getCell(10).value);
    const whyApply = cellText(row.getCell(11).value);
    const resumeTips = cellText(row.getCell(12).value);

    if (!companyRaw && !titleRaw) {
      problems.skippedRow += 1;
      continue;
    }

    const date = parseDate(dateRaw, { today: todayStr() });
    if (!date) problems.badDate += 1;

    const company_norm = companyNorm(companyRaw);
    const title_norm = titleNorm(titleRaw);
    const urlCanonical = canonicalUrl(urlRaw);
    if (!urlRaw) problems.noUrl += 1;
    else if (isSearchOrPortalUrl(urlRaw)) problems.searchUrl += 1;
    else if (!urlCanonical) problems.fuzzyUrl += 1;

    const family = guessJobFamily(titleRaw, requirement);
    const campus = looksCampus(titleRaw, requirement, remark);
    const city = extractCity(locationRaw);
    const dims = dimsToScores(parseDimensions(dimsText));
    const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : legacyScore7 ? legacyScore7 * 10 : null;
    if (total == null) problems.noScore += 1;

    // 历史行补齐统一 gate 结构（action/reasons），供网页与 Excel 一致消费。
    // 注意：历史行的分数来自旧流程，不参与"强推"（见 derive/excel.js isLegacy）。
    const gateReasons = [];
    const familyOk = familyAllowed(search, family);
    const cityOk = Boolean(city && cities.includes(city));
    const urlOk = Boolean(urlCanonical && !isSearchOrPortalUrl(urlRaw));
    const text = `${titleRaw} ${requirement}`;
    const postdoc = (search.education?.postdoc_keywords || ['博士后', '博后']).some((k) => text.includes(k));
    const phdOnly = /仅限博士|仅招博士|只招博士|博士研究生/.test(text);
    let gateAction = 'keep';
    if (!urlOk) { gateAction = 'skip'; gateReasons.push('url_invalid'); }
    else if (postdoc) { gateAction = 'skip'; gateReasons.push('postdoc'); }
    else if (phdOnly) { gateAction = 'skip'; gateReasons.push('phd_only'); }
    else if (!city) { gateAction = 'review'; gateReasons.push('city_unknown'); }
    else if (!cityOk) { gateAction = 'skip'; gateReasons.push('city'); }
    else gateReasons.push(city === (search.cities.core || []).find((c) => c === city) ? 'city_core' : 'city_extended');
    if (familyOk && gateAction === 'keep') gateReasons.push('family_allowed');
    if (campus) gateReasons.push('campus');

    jobs.push({
      id: makeId({ urlCanonical, companyNorm: company_norm, titleNorm: title_norm }),
      source: 'legacy_xlsx',
      company: companyRaw,
      company_norm,
      title: titleRaw,
      title_norm,
      requirement,
      job_family: family,
      campus,
      location_raw: locationRaw,
      cities: city ? [city] : [],
      city,
      degree_req: null,
      major_req: [],
      exp_req: null,
      posted_at: null, // 历史数据只有"发现日期"，没有可靠发布时间
      deadline: null,
      url: urlRaw,
      url_canonical: urlCanonical,
      first_seen: date || null,
      last_seen: date || null,
      status: 'unknown',
      scores: Object.keys(dims).length ? dims : null,
      total,
      legacy: {
        score_1_10: legacyScore7,
        remark,
        dims_text: dimsText,
        date_raw: dateRaw,
        row: r,
      },
      why_apply: whyApply,
      resume_tips: resumeTips,
      gate: { action: gateAction, passed: gateAction === 'keep', reasons: gateReasons },
      version: 1,
    });
  }
  return { jobs, problems };
}

const GENERIC_TITLE = /^(研发|工艺|结构|机械|材料|质量|注册|技术支持|临床|生产|设备|产品|项目)(工程师|专员|经理|主管|技术员|助理)?$/;

function isGenericTitle(titleNorm) {
  return !titleNorm || GENERIC_TITLE.test(titleNorm);
}

/**
 * 去重规则（与线上一致）：
 * 1) 同一 canonicalUrl 且公司归一相同 → 同一条（招聘网站同岗位多投/多抓）；
 * 2) 公司归一 + 岗位归一完全相同，且岗位名不是"研发工程师/工艺工程师"这类泛称 → 同一条；
 * 3) 泛称岗位（无法区分具体岗位）不合并，避免把 10 个不同 opening 压成 1 个。
 */
function dedupe(jobs) {
  const byUrl = new Map();
  const byKey = new Map();
  const merged = [];
  let urlMerged = 0;
  let keyMerged = 0;
  for (const job of jobs) {
    const urlKey = job.url_canonical ? `${job.url_canonical}|||${job.company_norm || ''}` : null;
    const key = `${job.company_norm || ''}|||${job.title_norm || ''}`;
    let existing = (urlKey && byUrl.get(urlKey)) || (!isGenericTitle(job.title_norm) ? byKey.get(key) : null);
    if (existing) {
      if (urlKey && byUrl.get(urlKey) === existing) urlMerged += 1;
      else keyMerged += 1;
      if (job.first_seen && (!existing.first_seen || job.first_seen < existing.first_seen)) existing.first_seen = job.first_seen;
      if (job.last_seen && (!existing.last_seen || job.last_seen > existing.last_seen)) existing.last_seen = job.last_seen;
      existing.duplicates = existing.duplicates || [];
      existing.duplicates.push({ company: job.company, title: job.title, url: job.url_canonical, row: job.legacy?.row });
      continue;
    }
    merged.push(job);
    if (urlKey) byUrl.set(urlKey, job);
    if (!isGenericTitle(job.title_norm)) {
      // 只保留第一条，后续重复项通过上面 byKey 命中合并
      if (!byKey.has(key)) byKey.set(key, job);
    }
  }
  return {
    merged,
    duplicateCount: jobs.length - merged.length,
    duplicateGroups: urlMerged + keyMerged,
  };
}

function applicationsFromSheet(ws) {
  const rows = [];
  if (!ws) return rows;
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const company = cellText(row.getCell(2).value);
    const title = cellText(row.getCell(3).value);
    if (!company && !title) continue;
    rows.push({
      apply_date: cellText(row.getCell(1).value) || null,
      company,
      title,
      status: cellText(row.getCell(4).value) || '未投递',
      channel: cellText(row.getCell(5).value) || '',
      notes: cellText(row.getCell(6).value) || '',
      next_follow_up: cellText(row.getCell(7).value) || null,
    });
  }
  return rows;
}

async function main() {
  const root = path.resolve(arg('--root', path.resolve(__dirname, '..')));
  const xlsx = path.join(root, LEGACY_XLSX);
  if (!fs.existsSync(xlsx)) {
    console.error(`找不到 ${xlsx}`);
    process.exit(1);
  }
  const config = loadConfig(root);
  const wb = await readWorkbook(xlsx);
  const jobSheet = wb.getWorksheet('招聘信息');
  if (!jobSheet) {
    console.error('找不到「招聘信息」工作表');
    process.exit(1);
  }
  const { jobs, problems } = legacyJobsFromSheet(jobSheet, config);
  const { merged, duplicateCount, duplicateGroups } = dedupe(jobs);
  const apps = applicationsFromSheet(wb.getWorksheet('投递情况'));

  const stats = {
    source_rows: jobSheet.rowCount - 1,
    imported: jobs.length,
    unique: merged.length,
    duplicates_removed: duplicateCount,
    duplicate_groups: duplicateGroups,
    applications: apps.length,
    problems,
    with_scores: merged.filter((j) => j.total != null).length,
    no_url: merged.filter((j) => !j.url_canonical).length,
  };

  console.log(JSON.stringify(stats, null, 2));

  if (hasFlag('--dry-run')) {
    console.log('dry-run：不写文件');
    return;
  }

  const outRoot = path.resolve(arg('--out', root));
  store.writeJsonl(store.defaultPaths(outRoot).jobs, merged);
  store.writeApplications(outRoot, apps);
  console.log(`已写入 ${store.defaultPaths(outRoot).jobs}（${merged.length} 条）`);
  console.log(`已写入 ${store.defaultPaths(outRoot).applications}（${apps.length} 条）`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { legacyJobsFromSheet, dedupe, applicationsFromSheet, parseDimensions, makeId };
