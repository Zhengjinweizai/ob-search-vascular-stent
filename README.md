**1. 每日自动检索（GitHub Actions 定时，北京时间 08:00）**
- 覆盖 **25 个域名渠道**：猎聘、前程无忧、智联、BOSS直聘等主流平台；国家大学生就业服务平台、中国公共招聘网等国家级平台；11 所高校就业网；15 家目标企业官网；7 个招聘公众号
- 每日全量重搜 + 自动去重，不会漏岗位

**2. AI 智能匹配评分（5 维加权）**
- 按能力模型 `profile_model.yml` 对每个岗位打分：研究方向(0.35) + 技能(0.30) + 学历(0.15) + 行业(0.10) + 企业类型(0.10)
- ≥80 强烈推荐（进「推荐投递」表、微信优先展示）；60-79 值得考虑；<60 暂不推荐
- 每个岗位附匹配理由、为什么投递、简历修改建议

**3. 数据管理（Excel）**
- `求职记录.xlsx`：招聘信息 / 投递情况 / 推荐投递 / 汇总统计 四张表
- 投递、面试、拒信全流程跟踪，自动生成 CSV 便于版本管理

**4. 微信多通道推送**
- ServerChan + PushPlus 双通道并行，任一失败不影响整体
- 推送：标题（含今日新增/推荐数）+ 正文摘要 + 历史累计 + 网页链接 + Excel 下载链接（GitHub raw 永久链接）
- 支持一对多群组（PushPlus 群组 / ServerChan 多 key）

**5. HTML 网页日报（GitHub Pages）**
- 今日新增 / 强烈推荐 / 全部岗位三区，手机友好
- 点击岗位行展开完整细节（岗位要求、匹配理由、维度评分、投递建议）
- 每日自动更新：`https://Zhengjinweizai.github.io/ob-search-vascular-stent/`

**6. 一键可配置（`search-config.yml`）**
- 改关键词、排除词、城市、岗位类型、自定义搜索查询——只改一个文件

## 🛠 技术栈
- **AI 执行**：opencode（DeepSeek 模型）
- **脚本**：Node.js + ExcelJS + js-yaml
- **自动化**：GitHub Actions 定时调度 + 自动提交
- **托管**：GitHub Pages

## 📦 使用
1. 在仓库 Settings → Secrets 配置 `DEEPSEEK_API_KEY`、`SERVERCHAN_SENDKEY`、`PUSHPLUS_TOKEN`（可选 `PUSHPLUS_TOPIC`）
2. 按需修改 `search-config.yml` 中的搜索关键词/范围
3. 每天北京时间 08:00 自动运行，也可在 Actions 手动触发

## ⚠️ 说明
- 本仓库为公开仓库，`求职记录.xlsx`（含投递记录）会随发布公开，请知悉
- 定时任务触发时间以 GitHub Actions 实际调度为准，可能略有延迟
- 推送正文在 ServerChan 免费版仅显示标题（正文建议通过 PushPlus 或网页查看）
