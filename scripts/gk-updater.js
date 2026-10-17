/* =====================================================================
 * 国考 2027 官方数据自动更新器
 *
 * 数据源：国考专题站（纯 http，无需代理）
 *   - 文章列表  GET http://dl.scs.gov.cn/api/article/articlelist/all/{hb01Id}/{eid}/{page}
 *   - 文章详情  GET http://dl.scs.gov.cn/api/article/{articleId}  → article.content (HTML)
 *
 * 工作方式：
 *   1. 拉取「重要通知 / 招考公告」两个栏目的文章列表；
 *   2. 与本地缓存（data/.gk2027_update_cache.json 的 seenIds）对比找出新文章；
 *   3. 标题命中「报名人数 / 资格审查 / 过审 / 缴费」→ 拉正文，提取「N 万人」；
 *   4. 命中则写回 data/guokao2027.json 的 overallStats.totalApplicants / avgRatio，
 *      并在 timeline 追加一条官方统计节点（auto: true 标记，避免重复）。
 *
 * 独立可跑：node scripts/gk-updater.js  （无 Electron 依赖，便于测试）
 * ===================================================================== */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const HB01_ID = '8a81f6eca0221f1401a0242759fc0000';           // 2027 国考专题 id（core-constant.js）
const NOTICE_EID = '0000000062b7b2b60162bcce3de20008';        // 「重要通知」栏目
const ANNOUNCE_EID = '0000000062b7b2b60162bccdd5860007';      // 「招考公告」栏目
const CDN = 'http://dl.scs.gov.cn';
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, '.gk2027_update_cache.json');
const GK2027_FILE = path.join(DATA_DIR, 'guokao2027.json');
const CHECK_INTERVAL = 24 * 3600 * 1000;   // 自动模式 24h 一次

function httpGet(url, timeout = 20000, depth = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 gongkao-helper' } }, res => {
      // 华图专题页 301 http->https，跟随一层重定向即可
      if ([301, 302].includes(res.statusCode) && res.headers.location && depth < 2) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return httpGet(next, timeout, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
  });
}

/* 从正文提取「N 万人」（官方通报过审数）。
 * 教训（单测抓出来的三个坑）：
 *   ① 正文数字会被排版塞进空格（「198 7 年」），必须先去掉全部空白再匹配；
 *   ② 「报名人数突破 200 万人，审查通过 180.5 万人」同句并存时，要取「审查通过」后的数，
 *      取最大值会错拿报名数；
 *   ③ 只有「计划招录 3.9 万人」的文本必须返回 null——招录数不是报名数。
 * 优先级：资格审查句（过审数，三种官方句式）> 报名句 > 全文兜底（仅当确有资格审查字样）。 */
function extractWan(html) {
  const text = String(html).replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  const sentences = text.split(/[。；！？\n]/);
  // 「过审数」的三种常见官方句式
  const grabReview = s => {
    let m = s.match(/审查通过[^，。；]{0,8}?([\d.]+)万人/);                              // 审查通过 180.5 万人
    if (m) return parseFloat(m[1]);
    m = s.match(/([\d.]+)万人[^，。；]{0,15}(?:通过|获)[^，。；]{0,8}资格[审审查查]{2}/); // 371.8 万人通过…资格审查
    if (m) return parseFloat(m[1]);
    m = s.match(/通过[^，。；]{0,12}资格[审审查查]{2}[^，。；]{0,8}?([\d.]+)万人/);       // 通过…资格审查…为 371.8 万人
    if (m) return parseFloat(m[1]);
    return null;
  };
  const grabAny = s => {
    let b = null;
    for (const m of s.matchAll(/([\d.]+)万人/g)) {
      const v = parseFloat(m[1]);
      if (v > 0 && (!b || v > b)) b = v;
    }
    return b;
  };

  // 1) 资格审查句优先（「计划招录」句一律跳过——招录数永远不是报名数）
  for (const s of sentences) {
    if (/计划招录/.test(s)) continue;
    if (/资格[审审查查]{2}|审查通过/.test(s)) {
      const v = grabReview(s) ?? grabAny(s);
      if (v) return v;
    }
  }
  // 2) 报名 / 缴费句
  for (const s of sentences) {
    if (/计划招录/.test(s)) continue;
    if (/报名|缴费/.test(s)) {
      const v = grabAny(s);
      if (v) return v;
    }
  }
  // 3) 兜底：仅当全文确有「资格审查」字样才启用；过滤 <10 万的数（招录数混不进来）
  if (/资格[审审查查]{2}|审查通过/.test(text)) {
    const all = [...text.matchAll(/([\d.]+)万人/g)]
      .map(m => parseFloat(m[1]))
      .filter(v => v > 10);
    if (all.length) return Math.max(...all);
  }
  return null;
}

function localDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* 把官方统计写进 guokao2027.json（含招录合计回推平均竞争比） */
function applyStats(article, wan) {
  const d = JSON.parse(fs.readFileSync(GK2027_FILE, 'utf8'));
  const n = Math.round(wan * 10000);
  d.overallStats = d.overallStats || {};
  d.overallStats.totalApplicants = n;
  const quota = (d.positions || []).reduce((a, p) => a + (Number(p.quota) || 0), 0);
  if (quota) d.overallStats.avgRatio = Math.round(n / quota * 10) / 10;
  d.overallStats.source = `官方通报「${article.title}」（${CDN}/api/article/${article.id}），由应用自动更新于 ${localDateStr(new Date())}`;
  const date = article.ts ? new Date(article.ts) : new Date();
  d.timeline = d.timeline || [];
  const stage = `报名统计：${article.title}`;
  if (!d.timeline.some(t => t.stage === stage)) {
    d.timeline.push({ stage, date: localDateStr(date), source: `${CDN}/api/article/${article.id}`, auto: true });
  }
  fs.writeFileSync(GK2027_FILE, JSON.stringify(d, null, 1), 'utf8');
  return { title: article.title, wan, totalApplicants: n, avgRatio: d.overallStats.avgRatio };
}

/* 第三方口径：华图教育报名人数统计专题（报名期每日更新）。
 * 口径说明：华图的「人报名」= 报名 + 待审总量，「过审」为其汇总口径——
 * 都不是官方通报（官方过审数在报名结束后统一发布，走上面的文章监控）。
 * 写入 timeline 时必须带「第三方」标注，且与上一条数字相同则跳过（每日更新，一天一节点）。 */
const HUATU_URL = 'https://ah.huatu.com/zt/gkrstj/';
async function fetchHuatuStats() {
  let html;
  try { html = await httpGet(HUATU_URL); } catch (e) { return { updated: false, msg: '' }; }
  const text = String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const m = text.match(/([\d,]+)\s*人报名[^\d]{0,40}?([\d,]+)\s*人过审/);
  if (!m) return { updated: false, msg: '' };
  const apply = Number(m[1].replace(/,/g, ''));
  const passed = Number(m[2].replace(/,/g, ''));
  if (!(apply > 0 && passed > 0)) return { updated: false, msg: '' };
  const avg = (text.match(/全国平均竞争比([\d.]+)/) || [])[1] || null;
  const hot = (text.match(/竞争最激烈的职位\s*([\d.]+):1/) || [])[1] || null;
  const upd = (text.match(/更新时间[:：]\s*([\d-]+ [\d:]+)/) || [])[1] || '';

  const d = JSON.parse(fs.readFileSync(GK2027_FILE, 'utf8'));
  d.timeline = d.timeline || [];
  const stage = '报名统计（第三方口径·华图教育，每日更新）';
  const last = [...d.timeline].reverse().find(t => t.stage === stage);
  if (last && String(last.passed) === String(passed)) return { updated: false, msg: '' };
  d.timeline.push({
    stage,
    date: localDateStr(new Date()),
    notes: `截至 ${upd || localDateStr(new Date())}：报名 ${apply.toLocaleString('zh-CN')} 人（含待审）、过审 ${passed.toLocaleString('zh-CN')} 人`
      + (avg ? `、全国平均竞争比 ${avg}:1` : '')
      + (hot ? `、最热职位 ${hot}:1` : '')
      + '。口径：华图教育第三方统计（报名含待审），非官方通报；官方过审总数以报名结束后官方发布为准',
    source: HUATU_URL,
    passed,
    auto: true
  });
  fs.writeFileSync(GK2027_FILE, JSON.stringify(d, null, 1), 'utf8');
  return { updated: true, msg: `华图第三方统计：报名 ${apply.toLocaleString('zh-CN')} / 过审 ${passed.toLocaleString('zh-CN')}` };
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return { lastCheck: 0, seenIds: [], applied: [] }; }
}

/* 主入口。manual=true 时忽略 24h 限频（数据管理页按钮） */
async function fetchOfficialUpdates(manual = false) {
  const cache = loadCache();
  const now = Date.now();
  if (!manual && now - (cache.lastCheck || 0) < CHECK_INTERVAL) {
    return { updated: false, msg: '24 小时内已自动检查过' };
  }
  const seen = new Set(cache.seenIds || []);
  const fresh = [];
  for (const eid of [NOTICE_EID, ANNOUNCE_EID]) {
    for (let pg = 1; pg <= 3; pg++) {
      let list;
      try {
        list = JSON.parse(await httpGet(`${CDN}/api/article/articlelist/all/${HB01_ID}/${eid}/${pg}`));
      } catch (e) { continue; }
      for (const a of (list.articleList || [])) {
        if (!a.id || seen.has(a.id)) continue;
        seen.add(a.id);
        fresh.push({ id: a.id, title: a.articleTitle || '', ts: a.pstrtime || 0 });
      }
      if ((list.articleList || []).length === 0) break;   // 空页不再翻
    }
  }

  const applied = cache.applied || [];
  const results = [];
  for (const a of fresh) {
    if (!/报名人数|资格审查|审查通过|缴费人数/.test(a.title)) continue;
    if (applied.includes(a.id)) continue;
    let detail;
    try { detail = JSON.parse(await httpGet(`${CDN}/api/article/${a.id}`)); } catch (e) { continue; }
    const wan = extractWan((detail.article && detail.article.content) || '');
    if (wan != null) {
      results.push(applyStats(a, wan));
      applied.push(a.id);
    } else {
      applied.push(a.id);   // 命中标题但正文无数字（如报名开始通知），不再重复处理
    }
  }

  // 第三方逐日统计（华图），失败静默
  try {
    const h = await fetchHuatuStats();
    if (h.updated) { results.push({ title: '华图报名统计（第三方口径）', wan: null, msg: h.msg }); }
  } catch (e) { /* 静默 */ }

  cache.lastCheck = now;
  cache.seenIds = [...seen].slice(-500);
  cache.applied = applied.slice(-200);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1), 'utf8');

  return {
    updated: results.length > 0,
    msg: results.length
      ? results.map(r => r.msg || `「${r.title}」→ 报名 ${r.wan} 万人，平均竞争比约 ${r.avgRatio}:1`).join('；')
      : (manual ? '官方暂无新的报名统计（通报通常在报名中后期与截止后发布）' : ''),
    checked: fresh.length
  };
}

module.exports = { fetchOfficialUpdates, extractWan };

/* 命令行直跑：node scripts/gk-updater.js */
if (require.main === module) {
  fetchOfficialUpdates(true).then(r => {
    console.log(JSON.stringify(r, null, 1));
    process.exit(0);
  }).catch(e => { console.error('FAIL', e.message); process.exit(1); });
}
