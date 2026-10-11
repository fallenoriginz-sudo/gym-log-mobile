"use strict";

/* =====================================================================
   Storage: one JSON state object in IndexedDB, mirrored to localStorage.
   Writes are debounced and flushed when the app is hidden or closed.
   ===================================================================== */

const DB_NAME = "gymlog";
const STORE = "kv";
const LS_KEY = "gymlog-state";

let idbPromise = null;
function idbOpen() {
  idbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let saveTimer = null;
let dirtyData = false;
function save() {
  dirtyData = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}
function flush() {
  clearTimeout(saveTimer);
  if (!dirtyData) return Promise.resolve();
  dirtyData = false;
  state.savedAt = Date.now();
  const json = JSON.stringify(state);
  try { localStorage.setItem(LS_KEY, json); } catch {}
  return idbSet("state", json).catch(() => {});
}

async function load() {
  const parse = (json) => { try { return json ? JSON.parse(json) : null; } catch { return null; } };
  let fromIdb = null, fromLs = null;
  try { fromIdb = parse(await idbGet("state")); } catch {}
  try { fromLs = parse(localStorage.getItem(LS_KEY)); } catch {}
  const best = [fromIdb, fromLs].filter(Boolean).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0];
  return best ? migrate(best) : seed();
}

/* =====================================================================
   Data model
   ===================================================================== */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function seed() {
  const ex = (name, category) => ({ id: uid(), name, category });
  const exercises = [
    ex("Bench Press", "Chest"), ex("Overhead Press", "Shoulders"), ex("Incline Dumbbell Press", "Chest"),
    ex("Tricep Pushdown", "Arms"), ex("Lateral Raise", "Shoulders"),
    ex("Deadlift", "Back"), ex("Pull-up", "Back"), ex("Barbell Row", "Back"), ex("Lat Pulldown", "Back"), ex("Bicep Curl", "Arms"),
    ex("Squat", "Legs"), ex("Romanian Deadlift", "Legs"), ex("Leg Press", "Legs"), ex("Leg Curl", "Legs"), ex("Calf Raise", "Legs"),
  ];
  const items = (...names) => names.map((n) => newItem(exercises.find((e) => e.name === n).id));
  const push = { id: uid(), name: "Push", items: items("Bench Press", "Overhead Press", "Incline Dumbbell Press", "Lateral Raise", "Tricep Pushdown") };
  const pull = { id: uid(), name: "Pull", items: items("Deadlift", "Pull-up", "Barbell Row", "Lat Pulldown", "Bicep Curl") };
  const legs = { id: uid(), name: "Legs", items: items("Squat", "Romanian Deadlift", "Leg Press", "Leg Curl", "Calf Raise") };
  return migrate({
    version: 2,
    exercises,
    templates: [push, pull, legs],
    // Optional weekly defaults, keyed by JS weekday: 0 = Sunday ... 6 = Saturday.
    // Dates in `calendar` override these.
    schedule: { 1: push.id, 3: pull.id, 5: legs.id },
    calendar: {},
  });
}

// A plan line: 3 × 8–10 @ targetKg (null = use last time's weight).
function newItem(exerciseId) {
  return { exerciseId, sets: 3, repsMin: 8, repsMax: 10, targetKg: null };
}

function migrate(s) {
  s.version ??= 1;
  s.settings ??= {};
  s.settings.unit ??= "kg";
  s.settings.restSec ??= 90;
  s.settings.goalKg ??= null;
  s.settings.profile ??= {};
  const pr = s.settings.profile;
  pr.heightCm ??= null;
  pr.age ??= null;
  pr.sex ??= "male";
  pr.activity ??= 1.55;
  pr.goal ??= "maintain";
  s.exercises ??= [];
  s.templates ??= [];
  s.schedule ??= {};
  s.calendar ??= {};
  for (const t of s.templates) {
    // v1 plans were a bare list of exercise ids
    if (!t.items) t.items = (t.exerciseIds || []).map((exerciseId) => ({ exerciseId, sets: 3, repsMin: null, repsMax: null, targetKg: null }));
    delete t.exerciseIds;
  }
  s.version = 2;
  s.sessions ??= [];
  s.bodyweight ??= [];
  s.activeSessionId ??= null;
  return s;
}

let state;
const TABS = ["today", "plan", "progress", "body", "more"];
const ui = {
  tab: "today",
  dirty: Object.fromEntries(TABS.map((t) => [t, true])),
  scroll: {},
  workoutOpen: false,
  current: 0,          // index of the expanded exercise in the workout
  menu: -1,            // exercise whose options are open
  pickOpen: false,     // plan picker on Today
  calOpen: null,       // date whose row is expanded on Plan
  extraDates: [],      // dates beyond the next 14 days the user jumped to
  weeklyOpen: false,
  editTemplateId: null,
  editFrom: "plan",    // tab the plan editor was opened from
  progress: { ex: null, metric: "e1rm", range: "3M" },
  bodyRange: "3M",
  bwDate: null,        // date shown on the Body log card (null = today)
  repMax: {},          // chosen N-rep max per exercise on Progress
  rest: null,          // { end, total }
};

/* Every data change bumps the version: caches drop, tabs re-render on next view. */
let dataVersion = 0;
function changed({ keep } = {}) {
  dataVersion++;
  for (const t of TABS) if (t !== keep) ui.dirty[t] = true;
  save();
}
function memo(fn) {
  let v = -1;
  const cache = new Map();
  return (key) => {
    if (v !== dataVersion) { cache.clear(); v = dataVersion; }
    if (!cache.has(key)) cache.set(key, fn(key));
    return cache.get(key);
  };
}

/* =====================================================================
   Helpers
   ===================================================================== */

const KG_PER_LB = 0.45359237;
const unit = () => state.settings.unit;
const round1 = (n) => Math.round(n * 10) / 10;
const toDisplay = (kg) => (kg == null || kg === "" || isNaN(kg) ? "" : round1(unit() === "kg" ? kg : kg / KG_PER_LB));
const fromDisplay = (v) => {
  const n = parseFloat(String(v).replace(",", "."));
  if (isNaN(n)) return null;
  return unit() === "kg" ? n : n * KG_PER_LB;
};
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toLocaleString();

const pad2 = (n) => String(n).padStart(2, "0");
function dateStr(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
const todayStr = () => dateStr();
function parseDate(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); }
function mondayOf(s) { const d = parseDate(s); return addDays(s, -((d.getDay() + 6) % 7)); }
// Intl formatters are slow to create, so reuse one per option set.
const fmtCache = new Map();
function fmtDate(s, opts = { weekday: "short", day: "numeric", month: "short" }) {
  const d = parseDate(s);
  if (d.getFullYear() !== new Date().getFullYear()) opts = { ...opts, year: "numeric" };
  const key = JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(undefined, opts));
  return fmtCache.get(key).format(d);
}
function relDay(s) {
  const diff = Math.round((parseDate(todayStr()) - parseDate(s)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return parseDate(s).toLocaleDateString(undefined, { weekday: "short" });
  return fmtDate(s, { day: "numeric", month: "short" });
}
function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const exById = (id) => state.exercises.find((e) => e.id === id);
const tplById = (id) => state.templates.find((t) => t.id === id);
const sessById = (id) => state.sessions.find((s) => s.id === id);

// The plan for a date: an explicit calendar entry (null = rest) wins over the weekly default.
function planFor(date) {
  const id = date in state.calendar ? state.calendar[date] : state.schedule[parseDate(date).getDay()];
  return (id && tplById(id)) || null;
}
const planItems = (t) => t.items.filter((it) => exById(it.exerciseId));
const repsText = (it) => (it.repsMin == null ? "" : it.repsMax && it.repsMax !== it.repsMin ? `${it.repsMin}–${it.repsMax}` : `${it.repsMin}`);
function itemText(it) {
  const reps = repsText(it);
  return `${reps ? `${it.sets} × ${reps}` : `${it.sets} sets`}${it.targetKg != null ? ` @ ${toDisplay(it.targetKg)} ${unit()}` : ""}`;
}
function planSummary(t) {
  const items = planItems(t);
  return `${items.length} exercise${items.length === 1 ? "" : "s"}, ${items.reduce((n, it) => n + (+it.sets || 0), 0)} sets`;
}
const active = () => (state.activeSessionId ? sessById(state.activeSessionId) : null);
const doneSets = (e) => e.sets.filter((x) => x.done && x.reps > 0 && x.weight != null);
const e1rm = (w, r) => (r <= 1 ? w : w * (1 + r / 30)); // Epley

const sortedSessions = memo(() => [...state.sessions].sort((a, b) => (b.date + (b.startedAt || 0)).localeCompare(a.date + (a.startedAt || 0))));

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 1600);
}
const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch {} };

/* =====================================================================
   Derived data (cached per data version)
   ===================================================================== */

// Per-exercise history, oldest first, with PR flags.
const exerciseHistory = memo((exerciseId) => {
  const rows = [];
  const sessions = [...state.sessions].sort((a, b) => a.date.localeCompare(b.date));
  for (const s of sessions) {
    if (s.id === state.activeSessionId && !s.finished) continue;
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId) continue;
      const done = doneSets(e);
      if (!done.length) continue;
      let best = done[0];
      for (const x of done) if (e1rm(x.weight, x.reps) > e1rm(best.weight, best.reps)) best = x;
      rows.push({
        date: s.date,
        sessionId: s.id,
        sets: done,
        best,
        e1rm: e1rm(best.weight, best.reps),
        top: Math.max(...done.map((x) => x.weight)),
        volume: done.reduce((v, x) => v + x.weight * x.reps, 0),
      });
    }
  }
  let max = -Infinity;
  rows.forEach((r, i) => {
    r.pr = i > 0 && r.e1rm > max + 1e-9;
    max = Math.max(max, r.e1rm);
  });
  return rows;
});

// PR count per session id.
const prCounts = memo(() => {
  const map = new Map();
  for (const ex of state.exercises) {
    for (const r of exerciseHistory(ex.id)) if (r.pr) map.set(r.sessionId, (map.get(r.sessionId) || 0) + 1);
  }
  return map;
});

function lastPerformance(exerciseId, excludeSessionId) {
  for (const s of sortedSessions()) {
    if (s.id === excludeSessionId) continue;
    const e = s.entries.find((en) => en.exerciseId === exerciseId);
    const done = e && doneSets(e);
    if (done?.length) return { date: s.date, sets: done };
  }
  return null;
}

function describeSets(sets) {
  if (!sets.length) return "";
  const same = sets.every((x) => x.reps === sets[0].reps && x.weight === sets[0].weight);
  if (same) return `${sets.length} × ${sets[0].reps} at ${toDisplay(sets[0].weight)} ${unit()}`;
  return sets.map((x) => `${x.reps}×${toDisplay(x.weight)}`).join(", ") + ` ${unit()}`;
}

const RANGES = { "4W": 28, "3M": 91, "1Y": 365, All: null };
const inRange = (date, range) => !RANGES[range] || date >= addDays(todayStr(), -RANGES[range]);

/* =====================================================================
   Chart (inline SVG, no dependencies)
   ===================================================================== */

/* Charts register their points so a tap or drag can show the nearest value. */
const chartPoints = new Map();
let chartSeq = 0;

function chart({ line = [], dots = [], prs = [], goal = null, label = "", inspect = null, hollow = false, fmt = (y) => y }) {
  const all = [...line, ...dots];
  if (!all.length) return `<div class="empty">No data in this range yet</div>`;
  const W = 340, H = 180, L = 34, R = 8, T = 10, B = 24;
  const ys = all.map((p) => p.y);
  if (goal != null) ys.push(goal);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (max - min < 1) { min -= 1; max += 1; }
  const padY = (max - min) * 0.08;
  min -= padY; max += padY;
  const dates = all.map((p) => p.x).sort();
  const t0 = parseDate(dates[0]).getTime();
  const t1 = parseDate(dates[dates.length - 1]).getTime();
  const span = t1 - t0;
  const X = (x) => (span ? L + ((parseDate(x).getTime() - t0) / span) * (W - L - R) : (L + W - R) / 2);
  const Y = (y) => T + (1 - (y - min) / (max - min)) * (H - T - B);
  const f = (n) => n.toFixed(1);
  const yLabel = (v) => (Math.abs(max - min) > 50 ? Math.round(v).toLocaleString() : Math.round(v * 10) / 10);

  let out = "";
  for (const k of [0, 0.5, 1]) {
    const v = max - (max - min) * k;
    const y = T + k * (H - T - B);
    out += `<line class="grid" x1="${L}" x2="${W - R}" y1="${f(y)}" y2="${f(y)}"/><text x="0" y="${f(y + 4)}">${yLabel(v)}</text>`;
  }
  // x labels: up to 4 evenly spaced dates, as months on long ranges
  const nLabels = span ? 4 : 1;
  const long = span > 80 * 86400000;
  for (let i = 0; i < nLabels; i++) {
    const t = nLabels === 1 ? t0 : t0 + (span * i) / (nLabels - 1);
    const txt = new Date(t).toLocaleDateString(undefined, long ? { month: "short" } : { day: "numeric", month: "short" });
    const x = nLabels === 1 ? (L + W - R) / 2 : L + ((W - L - R) * i) / (nLabels - 1);
    const anchor = nLabels === 1 ? "middle" : i === 0 ? "start" : i === nLabels - 1 ? "end" : "middle";
    out += `<text x="${f(x)}" y="${H - 6}" text-anchor="${anchor}">${esc(txt)}</text>`;
  }
  if (goal != null) {
    out += `<line class="goal" x1="${L}" x2="${W - R}" y1="${f(Y(goal))}" y2="${f(Y(goal))}"/><text class="goal-t" x="${W - R}" y="${f(Y(goal) - 5)}" text-anchor="end">Goal ${round1(goal)}</text>`;
  }
  if (dots.length) out += dots.map((p) => `<circle class="daily" cx="${f(X(p.x))}" cy="${f(Y(p.y))}" r="3"/>`).join("");
  if (line.length > 1) out += `<polyline class="line" points="${line.map((p) => `${f(X(p.x))},${f(Y(p.y))}`).join(" ")}"/>`;
  if (hollow && line.length <= 60) {
    out += line.map((p) => `<circle class="${p.solid ? "pt" : "pt-hollow"}" cx="${f(X(p.x))}" cy="${f(Y(p.y))}" r="${p.solid ? 4 : 3.5}"/>`).join("");
  } else if (line.length === 1) {
    out += `<circle class="pt" cx="${f(X(line[0].x))}" cy="${f(Y(line[0].y))}" r="4"/>`;
  }
  out += prs.map((p) => `<circle class="pr" cx="${f(X(p.x))}" cy="${f(Y(p.y))}" r="5"/>`).join("");

  const id = ++chartSeq;
  const pts = (inspect || line.length ? inspect || line : dots).map((p) => ({ px: X(p.x), py: Y(p.y), x: p.x, t: p.text ?? fmt(p.y) }));
  chartPoints.set(String(id), { pts, W, H, T, B });
  if (chartPoints.size > 20) chartPoints.delete(chartPoints.keys().next().value);
  return `<svg class="chart" data-chart="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${out}<g class="insp"></g></svg>`;
}

// Tap or drag on a chart: guide line and a label for the nearest point.
function inspectChart(svg, clientX) {
  const c = chartPoints.get(svg.dataset.chart);
  if (!c || !c.pts.length) return;
  const box = svg.getBoundingClientRect();
  const x = ((clientX - box.left) / box.width) * c.W;
  let best = c.pts[0];
  for (const p of c.pts) if (Math.abs(p.px - x) < Math.abs(best.px - x)) best = p;
  best.text ??= `${fmtDate(best.x, { day: "numeric", month: "short" })}: ${best.t}`;
  const tw = best.text.length * 6.2 + 16;
  const lx = Math.min(Math.max(best.px - tw / 2, 0), c.W - tw);
  svg.querySelector(".insp").innerHTML =
    `<line class="guide" x1="${best.px}" x2="${best.px}" y1="${c.T}" y2="${c.H - c.B}"/>` +
    `<circle class="insp-dot" cx="${best.px}" cy="${best.py}" r="5"/>` +
    `<rect class="tip" x="${lx}" y="0" width="${tw}" height="22" rx="11"/>` +
    `<text class="tip-t" x="${lx + tw / 2}" y="15" text-anchor="middle">${esc(best.text)}</text>`;
}

// Weekly bodyweight change: one bar per Monday–Sunday week, up for gain, down for loss.
function weekBars(weeks) {
  if (!weeks.length) return `<div class="empty small">Weekly bars appear after two weigh-ins in a week.</div>`;
  const W = 340, H = 130, T = 14, B = 22, L = 4, R = 4;
  const maxAbs = Math.max(0.2, ...weeks.map((w) => Math.abs(w.change)));
  const mid = T + (H - T - B) / 2;
  const half = (H - T - B) / 2;
  const slot = (W - L - R) / weeks.length;
  const bw = Math.min(28, slot * 0.6);
  const every = Math.ceil(weeks.length / 6);
  let out = `<line class="grid" x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}"/>`;
  weeks.forEach((w, i) => {
    const h = (Math.abs(w.change) / maxAbs) * half;
    const x = L + slot * i + (slot - bw) / 2;
    const y = w.change >= 0 ? mid - h : mid;
    out += `<rect class="${w.change >= 0 ? "bar-up" : "bar-down"}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1.5, h).toFixed(1)}" rx="3"/>`;
    if (weeks.length <= 8) out += `<text x="${(x + bw / 2).toFixed(1)}" y="${(w.change >= 0 ? y - 3 : y + h + 11).toFixed(1)}" text-anchor="middle" class="bar-v">${signed(toDisplay(w.change))}</text>`;
    if (i % every === 0) out += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(fmtDate(w.week, { day: "numeric", month: "short" }))}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly bodyweight change">${out}</svg>`;
}

function sparkline(values) {
  if (values.length < 2) return `<svg width="64" height="24" aria-hidden="true"></svg>`;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(2 + (i * 60) / (values.length - 1)).toFixed(1)},${(22 - ((v - min) / span) * 20).toFixed(1)}`).join(" ");
  return `<svg width="64" height="24" viewBox="0 0 64 24" aria-hidden="true"><polyline class="spark" points="${pts}"/></svg>`;
}

/* =====================================================================
   Tabs: each tab has its own container, rendered only when its data changed.
   Switching tabs keeps each tab's scroll position.
   ===================================================================== */

const VIEWS = { today: viewToday, plan: viewPlan, progress: viewProgress, body: viewBody, more: viewMore };
const viewEl = (t) => document.querySelector(`.view[data-view="${t}"]`);

function renderTab(t = ui.tab) {
  viewEl(t).innerHTML = VIEWS[t]();
  ui.dirty[t] = false;
  if (t === "more") showPersistStatus();
}

function showTab(t) {
  if (t === ui.tab) {
    if (ui.dirty[t]) renderTab(t);
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  ui.scroll[ui.tab] = window.scrollY;
  viewEl(ui.tab).hidden = true;
  ui.tab = t;
  if (ui.dirty[t]) renderTab(t);
  viewEl(t).hidden = false;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  window.scrollTo(0, ui.scroll[t] || 0);
}

// Re-render the visible tab in place, keeping scroll.
function refresh() {
  const y = window.scrollY;
  renderTab(ui.tab);
  window.scrollTo(0, y);
}

/* ---------- Today ---------- */

function viewToday() {
  const today = todayStr();
  const tpl = planFor(today);
  const sess = active();

  // Week strip, Monday to Sunday
  const mon = mondayOf(today);
  const trainedDays = new Set(state.sessions.filter((s) => s.entries.some((e) => e.sets.some((x) => x.done))).map((s) => s.date));
  let planned = 0, done = 0;
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(mon, i);
    const isPlanned = !!planFor(d);
    if (isPlanned) planned++;
    if (trainedDays.has(d)) done++;
    let cls = "";
    if (d === today) cls = "today";
    else if (trainedDays.has(d)) cls = "done";
    else if (isPlanned && d > today) cls = "plan";
    return `<div><span class="dl">${"MTWTFSS"[i]}</span><span class="dn ${cls}">${parseDate(d).getDate()}</span></div>`;
  }).join("");

  const latestBw = [...state.bodyweight].sort((a, b) => a.date.localeCompare(b.date)).pop();
  const monthStart = today.slice(0, 8) + "01";
  const prs = state.sessions.filter((s) => s.date >= monthStart).reduce((n, s) => n + (prCounts().get(s.id) || 0), 0);

  const recent = sortedSessions().filter((s) => s.id !== state.activeSessionId).slice(0, 8);

  let main;
  if (sess) {
    main = `<div class="card stack">
      <div class="label">In progress</div>
      <div class="big-name">${esc(sess.name)}</div>
      <button class="primary full" data-action="resume">Resume workout</button>
    </div>`;
  } else {
    main = `<div class="card stack">
      <div class="row between">
        <span class="label">${tpl ? "Planned for today" : "Rest day"}</span>
        <button class="ghost" style="min-height:36px;margin-right:-8px" data-action="toggle-pick" aria-expanded="${ui.pickOpen}">${ui.pickOpen ? "Close" : "Change"}</button>
      </div>
      ${ui.pickOpen ? planPicker(today, { empty: true }) : `
      <div class="big-name">${tpl ? `${esc(tpl.name)} day` : "Nothing planned"}</div>
      ${tpl ? `<ul class="list first-line">${planItems(tpl).map((it) => `<li style="min-height:40px;padding:8px 2px">
          <span class="grow">${esc(exById(it.exerciseId).name)}</span><span class="muted small num">${esc(itemText(it))}</span></li>`).join("")}</ul>`
        : `<div class="muted small">Tap Change to pick a plan for today.</div>`}
      ${tpl ? `<button class="primary full" data-action="start" data-tpl="${tpl.id}"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="vertical-align:-3px;margin-right:6px"><path d="M7 4.5v15l12-7.5z"/></svg>Start ${esc(tpl.name)}</button>` : ""}`}
    </div>`;
  }

  return `
    <div>
      <div class="eyebrow">${esc(fmtDate(today, { weekday: "long", day: "numeric", month: "long" }))}</div>
      <h1 class="title">Today</h1>
    </div>
    <div class="week">${week}</div>
    ${main}
    <div class="stats">
      <div class="stat"><b>${done} / ${planned}</b><span>Workouts this week</span></div>
      <div class="stat"><b>${latestBw ? toDisplay(latestBw.kg) : "–"}</b><span>Bodyweight (${unit()})</span></div>
      <div class="stat"><b>${prs}</b><span>PRs this month</span></div>
    </div>
    <div>
      <h2 style="margin:0 4px 4px">Recent</h2>
      ${recent.length ? `<ul class="list">${recent.map((s) => {
        const sets = s.entries.reduce((n, e) => n + doneSets(e).length, 0);
        const pr = prCounts().get(s.id) || 0;
        return `<li class="tap" data-action="open-session" data-id="${s.id}">
          <div class="grow"><div class="t">${esc(s.name)}</div><div class="muted small">${s.entries.length} exercises · ${sets} sets${pr ? ` · ${pr} PR${pr > 1 ? "s" : ""}` : ""}</div></div>
          <span class="muted small">${esc(relDay(s.date))}</span></li>`;
      }).join("")}</ul>` : `<div class="empty">Finished workouts show up here.</div>`}
    </div>`;
}

// List of plans to assign to a date. On Today it can also start an empty workout.
function planPicker(date, { empty = false } = {}) {
  const cur = planFor(date);
  return `<ul class="list first-line">
    ${state.templates.map((t) => `<li class="tap" data-action="assign" data-date="${date}" data-tpl="${t.id}">
      <div class="grow"><div class="t">${esc(t.name)}</div><div class="muted small">${esc(planSummary(t))}</div></div>
      ${cur?.id === t.id ? `<span class="up">✓</span>` : ""}</li>`).join("")}
    <li class="tap" data-action="assign" data-date="${date}" data-tpl=""><span class="t grow">Rest</span>${!cur ? `<span class="up">✓</span>` : ""}</li>
    ${empty ? `<li class="tap" data-action="start" data-tpl=""><span class="t grow">Start an empty workout</span></li>` : ""}
  </ul>`;
}

/* ---------- Plan ---------- */

function viewPlan() {
  if (ui.editTemplateId && ui.editFrom === "plan") return viewTemplateEditor(tplById(ui.editTemplateId));
  const today = todayStr();
  const dates = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  for (const d of ui.extraDates) if (!dates.includes(d)) dates.push(d);
  dates.sort();
  const order = [1, 2, 3, 4, 5, 6, 0];
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const rows = dates.map((d) => {
    const t = planFor(d);
    const open = ui.calOpen === d;
    const overridden = d in state.calendar;
    return `<li class="cal ${d === today ? "is-today" : ""}" style="display:block">
      <div class="row tap" data-action="cal-toggle" data-date="${d}">
        <div class="cal-date"><b>${esc(parseDate(d).toLocaleDateString(undefined, { weekday: "short" }))}</b><span class="muted small">${parseDate(d).getDate()} ${esc(parseDate(d).toLocaleDateString(undefined, { month: "short" }))}</span></div>
        <div class="grow"><div class="t">${t ? esc(t.name) : `<span class="muted">Rest</span>`}</div>${t ? `<div class="muted small">${esc(planSummary(t))}</div>` : ""}</div>
        <span class="muted">${open ? "▴" : "▾"}</span>
      </div>
      ${open ? `<div class="cal-panel">
        ${planPicker(d)}
        <div class="row" style="margin-top:10px">
          <label class="grow"><span class="muted small">Move to another day (swaps the two)</span>
            <input type="date" data-field="cal-move" data-date="${d}" min="${today}"></label>
        </div>
        ${overridden && state.schedule[parseDate(d).getDay()] !== undefined ? `<button class="text full" data-action="cal-default" data-date="${d}">Use weekly default</button>` : ""}
      </div>` : ""}
    </li>`;
  }).join("");

  return `
    <h1 class="title">Plan</h1>
    <div class="card">
      <div class="row between"><h2>Upcoming</h2><span class="muted small">Tap a day to change it</span></div>
      <ul class="list" style="margin-top:6px">${rows}</ul>
      <label class="field" style="margin-top:12px"><span>Plan a later date</span><input type="date" data-field="cal-jump" min="${today}"></label>
    </div>
    <div>
      <h2 style="margin:0 4px 8px">Plans</h2>
      <div class="stack">
      ${state.templates.map((t) => `<div class="card tight tap" data-action="edit-tpl" data-id="${t.id}">
        <div class="row between"><h3>${esc(t.name)}</h3><span class="muted">Edit ›</span></div>
        <div class="muted small" style="margin-top:4px">${planItems(t).map((it) => esc(exById(it.exerciseId).name)).join(" · ") || "No exercises yet"}</div>
      </div>`).join("")}
      <button class="dashed full" data-action="new-tpl">+ New plan</button>
      </div>
    </div>
    <div class="card">
      <button class="text full" style="justify-content:space-between;display:flex;align-items:center;padding:0;color:var(--text)" data-action="toggle-weekly" aria-expanded="${ui.weeklyOpen}">
        <span><b>Repeat weekly</b> <span class="muted small" style="font-weight:400">(optional defaults)</span></span><span class="muted">${ui.weeklyOpen ? "▴" : "▾"}</span>
      </button>
      ${ui.weeklyOpen ? `<div class="muted small" style="margin:6px 0 8px">Days you haven't planned by date use these. Set all to Rest to plan only by date.</div>
      ${order.map((d) => `<div class="day">
        <b>${names[d]}</b>
        <select data-field="schedule" data-day="${d}" aria-label="${names[d]} default">
          <option value="">Rest</option>
          ${state.templates.map((t) => `<option value="${t.id}" ${state.schedule[d] === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
        </select>
      </div>`).join("")}` : ""}
    </div>`;
}

function viewTemplateEditor(t) {
  if (!t) { ui.editTemplateId = null; return ui.editFrom === "more" ? viewMore() : viewPlan(); }
  const available = [...state.exercises].sort((a, b) => a.name.localeCompare(b.name));
  const u = unit();
  return `
    <button class="ghost" data-action="tpl-back" style="margin-left:-10px">‹ ${ui.editFrom === "more" ? "More" : "Plan"}</button>
    <label class="field"><span>Plan name</span><input data-field="tpl-name" value="${esc(t.name)}"></label>
    <div class="card">
      <h3>Exercises</h3>
      <div class="muted small">Sets, reps (a number or a range) and target weight. Leave weight empty to use last time's.</div>
      ${t.items.length ? `<ul class="list first-line" style="margin-top:6px">${t.items.map((it, i) => `<li style="display:block">
        <div class="row">
          <span class="grow t">${esc(exById(it.exerciseId)?.name ?? "(deleted)")}</span>
          <button class="ghost icon" data-action="tpl-up" data-i="${i}" aria-label="Move up">↑</button>
          <button class="ghost icon" data-action="tpl-down" data-i="${i}" aria-label="Move down">↓</button>
          <button class="ghost icon" data-action="tpl-remove" data-i="${i}" aria-label="Remove">✕</button>
        </div>
        <div class="item-grid">
          <label><span>Sets</span><input inputmode="numeric" data-field="item" data-i="${i}" data-k="sets" value="${it.sets ?? ""}"></label>
          <label><span>Reps</span><input inputmode="numeric" data-field="item" data-i="${i}" data-k="repsMin" value="${it.repsMin ?? ""}" placeholder="8"></label>
          <label><span>to</span><input inputmode="numeric" data-field="item" data-i="${i}" data-k="repsMax" value="${it.repsMax ?? ""}" placeholder="–"></label>
          <label><span>${u}</span><input inputmode="decimal" data-field="item" data-i="${i}" data-k="targetKg" value="${it.targetKg != null ? toDisplay(it.targetKg) : ""}" placeholder="last"></label>
        </div>
      </li>`).join("")}</ul>` : `<div class="muted small" style="margin-top:6px">No exercises yet.</div>`}
    </div>
    <div class="card stack">
      <h3>Add an exercise</h3>
      <select id="tplAddPick" aria-label="Exercise">${available.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select>
      <button class="full" data-action="tpl-add">Add</button>
      <div class="row"><input class="grow" id="newExName" placeholder="New exercise, e.g. Cable Fly"><button data-action="tpl-add-new">Create</button></div>
    </div>
    <button class="full" data-action="tpl-duplicate">Duplicate plan</button>
    <button class="danger full" data-action="tpl-delete">Delete plan</button>`;
}

/* ---------- Progress ---------- */

const METRICS = {
  e1rm: { label: "Est. max" },
  top: { label: "Heaviest" },
  volume: { label: "Volume" },
};
const REP_MAXES = [1, 3, 5, 10];

// A session's N-rep max: estimated from its best set (Epley), or the weight
// actually lifted for exactly N reps when that is higher (drawn solid).
function repMaxOf(row, n) {
  const est = n === 1 ? row.e1rm : row.e1rm / (1 + n / 30);
  const actual = Math.max(0, ...row.sets.filter((x) => x.reps === n).map((x) => x.weight));
  return actual >= est - 1e-9 && actual > 0 ? { v: actual, solid: true } : { v: est, solid: false };
}

function viewProgress() {
  const withData = state.exercises.filter((x) => exerciseHistory(x.id).length);
  if (!withData.length) {
    return `<h1 class="title">Progress</h1><div class="card empty">Finish a workout with some sets ticked off and your progress will show up here.</div>`;
  }
  const p = ui.progress;
  if (!withData.some((x) => x.id === p.ex)) p.ex = withData[0].id;
  const n = ui.repMax[p.ex] || 1;
  const all = exerciseHistory(p.ex);

  // Series for the chosen metric over all history, with PRs = new all-time bests.
  let best = -Infinity;
  const series = all.map((r, i) => {
    const pt = p.metric === "e1rm" ? repMaxOf(r, n) : { v: p.metric === "top" ? r.top : r.volume, solid: true };
    const pr = i > 0 && pt.v > best + 1e-9;
    best = Math.max(best, pt.v);
    return { date: r.date, ...pt, pr, row: r };
  });
  const hist = series.filter((h) => inRange(h.date, p.range));
  const latest = hist[hist.length - 1];
  const change = hist.length > 1 ? latest.v - hist[0].v : null;
  const rangeTxt = { "4W": "in 4 weeks", "3M": "in 3 months", "1Y": "in a year", All: "overall" }[p.range];
  const isVol = p.metric === "volume";
  const val = (kg) => (isVol ? Math.round(toDisplay(kg)).toLocaleString() : toDisplay(kg));
  const bestAll = Math.max(...series.map((s) => s.v));
  const prsInRange = hist.filter((h) => h.pr).length;
  const metricName = p.metric === "e1rm" ? `est. ${n}RM` : p.metric === "top" ? "heaviest set" : "volume";

  const allLifts = withData.map((x) => {
    const h = exerciseHistory(x.id).filter((r) => inRange(r.date, p.range));
    const b = exerciseHistory(x.id).reduce((acc, r) => (r.e1rm > acc.e1rm ? r : acc));
    const chg = h.length > 1 ? toDisplay(h[h.length - 1].e1rm - h[0].e1rm) : null;
    return `<li class="tap" data-action="pick-lift" data-id="${x.id}">
      <div class="grow"><div class="t">${esc(x.name)}</div><div class="muted small">Best ${toDisplay(b.best.weight)} ${unit()} × ${b.best.reps}</div></div>
      ${sparkline(h.map((r) => r.e1rm))}
      <div class="chg" style="${chg != null && chg < 0 ? "color:var(--muted)" : ""}">${chg == null ? "–" : signed(chg)}</div>
    </li>`;
  }).join("");

  return `
    <h1 class="title">Progress</h1>
    <div class="scroller">${withData.map((x) => `<button class="pill ${x.id === p.ex ? "on" : ""}" data-action="pick-lift" data-id="${x.id}">${esc(x.name)}</button>`).join("")}</div>
    <div class="card stack">
      <div class="seg">${Object.entries(METRICS).map(([k, v]) => `<button class="${k === p.metric ? "on" : ""}" data-action="metric" data-m="${k}">${v.label}</button>`).join("")}</div>
      ${p.metric === "e1rm" ? `<div class="ranges">${REP_MAXES.map((r) => `<button class="${r === n ? "on" : ""}" data-action="repmax" data-n="${r}">${r}RM</button>`).join("")}</div>` : ""}
      ${latest ? `<div class="row" style="align-items:baseline;flex-wrap:wrap">
        <div class="big-val">${val(latest.v)}<small> ${unit()}</small></div>
        ${change != null ? `<div class="up" style="${change < 0 ? "color:var(--muted)" : ""}">${signed(val(change))} ${rangeTxt}</div>` : ""}
      </div>` : ""}
      ${chart({
        line: hist.map((h) => ({ x: h.date, y: +toDisplay(h.v), solid: h.solid })),
        prs: hist.filter((h) => h.pr).map((h) => ({ x: h.date, y: +toDisplay(h.v) })),
        inspect: hist.map((h) => ({ x: h.date, y: +toDisplay(h.v), text: `${val(h.v)} ${unit()}${p.metric === "e1rm" && !h.solid ? " est." : ""}${h.pr ? " · PR" : ""}` })),
        hollow: p.metric === "e1rm" && n > 1,
        label: `${exById(p.ex)?.name} ${metricName}`,
      })}
      <div class="row between" style="flex-wrap:wrap">
        <div class="ranges">${Object.keys(RANGES).map((r) => `<button class="${r === p.range ? "on" : ""}" data-action="range" data-r="${r}">${r}</button>`).join("")}</div>
        <div class="legend">
          ${p.metric === "e1rm" && n > 1 ? `<span><i style="width:8px;height:8px;border-radius:99px;border:2px solid var(--accent)"></i>est.</span>` : ""}
          <span><i style="width:10px;height:10px;border-radius:99px;background:var(--amber)"></i>PR</span>
        </div>
      </div>
      <div class="muted small">Tap or drag on the chart to see each session.</div>
    </div>
    <div class="stats">
      <div class="stat"><b>${val(bestAll)}</b><span>Best ${esc(metricName)}</span></div>
      <div class="stat"><b>${prsInRange}</b><span>PRs ${p.range === "All" ? "overall" : `in ${p.range}`}</span></div>
      <div class="stat"><b>${toDisplay(Math.max(...all.map((r) => r.top)))}</b><span>Heaviest (${unit()})</span></div>
    </div>
    <div>
      <h2 style="margin:0 4px 4px">All lifts${RANGES[p.range] ? `, last ${p.range === "4W" ? "4 weeks" : p.range === "3M" ? "3 months" : "year"}` : ""}</h2>
      <div class="muted small" style="margin:0 4px 4px">Change in estimated 1RM</div>
      <ul class="list">${allLifts}</ul>
    </div>`;
}

/* ---------- Body ---------- */

const bodyEntries = memo(() => [...state.bodyweight].sort((a, b) => a.date.localeCompare(b.date)));
const rollingAvg = memo(() => {
  const e = bodyEntries();
  return e.map((x, i) => {
    const from = addDays(x.date, -6);
    let sum = 0, n = 0;
    for (let j = i; j >= 0 && e[j].date >= from; j--) { sum += e[j].kg; n++; }
    return { date: x.date, kg: sum / n };
  });
});
// Monday–Sunday weeks with at least two weigh-ins: last minus first.
const weeklyChanges = memo(() => {
  const byWeek = new Map();
  for (const e of bodyEntries()) {
    const w = mondayOf(e.date);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(e);
  }
  return [...byWeek].filter(([, es]) => es.length >= 2).map(([week, es]) => ({ week, change: es[es.length - 1].kg - es[0].kg }));
});

const ACTIVITY = [
  { v: 1.2, l: "Sedentary" },
  { v: 1.375, l: "Light" },
  { v: 1.55, l: "Moderate" },
  { v: 1.725, l: "Very active" },
];
const GOALS = {
  lose: { l: "Lose", delta: -500, protein: 2.0, rate: -0.5, note: "about 0.5 kg a week" },
  maintain: { l: "Maintain", delta: 0, protein: 1.6, rate: 0, note: "hold steady" },
  gain: { l: "Gain", delta: 300, protein: 1.8, rate: 0.275, note: "lean bulk, about 0.25–0.3 kg a week" },
};
const round50 = (n) => Math.round(n / 50) * 50;

// Calorie and protein estimates from the profile in More (Mifflin-St Jeor).
function nutritionCard(weightKg) {
  const pr = state.settings.profile;
  if (!pr.heightCm || !pr.age || !weightKg) {
    return `<div class="card stack"><h3>Calories and protein</h3>
      <div class="muted small">Add your height, age and activity in More to see daily estimates.</div>
      <button class="full" data-action="goto-profile">Add details</button></div>`;
  }
  const bmr = 10 * weightKg + 6.25 * pr.heightCm - 5 * pr.age + (pr.sex === "female" ? -161 : 5);
  const tdee = round50(bmr * pr.activity);
  const cards = Object.entries(GOALS).map(([k, g]) => `<div class="kcal ${k === pr.goal ? "on" : ""}">
      <span class="muted small">${g.l}</span>
      <b class="num">${(tdee + g.delta).toLocaleString()}</b><span class="small muted">kcal</span>
      <span class="small num">${Math.round(g.protein * weightKg)} g</span><span class="small muted">protein</span>
    </div>`).join("");

  // Goal check: average of the last three complete weeks.
  const thisMon = mondayOf(todayStr());
  const recent = weeklyChanges().filter((w) => w.week < thisMon).slice(-3);
  let check = "";
  if (recent.length) {
    const rate = recent.reduce((a, w) => a + w.change, 0) / recent.length;
    const g = GOALS[pr.goal];
    const dev = rate - g.rate;
    const kcal = round50(Math.abs(dev) * 7700 / 7);
    const rateTxt = `${rate >= 0 ? "Gaining" : "Losing"} ${toDisplay(Math.abs(rate))} ${unit()}/week`;
    if (Math.abs(dev) < 0.15 || kcal < 100) check = `${rateTxt}, on track to ${g.l.toLowerCase()}.`;
    else check = `${rateTxt}, ${dev > 0 ? (pr.goal === "lose" ? "slower than planned" : "faster than planned") : (pr.goal === "gain" ? "slower than planned" : "faster than planned")} (${g.note}). Try about ${Math.min(kcal, 500)} kcal ${dev > 0 ? "less" : "more"} a day.`;
  }
  return `<div class="card stack">
    <div class="row between"><h3>Calories and protein</h3><span class="muted small">Maintenance ${tdee.toLocaleString()} kcal</span></div>
    <div class="kcals">${cards}</div>
    ${check ? `<div class="small">${esc(check)}</div>` : ""}
    <div class="muted small">Estimate from your ${toDisplay(weightKg)} ${unit()} 7-day average, not medical advice.</div>
  </div>`;
}

function viewBody() {
  const entries = bodyEntries();
  const latest = entries[entries.length - 1];
  const avg = rollingAvg();
  const avg7 = avg.length ? avg[avg.length - 1].kg : null;
  const r = ui.bodyRange;
  const goal = state.settings.goalKg;
  const toGoal = goal != null && (avg7 ?? latest?.kg) != null ? (avg7 ?? latest.kg) - goal : null;

  // This week, resetting each Monday.
  const thisWeek = entries.filter((e) => e.date >= mondayOf(todayStr()));
  const weekChange = thisWeek.length >= 2 ? thisWeek[thisWeek.length - 1].kg - thisWeek[0].kg : null;
  const inR = entries.filter((e) => inRange(e.date, r));
  const rangeChange = inR.length >= 2 ? inR[inR.length - 1].kg - inR[0].kg : null;

  // Log card for the chosen date
  if (!ui.bwDate || ui.bwDate > todayStr()) ui.bwDate = todayStr();
  const d = ui.bwDate;
  const isToday = d === todayStr();
  const existing = entries.find((e) => e.date === d);
  const startVal = existing ? toDisplay(existing.kg) : latest ? toDisplay(latest.kg) : "";
  const rangeTitle = { "4W": "Last 4 weeks", "3M": "Last 3 months", "1Y": "Last year", All: "All time" }[r];
  const weeks = weeklyChanges().filter((w) => inRange(w.week, r) || inRange(addDays(w.week, 6), r));

  return `
    <h1 class="title">Body</h1>
    <div class="card stack" id="bwCard">
      <h3>${isToday ? "Log today's weight" : `Weight for ${esc(fmtDate(d, { weekday: "short", day: "numeric", month: "short" }))}`}</h3>
      <div class="row between" style="margin-top:4px">
          <button class="ghost icon" data-action="bw-day" data-d="-1" aria-label="Previous day">‹</button>
          <input type="date" data-field="bw-date" class="date-inline" value="${d}" max="${todayStr()}" aria-label="Date">
          <button class="ghost icon" data-action="bw-day" data-d="1" aria-label="Next day" ${isToday ? "disabled" : ""}>›</button>
      </div>
      <div class="stepper">
        <button data-action="bw-step" data-d="-0.1" aria-label="Decrease by 0.1">−</button>
        <label class="grow"><span class="sr">Bodyweight in ${unit()}</span><input id="bwInput" inputmode="decimal" value="${startVal}" placeholder="0.0"></label>
        <button data-action="bw-step" data-d="0.1" aria-label="Increase by 0.1">+</button>
      </div>
      <button class="primary full" style="min-height:52px" data-action="bw-save">${existing ? "Update" : "Save"}</button>
    </div>
    <div class="stats two">
      <div class="stat"><b>${latest ? toDisplay(latest.kg) : "–"}</b><span>Latest (${unit()})</span></div>
      <div class="stat"><b>${weekChange != null ? signed(toDisplay(weekChange)) : "–"}</b><span>This week (since Mon)</span></div>
      <div class="stat"><b>${rangeChange != null ? signed(toDisplay(rangeChange)) : "–"}</b><span>${r === "All" ? "All time" : `Last ${r}`}</span></div>
      <div class="stat tap" data-action="goto-goal"><b>${toGoal != null ? toDisplay(Math.abs(toGoal)) : "Set"}</b><span>${toGoal != null ? (Math.abs(toGoal) < 0.05 ? "At goal" : `${unit()} to go`) : "a goal"}</span></div>
    </div>
    <div class="card stack">
      <div class="row between">
        <h3>${rangeTitle}</h3>
        <div class="legend">
          <span><i style="width:14px;height:3px;border-radius:2px;background:var(--accent)"></i>7-day avg</span>
          <span><i style="width:6px;height:6px;border-radius:99px;background:var(--dim)"></i>Daily</span>
        </div>
      </div>
      ${chart({
        dots: inR.map((e) => ({ x: e.date, y: +toDisplay(e.kg) })),
        line: avg.filter((e) => inRange(e.date, r)).map((e) => ({ x: e.date, y: +toDisplay(e.kg) })),
        inspect: inR.map((e, i) => ({ x: e.date, y: +toDisplay(e.kg), text: `${toDisplay(e.kg)} ${unit()} · avg ${toDisplay(avg[entries.length - inR.length + i].kg)}` })),
        goal: goal != null ? +toDisplay(goal) : null,
        label: "Bodyweight trend",
      })}
      <div class="ranges">${Object.keys(RANGES).map((k) => `<button class="${k === r ? "on" : ""}" data-action="body-range" data-r="${k}">${k}</button>`).join("")}</div>
    </div>
    <div class="card stack">
      <div class="row between"><h3>Weekly change</h3><span class="muted small">Mon–Sun</span></div>
      ${weekBars(weeks)}
    </div>
    ${nutritionCard(avg7 ?? latest?.kg)}
    ${entries.length ? `<div><h2 style="margin:0 4px 4px">Entries</h2><div class="muted small" style="margin:0 4px 4px">Tap an entry to edit it</div><ul class="list">
      ${[...entries].reverse().slice(0, 90).map((e) => `<li class="tap" data-action="bw-load" data-date="${e.date}">
        <span class="grow">${esc(fmtDate(e.date))}</span>
        <b class="num">${toDisplay(e.kg)} ${unit()}</b>
        <button class="ghost icon" data-action="bw-delete" data-date="${e.date}" aria-label="Delete entry">✕</button>
      </li>`).join("")}
    </ul></div>` : ""}`;
}

/* ---------- More ---------- */

function viewMore() {
  if (ui.editTemplateId && ui.editFrom === "more") return viewTemplateEditor(tplById(ui.editTemplateId));
  const exercises = [...state.exercises].sort((a, b) => a.name.localeCompare(b.name));
  return `
    <h1 class="title">More</h1>
    <div class="card stack">
      <label class="field"><span>Units</span>
        <select data-field="unit">
          <option value="kg" ${unit() === "kg" ? "selected" : ""}>Kilograms (kg)</option>
          <option value="lb" ${unit() === "lb" ? "selected" : ""}>Pounds (lb)</option>
        </select>
      </label>
      <label class="field"><span>Rest timer after each set</span>
        <select data-field="rest-sec">
          ${[0, 60, 90, 120, 150, 180, 240].map((s) => `<option value="${s}" ${state.settings.restSec === s ? "selected" : ""}>${s ? fmtClock(s) : "Off"}</option>`).join("")}
        </select>
      </label>
      <label class="field" id="goalField"><span>Goal bodyweight (${unit()})</span>
        <input data-field="goal" inputmode="decimal" placeholder="None" value="${state.settings.goalKg != null ? toDisplay(state.settings.goalKg) : ""}">
      </label>
    </div>
    <div class="card">
      <h3>My plans</h3>
      <div class="muted small">Rename, edit or delete plans, or make your own. Tap a plan to edit it.</div>
      <ul class="list" style="margin-top:6px">
        ${state.templates.map((t) => `<li class="tap" data-action="edit-tpl" data-id="${t.id}">
          <div class="grow"><div class="t">${esc(t.name)}</div><div class="muted small">${esc(planSummary(t))}</div></div>
          <span class="muted">Edit ›</span>
        </li>`).join("")}
      </ul>
      <button class="dashed full" style="margin-top:8px" data-action="new-tpl">+ New plan</button>
    </div>
    <div class="card stack" id="profileCard">
      <h3>Body profile</h3>
      <div class="muted small">Used for calorie and protein estimates on Body. Stays on this phone.</div>
      <div class="item-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        <label><span>Height (cm)</span><input inputmode="numeric" data-field="profile" data-k="heightCm" value="${state.settings.profile.heightCm ?? ""}" placeholder="180"></label>
        <label><span>Age</span><input inputmode="numeric" data-field="profile" data-k="age" value="${state.settings.profile.age ?? ""}" placeholder="25"></label>
      </div>
      <label class="field"><span>Sex (for the formula)</span>
        <select data-field="profile" data-k="sex">
          <option value="male" ${state.settings.profile.sex === "male" ? "selected" : ""}>Male</option>
          <option value="female" ${state.settings.profile.sex === "female" ? "selected" : ""}>Female</option>
        </select>
      </label>
      <label class="field"><span>Activity level</span>
        <select data-field="profile" data-k="activity">
          ${ACTIVITY.map((a) => `<option value="${a.v}" ${state.settings.profile.activity === a.v ? "selected" : ""}>${a.l} (×${a.v})</option>`).join("")}
        </select>
      </label>
      <label class="field"><span>Goal</span>
        <select data-field="profile" data-k="goal">
          ${Object.entries(GOALS).map(([k, g]) => `<option value="${k}" ${state.settings.profile.goal === k ? "selected" : ""}>${g.l}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="card stack">
      <h3>Backup</h3>
      <div class="muted small">Your data lives only on this phone. Export a backup now and then (save it to Files or iCloud Drive) so you can restore it on a new phone.</div>
      <div class="muted small" id="persistStatus"></div>
      <button class="full" data-action="export">Export backup</button>
      <button class="full" data-action="import">Restore from backup</button>
    </div>
    <div class="card">
      <h3>Exercise library</h3>
      <div class="row" style="margin:10px 0 4px"><input class="grow" id="libNewName" placeholder="New exercise name"><button data-action="lib-add">Add</button></div>
      <ul class="list">
        ${exercises.map((x) => `<li>
          <span class="grow">${esc(x.name)}</span>
          <button class="ghost" data-action="lib-rename" data-id="${x.id}">Rename</button>
          <button class="ghost icon" data-action="lib-delete" data-id="${x.id}" aria-label="Delete ${esc(x.name)}">✕</button>
        </li>`).join("")}
      </ul>
    </div>
    <button class="danger full" data-action="reset">Erase all data</button>
    <div class="muted small" style="text-align:center">Gym Log · works offline · data stored on this device</div>`;
}

async function showPersistStatus() {
  const el = document.getElementById("persistStatus");
  if (!el || !navigator.storage?.persisted) return;
  const p = await navigator.storage.persisted();
  el.textContent = p ? "Storage is marked persistent on this device." : "Tip: add this app to your home screen so the phone keeps its data.";
}

/* =====================================================================
   Workout screen: full screen, tab bar hidden. Frequent actions (tick a set,
   add or remove a set, typing) patch the DOM directly instead of re-rendering.
   ===================================================================== */

const wEl = () => document.getElementById("workout");

function openWorkout() {
  const s = active();
  if (!s) return;
  ui.scroll[ui.tab] = window.scrollY;
  ui.workoutOpen = true;
  ui.menu = -1;
  if (ui.current >= s.entries.length || ui.current < 0) ui.current = firstUnfinished(s);
  renderWorkout();
  document.body.classList.add("in-workout");
  wEl().hidden = false;
  window.scrollTo(0, 0);
  updateResume();
  if (ui.rest) updateRest(true);
  startTicker();
}

function minimiseWorkout() {
  ui.workoutOpen = false;
  wEl().hidden = true;
  document.getElementById("rest").hidden = true;
  document.body.classList.remove("in-workout");
  if (ui.dirty[ui.tab]) renderTab(ui.tab);
  window.scrollTo(0, ui.scroll[ui.tab] || 0);
  updateResume();
}

function firstUnfinished(s) {
  const i = s.entries.findIndex((e) => !e.sets.length || e.sets.some((x) => !x.done));
  return i < 0 ? 0 : i;
}

function setRowHTML(e, i, j, prev) {
  const x = e.sets[j];
  const p = prev?.sets[j];
  return `<div class="set ${x.done ? "done" : ""}" data-i="${i}" data-j="${j}">
    <div class="n">${j + 1}</div>
    <div class="prev">${p ? `${toDisplay(p.weight)}×${p.reps}` : "—"}</div>
    <label><span class="sr">Weight, set ${j + 1}</span><input inputmode="decimal" data-field="w" value="${toDisplay(x.weight)}" placeholder="${p ? toDisplay(p.weight) : "0"}"></label>
    <label><span class="sr">Reps, set ${j + 1}</span><input inputmode="numeric" data-field="r" value="${x.reps ?? ""}" placeholder="${p ? p.reps : "0"}"></label>
    <button class="tick" data-action="tick" aria-label="Mark set ${j + 1} done" aria-pressed="${!!x.done}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
  </div>`;
}

// All planned sets done and each hit the bottom of the rep range.
function targetMet(e) {
  const t = e.target;
  if (!t || !t.sets) return e.sets.length > 0 && e.sets.every((x) => x.done);
  const done = e.sets.filter((x) => x.done && x.reps != null);
  return done.length >= t.sets && done.slice(0, t.sets).every((x) => t.repsMin == null || x.reps >= t.repsMin);
}

// "Ready for +2.5 kg?" when every planned set hit the top of the range last time.
function progressionHint(s, e) {
  const t = e.target;
  if (!t || t.repsMax == null || !s.templateId || !tplById(s.templateId)) return null;
  const prev = lastPerformance(e.exerciseId, s.id);
  if (!prev || prev.sets.length < t.sets) return null;
  if (!prev.sets.slice(0, t.sets).every((x) => x.reps >= t.repsMax)) return null;
  const base = Math.max(...prev.sets.slice(0, t.sets).map((x) => x.weight));
  const step = unit() === "kg" ? 2.5 : 5 * KG_PER_LB;
  if (e.sets.some((x) => x.done)) return null;
  // Already planning more than last time: nothing to suggest.
  if ((t.targetKg ?? 0) > base + 1e-6) return null;
  if (e.sets.length && e.sets[0].weight != null && e.sets[0].weight > base + 1e-6) return null;
  return { base, next: base + step };
}

function entryHTML(s, e, i) {
  const prev = lastPerformance(e.exerciseId, s.id);
  const done = e.sets.filter((x) => x.done).length;
  const plan = e.target && e.target.sets ? `Plan: ${itemText(e.target)}` : "";
  if (i !== ui.current) {
    return `<div class="card tight compact tap ${targetMet(e) ? "complete" : ""}" data-action="focus-entry" data-i="${i}">
      <div class="grow"><div class="t" style="font-weight:600">${esc(e.name)}</div><div class="muted small">${esc(plan || (prev ? `Last: ${describeSets(prev.sets)}` : "First time"))}</div></div>
      <div class="prog muted small num">${done} / ${e.sets.length}</div>
    </div>`;
  }
  return `<div class="card ${targetMet(e) ? "met" : ""}" data-entry="${i}">
    <div class="row between" style="align-items:flex-start">
      <div class="grow">
        <div class="ex-name">${esc(e.name)}</div>
        ${plan ? `<div class="small plan-line ${targetMet(e) ? "met" : ""}">${esc(plan)}</div>` : ""}
        <div class="muted small">${prev ? `Last time: ${esc(describeSets(prev.sets))}` : "First time logging this"}</div>
        ${(() => { const h = progressionHint(s, e); return h ? `<button class="hint" data-action="bump" data-i="${i}">Ready for +${toDisplay(h.next - h.base)} ${unit()}? Use ${toDisplay(h.next)}</button>` : ""; })()}
      </div>
      <button class="ghost icon" data-action="entry-menu" data-i="${i}" aria-label="Exercise options" aria-expanded="${ui.menu === i}"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>
    </div>
    ${ui.menu === i ? `<div class="menu">
      ${i > 0 ? `<button data-action="entry-up" data-i="${i}">Move up</button>` : ""}
      <button data-action="set-remove" data-i="${i}" ${e.sets.length ? "" : "disabled"}>Remove last set</button>
      <button class="danger" data-action="entry-remove" data-i="${i}">Remove exercise</button>
    </div>` : ""}
    <div class="sets-head"><div>Set</div><div>Before</div><div>${unit()}</div><div>Reps</div><div></div></div>
    <div class="setlist">${e.sets.map((_, j) => setRowHTML(e, i, j, prev)).join("")}</div>
    <button class="dashed full" style="margin-top:10px" data-action="set-add" data-i="${i}">+ Add set</button>
  </div>`;
}

function renderWorkout() {
  const s = active();
  if (!s) return;
  const sorted = [...state.exercises].sort((a, b) => a.name.localeCompare(b.name));
  wEl().innerHTML = `
    <header class="wbar">
      <button class="icon" data-action="minimise" aria-label="Minimise workout"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
      <div class="center grow"><b>${esc(s.name)}</b><span class="muted small num" id="wmeta"></span></div>
      <button class="finish" data-action="finish">${s.finished ? "Done" : "Finish"}</button>
    </header>
    <div class="wbody">
      ${s.entries.map((e, i) => entryHTML(s, e, i)).join("")}
      ${s.entries.length ? "" : `<div class="card empty">Add your first exercise below.</div>`}
      <div class="card stack">
        <h3>Add exercise</h3>
        <select id="addExPick" aria-label="Exercise">${sorted.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select>
        <button class="full" data-action="session-add-ex">Add to workout</button>
      </div>
      <div class="card stack">
        <h3>Details</h3>
        <label class="field"><span>Name</span><input data-field="s-name" value="${esc(s.name)}"></label>
        <label class="field"><span>Date</span><input type="date" data-field="s-date" value="${s.date}"></label>
        <label class="field"><span>Notes</span><textarea data-field="s-notes" placeholder="How did it feel?">${esc(s.notes || "")}</textarea></label>
        <button class="danger full" data-action="delete-session">Delete workout</button>
      </div>
    </div>`;
  updateWorkoutMeta();
}

function updateMet(i) {
  const e = active().entries[i];
  const card = wEl().querySelector(`[data-entry="${i}"]`);
  if (!card) return;
  const met = targetMet(e);
  card.classList.toggle("met", met);
  card.querySelector(".plan-line")?.classList.toggle("met", met);
}

function updateWorkoutMeta() {
  const s = active();
  const el = document.getElementById("wmeta");
  if (!s || !el) return;
  const total = s.entries.reduce((n, e) => n + e.sets.length, 0);
  const done = s.entries.reduce((n, e) => n + e.sets.filter((x) => x.done).length, 0);
  const time = !s.finished && s.startedAt ? fmtClock((Date.now() - s.startedAt) / 1000) : fmtDate(s.date, { day: "numeric", month: "short" });
  const txt = `${time} · ${done} of ${total} sets`;
  if (el.textContent !== txt) el.textContent = txt;
}

function updateResume() {
  const s = active();
  const show = !!s && !ui.workoutOpen;
  const el = document.getElementById("resume");
  el.hidden = !show;
  document.body.classList.toggle("has-resume", show);
  if (show) {
    document.getElementById("resumeName").textContent = s.name;
    document.getElementById("resumeTime").textContent = s.startedAt && !s.finished ? fmtClock((Date.now() - s.startedAt) / 1000) : "";
  }
}

/* One 1-second ticker updates the clock texts and rest timer; nothing re-renders. */
let ticker = null;
function startTicker() {
  if (ticker) return;
  ticker = setInterval(tick, 1000);
}
function tick() {
  if (document.hidden) return;
  const s = active();
  if (!s && !ui.rest) { clearInterval(ticker); ticker = null; return; }
  if (ui.workoutOpen) updateWorkoutMeta();
  else if (s) document.getElementById("resumeTime").textContent = s.startedAt && !s.finished ? fmtClock((Date.now() - s.startedAt) / 1000) : "";
  updateRest();
}

function startRest() {
  const sec = state.settings.restSec;
  if (!sec) return;
  ui.rest = { end: Date.now() + sec * 1000, total: sec };
  const bar = document.getElementById("restBar");
  bar.style.transition = "none";
  bar.style.transform = "scaleX(1)";
  document.getElementById("rest").hidden = !ui.workoutOpen;
  updateRest(true);
  startTicker();
}
function updateRest(immediate) {
  const el = document.getElementById("rest");
  if (!ui.rest) { el.hidden = true; return; }
  const left = (ui.rest.end - Date.now()) / 1000;
  if (left <= 0) {
    ui.rest = null;
    el.hidden = true;
    buzz([120, 80, 120]);
    if (ui.workoutOpen) toast("Rest over");
    return;
  }
  el.hidden = !ui.workoutOpen;
  document.getElementById("restTime").textContent = fmtClock(Math.ceil(left));
  const bar = document.getElementById("restBar");
  // Animate towards where the bar will be in one second, so it glides smoothly.
  requestAnimationFrame(() => {
    bar.style.transition = immediate ? "none" : "";
    bar.style.transform = `scaleX(${Math.max(0, (left - (immediate ? 0 : 1)) / ui.rest.total)})`;
    if (immediate) requestAnimationFrame(() => { bar.style.transition = ""; bar.style.transform = `scaleX(${Math.max(0, (left - 1) / ui.rest.total)})`; });
  });
}

// A workout entry, prefilled from the plan line (sets, target reps and weight),
// falling back to what was lifted last time.
function newEntry(exerciseId, item = null) {
  const ex = exById(exerciseId);
  const last = lastPerformance(exerciseId);
  let sets;
  if (item && item.sets > 0) {
    sets = Array.from({ length: item.sets }, (_, j) => {
      const lastSet = last?.sets[Math.min(j, last.sets.length - 1)];
      return {
        weight: item.targetKg ?? lastSet?.weight ?? null,
        reps: item.repsMin ?? lastSet?.reps ?? null,
        done: false,
      };
    });
  } else if (last) {
    sets = last.sets.map((x) => ({ weight: x.weight, reps: x.reps, done: false }));
  } else {
    sets = Array.from({ length: 3 }, () => ({ weight: null, reps: null, done: false }));
  }
  // Copy of the plan line, so later plan edits never rewrite history.
  const target = item ? { sets: item.sets, repsMin: item.repsMin, repsMax: item.repsMax, targetKg: item.targetKg } : null;
  return { exerciseId, name: ex?.name ?? "Exercise", sets, target };
}

function startSession(tplId) {
  const tpl = tplId && tplById(tplId);
  const s = {
    id: uid(),
    date: todayStr(),
    startedAt: Date.now(),
    name: tpl ? tpl.name : "Workout",
    templateId: tpl?.id ?? null,
    entries: tpl ? planItems(tpl).map((it) => newEntry(it.exerciseId, it)) : [],
    notes: "",
    finished: false,
  };
  state.sessions.push(s);
  state.activeSessionId = s.id;
  ui.current = 0;
  ui.pickOpen = false;
  // Starting a plan today records it on the calendar too.
  if (tpl && planFor(s.date)?.id !== tpl.id) state.calendar[s.date] = tpl.id;
  changed();
  openWorkout();
}

function closeSession() {
  state.activeSessionId = null;
  ui.rest = null;
  document.getElementById("rest").hidden = true;
  changed();
  minimiseWorkout();
}

/* =====================================================================
   Events
   ===================================================================== */

function moveItem(arr, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return false;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return true;
}

function addExercise(name) {
  name = name.trim();
  if (!name) return null;
  const existing = state.exercises.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const ex = { id: uid(), name, category: null };
  state.exercises.push(ex);
  return ex;
}

function rowOf(el) {
  const row = el.closest(".set");
  return { row, i: +row.dataset.i, j: +row.dataset.j };
}

const actions = {
  /* Today */
  start: (el) => startSession(el.dataset.tpl || null),
  "toggle-pick": () => { ui.pickOpen = !ui.pickOpen; refresh(); },
  resume: () => openWorkout(),
  "open-session": (el) => {
    if (state.activeSessionId && state.activeSessionId !== el.dataset.id) {
      toast("Finish your current workout first");
      return;
    }
    state.activeSessionId = el.dataset.id;
    ui.current = 0;
    changed();
    openWorkout();
  },

  /* Workout */
  minimise: () => minimiseWorkout(),
  finish: () => {
    const s = active();
    if (s && !s.entries.some((e) => e.sets.some((x) => x.done))) {
      if (!confirm("No sets are ticked off. Discard this workout?")) return;
      state.sessions = state.sessions.filter((x) => x.id !== s.id);
      closeSession();
      return;
    }
    const wasFinished = s.finished;
    s.finished = true;
    if (!wasFinished && s.startedAt) s.durationSec = Math.round((Date.now() - s.startedAt) / 1000);
    closeSession();
    if (ui.tab !== "today") showTab("today");
    const prs = prCounts().get(s.id) || 0;
    toast(wasFinished ? "Workout updated" : prs ? `Workout saved · ${prs} PR${prs > 1 ? "s" : ""}` : "Workout saved");
  },
  "delete-session": () => {
    if (!confirm("Delete this workout?")) return;
    state.sessions = state.sessions.filter((x) => x.id !== state.activeSessionId);
    closeSession();
  },
  tick: (el) => {
    const s = active();
    const { row, i, j } = rowOf(el);
    const x = s.entries[i].sets[j];
    x.done = !x.done;
    if (x.done) {
      // An empty set takes the values shown as placeholders (last time).
      const [w, r] = row.querySelectorAll("input");
      if (x.weight == null && w.placeholder && w.placeholder !== "0") { x.weight = fromDisplay(w.placeholder); w.value = w.placeholder; }
      if (x.reps == null && r.placeholder && r.placeholder !== "0") { x.reps = parseInt(r.placeholder, 10); r.value = r.placeholder; }
      buzz();
      startRest();
    }
    row.classList.toggle("done", x.done);
    el.setAttribute("aria-pressed", x.done);
    updateMet(i);
    updateWorkoutMeta();
    changed();
  },
  "set-add": (el) => {
    const s = active();
    const i = +el.dataset.i;
    const e = s.entries[i];
    const last = e.sets[e.sets.length - 1];
    e.sets.push({ weight: last?.weight ?? null, reps: last?.reps ?? null, done: false });
    const list = el.parentElement.querySelector(".setlist");
    list.insertAdjacentHTML("beforeend", setRowHTML(e, i, e.sets.length - 1, lastPerformance(e.exerciseId, s.id)));
    updateWorkoutMeta();
    changed();
  },
  "set-remove": (el) => {
    const s = active();
    const i = +el.dataset.i;
    const e = s.entries[i];
    if (!e.sets.length) return;
    e.sets.pop();
    const card = wEl().querySelector(`[data-entry="${i}"]`);
    card.querySelector(".setlist").lastElementChild?.remove();
    if (!e.sets.length) el.disabled = true;
    updateWorkoutMeta();
    changed();
  },
  "focus-entry": (el) => {
    ui.current = +el.dataset.i;
    ui.menu = -1;
    renderWorkout();
    wEl().querySelector(`[data-entry="${ui.current}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  },
  "entry-menu": (el) => {
    const i = +el.dataset.i;
    ui.menu = ui.menu === i ? -1 : i;
    const y = window.scrollY;
    renderWorkout();
    window.scrollTo(0, y);
  },
  "entry-up": (el) => {
    const s = active();
    const i = +el.dataset.i;
    if (moveItem(s.entries, i, -1)) { ui.current = i - 1; ui.menu = -1; changed(); renderWorkout(); }
  },
  "entry-remove": (el) => {
    const s = active();
    const i = +el.dataset.i;
    if (!confirm(`Remove ${s.entries[i].name} from this workout?`)) return;
    s.entries.splice(i, 1);
    ui.menu = -1;
    ui.current = Math.min(ui.current, Math.max(0, s.entries.length - 1));
    changed();
    renderWorkout();
  },
  "session-add-ex": () => {
    const s = active();
    const id = document.getElementById("addExPick").value;
    if (!s || !id) return;
    s.entries.push(newEntry(id));
    ui.current = s.entries.length - 1;
    ui.menu = -1;
    changed();
    renderWorkout();
    wEl().querySelector(`[data-entry="${ui.current}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  },
  bump: (el) => {
    const s = active();
    const i = +el.dataset.i;
    const e = s.entries[i];
    const h = progressionHint(s, e);
    if (!h) return;
    e.target.targetKg = h.next;
    const it = tplById(s.templateId)?.items.find((x) => x.exerciseId === e.exerciseId);
    if (it) it.targetKg = h.next;
    for (const x of e.sets) if (!x.done) x.weight = h.next;
    changed();
    renderWorkout();
    toast(`Target raised to ${toDisplay(h.next)} ${unit()}`);
  },
  "rest-add": () => { if (ui.rest) { ui.rest.end += 30000; ui.rest.total += 30; updateRest(true); } },
  "rest-skip": () => { ui.rest = null; updateRest(); },

  /* Plan */
  assign: (el) => {
    state.calendar[el.dataset.date] = el.dataset.tpl || null;
    ui.pickOpen = false;
    ui.calOpen = null;
    changed();
    refresh();
    const t = tplById(el.dataset.tpl);
    toast(`${fmtDate(el.dataset.date, { weekday: "short", day: "numeric", month: "short" })}: ${t ? t.name : "Rest"}`);
  },
  "cal-toggle": (el) => { ui.calOpen = ui.calOpen === el.dataset.date ? null : el.dataset.date; refresh(); },
  "cal-default": (el) => { delete state.calendar[el.dataset.date]; ui.calOpen = null; changed(); refresh(); },
  "toggle-weekly": () => { ui.weeklyOpen = !ui.weeklyOpen; refresh(); },
  "edit-tpl": (el) => { ui.editTemplateId = el.dataset.id; ui.editFrom = ui.tab; refresh(); window.scrollTo(0, 0); },
  "new-tpl": () => {
    const t = { id: uid(), name: "New plan", items: [] };
    state.templates.push(t);
    ui.editTemplateId = t.id;
    ui.editFrom = ui.tab;
    changed();
    refresh();
    window.scrollTo(0, 0);
    const name = document.querySelector('[data-field="tpl-name"]');
    name?.focus();
    name?.select();
  },
  "tpl-duplicate": () => {
    const src = tplById(ui.editTemplateId);
    const t = { id: uid(), name: `${src.name} copy`, items: src.items.map((it) => ({ ...it })) };
    state.templates.push(t);
    ui.editTemplateId = t.id;
    changed();
    refresh();
    window.scrollTo(0, 0);
    toast("Plan duplicated");
  },
  "tpl-back": () => { ui.editTemplateId = null; refresh(); window.scrollTo(0, 0); },
  "tpl-up": (el) => { if (moveItem(tplById(ui.editTemplateId).items, +el.dataset.i, -1)) { changed(); refresh(); } },
  "tpl-down": (el) => { if (moveItem(tplById(ui.editTemplateId).items, +el.dataset.i, 1)) { changed(); refresh(); } },
  "tpl-remove": (el) => { tplById(ui.editTemplateId).items.splice(+el.dataset.i, 1); changed(); refresh(); },
  "tpl-add": () => {
    const id = document.getElementById("tplAddPick").value;
    if (id) { tplById(ui.editTemplateId).items.push(newItem(id)); changed(); refresh(); }
  },
  "tpl-add-new": () => {
    const ex = addExercise(document.getElementById("newExName").value);
    if (ex) { tplById(ui.editTemplateId).items.push(newItem(ex.id)); changed(); refresh(); }
  },
  "tpl-delete": () => {
    const t = tplById(ui.editTemplateId);
    if (!confirm(`Delete the ${t.name} plan? Past workouts stay in your history.`)) return;
    state.templates = state.templates.filter((x) => x.id !== t.id);
    for (const d in state.schedule) if (state.schedule[d] === t.id) delete state.schedule[d];
    for (const d in state.calendar) if (state.calendar[d] === t.id) delete state.calendar[d];
    ui.editTemplateId = null;
    changed();
    refresh();
  },

  /* Progress */
  "pick-lift": (el) => { ui.progress.ex = el.dataset.id; refresh(); if (el.closest(".list")) window.scrollTo({ top: 0, behavior: "smooth" }); },
  metric: (el) => { ui.progress.metric = el.dataset.m; refresh(); },
  range: (el) => { ui.progress.range = el.dataset.r; refresh(); },

  /* Body */
  "bw-step": (el) => {
    const input = document.getElementById("bwInput");
    const cur = parseFloat(input.value.replace(",", ".")) || 0;
    input.value = Math.max(0, round1(cur + parseFloat(el.dataset.d))).toFixed(1);
  },
  "bw-save": () => {
    const kg = fromDisplay(document.getElementById("bwInput").value);
    const date = ui.bwDate || todayStr();
    if (kg == null || kg <= 0) { toast("Enter a weight first"); return; }
    const updating = state.bodyweight.some((e) => e.date === date);
    state.bodyweight = state.bodyweight.filter((e) => e.date !== date);
    state.bodyweight.push({ date, kg });
    ui.bwDate = todayStr(); // after a past date, the card goes back to today
    changed();
    refresh();
    toast(updating ? "Entry updated" : "Bodyweight saved");
  },
  "bw-day": (el) => {
    const next = addDays(ui.bwDate || todayStr(), +el.dataset.d);
    if (next > todayStr()) return;
    ui.bwDate = next;
    refresh();
  },
  "bw-load": (el) => {
    ui.bwDate = el.dataset.date;
    refresh();
    document.getElementById("bwCard").scrollIntoView({ behavior: "smooth", block: "start" });
  },
  repmax: (el) => { ui.repMax[ui.progress.ex] = +el.dataset.n; refresh(); },
  "goto-profile": () => {
    showTab("more");
    const f = document.getElementById("profileCard");
    f?.scrollIntoView({ block: "start" });
  },
  "bw-delete": (el) => {
    if (!confirm("Delete this entry?")) return;
    state.bodyweight = state.bodyweight.filter((e) => e.date !== el.dataset.date);
    changed();
    refresh();
  },
  "body-range": (el) => { ui.bodyRange = el.dataset.r; refresh(); },
  "goto-goal": () => {
    showTab("more");
    const f = document.querySelector('#goalField input');
    f?.scrollIntoView({ block: "center" });
    f?.focus();
  },

  /* More */
  "lib-add": () => { if (addExercise(document.getElementById("libNewName").value)) { changed(); refresh(); } },
  "lib-rename": (el) => {
    const ex = exById(el.dataset.id);
    const name = prompt("Rename exercise", ex.name);
    if (!name || !name.trim()) return;
    ex.name = name.trim();
    for (const s of state.sessions) for (const e of s.entries) if (e.exerciseId === ex.id) e.name = ex.name;
    changed();
    refresh();
  },
  "lib-delete": (el) => {
    const ex = exById(el.dataset.id);
    if (!confirm(`Delete ${ex.name} from your library? Logged sets stay in your workout history.`)) return;
    state.exercises = state.exercises.filter((x) => x.id !== ex.id);
    for (const t of state.templates) t.items = t.items.filter((it) => it.exerciseId !== ex.id);
    changed();
    refresh();
  },
  export: async () => {
    await flush();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const name = `gym-log-backup-${todayStr()}.json`;
    const file = new File([blob], name, { type: "application/json" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Gym Log backup" }); return; } catch (err) { if (err.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  import: () => document.getElementById("importFile").click(),
  reset: () => {
    if (!confirm("Erase every workout, bodyweight entry and setting on this phone?")) return;
    if (!confirm("This can't be undone. Erase everything?")) return;
    state = seed();
    ui.editTemplateId = null;
    ui.rest = null;
    changed();
    flush();
    refresh();
    updateResume();
    toast("All data erased");
  },
};

document.addEventListener("click", (ev) => {
  const tab = ev.target.closest("#tabs button");
  if (tab) {
    if (ui.editTemplateId && tab.dataset.tab !== ui.editFrom) { ui.editTemplateId = null; ui.dirty.plan = ui.dirty.more = true; }
    showTab(tab.dataset.tab);
    return;
  }
  const el = ev.target.closest("[data-action]");
  if (el && !el.disabled && actions[el.dataset.action]) actions[el.dataset.action](el);
});

// Typing updates state in place; no re-render, so focus and keyboard stay put.
document.addEventListener("input", (ev) => {
  const el = ev.target;
  const f = el.dataset.field;
  if (!f) return;
  const s = active();
  if (f === "w" || f === "r") {
    const { i, j } = rowOf(el);
    const x = s.entries[i].sets[j];
    if (f === "w") x.weight = fromDisplay(el.value);
    else { const n = parseInt(el.value, 10); x.reps = isNaN(n) ? null : n; }
  } else if (f === "s-name") {
    s.name = el.value;
    wEl().querySelector(".wbar b").textContent = el.value;
  } else if (f === "s-notes") s.notes = el.value;
  else if (f === "tpl-name") tplById(ui.editTemplateId).name = el.value;
  else if (f === "item") {
    const it = tplById(ui.editTemplateId).items[+el.dataset.i];
    const k = el.dataset.k;
    if (k === "targetKg") it.targetKg = el.value.trim() ? fromDisplay(el.value) : null;
    else { const n = parseInt(el.value, 10); it[k] = isNaN(n) ? (k === "sets" ? 0 : null) : n; }
  }
  else return;
  changed({ keep: ui.workoutOpen ? null : ui.tab });
});

// Select the whole value when tapping a set input, so a new number replaces it.
document.addEventListener("focusin", (ev) => {
  if (ev.target.matches?.(".set input")) setTimeout(() => ev.target.select(), 0);
});

document.addEventListener("change", (ev) => {
  const el = ev.target;
  const f = el.dataset.field;
  if (f === "s-date" && el.value) { active().date = el.value; changed(); updateWorkoutMeta(); }
  else if (f === "cal-move" && el.value) {
    const from = el.dataset.date, to = el.value;
    if (from !== to) {
      const a = planFor(from)?.id ?? null, b = planFor(to)?.id ?? null;
      state.calendar[to] = a;
      state.calendar[from] = b;
      if (!ui.extraDates.includes(to)) ui.extraDates.push(to);
      ui.calOpen = null;
      changed();
      refresh();
      toast(`Moved to ${fmtDate(to)}`);
    }
  } else if (f === "cal-jump" && el.value) {
    if (!ui.extraDates.includes(el.value)) ui.extraDates.push(el.value);
    ui.calOpen = el.value;
    refresh();
  } else if (f === "schedule") {
    if (el.value) state.schedule[el.dataset.day] = el.value; else delete state.schedule[el.dataset.day];
    changed({ keep: "plan" });
    toast("Schedule updated");
  } else if (f === "unit") { state.settings.unit = el.value; changed(); refresh(); }
  else if (f === "bw-date" && el.value) { ui.bwDate = el.value > todayStr() ? todayStr() : el.value; refresh(); }
  else if (f === "profile") {
    const k = el.dataset.k;
    const pr = state.settings.profile;
    if (k === "heightCm" || k === "age") { const n = parseFloat(el.value); pr[k] = isNaN(n) || n <= 0 ? null : n; }
    else if (k === "activity") pr[k] = +el.value;
    else pr[k] = el.value;
    changed({ keep: "more" });
  }
  else if (f === "rest-sec") { state.settings.restSec = +el.value; changed({ keep: "more" }); }
  else if (f === "goal") {
    state.settings.goalKg = el.value.trim() ? fromDisplay(el.value) : null;
    changed({ keep: "more" });
    toast(state.settings.goalKg != null ? "Goal saved" : "Goal cleared");
  }
});

// Tap or drag on a chart to inspect points.
document.addEventListener("pointerdown", (ev) => {
  const svg = ev.target.closest?.("svg.chart[data-chart]");
  if (!svg) return;
  inspectChart(svg, ev.clientX);
  const move = (e) => inspectChart(svg, e.clientX);
  const up = () => { svg.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  svg.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});

document.getElementById("importFile").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.sessions) || !Array.isArray(data.exercises)) throw new Error("not a backup");
    if (!confirm("Replace everything on this phone with this backup?")) return;
    state = migrate(data);
    state.activeSessionId = null;
    changed();
    await flush();
    refresh();
    updateResume();
    toast("Backup restored");
  } catch {
    alert("That file isn't a Gym Log backup.");
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
  else tick();
});
window.addEventListener("pagehide", () => flush());

/* =====================================================================
   Boot
   ===================================================================== */

(async function boot() {
  state = await load();
  document.querySelector('#tabs [data-tab="today"]').classList.add("on");
  renderTab("today");
  updateResume();
  if (active()) startTicker();
  try { await navigator.storage?.persist?.(); } catch {}
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
