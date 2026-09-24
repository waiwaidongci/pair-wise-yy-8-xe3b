import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-pulp-fermentation.json");
const port = Number(process.env.PORT || 3039);
const seed = {
  "items": [
    {
      "code": "PF-001",
      "source": "构树皮",
      "vat": "三号缸",
      "days": 5,
      "owner": "林素",
      "status": "发酵中",
      "logs": [
        {
          "at": "2026-06-15",
          "step": "观察",
          "note": "温度24.6，气味微酸，纤维开始松散",
          "abnormal": false
        }
      ]
    }
  ]
};
const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["dryWeight","原料干重(kg)","number"],["initialWaterLevel","初始水位(cm)","number"],["waterChangeCycle","换水周期(天)","number"],["days","发酵天数","number"],["owner","负责人","text"]];
const stages = ["入缸","发酵中","待补水","可抄纸","异常观察"];
const statLabels = stages;
const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];

// 水位低于初始水位的七成，或超过换水周期未换水，批次转待补水
const LOW_WATER_RATIO = 0.7;

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "PF-" + Date.now(); }
function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v) {
  if (v === true || v === false) return v;
  return /^(是|true|1|yes)$/i.test(String(v ?? "").trim());
}
function dayStamp(t) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
// 泡料用水状态：水位比例、距上次换水天数、逾期天数全部由历史巡查记录派生
function waterState(item, now = Date.now()) {
  const initial = num(item.initialWaterLevel);
  const registered = initial !== null && initial > 0;
  const records = item.waterInspections || [];
  const chrono = [...records].sort((a, b) => new Date(a.at) - new Date(b.at));
  const latest = chrono[chrono.length - 1] || null;
  const currentLevel = latest ? num(latest.waterLevel) : null;
  const levelRatio = registered && currentLevel !== null ? currentLevel / initial : null;
  const low = levelRatio !== null && levelRatio < LOW_WATER_RATIO;

  const cycle = num(item.waterChangeCycle);
  const changeTimes = records.filter(r => r.changedWater).map(r => new Date(r.at).getTime()).filter(t => !Number.isNaN(t));
  const anchor = changeTimes.length
    ? new Date(Math.max(...changeTimes))
    : (item.entryAt ? new Date(item.entryAt) : null);
  let elapsedDays = null;
  let overdueDays = 0;
  if (registered && anchor && cycle !== null && cycle > 0) {
    elapsedDays = Math.max(0, Math.round((dayStamp(now) - dayStamp(anchor.getTime())) / 86400000));
    overdueDays = Math.max(0, elapsedDays - cycle);
  }
  const reasons = [];
  if (low) reasons.push("水位" + currentLevel + "cm，低于初始水位七成（" + Math.round(initial * LOW_WATER_RATIO) + "cm）");
  if (overdueDays > 0) reasons.push("换水周期" + cycle + "天，已逾期" + overdueDays + "天未换水");
  return {
    registered,
    hasReading: latest !== null,
    currentLevel,
    levelRatio,
    low,
    cycle,
    lastWaterChangeAt: anchor ? anchor.toISOString() : null,
    elapsedDays,
    overdueDays,
    needWater: reasons.length > 0,
    reasons
  };
}
// 按巡查结果在「待补水」与原阶段之间切换，返回需要写入日志的事件
function applyWaterRules(item) {
  const state = waterState(item);
  const events = [];
  if (state.registered && state.needWater) {
    if (item.status !== "待补水") {
      item.stageBeforePending = item.status;
      item.status = "待补水";
      events.push({ step: "待补水", note: state.reasons.join("；") + "，批次转待补水，不能申请抄纸" });
    }
  } else if (item.status === "待补水") {
    const back = item.stageBeforePending || "发酵中";
    item.status = back;
    delete item.stageBeforePending;
    events.push({ step: "恢复阶段", note: "换水记录已补齐，水位恢复，回到「" + back + "」" });
  }
  return { state, events };
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount, water: waterState(item) };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵记录</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:120px; overflow:auto; } .warn,.danger { color:var(--warn); font-weight:700; }
    .vat-group { margin-bottom:12px; } .vat-group h3 { margin:0 0 4px; font-size:15px; }
    .vat-row { display:flex; align-items:center; gap:10px; padding:7px 2px; border-bottom:1px dashed var(--line); font-size:13px; flex-wrap:wrap; }
    .vat-row .code { min-width:74px; font-weight:700; } .vat-row .ratio { min-width:46px; }
    .bar { width:130px; height:9px; background:#e4e9e0; border-radius:99px; overflow:hidden; display:inline-block; }
    .bar i { display:block; height:100%; background:var(--accent); } .bar.low i { background:var(--warn); }
    .tag-backfill { border:1px solid var(--line); border-radius:4px; padding:0 5px; font-size:11px; color:var(--muted); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆发酵记录</h1><div class="meta">纸浆批次、浸泡缸、泡料用水巡查和异常观察</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增纸浆批次（入缸登记）</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存纸浆批次</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
      <form id="waterForm" style="margin-top:14px">
        <h2>泡料用水巡查</h2>
        <label>选择纸浆批次</label><select name="id" id="waterSelect"></select>
        <label>观察日期（补录请选过去日期，旧巡查不会被覆盖）</label><input type="date" name="at" id="waterDate">
        <label>水位(cm)</label><input name="waterLevel" type="number" step="0.1" min="0" required>
        <label>酸碱度(pH 0-14)</label><input name="ph" type="number" step="0.1" min="0" max="14" required>
        <label>是否换水</label><select name="changedWater"><option value="否">否</option><option value="是">是（换水后逾期清零）</option></select>
        <label>备注</label><input name="note">
        <button>提交巡查</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel" style="margin-bottom:14px"><h2>缸位水位看板</h2><div id="vatBoard"></div></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>入缸登记干重、初始水位与换水周期；每次巡查记录水位、酸碱度和换水情况。水位低于七成或换水逾期转待补水，补齐换水记录后回到原阶段。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["dryWeight","原料干重(kg)","number"],["initialWaterLevel","初始水位(cm)","number"],["waterChangeCycle","换水周期(天)","number"],["days","发酵天数","number"],["owner","负责人","text"]];
    const registerKeys = ["dryWeight","initialWaterLevel","waterChangeCycle"];
    const stages = ["入缸","发酵中","待补水","可抄纸","异常观察"];
    const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const waterForm = document.querySelector('#waterForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const waterSelect = document.querySelector('#waterSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '请求失败');
      return data;
    }
    const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    function fmtDay(t) { const d = new Date(t); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
    function isBackfill(r) { return r.recordedAt && fmtDay(r.recordedAt) !== fmtDay(r.at); }
    function today() { return fmtDay(new Date()); }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'||registerKeys.includes(key)?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
      document.querySelector('#waterDate').value = today();
    }
    function waterDue(w) {
      if (!w.registered) return '';
      if (w.overdueDays > 0) return '<span class="danger">换水逾期'+w.overdueDays+'天</span>';
      if (w.cycle && w.elapsedDays !== null) return '<span class="meta">换水余'+(w.cycle-w.elapsedDays)+'天</span>';
      return '';
    }
    function renderBoard() {
      const groups = {};
      for (const item of items) (groups[item.vat || '未分缸'] ||= []).push(item);
      document.querySelector('#vatBoard').innerHTML = Object.entries(groups).map(([vat, list]) =>
        '<div class="vat-group"><h3>'+esc(vat)+'</h3>'+list.map(item => {
          const w = item.water || {};
          if (!w.registered) return '<div class="vat-row"><span class="code">'+esc(item.code)+'</span><span class="meta">未登记泡料用水（干重 / 初始水位 / 换水周期）</span><span class="pill">'+esc(item.status)+'</span></div>';
          const pct = w.levelRatio === null ? null : Math.round(w.levelRatio*100);
          const bar = pct === null ? '<span class="meta">尚未巡查</span>' : '<span class="bar '+(w.low?'low':'')+'"><i style="width:'+Math.max(0,Math.min(100,pct))+'%"></i></span><span class="ratio'+(w.low?' danger':'')+'">水位'+pct+'%</span>';
          return '<div class="vat-row"><span class="code">'+esc(item.code)+'</span>'+bar+waterDue(w)+'<span class="pill">'+esc(item.status)+'</span></div>';
        }).join('')+'</div>').join('');
    }
    function render() {
      const opts = items.map(item => '<option value="'+esc(item.id || item.code)+'">'+esc(item.code || item.id)+' · '+esc(item.vat || '')+' · '+esc(item.source || '')+'</option>').join('');
      itemSelect.innerHTML = opts;
      waterSelect.innerHTML = opts;
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      renderBoard();
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        try { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); }
        catch (err) { alert(err.message); }
        await load();
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const w = item.water || {};
      const main = '<div><b>原料来源</b> '+esc(item.source ?? '')+'</div><div><b>浸泡缸</b> '+esc(item.vat ?? '')+'</div><div><b>发酵天数</b> '+(item.days ?? '')+'</div><div><b>负责人</b> '+esc(item.owner ?? '')+'</div>';
      const reg = w.registered
        ? '<div class="meta">干重'+esc(item.dryWeight)+'kg · 初始水位'+esc(item.initialWaterLevel)+'cm · 换水周期'+esc(w.cycle)+'天</div>'
        : '<div class="meta">未登记泡料用水（干重 / 初始水位 / 换水周期）</div>';
      let now = '';
      if (w.registered) {
        if (w.levelRatio === null) now = '<div class="meta">尚无巡查记录</div>';
        else now = '<div class="'+(w.low?'warn':'')+'">当前水位'+esc(w.currentLevel)+'cm（初始值'+Math.round(w.levelRatio*100)+'%）</div>';
      }
      const due = w.registered ? '<div>'+waterDue(w)+'</div>' : '';
      const insp = [...(item.waterInspections || [])].sort((a,b) => new Date(b.at)-new Date(a.at)).map(r =>
        '<div>'+fmtDay(r.at)+' 水位'+esc(r.waterLevel)+'cm · pH'+esc(r.ph)+' · '+(r.changedWater?'已换水':'未换水')+(isBackfill(r)?' <span class="tag-backfill">补录</span>':'')+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      return '<article class="card"><h3>'+esc(item.code || item.id)+'</h3><span class="pill">'+esc(item.status)+'</span>'+main+reg+now+due
        +'<div class="logs meta"><b>用水巡查（旧记录保留）</b>'+(insp || '<div>暂无巡查</div>')+'</div>'
        +'<label>状态</label><select data-status="'+esc(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+esc(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); renderForms(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    waterForm.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(waterForm).entries());
      const id = data.id; delete data.id;
      try { await api('/api/items/'+id+'/water-logs', { method:'POST', body: JSON.stringify(data) }); waterForm.reset(); renderForms(); await load(); }
      catch (err) { alert(err.message); }
    };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      // 巡查记录与原阶段只允许通过专门的巡查接口写入，建档时不能直接带入
      delete input.waterInspections;
      delete input.stageBeforePending;
      const now = new Date().toISOString();
      const initial = num(input.initialWaterLevel);
      const cycle = num(input.waterChangeCycle);
      const item = {
        id: newId(),
        ...input,
        dryWeight: num(input.dryWeight),
        initialWaterLevel: initial,
        waterChangeCycle: cycle,
        days: num(input.days) ?? 0,
        entryAt: now,
        waterInspections: [],
        logs: [{ at: now, step: "建档", note: "创建纸浆批次" + (initial !== null ? "，原料干重" + (num(input.dryWeight) ?? "?") + "kg，初始水位" + initial + "cm，换水周期" + (cycle ?? "?") + "天" : "") }]
      };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found", message: "批次不存在" });
      const input = await body(req);
      // 申请抄纸必须通过泡料用水检查：水位不足或换水逾期一律拦截
      if (input.status === "可抄纸") {
        const st = waterState(item);
        if (st.registered && st.needWater) {
          return send(res, 400, { error: "water_pending", message: "批次待补水（" + st.reasons.join("；") + "），不能申请抄纸；补齐换水记录后自动回到原阶段。" });
        }
      }
      // 历史巡查只追加，不允许整体改写字段
      delete input.waterInspections;
      delete input.stageBeforePending;
      Object.assign(item, input);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found", message: "批次不存在" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    // 泡料用水巡查：入缸登记之外，每次观察只向 waterInspections 末尾追加一条
    const water = url.pathname.match(/^\/api\/items\/([^/]+)\/water-logs$/);
    if (water && req.method === "POST") {
      const item = db.items.find(x => x.id === water[1] || x.code === water[1]);
      if (!item) return send(res, 404, { error: "item_not_found", message: "批次不存在" });
      const input = await body(req);
      const level = num(input.waterLevel);
      if (level === null || level < 0) return send(res, 400, { error: "water_level_invalid", message: "请填写不小于 0 的水位（cm）" });
      const ph = num(input.ph);
      if (ph === null || ph < 0 || ph > 14) return send(res, 400, { error: "ph_invalid", message: "酸碱度请填写 0-14 之间的数字" });
      const observed = input.at ? new Date(input.at) : new Date();
      if (Number.isNaN(observed.getTime())) return send(res, 400, { error: "date_invalid", message: "观察日期格式不正确" });
      const changedWater = bool(input.changedWater);
      const recordedAt = new Date();
      const record = {
        at: observed.toISOString(),
        recordedAt: recordedAt.toISOString(),
        waterLevel: level,
        ph,
        changedWater,
        note: String(input.note || "")
      };
      item.waterInspections ||= [];
      item.waterInspections.push(record);
      item.logs ||= [];
      const before = waterState(item);
      const pct = before.levelRatio === null ? "?" : Math.round(before.levelRatio * 100) + "%";
      const backfilled = dayStamp(recordedAt.getTime()) !== dayStamp(observed.getTime());
      item.logs.push({
        at: recordedAt.toISOString(),
        step: "用水巡查",
        note: "水位" + level + "cm（初始值" + pct + "），pH" + ph + "，" + (changedWater ? "已换水" : "未换水")
          + (backfilled ? "，补录" + observed.toISOString().slice(0, 10) + " 巡查" : "")
          + (record.note ? "，" + record.note : "")
      });
      // 追加完记录后再判定：低于七成/逾期转待补水，补齐换水记录则回到原阶段
      const { state, events } = applyWaterRules(item);
      for (const ev of events) item.logs.push({ at: recordedAt.toISOString(), step: ev.step, note: ev.note });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found", message: "批次不存在" });
      const input = await body(req);
      item.logs ||= [];
      const abnormal = String(input.abnormal || "").includes("是") || String(input.abnormal || "").includes("有");
      item.observations ||= [];
      item.observations.push({ at: new Date().toISOString(), ...input, abnormal });
      item.days = Number(item.days || 0) + 1;
      // 待补水优先：用水不达标时发酵再久也不能进入可抄纸
      const { events } = applyWaterRules(item);
      if (item.status !== "待补水") {
        item.status = abnormal ? "异常观察" : Number(item.days) >= 7 ? "可抄纸" : "发酵中";
      }
      for (const ev of events) item.logs.push({ at: new Date().toISOString(), step: ev.step, note: ev.note });
      item.logs.push({ at: new Date().toISOString(), step: "观察", note: "温度" + (input.temperature || "") + "，" + (input.smell || "") + "，" + (input.fiber || "") });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法纸浆发酵记录 listening on http://localhost:" + port));
