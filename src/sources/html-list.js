'use strict';
/**
 * 企业官网「岗位列表」源（HTML 静态渲染）。
 * 通过 selectors 从列表页抽条目；企业官网常见情况是没有独立详情页（href=javascript:;），
 * 此时 link 留空，url 退回列表页，并在候选里标记 url_quality=company_page。
 */

const cheerio = require('cheerio');

function textOf($, node, selector) {
  if (!selector) return '';
  const el = $(node).find(selector).first();
  return el.length ? el.text().replace(/\s+/g, ' ').trim() : '';
}

/**
 * @param {object} source sources.yml 中的源配置
 * @param {{http: import('../http').HttpClient, log?: Function}} ctx
 */
async function crawlSource(source, ctx) {
  const { http } = ctx;
  const log = ctx.log || (() => {});
  const pageUrl = source.url;
  if (!pageUrl) throw new Error(`源 ${source.id} 缺少 url`);

  const res = await http.getText(pageUrl, { headers: { referer: pageUrl } });
  const stats = { source: source.id, pages: 1, fetched: 0, httpErrors: 0 };
  if (!res.ok) {
    stats.httpErrors += 1;
    log(`[${source.id}] 列表页 HTTP ${res.status}`);
    return { items: [], stats };
  }
  const $ = cheerio.load(res.text);
  const items = [];
  const seen = new Set();
  $(source.item_selector || 'a').each((i, node) => {
    const title = textOf($, node, source.title_selector || 'a').replace(/^(职位|岗位)[:：]\s*/, '');
    if (!title) return;
    const rawLocation = textOf($, node, source.location_selector);
    const location = rawLocation.replace(/^工作地点[:：]\s*/, '');
    let link = '';
    if (source.link_selector) {
      const href = $(node).find(source.link_selector).first().attr('href') || $(node).attr('href') || '';
      if (href && !/^javascript:/i.test(href) && href !== '#') link = new URL(href, pageUrl).toString();
    }
    const key = `${title}|${location}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      source: source.id,
      kind: 'position',
      company: source.company || '',
      title,
      url: link || (source.link_fallback_url ? new URL(source.link_fallback_url, pageUrl).toString() : pageUrl),
      url_quality: link ? 'detail' : 'company_page',
      city: location || source.city_fallback || '',
      location_raw: location,
      posted_at: null,
      deadline: null,
      fetched_at: new Date().toISOString(),
    });
  });
  stats.fetched = items.length;
  return { items, stats };
}

module.exports = { crawlSource };
