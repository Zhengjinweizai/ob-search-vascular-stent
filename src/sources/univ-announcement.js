'use strict';
/**
 * 高校就业网「招聘公告」源（西安交大 / 大连理工 等同模板站点）。
 *
 * 该模板的列表接口：
 *   GET  /f/ajaxHome/getToken                    -> { data: token }
 *   POST /f/recruitmentinfo/ajax_frontRecruitinfo (header token)
 *        pageNo, pageSize, positionType, city, title, corporationNature, corporationinfo.industry
 * 返回 object.list[]：corporationName/title/cityName(部分站点有)/education/majorName/startTime/endTime/url
 *
 * 公告标题多为「XX公司2027年校园招聘」，属"校招窗口"而不是具体岗位；
 * 这里只做召回与硬规则初筛，具体岗位由用户点击公告页查看。
 */

const { sleep } = require('../http');

function parseDatePrefix(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * 抓取一个站点。
 * @param {object} source sources.yml 中的源配置
 * @param {{http: import('../http').HttpClient, log?: Function, full?: boolean}} ctx
 * @returns {Promise<{items: object[], stats: object}>}
 */
async function crawlSource(source, ctx) {
  const { http } = ctx;
  const log = ctx.log || (() => {});
  const base = String(source.base_url || '').replace(/\/+$/, '');
  if (!base) throw new Error(`源 ${source.id} 缺少 base_url`);

  const pageSize = Math.min(Math.max(Number(source.page_size) || 100, 1), 100);
  const maxPages = ctx.full ? Math.max(Number(source.max_pages) || 100, 1) : Math.min(Number(source.max_pages) || 10, 100);
  const positionType = String(source.position_type || '1');

  const headers = {
    referer: `${base}/`,
    'x-requested-with': 'XMLHttpRequest',
    accept: 'application/json, text/javascript, */*; q=0.01',
  };

  const tokenRes = await http.getJson(`${base}/f/ajaxHome/getToken?ts=${Date.now()}`, { headers });
  const token = tokenRes.json && tokenRes.json.data;
  if (!token) throw new Error(`源 ${source.id} 获取 token 失败（HTTP ${tokenRes.status}）`);

  const items = [];
  const stats = { source: source.id, pages: 0, fetched: 0, httpErrors: 0 };
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await http.postForm(
      `${base}/f/recruitmentinfo/ajax_frontRecruitinfo?ts=${Date.now()}`,
      {
        pageNo: String(page),
        pageSize: String(pageSize),
        positionType,
        city: '',
        title: '',
        corporationNature: '',
        'corporationinfo.industry': '',
      },
      { headers: { ...headers, token } },
    );
    stats.pages += 1;
    let body;
    try {
      body = JSON.parse(res.text);
    } catch {
      stats.httpErrors += 1;
      log(`[${source.id}] 第 ${page} 页返回非 JSON（HTTP ${res.status}），停止翻页`);
      break;
    }
    if (body.state !== 1) {
      stats.httpErrors += 1;
      log(`[${source.id}] 第 ${page} 页 state=${body.state}，停止翻页`);
      break;
    }
    const list = (body.object && body.object.list) || [];
    if (!Array.isArray(list) || list.length === 0) break;

    for (const item of list) {
      // 同模板站点字段不完全一致：xjtu 用 corporationName，tongji 只有 corporationinfo.name
      const company = String(item.corporationName || (item.corporationinfo && item.corporationinfo.name) || '').trim();
      const title = String(item.title || '').trim();
      if (!company || !title) continue;
      const detailUrl = item.url ? new URL(item.url, base + '/').toString() : '';
      items.push({
        source: source.id,
        kind: 'announcement',
        company,
        title,
        url: detailUrl,
        city: item.cityName ? String(item.cityName) : '',
        education: item.education ? String(item.education) : '',
        major: item.majorName ? String(item.majorName) : '',
        corporation_nature: (item.corporationinfo && item.corporationinfo.corporationNatureValue) || '',
        posted_at: parseDatePrefix(item.startTime),
        deadline: parseDatePrefix(item.endTime),
        fetched_at: new Date().toISOString(),
      });
    }
    stats.fetched = items.length;
    if (list.length < pageSize) break;
    if (ctx.full === false) {
      // 增量模式：只翻最近几页，避免每天拉全量
      if (page >= (Number(source.daily_pages) || 6)) break;
    }
    if (page < maxPages) await sleep(Number(source.page_delay_ms) || 200);
  }
  return { items, stats };
}

module.exports = { crawlSource };
