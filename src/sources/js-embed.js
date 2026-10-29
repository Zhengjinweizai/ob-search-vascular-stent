'use strict';
/**
 * js-embed 源：岗位数据直接嵌在前端 JS 文件里（例如乐普医疗 join_data.js）。
 *
 * 这类站点用 fetch 拿不到列表接口，但数据摆在一个静态 .js 里，正则即可抽取：
 *   { "details" : "职位名称：质量工程师<br>工作地点：北京<br><br>岗位职责：..." }
 *
 * 配置（sources.yml）：
 *   kind: js-embed
 *   url: https://www.lepumedical.com/js/join_data.js
 *   page_url: https://www.lepumedical.com/join_lepu.html   # 记录里展示给用户点的页面
 *   company: 乐普医疗
 *   entry_pattern: '职位名称：([^<\n]+)<br>工作地点：([^<\n]+)'   # 2 个捕获组：title, city
 *   requirement_chars: 600                                   # 证据正文取匹配点后多少字符
 */
const cheerio = require('cheerio');

function stripTags(html) {
  const $ = cheerio.load(`<div id="__js_embed_root">${html}</div>`);
  return $('#__js_embed_root').text().replace(/\s+/g, ' ').trim();
}

async function crawlSource(source, ctx) {
  const { http } = ctx;
  const log = ctx.log || (() => {});
  if (!source.url) throw new Error(`源 ${source.id} 缺少 url`);
  if (!source.entry_pattern) throw new Error(`源 ${source.id} 缺少 entry_pattern`);
  const pageUrl = source.page_url || source.url;

  const res = await http.getText(source.url, { headers: { referer: pageUrl } });
  const text = String(res.text || '');
  if (!text) throw new Error(`源 ${source.id} 取到空内容（HTTP ${res.status}）`);

  let re;
  try {
    re = new RegExp(source.entry_pattern, 'g');
  } catch (err) {
    throw new Error(`源 ${source.id} 的 entry_pattern 不是合法正则：${err.message}`);
  }

  const windowChars = Number(source.requirement_chars) || 600;
  const items = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const title = String(m[1] || '').replace(/\s+/g, ' ').trim();
    const city = String(m[2] || '').replace(/\s+/g, ' ').trim();
    if (!title || seen.has(`${title}|${city}`)) continue;
    seen.add(`${title}|${city}`);
    // 窗口必须在本条岗位内部：遇下一条「职位名称」或字符串结束就截断，否则会把相邻岗位的职责/城市串进来
    const rest = text.slice(m.index, m.index + windowChars);
    const cutAt = [rest.indexOf('职位名称', 4), rest.indexOf('" }'), rest.indexOf('" }')].filter((i) => i > 0).sort((a, b) => a - b)[0];
    const snippet = (cutAt ? rest.slice(0, cutAt) : rest).split('</p>')[0];
    items.push({
      source: source.id,
      kind: 'position',
      company: source.company || '',
      industry_hint: Boolean(source.medical_hint),
      title,
      city,
      location_raw: city,
      requirement: stripTags(snippet).slice(0, 800),
      url: pageUrl,
      url_quality: 'company_page',
      posted_at: null,
      deadline: null,
      fetched_at: new Date().toISOString(),
    });
    // 防止某个正则写成零宽匹配导致死循环
    if (m[0] === '') re.lastIndex += 1;
  }

  log(`[${source.id}] 从 JS 内嵌数据抽出 ${items.length} 条`);
  return { items, stats: { source: source.id, fetched: items.length, pages: 1, httpErrors: 0 } };
}

module.exports = { crawlSource };
