const test = require('node:test');
const assert = require('node:assert');
const {
  buildQueries,
  mapResult,
  parseTitle,
  resolveProvider,
  crawlSource,
} = require('../src/sources/search-api');

const SOURCE = {
  id: 'search_portals',
  provider: 'bocha',
  sites: ['liepin.com', 'zhipin.com'],
  keywords: ['血管支架', '介入', '医疗器械', '研发工程师'],
  query_suffix: '招聘',
  queries_per_day: 4,
  results_per_query: 10,
  fetch_detail: false,
};

const BOCHA_JSON = {
  json: {
    data: {
      webPages: {
        value: [
          {
            name: '【北京 支架研发工程师招聘】-康誉医疗招聘信息-猎聘',
            url: 'https://www.liepin.com/job/1981333257.shtml?utm_source=x',
            summary: '岗位职责：负责血管支架结构设计与有限元分析，硕士及以上。',
          },
          {
            name: '血管介入研发工程师-鑫云生科招聘-智联招聘',
            url: 'https://www.zhaopin.com/job/1984130461.htm',
            summary: '负责球囊导管产品研发。',
          },
        ],
      },
    },
  },
};

test('resolveProvider：默认 bocha，读环境变量里的 key', () => {
  const a = resolveProvider(SOURCE, { BOCHA_API_KEY: 'k1' });
  assert.strictEqual(a.provider.name, 'bocha');
  assert.strictEqual(a.apiKey, 'k1');
  const b = resolveProvider({ provider: 'serper' }, { SEARCH_API_KEY: 'k2' });
  assert.strictEqual(b.provider.name, 'serper');
  assert.strictEqual(b.apiKey, 'k2');
  assert.throws(() => resolveProvider({ provider: 'nope' }, {}), /未知搜索 provider/);
});

test('buildQueries：site × 关键词矩阵，按天轮换且不重复', () => {
  const day1 = buildQueries(SOURCE, '2026-10-29');
  const day2 = buildQueries(SOURCE, '2026-10-30');
  assert.strictEqual(day1.length, 4);
  assert.strictEqual(day2.length, 4);
  assert.ok(day1.every((q) => q.query.startsWith('site:')));
  assert.ok(day1.every((q) => q.query.endsWith('招聘')));
  assert.notDeepStrictEqual(
    day1.map((q) => q.query),
    day2.map((q) => q.query),
    '不同日期应轮换到不同组合',
  );
  assert.strictEqual(new Set(day1.map((q) => q.query)).size, 4);
});

test('parseTitle：平台标题解析出岗位/公司/城市', () => {
  const a = parseTitle('【北京 支架研发工程师招聘】-康誉医疗招聘信息-猎聘', SOURCE);
  assert.strictEqual(a.title, '支架研发工程师');
  assert.strictEqual(a.company, '康誉医疗');
  assert.strictEqual(a.city, '北京');
  const b = parseTitle('研发工程师_苏州某医疗器械公司招聘', SOURCE);
  assert.strictEqual(b.title, '研发工程师');
  assert.strictEqual(b.company, '苏州某医疗器械公司');
});

test('mapResult：URL 规范化、摘要进 requirement、标记 snippet_only', () => {
  const job = mapResult(
    { title: '【上海 介入研发工程师招聘】-心脉医疗', url: 'https://www.liepin.com/job/1.shtml?utm_source=a', snippet: '负责支架设计' },
    SOURCE,
  );
  assert.strictEqual(job.url, 'https://www.liepin.com/job/1.shtml');
  assert.strictEqual(job.city, '上海');
  assert.strictEqual(job.company, '心脉医疗');
  assert.match(job.requirement, /支架设计/);
  assert.strictEqual(job.snippet_only, true);
  assert.strictEqual(job.url_quality, 'detail');
});

test('crawlSource：无 key 时跳过且不报错', async () => {
  const { items, stats } = await crawlSource(SOURCE, { http: {}, log: () => {}, full: false, env: {} });
  assert.strictEqual(items.length, 0);
  assert.strictEqual(stats.skipped, 'no_api_key');
});

test('crawlSource：解析 provider 返回、按 URL 去重', async () => {
  const calls = [];
  const http = {
    async postJson(url, body, options) {
      calls.push({ url, body, options });
      return BOCHA_JSON;
    },
    async getText() {
      throw new Error('should not be called');
    },
  };
  const prev = process.env.BOCHA_API_KEY;
  process.env.BOCHA_API_KEY = 'test-key';
  try {
    const { items, stats } = await crawlSource(SOURCE, { http, log: () => {}, full: false });
    assert.strictEqual(items.length, 2);
    assert.strictEqual(stats.results, 2);
    assert.strictEqual(stats.provider, 'bocha');
    assert.ok(calls.length >= 1);
    assert.strictEqual(calls[0].url, 'https://api.bochaai.com/v1/web-search');
    assert.strictEqual(calls[0].options.headers.authorization, 'Bearer test-key');
    assert.strictEqual(items[0].url, 'https://www.liepin.com/job/1981333257.shtml');
    assert.strictEqual(items[0].company, '康誉医疗');
  } finally {
    if (prev === undefined) delete process.env.BOCHA_API_KEY;
    else process.env.BOCHA_API_KEY = prev;
  }
});
