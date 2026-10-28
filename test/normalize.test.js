'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalUrl,
  isSearchOrPortalUrl,
  companyNorm,
  titleNorm,
  extractCity,
  guessJobFamily,
  looksCampus,
} = require('../src/normalize');

test('canonicalUrl 去掉跟踪参数、锚点和多余斜杠', () => {
  assert.equal(
    canonicalUrl('https://www.liepin.com/job/1958068611.shtml?utm_source=x&from=y#top'),
    'https://www.liepin.com/job/1958068611.shtml'
  );
  assert.equal(canonicalUrl('https://example.com/job/'), 'https://example.com/job');
  assert.equal(canonicalUrl('https://example.com/job?id=12&utm_medium=abc'), 'https://example.com/job?id=12');
  assert.equal(canonicalUrl('not-a-url'), null);
  assert.equal(canonicalUrl(''), null);
});

test('isSearchOrPortalUrl 识别搜索页与门户首页', () => {
  const bad = [
    'https://www.sogou.com/link?url=abc',
    'https://weixin.sogou.com/weixin?type=2&query=test',
    'https://www.baidu.com/s?wd=test',
    'https://www.bing.com/search?q=test',
    'https://www.zhipin.com/',
    'https://www.zhipin.com',
    'https://www.zhaopin.com/',
    'https://www.liepin.com/',
    'https://job.ncss.cn/',
  ];
  for (const u of bad) assert.equal(isSearchOrPortalUrl(u), true, u);

  const good = [
    'https://www.liepin.com/job/1958068611.shtml',
    'https://www.endovastec.com/SocialRecruitment/',
    'https://job.xjtu.edu.cn/frontpage/xjtu/html/recruitmentinfoForm.html?positionDetailId=abc',
  ];
  for (const u of good) assert.equal(isSearchOrPortalUrl(u), false, u);
});

test('companyNorm 归一化公司名与别名', () => {
  assert.equal(companyNorm('心脉医疗'), '心脉医疗');
  assert.equal(companyNorm('上海微创医疗器械（集团）有限公司'), '微创医疗');
  assert.equal(companyNorm('美中双和（北京）'), '美中双和');
  assert.equal(companyNorm('乐普（北京）医疗器械股份有限公司'), '乐普医疗');
  assert.equal(companyNorm('先健科技（深圳）有限公司'), '先健科技');
  assert.equal(companyNorm('某某医疗器械有限公司'), '某某');
  assert.equal(companyNorm(''), null);
});

test('titleNorm 去掉校招年份/届别/城市等噪声', () => {
  assert.equal(titleNorm('2027届校园招聘-研发工程师（北京）'), '研发工程师');
  assert.equal(titleNorm('血管支架研发工程师'), '血管支架研发工程师');
  assert.equal(titleNorm('研发工程师 | 上海'), '研发工程师');
  assert.equal(titleNorm(''), null);
});

test('extractCity 从地点文本识别城市（含产业园/区县）', () => {
  assert.equal(extractCity('上海-浦东新区'), '上海');
  assert.equal(extractCity('东莞松山湖'), '东莞');
  assert.equal(extractCity('宁波-慈溪'), '宁波');
  assert.equal(extractCity('苏州工业园区'), '苏州');
  assert.equal(extractCity('北京'), '北京');
  assert.equal(extractCity(''), null);
});

test('guessJobFamily 识别岗位族（临床/销售不在白名单里）', () => {
  assert.equal(guessJobFamily('血管支架研发工程师'), '研发');
  assert.equal(guessJobFamily('医疗器械注册专员'), '注册法规');
  assert.equal(guessJobFamily('质量工程师（QA）'), '质量');
  assert.equal(guessJobFamily('工艺工程师'), '工艺制造');
  assert.equal(guessJobFamily('临床应用工程师'), '临床医学');
  assert.equal(guessJobFamily('临床监查员 CRA'), '临床医学');
  assert.equal(guessJobFamily('医疗器械销售代表'), '销售市场');
  assert.equal(guessJobFamily('行政专员'), '职能');
  assert.equal(guessJobFamily('研发工程师', '负责产品注册与临床评价'), '研发');
});

test('looksCampus 识别校招/应届线索', () => {
  assert.equal(looksCampus('2027届校园招聘'), true);
  assert.equal(looksCampus('校园招聘'), true);
  assert.equal(looksCampus('社招', '不限经验，应届可投'), true);
  assert.equal(looksCampus('社会招聘', '3 年以上经验'), false);
});
