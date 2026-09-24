import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-pulp-fermentation.json");
const port = Number(process.env.PORT || 3039);
const DAY_MS = 24 * 60 * 60 * 1000;
const LOW_WATER_RATIO = 0.7;
const FERMENT_READY_DAYS = 7;
const seed = {
  "items": [
    {
      "code": "PF-001",
      "source": "构树皮",
      "vat": "三号缸",
      "dryWeight": 120,
      "initialWaterLevel": 80,
      "waterChangeCycleDays": 7,
      "entryAt": "2026-09-10T01:00:00.000Z",
      "days": 8,
      "owner": "林素",
      "status": "待补水",
      "statusBeforeWater": "发酵中",
      "logs": [
        {
          "at": "2026-09-10T01:00:00.000Z",
          "step": "建档",
          "note": "创建纸浆批次，入缸登记：干重120kg，初始水位80cm，换水周期7天"
        },
        {
          "at": "2026-09-12T02:10:00.000Z",
          "step": "观察",
          "note": "水位78cm（98%），pH7.0，已换水，温度24.6，气味微酸，纤维开始松散"
        },
        {
          "at": "2026-09-23T03:50:00.000Z",
          "step": "待补水",
          "note": "水位52cm为初始值65%（低于70%）；距上次换水已11天，换水逾期4天"
        }
      ],
      "observations": [
        {
          "at": "2026-09-12T02:10:00.000Z",
          "observedAt": "2026-09-12T02:10:00.000Z",
          "waterLevel": 78,
          "ph": 7.0,
          "changedWater": "是",
          "temperature": "24.6",
          "smell": "微酸",
          "fiber": "开始松散",
          "abnormal": false,
          "backfilled": false
        },
        {
          "at": "2026-09-23T03:50:00.000Z",
          "observedAt": "2026-09-23T03:50:00.000Z",
          "waterLevel": 52,
          "ph": 6.4,
          "changedWater": "否",
          "temperature": "25.1",
          "smell": "微酸",
          "fiber": "松散",
          "abnormal": false,
          "backfilled": false
        }
      ]
    }
  ]
};
const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸位","text"],["dryWeight","原料干重(kg)","number"],["initialWaterLevel","初始水位(cm)","number"],["waterChangeCycleDays","换水周期(天)","number"],["days","发酵天数","number"],["owner","负责人","text"]];
const stages = ["入缸","发酵中","待补水","可抄纸","异常观察"];
const statLabels = stages;
const observationFields = [["waterLevel","本次水位(cm)","number"],["ph","酸碱度","number"],["changedWater","是否换水","select"],["observedAt","巡查时间(补录可选)","datetime-local"],["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["abnormal","异味或霉点"]];

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
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function isYes(value) {
  return value === true || (typeof value === "string" && (value.includes("是") || value.toLowerCase() === "yes"));
}
function observedTime(o) {
  const t = new Date(o.observedAt || o.at).getTime();
  return Number.isFinite(t) ? t : 0;
}
// 泡料用水巡查状态：纯计算，不改动任何历史巡查记录
function waterStatus(item, now = Date.now()) {
  const initial = num(item.initialWaterLevel);
  const cycle = num(item.waterChangeCycleDays);
  const observations = item.observations || [];
  const withLevel = observations.filter(o => num(o.waterLevel) !== null).sort((a, b) => observedTime(a) - observedTime(b));
  const latest = withLevel[withLevel.length - 1] || null;
  const latestLevel = latest ? num(latest.waterLevel) : null;
  const ratio = latestLevel !== null && initial > 0 ? latestLevel / initial : null;
  const changeTimes = observations.filter(o => isYes(o.changedWater)).map(observedTime).filter(Boolean);
  const lastChangeAt = changeTimes.length ? Math.max(...changeTimes) : (item.entryAt ? new Date(item.entryAt).getTime() : null);
  let elapsedDays = null;
  let overdueDays = 0;
  if (cycle > 0 && lastChangeAt) {
    elapsedDays = Math.floor((now - lastChangeAt) / DAY_MS);
    overdueDays = Math.max(0, elapsedDays - cycle);
  }
  const lowWater = ratio !== null && ratio < LOW_WATER_RATIO;
  const overdue = cycle > 0 && elapsedDays !== null && elapsedDays > cycle;
  const reasons = [];
  if (lowWater) reasons.push("水位" + latestLevel + "cm为初始值" + Math.round(ratio * 100) + "%（低于70%）");
  if (overdue) reasons.push("换水逾期" + overdueDays + "天（周期" + cycle + "天）");
  return {
    registered: initial !== null && initial > 0,
    initial,
    cycle,
    latestLevel,
    latestPh: latest ? (num(latest.ph) !== null ? num(latest.ph) : (latest.ph ?? null)) : null,
    latestAt: latest ? (latest.observedAt || latest.at) : null,
    ratio,
    lastChangeAt: lastChangeAt || null,
    neverChanged: changeTimes.length === 0,
    elapsedDays,
    overdueDays,
    lowWater,
    overdue,
    alert: lowWater || overdue,
    reasons
  };
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
  return { ...item, logCount, water: waterStatus(item) };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵 · 泡料用水巡查</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --ok:#3f7a4f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3.vatname { margin:18px 0 8px; font-size:16px; }
    main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button:disabled { opacity:.55; cursor:default; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; } .pill.warn { color:var(--warn); border-color:var(--warn); } .pill.ok { color:var(--ok); border-color:var(--ok); }
    .warn { color:var(--warn); font-weight:700; } .ok { color:var(--ok); font-weight:700; }
    .bar { height:9px; border-radius:999px; background:#e6ebe2; overflow:hidden; } .bar i { display:block; height:100%; background:var(--ok); } .bar i.low { background:var(--warn); }
    .row { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
    .btnrow { display:flex; gap:8px; flex-wrap:wrap; } .btnrow button { flex:1; padding:8px 10px; }
    details { border-top:1px solid var(--line); padding-top:8px; } summary { cursor:pointer; font-size:13px; color:var(--muted); }
    .hist { font-size:12.5px; color:var(--muted); border-bottom:1px dashed var(--line); padding:5px 0; } .tag { display:inline-block; margin-left:4px; padding:0 6px; border-radius:999px; background:#efe7d4; color:#7a5e22; font-size:11px; }
    .notice { font-size:12.5px; color:var(--muted); margin:8px 0 0; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆发酵 · 泡料用水巡查</h1><div class="meta">入缸登记干重、初始水位与换水周期；按缸位巡查水位、酸碱度与换水情况</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>入缸登记</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存纸浆批次</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>泡料用水巡查</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交巡查记录</button><p class="notice">巡查记录只追加不覆盖；补录过去时间的巡查请填写“巡查时间”，旧记录保留不变。</p></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号、缸位或关键词"></div>
      <div class="panel"><h2>泡料用水巡查看板（按缸位）</h2><div id="board"></div></div>
    </section>
  </main>
  <script>
    const fields = ${JSON.stringify(fields)};
    const stages = ${JSON.stringify(stages)};
    const observationFields = ${JSON.stringify(observationFields)};
    const LOW_WATER_RATIO = 0.7;
    const errorText = {
      invalid_registration: "请正确登记原料干重、初始水位和换水周期（大于0的数字）",
      water_fields_required: "该批次已登记泡料用水，每次巡查必须填写水位和酸碱度",
      water_required: "批次待补水：水位低于初始值七成或换水已逾期，不能申请抄纸",
      need_water_record: "批次处于待补水，请先补齐换水记录并使水位恢复",
      fermenting: "发酵天数不足7天，暂不能申请抄纸",
      already_water_pending: "批次已在待补水状态"
    };
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const board = document.querySelector('#board');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(errorText[data.error] || data.error || '请求失败');
      return data;
    }
    function inputHtml([key,label,type], required) {
      const req = required ? ' required' : '';
      if (type === 'select') return '<label>'+label+'</label><select name="'+key+'"'+req+'><option value="否">否</option><option value="是">是</option></select>';
      const step = key === 'ph' ? ' step="0.1"' : '';
      return '<label>'+label+'</label><input name="'+key+'" type="'+(type||'text')+'"'+step+req+'>';
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(f => inputHtml(f, f[0] === 'code' || ['dryWeight','initialWaterLevel','waterChangeCycleDays'].includes(f[0]))).join('');
      document.querySelector('#extraFields').innerHTML = observationFields.map(f => inputHtml(f, ['waterLevel','ph','changedWater'].includes(f[0]))).join('');
    }
    function fmt(ts) {
      if (!ts) return '—';
      const d = new Date(ts);
      return isNaN(d) ? String(ts) : d.toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.vat||'未分缸')+' · '+(item.source||'')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      const groups = new Map();
      for (const item of visible) {
        const key = item.vat || '未指定缸位';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      board.innerHTML = [...groups.entries()].map(([vat, list]) => '<h3 class="vatname">缸位：'+vat+'（'+list.length+' 批）</h3><div class="grid">'+list.map(cardHtml).join('')+'</div>').join('') || '<p class="meta">暂无批次</p>';
      bindCardEvents();
    }
    function waterBlock(item) {
      const w = item.water || {};
      if (!w.registered) return '<div class="meta">泡料用水未登记（干重/初始水位/换水周期）</div>';
      const pct = w.ratio == null ? null : Math.round(w.ratio * 100);
      const bar = w.ratio == null ? '' : '<div class="bar"><i class="'+(w.lowWater?'low':'')+'" style="width:'+Math.max(0,Math.min(100,pct))+'%"></i></div>';
      let levelLine;
      if (w.ratio == null) levelLine = '<span class="meta">尚无水位巡查</span>';
      else levelLine = '<span class="'+(w.lowWater?'warn':'ok')+'">'+pct+'%（'+w.latestLevel+'/'+w.initial+'cm）</span>';
      let dueLine;
      if (w.cycle > 0 && w.elapsedDays !== null) {
        if (w.overdue) dueLine = '<span class="warn">换水逾期 '+w.overdueDays+' 天</span>';
        else dueLine = '<span class="ok">距换水还有 '+(w.cycle - w.elapsedDays)+' 天</span>';
      } else dueLine = '<span class="meta">周期未登记</span>';
      const lastChange = w.neverChanged ? '入缸后未换水（自'+fmt(item.entryAt)+'）' : '上次换水 '+fmt(w.lastChangeAt);
      const phLine = w.latestPh == null ? '' : ' · pH '+w.latestPh;
      return '<div class="row"><span class="meta">水位比例</span>'+levelLine+'</div>'+bar
        + '<div class="row"><span class="meta">换水（周期'+w.cycle+'天）</span>'+dueLine+'</div>'
        + '<div class="meta">'+lastChange+phLine+(w.latestAt?' · 最新巡查 '+fmt(w.latestAt):'')+'</div>'
        + (w.alert ? '<div class="warn">⚠ '+w.reasons.join('；')+'，批次转待补水，不能申请抄纸</div>' : '');
    }
    function historyHtml(item) {
      const obs = item.observations || [];
      if (!obs.length) return '';
      const initial = Number(item.initialWaterLevel) || 0;
      const rows = obs.slice().reverse().map(o => {
        const pct = initial && Number(o.waterLevel) ? Math.round(Number(o.waterLevel) / initial * 100) + '%' : '—';
        return '<div class="hist">'+fmt(o.observedAt || o.at)+(o.backfilled ? '<span class="tag">补录</span>' : '')
          + '<br>水位 '+((o.waterLevel ?? '—')+'cm')+'（'+pct+'） · pH '+(o.ph ?? '—')+' · 换水：'+(o.changedWater || '—')
          + (o.temperature ? ' · 温度'+o.temperature : '') + (o.smell ? ' · '+o.smell : '') + (o.fiber ? ' · '+o.fiber : '')
          + '</div>';
      }).join('');
      return '<details><summary>巡查历史（'+obs.length+' 条，旧记录保留不覆盖）</summary>'+rows+'</details>';
    }
    function cardHtml(item) {
      const head = '<div class="row"><h3 style="margin:0">'+(item.code || item.id)+'</h3><span class="pill '+(item.status==='待补水'?'warn':item.status==='可抄纸'?'ok':'')+'">'+item.status+'</span></div>';
      const base = '<div class="meta">'+(item.source||'')+' · 干重'+(item.dryWeight ?? '—')+'kg · 负责人'+(item.owner||'—')+' · 发酵'+(item.days||0)+'天</div>';
      const controls = '<label style="margin:0">批次状态</label><div class="btnrow"><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'
        + (item.status === '可抄纸' ? '<button disabled>已可抄纸</button>' : '<button data-apply="'+(item.id || item.code)+'">申请抄纸</button>')
        + '<button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button></div>';
      return '<article class="card">'+head+base+waterBlock(item)+controls+historyHtml(item)+'</article>';
    }
    function bindCardEvents() {
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        const value = sel.value;
        try { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: value }) }); }
        catch (e) { alert(e.message); }
        await load();
      });
      document.querySelectorAll('[data-apply]').forEach(btn => btn.onclick = async () => {
        try { await api('/api/items/'+btn.dataset.apply+'/apply-paper', { method:'POST', body: '{}' }); alert('已申请抄纸，批次转为「可抄纸」'); }
        catch (e) { alert(e.message); }
        await load();
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => {
        const note = prompt('记录备注');
        if (note) { await api('/api/items/'+btn.dataset.note+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); }
      });
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => {
      event.preventDefault();
      await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) });
      actionForm.reset();
      await load();
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
      const dryWeight = num(input.dryWeight);
      const initialWaterLevel = num(input.initialWaterLevel);
      const waterChangeCycleDays = num(input.waterChangeCycleDays);
      if (!dryWeight || dryWeight <= 0 || !initialWaterLevel || initialWaterLevel <= 0 || !waterChangeCycleDays || waterChangeCycleDays <= 0) {
        return send(res, 400, { error: "invalid_registration" });
      }
      const now = new Date().toISOString();
      const item = {
        id: newId(),
        ...input,
        dryWeight,
        initialWaterLevel,
        waterChangeCycleDays,
        days: num(input.days) || 0,
        status: input.status || "发酵中",
        entryAt: now,
        observations: [],
        logs: [{ at: now, step: "建档", note: "入缸登记：干重" + dryWeight + "kg，初始水位" + initialWaterLevel + "cm，换水周期" + waterChangeCycleDays + "天" }]
      };
      delete item.water;
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const ws = waterStatus(item);
      // 待补水期间不能人工改成可抄纸或绕过补水流程
      if (input.status === "可抄纸" && ws.alert) return send(res, 409, { error: "water_required", water: ws });
      if (item.status === "待补水" && input.status && input.status !== "待补水" && ws.alert) {
        return send(res, 409, { error: "need_water_record", water: ws });
      }
      Object.assign(item, input);
      delete item.water;
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const applyPaper = url.pathname.match(/^\/api\/items\/([^/]+)\/apply-paper$/);
    if (applyPaper && req.method === "POST") {
      const item = db.items.find(x => x.id === applyPaper[1] || x.code === applyPaper[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const ws = waterStatus(item);
      if (ws.alert) return send(res, 409, { error: "water_required", water: ws });
      if (Number(item.days || 0) < FERMENT_READY_DAYS) return send(res, 409, { error: "fermenting" });
      item.status = "可抄纸";
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "申请抄纸", note: "巡查正常，申请抄纸" });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const registered = num(item.initialWaterLevel) !== null && num(item.initialWaterLevel) > 0;
      const waterLevel = num(input.waterLevel);
      const ph = input.ph === undefined || input.ph === "" ? null : num(input.ph);
      if (registered && (waterLevel === null || waterLevel <= 0 || ph === null)) {
        return send(res, 400, { error: "water_fields_required" });
      }
      const abnormal = String(input.abnormal || "").includes("是") || String(input.abnormal || "").includes("有");
      const now = new Date().toISOString();
      const observedAt = input.observedAt ? new Date(input.observedAt).toISOString() : now;
      item.logs ||= [];
      item.observations ||= [];
      // 只追加：新巡查（含补录）永不覆盖旧巡查
      item.observations.push({
        at: now,
        observedAt,
        backfilled: observedAt !== now,
        waterLevel: waterLevel,
        ph: ph,
        changedWater: input.changedWater || "否",
        temperature: input.temperature || "",
        smell: input.smell || "",
        fiber: input.fiber || "",
        abnormal
      });
      item.days = Number(item.days || 0) + 1;
      const ws = waterStatus(item);
      const fermentTarget = abnormal ? "异常观察" : Number(item.days) >= FERMENT_READY_DAYS ? "可抄纸" : "发酵中";
      const pctText = ws.ratio == null ? "" : Math.round(ws.ratio * 100) + "%";
      item.logs.push({
        at: now,
        step: "巡查",
        note: "水位" + (waterLevel == null ? "未填" : waterLevel + "cm（" + pctText + "）") + "，pH" + (ph == null ? "未填" : ph) + "，" + (isYes(input.changedWater) ? "已换水" : "未换水")
          + (input.temperature ? "，温度" + input.temperature : "") + (input.smell ? "，" + input.smell : "") + (input.fiber ? "，" + input.fiber : "")
      });
      if (ws.alert) {
        if (item.status !== "待补水") {
          item.statusBeforeWater = item.status || fermentTarget;
          item.logs.push({ at: now, step: "待补水", note: ws.reasons.join("；") + "，批次转待补水，不能申请抄纸" });
        } else {
          item.logs.push({ at: now, step: "待补水", note: "巡查仍未解除：" + ws.reasons.join("；") });
        }
        item.status = "待补水";
      } else if (item.status === "待补水") {
        const back = item.statusBeforeWater || fermentTarget;
        item.logs.push({ at: now, step: "恢复", note: "换水记录已补齐且水位恢复，回到原阶段：" + back });
        item.status = back;
        item.statusBeforeWater = null;
      } else {
        item.status = fermentTarget;
      }
      await saveDb(db);
      return send(res, 201, summarize(item));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法纸浆发酵 · 泡料用水巡查 listening on http://localhost:" + port));
