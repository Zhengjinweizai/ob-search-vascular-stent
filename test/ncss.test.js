const test = require('node:test');
const assert = require('node:assert');
const {
  buildListUrl,
  mapListItem,
  extractDetailText,
  extractDetailLocation,
  crawlSource,
} = require('../src/sources/ncss');

const LIST_ITEM = {
  jobName: '医疗器械研发岗',
  recName: '北京天助畅运医疗技术股份有限公司',
  areaCodeName: '江苏',
  degreeName: '硕士及以上',
  major: '材料 机械',
  publishDate: 1793232000000,
  jobId: 'R7u5K1fiBCWHcDdiqqPA9C',
  recruitType: '1',
  recProperty: '民营企业',
  recTags: '专精特新',
};

const DETAIL_HTML = `<!doctype html><html><body>
<div>国家大学生就业服务平台提醒您：请仔细甄别招聘信息真伪，警惕各类求职诈骗与违规招聘。</div>
<div class="site-tag">江苏省无锡市新吴区</div>
<div class="details"><pre class="mainContent mainContent">岗位职责：
1、负责血管支架产品结构设计；
任职资格要求：
1、硕士及以上，材料/机械相关专业。</pre></div>
</body></html>`;

test('buildListUrl：关键词/分页参数正确', () => {
  const url = buildListUrl({ keyword: '血管支架', offset: 21, limit: 20 });
  assert.match(url, /^https:\/\/www\.ncss\.cn\/student\/jobs\/jobslist\/ajax\/\?/);
  assert.match(url, /jobName=%E8%A1%80%E7%AE%A1%E6%94%AF%E6%9E%B6/);
  assert.match(url, /offset=21/);
  assert.match(url, /limit=20/);
});

test('mapListItem：字段映射与详情深链', () => {
  const job = mapListItem(LIST_ITEM, { id: 'ncss_campus' });
  assert.strictEqual(job.source, 'ncss_campus');
  assert.strictEqual(job.kind, 'position');
  assert.strictEqual(job.company, LIST_ITEM.recName);
  assert.strictEqual(job.title, LIST_ITEM.jobName);
  assert.strictEqual(job.url, 'https://www.ncss.cn/student/jobs/R7u5K1fiBCWHcDdiqqPA9C/detail.html');
  assert.strictEqual(job.url_quality, 'detail');
  assert.strictEqual(job.city, '江苏');
  assert.match(job.posted_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(job.extra.job_id, LIST_ITEM.jobId);
});

test('extractDetailText：取职位详情正文，跳过平台反诈提示', () => {
  const text = extractDetailText(DETAIL_HTML);
  assert.match(text, /负责血管支架产品结构设计/);
  assert.ok(!/提醒您/.test(text));
});

test('extractDetailLocation：取详情页完整地点', () => {
  assert.strictEqual(extractDetailLocation(DETAIL_HTML), '江苏省无锡市新吴区');
});

test('crawlSource：按关键词抓列表 + 详情，并做 jobId 去重', async () => {
  const calls = [];
  const http = {
    async getJson(url) {
      calls.push(url);
      return {
        json: {
          data: {
            list: [
              { ...LIST_ITEM, jobId: 'A1' },
              { ...LIST_ITEM, jobId: 'A2' },
            ],
          },
        },
      };
    },
    async getText(url) {
      calls.push(url);
      return { text: DETAIL_HTML };
    },
  };
  const logs = [];
  const { items, stats } = await crawlSource(
    { id: 'ncss_campus', keywords: ['血管支架'], limit: 20, pages_per_keyword: 1 },
    { http, log: (m) => logs.push(m) },
  );
  assert.strictEqual(items.length, 2);
  assert.strictEqual(stats.details, 2);
  assert.deepStrictEqual(items.map((j) => j.extra.job_id), ['A1', 'A2']);
  assert.strictEqual(items[0].city, '江苏省无锡市新吴区');
  assert.match(items[0].requirement, /血管支架/);
  assert.strictEqual(calls.filter((u) => u.includes('jobslist/ajax')).length, 1);
  assert.strictEqual(calls.filter((u) => u.endsWith('/detail.html')).length, 2);
});

test('crawlSource：同一 jobId 跨关键词只保留一次', async () => {
  const http = {
    async getJson() {
      return { json: { data: { list: [{ ...LIST_ITEM, jobId: 'SAME' }] } } };
    },
    async getText() {
      return { text: DETAIL_HTML };
    },
  };
  const { items } = await crawlSource(
    { id: 'ncss_campus', keywords: ['血管支架', '介入'], limit: 20, fetch_detail: false },
    { http },
  );
  assert.strictEqual(items.length, 1);
});
