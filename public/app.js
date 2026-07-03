// Передачи приезжают с /api/config (сервер читает опциональный
// gearbox.config.json). Этот набор — запасной, если запрос не удался.
// Логика как в машине: первая передача — самая лёгкая модель, высшая — топ.
// col: null у нейтрали = середина рейки.
const FALLBACK_GEARS = [
  { pos: "1", col: 0, row: 0, model: "haiku",   name: "Haiku 4.5", desc: "fastest" },
  { pos: "2", col: 0, row: 2, model: "sonnet",  name: "Sonnet 5",  desc: "routine tasks" },
  { pos: "3", col: 1, row: 0, model: "opus",    name: "Opus 4.8",  desc: "complex tasks" },
  { pos: "4", col: 1, row: 2, model: "default", name: "Opus 4.8 · 1M", desc: "recommended" },
  { pos: "5", col: 2, row: 0, model: "fable",   name: "Fable 5",   desc: "most capable" },
  { pos: "N", col: null, row: 1, model: "default", name: "Default ★", desc: "back to default" },
];

// ── геометрия кулисы ─────────────────────────────────────────────────────────
// Ряды фиксированы, а x-координаты колонок раздаёт buildGraph: сколько колонок
// занято, столько и рисуем, равномерно по ширине плиты (2 колонки = широкая
// четырёхступка, 3 = классическая пятиступка).
let COLS = { 0: 85, 1: 160, 2: 235 };
const ROWS = { 0: 118, 1: 205, 2: 292 };
const RAIL_ROW = 1; // средний ряд — нейтральная рейка
const slotXY = (g) => ({
  x: g.col == null ? (RAIL.minX + RAIL.maxX) / 2 : COLS[g.col],
  y: ROWS[g.row],
});

const $ = (s) => document.querySelector(s);
const gate = $("#gate");
const tach = $("#tach");
const paneSel = $("#pane");
const statusEl = $("#status");
const modelEl = $("#current-model");
const gearEl = $("#current-gear");

const SVGNS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}, ...children) => {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of children) n.appendChild(c);
  return n;
};
const txt = (node, s) => ((node.textContent = s), node);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let GEARS = FALLBACK_GEARS;
let currentGear = null;
let shifting = false; // true, пока идёт анимация включения/отскока

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

// ── звук: механический «клац» на WebAudio (без файлов) ──────────────────────
// Два слоя: низкий глухой удар (осциллятор с падающей частотой) + металлический
// щелчок (короткий шумовой всплеск через полосовой фильтр).
let audioCtx;
function clack(strength = 1) {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    // глухой удар
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.35 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.16);
    // металлический щелчок
    const len = Math.floor(audioCtx.sampleRate * 0.05);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const bp = audioCtx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 2600; bp.Q.value = 1.2;
    const g2 = audioCtx.createGain();
    g2.gain.value = 0.45 * strength;
    src.connect(bp).connect(g2).connect(audioCtx.destination);
    src.start(t);
  } catch { /* звук — бонус, из-за него не падаем */ }
}

// ── тахометр ─────────────────────────────────────────────────────────────────
// Полукруглая шкала 0–8, красная зона с 7. Стрелка подрывается при каждом
// переключении и плавно опускается на холостые.
const TACH = { cx: 100, cy: 105, r: 78, min: -160, max: -20 }; // углы в градусах
let needle;

function drawTach() {
  tach.innerHTML = "";
  const { cx, cy, r } = TACH;
  const face = el("g");
  // дуга шкалы
  face.appendChild(el("path", {
    d: `M ${cx + r * Math.cos(Math.PI * (180 + 20) / 180)} ${cy + r * Math.sin(Math.PI * (180 + 20) / 180)}
        A ${r} ${r} 0 0 1 ${cx + r * Math.cos(Math.PI * -20 / 180)} ${cy + r * Math.sin(Math.PI * -20 / 180)}`,
    fill: "none", stroke: "#2a2e37", "stroke-width": 3,
  }));
  // риски и цифры
  for (let i = 0; i <= 8; i++) {
    const a = (TACH.min + (i / 8) * (TACH.max - TACH.min)) * Math.PI / 180;
    const red = i >= 7;
    face.appendChild(el("line", {
      x1: cx + (r - 2) * Math.cos(a), y1: cy + (r - 2) * Math.sin(a),
      x2: cx + (r - 12) * Math.cos(a), y2: cy + (r - 12) * Math.sin(a),
      stroke: red ? "#ff3b30" : "#8b909b", "stroke-width": red ? 3 : 2,
    }));
    face.appendChild(txt(el("text", {
      x: cx + (r - 24) * Math.cos(a), y: cy + (r - 24) * Math.sin(a) + 3,
      fill: red ? "#ff6b60" : "#6b7280", "font-size": 10, "font-weight": 700, "text-anchor": "middle",
    }), String(i)));
  }
  // красная зона
  const a1 = (TACH.min + (7 / 8) * (TACH.max - TACH.min)) * Math.PI / 180;
  const a2 = TACH.max * Math.PI / 180;
  face.appendChild(el("path", {
    d: `M ${cx + (r - 6) * Math.cos(a1)} ${cy + (r - 6) * Math.sin(a1)}
        A ${r - 6} ${r - 6} 0 0 1 ${cx + (r - 6) * Math.cos(a2)} ${cy + (r - 6) * Math.sin(a2)}`,
    fill: "none", stroke: "rgba(255,59,48,0.55)", "stroke-width": 7,
  }));
  face.appendChild(txt(el("text", {
    x: cx, y: cy - 24, fill: "#4b5563", "font-size": 8, "letter-spacing": 2, "text-anchor": "middle",
  }), "RPM ×1000"));
  // стрелка
  needle = el("g", { id: "needle" },
    el("line", { x1: 0, y1: 0, x2: r - 16, y2: 0, stroke: "#ff5a1f", "stroke-width": 3, "stroke-linecap": "round" }),
    el("circle", { cx: 0, cy: 0, r: 6, fill: "#1c1f26", stroke: "#3a3f49", "stroke-width": 2 }),
  );
  face.appendChild(needle);
  tach.appendChild(face);
  setNeedle(0.08);
}

function setNeedle(frac) {
  const a = TACH.min + frac * (TACH.max - TACH.min);
  needle.setAttribute("transform", `translate(${TACH.cx}, ${TACH.cy}) rotate(${a})`);
}

// «Перегазовка»: резкий подхват до случайного пика и мягкий спад на холостые.
function rev() {
  const peak = 0.72 + Math.random() * 0.24;
  const start = performance.now();
  const UP = 260, DOWN = 900; // мс: подхват / спад
  (function frame(now) {
    const t = now - start;
    if (t < UP) {
      setNeedle(0.08 + (peak - 0.08) * (t / UP));
      requestAnimationFrame(frame);
    } else if (t < UP + DOWN) {
      const k = (t - UP) / DOWN;
      setNeedle(peak + (0.08 - peak) * (1 - (1 - k) ** 3));
      requestAnimationFrame(frame);
    } else setNeedle(0.08);
  })(start);
}

// ── граф кулисы (для ограничений драга) ─────────────────────────────────────
// Строится из GEARS: горизонтальная рейка + вертикаль на каждую занятую колонку.
let RAIL = { y: 0, minX: 0, maxX: 0 };
let COLUMNS = []; // { x, top, bottom }

function buildGraph() {
  const usedCols = [...new Set(GEARS.filter((g) => g.col != null).map((g) => g.col))].sort();
  // раскладываем занятые колонки равномерно по ширине плиты
  const spread = { 1: [160], 2: [110, 210], 3: [85, 160, 235] }[usedCols.length] || [85, 160, 235];
  COLS = {};
  usedCols.forEach((c, i) => { COLS[c] = spread[i]; });
  RAIL = {
    y: ROWS[RAIL_ROW],
    minX: COLS[usedCols[0]],
    maxX: COLS[usedCols.at(-1)],
  };
  COLUMNS = usedCols.map((c) => {
    const rows = GEARS.filter((g) => g.col === c).map((g) => g.row).concat(RAIL_ROW);
    return { x: COLS[c], top: ROWS[Math.min(...rows)], bottom: ROWS[Math.max(...rows)] };
  });
}

const nearestColumn = (px) =>
  COLUMNS.reduce((best, c) => (Math.abs(px - c.x) < Math.abs(px - best.x) ? c : best), COLUMNS[0]);

// ── отрисовка ────────────────────────────────────────────────────────────────
let knob;
let knobPos = { x: 0, y: 0 };

function drawGate() {
  gate.innerHTML = "";

  // градиенты: плита, её кромка, ручка, хромовый воротник
  const defs = el("defs");
  const mkGrad = (id, stops, attrs = {}) => {
    const g = el("linearGradient", { id, ...attrs });
    for (const [offset, color] of stops) g.appendChild(el("stop", { offset, "stop-color": color }));
    return g;
  };
  defs.appendChild(mkGrad("plate", [
    ["0%", "#e2e6ec"], ["18%", "#c7ccd6"], ["45%", "#9aa1ac"],
    ["60%", "#b7bdc8"], ["85%", "#8e95a1"], ["100%", "#b0b6c0"],
  ], { x1: 0, y1: 0, x2: 0.25, y2: 1 }));
  defs.appendChild(mkGrad("plateEdge", [
    ["0%", "#f6f8fb"], ["50%", "#6d7480"], ["100%", "#3f454f"],
  ], { x1: 0, y1: 0, x2: 0, y2: 1 }));
  const knobGrad = el("radialGradient", { id: "knobG", cx: "36%", cy: "30%", r: "80%" });
  [["0%", "#6a6f78"], ["35%", "#26282e"], ["100%", "#050506"]].forEach(([o, c]) =>
    knobGrad.appendChild(el("stop", { offset: o, "stop-color": c })));
  defs.appendChild(knobGrad);
  const collarGrad = el("radialGradient", { id: "collarG", cx: "40%", cy: "35%", r: "75%" });
  [["0%", "#f4f6f9"], ["55%", "#aeb4bf"], ["100%", "#565c68"]].forEach(([o, c]) =>
    collarGrad.appendChild(el("stop", { offset: o, "stop-color": c })));
  defs.appendChild(collarGrad);
  gate.appendChild(defs);

  // плита с фаской + шлифованная текстура
  gate.appendChild(el("rect", { x: 24, y: 60, width: 272, height: 296, rx: 20, fill: "url(#plateEdge)" }));
  gate.appendChild(el("rect", { x: 27, y: 63, width: 266, height: 290, rx: 17, fill: "url(#plate)" }));
  for (let y = 72; y < 350; y += 5) {
    gate.appendChild(el("line", {
      x1: 30, y1: y, x2: 290, y2: y, stroke: "rgba(255,255,255,0.05)", "stroke-width": 1,
    }));
  }
  // винты по углам (угол шлица «псевдослучайный» от координат — стабилен между рендерами)
  for (const [sx, sy] of [[46, 82], [274, 82], [46, 334], [274, 334]]) {
    gate.appendChild(el("circle", { cx: sx, cy: sy, r: 7, fill: "url(#collarG)", stroke: "#4b515c", "stroke-width": 1 }));
    const ang = (sx * 7 + sy * 13) % 180;
    gate.appendChild(el("line", {
      x1: sx - 4.5, y1: sy, x2: sx + 4.5, y2: sy,
      stroke: "#2f333b", "stroke-width": 1.6, transform: `rotate(${ang} ${sx} ${sy})`,
    }));
  }

  // гравировка: светлый сдвиг снизу + тёмный текст сверху = эффект штамповки;
  // заводская маркировка идёт вертикально по правому борту, чтобы не мешать
  // подписям моделей у нижнего ряда передач
  const engrave = (x, y, s, size = 9, ls = 3, rotate = 0) => {
    const attrs = (fill, dy) => ({
      x, y: y + dy, fill, "font-size": size, "letter-spacing": ls,
      "text-anchor": "middle", "font-weight": 700,
      ...(rotate ? { transform: `rotate(${rotate} ${x} ${y})` } : {}),
    });
    gate.appendChild(txt(el("text", attrs("rgba(255,255,255,0.55)", 0.8)), s));
    gate.appendChild(txt(el("text", attrs("#3d434d", 0)), s));
  };
  engrave(282, 208, "CLAUDE · CODE", 7.5, 2.2, 90);

  // прорези: светлая кромка снизу, тёмный паз, чёрное дно
  const paths = [
    `M ${RAIL.minX} ${RAIL.y} L ${RAIL.maxX} ${RAIL.y}`,
    ...COLUMNS.map((c) => `M ${c.x} ${c.top} L ${c.x} ${c.bottom}`),
  ];
  for (const d of paths) gate.appendChild(el("path", {
    d, fill: "none", stroke: "rgba(255,255,255,0.6)", "stroke-width": 17,
    "stroke-linecap": "round", transform: "translate(0, 1.6)",
  }));
  for (const d of paths) gate.appendChild(el("path", {
    d, fill: "none", stroke: "#111318", "stroke-width": 16, "stroke-linecap": "round",
  }));
  for (const d of paths) gate.appendChild(el("path", {
    d, fill: "none", stroke: "#000", "stroke-width": 9, "stroke-linecap": "round",
  }));

  // позиции: гравированная цифра + невидимая кликабельная зона
  for (const g of GEARS) {
    const { x, y } = slotXY(g);
    // подписи: у верхнего ряда над пазом, у нижнего под пазом; у нейтрали —
    // под ручкой, а если там проходит паз колонки — сбоку от ручки
    const onRail = g.row === RAIL_ROW;
    let lx = x, ly, ny;
    if (onRail) {
      const grooveBelow = COLUMNS.some((c) => Math.abs(c.x - x) < 1 && c.bottom > RAIL.y + 1);
      if (!grooveBelow) { ly = y + 36; ny = ly + 12; }       // снизу, место свободно
      else { lx = x + 34; ly = y - 15; ny = ly - 14; }       // сбоку от ручки
    } else if (g.row === 0) { ly = y - 26; ny = ly - 15; }
    else { ly = y + 33; ny = ly + 13; }
    const modelName = (g.name || "").replace(/\s*★\s*$/, "").toUpperCase();

    const grp = el("g", { class: "slot", "data-pos": g.pos });
    grp.appendChild(el("circle", { class: "slot__hit", cx: x, cy: y, r: 30 }));
    // цифра передачи
    grp.appendChild(txt(el("text", {
      x: lx, y: ly + 1, fill: "rgba(255,255,255,0.6)", "font-size": onRail ? 14 : 17, "font-weight": 800, "text-anchor": "middle",
    }), g.pos));
    grp.appendChild(txt(el("text", {
      class: "etch-main", x: lx, y: ly, fill: "#343a44", "font-size": onRail ? 14 : 17, "font-weight": 800, "text-anchor": "middle",
    }), g.pos));
    // имя модели, мелкой гравировкой
    grp.appendChild(txt(el("text", {
      x: lx, y: ny + 0.7, fill: "rgba(255,255,255,0.55)", "font-size": 7,
      "font-weight": 700, "letter-spacing": 0.6, "text-anchor": "middle",
    }), modelName));
    grp.appendChild(txt(el("text", {
      class: "etch-name", x: lx, y: ny, fill: "#454b56", "font-size": 7,
      "font-weight": 700, "letter-spacing": 0.6, "text-anchor": "middle",
    }), modelName));
    grp.addEventListener("click", () => onSlotClick(g));
    gate.appendChild(grp);
  }

  // ручка: тень + хромовый воротник + глянцевый чёрный шар с бликом
  // и выгравированной мини-схемой передач на торце
  knob = el("g", { id: "knob" });
  knob.appendChild(el("ellipse", { cx: 3, cy: 7, rx: 22, ry: 10, fill: "rgba(0,0,0,0.45)" }));
  knob.appendChild(el("circle", { cx: 0, cy: 0, r: 15, fill: "url(#collarG)", stroke: "#3a3f49", "stroke-width": 1 }));
  knob.appendChild(el("circle", { cx: 0, cy: 0, r: 19, fill: "url(#knobG)", stroke: "#000", "stroke-width": 1 }));
  knob.appendChild(el("ellipse", { cx: -6, cy: -8, rx: 7, ry: 4.5, fill: "rgba(255,255,255,0.35)", transform: "rotate(-30 -6 -8)" }));
  const mini = el("g", { stroke: "rgba(230,234,240,0.8)", "stroke-width": 1.3, "stroke-linecap": "round" });
  mini.appendChild(el("line", { x1: -6, y1: -4, x2: -6, y2: 6 }));
  mini.appendChild(el("line", { x1: 0, y1: -4, x2: 0, y2: 6 }));
  mini.appendChild(el("line", { x1: 6, y1: -4, x2: 6, y2: 1 }));
  mini.appendChild(el("line", { x1: -6, y1: 1, x2: 6, y2: 1 }));
  knob.appendChild(mini);
  gate.appendChild(knob);

  attachDrag();
}

function placeKnobXY(x, y, scale = 1) {
  knobPos = { x, y };
  knob.setAttribute("transform", `translate(${x}, ${y}) scale(${scale})`);
}
const placeKnob = (g, scale = 1) => {
  const { x, y } = slotXY(g);
  placeKnobXY(x, y, scale);
};

// ── анимация по маршруту (клик по позиции и пружинный отскок) ───────────────
// Маршрут между точками графа: по вертикали к рейке → вдоль рейки → в паз.
function routePts(a, b) {
  const rail = RAIL.y;
  if (Math.abs(a.x - b.x) < 0.5) return [a, b]; // одна колонка — прямой ход
  const pts = [a];
  if (Math.abs(a.y - rail) > 0.5) pts.push({ x: a.x, y: rail });
  pts.push({ x: b.x, y: rail });
  if (Math.abs(b.y - rail) > 0.5) pts.push(b);
  return pts;
}

// Ведёт ручку по ломаной с ease-in-out; в середине хода она слегка
// «приподнимается» (scale), в конце — вибрирующий довод (settle).
function animateAlong(pts, done) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segs.push({ a: pts[i], b: pts[i + 1], len });
    total += len;
  }
  if (!total) return done?.();

  const DURATION = Math.min(560, 180 + total * 1.6); // дольше путь — дольше ход
  const start = performance.now();
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
  const end = pts.at(-1);

  (function frame(now) {
    const k = Math.min(1, (now - start) / DURATION);
    let dist = ease(k) * total;
    let seg = segs[0];
    for (const s of segs) {
      if (dist <= s.len) { seg = s; break; }
      dist -= s.len; seg = s;
    }
    const f = seg.len ? Math.min(1, dist / seg.len) : 1;
    const x = seg.a.x + (seg.b.x - seg.a.x) * f;
    const y = seg.a.y + (seg.b.y - seg.a.y) * f;
    const lift = 1 + 0.14 * Math.sin(Math.PI * k);
    placeKnobXY(x, y, lift);
    if (k < 1) requestAnimationFrame(frame);
    else {
      let w = 0;
      (function settle() {
        w++;
        const s = 1 + 0.05 * Math.sin(w * 1.4) * Math.exp(-w / 5);
        placeKnobXY(end.x, end.y, s);
        if (w < 14) requestAnimationFrame(settle);
        else { placeKnobXY(end.x, end.y); done?.(); }
      })();
    }
  })(start);
}

// ── включение передачи: табло + звук + запрос к серверу ─────────────────────
function engage(g, { send = true } = {}) {
  currentGear = g;
  document.querySelectorAll(".slot").forEach((s) =>
    s.classList.toggle("active", s.dataset.pos === g.pos));
  clack();
  rev();
  modelEl.textContent = g.name;
  modelEl.classList.remove("flash");
  void modelEl.offsetWidth; // перезапуск CSS-анимации
  modelEl.classList.add("flash");
  gearEl.textContent = `gear ${g.pos} · /model ${g.model}${g.desc ? " · " + g.desc : ""}`;
  if (send) sendShift(g);
}

async function sendShift(g) {
  const pane = paneSel.value;
  if (!pane) {
    setStatus("Панель не выбрана. Запусти Claude Code внутри tmux и нажми ⟳.", "err");
    return;
  }
  try {
    const res = await fetch("/api/shift", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane, model: g.model }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "shift failed");
    setStatus(`Передача ${g.pos} → ${g.name} (/model ${g.model})`, "ok");
  } catch (e) {
    setStatus("Не переключилось: " + e.message, "err");
  }
}

// Клик по цифре — ручка сама доезжает до паза (ленивый режим).
function onSlotClick(g) {
  if (dragging || justDragged || shifting) return;
  if (g.pos === currentGear?.pos) return;
  shifting = true;
  animateAlong(routePts(knobPos, slotXY(g)), () => {
    shifting = false;
    engage(g);
  });
}

// ── драг: рычаг жёстко ограничен прорезями кулисы ───────────────────────────
let dragging = false;
let justDragged = false; // гасим click, прилетающий сразу после pointerup
let lastDetent = null;   // над каким пазом были в прошлый раз (для тиков)

function svgPoint(evt) {
  const pt = gate.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  return pt.matrixTransform(gate.getScreenCTM().inverse());
}

// Тянем ручку к курсору, но только вдоль графа кулисы (рейка + колонки).
// Логика «шарика в лабиринте»: на рейке можно ехать вбок или нырнуть в
// колонку над которой курсор; в колонке x заперт, пока не вернёшься на рейку.
function constrainMove(p) {
  const SN = 15; // окно захвата в координатах SVG
  let { x, y } = knobPos;
  const onRail = Math.abs(y - RAIL.y) <= 0.5;

  if (onRail) {
    const col = nearestColumn(p.x);
    // ныряем в колонку, только если курсор над ней И тянет прочь от рейки
    if (Math.abs(p.x - col.x) < SN && Math.abs(p.y - RAIL.y) > SN * 0.5) {
      x = col.x;
      y = clamp(p.y, col.top, col.bottom);
    } else {
      x = clamp(p.x, RAIL.minX, RAIL.maxX);
      y = RAIL.y;
    }
  } else {
    // внутри колонки: x заперт, свободен только y
    const col = nearestColumn(x);
    x = col.x;
    y = clamp(p.y, col.top, col.bottom);
    // у рейки и тянут вбок → выскакиваем на рейку
    if (Math.abs(y - RAIL.y) < SN && Math.abs(p.x - x) > SN) y = RAIL.y;
  }
  placeKnobXY(x, y, 1.1);

  // тик-детент при проходе над пазом
  const near = GEARS.find((g) => {
    const s = slotXY(g);
    return Math.hypot(x - s.x, y - s.y) < 10;
  });
  const key = near?.pos ?? null;
  if (key !== lastDetent) {
    if (key) clack(0.18);
    lastDetent = key;
  }
}

function attachDrag() {
  knob.addEventListener("pointerdown", (e) => {
    if (shifting) return;
    dragging = true;
    lastDetent = currentGear?.pos ?? null;
    gate.setPointerCapture(e.pointerId);
    placeKnobXY(knobPos.x, knobPos.y, 1.1); // ручка «взята» — чуть крупнее
    document.body.classList.add("dragging");
    e.preventDefault();
  });

  gate.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    constrainMove(svgPoint(e));
  });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("dragging");
    justDragged = true;
    setTimeout(() => (justDragged = false), 150);

    // отпустили в пазу? (щедрый радиус захвата)
    const hit = GEARS.reduce((best, g) => {
      const s = slotXY(g);
      const d = Math.hypot(knobPos.x - s.x, knobPos.y - s.y);
      return d < (best?.d ?? 24) ? { g, d } : best;
    }, null);

    if (hit) {
      const g = hit.g;
      placeKnob(g);
      if (g.pos !== currentGear?.pos) engage(g);
      else clack(0.3); // усадили обратно ту же передачу
    } else {
      // недовключение: пружина возвращает рычаг в текущую передачу
      setStatus("Мимо паза — рычаг отпружинил обратно.", "");
      shifting = true;
      animateAlong(routePts(knobPos, slotXY(currentGear)), () => {
        shifting = false;
        clack(0.35);
      });
    }
  };
  gate.addEventListener("pointerup", release);
  gate.addEventListener("pointercancel", release);
}

// ── загрузка данных ──────────────────────────────────────────────────────────
let customConfig = false; // юзер положил gearbox.config.json → автодетект молчит

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    if (Array.isArray(data.gears) && data.gears.length) {
      GEARS = data.gears;
      customConfig = Boolean(data.custom);
    }
  } catch { /* остаёмся на FALLBACK_GEARS */ }
}

// Раскладка позиций по кулисе: куда сажать передачи 1..6.
const SLOT_TEMPLATE = [
  { col: 0, row: 0 }, { col: 0, row: 2 },
  { col: 1, row: 0 }, { col: 1, row: 2 },
  { col: 2, row: 0 }, { col: 2, row: 2 },
];

// Порядок передач — как тяга в машине: первая для самой лёгкой модели,
// высшая для топовой. Незнакомые модели уходят в конец в порядке пикера.
const GEAR_RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

// Превращаем список из живого пикера /model в карту передач: каждый пункт
// пикера — своя передача, от лёгкой к мощной. Default тоже передача (это
// реальная модель, обычно Opus · 1M), он встаёт следом за своей базовой.
// Нейтраль дополнительно возит default: бросил рычаг в центр — вернулся.
function gearsFromModels(models) {
  const drive = models
    .map((m) => {
      const isDefault = /^default/i.test(m.alias);
      // у Default модель зашита в описании: «Opus 4.8 with 1M context · ...»
      const baseSlug = (isDefault ? m.desc : m.alias).split(/\s/)[0].toLowerCase();
      return {
        ...m,
        isDefault,
        slug: isDefault ? "default" : baseSlug, // «Fable» → «fable»
        rank: (GEAR_RANK[baseSlug] || 99) + (isDefault ? 0.5 : 0),
      };
    })
    .sort((a, b) => a.rank - b.rank);

  const gears = drive.slice(0, SLOT_TEMPLATE.length).map((m, i) => {
    const [rawName, ...tail] = m.desc.split("·");
    const base = rawName.replace(/\s+with .*$/i, "").trim(); // «Opus 4.8 with 1M context» → «Opus 4.8»
    const oneM = /with 1M context/i.test(rawName);
    return {
      pos: String(i + 1),
      ...SLOT_TEMPLATE[i],
      model: m.slug,
      // дефолту даём отличимое имя, чтобы на плите не было двух одинаковых
      name: m.isDefault ? (oneM ? `${base} · 1M` : "Default") : base,
      desc: tail.join("·").trim(),
    };
  });
  gears.push({ pos: "N", col: null, row: 1, model: "default", name: "Default ★", desc: "default" });
  return gears;
}

// Пробуем считать реальные модели из выбранной панели и перерисоваться.
async function syncModels() {
  const pane = paneSel.value;
  if (!pane || customConfig || shifting || dragging) return;
  setStatus("Читаю живой пикер /model из панели…");
  try {
    const res = await fetch(`/api/models?pane=${encodeURIComponent(pane)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "detect failed");
    GEARS = gearsFromModels(data.models);
    applyGears();
    const cur = data.models.find((m) => m.current);
    setStatus(`Передачи считаны с пикера${cur ? ` · сейчас в панели: ${cur.alias}` : ""}. Хватай рычаг.`, "ok");
  } catch (e) {
    setStatus(`Автодетект не вышел (${e.message}) — еду на дефолтной карте.`, "");
  }
}

// Полная перерисовка кулисы под новую карту передач (рычаг встаёт в нейтраль).
function applyGears() {
  buildGraph();
  drawGate();
  const neutral = GEARS.find((g) => g.pos === "N") || GEARS.at(-1);
  currentGear = neutral;
  placeKnob(neutral);
  document.querySelectorAll(".slot").forEach((s) =>
    s.classList.toggle("active", s.dataset.pos === neutral.pos));
  modelEl.textContent = neutral.name;
  gearEl.textContent = `gear ${neutral.pos} · /model ${neutral.model}`;
}

async function loadPanes() {
  try {
    const res = await fetch("/api/panes");
    const data = await res.json();
    paneSel.innerHTML = "";
    if (!data.tmux) {
      setStatus("tmux не запущен. `brew install tmux`, запусти Claude Code внутри, затем ⟳.", "err");
      return;
    }
    if (!data.panes.length) {
      setStatus("Панелей tmux нет. Открой tmux, запусти в нём `claude`, затем ⟳.", "err");
      return;
    }
    for (const p of data.panes) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.label} (${p.command})${p.looksLikeClaude ? " ●" : ""}`;
      paneSel.appendChild(opt);
    }
    // авто-выбор панели, похожей на Claude Code
    const claude = data.panes.find((p) => p.looksLikeClaude);
    if (claude) paneSel.value = claude.id;
    setStatus(`Панелей: ${data.panes.length}. ${claude ? "Панель Claude выбрана." : "Выбери свою панель."} Хватай рычаг.`);
  } catch (e) {
    setStatus("Не удалось получить панели: " + e.message, "err");
  }
}

// ── старт ────────────────────────────────────────────────────────────────────
// Порядок: конфиг → отрисовка → панели → автодетект живых моделей из пикера
// (кулиса перерисуется под реальный список; свой конфиг юзера — приоритетнее).
(async function boot() {
  await loadConfig();
  drawTach();
  applyGears(); // на старте стоим в нейтрали, /model не шлём
  await loadPanes();
  await syncModels();
  $("#refresh").addEventListener("click", async () => {
    await loadPanes();
    await syncModels();
  });
  paneSel.addEventListener("change", syncModels);
})();
