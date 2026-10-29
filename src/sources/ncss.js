// 国家大学生就业服务平台（ncss.cn / 24365）适配器
// 列表：GET /student/jobs/jobslist/ajax/?jobName=<关键词>&offset=<1起>&limit=20
// 详情：https://www.ncss.cn/student/jobs/<jobId>/detail.html（SSR HTML，正文含岗位职责）
const cheerio = require('cheerio');
const { todayStr } = require('../date');

const LIST_API = 'https://www.ncss.cn/student/jobs/jobslist/ajax/';
const DETAIL_BASE = 'https://www.ncss.cn/student/jobs';

function buildListUrl({ keyword, offset, limit }) {
  const params = new URLSearchParams({
    jobType: '',
    areaCode: '',
    jobName: keyword,
    monthPay: '',
    industrySectors: '',
    property: '',
    categoryCode: '',
    memberLevel: '',
    recruitType: '',
    offset: String(offset),
    limit: String(limit),
    keyUnits: '',
    degreeCode: '',
    sourcesName: '0',
    sourcesType: '',
    _: String(Date.now()),
  });
  return `${LIST_API}?${params.toString()}`;
}

const DETAIL_SELECTORS = [
  'pre.mainContent',
  'div.details pre',
  'div.details',
  '.jobdetail-box',
  '.detail-content',
  '.job-detail',
  '.article',
  '#content',
];

function extractDetailText(html, limit = 2600) {
  const $ = cheerio.load(html);
  $('script, style, nav, header, footer').remove();
  let text = '';
  for (const selector of DETAIL_SELECTORS) {
    const node = $(selector).first();
    if (!node.length) continue;
    const candidate = node.text().replace(/\s+/g, ' ').trim();
    if (candidate.length > text.length) text = candidate;
    if (candidate.length > 80) break;
  }
  if (!text) text = $('body').text().replace(/\s+/g, ' ').trim();
  return text.slice(0, limit);
}

// 详情页里的完整工作地点（列表接口通常只给省级）
function extractDetailLocation(html) {
  const $ = cheerio.load(html);
  const node = $('.site-tag').first();
  return node.length ? node.text().replace(/\s+/g, ' ').trim() : '';
}

function mapListItem(item, source) {
  const jobId = item.jobId || '';
  const publishMs = Number(item.publishDate || item.updateDate || 0);
  const posted = publishMs > 0 ? todayStr(new Date(publishMs)) : null;
  return {
    source: source.id,
    kind: 'position',
    company: String(item.recName || '').trim(),
    title: String(item.jobName || '').trim(),
    url: `${DETAIL_BASE}/${jobId}/detail.html`,
    url_quality: 'detail',
    city: String(item.areaCodeName || '').trim(),
    location_raw: String(item.areaCodeName || '').trim(),
    education: String(item.degreeName || '').trim(),
    major: String(item.major || '').trim(),
    posted_at: posted,
    deadline: null,
    requirement: '',
    fetched_at: new Date().toISOString(),
    industry_hint: false,
    extra: { job_id: jobId, recruit_type: item.recruitType, property: item.recProperty, tags: item.recTags },
  };
}

async function crawlSource(source, { http, log, full } = {}) {
  const keywords = Array.isArray(source.keywords) ? source.keywords.filter(Boolean) : [];
  if (keywords.length === 0) throw new Error(`${source.id}: 缺少 keywords`);
  const limit = source.limit || 20;
  const pages = full ? (source.max_pages_per_keyword || 3) : (source.pages_per_keyword || 1);
  const fetchDetail = source.fetch_detail !== false;
  const items = [];
  const seenIds = new Set();
  const stats = { source: source.id, keywords: 0, fetched: 0, details: 0, httpErrors: 0 };

  for (const keyword of keywords) {
    stats.keywords += 1;
    for (let page = 0; page < pages; page += 1) {
      const offset = page * limit + 1;
      let json;
      try {
        json = await http.getJson(buildListUrl({ keyword, offset, limit }));
      } catch (err) {
        stats.httpErrors += 1;
        log?.(`[${source.id}] 关键词「${keyword}」第 ${page + 1} 页失败：${String(err.message).slice(0, 60)}`);
        break;
      }
      const payload = json?.json ?? json;
      const list = payload?.data?.list || [];
      if (list.length === 0) break;
      for (const listed of list) {
        const job = mapListItem(listed, source);
        if (!job.url || job.url.includes('/undefined/')) continue;
        if (seenIds.has(job.extra.job_id)) continue;
        seenIds.add(job.extra.job_id);
        if (fetchDetail) {
          try {
            const res = await http.getText(job.url);
            const html = res?.text || String(res || '');
            job.requirement = extractDetailText(html);
            const detailLocation = extractDetailLocation(html);
            if (detailLocation) {
              job.location_raw = detailLocation;
              job.city = detailLocation;
            }
            stats.details += 1;
          } catch (err) {
            stats.httpErrors += 1;
          }
        }
        items.push(job);
      }
      if (list.length < limit) break;
    }
  }

  stats.fetched = items.length;
  log?.(`[${source.id}] ${keywords.length} 个关键词，${items.length} 条（详情 ${stats.details}）`);
  return { items, stats };
}

module.exports = { crawlSource, mapListItem, buildListUrl, extractDetailText, extractDetailLocation };
