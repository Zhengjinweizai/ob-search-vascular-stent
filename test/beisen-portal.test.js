const { test } = require('node:test');
const assert = require('node:assert/strict');
const beisen = require('../src/sources/beisen-portal');

function fakeHttp(pages) {
  const calls = [];
  return {
    calls,
    async postJson(url, body) {
      calls.push({ url, body });
      const list = pages[body.PageIndex] || [];
      return { ok: true, status: 200, json: { Code: 200, Data: list } };
    },
  };
}

const SRC = {
  id: 'acme_social',
  company: '阿克米医疗',
  base_url: 'https://acme.zhiye.com',
  category: '1',
  detail_path: '/social/detail/{id}',
  page_size: 2,
  daily_pages: 3,
  medical_hint: true,
};

test('beisen-portal：分页、字段映射、详情深链', async () => {
  const page0 = [
    { JobAdId: 101, JobAdName: '研发工程师（支架）', Duty: '负责支架结构设计', Require: '硕士，材料相关专业', PostDate: '2026-10-20T09:00:00', EndTime: '0001-01-01T00:00:00', LocNames: ['江苏省·苏州市'] },
    { JobAdId: 102, JobAdName: '注册专员', Duty: '注册资料', Require: '本科', PostDate: '', EndTime: '2026-12-31T00:00:00', LocNames: ['上海市'] },
  ];
  const page1 = [
    { JobAdId: 103, JobAdName: '质量工程师', Duty: '体系维护', Require: '本科', PostDate: '2026-10-21', LocNames: ['广东省·深圳市'] },
  ];
  const http = fakeHttp([page0, page1]);
  const { items, stats } = await beisen.crawlSource(SRC, { http, log: () => {} });

  assert.equal(stats.pages, 2);
  assert.equal(items.length, 3);
  const first = items[0];
  assert.equal(first.kind, 'position');
  assert.equal(first.company, '阿克米医疗');
  assert.equal(first.url, 'https://acme.zhiye.com/social/detail/101');
  assert.equal(first.url_quality, 'detail');
  assert.equal(first.city, '苏州市');
  assert.equal(first.posted_at, '2026-10-20');
  assert.equal(first.deadline, null);
  assert.match(first.requirement, /支架结构设计/);
  assert.equal(first.industry_hint, true);
  assert.equal(items[1].deadline, '2026-12-31');
  assert.equal(items[1].posted_at, null);
  assert.equal(items[2].city, '深圳市');
  assert.equal(http.calls[0].url, 'https://acme.zhiye.com/api/Jobad/GetJobAdPageList');
  assert.deepEqual(http.calls[0].body.Category, ['1']);
});

test('beisen-portal：空页立即停止，不无限翻页', async () => {
  const http = fakeHttp([[]]);
  const { items, stats } = await beisen.crawlSource(SRC, { http, log: () => {} });
  assert.equal(items.length, 0);
  assert.equal(stats.pages, 1);
});

test('splitCity：取最后一段作为城市', () => {
  assert.equal(beisen.splitCity(['山东省·威海市']).city, '威海市');
  assert.equal(beisen.splitCity(['上海市']).city, '上海市');
  assert.equal(beisen.splitCity([]).city, '');
});
