'use strict';
/**
 * 搜索引擎 API 源（付费通道）：用 site:<平台域名> 关键词查询拿到岗位深链。
 *
 * 支持三家 provider（同一个 key 只配一家，通过 SEARCH_PROVIDER 选择）：
 *  - bocha（博查，国内最便宜，默认）：POST https://api.bochaai.com/v1/web-search
 *  - serper（Google 代理）：POST https://google.serper.dev/search
 *  - exa：POST https://api.exa.ai/search
 *
 * 设计要点：
 *  1. 没有 key 时不报错、不参与抓取（记 skipped），避免把整条流水线打红；
 *  2. 查询矩阵按天轮换（每天只打 queries_per_day 条，控制费用），跨天自然覆盖全部组合；
 *  3. 结果先做 URL 规范化去重，再尽力抓详情页（平台反爬时退回搜索摘要，标记 snippet_only）；
 *  4. 平台站内页标题/摘要里通常带「城市 + 岗位 + 公司」，本地解析出字段供后续过滤。
 */

const { canonicalUrl } = require('../normalize');

const PROVIDERS = {
  bocha: {
    name: 'bocha',
    envKey: 'BOCHA_API_KEY',
    endpoint: 'https://api.bochaai.com/v1/web-search',
    request({ query, count }, apiKey) {
      return {
        url: this.endpoint,
        body: { query, count, summary: true, freshness: 'oneMonth' },
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      };
    },
    parse(json) {
      const pages = json?.data?.webPages?.value || [];
      return pages.map((p) => ({ title: p.name, url: p.url, snippet: p.summary || p.snippet || '' }));
    },
  },
  serper: {
    name: 'serper',
    envKey: 'SERPER_API_KEY',
    endpoint: 'https://google.serper.dev/search',
    request({ query, count }, apiKey) {
      return {
        url: this.endpoint,
        body: { q: query, num: count, gl: 'cn', hl: 'zh-cn' },
        headers: { 'X-API-KEY': apiKey, 'content-type': 'application/json' },
      };
    },
    parse(json) {
      const list = json?.organic || [];
      return list.map((p) => ({ title: p.title, url: p.link, snippet: p.snippet || '' }));
    },
  },
  exa: {
    name: 'exa',
    envKey: 'EXA_API_KEY',
    endpoint: 'https://api.exa.ai/search',
    request({ query, count }, apiKey) {
      return {
        url: this.endpoint,
        body: { query, numResults: count, contents: { text: { maxCharacters: 800 } } },
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      };
    },
    parse(json) {
      const list = json?.results || [];
      return list.map((p) => ({ title: p.title, url: p.url, snippet: (p.text || '').slice(0, 400) }));
    },
  },
};

function resolveProvider(source, env = process.env) {
  const name = String(source.provider || env.SEARCH_PROVIDER || 'bocha').toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`未知搜索 provider：${name}（可选 bocha/serper/exa）`);
  const apiKey = env[provider.envKey] || env.SEARCH_API_KEY || '';
  return { provider, apiKey };
}

/** 生成「平台 × 关键词」查询矩阵；按天轮换取一个子集。 */
function buildQueries(source, today) {
  const sites = source.sites || [];
  const keywords = source.keywords || [];
  const all = [];
  for (const site of sites) {
    for (const kw of keywords) {
      const suffix = source.query_suffix ? ` ${source.query_suffix}` : '';
      all.push({ site, keyword: kw, query: `site:${site} ${kw}${suffix}` });
    }
  }
  const perDay = Math.max(1, source.queries_per_day || 20);
  if (all.length <= perDay) return all;
  // 以「当年第几天」为偏移，让每天打到不同组合，几天内覆盖全矩阵
  const day = Number(String(today).replace(/-/g, '')) || 0;
  const start = (day * perDay) % all.length;
  const picked = [];
  for (let i = 0; i < perDay; i += 1) picked.push(all[(start + i) % all.length]);
  return picked;
}

const TITLE_PATTERNS = [
  // 【北京 支架研发工程师招聘】-康誉医疗招聘信息-猎聘
  /^【(?<city>[^\s】]{2,12})\s+(?<title>.{2,30}?)招聘】[-－—]?(?<company>[^-－—|]+)/,
  // 【北京支架研发工程师招聘】-康誉医疗
  /^【(?<title>.{4,30}?)招聘】[-－—]?(?<company>[^-－—|]+)/,
  // 血管介入研发工程师-鑫云生科招聘-智联招聘
  /^(?<title>[^【】|]{2,30}?)[-－—|](?<company>[^-－—|]{2,30}?)(?:招聘|官网|招聘信息)/,
];

const COMPANY_SUFFIX = /(招聘信息|人才招聘|招聘网|招聘系统|招聘|官网|公司简介|企业官网)$/;

function cleanCompany(name) {
  return String(name || '')
    .replace(/[-－—|].*$/, '')
    .replace(COMPANY_SUFFIX, '')
    .replace(/\s+/g, '')
    .trim();
}

function parseTitle(rawTitle, source) {
  const title = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  for (const re of TITLE_PATTERNS) {
    const m = re.exec(title);
    if (m && m.groups && m.groups.title) {
      return {
        title: m.groups.title.trim(),
        company: cleanCompany(m.groups.company || source.company || ''),
        city: (m.groups.city || '').trim(),
      };
    }
  }
  // 「岗位名称_公司名招聘」这类常见写法
  const parts = title.split(/[_|]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { title: parts[0], company: cleanCompany(parts[parts.length - 1]), city: '' };
  return { title, company: cleanCompany(source.company || ''), city: '' };
}

function mapResult(result, source) {
  const parsed = parseTitle(result.title, source);
  const snippet = String(result.snippet || '').replace(/\s+/g, ' ').trim();
  return {
    source: source.id,
    kind: 'position',
    company: parsed.company,
    title: parsed.title,
    url: canonicalUrl(result.url) || result.url,
    url_quality: 'detail',
    city: parsed.city,
    location_raw: parsed.city,
    education: '',
    major: '',
    posted_at: null,
    deadline: null,
    requirement: snippet.slice(0, 600),
    snippet_only: true,
    fetched_at: new Date().toISOString(),
    industry_hint: Boolean(source.medical_hint),
  };
}

const cheerio = require('cheerio');

/** 尽力抓平台详情页：反爬时返回 null，由搜索摘要兜底。 */
async function fetchDetail(http, url) {
  let res;
  try {
    res = await http.getText(url, { timeoutMs: 8000 });
  } catch {
    return null;
  }
  if (!res || !res.ok || !res.text) return null;
  const html = res.text;
  if (html.length < 300) return null;
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, noscript').remove();
  const title = ($('title').first().text() || '').trim();
  const bodyText = ($('body').text() || '').replace(/\s+/g, ' ').trim();
  if (/滑动验证|安全验证|访问异常|请开启JavaScript|验证码/.test(bodyText.slice(0, 400))) return null;
  const m = /(岗位职责|职位描述|工作职责|任职要求|职位要求)[\s\S]{20,1200}/.exec(bodyText);
  const detailText = (m ? m[0] : bodyText).slice(0, 1200);
  return { title, text: detailText };
}

async function crawlSource(source, { http, log, full } = {}) {
  const today = require('../date').todayStr();
  const { provider, apiKey } = resolveProvider(source);
  if (!apiKey) {
    log?.(`[${source.id}] 跳过：未配置 ${provider.envKey} / SEARCH_API_KEY`);
    return { items: [], stats: { source: source.id, skipped: 'no_api_key', provider: provider.name } };
  }
  const queries = buildQueries(source, today);
  const count = Math.max(1, Math.min(50, source.results_per_query || 10));
  const seen = new Set();
  const items = [];
  const stats = { source: source.id, provider: provider.name, queries: queries.length, results: 0, detailFetched: 0, httpErrors: 0 };

  for (const q of queries) {
    const req = provider.request({ query: q.query, count }, apiKey);
    let json;
    try {
      json = await http.postJson(req.url, req.body, { headers: req.headers });
    } catch (err) {
      stats.httpErrors += 1;
      log?.(`[${source.id}] 查询失败「${q.query}」：${String(err.message).slice(0, 60)}`);
      continue;
    }
    const rawResults = provider.parse(json?.json ?? json) || [];
    for (const r of rawResults) {
      if (!r.url) continue;
      const key = canonicalUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      const job = mapResult({ ...r, url: key }, source);
      if (!job.title) continue;
      if (source.fetch_detail !== false && items.length < (source.max_details || 40)) {
        const detail = await fetchDetail(http, job.url);
        if (detail) {
          if (detail.title) job.title = detail.title;
          if (detail.text) {
            job.requirement = detail.text;
            job.snippet_only = false;
          }
          stats.detailFetched += 1;
        }
      }
      items.push(job);
      stats.results += 1;
    }
  }
  stats.fetched = items.length;
  log?.(`[${source.id}] ${provider.name}：${queries.length} 条查询，${items.length} 个结果`);
  return { items, stats };
}

module.exports = { crawlSource, mapResult, buildQueries, parseTitle, resolveProvider, fetchDetail, PROVIDERS };
