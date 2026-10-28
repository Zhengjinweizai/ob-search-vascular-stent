'use strict';

/**
 * 规范化工具：URL、公司名、岗位名、城市、岗位族、校招标记。
 * 全部是纯函数，方便单测；配置相关（城市名单、岗位族关键词）可通过参数注入。
 */

// ---------- URL ----------

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'from', 'source', 'spm', 'traceid', 'sharesource', 'share_token', 'shareid',
  'ref', 'refer', 'channel', 'sr', 'srce', 'isfrom', 'fromscene', 'scene',
];

// 搜索页 / 门户首页 / 列表页：不能当岗位链接
const NON_JOB_URL_PATTERNS = [
  /^https?:\/\/(www\.)?(sogou|baidu|bing|google|so)\.com\b/i,
  /weixin\.sogou\.com/i,
  /^https?:\/\/(www\.)?zhipin\.com\/?(\?|$)/i,
  /^https?:\/\/(www\.)?zhipin\.com\/(web\/geek|job_detail\/?$)/i,
  /^https?:\/\/(www\.)?zhaopin\.com\/?(\?|$)/i,
  /^https?:\/\/(www\.)?liepin\.com\/?(\?|$)/i,
  /^https?:\/\/(www\.)?51job\.com\/?(\?|$)/i,
  /^https?:\/\/(www\.)?lagou\.com\/?(\?|$)/i,
  /^https?:\/\/(www\.)?job\.ncss\.cn\/?(\?|$)/i,
  /^https?:\/\/www\.ncss\.cn\/?(\?|$)/i,
  /^https?:\/\/(www\.)?yingjiesheng\.com\/?(\?|$)/i,
  /\?[^#]*(query|wd|q|key|keyword)=/i,
];

function canonicalUrl(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!u.hostname || !u.hostname.includes('.')) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (u.hostname.startsWith('www.') && u.hostname.split('.').length > 2) {
    // 保留 www：部分站点 www 与非 www 是不同站点，交给存活校验兜底，不在这里合并
  }
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.includes(k.toLowerCase()));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

function isSearchOrPortalUrl(url) {
  if (!url) return true;
  const s = String(url).trim();
  if (!/^https?:\/\//i.test(s)) return true;
  return NON_JOB_URL_PATTERNS.some((re) => re.test(s));
}

// ---------- 公司名 ----------

const COMPANY_ALIASES = {
  心脉: '心脉医疗',
  心脉医疗: '心脉医疗',
  微创: '微创医疗',
  微创医疗: '微创医疗',
  乐普: '乐普医疗',
  乐普医疗: '乐普医疗',
  先健: '先健科技',
  先健科技: '先健科技',
  赛诺: '赛诺医疗',
  赛诺医疗: '赛诺医疗',
  归创通桥: '归创通桥',
  蓝帆: '蓝帆医疗',
  蓝帆医疗: '蓝帆医疗',
  垠艺: '垠艺生物',
  垠艺生物: '垠艺生物',
  美中双和: '美中双和',
  巴泰: '巴泰医疗',
  赛禾: '赛禾医疗',
  启明: '启明医疗',
  沛嘉: '沛嘉医疗',
  惠泰: '惠泰医疗',
  恒瑞: '恒瑞医药',
  迈瑞: '迈瑞医疗',
  联影: '联影医疗',
  鱼跃: '鱼跃医疗',
  威高: '威高集团',
  康德莱: '康德莱',
  康誉: '康誉医疗',
  鑫云生科: '鑫云生科',
  天臣: '天臣医疗',
};

const COMPANY_SUFFIXES = [
  '股份有限公司', '有限责任公司', '有限公司', '公司',
  '集团', '控股', '医疗科技', '医疗器械', '生物科技', '生物技术', '医疗',
  '科技', '股份', '（中国）', '(中国)',
];

function companyNorm(name) {
  if (!name) return null;
  let s = String(name).trim();
  if (!s) return null;
  // 去掉所有括号内容（城市、集团、年份、英文缩写）：美中双和（北京）→ 美中双和
  s = s.replace(/[（(][^）)]*[）)]/g, '');
  s = s.replace(/\s+/g, '').replace(/[，,。.、]/g, '');
  // 去掉开头的城市/省份前缀：上海微创 → 微创
  s = s.replace(/^(北京|上海|深圳|苏州|杭州|东莞|无锡|常州|宁波|广州|南京|天津|成都|武汉|西安|厦门|珠海|合肥|青岛|佛山|中山|江苏|浙江|广东|中国)/, '');
  // 去掉法律后缀（可能叠加）
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of COMPANY_SUFFIXES) {
      if (s.length > suf.length && s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        changed = true;
      }
    }
  }
  if (!s) return null;
  // 别名：包含最长别名键则归一到标准名（上海微创 → 微创 → 微创医疗）
  let best = null;
  for (const [alias, std] of Object.entries(COMPANY_ALIASES)) {
    if (s.includes(alias) && (!best || alias.length > best.alias.length)) best = { alias, std };
  }
  return best ? best.std : s;
}

// ---------- 岗位名 ----------

const TITLE_NOISE = [
  /20\d{2}届?/g, /20\d{2}年?/g, /校园招聘/g, /校招/g, /社招/g, /急聘/g, /急招/g, /热招/g,
  /【[^】]*】/g, /（[^）]*）/g, /\([^)]*\)/g, /招聘信息.*$/g,
  /^[-—_|｜·\s]+/, /[-—_|｜·\s]+$/,
];

// 岗位名里的分隔符：只保留第一段（研发工程师 | 上海 → 研发工程师）

function titleNorm(title) {
  if (!title) return null;
  let s = String(title).toLowerCase().replace(/\s+/g, '');
  s = s.split(/[|｜·—–]/)[0] || '';
  for (const re of TITLE_NOISE) s = s.replace(re, '');
  s = s.replace(/[，,。.、:：;；!！?？"'“”‘’]/g, '');
  return s || null;
}

// ---------- 城市 ----------

const CITY_ALIASES = {
  北京: ['北京', '北京市'],
  上海: ['上海', '上海市'],
  深圳: ['深圳', '深圳市'],
  苏州: ['苏州', '苏州市', '苏州工业园区', '昆山', '太仓', '张家港', '常熟'],
  杭州: ['杭州', '杭州市', '余杭', '滨江'],
  东莞: ['东莞', '东莞市', '松山湖'],
  无锡: ['无锡', '无锡市'],
  常州: ['常州', '常州市'],
  嘉兴: ['嘉兴', '嘉兴市'],
  宁波: ['宁波', '宁波市', '慈溪', '余姚'],
  广州: ['广州', '广州市'],
  南京: ['南京', '南京市'],
  天津: ['天津', '天津市'],
  成都: ['成都', '成都市'],
  武汉: ['武汉', '武汉市'],
  西安: ['西安', '西安市'],
  厦门: ['厦门', '厦门市'],
  珠海: ['珠海', '珠海市'],
  合肥: ['合肥', '合肥市'],
  青岛: ['青岛', '青岛市'],
  佛山: ['佛山', '佛山市'],
  中山: ['中山', '中山市'],
};

/** 从"上海-浦东新区"、"东莞松山湖"、"宁波-慈溪"里识别城市 */
function extractCity(location) {
  if (!location) return null;
  const s = String(location);
  for (const [city, aliases] of Object.entries(CITY_ALIASES)) {
    for (const a of aliases) {
      if (s.includes(a)) return city;
    }
  }
  return null;
}

// ---------- 岗位族 ----------

const FAMILY_RULES = [
  ['研发', /(研发|开发|设计|结构|仿真|有限元|工艺开发|材料工程|研究)/],
  ['注册法规', /(注册|法规|\bRA\b|FDA|CE认证|体系认证)/i],
  ['质量', /(质量|QA|QC|体系|检验|可靠性|合规)/i],
  ['工艺制造', /(工艺|制造|生产|设备|自动化|模具|装配|产线)/],
  ['临床医学', /(临床|医学|CRA|CRC|CRO|医学事务)/],
  ['技术支持', /(技术支持|应用工程|售前|售后|现场服务|技术服务)/],
  ['销售市场', /(销售|市场|商务|渠道|客户经理)/],
  ['职能', /(行政|人事|HR|财务|会计|法务|采购|供应链|IT|信息)/],
];

function guessJobFamily(title, requirement = '') {
  const text = `${title || ''} ${String(requirement).slice(0, 400)}`;
  // 先看标题：标题里的岗位名比正文可靠
  for (const [family, re] of FAMILY_RULES) {
    if (title && re.test(title)) return family;
  }
  for (const [family, re] of FAMILY_RULES) {
    if (re.test(text)) return family;
  }
  return '其他';
}

// ---------- 校招 ----------

const CAMPUS_PATTERNS = [/(校园招聘|校招|应届|20\d{2}届|管培生|培训生|实习生?招聘)/];

function looksCampus(...parts) {
  const text = parts.filter(Boolean).join(' ');
  return CAMPUS_PATTERNS.some((re) => re.test(text));
}

module.exports = {
  canonicalUrl,
  isSearchOrPortalUrl,
  companyNorm,
  titleNorm,
  extractCity,
  guessJobFamily,
  looksCampus,
  CITY_ALIASES,
  COMPANY_ALIASES,
};
