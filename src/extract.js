'use strict';
/**
 * 原始条目 → 候选岗位（规范化字段 + 相关度/岗位族/城市初判）。
 * 这里只做"机器能确定"的事，语义评分留给 score 层（DeepSeek）。
 */

const {
  canonicalUrl,
  isSearchOrPortalUrl,
  companyNorm,
  titleNorm,
  extractCity,
  guessJobFamily,
  looksCampus,
} = require('./normalize');
const { todayStr, parseDate } = require('./date');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hitsAny(text, words) {
  const s = String(text || '');
  return (words || []).some((w) => w && s.includes(w));
}

/**
 * @param {object} raw 原始条目（sources 层输出）
 * @param {object} cfg loadConfig() 结果
 * @param {{now?: Date}} [opts]
 */
function extractCandidate(raw, cfg, opts = {}) {
  const now = opts.now || new Date();
  const search = cfg.search || {};
  const relevance = search.relevance || {};
  const cities = [...(search.cities?.core || []), ...(search.cities?.extended || [])];

  const company = String(raw.company || '').trim();
  const title = String(raw.title || '').trim();
  const url = String(raw.url || '').trim();
  // 相关度只看公司/标题/要求：公告的 major 字段是整串专业列表，混进来会把无关公司判成相关
  const text = [company, title, raw.requirement].filter(Boolean).join(' ');

  const job = {
    source: raw.source,
    kind: raw.kind || 'position',
    company,
    company_norm: companyNorm(company),
    title,
    title_norm: titleNorm(title),
    // 岗位的职能看标题最准；要求正文里常混着别的部门职责，只在标题判不出时才参考正文
    job_family: raw.kind === 'announcement' ? guessJobFamily(title, raw.requirement || '') : guessJobFamily(title),
    // 校招身份只看标题（要求的正文里常出现"应届可放宽"这类放宽词，不能据此把社招当校招）
    campus: raw.kind === 'announcement' ? true : looksCampus(title),
    cities: [],
    city_raw: raw.city || '',
    location_raw: raw.location_raw || raw.city || '',
    education_req: raw.education || '',
    major_req: raw.major || '',
    requirement: raw.requirement || '',
    posted_at: parseDate(raw.posted_at) || null,
    deadline: parseDate(raw.deadline) || null,
    url,
    url_quality: raw.url_quality || 'detail',
    first_seen: todayStr(now),
    last_seen: todayStr(now),
    fetched_at: raw.fetched_at || now.toISOString(),
    // 已验证的企业官网/ATS 源直接标记医疗器械行业，避免"先健科技"这类不含"医疗"字样的公司被误杀
    medical_relevant: Boolean(raw.industry_hint) || hitsAny(text, relevance.keywords),
    // 专业方向匹配：标题/要求里是否出现支架、介入、导管等方向词
    direction_hits: (relevance.direction_keywords || []).filter((k) => text.includes(k)),
    direction_match: (relevance.direction_keywords || []).some((k) => text.includes(k)),
    // 明显无关的岗位名（软件/算法/试剂/试剂检验等），即使公司是医疗器械也直接丢
    role_excluded: (relevance.role_exclude || []).some((k) => title.includes(k)),
    org_excluded: hitsAny(company, relevance.org_exclude),
    major_relevant: hitsAny([raw.major, title, raw.requirement].filter(Boolean).join(' '), relevance.majors),
  };

  // 城市：优先显式城市字段，其次从地点/标题里找
  const detected = [raw.city, raw.location_raw, title].map((x) => extractCity(x)).filter(Boolean);
  job.cities = [...new Set(detected)];
  if (job.cities.length === 0 && raw.kind === 'announcement') job.cities = [];

  job.url_canonical = canonicalUrl(url);
  job.is_search_url = isSearchOrPortalUrl(url);
  job.id = require('node:crypto')
    .createHash('sha1')
    .update(`${job.url_canonical}|${job.company_norm}|${job.title_norm}`)
    .digest('hex');

  // 学历可投判断
  const edu = job.education_req;
  job.degree_ok = !edu || /硕士|不限|本科|博士/.test(edu);
  job.phd_only =
    /仅限博士|仅招博士|只招博士|博士研究生/.test(`${title} ${edu} ${raw.requirement || ''}`) && !/硕士/.test(edu);

  return job;
}

/**
 * 判断公告条目的相关度（公告标题通常只有公司名 + "2027年校园招聘"）。
 * 返回 {keep, reason}
 */
function announcementRelevant(job, cfg) {
  const relevance = cfg.search?.relevance || {};
  const cityAllowed = [...(cfg.search?.cities?.core || []), ...(cfg.search?.cities?.extended || [])];
  if (job.org_excluded) return { keep: false, reason: 'org_excluded' };
  if (!job.medical_relevant && !hitsAny(job.company, relevance.keywords)) return { keep: false, reason: 'not_relevant' };
  if (job.phd_only) return { keep: false, reason: 'phd_only' };
  if (job.cities.length > 0 && !job.cities.some((c) => cityAllowed.includes(c))) return { keep: false, reason: 'city' };
  if (job.cities.length === 0) return { keep: true, reason: 'city_unknown' };
  return { keep: true, reason: null };
}

module.exports = { extractCandidate, announcementRelevant, hitsAny, escapeRe };
