"use strict";
(() => {
  // ---------- утилиты ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MINUS = "\u2212";
  const num = (x, d = 0) => x.toFixed(d).replace(".", ",");
  const pc = (x, d = 0) => num(x * 100, d) + "%";
  const sgn = (v, body) => (v < 0 ? MINUS : v > 0 ? "+" : "") + body;
  const spc = (x, d = 1) => sgn(Math.round(x * 10 ** (d + 2)), num(Math.abs(x) * 100, d) + "%");
  const spp = (x) => { const v = Math.round(x * 100); return sgn(v, Math.abs(v) + " п.п."); };
  const money = (x) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: x < 1000 ? 2 : 0 }).format(x) + "\u00a0$";
  const utcDate = (s) => new Date(s + "T00:00:00Z");
  const fmtDate = (s) => utcDate(s).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" }).replace(".", "");
  const addDays = (s, n) => new Date(utcDate(s).getTime() + n * 864e5).toISOString().slice(0, 10);
  const fmtDT = (iso) => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).replace(".", "");
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  };

  const ICONS = {
    up: '<svg class="ic" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2 11 10H1z"/></svg>',
    down: '<svg class="ic" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10 1 2h10z"/></svg>',
    flat: '<svg class="ic" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="5" width="10" height="2" rx="1"/></svg>',
    check: '<svg class="ic st" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 5 9.5 10 3"/></svg>',
    eq: '<svg class="ic st" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4.5h8M2 7.5h8"/></svg>',
    cross: '<svg class="ic st" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
    clock: '<svg class="ic st" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5"/><path d="M6 3.5V6l1.7 1"/></svg>',
    warn: '<svg class="ic" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1 11.5 10.5h-11z"/><path d="M6 4.5v3M6 8.6v.1" stroke="var(--bg)" stroke-width="1.3" stroke-linecap="round"/></svg>',
  };
  const CLS = [
    { k: "short", name: "Шорт", icon: "down" },
    { k: "flat", name: "Флэт", icon: "flat" },
    { k: "long", name: "Лонг", icon: "up" },
  ];

  const NOISE = 0.02;      // разница с базой меньше 2% - считаем шумом
  const MIN_LIVE = 20;     // сколько закрытых живых прогнозов нужно, чтобы доверять живой метрике
  const STALE_H = 36;      // часов без обновления - показываем предупреждение
  const TARGETS = [
    { key: "direction", label: "Направление", loss: "log loss" },
    { key: "long_drawdown", label: "Просадка лонга", loss: "Brier" },
    { key: "short_stop", label: "Стоп шорта", loss: "Brier" },
  ];
  const CAL_TABS = [
    { key: "long", label: "Лонг", full: "P(лонг): цена через неделю выше порога флэта", color: "var(--long)" },
    { key: "short", label: "Шорт", full: "P(шорт): цена через неделю ниже порога флэта", color: "var(--short)" },
    { key: "long_drawdown", label: "Просадка", full: "P(просадка лонга): касание нижней границы за неделю", color: "var(--long)" },
    { key: "short_stop", label: "Стоп", full: "P(стоп шорта): касание верхней границы за неделю", color: "var(--short)" },
  ];

  const state = { index: null, slug: null, fc: null, hist: null, cal: "long", histFilter: "all", histN: 14, loadedAt: 0 };

  // ---------- данные ----------
  async function getJSON(path) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }

  async function load(slug) {
    state.slug = slug;
    store.set("slug", slug);
    const [fc, hist] = await Promise.all([
      getJSON(`data/${slug}/forecast.json`),
      getJSON(`data/${slug}/history.json`).catch(() => null),
    ]);
    state.fc = fc;
    state.hist = hist ? hist.entries : [];
    state.loadedAt = Date.now();
    render();
  }

  async function boot() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    try {
      state.index = await getJSON("data/index.json");
      const syms = state.index.symbols;
      if (!syms.length) throw new Error("в data/index.json нет инструментов");
      const saved = store.get("slug");
      await load((syms.find((s) => s.slug === saved) || syms[0]).slug);
    } catch (e) {
      $("#splash").outerHTML = `<div class="err" id="splash"><h2>Данные не загрузились</h2>
        <p class="sub">${esc(e.message)}. Проверьте соединение. Если открываете впервые, подождите первого запуска workflow.</p>
        <button type="button" id="retry">Повторить</button></div>`;
      $("#retry").addEventListener("click", () => location.reload());
    }
  }

  // ---------- метрики ----------
  function verdict(m) {
    if (!m || !m.n || !m.base) return null;
    const s = (m.base - m.model) / m.base;
    return { s, key: s >= NOISE ? "better" : s <= -NOISE ? "worse" : "same" };
  }
  const VT = {
    better: { icon: "check", cls: "ok", text: "лучше базы" },
    same: { icon: "eq", cls: "mid", text: "на уровне базы" },
    worse: { icon: "cross", cls: "bad", text: "хуже базы" },
  };

  function headline(fc) {
    const a = verdict(fc.metrics.direction.all), r = verdict(fc.metrics.direction.recent);
    if (!a || !r) return { cls: "mid", icon: "eq", t: "Мало данных", d: "Не хватает истории, чтобы оценить модель." };
    if (a.key === "better" && r.key === "better")
      return { cls: "ok", icon: "check", t: "Есть сигнал", d: "По направлению модель стабильно точнее простых частот: и за всё время, и за последний год." };
    if (a.key === "worse" && r.key !== "better")
      return { cls: "bad", icon: "cross", t: "Сигнала нет", d: "По направлению модель проигрывает простым частотам. Проценты в прогнозе читайте как шум, а не как сигнал." };
    if (a.key === "same" && r.key === "same")
      return { cls: "mid", icon: "eq", t: "На уровне базы", d: "По направлению модель не лучше обычных частот. Информативнее могут быть риски ниже." };
    return { cls: "mid", icon: "eq", t: "Сигнал нестабилен", d: `По направлению за всё время модель ${VT[a.key].text}, за последний год ${VT[r.key].text}.` };
  }

  // ---------- блоки ----------
  function strip(p, tall) {
    const parts = CLS.map((c, i) => p[i] > 0.004
      ? `<i class="b-${c.k}" style="flex:${p[i]} 1 0">${tall && p[i] >= 0.13 ? pc(p[i]) : ""}</i>` : "").join("");
    const label = CLS.map((c, i) => `${c.name.toLowerCase()} ${pc(p[i])}`).join(", ");
    return `<div class="strip ${tall ? "tall" : "thin"}" role="img" aria-label="${label}">${parts}</div>`;
  }

  function spark(vals) {
    if (!vals || vals.length < 2) return "";
    const W = 110, Hh = 34, lo = Math.min(...vals), hi = Math.max(...vals), pad = 4;
    const X = (i) => pad + (i / (vals.length - 1)) * (W - 2 * pad);
    const Y = (v) => Hh - pad - ((v - lo) / (hi - lo || 1)) * (Hh - 2 * pad);
    const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join("");
    return `<svg class="spark" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Цена за 60 дней">
      <path d="${d}"/><circle cx="${X(vals.length - 1)}" cy="${Y(vals[vals.length - 1])}" r="5"/></svg>`;
  }

  function renderTop() {
    const syms = state.index.symbols;
    $("#tabs").innerHTML = syms.map((s) =>
      `<button type="button" data-slug="${esc(s.slug)}" aria-pressed="${s.slug === state.slug}">${esc(s.symbol.split("/")[0])}</button>`).join("");
    const fc = state.fc;
    const ageH = (Date.now() - Date.parse(fc.generated_at)) / 36e5;
    const stale = ageH > STALE_H;
    $("#fresh").className = "fresh" + (stale ? " old" : "");
    $("#fresh").textContent = (stale ? "Не обновлялось с " : "Обновлено ") + fmtDT(fc.generated_at);

    const notes = [];
    if (fc.demo) notes.push("Это демо-данные на синтетических свечах: цифры ничего не значат. Настоящий прогноз появится после первого запуска workflow.");
    if (stale && !fc.demo) notes.push("Прогноз устарел: ежедневный запуск не отработал. Откройте вкладку Actions в репозитории и посмотрите ошибку.");
    if (!navigator.onLine) notes.push("Нет сети: показан последний сохранённый прогноз.");
    $("#notes").innerHTML = notes.map((t) => `<div class="note" role="status">${ICONS.warn}<span>${esc(t)}</span></div>`).join("");
  }

  function renderHero() {
    const fc = state.fc, p = [fc.probs.short, fc.probs.flat, fc.probs.long];
    const b = [fc.base.short, fc.base.flat, fc.base.long];
    const tiles = CLS.map((c, i) => `
      <div class="tile">
        <div class="nm"><span class="sw" style="background:var(--${c.k})"></span>${c.name}</div>
        <div class="v">${pc(p[i])}</div>
        <div class="d">база ${pc(b[i])}<br><b>${spp(p[i] - b[i])}</b></div>
      </div>`).join("");
    $("#hero").innerHTML = `
      <div class="price-row">
        <div><div class="price">${money(fc.price)}</div><div class="sub">закрытие ${fmtDate(fc.asof)}, UTC</div></div>
        ${spark(fc.spark)}
      </div>
      <h1 id="hero-h">Куда пойдёт цена до ${fmtDate(fc.target_date)}</h1>
      <p class="lead">Вероятности на ${fc.horizon_days} дней вперёд от закрытия ${fmtDate(fc.asof)}.</p>
      <div class="strips">
        <span class="cap">модель</span>${strip(p, true)}
        <span class="cap">база</span>${strip(b, false)}
      </div>
      <div class="tiles">${tiles}</div>
      <p class="flatnote">Флэт: за неделю цена остаётся в пределах ±${num(fc.theta * 100, 1)}% (${num(fc.params.theta_k, 1)} недельной волатильности). База: как часто каждый исход случался в обучающих данных.</p>`;
  }

  function meter(label, sub, p, base, cvar, id) {
    const max = Math.max(p, base) > 0.5 ? 1 : 0.5;
    return `
      <div class="risk">
        <div class="risk-h"><span class="risk-t" id="${id}">${label}</span><span class="risk-v">${pc(p)}</span></div>
        <div class="meter" style="--c:var(${cvar})" role="meter" aria-labelledby="${id}" aria-valuemin="0" aria-valuemax="${max * 100}" aria-valuenow="${(p * 100).toFixed(1)}">
          <i class="fill" style="width:${(p / max) * 100}%"></i><b class="tick" style="left:${(base / max) * 100}%"></b>
        </div>
        <div class="meter-scale"><span>0%</span><span>${pc(max)}</span></div>
        <p class="risk-n">${sub} Штрих на шкале: база ${pc(base)}, то есть как часто так бывало раньше.</p>
      </div>`;
  }

  function renderRisks() {
    const fc = state.fc, dd = fc.params.long_dd, st = fc.params.short_stop;
    $("#risks").innerHTML = `
      <h2 id="risks-h">Риски на неделю</h2>
      <div class="risks">
        ${meter(`Просадка лонга ${MINUS}${pc(dd)}`, `Цена хотя бы раз за неделю окажется на ${pc(dd)} ниже входа.`, fc.risk.long_drawdown, fc.base.long_drawdown, "--long", "r-dd")}
        ${meter(`Стоп шорта +${pc(st)}`, `Цена хотя бы раз за неделю окажется на ${pc(st)} выше входа.`, fc.risk.short_stop, fc.base.short_stop, "--short", "r-st")}
      </div>`;
  }

  // --- доверие ---
  function skCell(m, live) {
    if (live && (!m || m.n < MIN_LIVE)) return `<span class="vc wait" title="Живых прогнозов с известным итогом: ${m ? m.n : 0} из ${MIN_LIVE} нужных">${ICONS.clock}${m ? m.n : 0}/${MIN_LIVE}</span>`;
    const v = verdict(m);
    if (!v) return `<span class="vc wait">нет данных</span>`;
    const t = VT[v.key];
    return `<span class="vc ${t.cls}" title="${t.text}">${ICONS[t.icon]}<span class="sr">${t.text}: </span>${spc(v.s, 1)}</span>`;
  }

  function niceMax(v) {
    return [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1].find((x) => x >= v * 1.08) || 1;
  }

  function calChart(tab) {
    const pts = state.fc.calibration[tab] || [];
    if (pts.length < 2) return `<p class="empty">Для этого графика пока мало данных.</p>`;
    const tabDef = CAL_TABS.find((t) => t.key === tab);
    const W = 340, Ht = 236, L = 42, R = 14, T = 12, B = 30;
    const pw = W - L - R, ph = Ht - T - B;
    const vmax = niceMax(Math.max(...pts.map((p) => Math.max(p.pred, p.real))));
    const X = (v) => L + (v / vmax) * pw, Y = (v) => T + ph - (v / vmax) * ph;
    let g = "";
    [0, vmax / 2, vmax].forEach((t) => {
      g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}"/>`;
      g += `<text class="tick" x="${L - 8}" y="${Y(t) + 4}" text-anchor="end">${Math.round(t * 100)}%</text>`;
      g += `<text class="tick" x="${X(t)}" y="${T + ph + 18}" text-anchor="${t === 0 ? "start" : t === vmax ? "end" : "middle"}">${Math.round(t * 100)}%</text>`;
    });
    g += `<line class="diag" x1="${X(0)}" y1="${Y(0)}" x2="${X(vmax)}" y2="${Y(vmax)}"/>`;
    g += `<path class="ln" style="stroke:${tabDef.color}" d="${pts.map((p, i) => `${i ? "L" : "M"}${X(p.pred).toFixed(1)} ${Y(p.real).toFixed(1)}`).join("")}"/>`;
    g += pts.map((p) => `<circle class="dot" style="fill:${tabDef.color}" cx="${X(p.pred).toFixed(1)}" cy="${Y(p.real).toFixed(1)}" r="5"/>`).join("");
    g += pts.map((p, i) => `<circle class="hit" data-i="${i}" cx="${X(p.pred).toFixed(1)}" cy="${Y(p.real).toFixed(1)}" r="16" tabindex="0" role="img"
      aria-label="Модель обещала ${pc(p.pred)}, сбылось ${pc(p.real)}, дней: ${p.n}"/>`).join("");
    const rows = pts.map((p) => `<tr><td>${Math.round(p.lo * 100)}–${Math.round(p.hi * 100)}%</td><td>${p.n}</td><td>${pc(p.pred, 1)}</td><td>${pc(p.real, 1)}</td></tr>`).join("");
    return `
      <p class="sub">${esc(tabDef.full)}</p>
      <div class="chart" id="chart">
        <svg viewBox="0 0 ${W} ${Ht}" role="group" aria-label="Калибровка: ${esc(tabDef.full)}">${g}</svg>
        <div class="tip" id="tip" hidden></div>
      </div>
      <p class="fn">По горизонтали вероятность, которую называла модель; по вертикали как часто событие реально случалось. Точки на диагонали значат честные проценты. Выше диагонали модель занижала вероятность, ниже завышала.</p>
      <details><summary>Таблица калибровки</summary>
        <table><thead><tr><th>Корзина</th><th>Дней</th><th>Прогноз</th><th>Факт</th></tr></thead><tbody>${rows}</tbody></table>
      </details>`;
  }

  function renderTrust() {
    const fc = state.fc, h = headline(fc), M = fc.metrics;
    const rows = TARGETS.map((t) => `<tr><td>${t.label}</td>
      <td>${skCell(M[t.key].all)}</td><td>${skCell(M[t.key].recent)}</td><td>${skCell(M[t.key].live, true)}</td></tr>`).join("");
    const raw = TARGETS.flatMap((t) => [["all", "всё время"], ["recent", "12 мес"], ["live", "вживую"]].map(([k, kn]) => {
      const m = M[t.key][k];
      return m ? `<tr><td>${t.label}</td><td>${kn}</td><td>${m.n}</td><td>${num(m.model, 4)}</td><td>${num(m.base, 4)}</td></tr>` : "";
    })).join("");
    $("#trust").innerHTML = `
      <h2 id="trust-h">Можно ли верить прогнозу</h2>
      <div class="verdict"><span class="vbadge ${h.cls}">${ICONS[h.icon]}${h.t}</span><p>${h.d}</p></div>
      <table class="sk"><thead><tr><th></th><th>Всё время</th><th>12 мес</th><th>Вживую</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="fn">Выигрыш у базы: на сколько процентов ошибка модели меньше ошибки простых частот. Меньше ±${NOISE * 100}% считаем шумом: прогнозы соседних дней перекрываются на ${fc.horizon_days} дней, поэтому реальная выборка примерно в ${fc.horizon_days} раз меньше, чем строк. «Вживую» это прогнозы, сделанные до того, как стал известен итог; пока таких меньше ${MIN_LIVE}, в ячейке видно, сколько уже набралось.</p>
      <details><summary>Метрики подробно</summary>
        <table><thead><tr><th>Цель</th><th>Период</th><th>Дней</th><th>Модель</th><th>База</th></tr></thead><tbody>${raw}</tbody></table>
        <p class="fn">Направление: log loss, риски: Brier. Чем меньше, тем лучше.</p>
      </details>
      <h3 class="sec-sub">Честны ли проценты</h3>
      <div class="cal-tabs" role="group" aria-label="Что показать на графике">
        ${CAL_TABS.map((t) => `<button type="button" data-cal="${t.key}" aria-pressed="${t.key === state.cal}">${t.label}</button>`).join("")}
      </div>
      <div id="cal">${calChart(state.cal)}</div>`;
  }

  // --- история ---
  function histRow(e) {
    const o = e.out, top = e.p.indexOf(Math.max(...e.p));
    const pLabel = CLS.map((c, i) => `${c.name.toLowerCase()} ${pc(e.p[i])}`).join(", ");
    let res, flags = "";
    if (o) {
      const c = CLS[o.cls];
      res = `<span class="res" title="Итог: ${c.name.toLowerCase()}">
        <span style="color:${c.k === "flat" ? "var(--muted)" : `var(--${c.k})`}">${ICONS[c.icon]}</span>${spc(o.ret, 1)}${top === o.cls ? `<span title="Модель ставила на этот исход" style="color:var(--ink2)">${ICONS.check}</span>` : ""}</span>`;
      const f = [];
      if (o.dd_hit) f.push(`<span><span style="color:var(--long)">${ICONS.down}</span>касание ${MINUS}${pc(state.fc.params.long_dd)}, прогноз был ${pc(e.dd)}</span>`);
      if (o.stop_hit) f.push(`<span><span style="color:var(--short)">${ICONS.up}</span>касание +${pc(state.fc.params.short_stop)}, прогноз был ${pc(e.stop)}</span>`);
      flags = f.length ? `<div class="flags">${f.join("")}</div>` : "";
    } else {
      res = `<span class="res wait">${ICONS.clock}до ${fmtDate(addDays(e.asof, state.fc.horizon_days))}</span>`;
    }
    return `<li class="row" aria-label="Прогноз от ${fmtDate(e.asof)}: ${pLabel}">
      <div class="dt">${fmtDate(e.asof)}<small>${e.src === "live" ? "вживую" : "бэктест"}</small></div>
      ${strip(e.p, false)}${res}${flags}</li>`;
  }

  function renderHistory() {
    const all = [...state.hist].sort((a, b) => (a.asof < b.asof ? 1 : -1));
    const list = state.histFilter === "live" ? all.filter((e) => e.src === "live") : all;
    const shown = list.slice(0, state.histN);
    const liveDone = all.filter((e) => e.src === "live" && e.out).length;
    let body;
    if (!list.length) {
      body = `<p class="empty">Здесь пока пусто.</p>`;
    } else {
      body = `<ol class="rows">${shown.map(histRow).join("")}</ol>` +
        (list.length > shown.length ? `<button type="button" class="more" id="more">Показать ещё ${Math.min(14, list.length - shown.length)}</button>` : "");
      if (state.histFilter === "live" && !liveDone) {
        const first = [...all].reverse().find((e) => e.src === "live");
        body += `<p class="empty">Первый итог живого прогноза появится ${fmtDate(addDays(first.asof, state.fc.horizon_days + 1))}.</p>`;
      }
    }
    $("#history").innerHTML = `
      <div class="hist-h">
        <h2 id="hist-h">История прогнозов</h2>
        <div class="chips" role="group" aria-label="Фильтр">
          <button type="button" data-hf="all" aria-pressed="${state.histFilter === "all"}">Все</button>
          <button type="button" data-hf="live" aria-pressed="${state.histFilter === "live"}">Вживую</button>
        </div>
      </div>
      <p class="sub" style="margin-top:6px">Полоса: что обещала модель (шорт, флэт, лонг). Справа: что случилось через ${state.fc.horizon_days} дней. «Бэктест» посчитан задним числом, «вживую» записан до итога.</p>
      ${body}`;
  }

  function renderFoot() {
    const fc = state.fc, srcName = { binanceusdm: "Binance Futures", bybit: "Bybit", bitstamp: "Bitstamp (спот, USD)", demo: "синтетика" }[fc.source] || fc.source;
    $("#foot").innerHTML = `
      <p>Свечи: ${esc(srcName)}, дневное закрытие по UTC. Обновлено ${fmtDT(fc.generated_at)}.</p>
      <p>Это статистическая оценка по прошлым данным, а не рекомендация. Если «Можно ли верить» показывает «Сигнала нет», не ставьте на проценты выше.</p>`;
  }

  function render() {
    $("#splash").hidden = true;
    $("#cols").hidden = false;
    $("#foot").hidden = false;
    renderTop(); renderHero(); renderRisks(); renderTrust(); renderHistory(); renderFoot();
    document.title = `${state.fc.symbol.split("/")[0]}: прогноз на неделю`;
  }

  // ---------- события ----------
  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest("button");
    if (!t) { hideTip(); return; }
    if (t.dataset.slug && t.dataset.slug !== state.slug) { state.histN = 14; await load(t.dataset.slug).catch(() => {}); }
    else if (t.dataset.cal) { state.cal = t.dataset.cal; renderTrust(); }
    else if (t.dataset.hf) { state.histFilter = t.dataset.hf; state.histN = 14; renderHistory(); }
    else if (t.id === "more") { state.histN += 14; renderHistory(); }
  });

  // тултип калибровки
  function showTip(c) {
    const chart = $("#chart"), tip = $("#tip");
    if (!chart || !tip) return;
    const p = state.fc.calibration[state.cal][+c.dataset.i];
    tip.innerHTML = `Модель обещала <b>${pc(p.pred, 1)}</b>, сбылось <b>${pc(p.real, 1)}</b><br>${p.n} дн. в корзине ${Math.round(p.lo * 100)}–${Math.round(p.hi * 100)}%`;
    tip.hidden = false;
    const cr = c.getBoundingClientRect(), wr = chart.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const x = Math.min(Math.max(cr.left - wr.left + cr.width / 2, half), wr.width - half);
    tip.style.left = x + "px";
    tip.style.top = Math.max(cr.top - wr.top + cr.height / 2 - 10, tip.offsetHeight + 2) + "px";
  }
  function hideTip() { const tip = $("#tip"); if (tip) tip.hidden = true; }
  document.addEventListener("pointerover", (ev) => { const c = ev.target.closest(".hit"); if (c) showTip(c); });
  document.addEventListener("pointerout", (ev) => { if (ev.target.closest(".hit")) hideTip(); });
  document.addEventListener("pointerdown", (ev) => { const c = ev.target.closest(".hit"); if (c) showTip(c); else hideTip(); });
  document.addEventListener("focusin", (ev) => { const c = ev.target.closest(".hit"); if (c) showTip(c); });
  document.addEventListener("focusout", hideTip);

  // при возврате в приложение освежаем данные, если им больше 10 минут
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.slug && Date.now() - state.loadedAt > 10 * 60 * 1000) load(state.slug).catch(() => {});
  });
  window.addEventListener("online", () => state.fc && load(state.slug).catch(() => {}));
  window.addEventListener("offline", () => state.fc && renderTop());

  boot();
})();
