const ExcelJS = require('exceljs');
const fs = require('fs');

function loadSendKeys() {
  const list = [];
  if (process.env.SERVERCHAN_SENDKEY) {
    for (const k of process.env.SERVERCHAN_SENDKEY.split(',')) {
      const v = k.trim();
      if (v) list.push(v);
    }
  }
  if (list.length === 0) {
    try {
      for (const line of fs.readFileSync('serverchan.key', 'utf8').split(/\r?\n/)) {
        const v = line.trim();
        if (v) list.push(v);
      }
    } catch (e) { /* ignore */ }
  }
  if (list.length === 0) {
    throw new Error('未配置 SendKey：请设置环境变量 SERVERCHAN_SENDKEY（逗号分隔多个）或在项目目录创建 serverchan.key 文件');
  }
  return list;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function matchLevel(score) {
  if (score >= 80) return '强烈推荐';
  if (score >= 60) return '值得考虑';
  return '暂不推荐';
}

function extractReason(note) {
  if (!note) return '';
  const parts = String(note).split('|');
  return parts[parts.length - 1].trim();
}

const campusPriority = (j) => /校园招聘|校招|应届/.test(String(j.note)) ? 0 : 1;

async function uploadExcel(filePath) {
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const fd = new FormData();
  fd.append('files', blob, '求职记录.xlsx');
  fd.append('expiryHours', '48');

  const res = await fetch('https://tempfile.org/api/upload/local', { method: 'POST', body: fd });
  const data = await res.json();
  if (!data.success || !data.files?.[0]?.url) {
    throw new Error('上传失败: ' + JSON.stringify(data));
  }
  return data.files[0].url + 'download';
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('求职记录.xlsx');

  const sheet1 = wb.getWorksheet('招聘信息');
  const sheet2 = wb.getWorksheet('投递情况');

  const now = new Date();
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const monthPrefix = today.slice(0, 7);
  const todayDate = new Date(today);
  const weekAgo = new Date(todayDate);
  weekAgo.setDate(weekAgo.getDate() - 6);
  const weekAgoStr = `${weekAgo.getFullYear()}-${pad2(weekAgo.getMonth() + 1)}-${pad2(weekAgo.getDate())}`;

  // Read job listings
  const jobs = [];
  sheet1.eachRow((row, ri) => {
    if (ri === 1) return;
    const date = String(row.getCell(1).value || '').slice(0, 10);
    const matchScore = parseInt(row.getCell(9).value) || 0;
    const legacyScore = parseInt(row.getCell(7).value) || 0;
    const score = matchScore > 0 ? matchScore : legacyScore * 10;
    jobs.push({
      date,
      company: row.getCell(2).value || '',
      position: row.getCell(3).value || '',
      location: row.getCell(5).value || '',
      url: row.getCell(6).value || '',
      score,
      note: row.getCell(8).value || '',
    });
  });

  // Read applied records
  const applied = [];
  if (sheet2) {
    sheet2.eachRow((row, ri) => {
      if (ri === 1) return;
      const v1 = row.getCell(2).value;
      const v2 = row.getCell(3).value;
      if (!v1 || !v2) return;
      applied.push({
        date: String(row.getCell(1).value || '').slice(0, 10),
        company: v1,
        position: v2,
        status: String(row.getCell(4).value || '已投递'),
      });
    });
  }

  const inRange = (d, start, end) => d >= start && d <= end;
  const inMonth = (d) => d.slice(0, 7) === monthPrefix;
  const classifyStatus = (s) => {
    if (/面试|一面|二面|终面|笔试|复试/.test(s)) return 'interview';
    if (/拒绝|未通过|不合适|已拒|淘汰/.test(s)) return 'rejected';
    return 'applied';
  };

  // Today's new jobs
  const todayJobs = jobs.filter(j => j.date === today);
  const highToday = todayJobs.filter(j => j.score >= 80).sort((a, b) => b.score - a.score || campusPriority(a) - campusPriority(b) || a.position.localeCompare(b.position));

  // Period aggregates (counts only)
  function periodStats(filter, applyFilter) {
    const inPeriod = jobs.filter(filter);
    const recCount = inPeriod.filter(j => j.score >= 80).length;
    const applyIn = applied.filter(applyFilter);
    const appliedCount = applyIn.filter(a => classifyStatus(a.status) === 'applied').length;
    const interviewCount = applyIn.filter(a => classifyStatus(a.status) === 'interview').length;
    const rejectedCount = applyIn.filter(a => classifyStatus(a.status) === 'rejected').length;
    return { total: inPeriod.length, rec: recCount, applied: appliedCount, interview: interviewCount, rejected: rejectedCount };
  }

  const weekStats = periodStats(
    j => inRange(j.date, weekAgoStr, today),
    a => inRange(a.date, weekAgoStr, today)
  );
  const monthStats = periodStats(
    j => inMonth(j.date),
    a => inMonth(a.date)
  );

  const highTodayCount = todayJobs.filter(j => j.score >= 80).length;
  const mediumTodayCount = todayJobs.filter(j => j.score >= 60 && j.score < 80).length;
  const lowTodayCount = todayJobs.filter(j => j.score < 60).length;

  // Build message
  let desp = `## 🎯 高匹配度岗位（≥80分，今日新增）\n\n`;

  if (highToday.length > 0) {
    for (const j of highToday) {
      const reason = extractReason(j.note) || matchLevel(j.score);
      desp += `【${j.score}分】${j.position} - ${j.company}\n`;
      desp += `💡 匹配理由：${reason}\n`;
      desp += `🔗 链接：${j.url || '暂无'}\n\n`;
    }
  } else {
    desp += `✅ 今日暂无 ≥80 分新岗位\n\n`;
  }

  desp += `## 📊 今日新增汇总\n\n`;
  desp += `✅ 今日共捕获岗位：${todayJobs.length} 个\n`;
  desp += `⭐ 高匹配度（≥80分）：${highTodayCount} 个\n`;
  desp += `📌 中等匹配（60-79分）：${mediumTodayCount} 个\n`;
  desp += `⏳ 低匹配（<60分）：${lowTodayCount} 个\n\n`;
  desp += `---\n\n`;

  desp += `## 📎 完整岗位清单\n\n`;
  desp += `完整岗位清单（含中低匹配度）：请查看项目目录中的 Excel 表格：**求职记录.xlsx**\n\n`;
  desp += `---\n\n`;

  desp += `## 📅 历史累计\n\n`;
  desp += `【7日内累计】（${weekAgoStr} ~ ${today}）\n`;
  desp += `    累计捕获岗位数：${weekStats.total} 个\n`;
  desp += `    累计推荐投递数：${weekStats.rec} 个\n`;
  desp += `    已投递数：${weekStats.applied} 个\n`;
  if (weekStats.interview > 0) desp += `    面试中数：${weekStats.interview} 个\n`;
  if (weekStats.rejected > 0) desp += `    已拒绝数：${weekStats.rejected} 个\n`;
  desp += `\n`;
  desp += `【本月累计】（${monthPrefix}）\n`;
  desp += `    累计捕获岗位数：${monthStats.total} 个\n`;
  desp += `    累计推荐投递数：${monthStats.rec} 个\n`;
  desp += `    已投递数：${monthStats.applied} 个\n`;
  if (monthStats.interview > 0) desp += `    面试中数：${monthStats.interview} 个\n`;
  if (monthStats.rejected > 0) desp += `    已拒绝数：${monthStats.rejected} 个\n`;
  desp += `\n---\n\n`;

  if (highToday.length > 0) {
    const top = highToday[0];
    desp += `## 💡 每日建议\n\n`;
    desp += `建议今日优先投递：**${top.company}（${top.position}）**\n\n`;
  }

  const title = `📊 【求职日报】${today}`;

  if (process.env.NOTIFY_DRY_RUN === '1') {
    console.log('===== DRY RUN (不推送) =====');
    console.log('标题:', title);
    console.log('----- 消息体 -----');
    console.log(desp);
    console.log('今日新增合计:', todayJobs.length, '| 高:', highTodayCount, '中:', mediumTodayCount, '低:', lowTodayCount);
    return;
  }

  const downloadUrl = await uploadExcel('求职记录.xlsx');
  desp += `📎 **求职记录.xlsx 在线下载：** [点击下载](${downloadUrl})（有效期 48h）\n`;

  const keys = loadSendKeys();
  let okCount = 0;
  const failed = [];
  for (let i = 0; i < keys.length; i++) {
    const apiUrl = `https://sctapi.ftqq.com/${keys[i]}.send`;
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, desp }),
    });

    const result = await res.json();
    if (result.code === 0) {
      okCount++;
      console.log(`推送成功[${i + 1}/${keys.length}] pushid:`, result.data?.pushid);
    } else {
      console.error(`推送失败[${i + 1}/${keys.length}]:`, JSON.stringify(result));
      failed.push(i + 1);
    }
  }
  console.log('下载链接:', downloadUrl);
  if (okCount === 0) process.exit(1);
  if (failed.length > 0) console.warn(`部分发送失败，失败序号: ${failed.join(', ')}（共 ${keys.length} 个 key）`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
