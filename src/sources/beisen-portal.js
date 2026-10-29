// 北森（Beisen / *.zhiye.com）招聘门户适配器：直接调 JSON 接口，不需要浏览器
// 实测：weigao.zhiye.com（威高）、mindray.zhiye.com（迈瑞）
const PAGE_LIMIT = 50;

function splitCity(locNames = []) {
  const raw = Array.isArray(locNames) ? locNames.join(' ') : String(locNames || '');
  // "山东省·威海市" / "广东省·深圳市" -> 城市
  const parts = raw.split(/[·\/,，\s]+/).filter(Boolean);
  return { city: parts[parts.length - 1] || '', raw };
}

function mapItem(item, source, base) {
  const { city, raw } = splitCity(item.LocNames);
  const posted = String(item.PostDate || '').slice(0, 10);
  const postedOk = /^\d{4}-\d{2}-\d{2}$/.test(posted) ? posted : null;
  const end = String(item.EndTime || '').slice(0, 10);
  const deadline = /^20\d{2}-\d{2}-\d{2}$/.test(end) ? end : null;
  return {
    source: source.id,
    kind: 'position',
    company: source.company,
    title: String(item.JobAdName || '').trim(),
    url: `${base}/${source.detail_path.replace('{id}', item.JobAdId)}`,
    url_quality: 'detail',
    city,
    location_raw: raw,
    posted_at: postedOk,
    deadline,
    requirement: [item.Duty, item.Require].filter(Boolean).join('\n').slice(0, 3000),
    fetched_at: new Date().toISOString(),
    industry_hint: Boolean(source.medical_hint),
    extra: {
      classification: [item.ClassificationOne, item.ClassificationTwo].filter(Boolean).join('/'),
      job_ad_id: item.JobAdId,
    },
  };
}

async function crawlSource(source, { http, log, full } = {}) {
  const base = String(source.base_url || '').replace(/\/+$/, '');
  if (!base) throw new Error(`${source.id}: 缺少 base_url`);
  const listUrl = `${base}/api/Jobad/GetJobAdPageList`;
  const maxPages = full ? (source.max_pages || 20) : (source.daily_pages || 2);
  const items = [];
  const stats = { source: source.id, pages: 0, fetched: 0, httpErrors: 0 };

  for (let page = 0; page < maxPages; page += 1) {
    const body = {
      PageIndex: page,
      PageSize: source.page_size || PAGE_LIMIT,
      Category: [String(source.category || '1')],
      KeyWords: '',
      SpecialType: 0,
      PortalId: '',
      DisplayFields: ['LocId', 'PostDate', 'ClassificationOne', 'ClassificationTwo'],
    };
    let json;
    try {
      json = await http.postJson(listUrl, body, {
        headers: { langType: 'zh_CN', referer: `${base}/${source.detail_path.split('/detail/')[0] || 'social/jobs'}` },
      });
    } catch (err) {
      stats.httpErrors += 1;
      throw new Error(`${source.id}: 列表接口失败 ${String(err.message).slice(0, 80)}`);
    }
    const payload = json?.json ?? json;
    const list = Array.isArray(payload?.Data) ? payload.Data : [];
    stats.pages += 1;
    if (list.length === 0) break;
    for (const it of list) items.push(mapItem(it, source, base));
    if (list.length < (source.page_size || PAGE_LIMIT)) break;
  }

  stats.fetched = items.length;
  log?.(`[${source.id}] ${stats.pages} 页 ${items.length} 条`);
  return { items, stats };
}

module.exports = { crawlSource, mapItem, splitCity };
