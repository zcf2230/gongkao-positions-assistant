/* 考公岗位信息助手 - 渲染进程逻辑 */
const fs = require('fs');
const path = require('path');
const { shell, ipcRenderer } = require('electron');

const DATA_DIR = path.join(__dirname, '..', 'data');
// 顺序即优先级：同名考试以先出现的文件为主（overallStats/timeline/examStructure），positions 追加
// 注意：shanghai2026_b.json 目前尚未创建（上海数据待补齐），loadBuiltins 会记为 missing 而非报错；
//       补齐该文件后无需改代码即可自动生效。
const BUILTIN_FILES = ['zhejiangxuandiao2027.json', 'guokao2027.json', 'guokao2026.json', 'guokao2026_b.json', 'guokao2026_c.json', 'zhejiang2026.json', 'zhejiang2026_b.json', 'shandong2026.json', 'shandong2026_b.json', 'shandong2026_c.json', 'shandong2026_d.json', 'shanghai2026.json', 'shanghai2026_b.json'];
const KOUBEI_FILE = path.join(DATA_DIR, 'koubei.json');
const CUSTOM_FILE = path.join(DATA_DIR, 'custom_imports.json');

const LS = {
  fav: 'gk_favorites',
  review: 'gk_reviews',
  task: 'gk_tasks',
  compare: 'gk_compare',
  banner: 'gk_banner_dismissed'
};
const loadLS = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const saveLS = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let datasets = [];      // 各考试元数据（同名考试已合并）
let allPositions = [];  // 展平的岗位
let koubeiItems = [];   // 内置口碑
let favorites = loadLS(LS.fav, []);
let reviews = loadLS(LS.review, {});
let tasks = loadLS(LS.task, null) || defaultTasks();
let compareList = loadLS(LS.compare, []);   // uid 数组（持久化）
let importParsed = null; // 导入中间态
let lastFiltered = [];  // 最近的查询结果（导出用）
let loadIssues = [];    // 数据文件加载问题：{file, type:'missing'|'error', msg}
let dataUpdatedAt = null; // 内置数据文件的最近修改时间
let aggregateCount = 0; // 机关级汇总条目数（非真实职位）

/* 查询条件的「出厂默认值」——「重置条件」必须还原到这一组，而不是另一组别的值 */
const FILTER_DEFAULTS = {
  exams: ['国考', '浙江选调', '浙江省考', '山东省考', '上海市考'],
  region: '',
  major: '金融',
  edu: 'bachelor',
  political: '',
  base: '',
  keyword: '',
  sort: 'default',
  favOnly: false
};

/* 机关级汇总条目：position 固定为「财经类综合岗位（机关汇总）」，不是可投递的具体职位 */
const isAggregate = p => /汇总/.test(String(p.position || ''));

/* 考试类型 → 标签配色（与 style.css 的 .tag.exam-* 对应） */
const EXAM_CLS = {
  '国考': 'exam-guokao',
  '浙江选调': 'exam-xuandiao',
  '浙江省考': 'exam-zhejiang',
  '山东省考': 'exam-shandong',
  '上海市考': 'exam-shanghai'
};
const examCls = exam => `tag ${EXAM_CLS[exam] || 'gray'}`;
const fmtNum = n => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('zh-CN');

/* ---------------- 地区常量 ---------------- */
const PROV_CITIES = {
  '浙江': ['杭州', '宁波', '温州', '嘉兴', '湖州', '绍兴', '金华', '衢州', '舟山', '台州', '丽水'],
  '山东': ['济南', '青岛', '淄博', '枣庄', '东营', '烟台', '潍坊', '济宁', '泰安', '威海', '日照', '临沂', '德州', '聊城', '滨州', '菏泽'],
  '上海': ['上海']
};
const PROVINCES = [...Object.keys(PROV_CITIES), '北京', '天津', '重庆', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江', '江苏', '安徽', '福建', '江西', '河南', '湖北', '湖南', '广东', '广西', '海南', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆'];
const ALL_CITIES = Object.values(PROV_CITIES).flat();
const CITY_PROV = {};
for (const [pv, cs] of Object.entries(PROV_CITIES)) cs.forEach(c => { CITY_PROV[c] = pv; });

// 归一化地区：返回 { prov, city }
function normLocation(loc) {
  const s = String(loc || '');
  let prov = PROVINCES.find(p => s.includes(p)) || null;
  if (s.includes('全国')) { return { prov: '全国', city: '全国各省市' }; }
  let city = null;
  // 优先匹配"省·市"分隔符后的城市段
  const afterSep = s.match(/[·]\s*([\u4e00-\u9fa5]{2,5})/);
  if (afterSep) {
    const cand = afterSep[1];
    city = ALL_CITIES.find(c => cand.startsWith(c) || c === cand) || null;
  }
  if (!city) city = ALL_CITIES.find(c => s.includes(c)) || null;
  if (!prov && city) prov = CITY_PROV[city] || null; // 旧格式只有城市名，反查省份
  if (!city && prov && prov === '上海') city = '上海';
  if (!city && prov) city = prov; // 省本级，如"浙江"省直
  return { prov: prov || '其他', city: city || s.slice(0, 8) || '其他' };
}

/* ---------------- 工具 ---------------- */
function defaultTasks() {
  return [
    { id: 1, txt: '确定目标：国考 + 浙江省考 + 山东省考/上海市考 组合', done: false },
    { id: 2, txt: '系统学习行测五大模块（资料分析优先）', done: false },
    { id: 3, txt: '申论：每周精练 1 套小题 + 1 篇大作文', done: false },
    { id: 4, txt: '国考公告发布后核对职位表，筛选金融可报岗位', done: false },
    { id: 5, txt: '报名期：每天关注过审人数，最后 2 天内确认报名', done: false },
    { id: 6, txt: '笔试前 1 个月：每周 2 套全真模考', done: false },
    { id: 7, txt: '准备应届生身份材料（三方/档案政策了解）', done: false }
  ];
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtRatio = p => {
  if (p.applicants && p.quota) return (p.applicants / p.quota).toFixed(1);
  return null;
};
function ratioClass(r) { if (r == null) return ''; return r >= 100 ? 'ratio-hot' : r >= 40 ? 'ratio-mid' : 'ratio-ok'; }
function posUid(p) { return p.exam + '|' + (p.code || '') + '|' + (p.dept || '') + '|' + (p.position || '') + '|' + (p.location || ''); }

// 判定两条记录是否为「同一个职位」。
// 背景：uid 不含招录人数，同名职位（如某分行"综合业务部门一级主任科员及以下"分别招 1 人 / 10 人）
// 会撞 uid。旧逻辑直接丢弃后者，属于静默丢数据；现在改为「同 uid 且关键字段全同才算重复」。
const POS_IDENTITY_KEYS = ['quota', 'applicants', 'entryScore', 'education', 'major', 'political', 'baseYears', 'notes'];
function samePosition(a, b) {
  return POS_IDENTITY_KEYS.every(k => String(a[k] ?? '') === String(b[k] ?? ''));
}

function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})[-/年.](\d{1,2})(?:[-/月.](\d{1,2}))?/);
  if (m) return new Date(+m[1], +m[2] - 1, +(m[3] || 1));
  return null;
}
// 取时间段里的起始/结束日期（注意不能按 ASCII "-" 切分，否则会破坏 ISO 日期）
function parseRange(s) {
  if (!s) return [null, null];
  const parts = String(s).split(/至|到|~|～|—|－/).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return [parseDate(parts[0]), parseDate(parts[1])];
  return [parseDate(parts[0]), parseDate(parts[0])];
}

/* ---------------- 数据加载 ---------------- */
function loadBuiltins() {
  loadIssues = [];
  const raws = [];
  let latest = 0;
  for (const f of BUILTIN_FILES) {
    const fp = path.join(DATA_DIR, f);
    if (!fs.existsSync(fp)) {
      loadIssues.push({ file: f, type: 'missing', msg: '文件不存在（数据待补齐）' });
      continue;
    }
    try {
      const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
      d._file = f;
      raws.push(d);
      const mt = fs.statSync(fp).mtimeMs;
      if (mt > latest) latest = mt;
    } catch (e) {
      // 绝不静默吞掉：JSON 写坏会让整份数据凭空消失，必须让用户看见
      loadIssues.push({ file: f, type: 'error', msg: '解析失败：' + e.message });
    }
  }
  dataUpdatedAt = latest ? new Date(latest) : null;

  // 同名考试同年份合并：以先出现的文件为主（overallStats/timeline 取主文件），positions 追加去重；不同年度（如国考2027）作为独立数据集展示
  const byExam = new Map();
  for (const d of raws) {
    if (!d || !d.exam) continue;
    const key = d.exam + '|' + d.year;
    if (byExam.has(key)) {
      const main = byExam.get(key);
      main.positions = (main.positions || []).concat(d.positions || []);
      if (d.cityStats) main.cityStats = (main.cityStats || []).concat(d.cityStats);
    } else {
      byExam.set(key, d);
    }
  }
  datasets = [...byExam.values()];
  datasets.forEach(d => { d._custom = false; });

  try {
    const d = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
    d._file = 'custom_imports.json';
    d._custom = true;
    datasets.push(d);
  } catch (e) { /* 无导入数据 */ }

  try {
    const k = JSON.parse(fs.readFileSync(KOUBEI_FILE, 'utf8'));
    koubeiItems = k.items || [];
  } catch (e) { koubeiItems = []; }

  allPositions = [];
  const byUid = new Map();   // uid -> 已收录的岗位
  let merged = 0;            // 真正重复（关键字段全同）被合并的条数
  let disambiguated = 0;     // 同 uid 但内容不同，加 #2 后缀保留的条数
  for (const d of datasets) {
    (d.positions || []).forEach(p => {
      const np = { ...p, exam: d.exam, year: p.year || d.year, ratio: fmtRatio(p) };
      let uid = posUid(np);
      const prev = byUid.get(uid);
      if (prev) {
        if (samePosition(prev, np)) { merged++; return; }
        let n = 2;
        while (byUid.has(uid + '#' + n)) n++;
        uid = uid + '#' + n;
        disambiguated++;
      }
      np.uid = uid;
      byUid.set(uid, np);
      const loc = normLocation(np.location);
      np._prov = loc.prov;
      np._city = loc.city;
      allPositions.push(np);
    });
  }
  window.__gkLoadStats = { merged, disambiguated, total: allPositions.length };
  aggregateCount = allPositions.filter(isAggregate).length;
}

/* ---------------- 选项与筛选 ---------------- */
function regionGroups() {
  const extra = new Map(); // 其他省份 -> 城市/地点
  allPositions.forEach(p => {
    if (!Object.keys(PROV_CITIES).includes(p._prov) && p._prov !== '全国') {
      const label = p._prov === '其他' ? (p.location || '其他') : (p._city && p._city !== p._prov ? p._prov + '·' + p._city : p._prov);
      if (!extra.has(label)) extra.set(label, label);
    }
  });
  return { main: PROV_CITIES, extra: [...extra.keys()] };
}

function fillRegionSelect() {
  const sel = document.getElementById('fRegion');
  const cur = sel.value;
  const { main, extra } = regionGroups();
  let html = '<option value="">全部地区</option>';
  for (const [prov, cities] of Object.entries(main)) {
    html += `<optgroup label="${prov}">` + cities.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') + '</optgroup>';
  }
  if (extra.length) html += '<optgroup label="其他地区">' + extra.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') + '</optgroup>';
  sel.innerHTML = html;
  sel.value = cur;
}

function matchRegion(p, region) {
  if (!region) return true;
  if (p._city === region) return true;
  if (p._prov === region) return true;
  // 静态城市列表里选的城市，数据里 location 原文包含也算
  const s = String(p.location || '');
  if (region.length >= 2 && s.includes(region)) return true;
  return false;
}

function eduAllowsBachelor(edu) {
  const s = String(edu || '');
  return /本科/.test(s) || /大专|专科/.test(s) || /不限/.test(s);
}
function eduRequiresMaster(edu) {
  const s = String(edu || '');
  return /硕士|研究生/.test(s) && !/本科/.test(s);
}
function politicalOk(filterVal, required) {
  if (!filterVal) return true;
  const r = String(required || '不限');
  if (filterVal === 'none') return /不限|无|群众/.test(r) || r === '';
  if (filterVal === 'ccp') return /党/.test(r); // 想报要求党员的岗
  return true;
}

function currentFilters() {
  const exams = [...document.querySelectorAll('#examChecks input:checked')].map(x => x.value);
  return {
    exams,
    region: document.getElementById('fRegion').value,
    major: document.getElementById('fMajor').value.trim(),
    edu: document.getElementById('fEdu').value,
    political: document.getElementById('fPolitical').value,
    base: document.getElementById('fBase').value,
    keyword: document.getElementById('fKeyword').value.trim(),
    sort: document.getElementById('fSort').value,
    favOnly: document.getElementById('fFavOnly').checked
  };
}

// 把界面控件恢复到「出厂默认值」。启动和「重置条件」共用同一个函数，
// 保证两者结果一致（旧版重置后学历变"不限"、政治面貌/基层年限/考试勾选不还原，得到的是第三种状态）。
function applyFilterDefaults() {
  const d = FILTER_DEFAULTS;
  document.querySelectorAll('#examChecks input').forEach(c => { c.checked = d.exams.includes(c.value); });
  document.getElementById('fRegion').value = d.region;
  document.getElementById('fMajor').value = d.major;
  document.getElementById('fEdu').value = d.edu;
  document.getElementById('fPolitical').value = d.political;
  document.getElementById('fBase').value = d.base;
  document.getElementById('fKeyword').value = d.keyword;
  document.getElementById('fSort').value = d.sort;
  document.getElementById('fFavOnly').checked = d.favOnly;
  syncSortHeaders();
}

function filterPositions(f) {
  let list = allPositions.filter(p => {
    if (f.exams.length && !f.exams.includes(p.exam)) return false;
    if (f.favOnly && !favorites.includes(p.uid)) return false;
    if (!matchRegion(p, f.region)) return false;
    if (f.edu === 'bachelor' && !eduAllowsBachelor(p.education)) return false;
    if (f.edu === 'master' && !eduRequiresMaster(p.education)) return false;
    if (f.political && !politicalOk(f.political, p.political)) return false;
    if (f.base === 'none' && !/不限|无|^$/.test(String(p.baseYears || '不限'))) return false;
    if (f.base === 'has' && /不限|无|^$/.test(String(p.baseYears || '不限'))) return false;
    if (f.major) {
      const majors = String(p.major || '');
      const kws = f.major.split(/[\/、,，\s]+/).filter(Boolean);
      if (kws.length && !kws.some(k => majors.includes(k))) return false;
    }
    if (f.keyword) {
      const kws = f.keyword.split(/[\s,，]+/).filter(Boolean);
      const hay = [p.dept, p.position, p.location, p.exam, p.major, p.notes].join(' ');
      if (!kws.every(k => hay.includes(k))) return false;
    }
    return true;
  });
  const sorters = {
    ratioAsc: makeSorter('ratio', 1),
    ratioDesc: makeSorter('ratio', -1),
    scoreAsc: makeSorter('entryScore', 1),
    scoreDesc: makeSorter('entryScore', -1),
    quotaDesc: makeSorter('quota', -1),
    quotaAsc: makeSorter('quota', 1),
    applicantsDesc: makeSorter('applicants', -1)
  };
  if (sorters[f.sort]) list.sort(sorters[f.sort]);
  else list.sort((a, b) => (a.exam + a.year).localeCompare(b.exam + b.year, 'zh'));
  return list;
}

// 数值排序：空值一律沉底（旧逻辑把 null 当 -1，导致"竞争比 低→高"前 119 行全是空数据）
function makeSorter(key, dir) {
  const val = v => (v == null || v === '' || isNaN(v) ? null : +v);
  return (a, b) => {
    const av = val(a[key]), bv = val(b[key]);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir * (av - bv);
  };
}

/* ---------------- 渲染：查询 ---------------- */
const RENDER_LIMIT = 400;   // 表格单次渲染上限（导出不受限）

function renderResults() {
  const f = currentFilters();
  const list = filterPositions(f);
  lastFiltered = list;
  const body = document.getElementById('resultBody');
  const agg = list.filter(isAggregate).length;
  document.getElementById('matchCount').textContent =
    `匹配到 ${list.length} 个岗位（真实职位 ${list.length - agg} · 机关汇总 ${agg}）`;
  document.getElementById('emptyTip').classList.toggle('hidden', list.length > 0);

  // 截断提示：旧版本静默只显示前 400 条，用户无从察觉
  const note = document.getElementById('tableNote');
  if (note) {
    if (list.length > RENDER_LIMIT) {
      note.innerHTML = `⚠️ 结果共 <b>${list.length}</b> 条，表格仅显示前 <b>${RENDER_LIMIT}</b> 条。点「导出 Excel」可拿到全部 ${list.length} 条，或补充筛选条件缩小范围。`;
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }
  }

  const linkify = (txt, p, cls) => {
    const t = esc(txt);
    return p.source
      ? `<a class="srclink ${cls}" href="${esc(p.source)}" target="_blank" title="点击打开来源网页：${esc(p.source)}">${t}</a>`
      : `<span class="${cls}">${t}</span>`;
  };
  // 金融可报：这工具的核心诉求，必须能在列表里直接看到，而不是逐个点进详情
  /* ⚠️ 国考进面分有两套满分制，混在一起排序会误导：
   *   普通职位 = 原始总分（满分 200）；特殊专业职位（金融监管/证监会/边检/外语等，
   *   需加考专业科目）= 折合分（满分 100）。52 分看着比 124 低，实际约等于 200 分制的 104 分。
   * 判据「国考 && <90」已实测校验：<90 的 231 条全是折合分，>=90 的 2165 条里没有一条折合分。 */
  const isFoldedScore = p => p.exam === '国考' && typeof p.entryScore === 'number' && p.entryScore < 90;
  const scoreCell = p => {
    if (p.entryScore == null) return '-';
    return isFoldedScore(p)
      ? `${p.entryScore}<span class="tag folded" title="国考特殊专业职位（需加考专业科目）为折合分，满分 100，不可与普通职位的 200 分制直接比较">折合</span>`
      : String(p.entryScore);
  };

  const finTag = p => p.financeOk === true
    ? '<span class="tag ok" title="专业要求含金融/经济/财政等，本科可报">✔ 可报</span>'
    : p.financeOk === false
      ? '<span class="tag warn" title="专业要求与金融不符">✘ 不符</span>'
      : '<span class="tag gray" title="专业要求为机关级推断或未逐条核对，请以官方职位表为准">待核对</span>';
  body.innerHTML = list.slice(0, RENDER_LIMIT).map(p => {
    const fav = favorites.includes(p.uid);
    const inCmp = compareList.includes(p.uid);
    const aggTag = isAggregate(p)
      ? '<span class="tag gray" title="机关级汇总条目：该机关共招 N 岗 M 人，非可投递的具体职位">汇总</span>'
      : '';
    return `<tr data-uid="${esc(p.uid)}">
      <td><span class="fav-star ${fav ? 'on' : ''}" data-act="fav" title="收藏/取消收藏">★</span></td>
      <td><span class="${examCls(p.exam)}">${esc(p.exam)}</span><span class="tag gray">${esc(p.year)}</span></td>
      <td class="dept">${linkify(p.dept, p, '')}</td>
      <td class="pos-name">${linkify(p.position, p, '')}${aggTag}</td>
      <td title="${esc(p.location || '')}">${esc(p.location || '')}</td>
      <td>${p.quota ?? '-'}</td>
      <td title="${p.applicants == null ? '官方未公布该岗位报名人数' : '报名人数'}">${p.applicants ?? '—'}</td>
      <td class="${ratioClass(p.ratio)}">${p.ratio ? p.ratio + ' : 1' : '-'}</td>
      <td>${scoreCell(p)}</td>
      <td>${finTag(p)}</td>
      <td class="major-cell" title="${esc(p.major || '')}">${esc(p.major || '')}</td>
      <td style="text-align:center"><label class="toggle" title="加入对比（最多 4 个）"><input type="checkbox" data-act="cmp" ${inCmp ? 'checked' : ''}></label></td>
    </tr>`;
  }).join('');

  /* 统计条：让「这一屏结果的成色」一眼可见，不用再去看筛选后的行数 */
  const withRatio = list.filter(p => p.ratio).map(p => +p.ratio);
  const avgRatio = withRatio.length
    ? Math.round(withRatio.reduce((a, b) => a + b, 0) / withRatio.length)
    : null;
  // 最低进面分只在「同口径」里取最小：山东是 100 分制笔试成绩、国考特殊专业职位是 100 分制折合分，
  // 混进 200 分制（浙江/国考普通职位）里取最小会得出「59.4 分很好考」的错误结论。
  const comparable = list
    .filter(p => p.entryScore != null && p.exam !== '山东省考' && !isFoldedScore(p))
    .map(p => +p.entryScore);
  const allScored = list.filter(p => p.entryScore != null).map(p => +p.entryScore);
  const minScore = comparable.length ? Math.min(...comparable) : (allScored.length ? Math.min(...allScored) : null);
  const totalQuota = list.reduce((a, p) => a + (Number(p.quota) || 0), 0);
  const setHtml = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  setHtml('stTotal', fmtNum(list.length));
  setHtml('stFin', fmtNum(list.filter(p => p.financeOk === true).length));
  setHtml('stScore', fmtNum(list.filter(p => p.entryScore != null).length));
  setHtml('stRatio', avgRatio == null ? '—' : `${fmtNum(avgRatio)}<small>: 1</small>`);
  setHtml('stMin', minScore == null ? '—' : `${minScore}<small>分</small>`);
  const stMinEl = document.getElementById('stMin');
  if (stMinEl) {
    stMinEl.parentElement.title = comparable.length
      ? '口径：仅统计 200 分制岗位（浙江省考、国考普通职位），不含山东 100 分制与国考折合分'
      : '当前结果中没有 200 分制进面分，退而取全部口径的最小值，跨省不可直接比较';
  }
  setHtml('stQuota', `${fmtNum(totalQuota)}<small>人</small>`);
  const tabCount = document.getElementById('tabCount');
  if (tabCount) tabCount.textContent = fmtNum(list.length);
}

/* ---------------- 导出 Excel ---------------- */
// 本地日期（旧版用 toISOString() 取的是 UTC，北京时间 00:00–08:00 会命名成前一天）
function localDateStr(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function exportExcel() {
  if (!lastFiltered.length) { alert('当前没有可导出的结果，请先查询'); return; }
  const rows = lastFiltered.map(p => ({
    '考试': p.exam, '年度': p.year, '招录机关': p.dept, '职位': p.position,
    '条目类型': isAggregate(p) ? '机关汇总（非具体职位）' : '真实职位',
    '地区': p.location || '', '招录人数': p.quota ?? '', '报名人数': p.applicants ?? '',
    '竞争比': p.ratio ? p.ratio + ':1' : '', '进面分': p.entryScore ?? '',
    '学历要求': p.education || '', '专业要求': p.major || '',
    '金融可报': p.financeOk === true ? '是' : p.financeOk === false ? '否' : '待核对',
    '政治面貌': p.political || '', '基层年限': p.baseYears || '',
    '备注': p.notes || '', '来源': p.source || ''
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 10 }, { wch: 6 }, { wch: 32 }, { wch: 22 }, { wch: 20 }, { wch: 14 }, { wch: 8 }, { wch: 9 }, { wch: 9 }, { wch: 7 }, { wch: 14 }, { wch: 30 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 30 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '岗位');
  XLSX.writeFile(wb, `考公岗位导出_${localDateStr()}.xlsx`);
}

/* ---------------- 详情弹窗 ---------------- */
function findKoubei(p) {
  const hay = (p.dept || '') + (p.position || '') + (p.major || '');
  return koubeiItems.filter(k => (k.match || []).some(kw => hay.includes(kw)));
}
function openDetail(uid) {
  const p = allPositions.find(x => x.uid === uid);
  if (!p) return;
  const rv = reviews[uid] || {};
  const ds = datasets.find(d => d.exam === p.exam && String(d.year) === String(p.year));
  const starPicks = [1, 2, 3, 4, 5].map(i =>
    `<span class="star-pick ${rv.rating >= i ? 'on' : ''}" data-star="${i}">★</span>`).join('');
  const kbs = findKoubei(p);
  const koubeiHtml = kbs.length ? `<div class="section">
      <b>🏛️ 口碑参考</b> <span class="muted" style="font-size:11px">（综合网络公开信息整理，主观仅供参考）</span>
      ${kbs.map(k => `<div class="koubei-item"><b>${esc(k.title)}</b>${k.source ? ` <a class="src" href="${esc(k.source)}" target="_blank">来源</a>` : ''}<div>${esc(k.body)}</div></div>`).join('')}
    </div>` : '';
  document.getElementById('modalBox').innerHTML = `
    <h3>${esc(p.dept)} — ${esc(p.position)}</h3>
    <div class="detail-grid">
      <span class="k">考试 / 年度</span><span class="v"><span class="tag">${esc(p.exam)}</span> ${esc(p.year)}</span>
      <span class="k">工作地区</span><span class="v">${esc(p.location || '未知')}</span>
      <span class="k">职位代码</span><span class="v">${esc(p.code || '未提供')}</span>
      <span class="k">招录人数</span><span class="v">${p.quota ?? '暂无公开数据'}</span>
      <span class="k">报名人数</span><span class="v">${p.applicants ?? '暂无公开数据（官方仅在报名期内公布实时数据）'}</span>
      <span class="k">竞争比</span><span class="v ${ratioClass(p.ratio)}">${p.ratio ? p.ratio + ' : 1' : '暂无数据'}</span>
      <span class="k">进面分数线</span><span class="v">${p.entryScore ?? (ds?.entryScoreSummary ? '可参考：' + esc(ds.entryScoreSummary) : '暂无公开数据')}</span>
      <span class="k">学历要求</span><span class="v">${esc(p.education || '未公布')}</span>
      <span class="k">专业要求</span><span class="v">${esc(p.major || '未公布')}</span>
      <span class="k">金融本科可报</span><span class="v">${p.financeOk === true ? '<span class="tag">✔ 可报</span>' : p.financeOk === false ? '<span class="tag warn">✘ 不符合</span>' : '需核对专业目录'}</span>
      <span class="k">政治面貌</span><span class="v">${esc(p.political || '不限')}</span>
      <span class="k">基层年限</span><span class="v">${esc(p.baseYears || '不限')}</span>
      <span class="k">备注</span><span class="v">${esc(p.notes || '—')}</span>
      <span class="k">数据来源</span><span class="v">${p.source ? `<a href="${esc(p.source)}" target="_blank">${esc(p.source)}</a>` : '内置整理'}</span>
    </div>
    ${koubeiHtml}
    <div class="section">
      <b>📝 我的评价</b>（仅保存在本机）
      <div style="margin:8px 0 6px">${starPicks}</div>
      <textarea id="rvText" placeholder="记录你的调研信息：工作强度、待遇口碑、晋升、离家远近…">${esc(rv.text || '')}</textarea>
      <div class="close-bar">
        <button class="btn" data-act="saveRv">保存评价</button>
        <button class="btn" data-act="toggleFav">${favorites.includes(uid) ? '取消收藏' : '★ 加入收藏'}</button>
        <button class="btn primary" data-act="closeModal">关闭</button>
      </div>
    </div>`;
  const box = document.getElementById('modalBox');
  box.querySelectorAll('.star-pick').forEach(el => el.onclick = () => {
    const n = +el.dataset.star;
    box.querySelectorAll('.star-pick').forEach(s => s.classList.toggle('on', +s.dataset.star <= n));
    box.dataset.rating = n;
  });
  box.dataset.rating = rv.rating || 0;
  document.getElementById('modalMask').classList.remove('hidden');
  box.dataset.uid = uid;
}

function closeModal() { document.getElementById('modalMask').classList.add('hidden'); }

// 关闭前检查评价是否已保存：旧版点遮罩 / 按 Esc 会静默丢掉刚写的文字
function tryCloseModal() {
  const box = document.getElementById('modalBox');
  const ta = document.getElementById('rvText');
  if (ta) {
    const typed = ta.value;
    const saved = (reviews[box.dataset.uid] || {}).text || '';
    if (typed !== saved && !confirm('评价还没保存，确定关闭吗？\n（点「取消」可返回弹窗，再点「保存评价」）')) return;
  }
  closeModal();
}

/* 列头排序指示：把当前排序状态同步到表头（▲/▼） */
const SORT_HEADERS = {
  ratioAsc: ['ratio', 'asc'], ratioDesc: ['ratio', 'desc'],
  scoreAsc: ['entryScore', 'asc'], scoreDesc: ['entryScore', 'desc'],
  quotaDesc: ['quota', 'desc'], quotaAsc: ['quota', 'asc'],
  applicantsDesc: ['applicants', 'desc'], applicantsAsc: ['applicants', 'asc']
};
// 点击某列时默认采用的方向
const COL_SORT_DEFAULT = { ratio: 'ratioAsc', entryScore: 'scoreAsc', quota: 'quotaDesc', applicants: 'applicantsDesc' };
// 同一列再点一次则反向
const SORT_FLIP = {
  ratioAsc: 'ratioDesc', ratioDesc: 'ratioAsc',
  scoreAsc: 'scoreDesc', scoreDesc: 'scoreAsc',
  quotaDesc: 'quotaAsc', quotaAsc: 'quotaDesc',
  applicantsDesc: 'applicantsAsc', applicantsAsc: 'applicantsDesc'
};
function syncSortHeaders() {
  const cur = SORT_HEADERS[document.getElementById('fSort').value] || null;
  document.querySelectorAll('#resultTable thead th[data-sort]').forEach(th => {
    if (!th.dataset.label) th.dataset.label = th.textContent.replace(/[▲▼]\s*$/, '').trim();
    const on = !!(cur && th.dataset.sort === cur[0]);
    th.classList.toggle('sorted', on);
    th.innerHTML = on
      ? `${esc(th.dataset.label)} <span class="sort-arrow">${cur[1] === 'asc' ? '▲' : '▼'}</span>`
      : esc(th.dataset.label);
  });
}

/* ---------------- 竞争度分析 ---------------- */
function renderAnalysis() {
  const cards = datasets.filter(d => !d._custom && (d.positions || []).length > 0).map(d => {
    const o = d.overallStats || {};
    const posCount = (d.positions || []).length;
    const finCount = (d.positions || []).filter(p => p.financeOk).length;
    return `<div class="stat-card">
      <div class="name">${esc(d.exam)}<span class="year">${esc(d.year)}年度</span></div>
      <div class="big ${o.avgRatio ? '' : 'na'}">${o.avgRatio ? esc(o.avgRatio) + ' : 1' : '不公布'}</div>
      <div class="sub">
        ${o.totalQuota ? `计划招录 <b>${esc(o.totalQuota)}</b> 人<br>` : ''}
        ${o.totalApplicants ? `报名 <b>${esc(o.totalApplicants)}</b> 人<br>` : ''}
        ${o.totalPositions ? `职位 <b>${esc(o.totalPositions)}</b> 个<br>` : ''}
        本库收录岗位 ${posCount} 个，其中金融可报 ${finCount} 个
      </div>
    </div>`;
  }).join('');
  document.getElementById('examStatCards').innerHTML = cards;

  const withRatio = allPositions.filter(p => p.ratio).map(p => ({ ...p, r: +p.ratio }));
  withRatio.sort((a, b) => b.r - a.r);
  document.getElementById('ratioChart').innerHTML = barChart(withRatio.slice(0, 15), true);
  const easy = [...withRatio].sort((a, b) => a.r - b.r);
  document.getElementById('easyChart').innerHTML = barChart(easy.slice(0, 10), false);

  const totalFin = allPositions.filter(p => p.financeOk).length;
  document.getElementById('insights').innerHTML = `
    <p>1. <b>税务系统是金融专业主战场</b>：国考岗位中约 60% 以上来自税务系统，专业要求集中在经济学类、金融学类、财政学类，本科可报岗位多。</p>
    <p>2. <b>竞争度参考</b>：2026 国考平均竞争比约 ${esc(datasets.find(d => d.exam === '国考')?.overallStats?.avgRatio ?? '98')} : 1；浙江省考约 51 : 1、山东省考约 48 : 1。经济发达地区（杭州、宁波、济南、青岛、上海市区）岗位普遍更高。</p>
    <p>3. <b>金融专业的差异化优势</b>：人民银行、金融监管总局（原银保监）系统需加考专业课，金融本科有天然优势，竞争比常低于同层级纯行测申论岗位。</p>
    <p>4. <b>现在怎么做（大四上）</b>：2027 国考已于 2026-10-13 发榜、11 月 29 日笔试，但你（2028 届）尚不能报——应届身份一般要求毕业当年。这一轮的价值是<b>实战演练</b>：用本工具跟着走一遍选岗→盯报名数据→估算竞争比；真正报考在 <b>2027 年 10 月启动的 2028 年度考试</b>，届时以应届生身份可报岗位更多、限制更少。</p>
    <p>5. 本库共收录 ${allPositions.length} 个岗位，金融可报 ${totalFin} 个；具体岗位报名人数以官方报名系统实时数据为准。</p>`;
}

function barChart(items, hot) {
  if (!items.length) return '<div class="muted">暂无岗位级报名数据（报名人数仅在官方报名系统公布）。</div>';
  const max = Math.max(...items.map(x => x.r), 1);
  return items.map(x => `<div class="chart-row">
    <div class="label" title="${esc(x.exam)}｜${esc(x.dept)}｜${esc(x.position)}">[${esc(x.exam)}] ${esc(x.dept)}·${esc(x.position)}</div>
    <div><div class="chart-bar ${hot && x.r >= 100 ? 'hot' : ''}" style="width:${Math.max(x.r / max * 100, 1.5)}%"></div></div>
    <div class="val ${ratioClass(x.r)}">${x.r} : 1</div>
  </div>`).join('');
}

/* ---------------- 对比与收藏 ---------------- */
function renderFavs() {
  const wrap = document.getElementById('favList');
  const list = allPositions.filter(p => favorites.includes(p.uid));
  if (!list.length) { wrap.innerHTML = '<div class="muted">还没有收藏。在「岗位查询」结果中点击 ★ 收藏感兴趣的岗位。</div>'; return; }
  wrap.innerHTML = list.map(p => `<div class="fav-item">
    <span class="fav-star on" data-act="fav" data-uid="${esc(p.uid)}">★</span>
    <div class="info">${p.source ? `<a class="srclink" href="${esc(p.source)}" target="_blank"><b>${esc(p.dept)}</b></a>` : `<b>${esc(p.dept)}</b>`} · ${esc(p.position)} <span class="tag">${esc(p.exam)}</span><span class="tag gray">${esc(p.location || '')}</span></div>
    <span>招录 ${p.quota ?? '-'}${p.ratio ? ` ｜ 竞争比 ${p.ratio}:1` : ''}</span>
    <button class="btn small" data-act="open" data-uid="${esc(p.uid)}">详情</button>
  </div>`).join('');
}

function renderCompare() {
  const wrap = document.getElementById('compareWrap');
  const list = allPositions.filter(p => compareList.includes(p.uid));
  if (list.length < 1) { wrap.innerHTML = '<div class="muted" style="margin-top:12px">尚未选择岗位。到「岗位查询」勾选"对比"后回来生成对比表。</div>'; return; }
  const rows = [
    ['考试', p => `${p.exam} ${p.year}`],
    ['地区', p => p.location || '—'],
    ['招录人数', p => p.quota ?? '—'],
    ['报名人数', p => p.applicants ?? '未公布'],
    ['竞争比', p => p.ratio ? p.ratio + ' : 1' : '—'],
    ['进面分', p => p.entryScore ?? '—'],
    ['学历', p => p.education || '—'],
    ['专业要求', p => p.major || '—'],
    ['金融可报', p => p.financeOk === true ? '✔' : p.financeOk === false ? '✘' : '待核对'],
    ['政治面貌', p => p.political || '不限'],
    ['基层年限', p => p.baseYears || '不限'],
    ['备注', p => p.notes || '—']
  ];
  wrap.innerHTML = `<table class="compare-table"><thead><tr><th>对比项</th>${list.map(p => `<th>${esc(p.dept)}<br><small>${esc(p.position)}</small></th>`).join('')}</tr></thead>
    <tbody>${rows.map(([label, get]) => `<tr><th>${label}</th>${list.map(p => `<td>${esc(get(p))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderReviews() {
  const wrap = document.getElementById('reviewList');
  const entries = Object.entries(reviews);
  if (!entries.length) { wrap.innerHTML = '<div class="muted">暂无评价。打开岗位详情即可打分留言。</div>'; return; }
  wrap.innerHTML = entries.map(([uid, rv]) => {
    const p = allPositions.find(x => x.uid === uid);
    const name = p ? `${esc(p.dept)} · ${esc(p.position)}` : esc(uid);
    return `<div class="review-item">
      <div class="head"><b>${name}</b><span class="stars">${'★'.repeat(rv.rating || 0)}${'☆'.repeat(5 - (rv.rating || 0))}</span>
        <button class="btn small danger del" data-act="delRv" data-uid="${esc(uid)}">删除</button></div>
      <div class="txt">${esc(rv.text || '')}</div>
    </div>`;
  }).join('');
}

/* ---------------- 备考辅助 ---------------- */
function renderPrep() {
  const events = [];
  datasets.forEach(d => (d.timeline || []).forEach(t => {
    const [s, e] = parseRange(t.date);
    events.push({ ...t, exam: d.exam, start: s, end: e });
  }));
  const now = new Date();
  const upcoming = events.filter(t => t.end ? t.end >= now : t.start >= now)
    .sort((a, b) => (a.start || a.end) - (b.start || b.end));
  const past = events.filter(t => !(t.end ? t.end >= now : t.start >= now))
    .sort((a, b) => (b.start || b.end) - (a.start || a.end));
  const renderTl = (arr, markNext) => arr.map((t, i) => {
    let count = '';
    if (markNext && i === 0 && t.start) {
      const days = Math.ceil((t.start - now) / 86400000);
      if (days > 0) count = `<span class="count">（还有 ${days} 天）</span>`;
    }
    return `<div class="tl-item ${markNext && i === 0 ? 'next' : ''}">
      <span class="date">${esc(t.date)}</span>
      <span><span class="stage">【${esc(t.exam)}】</span>${esc(t.stage)} ${count}</span>
      ${t.source ? `<a class="src" href="${esc(t.source)}" target="_blank">来源</a>` : ''}
    </div>`;
  }).join('');
  document.getElementById('timeline').innerHTML =
    (upcoming.length ? `<h3 style="margin-bottom:8px">即将到来</h3>` + renderTl(upcoming, true) : '<div class="muted">暂无未来节点数据，可到「数据管理」导入更新。</div>') +
    `<h3 style="margin:16px 0 8px">已过去（本考季）</h3>` + renderTl(past.slice(0, 12), false) +
    (past.length > 12 ? `<div class="muted" style="margin-top:8px">仅显示最近 12 个已过节点（共 ${past.length} 个）。</div>` : '');

  document.getElementById('examStructureCards').innerHTML = datasets.filter(d => !d._custom).map(d => {
    let extra = '';
    if (d.specialRule) extra += `<br><b>特殊规则：</b>${esc(d.specialRule)}`;
    if (d.hukouPolicy) extra += `<br><b>户籍政策：</b>${esc(d.hukouPolicy)}`;
    if (d.entryScoreSummary) extra += `<br><b>进面分数：</b>${esc(d.entryScoreSummary)}`;
    return `<div class="stat-card"><div class="name">${esc(d.exam)}<span class="year">${esc(d.year)}</span></div>
      <div class="sub" style="margin-top:8px">${esc(d.examStructure || '')}${extra}</div></div>`;
  }).join('');

  renderTasks();

  document.getElementById('advice').innerHTML = `
    <p class="muted">以下建议为内置整理文本${dataUpdatedAt ? `，数据整理于 ${esc(localDateStr(dataUpdatedAt))}` : ''}；具体时间以当年官方公告为准。</p>
    <p><b>战线规划</b>：你已是大四上学期，真正的主战场是 <b>2028 年度考试</b>（2027 年 10 月起陆续启动）——<b>2028 国考</b>（预计 2027 年 10 月中旬报名、11 月底笔试）、<b>2028 浙江省考/山东省考</b>（预计 2027 年 11-12 月报名、12 月-1 月笔试）、<b>2028 上海市考</b>（预计 2027 年 11 月报名、12 月笔试，先笔试后报岗）。三者笔试高度同源（行测+申论），一套复习可以三线通吃。眼下正在进行的 2027 年度考试（国考 2026-11-29 笔试、浙鲁沪省考 2026 年 12 月笔试）你报不了，但应全程观察作为预演。</p>
    <p><b>科目优先级</b>：行测中资料分析和判断推理提分最快，优先突破；数量关系可战略性放弃一部分。申论重在小题踩点，大作文积累人民日报评论员的论证结构。若目标人民银行/金融监管总局系统，加练金融专业课（宏微观、货币银行学、监管常识）。</p>
    <p><b>身份红利</b>：应届生身份是考公最大红利，大量岗位仅限应届。注意别轻易签三方/社保，多数省份认定应届以是否缴纳社保为准（上海等地对应届认定更严格，报名前查当年公告）。</p>
    <p><b>多线报考</b>：浙江、山东、上海、国考的笔试时间彼此错开，只要时间不冲突可以都报，增加上岸概率；但上海是先笔试后报岗，要过了笔试合格线才有志愿环节。</p>`;
}

function renderTasks() {
  const ul = document.getElementById('taskList');
  ul.innerHTML = tasks.map(t => `<li class="${t.done ? 'done' : ''}">
    <input type="checkbox" ${t.done ? 'checked' : ''} data-act="task" data-id="${t.id}">
    <span class="txt">${esc(t.txt)}</span>
    <span class="del" data-act="delTask" data-id="${t.id}">✕</span>
  </li>`).join('');
}

/* ---------------- 数据管理 ---------------- */
function renderDataSummary() {
  const cov = (arr, f) => {
    const n = arr.filter(f).length;
    return arr.length ? Math.round(n / arr.length * 100) + '%' : '—';
  };
  const total = allPositions.length;
  const aggN = allPositions.filter(isAggregate).length;
  const finN = allPositions.filter(p => p.financeOk === true).length;
  const finNull = allPositions.filter(p => p.financeOk == null).length;
  const pct = n => total ? Math.round(n / total * 100) + '%' : '—';

  // 顶部口径总览：把「真实职位 vs 机关汇总」摊开说清楚，避免误以为全部可投
  const overview = `
    <div class="data-overview">
      <div class="ov-item"><span class="ov-num">${total}</span><span class="ov-lab">收录条目</span></div>
      <div class="ov-item"><span class="ov-num ok">${total - aggN}</span><span class="ov-lab">真实职位</span></div>
      <div class="ov-item"><span class="ov-num warn">${aggN}</span><span class="ov-lab">机关汇总<br><small>非具体职位</small></span></div>
      <div class="ov-item"><span class="ov-num">${finN}</span><span class="ov-lab">金融可报</span></div>
      <div class="ov-item"><span class="ov-num muted-num">${finNull}</span><span class="ov-lab">待核对</span></div>
      <div class="ov-item"><span class="ov-num muted-num">${dataUpdatedAt ? esc(localDateStr(dataUpdatedAt)) : '—'}</span><span class="ov-lab">数据整理日期</span></div>
    </div>
    <p class="muted" style="margin-top:10px">
      <b>机关汇总</b>条目是「该机关共招 N 岗 M 人」的机关级推断，<b>不是可以直接投递的具体职位</b>，仅用于判断某地某系统是否招金融专业；
      需要具体职位请以官方职位表为准。全库字段完整度：招录人数 ${pct(allPositions.filter(p => p.quota != null).length)} ·
      报名人数 ${pct(allPositions.filter(p => p.applicants != null).length)} ·
      进面分 ${pct(allPositions.filter(p => p.entryScore != null).length)} ·
      职位代码 ${pct(allPositions.filter(p => p.code != null).length)}。
    </p>`;

  // 加载问题：文件缺失（待补）与解析失败（必须处理）分开呈现
  const issuesHtml = loadIssues.length ? `
    <div class="issue-box">
      <b>⚠️ 数据文件状态</b>
      <ul class="note-list" style="margin-top:6px">
        ${loadIssues.map(x => `<li><b>${esc(x.file)}</b> — ${x.type === 'error' ? '<span class="ratio-hot">解析失败</span>' : '未创建'}：${esc(x.msg)}${x.type === 'error' ? '，该文件内的岗位<b>当前不可见</b>' : ''}</li>`).join('')}
      </ul>
    </div>` : '';

  let cityHtml = '';
  for (const d of datasets.filter(x => x.cityStats && x.cityStats.length)) {
    cityHtml += `<div class="card" style="box-shadow:none;border:1px solid var(--border);margin-top:10px">
      <b>${esc(d.exam)} 各地市招录概况</b>（职位库口径，点城市名看来源）
      <table class="compare-table" style="margin-top:8px"><thead><tr><th>地市</th><th>职位数</th><th>招录人数</th></tr></thead><tbody>
      ${d.cityStats.map(c => `<tr><td>${esc(c.city)}</td><td>${esc(c.positions)}</td><td>${esc(c.quota)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  document.getElementById('dataSummary').innerHTML = `${overview}${issuesHtml}
    <table class="compare-table" style="margin-top:12px"><thead><tr><th>数据集</th><th>年度</th><th>条目数</th><th>真实职位</th><th>机关汇总</th><th>金融可报</th><th>招录数完整</th><th>报名数完整</th><th>进面分完整</th><th>类型</th></tr></thead><tbody>
    ${datasets.map(d => {
    const pos = d.positions || [];
    const a = pos.filter(isAggregate).length;
    return `<tr><td>${esc(d.exam)}</td><td>${esc(d.year)}</td><td>${pos.length}</td>
      <td>${pos.length - a}</td><td>${a}</td>
      <td>${pos.filter(p => p.financeOk).length}</td>
      <td>${cov(pos, p => p.quota != null)}</td>
      <td>${cov(pos, p => p.applicants != null)}</td>
      <td>${cov(pos, p => p.entryScore != null)}</td>
      <td>${d._custom ? '导入' : '内置'}</td></tr>`;
  }).join('')}
  </tbody></table>${cityHtml}`;
}

/* ---------------- 节点提醒 ---------------- */
function checkReminders() {
  const parts = [];

  // 数据文件加载失败必须优先告知：否则岗位会凭空消失且用户毫无察觉
  const hardErrors = loadIssues.filter(x => x.type === 'error');
  if (hardErrors.length) {
    parts.push(`<span class="banner-error">⚠️ <b>数据文件加载失败</b>：${hardErrors.map(x => esc(x.file) + '（' + esc(x.msg) + '）').join('；')} —— 该文件内的岗位已缺失，请检查 JSON 格式。</span>`);
  }

  const events = [];
  datasets.forEach(d => (d.timeline || []).forEach(t => {
    const [s, e] = parseRange(t.date);
    events.push({ ...t, exam: d.exam, start: s, end: e });
  }));
  const now = new Date();
  const soon = events.filter(t => {
    const d0 = t.start || t.end;
    if (!d0) return false;
    const days = Math.ceil((d0 - now) / 86400000);
    return days >= 0 && days <= 14;
  }).sort((a, b) => (a.start || a.end) - (b.start || b.end));

  const dismissedToday = loadLS(LS.banner, '') === localDateStr();
  const lines = (dismissedToday ? [] : soon).map(t => {
    const days = Math.ceil(((t.start || t.end) - now) / 86400000);
    return `【${t.exam}】${t.stage}：${days === 0 ? '今天' : days + ' 天后'}（${t.date}）`;
  });
  if (lines.length) parts.push(`⏰ <b>临近节点提醒</b>：${lines.map(esc).join('　｜　')}`);

  if (!parts.length) return;
  const banner = document.getElementById('reminderBanner');
  banner.innerHTML = `<div class="banner-inner">${parts.join('<br>')}<span class="banner-close" data-act="closeBanner" title="关闭（今天不再显示）">✕</span></div>`;
  banner.classList.remove('hidden');

  if (lines.length) {
    try { new Notification('考公助手 · 节点提醒', { body: lines.join('\n'), silent: false }); } catch (e) { /* 通知失败不影响使用 */ }
  }
}

/* ---------------- Excel 导入 ---------------- */
function autoMapColumns(headers) {
  const defs = [
    ['dept', ['招录机关', '用人单位', '部门名称', '招考单位', '单位', '部门', '用人司局']],
    ['position', ['职位名称', '职位', '岗位名称', '岗位', '招考职位']],
    ['code', ['职位代码', '职位编码', '代码', '岗位代码']],
    ['location', ['工作地点', '工作地区', '地区', '地点', '所属地市', '地市']],
    ['quota', ['招录人数', '招考人数', '计划人数', '人数', '招聘人数']],
    ['applicants', ['报名人数', '过审人数', '审查通过人数', '缴费人数']],
    ['entryScore', ['进面分数', '最低进面分数', '进面分数线', '分数线']],
    ['education', ['学历', '学历要求', '文化程度']],
    ['major', ['专业', '专业要求', '所学专业']],
    ['political', ['政治面貌', '政治面貌要求']],
    ['baseYears', ['基层工作年限', '基层工作经历', '基层年限', '服务基层']],
    ['notes', ['备注', '其他条件', '其他要求', '职位简介']]
  ];
  const mapping = {};
  defs.forEach(([field, keys]) => {
    let hit = headers.findIndex(h => keys.some(k => String(h).includes(k)));
    if (hit >= 0) mapping[field] = hit;
  });
  return mapping;
}

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (!rows.length) throw new Error('表格为空');
      let headerIdx = 0, best = -1;
      rows.slice(0, 5).forEach((r, i) => {
        const score = r.filter(c => String(c).trim()).length + (/职位|部门|单位/.test(r.join()) ? 10 : 0);
        if (score > best) { best = score; headerIdx = i; }
      });
      const headers = rows[headerIdx].map(h => String(h).trim());
      const dataRows = rows.slice(headerIdx + 1).filter(r => r.some(c => String(c).trim()));
      const mapping = autoMapColumns(headers);
      importParsed = { headers, dataRows, mapping, fileName: file.name };
      renderImportPreview();
    } catch (err) {
      alert('解析失败：' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function renderImportPreview() {
  const { headers, dataRows, mapping, fileName } = importParsed;
  const fieldNames = { dept: '招录机关*', position: '职位名称*', code: '职位代码', location: '工作地区', quota: '招录人数*', applicants: '报名人数', entryScore: '进面分', education: '学历要求', major: '专业要求', political: '政治面貌', baseYears: '基层年限', notes: '备注' };
  const options = ['<option value="">— 不导入 —</option>'].concat(headers.map((h, i) => `<option value="${i}">${esc(h)}</option>`)).join('');
  document.getElementById('importPreview').innerHTML = `
    <p style="margin-top:10px">文件 <b>${esc(fileName)}</b>：共 ${dataRows.length} 行数据，请确认列映射（* 为建议必选）：</p>
    <div class="map-grid">${Object.entries(fieldNames).map(([f, name]) => `
      <div class="map-item"><span>${name}</span>
        <select data-field="${f}">${options}</select>
      </div>`).join('')}
    </div>
    <button class="btn primary" id="btnConfirmImport">确认导入 ${dataRows.length} 行</button>
    <div class="preview-box" style="margin-top:12px"><table><thead><tr>${headers.slice(0, 12).map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${dataRows.slice(0, 8).map(r => `<tr>${r.slice(0, 12).map(c => `<td>${esc(String(c).slice(0, 40))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  document.querySelectorAll('#importPreview select[data-field]').forEach(sel => {
    if (mapping[sel.dataset.field] != null) sel.value = mapping[sel.dataset.field];
  });
  document.getElementById('btnConfirmImport').onclick = confirmImport;
}

function confirmImport() {
  const { dataRows, fileName } = importParsed;
  const mapping = {};
  document.querySelectorAll('#importPreview select[data-field]').forEach(sel => {
    if (sel.value !== '') mapping[sel.dataset.field] = +sel.value;
  });
  if (mapping.dept == null && mapping.position == null) { alert('至少需要映射"招录机关"或"职位名称"列'); return; }
  const positions = dataRows.map(r => {
    const g = f => mapping[f] != null ? String(r[mapping[f]] ?? '').trim() : '';
    const num = s => { const n = parseFloat(s); return isNaN(n) ? null : n; };
    return {
      code: g('code') || null,
      dept: g('dept') || g('position') || '未标注单位',
      position: g('position') || '（导入岗位）',
      location: g('location') || null,
      quota: num(g('quota')),
      applicants: num(g('applicants')),
      entryScore: num(g('entryScore')),
      education: g('education') || null,
      major: g('major') || null,
      political: g('political') || null,
      baseYears: g('baseYears') || null,
      notes: g('notes') || null,
      financeOk: g('major') ? /金融|经济|财政|税务|不限/.test(g('major')) : null,
      source: `本地导入：${fileName}`
    };
  });
  const existing = (() => { try { return JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')); } catch { return null; } })();
  const custom = existing || { exam: '自定义导入', year: new Date().getFullYear(), positions: [] };
  custom.positions = positions;
  fs.writeFileSync(CUSTOM_FILE, JSON.stringify(custom, null, 2), 'utf8');
  alert(`已导入 ${positions.length} 个岗位（覆盖之前的导入数据）`);
  loadBuiltins();
  bootstrap(false);
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  document.getElementById('tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === btn));
    document.querySelectorAll('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    // 切页时刷新该页数据，避免显示上一次的陈旧内容
    const tab = btn.dataset.tab;
    if (tab === 'prep') renderPrep();
    else if (tab === 'analysis') renderAnalysis();
    else if (tab === 'compare') { renderFavs(); renderCompare(); renderReviews(); }
    else if (tab === 'data') renderDataSummary();
  });

  document.getElementById('btnMatch').onclick = renderResults;
  document.getElementById('btnExport').onclick = exportExcel;
  document.querySelectorAll('.filter-card input, .filter-card select').forEach(el => {
    el.addEventListener('change', () => { syncSortHeaders(); renderResults(); });
    if (el.type === 'text') el.addEventListener('keydown', ev => { if (ev.key === 'Enter') renderResults(); });
  });
  document.getElementById('btnReset').onclick = () => {
    applyFilterDefaults();
    renderResults();
  };

  // 列头点击排序（与下拉框双向同步）：首次点某列用该列的默认方向，再点一次反向
  document.querySelector('#resultTable thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const col = th.dataset.sort;
    const cur = document.getElementById('fSort').value;
    const isThisCol = (SORT_HEADERS[cur] || [])[0] === col;
    document.getElementById('fSort').value = isThisCol
      ? (SORT_FLIP[cur] || cur)
      : (COL_SORT_DEFAULT[col] || 'default');
    syncSortHeaders();
    renderResults();
  });

  // Esc 关闭详情弹窗（并拦住未保存的评价）
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const mask = document.getElementById('modalMask');
    if (!mask.classList.contains('hidden')) tryCloseModal();
  });

  // 结果表：来源链接 / 收藏 / 对比 / 详情
  document.getElementById('resultBody').addEventListener('click', e => {
    if (e.target.closest('a')) return; // 名称链接交给系统浏览器（main 进程已配置 openExternal）
    const tr = e.target.closest('tr');
    if (!tr) return;
    const uid = tr.dataset.uid;
    const cbWrap = e.target.closest('label.toggle');
    const cb = cbWrap ? cbWrap.querySelector('input[data-act="cmp"]') : null;
    if (cb && e.target !== cb) { cb.checked = !cb.checked; }
    const box = cb || (e.target.matches('input[data-act="cmp"]') ? e.target : null);
    if (box) {
      const ok = toggleCompare(uid, box.checked);
      if (!ok) box.checked = false;
      return;
    }
    const act = e.target.dataset.act || e.target.closest('[data-act]')?.dataset.act;
    if (act === 'fav') { toggleFav(uid); }
    else if (!act) { openDetail(uid); }
  });

  document.getElementById('modalMask').addEventListener('click', e => {
    if (e.target.closest('a')) return;
    const box = document.getElementById('modalBox');
    if (e.target === e.currentTarget) return tryCloseModal();
    const act = e.target.dataset.act;
    if (act === 'closeModal') closeModal();
    else if (act === 'toggleFav') { toggleFav(box.dataset.uid); openDetail(box.dataset.uid); renderResults(); }
    else if (act === 'saveRv') {
      reviews[box.dataset.uid] = { rating: +box.dataset.rating || 0, text: document.getElementById('rvText').value, time: new Date().toLocaleString('zh-CN') };
      saveLS(LS.review, reviews);
      alert('评价已保存');
    }
  });

  document.getElementById('favList').parentElement.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    const act = e.target.dataset.act;
    const uid = e.target.dataset.uid;
    if (act === 'fav') toggleFav(uid);
    if (act === 'open') openDetail(uid);
  });
  document.getElementById('btnCompare').onclick = () => { renderCompare(); };
  document.getElementById('btnClearCompare').onclick = () => { compareList = []; saveLS(LS.compare, compareList); renderResults(); renderCompare(); };

  // 提醒横幅可关闭（记住当天已关闭，避免每次启动都弹；节点提醒通知不受影响）
  document.getElementById('reminderBanner').addEventListener('click', e => {
    if (!e.target.closest('[data-act="closeBanner"]')) return;
    saveLS(LS.banner, localDateStr());
    document.getElementById('reminderBanner').classList.add('hidden');
  });
  document.getElementById('reviewList').addEventListener('click', e => {
    if (e.target.dataset.act === 'delRv') {
      delete reviews[e.target.dataset.uid];
      saveLS(LS.review, reviews);
      renderReviews();
    }
  });

  document.getElementById('btnAddTask').onclick = addTask;
  document.getElementById('newTask').addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });
  document.getElementById('taskList').addEventListener('click', e => {
    const id = +(e.target.dataset.id || 0);
    if (e.target.dataset.act === 'task') {
      tasks = tasks.map(t => t.id === id ? { ...t, done: e.target.checked } : t);
      saveLS(LS.task, tasks);
      renderTasks();
    } else if (e.target.dataset.act === 'delTask') {
      tasks = tasks.filter(t => t.id !== id);
      saveLS(LS.task, tasks);
      renderTasks();
    }
  });

  document.getElementById('btnImport').onclick = () => document.getElementById('importFile').click();

  // 深色 / 浅色切换：写入 localStorage，下次启动由 index.html 头部脚本先行应用（无闪白）
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    const syncLabel = () => {
      themeToggle.textContent = document.documentElement.dataset.theme === 'dark' ? '浅色模式' : '深色模式';
    };
    syncLabel();
    themeToggle.onclick = () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('gk_theme', next); } catch (e) { /* 忽略 */ }
      syncLabel();
    };
  }

  // 「检查官方数据更新」：主进程拉国考专题文章，命中报名统计则写回 guokao2027.json
  const btnCheck = document.getElementById('btnCheckUpdate');
  if (btnCheck) btnCheck.onclick = async () => {
    btnCheck.disabled = true;
    const old = btnCheck.textContent;
    btnCheck.textContent = '检查中…';
    try {
      const r = await ipcRenderer.invoke('gk:check-update');
      if (r && r.updated) {
        loadBuiltins();
        bootstrap(false);
        alert('官方数据已更新：\n' + r.msg);
      } else {
        alert((r && r.msg) || '官方暂无新数据');
      }
    } catch (e) {
      alert('检查失败（网络原因），稍后再试');
    }
    btnCheck.disabled = false;
    btnCheck.textContent = old;
  };

  // 启动后自动检查命中时（main.js 主动推送）：重载数据 + 横幅提示
  ipcRenderer.on('gk-data-updated', (e, msg) => {
    loadBuiltins();
    bootstrap(false);
    const banner = document.getElementById('reminderBanner');
    if (banner) {
      banner.innerHTML = `<div class="banner-inner">✅ 官方数据已自动更新：${esc(msg)}<span class="banner-close" onclick="this.closest('.reminder-banner').classList.add('hidden')">✕</span></div>`;
      banner.classList.remove('hidden');
    }
  });
  document.getElementById('importFile').addEventListener('change', e => {
    if (e.target.files[0]) handleImportFile(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('btnClearImport').onclick = () => {
    if (!fs.existsSync(CUSTOM_FILE)) { alert('当前没有导入数据'); return; }
    if (confirm('确定清除所有导入数据？')) {
      fs.unlinkSync(CUSTOM_FILE);
      loadBuiltins();
      bootstrap(false);
      alert('已清除');
    }
  };
}

function addTask() {
  const input = document.getElementById('newTask');
  const txt = input.value.trim();
  if (!txt) return;
  tasks.push({ id: Date.now(), txt, done: false });
  saveLS(LS.task, tasks);
  input.value = '';
  renderTasks();
}

function toggleFav(uid) {
  const i = favorites.indexOf(uid);
  if (i >= 0) favorites.splice(i, 1); else favorites.push(uid);
  saveLS(LS.fav, favorites);
  renderResults();
  renderFavs();
  updateShell();
}
function toggleCompare(uid, on) {
  if (on) { if (!compareList.includes(uid)) { if (compareList.length >= 4) { alert('最多同时对比 4 个岗位'); return false; } compareList.push(uid); } }
  else compareList = compareList.filter(x => x !== uid);
  saveLS(LS.compare, compareList);
  return true;
}

/* ---------------- 启动 ---------------- */
// 侧栏「数据快照」与页头统计：只依赖已加载完的全局状态，随数据集变化刷新
function updateShell() {
  const builtin = datasets.filter(d => !d._custom);
  // 按考试名称去重（国考 2026 与 2027 是两个数据集，但对用户只是「一类考试」），
  // 且排除尚无职位的空数据集（如刚接入、职位表未发布的国考 2027）
  const examNames = [...new Set(builtin.filter(d => (d.positions || []).length > 0).map(d => d.exam))];
  const snapDate = document.getElementById('snapDate');
  if (snapDate) snapDate.textContent = dataUpdatedAt ? localDateStr(dataUpdatedAt) : '—';
  const snapCount = document.getElementById('snapCount');
  if (snapCount) snapCount.textContent = `${fmtNum(allPositions.length)} 个职位 · ${examNames.length} 类考试`;
  const hExam = document.getElementById('hExamCount');
  if (hExam) hExam.textContent = examNames.length;
  const hCov = document.getElementById('hCoverage');
  if (hCov) {
    hCov.textContent = allPositions.length
      ? Math.round(allPositions.filter(p => p.source).length / allPositions.length * 100) + '%'
      : '—';
  }
  // 数据来源数 = 去重后的来源域名数（比"文件数"更能反映真实来源广度）
  const hSrc = document.getElementById('hSourceCount');
  if (hSrc) {
    const hosts = new Set();
    allPositions.forEach(p => {
      if (!p.source) return;
      try { hosts.add(new URL(p.source).hostname); } catch (e) { /* 非法 URL 忽略 */ }
    });
    hSrc.textContent = hosts.size || '—';
  }
  const favCount = document.getElementById('tabFavCount');
  if (favCount) {
    favCount.textContent = favorites.length;
    favCount.classList.toggle('hidden', favorites.length === 0);   // 收藏为 0 时不显示角标
  }
}

function bootstrap(first) {
  loadBuiltins();
  fillRegionSelect();
  if (first) applyFilterDefaults();   // 启动与「重置条件」共用同一套默认值
  syncSortHeaders();
  renderResults();
  renderAnalysis();
  renderFavs();
  renderCompare();
  renderReviews();
  renderPrep();
  renderDataSummary();
  updateShell();
  if (first) {
    bindEvents();
    checkReminders();
  }
}

document.addEventListener('DOMContentLoaded', () => bootstrap(true));
