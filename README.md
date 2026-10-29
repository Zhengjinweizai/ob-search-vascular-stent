# 求职检索与推送（生物医学工程硕士 · 血管支架方向）

每天北京时间 **08:00**，GitHub Actions 自动执行：

```
抓取（高校就业网 / 企业官网）→ 清洗去重 → 硬规则过滤 → DeepSeek 六维评分（带证据）
→ 生成 Excel + 网页日报 + 微信推送（周一加发周报）
```

网页日报：<https://zhengjinweizai.github.io/ob-search-vascular-stent/>

> 本仓库是「方案 B（采集重构）」的落地版本。旧版依赖 opencode 让 AI 自己上网搜（实际没有搜索工具，每天在 60 分钟超时边缘），
> 且 80 分就算"强推"导致 80% 岗位都被标成强推。新版把抓取交给脚本、把推荐口径改成"先过硬规则，再按分排序"。

---

## 目录结构

```
src/
  cli.js                 命令行入口：crawl / process / score / publish / notify / weekly / run / check
  config.js              配置加载与校验（配置错了启动即报错）
  date.js                北京时间日期工具（todayStr / parseDate / daysUntil / isCampusSeason）
  http.js                抓取客户端：并发上限、超时、重试、退避
  normalize.js           URL 规范化 / 公司名归一 / 岗位名归一 / 城市识别 / 岗位族判断
  store.js               JSONL 存储：jobs.jsonl 主库、raw 原始池、review、runs、applications
  sources/               数据源适配器（univ-announcement / html-list）
  extract.js             统一字段抽取（id、岗位族、校招、城市、日期、相关度）
  validate.js            URL 分类（深链/栏目页/搜索页）与 HTTP 存活校验（带缓存）
  filter.js              硬规则闸门（过期/搜索页/仅博/博士后/组织排除/城市/经验放宽转人工）
  score.js               DeepSeek 六维评分：严格 JSON、每维必须有原文证据、总分由脚本重算
  derive/
    excel.js             四表工作簿（招聘信息 / 推荐投递 / 投递情况 / 汇总统计）
    html.js              静态日报网页（搜索、岗位族/城市/校招筛选、截止倒计时）
    notify.js            ServerChan / PushPlus 推送
    weekly.js            周报（本周新增、截止提醒、投递漏斗）
    level.js             分数 → 档位文案
data/
  jobs.jsonl             唯一事实来源：全部岗位（含评分/证据/状态）
  applications.json      投递记录（手动维护，Excel 的「投递情况」表由它派生）
  raw/YYYY-MM.jsonl      原始抓取池（只追加，可回放）
  runs/YYYY-MM-DD.json   每次运行的漏斗与失败原因
  reports/weekly-*.md    周报存档
test/                    73 项单元/结构测试（node --test）
sources.yml              数据源清单（enabled 开关）
portals.yml              旧版 155 个渠道的清单（候选池，不参与抓取；用于逐步补适配器）
search-config.yml        城市、岗位族、经验阈值、相关度词表
profile_model.yml        候选人画像、六维权重、评分锚点、阈值
scripts/import-legacy.js 旧版 Excel → jobs.jsonl 的一次性迁移脚本
```

---

## 常用命令

```bash
npm test                      # 68 项测试
npm run crawl                 # 抓取（--full 全量翻页）
npm run process               # 抽取 + 去重 + URL 校验 + 硬规则过滤，写入主库
npm run score                 # DeepSeek 评分（需要 DEEPSEEK_API_KEY；--recheck 重评）
npm run publish               # 生成求职记录.xlsx + index.html（--no-notify 不推送）
npm run notify                # 只推送微信日报（--dry-run 只打印）
npm run weekly                # 生成周报（--push 同时推送）
npm run check                 # 配置与数据自检
npm run migrate               # 从旧版 求职记录.xlsx 再迁移一次（幂等）
```

环境变量（GitHub Secrets）：

| 变量 | 用途 | 必需 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 评分（deepseek-chat） | 是 |
| `DEEPSEEK_MODEL` | 模型名，默认 `deepseek-chat` | 否 |
| `SERVERCHAN_SENDKEY` | ServerChan 推送（逗号分隔多个 key） | 二选一 |
| `PUSHPLUS_TOKEN` / `PUSHPLUS_TOPIC` | PushPlus 推送 | 二选一 |

本地调试想跳过 AI 评分：`node src/cli.js score --allow-heuristic`（分数会标记 `heuristic: true`，不要用于线上）。
抓取需要外网；评分不跑时 `publish` 仍可生成"待评分"的网页与表格。

---

## 每日流程（.github/workflows/daily-job-search.yml）

1. `npm ci` + `npm test`
2. `crawl`：按 `sources.yml` 逐源抓取，失败源写入 `runs` 并在日志里标红
3. `process`：抽取 → 同批去重 → URL 存活校验（搜索页直接判无效）→ 硬规则 → 主库
4. `score`：仅对"通过硬规则且未评分"的岗位调用 DeepSeek，每维必须给原文证据
5. `publish --no-notify`：生成 Excel 与网页
6. 提交 `data/jobs.jsonl`、`求职记录.xlsx`、`index.html`（先提交，保证手机端 raw 链接是当天文件）
7. `notify`：微信日报
8. 周一追加 `weekly --push`
9. 任何一步失败 → ServerChan 失败告警（不再静默丢一天）

调度：cron `0 0 * * *` + `TZ=Asia/Shanghai`。GitHub 定时任务通常会延迟 1–6 小时，实际运行时间不保证 08:00 整。

---

## 数据模型（jobs.jsonl）

| 字段 | 说明 |
| --- | --- |
| `id` | `sha1(url_canonical \| company_norm \| title_norm)`，稳定去重键 |
| `source` / `kind` | 来源 id；`announcement`（校招公告）或 `position`（具体岗位） |
| `company` / `company_norm` | 公司原名与归一名（括号、城市前缀、法律后缀、别名表） |
| `title` / `title_norm` | 岗位名与归一名（去掉届别、校招、括号） |
| `job_family` | 研发 / 注册法规 / 质量 / 工艺制造 / 技术支持 / 其他 |
| `campus` | 是否校招/应届友好 |
| `cities` / `city_raw` | 识别出的城市列表与原始地点文本 |
| `education_req` / `major_req` / `exp_req` | 学历、专业、经验要求（抽取所得） |
| `posted_at` / `deadline` / `first_seen` / `last_seen` | 发布时间、截止、首次发现、最近见到 |
| `url` / `url_canonical` / `url_quality` / `url_status` | 链接、规范化链接、深链/栏目页/搜索页、HTTP 状态 |
| `gate` | `{action: keep\|review\|skip, reasons: []}` |
| `scores` / `evidence` / `total` | 六维分、每维原文证据、脚本按权重重算的总分 |
| `status` | `active` / `closed` / `unknown`（人工或复核脚本维护） |

> 旧表 12 列仍在 Excel「招聘信息」表前 12 列中，兼容历史阅读习惯；第 13–16 列是岗位族/是否校招/截止/状态。
> 分数只用于排序；**是否推荐由硬规则决定**，`thresholds.strong = 88` 只是"优先级"分界。

---

## 新增数据源

`sources.yml` 目前支持两种适配器：

```yaml
sources:
  - id: xjtu_campus              # 高校就业网（token + 公告列表接口）
    adapter: univ-announcement
    base_url: https://job.xjtu.edu.cn
    daily_pages: 8               # 每天增量翻几页（--full 走 max_pages）
    page_size: 100
    enabled: true

  - id: endovastec_social        # 企业静态列表页（cheerio）
    adapter: html-list
    url: https://www.endovastec.com/SocialRecruitment/
    company: 心脉医疗
    item_selector: "ul[id^='ul24'] li"
    title_selector: p:first-child
    location_selector: p:nth-of-type(2)
    city_fallback: 上海
    enabled: true
```

新增源时先 `curl` 确认「服务端渲染、无验证码、列表链接可预测」，抓不到就设 `enabled: false`，
不要靠 AI 去"搜"——那正是旧版 URL 大面积不可核验的原因。抓取统计会写进 `data/runs/`，覆盖率可度量。

---

## 已知限制（有意为之，不是 bug）

- **只接入实测可用的源**：目前 8 所高校就业网（西安交大、大连理工、国科大、北大、北理、北师、同济、武大，共约 3400 条公告/天）+ 3 家企业岗位源（心脉社招列表、先健社招列表、乐普官网内嵌数据）。
  猎聘/BOSS/智联/jobui 均为 JS 渲染或验证码，纯 fetch 抓不到；高校公告详情页也是模板壳，只能当深链给浏览器打开。
  `portals.yml` 保留了旧版 155 个渠道的完整清单（65 查询 / 31 高校 / 17 公众号 / 42 企业），作为后续逐个补适配器的候选池。
- **企业静态列表大多没有岗位深链**（心脉的 `<a href="javascript:;">`），这类记录 `url_quality=company_page`，网页/表格里会标注，仍需点开人工确认。
- **源级失败不阻塞流水线**：GitHub 海外 runner 访问国内高校站点经常超时（实测 `dlut_campus` 在 Actions 里 fetch failed、`xjtu_campus` 正常）；
  只要还有一个源抓到数据就继续跑，失败源写进 `data/runs/`；要严格模式用 `npm run crawl -- --strict`（任一源失败即退出非 0）。
- **大连理工公告没有城市字段** → 城市未知的进 `data/review.jsonl` 人工复核，不直接丢弃。
- **经验 ≥3 年的社招**：命中"应届/优秀应届/可放宽/接受应届/无经验/实习转正"→ 转人工复核；否则丢弃（校招身份豁免）。
- **不做岗位失效自动下线**（v1 范围外）：`status` 目前靠人工/后续脚本维护。
- **公开仓库**：`data/applications.json`（投递记录）随仓库公开——按你的要求保留，没有做脱敏。

---

## 回滚与排障

- 每次运行的漏斗、失败源、URL 统计都在 `data/runs/YYYY-MM-DD.json`。
- 想看某天抓到了什么：`data/raw/YYYY-MM.jsonl`（只追加，可回放重跑 `process`）。
- 评分失败会进 `data/review.jsonl`（`reason: score_failed`），不会静默丢。
- 想回旧流程：`git revert` 到方案 B 之前的提交（旧 `search-engine.cjs` / `notify-job.cjs` 已在 PR5 删除，可从历史恢复）。

## 迁移

`npm run migrate` 会把旧版 `求职记录.xlsx`（12 列）转成 `data/jobs.jsonl`：
同 URL+同公司合并、泛称岗位不合并、投递记录转 `data/applications.json`。迁移是幂等的，重复跑不会产生重复行。
