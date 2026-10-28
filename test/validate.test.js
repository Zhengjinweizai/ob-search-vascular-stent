'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyUrl, UrlValidator } = require('../src/validate');

test('classifyUrl：深链 / 企业栏目页 / 搜索页 / 首页', () => {
  assert.equal(classifyUrl('https://www.liepin.com/job/1958068611.shtml'), 'deep_link');
  assert.equal(classifyUrl('https://www.endovastec.com/SocialRecruitment/'), 'company_page');
  assert.equal(classifyUrl('https://www.sogou.com/web?query=血管支架'), 'search');
  assert.equal(classifyUrl('https://www.zhipin.com/'), 'search');
  assert.equal(classifyUrl('https://'), 'invalid');
});

test('UrlValidator：搜索页不发请求直接判定无效；结果缓存', async () => {
  let calls = 0;
  const fakeHttp = {
    async getText() {
      calls += 1;
      return { ok: true, status: 200, text: 'ok' };
    },
  };
  const v = new UrlValidator({ http: fakeHttp });
  const r1 = await v.validate('https://www.sogou.com/web?query=x');
  assert.equal(r1.ok, false);
  assert.equal(calls, 0);

  const r2 = await v.validate('https://example.com/job/123');
  assert.equal(r2.ok, true);
  const r3 = await v.validate('https://example.com/job/123');
  assert.equal(r3.ok, true);
  assert.equal(calls, 1, '第二个相同 URL 应命中缓存');
});
