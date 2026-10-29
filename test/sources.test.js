'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const univ = require('../src/sources/univ-announcement');
const htmlList = require('../src/sources/html-list');
const jsEmbed = require('../src/sources/js-embed');

function makeStubHttp({ token = 'tok', pages = [], listPageHtml = '' }) {
  const calls = { getJson: 0, postForm: 0, getText: 0 };
  return {
    calls,
    async getJson(url) {
      calls.getJson += 1;
      if (url.includes('/f/ajaxHome/getToken')) return { ok: true, status: 200, json: { data: token } };
      return { ok: true, status: 200, json: null };
    },
    async postForm(url, body) {
      calls.postForm += 1;
      const page = Number(body.pageNo);
      const list = pages[page - 1] || [];
      return { ok: true, status: 200, text: JSON.stringify({ state: 1, object: { list } }) };
    },
    async getText() {
      calls.getText += 1;
      return { ok: true, status: 200, text: listPageHtml };
    },
  };
}

const annItem = (id, name, city = '广东省深圳市') => ({
  corporationName: name,
  title: `${name}2027年校园招聘`,
  url: `/f/recruitmentinfo/show?recruitmentId=${id}`,
  cityName: city,
  education: '硕士,博士',
  majorName: '不限专业',
  startTime: '2026-10-20 10:00:00',
  endTime: '2027-03-19 00:00:00',
  corporationinfo: { corporationNatureValue: '民营企业' },
});

test('univ-announcement：翻页、字段映射、绝对 URL', async () => {
  const http = makeStubHttp({
    pages: [[annItem('a1', '深圳麦科田生物医疗技术股份有限公司'), annItem('a2', '先健科技（深圳）有限公司')]],
  });
  const { items, stats } = await univ.crawlSource(
    { id: 'stub', base_url: 'https://job.example.edu.cn', page_size: 5, daily_pages: 2, max_pages: 2 },
    { http },
  );
  assert.equal(stats.pages, 1, '不足一页就应停止翻页');
  assert.equal(items.length, 2);
  assert.equal(items[0].company, '深圳麦科田生物医疗技术股份有限公司');
  assert.equal(items[0].city, '广东省深圳市');
  assert.equal(items[0].posted_at, '2026-10-20');
  assert.equal(items[0].deadline, '2027-03-19');
  assert.match(items[0].url, /^https:\/\/job\.example\.edu\.cn\/f\/recruitmentinfo\/show\?recruitmentId=a1$/);
  assert.equal(http.calls.getJson, 1);
});

test('univ-announcement：没有 corporationName 时回退 corporationinfo.name（同济模板）', async () => {
  const http = makeStubHttp({
    pages: [[
      {
        title: '上海某医疗科技有限公司2027届校园招聘',
        corporationinfo: { name: '上海某医疗科技有限公司' },
        url: '/f/recruitmentinfo/show?recruitmentId=t1',
        education: '硕士',
        startTime: '2026-10-28 09:00:00',
      },
    ]],
  });
  const { items } = await univ.crawlSource(
    { id: 'stub', base_url: 'https://tj.example.edu.cn', page_size: 5, daily_pages: 2, max_pages: 2 },
    { http },
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].company, '上海某医疗科技有限公司');
});

test('univ-announcement：token 失败时抛错', async () => {
  const http = makeStubHttp({ token: null });
  await assert.rejects(
    univ.crawlSource({ id: 'stub', base_url: 'https://job.example.edu.cn' }, { http }),
    /获取 token 失败/,
  );
});

test('html-list：按选择器抽岗位，无深链时回退列表页并标记 company_page', async () => {
  const html = `<ul id="ul24-1">
    <li><a href="javascript:;"><p class="t">研发工程师</p><p class="l">工作地点：上海市浦东新区</p></a></li>
    <li><a href="javascript:;"><p class="t">质量工程师</p><p class="l">工作地点：上海市浦东新区</p></a></li>
  </ul>`;
  const http = makeStubHttp({ listPageHtml: html });
  const { items } = await htmlList.crawlSource(
    {
      id: 'stub',
      url: 'https://www.example.com/SocialRecruitment/',
      company: '心脉医疗',
      item_selector: "ul[id^='ul24'] li",
      title_selector: 'p:first-child',
      location_selector: 'p:nth-of-type(2)',
      link_selector: 'a',
      city_fallback: '上海',
    },
    { http },
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '研发工程师');
  assert.equal(items[0].url_quality, 'company_page');
  assert.equal(items[0].url, 'https://www.example.com/SocialRecruitment/');
  assert.equal(items[0].city, '上海市浦东新区');
});

test('crawlFatal：部分源失败但抓到了东西 → 不算致命（海外 runner 常态）', () => {
  const { crawlFatal } = require('../src/sources');
  assert.equal(crawlFatal({ items: [{}], failed: [{ source: 'dlut_campus' }] }), false);
  assert.equal(crawlFatal({ items: [{}], failed: [{ source: 'dlut_campus' }], strict: true }), true);
  assert.equal(crawlFatal({ items: [], failed: [] }), true, '一个源都没抓到必须失败');
});

test('js-embed：从内嵌 JS 数据抽岗位（乐普 join_data.js 形态）', async () => {
  const js = 'var research=[{ "details" : "职位名称：质量工程师<br>工作地点：北京<br><br>岗位职责：负责质量管理" },'
    + '{ "details" : "职位名称：支架研发工程师<br>工作地点：上海<br><br>岗位职责：负责支架结构设计" }]';
  const http = {
    async getText() { return { ok: true, status: 200, text: js }; },
  };
  const { items, stats } = await jsEmbed.crawlSource(
    {
      id: 'lepu',
      url: 'https://example.com/join_data.js',
      page_url: 'https://example.com/join',
      company: '乐普医疗',
      entry_pattern: '职位名称：([^<\\n]+)<br>工作地点：([^<\\n]+)',
      requirement_chars: 60,
    },
    { http },
  );
  assert.equal(stats.fetched, 2);
  assert.deepEqual(items.map((x) => x.title), ['质量工程师', '支架研发工程师']);
  assert.equal(items[0].city, '北京');
  assert.equal(items[1].company, '乐普医疗');
  assert.match(items[0].requirement, /质量管理/);
  assert.equal(items[0].url, 'https://example.com/join');
  assert.equal(items[0].url_quality, 'company_page');
});

test('js-embed：缺少 entry_pattern 时报错', async () => {
  const http = { async getText() { return { ok: true, status: 200, text: 'x' }; } };
  await assert.rejects(jsEmbed.crawlSource({ id: 'x', url: 'https://e.com/a.js' }, { http }), /entry_pattern/);
});
