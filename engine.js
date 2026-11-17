/* Crypto Intelligence System — shared engine.
   Phases 1–7: legacy CORE (from BINANCE LONG SYSTEM – SMC QUANT PRO, unchanged except the 5m timeframe)
   + DATA layer (universe, filters, ticker and candle quality, source health, retry, de-dup)
   + ATTN (attention) + NARR (narratives) + QUANT (quant, SMC, MTF) + FLOW (exchange flow, wallet registry) + SIG (CIS, signals, risk) + PORT (portfolio, journal) + BT (historical replay, walk-forward, paper trading) + acceptance tests. Pure computation; runs in the browser (window.CISEngine) and in Node (require). */
(function (root) {
"use strict";
const CORE = (() => {
  const TF_MS = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
  const isNum = (x) => typeof x === 'number' && isFinite(x);

  /* ---------- precision helpers ---------- */
  function stepDecimals(step) {
    const s = String(step);
    if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
    const p = s.split('.')[1];
    return p ? p.replace(/0+$/, '').length : 0;
  }
  // floor/ceil/round a value to a step using integer arithmetic
  function roundStep(value, step, mode = 'floor') {
    const st = Number(step);
    if (!(st > 0)) return value;
    const d = stepDecimals(step);
    const scale = Math.pow(10, d);
    const v = Math.round(value * scale * 1e6) / 1e6; // value in step-decimal units (with fp guard)
    const stUnits = Math.round(st * scale);
    let units;
    if (mode === 'ceil') units = Math.ceil(v / stUnits - 1e-9) * stUnits;
    else if (mode === 'round') units = Math.round(v / stUnits) * stUnits;
    else units = Math.floor(v / stUnits + 1e-9) * stUnits;
    return Number((units / scale).toFixed(d));
  }

  /* ---------- robust payload parsing ---------- */
  function extractJSON(p) {
    if (p == null) return null;
    if (typeof p !== 'string') return p;
    try { return JSON.parse(p); } catch (e) { /* fall through */ }
    const start = p.search(/[\[{]/);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < p.length; i++) {
      const c = p[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { depth--; if (depth === 0) { try { return JSON.parse(p.slice(start, i + 1)); } catch (e) { return null; } } }
    }
    return null;
  }

  /* ---------- normalization & validation ---------- */
  function normalizeKlines(raw, { symbol, tf, nowMs, fetchedAt, source }) {
    const errors = [], warnings = [];
    const iv = TF_MS[tf];
    if (!Array.isArray(raw)) {
      return { candles: [], meta: { symbol, tf, exchange: 'Binance Spot', source, fetchedAt, valid: false, status: 'DATA UNAVAILABLE', errors: ['Response is not a kline array'], warnings } };
    }
    const candles = [];
    for (const k of raw) {
      if (!Array.isArray(k) || k.length < 7) { errors.push('Malformed kline row'); continue; }
      const c = { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: +k[6], qv: +k[7] };
      if (![c.t, c.o, c.h, c.l, c.c, c.v, c.ct].every(isNum)) { errors.push('Non-numeric kline at ' + k[0]); continue; }
      if (c.h < Math.max(c.o, c.c) - 1e-12 || c.l > Math.min(c.o, c.c) + 1e-12 || c.l <= 0) { errors.push('OHLC inconsistency at ' + new Date(c.t).toISOString()); continue; }
      c.closed = c.ct < nowMs;
      candles.push(c);
    }
    let gaps = 0;
    for (let i = 1; i < candles.length; i++) {
      const d = candles[i].t - candles[i - 1].t;
      if (d <= 0) errors.push('Timestamps not ascending');
      else if (iv && d !== iv) gaps++;
    }
    if (gaps) warnings.push(gaps + ' time gap(s) between candles (exchange maintenance or delisting pause)');
    const last = candles[candles.length - 1];
    let freshness = 'UNKNOWN';
    if (last && iv) {
      const expectedOpen = Math.floor(nowMs / iv) * iv;
      freshness = last.t >= expectedOpen - iv ? 'FRESH' : 'STALE';
    }
    const closedCount = candles.filter((c) => c.closed).length;
    const valid = errors.length === 0 && candles.length > 0;
    let status = 'VALID';
    if (!candles.length) status = 'DATA UNAVAILABLE';
    else if (!valid) status = 'INVALID';
    else if (freshness === 'STALE') status = 'DATA STALE';
    return {
      candles,
      meta: {
        symbol, tf, exchange: 'Binance Spot', source, fetchedAt,
        count: candles.length, closedCount, formingCount: candles.length - closedCount,
        firstOpen: candles[0] && candles[0].t, lastOpen: last && last.t, lastClose: last && last.ct,
        lastStatus: last ? (last.closed ? 'closed' : 'forming') : null,
        freshness, valid: valid && freshness !== 'STALE', status, errors, warnings,
      },
    };
  }

  /* ---------- indicators ---------- */
  function sma(arr, n) {
    const out = new Array(arr.length).fill(null); let s = 0;
    for (let i = 0; i < arr.length; i++) { s += arr[i]; if (i >= n) s -= arr[i - n]; if (i >= n - 1) out[i] = s / n; }
    return out;
  }
  function ema(arr, n) {
    const out = new Array(arr.length).fill(null); if (arr.length < n) return out;
    const k = 2 / (n + 1); let prev = 0;
    for (let i = 0; i < n; i++) prev += arr[i];
    prev /= n; out[n - 1] = prev;
    for (let i = n; i < arr.length; i++) { prev = arr[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }
  function atr(c, n = 14) {
    const out = new Array(c.length).fill(null); if (c.length <= n) return out;
    const tr = c.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)));
    let a = 0; for (let i = 1; i <= n; i++) a += tr[i]; a /= n; out[n] = a;
    for (let i = n + 1; i < c.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
    return out;
  }
  function rsi(closes, n = 14) {
    const out = new Array(closes.length).fill(null); if (closes.length <= n) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n; out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  /* ---------- swings (fractal pivots, closed candles only) ---------- */
  function findSwings(c, left = 3, right = 3) {
    const sw = [];
    for (let i = left; i < c.length - right; i++) {
      let isH = true, isL = true;
      for (let j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        if (j < i ? c[j].h >= c[i].h : c[j].h > c[i].h) isH = false;
        if (j < i ? c[j].l <= c[i].l : c[j].l < c[i].l) isL = false;
      }
      if (isH) sw.push({ i, t: c[i].t, price: c[i].h, type: 'H', confirmedAt: i + right });
      if (isL) sw.push({ i, t: c[i].t, price: c[i].l, type: 'L', confirmedAt: i + right });
    }
    // label HH/LH/HL/LL
    let pH = null, pL = null;
    for (const s of sw) {
      if (s.type === 'H') { s.label = pH == null ? 'H' : s.price > pH ? 'HH' : 'LH'; pH = s.price; }
      else { s.label = pL == null ? 'L' : s.price > pL ? 'HL' : 'LL'; pL = s.price; }
    }
    return sw;
  }

  /* ---------- BOS / CHoCH / MSS on candle close ---------- */
  function structureEvents(c, swings, atrArr, { mssAtr = 1.0 } = {}) {
    const events = []; let trend = 'none';
    let actH = null, actL = null; let si = 0;
    const byConf = swings.slice().sort((a, b) => a.confirmedAt - b.confirmedAt);
    for (let i = 0; i < c.length; i++) {
      while (si < byConf.length && byConf[si].confirmedAt <= i) {
        const s = byConf[si++];
        if (s.type === 'H') actH = s; else actL = s;
      }
      const x = c[i];
      if (actH && x.c > actH.price) {
        const type = trend === 'bear' ? 'CHoCH' : 'BOS';
        const body = Math.abs(x.c - x.o);
        events.push({ i, t: x.t, dir: 'bull', type, level: actH.price, swing: actH, mss: type === 'CHoCH' && atrArr[i] != null && body >= mssAtr * atrArr[i] });
        trend = 'bull'; actH = null;
      } else if (actL && x.c < actL.price) {
        const type = trend === 'bull' ? 'CHoCH' : 'BOS';
        const body = Math.abs(x.c - x.o);
        events.push({ i, t: x.t, dir: 'bear', type, level: actL.price, swing: actL, mss: type === 'CHoCH' && atrArr[i] != null && body >= mssAtr * atrArr[i] });
        trend = 'bear'; actL = null;
      }
    }
    return { events, trend };
  }

  /* ---------- Fair Value Gaps ---------- */
  function findFVGs(c, atrArr, { minAtr = 0.1 } = {}) {
    const out = [];
    for (let i = 2; i < c.length; i++) {
      const a = atrArr[i] || atrArr[c.length - 1] || 0;
      if (c[i].l > c[i - 2].h) {
        const top = c[i].l, bottom = c[i - 2].h, size = top - bottom;
        if (a && size < minAtr * a) continue;
        let minLow = Infinity;
        for (let j = i + 1; j < c.length; j++) minLow = Math.min(minLow, c[j].l);
        const filled = minLow === Infinity ? 0 : Math.max(0, Math.min(1, (top - minLow) / size));
        out.push({ dir: 'bull', i: i - 1, t: c[i - 1].t, top, bottom, size, sizePct: size / c[i].c * 100, sizeAtr: a ? size / a : null, filled, status: filled >= 1 ? 'Filled' : filled > 0 ? 'Partially mitigated' : 'Open' });
      } else if (c[i].h < c[i - 2].l) {
        const top = c[i - 2].l, bottom = c[i].h, size = top - bottom;
        if (a && size < minAtr * a) continue;
        let maxHigh = -Infinity;
        for (let j = i + 1; j < c.length; j++) maxHigh = Math.max(maxHigh, c[j].h);
        const filled = maxHigh === -Infinity ? 0 : Math.max(0, Math.min(1, (maxHigh - bottom) / size));
        out.push({ dir: 'bear', i: i - 1, t: c[i - 1].t, top, bottom, size, sizePct: size / c[i].c * 100, sizeAtr: a ? size / a : null, filled, status: filled >= 1 ? 'Filled' : filled > 0 ? 'Partially mitigated' : 'Open' });
      }
    }
    return out;
  }

  /* ---------- Order Blocks & estimated demand/supply ---------- */
  function zoneStatus(c, z, from) {
    let touchedAt = null, invalidAt = null;
    for (let j = from + 1; j < c.length; j++) {
      if (z.dir === 'bull') {
        if (touchedAt == null && c[j].l <= z.top) touchedAt = j;
        if (c[j].c < z.bottom) { invalidAt = j; break; }
      } else {
        if (touchedAt == null && c[j].h >= z.bottom) touchedAt = j;
        if (c[j].c > z.top) { invalidAt = j; break; }
      }
    }
    z.touchedAt = touchedAt; z.invalidAt = invalidAt;
    z.mitigation = touchedAt == null ? 'Unmitigated' : 'Mitigated';
    z.validity = invalidAt != null ? 'Invalidated' : 'Valid';
    return z;
  }
  function findOrderBlocks(c, events, atrArr, fvgs, { dispAtr = 1.5, lookback = 6 } = {}) {
    const out = [];
    for (const ev of events) {
      const bull = ev.dir === 'bull';
      // origin of the leg: extreme between the broken swing and the break candle
      let m = ev.swing.i, ext = bull ? Infinity : -Infinity;
      for (let j = ev.swing.i; j <= ev.i; j++) {
        if (bull ? c[j].l < ext : c[j].h > ext) { ext = bull ? c[j].l : c[j].h; m = j; }
      }
      let ob = null;
      for (let j = m; j >= Math.max(0, m - lookback); j--) {
        const isOpp = bull ? c[j].c < c[j].o : c[j].c > c[j].o;
        if (isOpp) { ob = j; break; }
      }
      if (ob == null) continue;
      const a = atrArr[ev.i] || atrArr[c.length - 1] || 0;
      const legSize = bull ? Math.max(...c.slice(m, ev.i + 1).map((x) => x.h)) - ext : ext - Math.min(...c.slice(m, ev.i + 1).map((x) => x.l));
      const hasFvg = fvgs.some((f) => f.dir === ev.dir && f.i >= ob && f.i <= ev.i);
      const displaced = a ? legSize >= dispAtr * a : false;
      const confirmed = hasFvg || displaced;
      const z = { dir: ev.dir, i: ob, t: c[ob].t, top: c[ob].h, bottom: bull ? Math.min(c[ob].l, ext) : c[ob].l, eventIdx: ev.i, eventType: ev.type, kind: confirmed ? 'Order Block' : 'Estimated zone', confirmed, hasFvg, displaced };
      if (!bull) z.top = Math.max(c[ob].h, ext);
      zoneStatus(c, z, ev.i);
      out.push(z);
    }
    // de-duplicate (same candle)
    const seen = new Set();
    return out.filter((z) => { const k = z.dir + z.i; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  // Estimated demand: swing lows that produced a strong rally without a structure break
  function estimatedDemand(c, swings, events, atrArr, { rallyAtr = 2, bars = 10 } = {}) {
    const out = [];
    for (const s of swings.filter((x) => x.type === 'L')) {
      if (events.some((e) => e.dir === 'bull' && e.i > s.i && e.i <= s.i + bars)) continue;
      const a = atrArr[s.i] || atrArr[c.length - 1]; if (!a) continue;
      const hi = Math.max(...c.slice(s.i, Math.min(c.length, s.i + bars + 1)).map((x) => x.h));
      if (hi - s.price < rallyAtr * a) continue;
      const k = c[s.i];
      const z = { dir: 'bull', i: s.i, t: k.t, top: Math.max(k.o, k.c), bottom: k.l, kind: 'Estimated zone', confirmed: false };
      if (z.top - z.bottom < 0.1 * a) z.top = z.bottom + 0.25 * a;
      zoneStatus(c, z, s.i);
      out.push(z);
    }
    return out;
  }

  /* ---------- Liquidity: BSL/SSL, EQH/EQL, sweeps ---------- */
  function liquidity(c, swings, atrArr, { eqTolAtr = 0.1, reclaimBars = 3 } = {}) {
    const a = atrArr[c.length - 1] || 0;
    const levels = swings.map((s) => {
      const L = { type: s.type === 'H' ? 'BSL' : 'SSL', price: s.price, i: s.i, t: s.t, swept: false, sweptAt: null, reclaimAt: null, sweepType: null, sweepExtreme: null };
      for (let j = s.i + 1; j < c.length; j++) {
        if (L.type === 'SSL' && c[j].l < s.price) {
          L.swept = true; L.sweptAt = j; L.sweepExtreme = c[j].l;
          if (c[j].c > s.price) { L.sweepType = 'Sweep & Reclaim'; L.reclaimAt = j; }
          else {
            for (let k = j + 1; k <= Math.min(c.length - 1, j + reclaimBars); k++) {
              L.sweepExtreme = Math.min(L.sweepExtreme, c[k].l);
              if (c[k].c > s.price) { L.sweepType = 'Sweep & Reclaim'; L.reclaimAt = k; break; }
            }
            if (!L.reclaimAt) L.sweepType = 'Broken';
          }
          break;
        }
        if (L.type === 'BSL' && c[j].h > s.price) {
          L.swept = true; L.sweptAt = j; L.sweepExtreme = c[j].h;
          if (c[j].c < s.price) { L.sweepType = 'Sweep & Reject'; L.reclaimAt = j; }
          else {
            for (let k = j + 1; k <= Math.min(c.length - 1, j + reclaimBars); k++) {
              L.sweepExtreme = Math.max(L.sweepExtreme, c[k].h);
              if (c[k].c < s.price) { L.sweepType = 'Sweep & Reject'; L.reclaimAt = k; break; }
            }
            if (!L.reclaimAt) L.sweepType = 'Broken';
          }
          break;
        }
      }
      return L;
    });
    // equal highs / lows among unswept levels
    const equals = [];
    for (const type of ['BSL', 'SSL']) {
      const pool = levels.filter((l) => l.type === type && !l.swept);
      for (let x = 0; x < pool.length; x++) for (let y = x + 1; y < pool.length; y++) {
        if (a && Math.abs(pool[x].price - pool[y].price) <= eqTolAtr * a) {
          equals.push({ type: type === 'BSL' ? 'EQH' : 'EQL', price: (pool[x].price + pool[y].price) / 2, i: pool[x].i, j: pool[y].i, t: pool[x].t });
        }
      }
    }
    return { levels, equals };
  }

  /* ---------- Dealing range / premium-discount ---------- */
  function dealingRange(c, swings) {
    const hs = swings.filter((s) => s.type === 'H'), ls = swings.filter((s) => s.type === 'L');
    if (!hs.length || !ls.length || !c.length) return null;
    const sh = hs[hs.length - 1], sl = ls[ls.length - 1];
    const from = Math.min(sh.i, sl.i);
    let high = sh.price, low = sl.price, hiIdx = sh.i, loIdx = sl.i;
    for (let j = from; j < c.length; j++) {
      if (c[j].h > high) { high = c[j].h; hiIdx = j; }
      if (c[j].l < low) { low = c[j].l; loIdx = j; }
    }
    const price = c[c.length - 1].c;
    const pos = high > low ? (price - low) / (high - low) : 0.5;
    const zone = pos < 0.45 ? 'Discount' : pos > 0.55 ? 'Premium' : 'Equilibrium';
    return { high, low, eq: (high + low) / 2, pos, zone, hiIdx, loIdx };
  }

  /* ---------- per-timeframe analysis ---------- */
  const DEFAULT_PARAMS = {
    swingLeft: { '1d': 3, '4h': 3, '1h': 3, '15m': 2 },
    swingRight: { '1d': 3, '4h': 3, '1h': 3, '15m': 2 },
    mssAtr: 1.0, fvgMinAtr: 0.1, obDispAtr: 1.5, eqTolAtr: 0.1, reclaimBars: 3,
    reversalBars: 15, rangeBars: 60,
    // signal
    sweepLookback: { '1h': 24, '4h': 12 }, zoneReactBars: 6, discountMax: 0.5,
    triggerBars: 8, chaseAtr: 1.0, slBufferAtr: 0.25, slMode: 'auto', liqAware: 'on', liqBufferAtr: 0.5, minRR: 2.0, rrTarget: 'TP2', maxSlPct: 8,
    feePct: 0.1, slipPct: 0.05, minCandles: 60,
  };

  function analyzeTF(all, tf, P = DEFAULT_PARAMS) {
    const c = all.filter((x) => x.closed); // structure only on closed candles
    const forming = all.find((x) => !x.closed) || null;
    const res = { tf, ok: c.length >= P.minCandles, n: c.length, forming };
    if (!c.length) return res;
    const closes = c.map((x) => x.c), vols = c.map((x) => x.v);
    const A = atr(c, 14), e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200), vS = sma(vols, 20), R = rsi(closes, 14);
    const sw = findSwings(c, P.swingLeft[tf] ?? 3, P.swingRight[tf] ?? 3);
    const st = structureEvents(c, sw, A, { mssAtr: P.mssAtr });
    const fv = findFVGs(c, A, { minAtr: P.fvgMinAtr });
    const obs = findOrderBlocks(c, st.events, A, fv, { dispAtr: P.obDispAtr });
    const est = estimatedDemand(c, sw, st.events, A);
    const liq = liquidity(c, sw, A, { eqTolAtr: P.eqTolAtr, reclaimBars: P.reclaimBars });
    const dr = dealingRange(c, sw);
    const L = c.length - 1, last = c[L];
    const lastEv = st.events[st.events.length - 1] || null;
    let cls = 'Ranging';
    if (!res.ok) cls = 'No Trade';
    else if (lastEv && lastEv.type === 'CHoCH' && L - lastEv.i <= P.reversalBars) cls = 'Potential Reversal';
    else if (!lastEv || L - lastEv.i > P.rangeBars) cls = 'Ranging';
    else if (st.trend === 'bull' && e50[L] != null && last.c > e50[L]) cls = 'Bullish Trend';
    else if (st.trend === 'bear' && e50[L] != null && last.c < e50[L]) cls = 'Bearish Trend';
    Object.assign(res, {
      candles: c, all, atr: A, ema20: e20, ema50: e50, ema200: e200, volSma: vS, rsi: R,
      swings: sw, events: st.events, trend: st.trend, lastEvent: lastEv,
      fvgs: fv, obs, est, liq, dr, cls,
      last, atrLast: A[L], atrPct: A[L] ? A[L] / last.c * 100 : null,
      relVol: vS[L] ? last.v / vS[L] : null,
      emaAlign: e200[L] != null ? (e20[L] > e50[L] && e50[L] > e200[L] ? 'Bull stack' : e20[L] < e50[L] && e50[L] < e200[L] ? 'Bear stack' : 'Mixed') : (e50[L] != null ? (e20[L] > e50[L] ? 'Bull (20>50)' : 'Bear (20<50)') : 'n/a'),
      lastHigh: [...sw].reverse().find((s) => s.type === 'H') || null,
      lastLow: [...sw].reverse().find((s) => s.type === 'L') || null,
    });
    return res;
  }

  /* ---------- cost-aware R:R ---------- */
  function rr(entry, sl, tp, feePct, slipPct) {
    const cst = (feePct + slipPct) / 100;
    const risk = entry - sl, reward = tp - entry;
    const netRisk = risk + entry * cst + sl * cst;
    const netReward = reward - entry * cst - tp * cst;
    return { gross: risk > 0 ? reward / risk : null, net: netRisk > 0 ? netReward / netRisk : null, netRiskPerUnit: netRisk, netRewardPerUnit: netReward };
  }


  /* ---------- SMC stop placement ---------- */
  // zone: below HTF zone low (sweep extreme / OB low) − buffer×ATR(1H)
  // refined: below the 15M protected low (origin of the leg that produced the trigger break) − buffer×ATR(15M)
  // liquidity-aware: if unswept SSL/EQL rests between the structural low and liqBufferAtr×ATR(1H) beneath the stop, move the stop beneath that pool
  function computeStop({ zoneLow, protectedLow, entry, atr1h, atr15, pools = [], P }) {
    if (!(zoneLow > 0) || !(atr1h > 0)) return { sl: null, reason: 'Zone low or ATR(1H) unavailable' };
    const zone = { used: 'zone', structural: zoneLow, buf: P.slBufferAtr * atr1h, label: `zone low ${fmtP(zoneLow)} − ${P.slBufferAtr}×ATR(1H)` };
    const refOk = protectedLow != null && isFinite(protectedLow) && protectedLow >= zoneLow && protectedLow < entry && atr15 > 0;
    const ref = refOk ? { used: 'refined', structural: protectedLow, buf: P.slBufferAtr * atr15, label: `15M protected low ${fmtP(protectedLow)} − ${P.slBufferAtr}×ATR(15M)` } : null;
    let pick;
    if (P.slMode === 'zone') pick = zone;
    else if (P.slMode === 'refined') { if (!ref) return { sl: null, reason: 'Refined mode: no valid 15M protected low inside the zone (needs a 15M trigger whose leg low holds above the zone low)' }; pick = ref; }
    else pick = ref || zone;
    let sl = pick.structural - pick.buf; let liq = null;
    const dist = (P.liqBufferAtr || 0) * atr1h;
    for (let k = 0; k < 3; k++) {
      const hit = pools.filter((q) => q.price < pick.structural && q.price >= sl - dist && q.price < entry);
      if (!hit.length) break;
      const low = hit.reduce((a, b) => (b.price < a.price ? b : a));
      const nsl = low.price - pick.buf;
      if (!(nsl < sl)) break;
      liq = { price: low.price, src: low.src }; sl = nsl;
    }
    const basis = (P.slMode === 'auto' ? (pick.used === 'refined' ? 'Auto → refined: ' : 'Auto → zone (no valid 15M protected low): ') : '') + pick.label + (liq ? `, moved below resting ${liq.src} ${fmtP(liq.price)}` : '');
    return { sl, used: pick.used, structural: pick.structural, basis, liq };
  }
  /* ---------- signal engine (long only) ---------- */
  function mergeLevels(levels, tolPct = 0.2) {
    const s = levels.filter((l) => isNum(l.price)).sort((a, b) => a.price - b.price); const out = [];
    for (const l of s) { const p = out[out.length - 1]; if (p && (l.price - p.price) / p.price * 100 < tolPct) { p.src += ' + ' + l.src; } else out.push({ ...l }); }
    return out;
  }
  function signal(mtf, price, P = DEFAULT_PARAMS, filters = null) {
    const { d, h4, h1, m15 } = mtf;
    const checks = [];
    const add = (id, name, pass, detail) => checks.push({ id, name, pass: !!pass, detail });
    const dataOk = [d, h4, h1, m15].every((x) => x && x.ok);
    if (!dataOk || !isNum(price)) {
      return { status: 'NO TRADE', reason: 'Data unavailable, stale or insufficient on at least one timeframe', checks, dataOk: false };
    }
    const D = d.candles.length - 1;
    // 1
    const c1 = d.trend === 'bull' && d.ema50[D] != null && d.last.c > d.ema50[D];
    add(1, 'Daily trend bullish', c1, `1D structure ${d.trend.toUpperCase()}, close ${fmtP(d.last.c)} vs EMA50 ${fmtP(d.ema50[D])}`);
    // 2
    add(2, '4H structure bullish', h4.trend === 'bull', `4H structure ${h4.trend.toUpperCase()}${h4.lastEvent ? `, last ${h4.lastEvent.dir} ${h4.lastEvent.type} @ ${fmtP(h4.lastEvent.level)}` : ''}`);
    // 3
    const h1rev = h1.lastEvent && h1.lastEvent.dir === 'bull' && h1.lastEvent.type === 'CHoCH';
    add(3, '1H bullish structure / validated reversal', h1.trend === 'bull', h1.trend === 'bull' ? (h1rev ? `Bullish CHoCH confirmed @ ${fmtP(h1.lastEvent.level)}` : 'Bullish structure (BOS sequence)') : `1H structure ${h1.trend.toUpperCase()}`);
    // 4 – zone: SSL sweep & reclaim or reaction at valid demand/OB
    let zone = null;
    for (const [tfA, lb] of [[h1, P.sweepLookback['1h']], [h4, P.sweepLookback['4h']]]) {
      const L = tfA.candles.length - 1;
      const sw = tfA.liq.levels.filter((l) => l.type === 'SSL' && l.sweepType === 'Sweep & Reclaim' && L - l.reclaimAt <= lb && price > l.sweepExtreme);
      for (const s of sw) {
        const z = { src: `${tfA.tf.toUpperCase()} SSL sweep & reclaim`, low: s.sweepExtreme, high: s.price, t: tfA.candles[s.reclaimAt].t, tf: tfA.tf };
        if (!zone || z.t > zone.t) zone = z;
      }
    }
    if (!zone) {
      for (const tfA of [h1, h4]) {
        const L = tfA.candles.length - 1;
        const zs = [...tfA.obs, ...tfA.est].filter((z) => z.dir === 'bull' && z.validity === 'Valid' && z.touchedAt != null && L - z.touchedAt <= P.zoneReactBars && tfA.last.c > z.bottom && price > z.bottom);
        for (const z0 of zs) {
          const z = { src: `${tfA.tf.toUpperCase()} ${z0.confirmed ? 'bullish OB' : 'estimated demand'}`, low: z0.bottom, high: z0.top, t: tfA.candles[z0.touchedAt].t, tf: tfA.tf, confirmed: z0.confirmed };
          if (!zone || (z.confirmed && !zone.confirmed) || z.t > zone.t) zone = z;
        }
      }
    }
    add(4, 'SSL sweep & reclaim or reaction at valid demand/OB', !!zone, zone ? `${zone.src}: ${fmtP(zone.low)} – ${fmtP(zone.high)}` : 'No recent sweep & reclaim and no reaction at a valid bullish zone');
    const M = m15.candles.length - 1;
    const trig = [...m15.events].reverse().find((e) => e.dir === 'bull' && M - e.i < P.triggerBars && (!zone || e.t >= zone.t));
    const tick = filters && filters.tickSize ? filters.tickSize : null;
    let entry = price;
    if (!trig && zone && price > zone.high) entry = zone.high; // limit plan at zone top when not triggered
    if (tick) entry = roundStep(entry, tick, 'floor');
    // 5 – discount
    const dr = h4.dr;
    const pos = dr && dr.high > dr.low ? (entry - dr.low) / (dr.high - dr.low) : null;
    add(5, 'Entry in discount (4H dealing range)', pos != null && pos >= 0 && pos <= P.discountMax, pos != null ? `Entry ${fmtP(entry)} at ${(pos * 100).toFixed(1)}% of 4H range ${fmtP(dr.low)} – ${fmtP(dr.high)} (max ${(P.discountMax * 100).toFixed(0)}%)${pos < 0 ? ' — below the range low, structure broken' : ''}` : 'Dealing range unavailable');
    // 6 – 15m trigger
    add(6, '15M bullish CHoCH/BOS confirmation (closed candle)', !!trig, trig ? `15M ${trig.type}${trig.mss ? ' (MSS)' : ''} above ${fmtP(trig.level)} at ${new Date(m15.candles[trig.i].ct + 1 + 7 * 36e5).toISOString().slice(0, 16).replace('T', ' ')} WIB` : `No bullish 15M break in the last ${P.triggerBars} closed candles${zone ? ' after the zone reaction' : ''}`);
    // 7 – volume
    let volOk = false, volTxt = 'No trigger candle';
    if (trig) { const v = m15.candles[trig.i].v, s = m15.volSma[trig.i]; volOk = s != null && v > s; volTxt = `Trigger volume ${fmtN(v)} vs SMA20 ${s != null ? fmtN(s) : 'n/a'} (${s ? (v / s).toFixed(2) + '×' : ''})`; }
    add(7, 'Entry volume > SMA20 volume', volOk, volTxt);
    // 8 – stop loss (SMC: below the level that invalidates the idea, beyond nearby resting sell-side liquidity)
    let protectedLow = null;
    if (trig) { protectedLow = Infinity; for (let j = trig.swing.i; j <= trig.i; j++) protectedLow = Math.min(protectedLow, m15.candles[j].l); }
    const pools = [];
    if (P.liqAware === 'on') {
      for (const tfA of [m15, h1, h4]) {
        for (const l of tfA.liq.levels) if (l.type === 'SSL' && !l.swept) pools.push({ price: l.price, src: tfA.tf.toUpperCase() + ' SSL' });
        for (const e of tfA.liq.equals) if (e.type === 'EQL') pools.push({ price: e.price, src: tfA.tf.toUpperCase() + ' EQL' });
      }
    }
    const stop = zone ? computeStop({ zoneLow: zone.low, protectedLow, entry, atr1h: h1.atrLast, atr15: m15.atrLast, pools, P }) : null;
    let sl = stop && stop.sl != null ? stop.sl : null;
    if (sl != null && tick) sl = roundStep(sl, tick, 'floor');
    const slPct = sl != null ? (entry - sl) / entry * 100 : null;
    const c8 = sl != null && sl < entry && sl > 0 && slPct <= P.maxSlPct;
    add(8, 'Clear invalidation for stop loss', c8, sl != null ? `SL ${fmtP(sl)} · ${stop.basis}; risk ${slPct.toFixed(2)}% (max ${P.maxSlPct}%)` : (stop && stop.reason) || 'No invalidation level available');
    // targets from unswept buy-side liquidity
    const lv = [];
    for (const tfA of [h1, h4, d]) {
      for (const l of tfA.liq.levels) if (l.type === 'BSL' && !l.swept && l.price > entry) lv.push({ price: l.price, src: tfA.tf.toUpperCase() + ' BSL' });
      for (const e of tfA.liq.equals) if (e.type === 'EQH' && e.price > entry) lv.push({ price: e.price, src: tfA.tf.toUpperCase() + ' EQH' });
    }
    if (h4.dr && h4.dr.high > entry) lv.push({ price: h4.dr.high, src: '4H range high' });
    const targets = mergeLevels(lv).slice(0, 3);
    const tps = targets.map((t) => ({ ...t, price: tick ? roundStep(t.price, tick, 'floor') : t.price }));
    let rrs = tps.map((t) => (sl != null ? rr(entry, sl, t.price, P.feePct, P.slipPct) : null));
    const refIdx = { TP1: 0, TP2: 1, TP3: 2 }[P.rrTarget] ?? 1;
    const ref = rrs[Math.min(refIdx, rrs.length - 1)];
    const refOk = !!(ref && isNum(ref.net) && isNum(ref.gross));
    const c9 = refOk && ref.net >= P.minRR;
    add(9, `Net R:R ≥ ${P.minRR} (to ${P.rrTarget})`, c9, !tps.length ? 'No buy-side liquidity target above entry' : !refOk ? 'R:R not computable (no valid stop loss below entry)' : `Net R:R ${ref.net.toFixed(2)} (gross ${ref.gross.toFixed(2)}) after ${P.feePct}% fee + ${P.slipPct}% slippage per side`);

    const p = Object.fromEntries(checks.map((c) => [c.id, c.pass]));
    let status = 'NO TRADE';
    if (p[1] && p[2] && (p[3] || p[4])) status = 'SETUP DETECTED';
    if (p[1] && p[2] && p[3] && p[4] && p[5] && p[8] && p[9]) status = 'SETUP VALIDATED';
    if (checks.every((c) => c.pass)) status = 'ENTRY TRIGGERED';
    const plan = {
      entry, entryZone: zone ? [zone.low, zone.high] : null, entryType: trig ? 'Market/limit near current price after 15M confirmation' : 'Limit at zone top, wait for 15M CHoCH/BOS',
      trigger: trig ? `15M ${trig.type} above ${fmtP(trig.level)}` : 'Wait: 15M bullish CHoCH/BOS on a closed candle with volume > SMA20',
      trigT: trig ? trig.t : null, sl, slPct, slBasis: stop && stop.basis, slMode: stop && stop.used, slLiq: stop && stop.liq, protectedLow: stop && stop.used === 'refined' ? stop.structural : null, tps, rrs, invalidation: sl != null ? (stop.used === 'refined' ? `A 15M close below the protected low ${fmtP(stop.structural)} invalidates the entry; a 1H close below ${fmtP(zone.low)} invalidates the zone; hard stop ${fmtP(sl)}` : `A 1H close below ${fmtP(zone.low)} invalidates the zone; hard stop ${fmtP(sl)}`) : null,
      zone, mtf: { d: d.cls, h4: h4.cls, h1: h1.cls, m15: m15.cls },
    };
    return { status, checks, plan, dataOk: true, price };
  }


  /* ---------- entry timing: too early / on time / chasing / late ---------- */
  function entryTiming(mtf, sig, price, P = DEFAULT_PARAMS, filters = null) {
    const out = { label: 'NO DATA', tone: 'neu', reasons: [], limit: null };
    if (!sig || !sig.dataOk || !sig.plan) { out.reasons.push('Data unavailable on at least one timeframe'); return out; }
    const { m15, h4 } = mtf, p = sig.plan, M = m15.candles.length - 1, a15 = m15.atrLast;
    const tick = filters && filters.tickSize;
    const iv = TF_MS['15m'];
    out.nextClose = (m15.forming ? m15.forming.ct : m15.candles[M].ct + iv) + 1;
    const refIdx = { TP1: 0, TP2: 1, TP3: 2 }[P.rrTarget] ?? 1;
    const refTp = p.tps.length ? p.tps[Math.min(refIdx, p.tps.length - 1)] : null;
    const pre = sig.checks.filter((c) => [1, 2, 3, 4, 5].includes(c.id));
    if (!(sig.checks[0].pass && sig.checks[1].pass)) { out.label = 'NO SETUP'; out.tone = 'neu'; out.reasons.push('Higher-timeframe bias (1D/4H) is not bullish'); return out; }
    if (!p.zone) { out.label = 'TOO EARLY'; out.tone = 'warn'; out.reasons.push('1D/4H bullish, but no SSL sweep & reclaim or reaction at a valid demand/OB yet'); return out; }
    // latest bullish 15M break after the zone reaction, regardless of the trigger window
    const lastBull = [...m15.events].reverse().find((e) => e.dir === 'bull' && e.t >= p.zone.t) || null;
    if (lastBull) {
      out.barsSince = M - lastBull.i; out.ageMin = out.barsSince * 15;
      out.breakLevel = lastBull.level; out.distAtr = a15 ? (price - lastBull.level) / a15 : null;
      let maxH = -Infinity; for (let j = lastBull.i + 1; j <= M; j++) maxH = Math.max(maxH, m15.candles[j].h);
      if (m15.forming) maxH = Math.max(maxH, m15.forming.h);
      out.tp1Touched = p.tps[0] ? maxH >= p.tps[0].price : false;
      // retrace limit: 15M FVG in the breakout leg → 15M OB of that break → 50% of the leg
      const legLo = (() => { let lo = Infinity; for (let j = lastBull.swing.i; j <= lastBull.i; j++) lo = Math.min(lo, m15.candles[j].l); return lo; })();
      let legHi = -Infinity; for (let j = lastBull.swing.i; j <= M; j++) legHi = Math.max(legHi, m15.candles[j].h);
      const fvg = m15.fvgs.filter((f) => f.dir === 'bull' && f.i >= lastBull.swing.i && f.i <= lastBull.i + 1 && f.status !== 'Filled').pop();
      const ob = m15.obs.find((z) => z.dir === 'bull' && z.eventIdx === lastBull.i && z.validity === 'Valid');
      let lim = null;
      if (fvg) lim = { price: fvg.top, src: `15M FVG ${fmtP(fvg.bottom)}–${fmtP(fvg.top)} (first touch)` };
      else if (ob) lim = { price: ob.top, src: `15M bullish OB ${fmtP(ob.bottom)}–${fmtP(ob.top)} (top)` };
      else if (legHi > legLo) lim = { price: legLo + (legHi - legLo) / 2, src: `50% of the 15M breakout leg ${fmtP(legLo)}–${fmtP(legHi)}` };
      if (lim) {
        if (tick) lim.price = roundStep(lim.price, tick, 'floor');
        if (p.sl != null && lim.price > p.sl && lim.price < price && refTp) { lim.rr = rr(lim.price, p.sl, refTp.price, P.feePct, P.slipPct).net; out.limit = lim; }
      }
    }
    const rrNow = refTp && p.sl != null && price > p.sl ? rr(price, p.sl, refTp.price, P.feePct, P.slipPct).net : null;
    out.rrNow = rrNow;
    const pos = h4.dr && h4.dr.high > h4.dr.low ? (price - h4.dr.low) / (h4.dr.high - h4.dr.low) : null;
    out.rangePos = pos;
    // pending break on the forming candle (not yet confirmation)
    const lastH = [...m15.swings].reverse().find((sw) => sw.type === 'H' && sw.confirmedAt <= M && !m15.events.some((e) => e.swing === sw));
    out.pendingBreak = !!(m15.forming && lastH && m15.forming.c > lastH.price);
    const triggered = sig.status === 'ENTRY TRIGGERED';
    if (triggered) {
      if (out.tp1Touched) { out.label = 'LATE'; out.tone = 'bear'; out.reasons.push('TP1 already touched after the break'); }
      else if (out.distAtr != null && out.distAtr > P.chaseAtr) { out.label = 'CHASING'; out.tone = 'warn'; out.reasons.push(`Price is ${out.distAtr.toFixed(2)}× ATR(15M) above the break level (max ${P.chaseAtr})`); }
      else { out.label = 'ON TIME'; out.tone = 'bull'; out.reasons.push(`Break confirmed ${out.ageMin} min ago, price ${out.distAtr != null ? out.distAtr.toFixed(2) + '× ATR' : ''} from the break level, net R:R now ${rrNow != null ? rrNow.toFixed(2) : '—'}`); }
      return out;
    }
    // not triggered: decide early vs late
    const moved = out.tp1Touched || (out.distAtr != null && out.distAtr > P.chaseAtr) || (rrNow != null && rrNow < P.minRR);
    if (lastBull && out.barsSince >= P.triggerBars && !moved) {
      out.label = 'TOO EARLY'; out.tone = 'warn';
      out.reasons.push(`Previous 15M break (${out.ageMin} min ago) has expired without the move leaving; wait for a fresh bullish 15M break on a closed candle`);
      return out;
    }
    if (lastBull && out.barsSince >= P.triggerBars) {
      out.label = 'LATE'; out.tone = 'bear';
      if (out.distAtr != null && out.distAtr > P.chaseAtr) out.reasons.push(`Price already ${out.distAtr.toFixed(2)}× ATR(15M) above the break level`);
      out.reasons.push(`Last 15M break was ${out.ageMin} min ago (window ${P.triggerBars * 15} min)`);
      if (out.tp1Touched) out.reasons.push('TP1 already touched');
      if (rrNow != null && rrNow < P.minRR) out.reasons.push(`Net R:R at current price ${rrNow.toFixed(2)} < ${P.minRR}`);
      if (out.limit) out.reasons.push('Only a retrace to the limit below would restore the setup');
      return out;
    }
    if (lastBull && !triggered) {
      const fails = sig.checks.filter((c) => !c.pass && c.id !== 6).map((c) => c.id);
      if (rrNow != null && rrNow < P.minRR) { out.label = 'CHASING'; out.tone = 'warn'; out.reasons.push(`Break exists but net R:R at current price is ${rrNow.toFixed(2)} < ${P.minRR}; wait for a retrace`); }
      else { out.label = 'TOO EARLY'; out.tone = 'warn'; out.reasons.push(`15M break found but condition(s) ${fails.join(', ')} still fail`); }
      return out;
    }
    out.label = 'TOO EARLY'; out.tone = 'warn';
    out.reasons.push(out.pendingBreak ? `Forming 15M candle is above swing high ${fmtP(lastH.price)} — wait for the close at the next 15M boundary` : 'Waiting for a bullish 15M CHoCH/BOS on a closed candle');
    if (pre.some((c) => !c.pass)) out.reasons.push('Also failing: ' + pre.filter((c) => !c.pass).map((c) => c.id).join(', '));
    return out;
  }
  /* ---------- position sizing with Binance filters ---------- */
  function positionSize({ equity, riskPct, entry, sl, feePct, slipPct, tps = [] }, f) {
    const out = { errors: [], warnings: [] };
    if (!(equity > 0)) out.errors.push('Enter account equity');
    if (!(entry > 0)) out.errors.push('Entry price missing');
    if (!(sl > 0) || !(sl < entry)) out.errors.push('Stop loss must be below entry for a long');
    if (out.errors.length) return out;
    const tick = f && f.tickSize;
    const e = tick ? roundStep(entry, tick, 'floor') : entry;
    const s = tick ? roundStep(sl, tick, 'floor') : sl;
    const cst = (feePct + slipPct) / 100;
    const riskAmt = equity * riskPct / 100;
    const perUnit = (e - s) + e * cst + s * cst;
    let qtyRaw = riskAmt / perUnit;
    const cap = equity / (e * (1 + cst));
    if (qtyRaw > cap) { out.warnings.push('Quantity capped by equity (spot, no leverage)'); qtyRaw = cap; }
    let qty = f && f.stepSize ? roundStep(qtyRaw, f.stepSize, 'floor') : qtyRaw;
    if (f) {
      if (f.minQty && qty < f.minQty) out.errors.push(`Quantity ${qty} below LOT_SIZE minQty ${f.minQty}`);
      if (f.maxQty && qty > f.maxQty) out.errors.push(`Quantity above LOT_SIZE maxQty ${f.maxQty}`);
      if (f.minNotional && qty * e < f.minNotional) out.errors.push(`Notional ${(qty * e).toFixed(2)} below ${f.notionalType || 'NOTIONAL'} minimum ${f.minNotional}`);
      if (f.maxNotional && qty * e > f.maxNotional) out.errors.push(`Notional above maximum ${f.maxNotional}`);
    }
    const value = qty * e;
    const feeEntry = value * feePct / 100, slipEntry = value * slipPct / 100;
    const feeExitSL = qty * s * feePct / 100, slipExitSL = qty * s * slipPct / 100;
    const netLoss = qty * (e - s) + feeEntry + slipEntry + feeExitSL + slipExitSL;
    const profits = tps.map((tp) => { const t = tick ? roundStep(tp, tick, 'floor') : tp; return { tp: t, net: qty * (t - e) - feeEntry - slipEntry - qty * t * (feePct + slipPct) / 100 }; });
    Object.assign(out, { entry: e, sl: s, riskAmt, qtyRaw, qty, value, feeEst: feeEntry + feeExitSL, slipEst: slipEntry + slipExitSL, netLoss, profits, riskPctActual: netLoss / equity * 100 });
    return out;
  }
  function parseFilters(sym) {
    const f = {};
    for (const x of sym.filters || []) {
      if (x.filterType === 'PRICE_FILTER') { f.tickSize = x.tickSize; f.minPrice = +x.minPrice; f.maxPrice = +x.maxPrice; }
      if (x.filterType === 'LOT_SIZE') { f.stepSize = x.stepSize; f.minQty = +x.minQty; f.maxQty = +x.maxQty; }
      if (x.filterType === 'NOTIONAL') { f.minNotional = +x.minNotional; f.maxNotional = +x.maxNotional; f.notionalType = 'NOTIONAL'; }
      if (x.filterType === 'MIN_NOTIONAL' && f.minNotional == null) { f.minNotional = +x.minNotional; f.notionalType = 'MIN_NOTIONAL'; }
    }
    f.tickNum = +f.tickSize; f.stepNum = +f.stepSize;
    return f;
  }


  /* ---------- backtest: walk-forward replay, closed candles only ---------- */
  // exit simulation on 15M candles after entry; same-candle SL+TP counts as SL (conservative)
  function simulateExit(c, from, { entry, sl, tp1, tp2, mode = 'single', maxBars = 672, feePct = 0.1, slipPct = 0.05 }) {
    const cst = (feePct + slipPct) / 100, risk = entry - sl;
    let stop = sl, half = false, realized = 0; // realized in price units per 1 unit, weighted
    const target = mode === 'single' ? tp2 : tp2;
    for (let j = from; j < c.length && j < from + maxBars; j++) {
      const k = c[j];
      if (k.l <= stop) {
        const px = Math.min(stop, k.o); // gap through stop fills at open
        const w = half ? 0.5 : 1;
        realized += w * (px - entry - entry * cst - px * cst);
        return { exitIdx: j, exitT: k.ct, exitPx: px, reason: half ? 'BE after TP1' : 'Stop loss', r: realized / risk, partial: half };
      }
      if (mode === 'partial' && !half && k.h >= tp1) {
        realized += 0.5 * (tp1 - entry - entry * cst - tp1 * cst); half = true; stop = entry;
        if (k.h >= target) { realized += 0.5 * (target - entry - entry * cst - target * cst); return { exitIdx: j, exitT: k.ct, exitPx: target, reason: 'TP1 + TP2', r: realized / risk, partial: true }; }
        continue;
      }
      if (k.h >= target) {
        const w = half ? 0.5 : 1;
        realized += w * (target - entry - entry * cst - target * cst);
        return { exitIdx: j, exitT: k.ct, exitPx: target, reason: half ? 'TP1 + TP2' : 'Target', r: realized / risk, partial: half };
      }
    }
    const j = Math.min(c.length, from + maxBars) - 1;
    if (j < from) return null; // no candles after entry yet
    const px = c[j].c, w = half ? 0.5 : 1;
    if (j === c.length - 1 && j < from + maxBars - 1) return { open: true, exitIdx: j, exitT: c[j].ct, exitPx: px, reason: 'Still open at end', r: (realized + w * (px - entry - entry * cst - px * cst)) / risk, partial: half };
    realized += w * (px - entry - entry * cst - px * cst);
    return { exitIdx: j, exitT: c[j].ct, exitPx: px, reason: 'Time exit', r: realized / risk, partial: half };
  }
  function createBacktest(series, { startT, P = DEFAULT_PARAMS, filters = null, window = 300, mode = 'single', maxBars = 672 }) {
    const tfs = ['1d', '4h', '1h', '15m'], key = { '1d': 'd', '4h': 'h4', '1h': 'h1', '15m': 'm15' };
    const m15 = series['15m'];
    let i = m15.findIndex((k) => k.ct >= startT);
    if (i < 0) i = m15.length;
    i = Math.max(i, window);
    const ptr = { '1d': 0, '4h': 0, '1h': 0 }, cacheA = {}, cnt = {};
    const trades = [], funnel = { steps: 0, noTrade: 0, detected: 0, validated: 0, triggered: 0, skippedNoData: 0 };
    let lastTrig = null; const startIdx = i;
    function view(tf, t) {
      const arr = series[tf]; let p = ptr[tf];
      while (p < arr.length && arr[p].ct <= t) p++;
      ptr[tf] = p;
      if (cnt[tf] !== p) { cnt[tf] = p; cacheA[tf] = p >= P.minCandles ? analyzeTF(arr.slice(Math.max(0, p - window), p), tf, P) : { ok: false }; }
      return cacheA[tf];
    }
    return {
      total: m15.length - startIdx,
      get done() { return i >= m15.length; },
      get progress() { return (i - startIdx) / Math.max(1, m15.length - startIdx); },
      step(n) {
        for (let s = 0; s < n && i < m15.length; s++, i++) {
          const t = m15[i].ct; funnel.steps++;
          const mtf = { d: view('1d', t), h4: view('4h', t), h1: view('1h', t), m15: analyzeTF(m15.slice(i + 1 - window, i + 1), '15m', P) };
          const sig = signal(mtf, m15[i].c, P, filters);
          if (!sig.dataOk) { funnel.skippedNoData++; continue; }
          if (sig.status === 'NO TRADE') funnel.noTrade++; else if (sig.status === 'SETUP DETECTED') funnel.detected++; else if (sig.status === 'SETUP VALIDATED') funnel.validated++; else funnel.triggered++;
          if (sig.status !== 'ENTRY TRIGGERED' || i + 1 >= m15.length) continue;
          const p = sig.plan; if (p.trigT === lastTrig) continue;
          const refIdx = { TP1: 0, TP2: 1, TP3: 2 }[P.rrTarget] ?? 1;
          const tp2 = p.tps[Math.min(refIdx, p.tps.length - 1)].price, tp1 = p.tps[0].price;
          const entry = m15[i + 1].o; // fill at next candle open
          if (!(entry > p.sl) || !(tp2 > entry)) continue; // gap invalidated the plan
          lastTrig = p.trigT;
          const ex = simulateExit(m15, i + 1, { entry, sl: p.sl, tp1, tp2, mode, maxBars, feePct: P.feePct, slipPct: P.slipPct });
          if (!ex) continue;
          trades.push({ entryT: m15[i + 1].t, entry, sl: p.sl, tp1, tp2, setup: p.zone ? p.zone.src : '—', planRR: p.rrs[Math.min(refIdx, p.rrs.length - 1)].net, ...ex });
          i = ex.exitIdx; // flat again after exit; one position at a time
        }
      },
      result() {
        const closed = trades.filter((t) => !t.open);
        const rs = closed.map((t) => t.r);
        const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
        let eq = 0, peak = 0, mdd = 0; const curve = [];
        for (const r of rs) { eq += r; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); curve.push(eq); }
        const gp = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
        const bySetup = {};
        for (const t of closed) { const k = t.setup.replace(/:.*/, ''); (bySetup[k] = bySetup[k] || { n: 0, w: 0, r: 0 }); bySetup[k].n++; if (t.r > 0) bySetup[k].w++; bySetup[k].r += t.r; }
        return { trades, closed: closed.length, open: trades.length - closed.length, winRate: closed.length ? wins.length / closed.length : null, avgR: rs.length ? eq / rs.length : null, totalR: eq, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : null, maxDDR: mdd, curve, funnel, bySetup, from: m15[startIdx] && m15[startIdx].t, to: m15[m15.length - 1] && m15[m15.length - 1].ct };
      },
    };
  }
  /* ---------- screener score (heuristic, untested hypothesis) ---------- */
  function longScore(d, h4) {
    let s = 0; const why = [];
    if (!d || !h4 || !d.ok || !h4.ok) return { score: 0, why: ['insufficient data'] };
    if (d.cls === 'Bullish Trend') { s += 20; why.push('1D bullish +20'); } else if (d.cls === 'Potential Reversal' && d.lastEvent.dir === 'bull') { s += 10; why.push('1D bull reversal +10'); } else if (d.cls === 'Ranging') { s += 6; why.push('1D ranging +6'); }
    if (h4.trend === 'bull') { s += 20; why.push('4H structure bull +20'); }
    if (h4.dr) { const add = Math.max(0, Math.min(15, (0.5 - h4.dr.pos) * 30 + 7.5)); s += add; why.push(`4H ${h4.dr.zone} +${add.toFixed(0)}`); }
    const L = h4.candles.length - 1;
    if (h4.liq.levels.some((l) => l.type === 'SSL' && l.sweepType === 'Sweep & Reclaim' && L - l.reclaimAt <= 12)) { s += 15; why.push('4H SSL sweep & reclaim +15'); }
    if ([...h4.obs, ...h4.est].some((z) => z.dir === 'bull' && z.validity === 'Valid' && h4.last.c >= z.bottom && h4.last.c <= z.top * 1.01)) { s += 10; why.push('At valid 4H demand +10'); }
    if (h4.relVol != null) { const v = Math.max(0, Math.min(10, (h4.relVol - 0.8) * 12.5)); s += v; why.push(`RelVol +${v.toFixed(0)}`); }
    if (h4.atrPct > 8) { s -= 10; why.push('Extreme volatility −10'); }
    const D = d.candles.length - 1;
    if (d.ema200[D] != null && d.last.c < d.ema200[D]) { s -= 10; why.push('Below 1D EMA200 −10'); }
    return { score: Math.max(0, Math.min(100, Math.round(s))), why };
  }
  function liquidityLabel(a) {
    if (!a || !a.ok) return '—';
    const L = a.candles.length - 1;
    const sw = a.liq.levels.filter((l) => l.sweepType === 'Sweep & Reclaim' && L - l.reclaimAt <= 12);
    if (sw.length) return 'SSL swept & reclaimed';
    const sb = a.liq.levels.filter((l) => l.sweepType === 'Sweep & Reject' && L - l.reclaimAt <= 12);
    if (sb.length) return 'BSL swept & rejected';
    if (a.liq.equals.some((e) => e.type === 'EQL' && e.price < a.last.c)) return 'Resting EQL below';
    if (a.liq.equals.some((e) => e.type === 'EQH' && e.price > a.last.c)) return 'Resting EQH above';
    return 'No nearby pool';
  }

  /* ---------- journal analytics ---------- */
  function tradeCalc(t) {
    const e = +t.entry, x = +t.exit, s = +t.sl, q = +t.qty, fee = +(t.fees || 0);
    const r = {};
    if (t.status === 'Closed' && e > 0 && x > 0 && q > 0) { r.pnl = (x - e) * q - fee; }
    if (t.status === 'Closed' && e > 0 && x > 0 && s > 0 && e > s) { const riskAmt = (e - s) * q; r.r = riskAmt > 0 && q > 0 ? r.pnl / riskAmt : (x - e) / (e - s); }
    return r;
  }
  function journalStats(trades, minTrades = 20) {
    const closed = trades.filter((t) => t.status === 'Closed').map((t) => ({ ...t, ...tradeCalc(t) })).filter((t) => isNum(t.pnl));
    const res = { n: closed.length, enough: closed.length >= minTrades, minTrades };
    if (!closed.length) return res;
    closed.sort((a, b) => String(a.exitDate || a.date).localeCompare(String(b.exitDate || b.date)));
    const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl <= 0);
    const gp = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
    const rs = closed.filter((t) => isNum(t.r)).map((t) => t.r);
    let eq = 0, peak = 0, mdd = 0;
    for (const t of closed) { eq += t.pnl; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); }
    const bySetup = {};
    for (const t of closed) { const k = t.setup || 'Unspecified'; (bySetup[k] = bySetup[k] || { n: 0, w: 0, pnl: 0, r: [] }); bySetup[k].n++; if (t.pnl > 0) bySetup[k].w++; bySetup[k].pnl += t.pnl; if (isNum(t.r)) bySetup[k].r.push(t.r); }
    Object.assign(res, {
      winRate: wins.length / closed.length, avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      profitFactor: gl > 0 ? gp / gl : (gp > 0 ? Infinity : null), netPnl: gp - gl, maxDD: mdd,
      expectancy: (gp - gl) / closed.length, expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      bySetup, equity: closed.reduce((arr, t) => { arr.push((arr[arr.length - 1] || 0) + t.pnl); return arr; }, []),
    });
    return res;
  }

  /* ---------- CSV ---------- */
  const JCOLS = ['id', 'symbol', 'status', 'setup', 'date', 'entry', 'sl', 'tp', 'qty', 'exitDate', 'exit', 'fees', 'note', 'reference', 'review'];
  function toCSV(rows, cols = JCOLS) {
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  }
  function parseCSV(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    const nonEmpty = rows.filter((r) => r.some((x) => x !== ''));
    if (!nonEmpty.length) return { header: [], rows: [] };
    const header = nonEmpty[0].map((h) => h.trim());
    return { header, rows: nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) };
  }
  function validateTrade(t) {
    const errs = [];
    if (!t.symbol || !/^[A-Z0-9]{2,20}USDT$/.test(String(t.symbol).toUpperCase())) errs.push('symbol must be a USDT pair');
    if (!['Planned', 'Open', 'Closed', 'Cancelled'].includes(t.status)) errs.push('status must be Planned/Open/Closed/Cancelled');
    for (const k of ['entry', 'sl', 'tp', 'qty', 'exit', 'fees']) if (t[k] !== '' && t[k] != null && !(Number(t[k]) >= 0)) errs.push(k + ' must be a number ≥ 0');
    if (t.status === 'Closed' && !(Number(t.exit) > 0)) errs.push('closed trades need an exit price');
    return errs;
  }

  /* ---------- formatting ---------- */
  function fmtP(x) { if (!isNum(x)) return '—'; const a = Math.abs(x); const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8; return x.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d }); }
  function fmtN(x, d = 2) { if (!isNum(x)) return '—'; const a = Math.abs(x); if (a >= 1e9) return (x / 1e9).toFixed(d) + 'B'; if (a >= 1e6) return (x / 1e6).toFixed(d) + 'M'; if (a >= 1e3) return (x / 1e3).toFixed(d) + 'K'; return x.toFixed(d); }

  return { entryTiming, computeStop, simulateExit, createBacktest, TF_MS, roundStep, stepDecimals, extractJSON, normalizeKlines, sma, ema, atr, rsi, findSwings, structureEvents, findFVGs, findOrderBlocks, estimatedDemand, liquidity, dealingRange, analyzeTF, rr, signal, positionSize, parseFilters, longScore, liquidityLabel, tradeCalc, journalStats, toCSV, parseCSV, validateTrade, JCOLS, DEFAULT_PARAMS, fmtP, fmtN };
})();

/* ==== DATA LAYER (Phase 1) — pure functions, no DOM, no network ====
   Builds the Binance Spot USDT universe, validates symbols and trading filters,
   scores ticker freshness and liquidity, checks candle quality, tracks source
   health, and gives retry/backoff and de-duplication helpers.
   Reuses CORE.parseFilters, CORE.normalizeKlines, CORE.roundStep from the legacy engine. */
const DATA = (() => {
  const isNum = (x) => typeof x === 'number' && isFinite(x);

  const STABLES = new Set(['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USD1', 'RLUSD', 'U', 'EUR', 'EURI', 'AEUR', 'XUSD', 'PYUSD', 'USDE', 'BFUSD', 'GBP', 'TRY', 'BRL', 'USDS']);
  const GOLD = new Set(['PAXG', 'XAUT']);
  // Crypto assets whose ticker ends in "B"; any other USDT base ending in "B" is a tokenized stock (bStock). From Tradesys Edge.
  const CRYPTO_B = new Set(['ARB', 'BB', 'BNB', 'CKB', 'DGB', 'SHIB', 'TRB', 'WENB']);
  const isStockToken = (base) => base.length >= 3 && base.endsWith('B') && !CRYPTO_B.has(base);
  const LEVERAGED = /(UP|DOWN|BULL|BEAR)$/;

  const DEFAULTS = {
    quote: 'USDT',
    excludeStables: true, excludeGold: false, excludeLeveraged: true, excludeStockTokens: true,
    tickerStaleMs: 5 * 60e3,          // a 24h ticker whose closeTime is older than this is stale
    minQuoteVolUsd: 0,                // liquidity floor used by the universe view (0 = none)
    liqTiers: [[50e6, 'A'], [10e6, 'B'], [2e6, 'C'], [5e5, 'D']], // 24h quote volume (USDT) → tier, else 'E'
  };

  /* ---------- symbol validation ---------- */
  function filterSummary(sym, parseFilters) {
    const f = parseFilters(sym);
    return {
      tickSize: f.tickSize != null ? String(f.tickSize) : null, stepSize: f.stepSize != null ? String(f.stepSize) : null,
      minQty: isNum(f.minQty) ? f.minQty : null, maxQty: isNum(f.maxQty) ? f.maxQty : null,
      minNotional: isNum(f.minNotional) ? f.minNotional : null, notionalType: f.notionalType || null,
      minPrice: isNum(f.minPrice) ? f.minPrice : null, maxPrice: isNum(f.maxPrice) ? f.maxPrice : null,
    };
  }

  function hasSpotPermission(sym, queriedWithSpot) {
    if (Array.isArray(sym.permissions) && sym.permissions.includes('SPOT')) return { ok: true, via: 'permissions' };
    if (Array.isArray(sym.permissionSets) && sym.permissionSets.some((set) => Array.isArray(set) && set.includes('SPOT'))) return { ok: true, via: 'permissionSets' };
    if (queriedWithSpot) return { ok: true, via: 'query permissions=SPOT' };
    return { ok: false, via: 'none' };
  }

  // Returns every check with pass/fail and detail, so the result is auditable.
  function validateSymbol(sym, opts, parseFilters) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const checks = [];
    const add = (k, pass, detail) => checks.push({ k, pass: !!pass, detail });
    // Binance lists a few pairs whose base asset is written in non-Latin letters (e.g. Chinese); they are real, tradable pairs.
    const okChars = typeof sym.symbol === 'string' && /^[\p{L}\p{N}]{2,30}$/u.test(sym.symbol);
    const okName = okChars && sym.symbol === String(sym.baseAsset) + String(sym.quoteAsset);
    add('symbol', okName, okName ? sym.symbol : !okChars ? `invalid characters in ${sym.symbol}` : `name mismatch: ${sym.symbol} ≠ ${sym.baseAsset}+${sym.quoteAsset}`);
    add('quote', sym.quoteAsset === o.quote, `quote ${sym.quoteAsset}`);
    add('status', sym.status === 'TRADING', `status ${sym.status}`);
    add('spotAllowed', sym.isSpotTradingAllowed === true, `isSpotTradingAllowed ${sym.isSpotTradingAllowed}`);
    const perm = hasSpotPermission(sym, o.queriedWithSpot);
    add('spotPermission', perm.ok, `SPOT via ${perm.via}`);
    const f = filterSummary(sym, parseFilters);
    const tick = Number(f.tickSize), step = Number(f.stepSize);
    add('tickSize', tick > 0, `tickSize ${f.tickSize}`);
    add('stepSize', step > 0, `stepSize ${f.stepSize}`);
    add('minQty', f.minQty != null && f.minQty >= 0, `minQty ${f.minQty}`);
    add('minNotional', f.minNotional != null && f.minNotional > 0, `minNotional ${f.minNotional} (${f.notionalType || 'missing'})`);
    const flags = [];
    const base = String(sym.baseAsset || '');
    if (STABLES.has(base)) flags.push('STABLECOIN');
    if (GOLD.has(base)) flags.push('GOLD_TOKEN');
    if (LEVERAGED.test(base)) flags.push('LEVERAGED_TOKEN');
    if (isStockToken(base)) flags.push('STOCK_TOKEN');
    if (!/^[A-Z0-9]+$/.test(base)) flags.push('NON_LATIN_NAME');
    const failed = checks.filter((c) => !c.pass).map((c) => c.k);
    const policy = [];
    if (o.excludeStables && flags.includes('STABLECOIN')) policy.push('stablecoin');
    if (o.excludeGold && flags.includes('GOLD_TOKEN')) policy.push('gold token');
    if (o.excludeLeveraged && flags.includes('LEVERAGED_TOKEN')) policy.push('leveraged token');
    if (o.excludeStockTokens && flags.includes('STOCK_TOKEN')) policy.push('tokenized stock');
    return {
      symbol: sym.symbol, base, quote: sym.quoteAsset, status: sym.status,
      valid: failed.length === 0, eligible: failed.length === 0 && policy.length === 0,
      failed, policy, flags, filters: f, checks,
    };
  }

  /* ---------- universe ---------- */
  function buildUniverse(exchangeInfo, opts, parseFilters, nowMs) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const syms = (exchangeInfo && Array.isArray(exchangeInfo.symbols)) ? exchangeInfo.symbols : null;
    if (!syms) return { ok: false, error: 'exchangeInfo has no symbols array', eligible: [], excluded: [], rows: [] };
    const rows = [];
    for (const s of syms) {
      if (s.quoteAsset !== o.quote) continue;
      rows.push(validateSymbol(s, o, parseFilters));
    }
    rows.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
    const eligible = rows.filter((r) => r.eligible);
    const excluded = rows.filter((r) => !r.eligible).map((r) => ({ symbol: r.symbol, status: r.status, reasons: r.failed.concat(r.policy) }));
    const byStatus = {}; for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    return {
      ok: true, at: nowMs, serverTime: exchangeInfo.serverTime || null,
      clockOffsetMs: exchangeInfo.serverTime ? exchangeInfo.serverTime - nowMs : null,
      totalSymbols: syms.length, quoteTotal: rows.length, byStatus,
      eligibleCount: eligible.length, invalidCount: rows.filter((r) => !r.valid).length,
      policyExcludedCount: rows.filter((r) => r.valid && !r.eligible).length,
      eligible: eligible.map((r) => r.symbol), excluded, rows,
    };
  }

  // Universe change log: compares two {symbol: status} maps.
  function diffUniverse(prev, next) {
    const added = [], removed = [], changed = [];
    for (const k of Object.keys(next)) { if (!(k in prev)) added.push(k); else if (prev[k] !== next[k]) changed.push({ symbol: k, from: prev[k], to: next[k] }); }
    for (const k of Object.keys(prev)) if (!(k in next)) removed.push(k);
    return { added: added.sort(), removed: removed.sort(), changed, changedAny: added.length + removed.length + changed.length > 0 };
  }
  const statusMap = (u) => Object.fromEntries(u.rows.map((r) => [r.symbol, r.eligible ? 'ELIGIBLE' : r.status]));

  /* ---------- tickers ---------- */
  function liqTier(qv, tiers) { for (const [min, t] of tiers) if (qv >= min) return t; return 'E'; }

  function tickerRows(tickers, universe, opts, nowMs) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const set = new Set(universe.eligible), out = [], issues = [];
    if (!Array.isArray(tickers)) return { rows: [], issues: ['ticker payload is not an array'], missing: universe.eligible.slice() };
    const seen = new Set();
    for (const t of tickers) {
      if (!t || !set.has(t.symbol)) continue;
      if (seen.has(t.symbol)) { issues.push('duplicate ticker ' + t.symbol); continue; }
      seen.add(t.symbol);
      const last = +t.lastPrice, open = +t.openPrice, qv = +t.quoteVolume, ct = +t.closeTime;
      const bad = ![last, qv, ct].every(isNum) || last <= 0;
      const chg = t.priceChangePercent != null ? +t.priceChangePercent : (open > 0 ? (last / open - 1) * 100 : null);
      const ageMs = isNum(ct) ? nowMs - ct : null;
      const stale = ageMs == null || ageMs > o.tickerStaleMs;
      const hi = +t.highPrice, lo = +t.lowPrice;
      out.push({
        symbol: t.symbol, last: bad ? null : last, chgPct: isNum(chg) ? chg : null, quoteVol: isNum(qv) ? qv : null,
        trades: isNum(+t.count) ? +t.count : null, high: isNum(hi) ? hi : null, low: isNum(lo) ? lo : null,
        rangePct: lo > 0 && isNum(hi) ? (hi / lo - 1) * 100 : null,
        spreadPct: (+t.askPrice > 0 && +t.bidPrice > 0) ? ((+t.askPrice - +t.bidPrice) / ((+t.askPrice + +t.bidPrice) / 2)) * 100 : null,
        closeTime: isNum(ct) ? ct : null, ageMs, quality: bad ? 'INVALID' : stale ? 'STALE' : 'FRESH',
        tier: isNum(qv) ? liqTier(qv, o.liqTiers) : null,
      });
    }
    const missing = universe.eligible.filter((s) => !seen.has(s));
    return { rows: out, issues, missing };
  }

  function marketBreadth(rows) {
    const v = rows.filter((r) => r.quality === 'FRESH' && r.chgPct != null);
    const chg = v.map((r) => r.chgPct).sort((a, b) => a - b);
    const med = chg.length ? (chg.length % 2 ? chg[(chg.length - 1) / 2] : (chg[chg.length / 2 - 1] + chg[chg.length / 2]) / 2) : null;
    const up = v.filter((r) => r.chgPct > 0).length, down = v.filter((r) => r.chgPct < 0).length;
    const qv = v.reduce((s, r) => s + (r.quoteVol || 0), 0);
    const tiers = {}; for (const r of v) tiers[r.tier] = (tiers[r.tier] || 0) + 1;
    return { n: v.length, up, down, flat: v.length - up - down, advDecl: down ? up / down : null, medianChgPct: med, totalQuoteVol: qv, tiers };
  }

  /* ---------- candles ---------- */
  // Removes duplicate open times (keeps the later copy, which is the most recent update) and sorts ascending.
  function dedupeCandles(candles) {
    const m = new Map(); let dups = 0;
    for (const c of candles) { if (m.has(c.t)) dups++; m.set(c.t, c); }
    return { candles: [...m.values()].sort((a, b) => a.t - b.t), duplicates: dups };
  }

  // Lists every missing candle open time between consecutive candles.
  function missingCandles(candles, ivMs, limit = 50) {
    const gaps = []; let count = 0;
    for (let i = 1; i < candles.length; i++) {
      const d = candles[i].t - candles[i - 1].t;
      if (d > ivMs) { const n = Math.round(d / ivMs) - 1; count += n; if (gaps.length < limit) gaps.push({ after: candles[i - 1].t, missing: n }); }
    }
    return { count, gaps };
  }

  // Wraps CORE.normalizeKlines with de-duplication, missing-candle listing and a single quality verdict.
  function candleQuality(raw, ctx, normalizeKlines, TF_MS) {
    const norm = normalizeKlines(raw, ctx);
    const dd = dedupeCandles(norm.candles);
    const iv = TF_MS[ctx.tf];
    const miss = iv ? missingCandles(dd.candles, iv) : { count: null, gaps: [] };
    const last = dd.candles[dd.candles.length - 1];
    const lastClosed = [...dd.candles].reverse().find((c) => c.closed) || null;
    let verdict = norm.meta.status; // VALID | DATA STALE | INVALID | DATA UNAVAILABLE
    if (verdict === 'VALID' && miss.count > 0) verdict = 'VALID WITH GAPS';
    return {
      candles: dd.candles,
      meta: Object.assign({}, norm.meta, {
        duplicates: dd.duplicates, missingCount: miss.count, gaps: miss.gaps, verdict,
        lastClosedOpen: lastClosed ? lastClosed.t : null, lastClosedClose: lastClosed ? lastClosed.c : null,
        lastPrice: last ? last.c : null, usableForSignals: norm.meta.valid && norm.meta.freshness === 'FRESH',
      }),
    };
  }

  // Compares two sources for the same last closed candle (e.g. connector vs public REST, or REST vs stream).
  function reconcile(a, b, tolPct = 0.05) {
    if (!a || !b) return { ok: false, reason: 'one side missing' };
    if (a.t !== b.t) return { ok: false, reason: 'different candle open times', driftMs: b.t - a.t };
    const diff = a.c > 0 ? Math.abs(a.c - b.c) / a.c * 100 : null;
    return { ok: diff != null && diff <= tolPct, diffPct: diff, reason: diff != null && diff <= tolPct ? 'match' : 'close prices differ' };
  }

  /* ---------- source health ---------- */
  function createSourceMonitor(nowFn = Date.now) {
    const S = {};
    const get = (k) => S[k] || (S[k] = { source: k, ok: 0, fail: 0, consecutiveFails: 0, lastOkAt: null, lastFailAt: null, lastError: null, latencies: [], state: 'UNKNOWN', note: null });
    function record(k, ok, latencyMs, err) {
      const s = get(k), t = nowFn();
      if (ok) { s.ok++; s.consecutiveFails = 0; s.lastOkAt = t; if (isNum(latencyMs)) { s.latencies.push(latencyMs); if (s.latencies.length > 50) s.latencies.shift(); } }
      else { s.fail++; s.consecutiveFails++; s.lastFailAt = t; s.lastError = err ? String(err.code || err.message || err) : 'error'; }
      s.state = s.consecutiveFails >= 3 ? 'DOWN' : s.consecutiveFails > 0 ? 'DEGRADED' : 'OK';
      return s;
    }
    function mark(k, state, note) { const s = get(k); s.state = state; s.note = note || null; return s; }
    function snapshot() {
      return Object.values(S).map((s) => {
        const l = s.latencies.slice().sort((a, b) => a - b);
        return Object.assign({}, s, { latencies: undefined, p50: l.length ? l[Math.floor(l.length / 2)] : null, p95: l.length ? l[Math.min(l.length - 1, Math.floor(l.length * 0.95))] : null });
      });
    }
    return { record, mark, snapshot, get };
  }

  /* ---------- retry / backoff ---------- */
  // Exponential backoff with full jitter: random in [0, min(max, base·2^attempt)].
  function backoffMs(attempt, base = 500, max = 8000, rand = Math.random) { return Math.floor(rand() * Math.min(max, base * Math.pow(2, attempt))); }

  // Retries only when isRetryable(err) says so; honours err.retryAfterMs.
  async function withRetry(fn, { tries = 3, isRetryable = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), base = 500, max = 8000, rand = Math.random, onAttempt } = {}) {
    let lastErr;
    for (let k = 0; k < tries; k++) {
      try { const v = await fn(k); if (onAttempt) onAttempt({ attempt: k, ok: true }); return v; }
      catch (e) {
        lastErr = e; if (onAttempt) onAttempt({ attempt: k, ok: false, err: e });
        if (k === tries - 1 || !isRetryable(e)) break;
        const wait = Math.max(backoffMs(k, base, max, rand), (e && e.retryAfterMs) || 0);
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  // Event de-duplication: remembers keys for ttlMs.
  function createDedupe(ttlMs = 10 * 60e3, nowFn = Date.now) {
    const m = new Map();
    return {
      seen(key) {
        const t = nowFn();
        for (const [k, at] of m) if (t - at > ttlMs) m.delete(k);
        if (m.has(key)) return true; m.set(key, t); return false;
      },
      size: () => m.size,
    };
  }

  return { STABLES, GOLD, LEVERAGED, isStockToken, DEFAULTS, validateSymbol, buildUniverse, diffUniverse, statusMap, liqTier, tickerRows, marketBreadth, dedupeCandles, missingCandles, candleQuality, reconcile, createSourceMonitor, backoffMs, withRetry, createDedupe, hasSpotPermission };
})();

/* ==== ATTENTION ENGINE (Phase 2) — pure functions ====
   Per-asset daily features from closed D1 candles, order book imbalance, and the Attention score.
   Components are scored 0–100. A component without data is UNAVAILABLE (null), never 0;
   the Attention score re-weights over the components that exist and reports its coverage. */
const ATTN = (() => {
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
  const DAY = 864e5;

  const WEIGHTS = { relVolume: 0.25, volGrowth: 0.20, momentum: 0.20, relStrength: 0.15, tradeActivity: 0.10, obImbalance: 0.10, social: 0 };
  const COMPONENTS = [
    ['relVolume', 'Relative volume', '24h quote volume ÷ average of the previous 20 closed days'],
    ['volGrowth', 'Volume growth', 'Quote volume of the last 7 closed days ÷ the 7 days before − 1'],
    ['momentum', 'Price momentum', 'Average of 24h change and 7-day return (closed candles)'],
    ['relStrength', 'Relative strength', '7/30/90-day return minus BTC, weighted 0.3/0.5/0.2'],
    ['tradeActivity', 'Trade activity', '24h trade count ÷ average daily trades of the previous 20 closed days'],
    ['obImbalance', 'Order book imbalance', '(bid − ask) ÷ (bid + ask) quantity within ±1% of mid price'],
    ['social', 'Social attention', 'No verified social data source is connected'],
  ];

  // Raw Binance kline rows → closed daily series (open time, close, quote volume, trades, taker buy quote volume).
  function dailySeries(raw, nowMs) {
    if (!Array.isArray(raw)) return null;
    const rows = [];
    const seen = new Set();
    for (const k of raw) {
      if (!Array.isArray(k) || k.length < 11) continue;
      const t = +k[0], ct = +k[6];
      if (!isNum(t) || seen.has(t) || !(ct < nowMs)) continue; // closed candles only, no duplicates
      seen.add(t);
      const c = +k[4], qv = +k[7], n = +k[8], tq = +k[10], h = +k[2], l = +k[3];
      if (![c, qv, n].every(isNum) || c <= 0) continue;
      rows.push({ t, c, h, l, qv, n, tq: isNum(tq) ? tq : null });
    }
    rows.sort((a, b) => a.t - b.t);
    return rows;
  }

  const ret = (s, d) => (s.length > d && s[s.length - 1 - d].c > 0 ? (s[s.length - 1].c / s[s.length - 1 - d].c - 1) * 100 : null);

  // Features from closed daily candles; `tick` is the live 24h ticker row (may be null).
  function assetFeatures(series, tick, emaFn, rsiFn) {
    const s = series || [], n = s.length;
    const closes = s.map((x) => x.c);
    const e50 = n >= 50 ? emaFn(closes, 50) : null, r14 = n >= 15 ? rsiFn(closes, 14) : null;
    const prev20 = s.slice(-20);
    const qvAvg20 = prev20.length >= 10 ? mean(prev20.map((x) => x.qv)) : null;
    const nAvg20 = prev20.length >= 10 ? mean(prev20.map((x) => x.n)) : null;
    const qv7 = n >= 14 ? s.slice(-7).reduce((a, x) => a + x.qv, 0) : null;
    const qvPrev7 = n >= 14 ? s.slice(-14, -7).reduce((a, x) => a + x.qv, 0) : null;
    return {
      days: n, lastClosedOpen: n ? s[n - 1].t : null, close: n ? s[n - 1].c : null,
      ret7: ret(s, 7), ret30: ret(s, 30), ret90: ret(s, 90),
      ema50: e50 ? e50[n - 1] : null, aboveEma50: e50 && e50[n - 1] != null ? s[n - 1].c > e50[n - 1] : null,
      rsi14: r14 ? r14[n - 1] : null,
      qvAvg20, nAvg20, qv7, qvPrev7,
      qv24: tick && isNum(tick.quoteVol) ? tick.quoteVol : null, trades24: tick && isNum(tick.trades) ? tick.trades : null,
      chg24: tick && isNum(tick.chgPct) ? tick.chgPct : null,
    };
  }

  // Order book imbalance within ±bandPct of the mid price. depth = {bids:[[p,q]], asks:[[p,q]]}.
  function obImbalance(depth, bandPct = 1) {
    if (!depth || !Array.isArray(depth.bids) || !Array.isArray(depth.asks) || !depth.bids.length || !depth.asks.length) return null;
    const bb = +depth.bids[0][0], ba = +depth.asks[0][0];
    if (!(bb > 0 && ba > 0 && ba >= bb)) return null;
    const mid = (bb + ba) / 2, lo = mid * (1 - bandPct / 100), hi = mid * (1 + bandPct / 100);
    let b = 0, a = 0;
    for (const [p, q] of depth.bids) if (+p >= lo) b += +p * +q;
    for (const [p, q] of depth.asks) if (+p <= hi) a += +p * +q;
    if (b + a <= 0) return null;
    return { imb: (b - a) / (b + a), bidUsd: b, askUsd: a, mid, spreadPct: (ba - bb) / mid * 100 };
  }

  // Raw component values (ratios / percents) before scoring.
  function rawComponents(f, btc, ob) {
    const ratio = (x, y) => (isNum(x) && isNum(y) && y > 0 ? x / y : null);
    const relV = ratio(f.qv24, f.qvAvg20);
    const vg = isNum(f.qv7) && isNum(f.qvPrev7) && f.qvPrev7 > 0 ? f.qv7 / f.qvPrev7 - 1 : null;
    const mom = isNum(f.chg24) && isNum(f.ret7) ? (f.chg24 + f.ret7) / 2 : isNum(f.ret7) ? f.ret7 : null;
    let rs = null;
    if (btc && isNum(f.ret7) && isNum(f.ret30) && isNum(btc.ret7) && isNum(btc.ret30)) {
      const has90 = isNum(f.ret90) && isNum(btc.ret90);
      rs = has90 ? 0.3 * (f.ret7 - btc.ret7) + 0.5 * (f.ret30 - btc.ret30) + 0.2 * (f.ret90 - btc.ret90) : (0.3 * (f.ret7 - btc.ret7) + 0.5 * (f.ret30 - btc.ret30)) / 0.8;
    }
    const ta = ratio(f.trades24, f.nAvg20);
    return { relVolume: relV, volGrowth: vg, momentum: mom, relStrength: rs, tradeActivity: ta, obImbalance: ob ? ob.imb : null, social: null };
  }

  // Percentile rank (0–100) of v among the values; ties share the mid rank.
  function pctRank(values, v) {
    if (!isNum(v)) return null;
    const a = values.filter(isNum); if (!a.length) return null;
    let below = 0, eq = 0; for (const x of a) { if (x < v) below++; else if (x === v) eq++; }
    return a.length === 1 ? 50 : clamp(((below + (eq - 1) / 2) / (a.length - 1)) * 100);
  }

  // Scores every asset. Cross-sectional components are percentile ranks across the scored universe;
  // order book imbalance is absolute: (imb + 1) / 2 · 100.
  function score(assets, weights) {
    const W = Object.assign({}, WEIGHTS, weights || {});
    const keys = ['relVolume', 'volGrowth', 'momentum', 'relStrength', 'tradeActivity'];
    const cols = Object.fromEntries(keys.map((k) => [k, assets.map((a) => a.raw[k])]));
    return assets.map((a) => {
      const comp = {};
      for (const k of keys) comp[k] = { raw: a.raw[k], score: pctRank(cols[k], a.raw[k]) };
      comp.obImbalance = { raw: a.raw.obImbalance, score: isNum(a.raw.obImbalance) ? clamp((a.raw.obImbalance + 1) / 2 * 100) : null };
      comp.social = { raw: null, score: null };
      let num = 0, den = 0, total = 0;
      for (const [k, w] of Object.entries(W)) { total += w; if (comp[k] && comp[k].score != null && w > 0) { num += w * comp[k].score; den += w; } }
      const coverage = total > 0 ? den / total : 0;
      return { symbol: a.symbol, base: a.base, comp, attention: den > 0 ? num / den : null, coverage, quality: coverage >= 0.7 ? 'OK' : coverage > 0 ? 'PARTIAL' : 'UNAVAILABLE' };
    });
  }

  return { WEIGHTS, COMPONENTS, dailySeries, assetFeatures, obImbalance, rawComponents, pctRank, score, clamp, mean, DAY };
})();

/* ==== NARRATIVE ENGINE (Phase 2) — pure functions ====
   Multi-label taxonomy (16 narratives) built from CoinGecko categories by explicit rules,
   then seven narrative metrics computed from Binance closed daily candles and global headlines.
   Every metric is 0–100 or null (UNAVAILABLE) and carries the inputs that produced it. */
const NARR = (() => {
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
  const median = (a) => { const v = a.filter(isNum).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const DAY = 864e5;

  const LIST = [
    ['AI', 'AI and AI Agents'], ['RWA', 'RWA'], ['DEPIN', 'DePIN'], ['DEFI', 'DeFi'], ['L1', 'Layer 1'], ['L2', 'Layer 2'],
    ['GAMING', 'Gaming'], ['MEME', 'Memecoin'], ['PRIVACY', 'Privacy'], ['PAYMENTS', 'Payments'], ['STABLE', 'Stablecoin'],
    ['RESTAKING', 'Restaking'], ['INTEROP', 'Interoperability'], ['INFRA', 'Infrastructure'], ['SOCIAL', 'Consumer and Social'], ['OTHER', 'Other'],
  ];
  const NAME = Object.fromEntries(LIST);
  // CoinGecko category name (lower-case) → narrative. Order inside a rule does not matter; a coin gets every narrative that matches.
  const RULES = [
    ['AI', /\bai\b|artificial intelligence|ai agent|machine learning/],
    ['RWA', /real world asset|\brwa\b|tokenized (treasur|gold|commodit|real estate|stock)/],
    ['DEPIN', /depin|physical infrastructure/],
    ['DEFI', /\bdefi\b|decentralized finance|decentralized exchange|\bdex\b|lending|borrowing|yield|derivatives|perpetual|liquid staking|automated market maker|\bamm\b/],
    ['L1', /layer 1|\(l1\)|smart contract platform/],
    ['L2', /layer 2|\(l2\)|rollup/],
    ['GAMING', /gaming|gamefi|play to earn|metaverse/],
    ['MEME', /meme/],
    ['PRIVACY', /privacy/],
    ['PAYMENTS', /payment/],
    ['STABLE', /stablecoin/],
    ['RESTAKING', /restaking|eigenlayer/],
    ['INTEROP', /interoperability|cross-chain|bridge/],
    ['INFRA', /infrastructure|oracle|data availability|storage|indexing|developer tool|wallet|account abstraction|modular blockchain/],
    ['SOCIAL', /socialfi|\bsocial\b|\bnft\b|non-fungible|fan token|music|creator|consumer|entertainment|sports/],
  ];
  // Portfolio, index, ecosystem and listing categories describe who holds or lists a coin, not what it does.
  const IGNORE = /ecosystem|portfolio|\bindex\b|made in|launchpad|holdings|hodler|megadrop|launchpool|alpha spotlight|binance |coinbase|top 100|alleged sec|ftx|airdrop/;
  // Most specific first. DeFi outranks Stablecoin (CoinGecko tags issuers such as Aave and Ethena as "Stablecoin Issuer"),
  // and Privacy sits after DeFi/Interop because CoinGecko also tags LINK and NEAR with "Privacy Infrastructure".
  const PRIMARY_ORDER = ['MEME', 'AI', 'RWA', 'DEPIN', 'RESTAKING', 'GAMING', 'PAYMENTS', 'L2', 'INTEROP', 'DEFI', 'STABLE', 'PRIVACY', 'SOCIAL', 'INFRA', 'L1'];
  const KEYWORDS = {
    AI: /\bai\b|artificial intelligence|ai agent/i, RWA: /\brwa\b|real[- ]world asset|tokeni[sz]ed (treasur|fund|stock|gold)/i, DEPIN: /\bdepin\b/i, DEFI: /\bdefi\b|\bdex\b|lending protocol/i,
    L1: /layer[- ]?1\b|\bl1\b/i, L2: /layer[- ]?2\b|\bl2\b|rollup/i, GAMING: /gaming|gamefi|\bgame\b/i, MEME: /meme ?coin|\bmemes?\b/i, PRIVACY: /privacy coin|\bprivacy\b/i,
    PAYMENTS: /payments?\b/i, STABLE: /stablecoin/i, RESTAKING: /restaking/i, INTEROP: /interoperab|cross-chain|bridge/i, INFRA: /oracle|data availability|infrastructure/i, SOCIAL: /socialfi|\bnft\b|fan token/i,
  };
  const CONF = { HIGH: 1, MEDIUM: 0.7, LOW: 0.4 };

  function mapCategories(categories) {
    const labels = new Set(), matched = [], ignored = [];
    for (const raw of categories || []) {
      const c = String(raw).toLowerCase();
      if (IGNORE.test(c)) { ignored.push(raw); continue; }
      for (const [k, re] of RULES) if (re.test(c)) { labels.add(k); matched.push({ category: raw, narrative: k }); }
    }
    const list = PRIMARY_ORDER.filter((k) => labels.has(k));
    return { labels: list.length ? list : ['OTHER'], primary: list[0] || 'OTHER', matched, ignored };
  }

  // Binance base asset → the symbol to look up (strips 1000/1M multipliers such as 1000SATS).
  const lookupSymbol = (base) => String(base).replace(/^(1000000|1000|1M)(?=[A-Z])/, '');

  // Picks the CoinGecko id from a search-coingecko result.
  function resolveCgId(res, base) {
    const want = lookupSymbol(base).toUpperCase();
    if (!res) return null;
    const sel = res.selected;
    if (sel && sel.identity && String(sel.symbol || '').toUpperCase() === want) return { id: sel.identity.id, name: sel.name || null, rank: sel.marketCapRank || null, confidence: 'HIGH', via: 'unique match' };
    const c = (res.candidates || []).filter((x) => String(x.symbol || '').toUpperCase() === want && x.identity && x.identity.id)
      .sort((a, b) => (a.marketCapRank || 1e9) - (b.marketCapRank || 1e9));
    if (c.length) return { id: c[0].identity.id, name: c[0].name || null, rank: c[0].marketCapRank || null, confidence: c.length === 1 ? 'HIGH' : 'MEDIUM', via: c.length === 1 ? 'single symbol match' : `best market-cap rank of ${c.length} symbol matches` };
    return null;
  }

  // Taxonomy record for one Binance base asset.
  function classify(base, resolved, info, manual) {
    if (manual && Array.isArray(manual.labels) && manual.labels.length) {
      const labels = PRIMARY_ORDER.concat(['OTHER']).filter((k) => manual.labels.includes(k));
      return { base, labels, primary: labels[0], source: 'Manual', verified: true, confidence: 'HIGH', cgId: resolved ? resolved.id : null, name: manual.name || (resolved && resolved.name) || null, matched: [], note: manual.note || null };
    }
    if (!resolved) return { base, labels: ['OTHER'], primary: 'OTHER', source: 'CoinGecko', verified: false, confidence: 'LOW', cgId: null, name: null, matched: [], note: 'No CoinGecko coin with this ticker' };
    const m = mapCategories(info && info.categories);
    const conf = m.primary === 'OTHER' ? 'LOW' : resolved.confidence;
    return { base, labels: m.labels, primary: m.primary, source: 'CoinGecko categories', verified: false, confidence: conf, cgId: resolved.id, name: (info && info.name) || resolved.name, matched: m.matched, categories: (info && info.categories) || [], note: m.primary === 'OTHER' ? 'No category matched a narrative rule' : null };
  }

  /* ---------- metrics ---------- */
  // 7-day return ending at open time T, from a {t→close} map.
  const r7At = (map, T) => { const a = map.get(T), b = map.get(T - 7 * DAY); return a > 0 && b > 0 ? (a / b - 1) * 100 : null; };

  function headlineMatches(n, headlines, memberNames, nowMs, windowH = 72) {
    const kw = KEYWORDS[n];
    const names = memberNames.filter((x) => x && x.length >= 4).map((x) => new RegExp('\\b' + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'));
    const hits = [], seen = new Set();
    for (const h of headlines || []) {
      const at = Date.parse(h.postedAt); if (!(nowMs - at <= windowH * 3600e3) || seen.has(h.url)) continue;
      const title = String(h.title || '');
      const by = kw && kw.test(title) ? 'narrative keyword' : (names.find((re) => re.test(title)) ? 'member name' : null);
      if (by) { seen.add(h.url); hits.push({ title, url: h.url, source: h.source, postedAt: h.postedAt, by }); }
    }
    return hits;
  }

  // Momentum is relative to the universe. A narrative that is merely falling less than the market
  // is not growing, so every rising stage also requires a positive median 7-day return.
  function lifecycle(m) {
    const ok = (x) => isNum(x);
    if (!ok(m.momentum)) return { stage: null, why: 'Momentum unavailable' };
    if (ok(m.med7) && m.med7 <= 0 && !(ok(m.adoption) && m.adoption >= 60))
      return { stage: 'DECLINING', why: m.momentum >= 50 ? `Falling in absolute terms (median 7-day return ${m.med7.toFixed(1)}%), although stronger than the universe` : `Falling and weaker than the universe (median 7-day return ${m.med7.toFixed(1)}%)` };
    if (m.momentum >= 80 && ok(m.adoption) && m.adoption >= 75 && ((ok(m.medRsi) && m.medRsi >= 70) || (ok(m.med30) && m.med30 >= 40)))
      return { stage: 'OVERHEATED', why: 'Momentum ≥ 80, adoption ≥ 75 and members stretched (median RSI ≥ 70 or 30-day return ≥ 40%)' };
    if (m.momentum >= 55 && ok(m.freshness) && m.freshness >= 60 && (!ok(m.adoption) || m.adoption < 60))
      return { stage: 'EMERGING', why: 'Outperforming for only a few days, with adoption still below 60' };
    if (m.momentum >= 50 && ok(m.adoption) && m.adoption >= 60 && (!ok(m.freshness) || m.freshness < 40))
      return { stage: 'MAINSTREAM', why: 'Broad participation (adoption ≥ 60) and an established run' };
    if (m.momentum >= 50) return { stage: 'GROWING', why: 'Outperforming the universe' };
    return { stage: 'DECLINING', why: 'Underperforming the universe (momentum < 50)' };
  }

  const NW = { momentum: 0.30, growth: 0.20, freshness: 0.15, catalyst: 0.15, adoption: 0.20 };

  /* assets: [{symbol, base, series:[{t,c,qv}], f:{ret7, ret30, aboveEma50, rsi14}}]
     tax: {base → taxonomy record}; headlines: [{title,url,source,postedAt}] */
  function compute(assets, tax, headlines, nowMs, opts = {}) {
    const minMembers = opts.minMembers || 3, histDays = opts.histDays || 30;
    const maps = new Map(assets.map((a) => [a.symbol, new Map(a.series.map((x) => [x.t, x.c]))]));
    const qvMaps = new Map(assets.map((a) => [a.symbol, new Map(a.series.map((x) => [x.t, x.qv]))]));
    const lastT = Math.max(...assets.map((a) => (a.series.length ? a.series[a.series.length - 1].t : 0)));
    const days = []; for (let i = histDays - 1; i >= 0; i--) days.push(lastT - i * DAY);
    const uniMed = (T) => median(assets.map((a) => r7At(maps.get(a.symbol), T)));
    const uniSeries = days.map(uniMed);
    const qvSum = (list, from, to) => { let s = 0; for (const a of list) { const m = qvMaps.get(a.symbol); for (let T = from; T <= to; T += DAY) { const v = m.get(T); if (isNum(v)) s += v; } } return s; };
    const allQv7 = qvSum(assets, lastT - 6 * DAY, lastT), allQvPrev7 = qvSum(assets, lastT - 13 * DAY, lastT - 7 * DAY);
    const uniRet30 = median(assets.map((a) => a.f.ret30));

    const out = [];
    for (const [key, name] of LIST) {
      const members = assets.filter((a) => tax[a.base] && tax[a.base].labels.includes(key));
      const rec = { key, name, members: members.map((a) => a.symbol), n: members.length };
      if (members.length < minMembers) { Object.assign(rec, { status: 'UNAVAILABLE', why: `${members.length} classified member${members.length === 1 ? '' : 's'} in the eligible universe (needs ${minMembers})` }); out.push(rec); continue; }
      const series = days.map((T) => median(members.map((a) => r7At(maps.get(a.symbol), T))));
      const excess = series.map((v, i) => (isNum(v) && isNum(uniSeries[i]) ? v - uniSeries[i] : null));
      const med7 = series[series.length - 1], med30 = median(members.map((a) => a.f.ret30));
      const ex7 = excess[excess.length - 1], ex30 = isNum(med30) && isNum(uniRet30) ? med30 - uniRet30 : null;
      const exBlend = isNum(ex7) && isNum(ex30) ? 0.6 * ex7 + 0.4 * ex30 : ex7;
      const momentum = isNum(exBlend) ? clamp(50 + 2.5 * exBlend) : null;
      const q7 = qvSum(members, lastT - 6 * DAY, lastT), qp = qvSum(members, lastT - 13 * DAY, lastT - 7 * DAY);
      const share7 = allQv7 > 0 ? q7 / allQv7 : null, sharePrev = allQvPrev7 > 0 ? qp / allQvPrev7 : null;
      const g = isNum(share7) && sharePrev > 0 ? share7 / sharePrev - 1 : null;
      const growth = isNum(g) ? clamp(50 + 100 * g) : null;
      let streak = 0; for (let i = excess.length - 1; i >= 0 && isNum(excess[i]) && excess[i] > 0; i--) streak++;
      const freshness = !isNum(ex7) ? null : ex7 <= 0 ? 0 : clamp(100 - (streak - 1) * (100 / 14));
      const names = members.map((a) => tax[a.base].name).filter(Boolean);
      const hits = headlineMatches(key, headlines, names, nowMs);
      const catalyst = Array.isArray(headlines) ? clamp(25 * hits.length) : null;
      const withF = members.filter((a) => a.f.aboveEma50 != null && isNum(a.f.ret7));
      const adoption = withF.length >= minMembers ? (withF.filter((a) => a.f.aboveEma50).length / withF.length * 50 + withF.filter((a) => a.f.ret7 > 0).length / withF.length * 50) : null;
      const medRsi = median(members.map((a) => a.f.rsi14));
      const metrics = { momentum, growth, freshness, catalyst, adoption };
      let num = 0, den = 0; for (const [k, w] of Object.entries(NW)) if (isNum(metrics[k])) { num += w * metrics[k]; den += w; }
      const avgConf = members.reduce((s, a) => s + CONF[tax[a.base].confidence || 'LOW'], 0) / members.length;
      const coverage = Object.values(metrics).filter(isNum).length / 5;
      const confidence = Math.round(100 * Math.min(1, members.length / 8) * avgConf * coverage);
      const lc = lifecycle(Object.assign({ medRsi, med30, med7 }, metrics));
      Object.assign(rec, {
        status: 'OK', score: den ? num / den : null, ...metrics, confidence, lifecycle: lc.stage, lifecycleWhy: lc.why,
        inputs: { med7, med30, ex7, ex30, uniRet30, share7, sharePrev, volShareChange: g, streakDays: streak, medRsi, headlinesChecked: (headlines || []).length, membersWithTrend: withF.length, avgTaxonomyConfidence: avgConf, coverage },
        headlines: hits, history: days.map((T, i) => ({ t: T, med7: series[i], excess: excess[i] })),
      });
      out.push(rec);
    }
    return { at: nowMs, lastClosedDay: lastT, universeMed7: uniSeries[uniSeries.length - 1], universeRet30: uniRet30, narratives: out };
  }

  // Narrative component for one asset: the best-scoring narrative among its labels (OTHER and UNAVAILABLE excluded).
  function assetNarrative(base, tax, result) {
    const t = tax[base]; if (!t) return { score: null, narrative: null, why: 'Not classified yet' };
    let best = null;
    for (const k of t.labels) { const r = result.narratives.find((x) => x.key === k); if (r && r.status === 'OK' && k !== 'OTHER' && isNum(r.score) && (!best || r.score > best.score)) best = r; }
    return best ? { score: best.score, narrative: best.key, lifecycle: best.lifecycle } : { score: null, narrative: t.primary, why: t.primary === 'OTHER' ? 'Narrative is Other' : 'Narrative unavailable' };
  }

  // Re-applies the current precedence to a stored taxonomy record (labels kept, primary recomputed).
  function reprimary(rec) { if (!rec || !Array.isArray(rec.labels)) return rec; const labels = PRIMARY_ORDER.filter((k) => rec.labels.includes(k)); const out = labels.length ? labels : ['OTHER']; return Object.assign({}, rec, { labels: out, primary: out[0] }); }
  // Re-applies lifecycle rules to a stored narrative result.
  function relabel(result) { if (!result || !Array.isArray(result.narratives)) return result; return Object.assign({}, result, { narratives: result.narratives.map((x) => { if (x.status !== 'OK') return x; const lc = lifecycle(Object.assign({ medRsi: x.inputs && x.inputs.medRsi, med30: x.inputs && x.inputs.med30, med7: x.inputs && x.inputs.med7 }, x)); return Object.assign({}, x, { lifecycle: lc.stage, lifecycleWhy: lc.why }); }) }); }
  return { reprimary, relabel, LIST, NAME, RULES, IGNORE, PRIMARY_ORDER, mapCategories, lookupSymbol, resolveCgId, classify, headlineMatches, lifecycle, compute, assetNarrative, NW, median };
})();

/* ==== QUANT, PRICE ACTION & SMC, MULTI-TIMEFRAME (Phase 3) — pure functions ====
   Indicators: EMA 13/21/50/200, RSI 14, ATR 14, ADX 14 (+DI/−DI), relative volume, ROC, relative strength vs BTC.
   Strategies: EMA 13×21 crossover and retest, on closed candles only.
   SMC: BOS, CHoCH/MSS, liquidity sweeps, equal highs/lows, order blocks, FVGs, displacement, premium/discount —
   built on CORE.analyzeTF (swings are used only after they are confirmed, so there is no look-ahead).
   MTF: D1 macro trend → H4 structure → H1 setup → M15 entry → M5 refinement (optional). */
const QUANT = (() => {
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

  const P = {
    rocLen: 10, rsLen: 20, relVolLen: 20, crossLookback: 5, retestWindow: 20, retestTolAtr: 0.25, retestFreshBars: 3,
    dispAtr: 1.5, dispBodyRatio: 0.6, eventFreshBars: { '1d': 10, '4h': 12, '1h': 12, '15m': 8, '5m': 6 },
  };

  /* ---------- indicators (ADX ported from the Tradesys Edge engine, with +DI/−DI kept) ---------- */
  function wilder(a, p) { const o = []; let prev = null, buf = []; for (let i = 0; i < a.length; i++) { const v = a[i]; if (v == null) { o.push(null); continue; } if (prev === null) { buf.push(v); if (buf.length < p) { o.push(null); continue; } prev = avg(buf); } else prev = (prev * (p - 1) + v) / p; o.push(prev); } return o; }
  function trueRange(h, l, c) { return h.map((_, i) => (i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])))); }
  function adx(h, l, c, p = 14) {
    const pdm = [null], mdm = [null];
    for (let i = 1; i < h.length; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0); }
    const tr = trueRange(h, l, c); tr[0] = null;
    const str = wilder(tr, p), sp = wilder(pdm, p), sm = wilder(mdm, p);
    const pdi = [], mdi = [];
    const dx = c.map((_, i) => { if (!str[i]) { pdi.push(null); mdi.push(null); return null; } const a = 100 * sp[i] / str[i], b = 100 * sm[i] / str[i]; pdi.push(a); mdi.push(b); return a + b === 0 ? 0 : 100 * Math.abs(a - b) / (a + b); });
    return { adx: wilder(dx, p), pdi, mdi };
  }
  const roc = (c, n) => c.map((v, i) => (i >= n && c[i - n] > 0 ? (v / c[i - n] - 1) * 100 : null));

  // closed: candles from CORE.normalizeKlines with closed === true; btc: same timeframe BTC closed candles (optional)
  function indicators(closed, CORE, btc) {
    const c = closed, closes = c.map((x) => x.c), n = c.length;
    const e13 = CORE.ema(closes, 13), e21 = CORE.ema(closes, 21), e50 = CORE.ema(closes, 50), e200 = CORE.ema(closes, 200);
    const R = CORE.rsi(closes, 14), A = CORE.atr(c, 14), D = adx(c.map((x) => x.h), c.map((x) => x.l), closes, 14);
    const qv = c.map((x) => (isNum(x.qv) ? x.qv : x.v * x.c)), qvS = CORE.sma(qv, P.relVolLen);
    const r10 = roc(closes, P.rocLen);
    let rs = null;
    if (btc && btc.length) {
      const m = new Map(btc.map((x) => [x.t, x.c])), L = n - 1, j = L - P.rsLen;
      const a1 = c[L], a0 = c[j], b1 = a1 && m.get(a1.t), b0 = a0 && m.get(a0.t);
      if (a0 && b1 > 0 && b0 > 0) rs = ((a1.c / a0.c) - (b1 / b0)) * 100;
    }
    // relative volume of the last closed bar vs the average of the previous 20 closed bars
    const rv = n > P.relVolLen && qvS[n - 2] ? qv[n - 1] / qvS[n - 2] : null;
    return { e13, e21, e50, e200, rsi: R, atr: A, adx: D.adx, pdi: D.pdi, mdi: D.mdi, roc: r10, relVol: rv, rsVsBtc: rs, qv };
  }

  /* ---------- EMA 13×21 crossover and retest ---------- */
  function emaCross(closed, ind) {
    const { e13, e21, atr } = ind, L = closed.length - 1;
    let crossIdx = null, dir = null;
    for (let i = L; i >= 1 && i >= L - P.retestWindow; i--) {
      if ([e13[i], e21[i], e13[i - 1], e21[i - 1]].some((v) => v == null)) break;
      if (e13[i - 1] <= e21[i - 1] && e13[i] > e21[i]) { crossIdx = i; dir = 'bull'; break; }
      if (e13[i - 1] >= e21[i - 1] && e13[i] < e21[i]) { crossIdx = i; dir = 'bear'; break; }
    }
    const above = e13[L] != null && e21[L] != null ? e13[L] > e21[L] : null;
    const out = { above, crossIdx, crossDir: dir, crossBarsAgo: crossIdx != null ? L - crossIdx : null, crossT: crossIdx != null ? closed[crossIdx].t : null, retestIdx: null, retestBarsAgo: null, state: 'NONE', why: '' };
    if (dir !== 'bull') {
      out.state = above === false ? 'BEARISH' : 'NONE';
      out.why = dir === 'bear' ? `EMA13 crossed below EMA21 ${out.crossBarsAgo} bar(s) ago` : above === false ? 'EMA13 below EMA21' : 'No bullish cross in the last ' + P.retestWindow + ' bars';
      return out;
    }
    // first closed bar after the cross whose low touches EMA21 (within tolerance) and closes back above it, while EMA13 > EMA21
    for (let j = crossIdx + 1; j <= L; j++) {
      if (closed[j].c < e21[j]) { out.state = 'FAILED'; out.why = `Closed below EMA21 ${L - j} bar(s) ago after the cross`; return out; }
      const tol = (atr[j] || 0) * P.retestTolAtr;
      if (closed[j].l <= e21[j] + tol && closed[j].c > e21[j] && e13[j] > e21[j]) { out.retestIdx = j; out.retestBarsAgo = L - j; break; }
    }
    if (out.retestIdx != null) {
      out.state = out.retestBarsAgo <= P.retestFreshBars ? 'RETEST CONFIRMED' : 'RETEST OLD';
      out.why = `Bullish cross ${out.crossBarsAgo} bar(s) ago, EMA21 retest held ${out.retestBarsAgo} bar(s) ago`;
    } else if (out.crossBarsAgo <= P.crossLookback) { out.state = 'FRESH CROSS'; out.why = `Bullish cross ${out.crossBarsAgo} bar(s) ago, waiting for an EMA21 retest`; }
    else { out.state = 'AWAITING RETEST'; out.why = `Bullish cross ${out.crossBarsAgo} bars ago, no EMA21 retest yet`; }
    return out;
  }

  /* ---------- displacement ---------- */
  function displacements(closed, atr, lookback = 30) {
    const out = [], L = closed.length - 1;
    for (let i = Math.max(1, L - lookback + 1); i <= L; i++) {
      const k = closed[i], body = Math.abs(k.c - k.o), range = k.h - k.l, a = atr[i];
      if (!a || range <= 0) continue;
      if (body >= P.dispAtr * a && body / range >= P.dispBodyRatio) out.push({ i, t: k.t, dir: k.c > k.o ? 'bull' : 'bear', bodyAtr: body / a, barsAgo: L - i });
    }
    return out;
  }

  /* ---------- Quant score for one timeframe (0–100, weights documented) ---------- */
  const QW = { trend: 0.35, momentum: 0.20, adx: 0.15, relVol: 0.10, roc: 0.10, rs: 0.10 };
  function tfScore(closed, ind) {
    const L = closed.length - 1, c = closed[L] && closed[L].c, g = (a) => a[L];
    const parts = {};
    if (g(ind.e21) != null && g(ind.e50) != null) {
      const checks = [g(ind.e13) > g(ind.e21), g(ind.e21) > g(ind.e50)];
      if (g(ind.e200) != null) checks.push(g(ind.e50) > g(ind.e200), c > g(ind.e200));
      parts.trend = 100 * checks.filter(Boolean).length / checks.length;
    }
    const r = g(ind.rsi); if (isNum(r)) parts.momentum = r >= 50 && r <= 70 ? 100 : r > 70 && r <= 78 ? 60 : r > 78 ? 30 : r >= 45 ? 50 : r >= 40 ? 25 : 0;
    const a = g(ind.adx), up = g(ind.pdi) > g(ind.mdi); if (isNum(a)) parts.adx = !up ? 0 : a >= 25 ? 100 : a >= 20 ? 60 : 30;
    if (isNum(ind.relVol)) parts.relVol = clamp(ind.relVol / 2 * 100);
    if (isNum(g(ind.roc))) parts.roc = clamp(50 + 5 * g(ind.roc));
    if (isNum(ind.rsVsBtc)) parts.rs = clamp(50 + 3 * ind.rsVsBtc);
    let num = 0, den = 0; for (const [k, w] of Object.entries(QW)) if (isNum(parts[k])) { num += w * parts[k]; den += w; }
    return { score: den ? num / den : null, parts, coverage: den / Object.values(QW).reduce((s, x) => s + x, 0) };
  }

  /* ---------- one timeframe: quant + SMC ---------- */
  function analyze(all, tf, CORE, btcClosed) {
    const A = CORE.analyzeTF(all, tf);
    const closed = A.candles || [];
    if (!A.ok) return { tf, ok: false, n: closed.length, why: `Only ${closed.length} closed candles` };
    const ind = indicators(closed, CORE, btcClosed);
    const L = closed.length - 1, last = closed[L], fresh = P.eventFreshBars[tf] || 10;
    const cross = emaCross(closed, ind), q = tfScore(closed, ind), disp = displacements(closed, ind.atr);
    const ev = A.events || [], lastEv = A.lastEvent;
    const bullObs = (A.obs || []).filter((z) => z.dir === 'bull' && z.validity === 'Valid' && z.bottom < last.c).sort((a, b) => b.top - a.top);
    const bullFvgs = (A.fvgs || []).filter((f) => f.dir === 'bull' && f.status !== 'Filled' && f.top < last.c * 1.0001).sort((a, b) => b.top - a.top);
    const inZone = (z) => last.l <= z.top && last.c >= z.bottom;
    const sweeps = ((A.liq && A.liq.levels) || []).filter((l) => l.type === 'SSL' && l.sweepType === 'Sweep & Reclaim' && l.reclaimAt != null && L - l.reclaimAt <= fresh).map((l) => ({ price: l.price, at: closed[l.reclaimAt].t, barsAgo: L - l.reclaimAt }));
    const eqs = ((A.liq && A.liq.equals) || []).map((e) => ({ type: e.type, price: e.price, distPct: (e.price / last.c - 1) * 100 })).sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct)).slice(0, 4);
    const evOut = ev.slice(-6).map((e) => ({ type: e.mss ? 'MSS' : e.type, dir: e.dir, level: e.level, t: e.t, barsAgo: L - e.i }));
    return {
      tf, ok: true, n: closed.length, lastClosedOpen: last.t, close: last.c,
      ind: { ema13: ind.e13[L], ema21: ind.e21[L], ema50: ind.e50[L], ema200: ind.e200[L], rsi: ind.rsi[L], atr: ind.atr[L], atrPct: ind.atr[L] ? ind.atr[L] / last.c * 100 : null, adx: ind.adx[L], pdi: ind.pdi[L], mdi: ind.mdi[L], roc: ind.roc[L], relVol: ind.relVol, rsVsBtc: ind.rsVsBtc },
      stack: ind.e200[L] != null ? (ind.e13[L] > ind.e21[L] && ind.e21[L] > ind.e50[L] && ind.e50[L] > ind.e200[L] ? 'BULL STACK' : ind.e13[L] < ind.e21[L] && ind.e21[L] < ind.e50[L] && ind.e50[L] < ind.e200[L] ? 'BEAR STACK' : 'MIXED') : 'NO EMA200',
      cross, quant: q, structure: A.trend, cls: A.cls, events: evOut,
      lastEvent: lastEv ? { type: lastEv.mss ? 'MSS' : lastEv.type, dir: lastEv.dir, level: lastEv.level, barsAgo: L - lastEv.i, t: lastEv.t } : null,
      obs: bullObs.slice(0, 3).map((z) => ({ top: z.top, bottom: z.bottom, kind: z.kind, status: z.mitigation, t: z.t, inZone: inZone(z), confirmed: z.confirmed })),
      fvgs: bullFvgs.slice(0, 3).map((f) => ({ top: f.top, bottom: f.bottom, status: f.status, t: f.t, inZone: inZone(f) })),
      sweeps, equals: eqs, displacement: disp.slice(-4),
      range: A.dr ? { high: A.dr.high, low: A.dr.low, eq: A.dr.eq, pos: A.dr.pos, zone: A.dr.zone } : null,
      _A: A, _ind: ind,
    };
  }

  /* ---------- multi-timeframe ---------- */
  // tfs: {'1d','4h','1h','15m','5m'} → analyze() output; quality: {tf → candleQuality meta}
  function mtf(tfs, quality) {
    const need = ['1d', '4h', '1h', '15m'];
    const bad = need.filter((tf) => !tfs[tf] || !tfs[tf].ok || (quality && quality[tf] && !quality[tf].usableForSignals));
    const d = tfs['1d'], h4 = tfs['4h'], h1 = tfs['1h'], m15 = tfs['15m'], m5 = tfs['5m'];
    const steps = [];
    // D1 macro trend
    let macro = 'UNAVAILABLE';
    if (d && d.ok) { const i = d.ind; macro = i.ema200 != null ? (d.close > i.ema200 && i.ema50 > i.ema200 ? 'BULLISH' : d.close < i.ema200 && i.ema50 < i.ema200 ? 'BEARISH' : 'NEUTRAL') : (d.close > i.ema50 ? 'BULLISH' : 'BEARISH'); }
    steps.push({ tf: '1d', role: 'Macro trend', state: macro, pass: macro === 'BULLISH' || macro === 'NEUTRAL', why: d && d.ok ? `Close ${d.close > d.ind.ema200 ? 'above' : 'below'} EMA200, EMA50 ${d.ind.ema50 > d.ind.ema200 ? 'above' : 'below'} EMA200` : 'No data' });
    // H4 structure
    let st4 = 'UNAVAILABLE';
    if (h4 && h4.ok) st4 = h4.structure === 'bull' ? 'BULLISH' : h4.structure === 'bear' ? 'BEARISH' : 'RANGE';
    steps.push({ tf: '4h', role: 'Primary structure', state: st4, pass: st4 === 'BULLISH', why: h4 && h4.ok && h4.lastEvent ? `Last event ${h4.lastEvent.dir} ${h4.lastEvent.type} ${h4.lastEvent.barsAgo} bars ago` : 'No structure break yet' });
    // H1 setup
    let setup = 'NONE', sWhy = 'No EMA13×21 setup and price not at a bullish order block or FVG';
    if (h1 && h1.ok) {
      const zone = h1.obs.find((z) => z.inZone) || h1.fvgs.find((z) => z.inZone);
      if (h1.structure === 'bear' && !(h1.lastEvent && h1.lastEvent.type !== 'BOS' && h1.lastEvent.dir === 'bull')) { setup = 'NONE'; sWhy = 'H1 structure bearish'; }
      else if (h1.cross.state === 'RETEST CONFIRMED' || h1.cross.state === 'FRESH CROSS') { setup = h1.cross.state === 'RETEST CONFIRMED' ? 'EMA RETEST' : 'EMA CROSS'; sWhy = h1.cross.why; }
      else if (zone && (!h1.range || h1.range.zone !== 'Premium')) { setup = 'ZONE TAP'; sWhy = `Price inside a bullish ${zone.kind ? zone.kind.toLowerCase() : 'FVG'} (${zone.bottom.toPrecision(5)}–${zone.top.toPrecision(5)})`; }
    } else sWhy = 'No data';
    steps.push({ tf: '1h', role: 'Setup confirmation', state: setup, pass: setup !== 'NONE', why: sWhy });
    // M15 entry confirmation
    let entry = 'WAITING', eWhy = 'No bullish break or EMA cross on M15 yet';
    if (m15 && m15.ok) {
      const ev = m15.lastEvent, fresh = P.eventFreshBars['15m'];
      if (ev && ev.dir === 'bull' && ev.barsAgo <= fresh && m15.close > m15.ind.ema21) { entry = 'CONFIRMED'; eWhy = `Bullish ${ev.type} ${ev.barsAgo} bars ago, close above EMA21`; }
      else if (m15.cross.crossDir === 'bull' && m15.cross.crossBarsAgo <= 3 && m15.close > m15.ind.ema21) { entry = 'CONFIRMED'; eWhy = `EMA13×21 bullish cross ${m15.cross.crossBarsAgo} bars ago`; }
    } else eWhy = 'No data';
    steps.push({ tf: '15m', role: 'Entry confirmation', state: entry, pass: entry === 'CONFIRMED', why: eWhy });
    // M5 refinement (optional, never blocks)
    let refine = 'n/a', rWhy = 'Optional';
    if (m5 && m5.ok) { const ev = m5.lastEvent; refine = ev && ev.dir === 'bull' && ev.barsAgo <= P.eventFreshBars['5m'] ? 'REFINED' : 'NOT YET'; rWhy = ev ? `Last M5 event ${ev.dir} ${ev.type} ${ev.barsAgo} bars ago` : 'No M5 structure break'; }
    steps.push({ tf: '5m', role: 'Entry refinement (optional)', state: refine, pass: null, why: rWhy });

    let verdict, why;
    if (bad.length) { verdict = 'DATA NOT USABLE'; why = 'Stale, invalid or missing: ' + bad.join(', '); }
    else if (macro === 'BEARISH' && st4 === 'BEARISH') { verdict = 'BEARISH'; why = 'D1 and H4 both bearish; long-only system stands aside'; }
    else if (steps.slice(0, 4).every((s) => s.pass)) { verdict = 'BULLISH CONFIRMED'; why = 'D1 not bearish, H4 bullish, H1 setup present, M15 entry confirmed'; }
    else if (steps[0].pass && steps[1].pass) { verdict = 'DEVELOPING'; why = 'Higher timeframes support longs; waiting for ' + steps.slice(2, 4).filter((s) => !s.pass).map((s) => s.tf.toUpperCase() + ' ' + s.role.toLowerCase()).join(' and '); }
    else { verdict = 'NOT ALIGNED'; why = steps.slice(0, 2).filter((s) => !s.pass).map((s) => s.tf.toUpperCase() + ' ' + s.state.toLowerCase()).join(', '); }
    // Quant score for the asset: 0.4 D1 + 0.6 H4 when both exist
    const qd = d && d.ok ? d.quant.score : null, qh = h4 && h4.ok ? h4.quant.score : null;
    const quant = isNum(qd) && isNum(qh) ? 0.4 * qd + 0.6 * qh : isNum(qh) ? qh : isNum(qd) ? qd : null;
    return { verdict, why, steps, quant, bullishConfirmed: verdict === 'BULLISH CONFIRMED' };
  }

  // Quant score from D1 and H4 only (stage-1 screening of the whole universe).
  function screen(d, h4) {
    const qd = d && d.ok ? d.quant.score : null, qh = h4 && h4.ok ? h4.quant.score : null;
    return isNum(qd) && isNum(qh) ? 0.4 * qd + 0.6 * qh : isNum(qh) ? qh : isNum(qd) ? qd : null;
  }

  return { P, QW, adx, roc, indicators, emaCross, displacements, tfScore, analyze, mtf, screen };
})();

/* ==== HYBRID WALLET INTELLIGENCE & CAPITAL FLOW (Phase 4) — pure functions ====
   Exchange side (Binance, anonymous): aggressive buy/sell from kline taker columns, large-trade activity and
   trade-flow imbalance from aggregate trades, order book imbalance, volume concentration, narrative capital flow.
   On-chain side: wallet registry records with source, verification and confidence, plus chain adapters.
   Binance trades are never turned into wallet records: they carry no address and are kind EXCHANGE_TRADE. */
const FLOW = (() => {
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
  const median = (a) => { const v = a.filter(isNum).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

  const P = { largeFloorUsd: 10000, largeMedianMult: 50, bars24h: 6, bars7d: 42 };
  // Exchange-flow score weights. Order book imbalance is already inside Attention, so it is shown here but not scored twice.
  const FW = { delta24: 0.30, delta7: 0.25, large: 0.25, tradeFlow: 0.20 };

  /* ---------- kline taker flow ---------- */
  // Binance kline row: [0 open time, 7 quote volume, 10 taker buy quote volume, 6 close time]. Closed bars only.
  function klineFlow(raw, nowMs) {
    if (!Array.isArray(raw)) return null;
    const seen = new Set(), bars = [];
    for (const k of raw) {
      if (!Array.isArray(k) || k.length < 11) continue;
      const t = +k[0], ct = +k[6], qv = +k[7], tb = +k[10];
      if (!isNum(t) || seen.has(t) || !(ct < nowMs) || !isNum(qv) || !isNum(tb) || qv < 0 || tb < 0 || tb > qv * (1 + 1e-9)) continue;
      seen.add(t); bars.push({ t, qv, buy: tb, sell: qv - tb });
    }
    bars.sort((a, b) => a.t - b.t);
    const win = (n, endOff = 0) => {
      const s = bars.slice(Math.max(0, bars.length - endOff - n), bars.length - endOff);
      if (s.length < n) return null;
      const qv = s.reduce((a, x) => a + x.qv, 0), buy = s.reduce((a, x) => a + x.buy, 0);
      return { qv, buy, sell: qv - buy, delta: 2 * buy - qv, imb: qv > 0 ? (2 * buy - qv) / qv : null, buyRatio: qv > 0 ? buy / qv : null, maxBarShare: qv > 0 ? Math.max(...s.map((x) => x.qv)) / qv : null };
    };
    return { bars: bars.length, lastClosedOpen: bars.length ? bars[bars.length - 1].t : null, h24: win(P.bars24h), d7: win(P.bars7d), d7prev: win(P.bars7d, P.bars7d) };
  }

  /* ---------- aggregate trades ---------- */
  // aggTrades row: {a id, p price, q qty, T time, m buyerIsMaker}. m === true means the taker sold.
  function tradeFlow(agg, opts = {}) {
    if (!Array.isArray(agg) || !agg.length) return null;
    const seen = new Set(), tr = [];
    for (const x of agg) {
      if (!x || seen.has(x.a)) continue; seen.add(x.a);
      const p = +x.p, q = +x.q, T = +x.T; if (!(p > 0) || !(q > 0) || !isNum(T)) continue;
      tr.push({ id: x.a, usd: p * q, side: x.m ? 'SELL' : 'BUY', T, p });
    }
    if (!tr.length) return null;
    tr.sort((a, b) => a.T - b.T);
    const med = median(tr.map((x) => x.usd));
    const thr = Math.max(opts.floor ?? P.largeFloorUsd, (opts.mult ?? P.largeMedianMult) * med);
    const sum = (arr, s) => arr.filter((x) => !s || x.side === s).reduce((a, x) => a + x.usd, 0);
    const buy = sum(tr, 'BUY'), sell = sum(tr, 'SELL');
    const large = tr.filter((x) => x.usd >= thr), lb = sum(large, 'BUY'), ls = sum(large, 'SELL');
    const biggest = large.slice().sort((a, b) => b.usd - a.usd).slice(0, 5).map((x) => ({ kind: 'EXCHANGE_TRADE', usd: x.usd, side: x.side, price: x.p, T: x.T }));
    return {
      n: tr.length, from: tr[0].T, to: tr[tr.length - 1].T, spanMin: (tr[tr.length - 1].T - tr[0].T) / 60e3,
      medianUsd: med, thresholdUsd: thr, buyUsd: buy, sellUsd: sell, imb: buy + sell > 0 ? (buy - sell) / (buy + sell) : null,
      largeN: large.length, largeBuyUsd: lb, largeSellUsd: ls, largeImb: lb + ls > 0 ? (lb - ls) / (lb + ls) : null,
      largeShare: buy + sell > 0 ? (lb + ls) / (buy + sell) : null, biggest,
    };
  }

  /* ---------- exchange flow score (0–100, 50 = balanced) ---------- */
  function flowScore(k, tf) {
    const parts = {};
    if (k && k.h24 && isNum(k.h24.imb)) parts.delta24 = clamp(50 + 250 * k.h24.imb);       // ±0.20 imbalance → 100 / 0
    if (k && k.d7 && isNum(k.d7.imb)) parts.delta7 = clamp(50 + 250 * k.d7.imb);
    if (tf && tf.largeN >= 3 && isNum(tf.largeImb)) parts.large = clamp(50 + 50 * tf.largeImb); // needs ≥ 3 large trades
    if (tf && isNum(tf.imb)) parts.tradeFlow = clamp(50 + 100 * tf.imb);
    let num = 0, den = 0; for (const [key, w] of Object.entries(FW)) if (isNum(parts[key])) { num += w * parts[key]; den += w; }
    return { score: den ? num / den : null, parts, coverage: den };
  }

  // Wallet component for CIS: exchange half + on-chain half. With no on-chain data the on-chain half is UNAVAILABLE.
  function walletScore(exchange, onchain) {
    const ex = exchange && isNum(exchange.score) ? exchange.score : null, oc = onchain && isNum(onchain.score) ? onchain.score : null;
    if (ex == null && oc == null) return { score: null, mode: 'UNAVAILABLE', coverage: 0 };
    if (oc == null) return { score: ex, mode: 'EXCHANGE ONLY', coverage: 0.5 * (exchange.coverage ?? 1) };
    if (ex == null) return { score: oc, mode: 'ON-CHAIN ONLY', coverage: 0.5 * (onchain.coverage ?? 1) };
    return { score: 0.5 * ex + 0.5 * oc, mode: 'HYBRID', coverage: 0.5 * (exchange.coverage ?? 1) + 0.5 * (onchain.coverage ?? 1) };
  }

  /* ---------- on-chain (EVM token transfers from the Etherscan connector) ---------- */
  const ZERO = '0x0000000000000000000000000000000000000000';
  const OW = { exNet: 0.50, supply: 0.20, whaleTrend: 0.30 };
  // Etherscan chain ids on the free tier, keyed by CoinGecko platform id.
  const EVM = [{ cg: 'ethereum', chainid: '1', name: 'Ethereum' }, { cg: 'arbitrum-one', chainid: '42161', name: 'Arbitrum' }, { cg: 'polygon-pos', chainid: '137', name: 'Polygon' }];
  // Picks the token contract from a search-coingecko token result; accepted only when its canonical coin id equals the taxonomy id.
  function resolveContract(res, cgId) {
    if (!res || !cgId) return null;
    const all = [].concat(res.selected ? [res.selected] : [], res.candidates || []);
    const m = all.find((x) => x && x.identity && x.identity.type === 'token' && /^0x[0-9a-fA-F]{40}$/.test(x.identity.address || '') && x.canonicalCoinId === cgId);
    return m ? { address: m.identity.address.toLowerCase(), cgChain: m.identity.chain, verifiedBy: 'CoinGecko canonical id = ' + cgId } : null;
  }
  // rows: Etherscan token transfers (newest first); priceUsd: Binance price; exchanges: Set of lower-case labelled exchange addresses.
  function onchainSample(rows, priceUsd, exchanges, opts = {}) {
    if (!Array.isArray(rows) || !rows.length || !(priceUsd > 0)) return null;
    const seen = new Set(), tr = [];
    for (const x of rows) {
      // Etherscan rows carry no logIndex; identical transfers inside one transaction are real, so only rows with a logIndex are de-duplicated.
      if (x.logIndex != null) { const key = (x.hash || '') + ':' + x.logIndex; if (seen.has(key)) continue; seen.add(key); }
      const dec = +x.tokenDecimal, raw = String(x.value || '0'), t = +x.timeStamp;
      if (!isNum(dec) || !/^\d+$/.test(raw) || !isNum(t)) continue;
      const amt = raw.length > dec ? +(raw.slice(0, raw.length - dec) + '.' + raw.slice(raw.length - dec)) : +('0.' + raw.padStart(dec, '0'));
      tr.push({ t, from: String(x.from).toLowerCase(), to: String(x.to).toLowerCase(), usd: amt * priceUsd });
    }
    if (tr.length < 20) return { n: tr.length, insufficient: true };
    tr.sort((a, b) => a.t - b.t);
    const t0 = tr[0].t, t1 = tr[tr.length - 1].t, spanH = Math.max((t1 - t0) / 3600, 1 / 60);
    const tot = tr.reduce((a, x) => a + x.usd, 0);
    const mint = tr.filter((x) => x.from === ZERO).reduce((a, x) => a + x.usd, 0), burn = tr.filter((x) => x.to === ZERO).reduce((a, x) => a + x.usd, 0);
    const med = median(tr.map((x) => x.usd)), thr = Math.max(opts.floor ?? P.largeFloorUsd, (opts.mult ?? P.largeMedianMult) * med);
    const mid = t0 + (t1 - t0) / 2, large = tr.filter((x) => x.usd >= thr);
    const l1 = large.filter((x) => x.t < mid).length, l2 = large.filter((x) => x.t >= mid).length;
    const ex = exchanges || new Set();
    const exIn = tr.filter((x) => ex.has(x.to) && !ex.has(x.from)), exOut = tr.filter((x) => ex.has(x.from) && !ex.has(x.to));
    const inUsd = exIn.reduce((a, x) => a + x.usd, 0), outUsd = exOut.reduce((a, x) => a + x.usd, 0);
    const addrs = new Set(); const sent = new Map();
    for (const x of tr) { addrs.add(x.from); addrs.add(x.to); sent.set(x.from, (sent.get(x.from) || 0) + x.usd); }
    const top10 = [...sent.values()].sort((a, b) => b - a).slice(0, 10).reduce((a, x) => a + x, 0);
    return {
      n: tr.length, from: t0 * 1000, to: t1 * 1000, spanH, totalUsd: tot, perHourUsd: tot / spanH, activeAddrPerH: addrs.size / spanH, addrs: addrs.size,
      mintUsd: mint, burnUsd: burn, netMintShare: tot > 0 ? (mint - burn) / tot : 0,
      thresholdUsd: thr, largeN: large.length, largeUsd: large.reduce((a, x) => a + x.usd, 0), large1: l1, large2: l2,
      exN: exIn.length + exOut.length, exInUsd: inUsd, exOutUsd: outUsd, exNetOutUsd: outUsd - inUsd, exImb: inUsd + outUsd > 0 ? (outUsd - inUsd) / (inUsd + outUsd) : null,
      top10SenderShare: tot > 0 ? top10 / tot : null,
    };
  }
  // On-chain score (0–100, 50 = neutral). Needs at least two of the three parts.
  function onchainScore(m) {
    if (!m || m.insufficient) return { score: null, parts: {}, coverage: 0, why: m ? `Only ${m.n} transfers` : 'No on-chain sample' };
    const parts = {};
    if (m.exN >= 3 && isNum(m.exImb)) parts.exNet = clamp(50 + 50 * m.exImb);               // tokens leaving exchanges = accumulation
    parts.supply = clamp(50 - 50 * Math.max(-1, Math.min(1, 20 * m.netMintShare)));          // 5% net mint of transferred value → 0; 5% net burn → 100
    if (m.large1 + m.large2 >= 4) parts.whaleTrend = clamp(50 + 25 * Math.log2((m.large2 + 1) / (m.large1 + 1)));
    const have = Object.keys(parts).length;
    if (have < 2) return { score: null, parts, coverage: 0, why: 'Fewer than two on-chain parts measurable (needs ≥ 3 labelled-exchange transfers or ≥ 4 large transfers)' };
    let num = 0, den = 0; for (const [k, w] of Object.entries(OW)) if (isNum(parts[k])) { num += w * parts[k]; den += w; }
    return { score: num / den, parts, coverage: den };
  }

  /* ---------- concentration ---------- */
  function concentration(values) {
    const v = values.filter((x) => isNum(x) && x > 0).sort((a, b) => b - a), tot = v.reduce((a, x) => a + x, 0);
    if (!tot) return null;
    const top = (n) => v.slice(0, n).reduce((a, x) => a + x, 0) / tot;
    return { n: v.length, total: tot, top1: top(1), top10: top(10), top20: top(20), hhi: v.reduce((a, x) => a + (x / tot) ** 2, 0) * 10000 };
  }

  /* ---------- narrative capital flow ---------- */
  // rows: [{symbol, labels:[...], k: klineFlow}] — each pair counts once per label it carries.
  function narrativeFlow(rows, keys) {
    const tot = (f, w) => rows.reduce((a, r) => a + ((r.k && r.k[w] && r.k[w][f]) || 0), 0);
    const all24 = tot('qv', 'h24'), all7 = tot('qv', 'd7'), allPrev = tot('qv', 'd7prev');
    return keys.map(([key, name]) => {
      const m = rows.filter((r) => r.labels.includes(key) && r.k && r.k.d7);
      const s = (f, w) => m.reduce((a, r) => a + ((r.k[w] && r.k[w][f]) || 0), 0);
      if (!m.length) return { key, name, n: 0, status: 'UNAVAILABLE' };
      const qv24 = s('qv', 'h24'), d24 = s('delta', 'h24'), qv7 = s('qv', 'd7'), d7 = s('delta', 'd7'), qvp = s('qv', 'd7prev');
      const share7 = all7 > 0 ? qv7 / all7 : null, sharePrev = allPrev > 0 ? qvp / allPrev : null;
      const top = m.slice().sort((a, b) => ((b.k.d7 && b.k.d7.delta) || 0) - ((a.k.d7 && a.k.d7.delta) || 0));
      return { key, name, n: m.length, status: 'OK', qv24, delta24: d24, imb24: qv24 > 0 ? d24 / qv24 : null, qv7, delta7: d7, imb7: qv7 > 0 ? d7 / qv7 : null, share24: all24 > 0 ? qv24 / all24 : null, share7, sharePrev, shareChange: isNum(share7) && sharePrev > 0 ? share7 / sharePrev - 1 : null, topIn: top.slice(0, 3).map((r) => r.symbol), topOut: top.slice(-3).reverse().map((r) => r.symbol) };
    });
  }

  /* ---------- wallet registry ---------- */
  const CHAINS = {
    ethereum: { name: 'Ethereum', re: /^0x[0-9a-fA-F]{40}$/ }, bsc: { name: 'BNB Smart Chain', re: /^0x[0-9a-fA-F]{40}$/ }, arbitrum: { name: 'Arbitrum', re: /^0x[0-9a-fA-F]{40}$/ },
    base: { name: 'Base', re: /^0x[0-9a-fA-F]{40}$/ }, polygon: { name: 'Polygon', re: /^0x[0-9a-fA-F]{40}$/ }, optimism: { name: 'Optimism', re: /^0x[0-9a-fA-F]{40}$/ },
    bitcoin: { name: 'Bitcoin', re: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/ },
    solana: { name: 'Solana', re: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ }, tron: { name: 'Tron', re: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ },
  };
  const ENTITY = ['EXCHANGE', 'FUND', 'MARKET_MAKER', 'SMART_MONEY', 'WHALE', 'PROJECT_TREASURY', 'BRIDGE', 'OTHER'];
  const VERIFY = ['VERIFIED', 'UNVERIFIED'];
  const CONF = ['HIGH', 'MEDIUM', 'LOW'];
  // A label is VERIFIED only with a reference link (explorer tag, official post, provider page).
  function validateWallet(w) {
    const errs = [];
    const chain = CHAINS[w && w.chain];
    if (!chain) errs.push('Unknown chain');
    const addr = String((w && w.address) || '').trim();
    if (chain && !chain.re.test(addr)) errs.push(`Not a valid ${chain.name} address`);
    if (!w || !String(w.label || '').trim()) errs.push('Label is required');
    if (!w || !ENTITY.includes(w.entity)) errs.push('Entity type is required');
    if (!w || !String(w.source || '').trim()) errs.push('Source is required (where the label comes from)');
    if (!w || !VERIFY.includes(w.verification)) errs.push('Verification must be VERIFIED or UNVERIFIED');
    if (w && w.verification === 'VERIFIED' && !/^https:\/\/\S+$/.test(String(w.reference || ''))) errs.push('A VERIFIED label needs an https reference link');
    if (!w || !CONF.includes(w.confidence)) errs.push('Confidence must be HIGH, MEDIUM or LOW');
    if (w && w.verification === 'UNVERIFIED' && w.confidence === 'HIGH') errs.push('An UNVERIFIED label cannot have HIGH confidence');
    if (errs.length) return { ok: false, errs };
    const evm = /^0x/.test(addr);
    return { ok: true, record: { chain: w.chain, address: evm ? addr.toLowerCase() : addr, label: String(w.label).trim(), entity: w.entity, source: String(w.source).trim(), verification: w.verification, reference: w.reference || null, confidence: w.confidence, note: w.note ? String(w.note).trim() : null } };
  }
  const walletId = (r) => `${r.chain}:${r.address}`.replace(/[^A-Za-z0-9_\-.~:@+]/g, '_');

  // Chain adapters: each names the source it needs; status is derived, never assumed.
  const ADAPTERS = [
    { chain: 'ethereum', source: 'Etherscan connector (free tier)', covers: 'ERC-20 transfers: whale transfers, mint/burn, exchange in/outflow for labelled wallets' },
    { chain: 'arbitrum', source: 'Etherscan connector (free tier)', covers: 'Token transfers on Arbitrum One' },
    { chain: 'polygon', source: 'Etherscan connector (free tier)', covers: 'Token transfers on Polygon PoS' },
    { chain: 'bsc', source: 'Etherscan paid plan', covers: 'BEP-20 transfers' },
    { chain: 'base', source: 'Etherscan paid plan', covers: 'Token transfers on Base' },
    { chain: 'bitcoin', source: 'No free connector found', covers: 'UTXO transfers' },
    { chain: 'solana', source: 'No free connector found', covers: 'SPL transfers' },
    { chain: 'tron', source: 'No free connector found', covers: 'TRC-20 transfers (USDT)' },
  ];
  function adapterStatus(connected) {
    return ADAPTERS.map((a) => { const free = /free tier/.test(a.source), ok = free && connected.etherscan; return Object.assign({}, a, { state: ok ? 'READY' : 'UNAVAILABLE', why: ok ? 'Connector available' : free ? 'Etherscan connector not connected' : /paid/.test(a.source) ? 'Needs a paid Etherscan plan' : 'No free public source reachable from this app' }); });
  }

  return { ZERO, OW, EVM, resolveContract, onchainSample, onchainScore, P, FW, klineFlow, tradeFlow, flowScore, walletScore, concentration, narrativeFlow, CHAINS, ENTITY, VERIFY, CONF, validateWallet, walletId, ADAPTERS, adapterStatus, median };
})();

/* ==== INTELLIGENCE SCORING, TRADE SIGNALS & RISK (Phase 5) — pure functions ====
   CIS = 0.25 Narrative + 0.25 Attention + 0.20 Wallet + 0.20 Quant + 0.10 Risk (all 0–100).
   CIS ranks candidates; it is never a BUY by itself. A BUY needs every hard filter to pass,
   and any failed hard filter overrides a high CIS. Spot, long-only, no order execution. */
const SIG = (() => {
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

  const W = { narrative: 0.25, attention: 0.25, wallet: 0.20, quant: 0.20, risk: 0.10 };
  const CLASSES = [[85, 'ELITE'], [70, 'STRONG'], [55, 'DEVELOPING'], [40, 'WEAK'], [0, 'POOR']];
  const DEFAULT_CFG = {
    equity: null, riskPct: 1, maxOpen: 5, dailyLossPct: 3, ddWarnPct: 5, ddStopPct: 10, minRR: 2, rrTarget: 'TP2',
    feePct: 0.1, slipPct: 0.05, minCIS: 70, watchCIS: 55, minLiqTier: 'C', maxSpreadPct: 0.3, maxSlPct: 8, maxPerNarrative: 2, maxHeatPct: 5, maxInputAgeH: 6,
    requireTiming: true, // BUY only when the entry is on time: not chasing the break and not late (Phase 7.4)
    requireEdge: true, // block BUY while the latest historical test of the live rules shows NO EDGE (Phase 7)
  };
  const TIER_RANK = { A: 1, B: 2, C: 3, D: 4, E: 5 };

  // Validates and clamps a risk configuration; returns the config plus the list of corrections made.
  function normalizeCfg(c) {
    const o = Object.assign({}, DEFAULT_CFG, c || {}), fix = [];
    const num = (k, lo, hi) => { const v = o[k]; if (v === null && k === 'equity') return; if (!isNum(+v) || +v < lo || +v > hi) { fix.push(`${k} reset to ${DEFAULT_CFG[k]} (allowed ${lo}–${hi})`); o[k] = DEFAULT_CFG[k]; } else o[k] = +v; };
    num('equity', 1, 1e12); num('riskPct', 0.05, 5); num('maxOpen', 1, 50); num('dailyLossPct', 0.5, 50); num('ddWarnPct', 1, 50); num('ddStopPct', 1, 90); num('minRR', 1, 10);
    num('feePct', 0, 1); num('slipPct', 0, 2); num('minCIS', 0, 100); num('watchCIS', 0, 100); num('maxSpreadPct', 0.01, 5); num('maxSlPct', 0.5, 50); num('maxPerNarrative', 1, 20); num('maxHeatPct', 0.5, 50);
    if (!TIER_RANK[o.minLiqTier]) { fix.push('minLiqTier reset to C'); o.minLiqTier = 'C'; }
    if (!['TP1', 'TP2'].includes(o.rrTarget)) { fix.push('rrTarget reset to TP2'); o.rrTarget = 'TP2'; }
    if (o.ddWarnPct >= o.ddStopPct) { fix.push('Drawdown warning must be below the stop; warning set to half of the stop'); o.ddWarnPct = o.ddStopPct / 2; }
    num('maxInputAgeH', 1, 72);
    o.requireTiming = o.requireTiming === false || o.requireTiming === 'false' ? false : true;
    o.requireEdge = o.requireEdge === false || o.requireEdge === 'false' ? false : true;
    if (o.watchCIS > o.minCIS) { fix.push('Watch CIS cannot exceed BUY CIS; set equal'); o.watchCIS = o.minCIS; }
    return { cfg: o, fixes: fix };
  }

  /* ---------- Risk component (higher = safer to trade) ---------- */
  function riskScore({ tier, atrPctD1, spreadPct }) {
    const parts = {};
    if (TIER_RANK[tier]) parts.liquidity = { A: 100, B: 85, C: 65, D: 40, E: 15 }[tier];
    if (isNum(atrPctD1)) parts.volatility = atrPctD1 <= 3 ? 100 : atrPctD1 <= 6 ? 70 : atrPctD1 <= 10 ? 40 : 15;
    if (isNum(spreadPct)) parts.spread = spreadPct <= 0.05 ? 100 : spreadPct <= 0.1 ? 80 : spreadPct <= 0.3 ? 50 : 20;
    const RW = { liquidity: 0.40, volatility: 0.35, spread: 0.25 };
    let num = 0, den = 0; for (const [k, w] of Object.entries(RW)) if (isNum(parts[k])) { num += w * parts[k]; den += w; }
    return { score: den ? num / den : null, parts, coverage: den };
  }

  /* ---------- CIS ---------- */
  // comps: {narrative, attention, wallet, quant, risk} each {score, coverage?}. Quant and Attention are required.
  function cis(comps, weights) {
    const w = Object.assign({}, W, weights || {});
    // FULL = all five inputs measured, each with ≥ 75% of its own parts, and the Wallet input must include on-chain data (HYBRID).
    const missing = [], partial = [];
    let num = 0, den = 0, cov = 0;
    for (const [k, wk] of Object.entries(w)) {
      const c = comps[k];
      if (!c || !isNum(c.score)) { missing.push(k); continue; }
      const cc = isNum(c.coverage) ? clamp(c.coverage, 0, 1) : 1;
      const complete = k === 'wallet' && c.mode ? c.mode === 'HYBRID' && cc >= 0.75 : cc >= 0.75;
      if (!complete) partial.push(k);
      num += wk * c.score; den += wk; cov += wk * cc;
    }
    if (missing.includes('quant') || missing.includes('attention')) return { cis: null, cls: null, quality: 'UNAVAILABLE', missing, partial, coverage: cov, why: 'Quant and Attention are required' };
    const v = num / den;
    return { cis: v, cls: CLASSES.find(([lo]) => v >= lo)[1], quality: missing.length || partial.length ? 'PARTIAL' : 'FULL', missing, partial, coverage: cov, weightsUsed: den };
  }
  const cisClass = (v) => (isNum(v) ? CLASSES.find(([lo]) => v >= lo)[1] : null);

  /* ---------- risk controls ---------- */
  // state: {equity, peakEquity, todayPnl, open:[{symbol, narrative, riskAmt}]}
  function riskGate(state, cfg, symbol, narrative, newRiskAmt) {
    const s = state || {}, checks = [], add = (id, name, pass, detail, level = 'BLOCK') => checks.push({ id, name, pass: !!pass, detail, level });
    const eq = isNum(s.equity) ? s.equity : cfg.equity, peak = isNum(s.peakEquity) ? Math.max(s.peakEquity, eq || 0) : eq;
    const open = Array.isArray(s.open) ? s.open : [];
    add('equity', 'Account equity set', isNum(eq) && eq > 0, isNum(eq) && eq > 0 ? `${eq.toFixed(2)} USDT` : 'Enter account equity in Risk Management');
    add('slots', `Open positions < ${cfg.maxOpen}`, open.length < cfg.maxOpen, `${open.length} open`);
    add('dup', 'Not already holding this pair', !open.some((p) => p.symbol === symbol), open.some((p) => p.symbol === symbol) ? 'Already open' : 'Not held');
    const loss = isNum(s.todayPnl) && s.todayPnl < 0 && isNum(eq) && eq > 0 ? -s.todayPnl / eq * 100 : 0;
    add('daily', `Daily loss < ${cfg.dailyLossPct}%`, loss < cfg.dailyLossPct, `Today ${loss.toFixed(2)}% lost`);
    const dd = isNum(peak) && peak > 0 && isNum(eq) ? (peak - eq) / peak * 100 : 0;
    add('ddStop', `Drawdown < ${cfg.ddStopPct}% (stop)`, dd < cfg.ddStopPct, `Drawdown ${dd.toFixed(2)}% from peak ${isNum(peak) ? peak.toFixed(2) : '–'}`);
    add('ddWarn', `Drawdown < ${cfg.ddWarnPct}% (warning)`, dd < cfg.ddWarnPct, `Drawdown ${dd.toFixed(2)}%`, 'WARN');
    const sameN = narrative && narrative !== 'OTHER' ? open.filter((p) => p.narrative === narrative).length : 0;
    add('narr', `≤ ${cfg.maxPerNarrative} open positions per narrative`, sameN < cfg.maxPerNarrative, narrative ? `${sameN} open in ${narrative}` : 'No narrative');
    const heat = open.reduce((a, p) => a + (isNum(p.riskAmt) ? p.riskAmt : 0), 0) + (isNum(newRiskAmt) ? newRiskAmt : 0);
    const heatPct = isNum(eq) && eq > 0 ? heat / eq * 100 : null;
    add('heat', `Total open risk ≤ ${cfg.maxHeatPct}% of equity`, heatPct != null && heatPct <= cfg.maxHeatPct + 1e-9, heatPct != null ? `${heatPct.toFixed(2)}% including this trade` : 'Equity missing');
    const blocks = checks.filter((c) => c.level === 'BLOCK' && !c.pass);
    return { ok: blocks.length === 0, checks, blocks: blocks.map((c) => c.id), drawdownPct: dd, dailyLossPct: loss, heatPct, warn: checks.some((c) => c.level === 'WARN' && !c.pass) };
  }


  /* ---------- live plan status (current price vs a trading plan) ---------- */
  // Uses the current price only: an earlier wick through the stop or a target is not visible here.
  function liveStatus(plan, price, CORE, cfg) {
    if (!plan || !(price > 0) || !(plan.entry > 0) || !(plan.stopLoss > 0)) return null;
    const pct = (x) => (x > 0 ? (x / price - 1) * 100 : null);
    const out = { price, toEntry: pct(plan.entry), toStop: pct(plan.stopLoss), toTp1: pct(plan.tp1), toTp2: pct(plan.tp2) };
    const tpRef = plan.tp2 > 0 ? plan.tp2 : plan.tp1;
    out.rrNow = tpRef > price && price > plan.stopLoss ? CORE.rr(price, plan.stopLoss, tpRef, cfg.feePct, cfg.slipPct).net : null;
    const band = Math.max(0.003, Math.min(0.01, (plan.entry - plan.stopLoss) / plan.entry * 0.25)); // ±¼ of the stop distance, 0.3–1%
    if (price <= plan.stopLoss) out.state = 'AT OR BELOW STOP';
    else if (plan.tp2 > 0 && price >= plan.tp2) out.state = 'PAST TP2';
    else if (plan.tp1 > 0 && price >= plan.tp1) out.state = 'PAST TP1';
    else if (Math.abs(price / plan.entry - 1) <= band || price < plan.entry) out.state = 'IN ENTRY ZONE';
    else out.state = 'ABOVE ENTRY';
    out.chase = out.state === 'ABOVE ENTRY' && isNum(out.rrNow) && out.rrNow < cfg.minRR; // buying now would break the minimum R:R
    // Expired: the plan should no longer be taken at market (target or stop already reached, or chasing).
    out.expired = out.chase || ['PAST TP1', 'PAST TP2', 'AT OR BELOW STOP'].includes(out.state);
    return out;
  }
  /* ---------- signal evaluation ---------- */
  /* ctx: { symbol, narrative, cis:{cis,cls,quality}, mtf:{verdict, why, steps}, quality:{tf→meta},
          ticker:{quality, tier, spreadPct}, legacy: CORE.signal() output, filters, cfg, riskState, sizing: fn(args, filters)→positionSize, rr: fn, nowMs } */
  function evaluate(ctx) {
    const cfg = ctx.cfg, hard = [], add = (id, name, pass, detail) => hard.push({ id, name, pass: !!pass, detail });
    const c = ctx.cis || {};
    add('cis', `CIS ≥ ${cfg.minCIS}`, isNum(c.cis) && c.cis >= cfg.minCIS, isNum(c.cis) ? `CIS ${c.cis.toFixed(1)} (${c.cls}, ${c.quality})` : 'CIS unavailable');
    const q = ctx.quality || {}, need = ['1d', '4h', '1h', '15m'];
    const stale = need.filter((tf) => !q[tf] || !q[tf].usableForSignals);
    const tOk = ctx.ticker && ctx.ticker.quality === 'FRESH';
    // CIS inputs (narratives, attention, quant) come from the last full scan; older than maxInputAgeH = stale
    const inStale = isNum(ctx.inputsAgeH) && ctx.inputsAgeH > (cfg.maxInputAgeH || 6);
    const dataOk = !stale.length && tOk && ctx.mtf && ctx.mtf.verdict !== 'DATA NOT USABLE' && !inStale;
    add('data', 'Market data valid and fresh', dataOk, dataOk ? 'D1, H4, H1, M15 candles fresh; 24h ticker fresh' + (isNum(ctx.inputsAgeH) ? `; scan ${ctx.inputsAgeH.toFixed(1)} h old` : '') : [stale.length ? `Not usable: ${stale.join(', ')}` : null, !tOk ? '24h ticker stale or missing' : null, inStale ? `CIS inputs from a scan ${ctx.inputsAgeH.toFixed(1)} h old (limit ${cfg.maxInputAgeH || 6} h)` : null].filter(Boolean).join('; '));
    const tier = ctx.ticker && ctx.ticker.tier, spr = ctx.ticker && ctx.ticker.spreadPct;
    const liqOk = TIER_RANK[tier] && TIER_RANK[tier] <= TIER_RANK[cfg.minLiqTier] && isNum(spr) && spr <= cfg.maxSpreadPct;
    add('liq', `Liquidity: tier ${cfg.minLiqTier} or better, spread ≤ ${cfg.maxSpreadPct}%`, liqOk, `Tier ${tier || '–'}, spread ${isNum(spr) ? spr.toFixed(3) + '%' : '–'}`);
    const setupOk = ctx.mtf && ctx.mtf.verdict === 'BULLISH CONFIRMED';
    add('setup', 'Confirmed bullish multi-timeframe setup', setupOk, ctx.mtf ? `${ctx.mtf.verdict}: ${ctx.mtf.why}` : 'No MTF analysis');
    // plan levels from the legacy SMC engine
    const L = ctx.legacy, plan = L && L.plan ? L.plan : null;
    const entry = plan && isNum(plan.entry) ? plan.entry : null, sl = plan && isNum(plan.sl) ? plan.sl : null;
    const slPct = entry && sl ? (entry - sl) / entry * 100 : null;
    const slOk = entry && sl && sl < entry && sl > 0 && slPct <= cfg.maxSlPct;
    add('stop', `Valid stop loss (≤ ${cfg.maxSlPct}% below entry)`, slOk, sl ? `SL ${sl} (${slPct.toFixed(2)}%) · ${plan.slBasis || ''}` : (L && L.checks && (L.checks.find((x) => x.id === 8) || {}).detail) || 'No structural invalidation level');
    const tps = plan && plan.tps ? plan.tps : [];
    const tp1 = tps[0] ? tps[0].price : null, tp2 = tps[1] ? tps[1].price : null;
    const ref = cfg.rrTarget === 'TP1' ? tp1 : tp2;
    const rrv = slOk && isNum(ref) && ctx.rr ? ctx.rr(entry, sl, ref, cfg.feePct, cfg.slipPct) : null;
    const rrOk = rrv && isNum(rrv.net) && rrv.net >= cfg.minRR;
    add('rr', `Net R:R ≥ ${cfg.minRR} to ${cfg.rrTarget}`, rrOk, rrv && isNum(rrv.net) ? `Net ${rrv.net.toFixed(2)} (gross ${rrv.gross.toFixed(2)}) after ${cfg.feePct}% fee + ${cfg.slipPct}% slippage per side` : !isNum(ref) ? `No ${cfg.rrTarget} at unswept buy-side liquidity above entry` : 'Needs a valid stop');
    const eq = ctx.riskState && isNum(ctx.riskState.equity) ? ctx.riskState.equity : cfg.equity;
    const size = slOk && ctx.sizing ? ctx.sizing({ equity: eq, riskPct: cfg.riskPct, entry, sl, feePct: cfg.feePct, slipPct: cfg.slipPct, tps: [tp1, tp2].filter(isNum) }, ctx.filters) : null;
    const sizeOk = size && !size.errors.length && size.qty > 0;
    add('size', 'Position size valid for exchange filters', sizeOk, size ? (size.errors.length ? size.errors.join('; ') : `${size.qty} units · ${size.value.toFixed(2)} USDT · loss at SL ${size.netLoss.toFixed(2)} USDT (${size.riskPctActual.toFixed(2)}%)${size.warnings.length ? ' · ' + size.warnings.join('; ') : ''}`) : 'Needs a valid stop');
    // Phase 7.4: entry timing from the legacy engine (break age, distance from the break level in ATR(15M), TP1 already
    // touched, R:R at the current price). Only ON TIME passes; CHASING / LATE / TOO EARLY keep the plan as WATCH.
    const T = ctx.timing;
    if (cfg.requireTiming && plan) add('timing', 'Entry on time (not chasing, not late)', !!(T && T.label === 'ON TIME'), T ? `${T.label}: ${(T.reasons || []).join('; ')}${T.limit ? ` · retrace limit ${T.limit.price} (${T.limit.src}), net R:R ${isNum(T.limit.rr) ? T.limit.rr.toFixed(2) : '–'}` : ''}` : 'Timing not computable');
    // Phase 7: validation of the rules themselves. Only a statistically negative historical result (NO EDGE) blocks.
    if (ctx.validation && cfg.requireEdge) { const v = ctx.validation; add('edge', 'Rules not shown to lose in the latest historical test', v.code !== 'NO EDGE', `${v.code}: ${v.why}${v.at ? '' : ''}`); }
    const gate = riskGate(ctx.riskState, cfg, ctx.symbol, ctx.narrative, size && isNum(size.netLoss) ? size.netLoss : null);
    add('risk', 'Risk controls passed', gate.ok, gate.ok ? (gate.warn ? 'Passed with drawdown warning' : 'All risk controls passed') : gate.checks.filter((x) => x.level === 'BLOCK' && !x.pass).map((x) => x.name + ' — ' + x.detail).join('; '));

    const pass = Object.fromEntries(hard.map((h) => [h.id, h.pass]));
    let decision;
    if (hard.every((h) => h.pass)) decision = 'BUY';
    else if (pass.data && pass.liq && isNum(c.cis) && c.cis >= cfg.watchCIS && ctx.mtf && ['BULLISH CONFIRMED', 'DEVELOPING'].includes(ctx.mtf.verdict)) decision = 'WATCH';
    else decision = 'AVOID';
    const failed = hard.filter((h) => !h.pass);
    const m15 = q['15m'];
    const out = {
      symbol: ctx.symbol, narrative: ctx.narrative || null, decision, cis: isNum(c.cis) ? c.cis : null, cisClass: c.cls || null, cisQuality: c.quality || null,
      hard, failed: failed.map((h) => h.id), reason: decision === 'BUY' ? 'All hard filters passed' : failed.map((h) => h.name).join(' · '),
      signalAt: ctx.nowMs, candleAt: m15 && m15.lastClosedOpen ? m15.lastClosedOpen : null,
      dataQuality: dataOk ? 'VALID' : 'NOT USABLE', mtfVerdict: ctx.mtf ? ctx.mtf.verdict : null, risk: { drawdownPct: gate.drawdownPct, dailyLossPct: gate.dailyLossPct, heatPct: gate.heatPct, warn: gate.warn },
    };
    if (entry && sl) {
      out.plan = {
        symbol: ctx.symbol, narrative: ctx.narrative || null, cis: out.cis, entry, entryType: plan.entryType, stopLoss: sl, slPct, tp1, tp2,
        rrTP1: isNum(tp1) && ctx.rr ? ctx.rr(entry, sl, tp1, cfg.feePct, cfg.slipPct).net : null, rrTP2: isNum(tp2) && ctx.rr ? ctx.rr(entry, sl, tp2, cfg.feePct, cfg.slipPct).net : null,
        qty: sizeOk ? size.qty : null, notional: sizeOk ? size.value : null, riskAmount: sizeOk ? size.netLoss : null, riskPct: sizeOk ? size.riskPctActual : null,
        timeframe: 'H4 structure · H1 setup · M15 entry', setup: setupDescription(ctx), signalAt: ctx.nowMs, dataQuality: out.dataQuality,
        invalidation: invalidation(ctx, sl), targetsFrom: tps.slice(0, 2).map((x) => x.src),
        timing: T ? { label: T.label, reasons: T.reasons || [], limit: T.limit || null, distAtr: isNum(T.distAtr) ? T.distAtr : null, ageMin: isNum(T.ageMin) ? T.ageMin : null, price: isNum(T.price) ? T.price : null } : null,
      };
    }
    return out;
  }
  function setupDescription(ctx) {
    const st = (ctx.mtf && ctx.mtf.steps) || [], g = (tf) => st.find((s) => s.tf === tf) || {};
    const z = ctx.legacy && ctx.legacy.plan && ctx.legacy.plan.zone;
    return [`D1 ${(g('1d').state || '–').toLowerCase()}`, `H4 ${(g('4h').state || '–').toLowerCase()}`, `H1 ${(g('1h').state || '–').toLowerCase()} (${g('1h').why || ''})`, `M15 ${(g('15m').state || '–').toLowerCase()}`, z ? `zone ${z.src}` : null].filter(Boolean).join(' · ');
  }
  function invalidation(ctx, sl) {
    return [`Close below stop loss ${sl}`, 'H4 structure turns bearish (bearish BOS/CHoCH on a closed H4 candle)', 'M15 closes back below EMA21 before entry fills', 'Data becomes stale or the pair leaves the eligible universe'];
  }

  return { liveStatus, W, CLASSES, DEFAULT_CFG, TIER_RANK, normalizeCfg, riskScore, cis, cisClass, riskGate, evaluate };
})();

/* ==== PORTFOLIO ANALYTICS & TRADE JOURNAL (Phase 6) — pure functions ====
   Journal entries use the legacy JCOLS fields (symbol, status, setup, date, entry, sl, tp, qty, exitDate, exit, fees, note,
   reference, review) plus narrative, tp1, openedAt, closedAt and cisAtEntry. Statistics reuse CORE.journalStats / tradeCalc.
   The derived risk state replaces the manual account state once a starting equity is set. */
const PORT = (() => {
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const n = (x) => (x === '' || x == null ? null : Number(x));

  /* ---------- journal entries ---------- */
  const STATUSES = ['Planned', 'Open', 'Closed', 'Cancelled'];
  function validateEntry(t, CORE) {
    // legacy symbol rule rejects 1-letter and non-Latin bases that Binance lists; use the Phase 1 rule instead
    const errs = CORE.validateTrade(t).filter((e) => e !== 'symbol must be a USDT pair');
    if (!/^[\p{L}\p{N}]{1,30}USDT$/u.test(String(t.symbol || ''))) errs.unshift('symbol must be a USDT pair');
    const e = n(t.entry), s = n(t.sl), tp = n(t.tp), q = n(t.qty), x = n(t.exit);
    if (isNum(e) && isNum(s) && s > 0 && !(s < e)) errs.push('stop loss must be below entry (spot long-only)');
    if (isNum(e) && isNum(tp) && tp > 0 && !(tp > e)) errs.push('target must be above entry');
    if ((t.status === 'Open' || t.status === 'Closed') && !(e > 0 && q > 0)) errs.push('open and closed trades need entry and quantity');
    if (t.status === 'Closed' && isNum(t.openedAt) && isNum(t.closedAt) && t.closedAt < t.openedAt) errs.push('close time is before open time');
    if (t.status === 'Closed' && !(x > 0)) { if (!errs.includes('closed trades need an exit price')) errs.push('closed trades need an exit price'); }
    return errs;
  }
  // A Planned journal entry from a Phase 5 trading plan.
  function fromPlan(plan, signalId, nowMs) {
    return { symbol: plan.symbol, status: 'Planned', setup: plan.setup ? String(plan.setup).slice(0, 160) : 'CIS signal', narrative: plan.narrative || null, date: new Date(nowMs).toISOString().slice(0, 10),
      entry: plan.entry, sl: plan.stopLoss, tp1: plan.tp1 ?? null, tp: plan.tp2 ?? plan.tp1 ?? null, qty: plan.qty ?? null, fees: 0, cisAtEntry: plan.cis ?? null, reference: signalId || null, note: '', review: '', createdAt: nowMs };
  }

  /* ---------- open position view ---------- */
  function positionView(t, price, cfg) {
    const e = n(t.entry), s = n(t.sl), q = n(t.qty), fees = n(t.fees) || 0, cst = ((cfg.feePct || 0) + (cfg.slipPct || 0)) / 100;
    const riskAmt = e > 0 && s > 0 && q > 0 && s < e ? q * (e - s) + q * s * cst + fees : null;
    const value = price > 0 && q > 0 ? q * price : null;
    const unreal = price > 0 && e > 0 && q > 0 ? q * (price - e) - fees - q * price * cst : null;
    return { symbol: t.symbol, narrative: t.narrative || null, qty: q, entry: e, sl: s, tp: n(t.tp), price, value, cost: e > 0 && q > 0 ? e * q : null, unreal, riskAmt, rOpen: isNum(unreal) && riskAmt > 0 ? unreal / riskAmt : null, distToSlPct: price > 0 && s > 0 ? (price - s) / price * 100 : null };
  }

  /* ---------- correlation ---------- */
  function corr(a, b) {
    const k = Math.min(a.length, b.length); if (k < 10) return null;
    const x = a.slice(-k), y = b.slice(-k), mx = x.reduce((s, v) => s + v, 0) / k, my = y.reduce((s, v) => s + v, 0) / k;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < k; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
  }
  // closes: {symbol → [daily closes, oldest first]}; returns daily log-return correlations over the last `days` returns.
  function corrMatrix(closes, days = 30) {
    const syms = Object.keys(closes), rets = {};
    for (const s of syms) { const c = closes[s]; const r = []; for (let i = 1; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) r.push(Math.log(c[i] / c[i - 1])); rets[s] = r.slice(-days); }
    const m = {}; for (const a of syms) { m[a] = {}; for (const b of syms) m[a][b] = a === b ? 1 : corr(rets[a], rets[b]); }
    return m;
  }
  function correlatedExposure(positions, matrix, equity, thr = 0.7) {
    const flagged = positions.filter((p) => positions.some((o) => o.symbol !== p.symbol && matrix[p.symbol] && isNum(matrix[p.symbol][o.symbol]) && matrix[p.symbol][o.symbol] >= thr));
    const v = flagged.reduce((s, p) => s + (p.value || 0), 0);
    return { symbols: flagged.map((p) => p.symbol), value: v, pctEquity: equity > 0 ? v / equity * 100 : null, threshold: thr };
  }

  /* ---------- portfolio ---------- */
  // journal: entries; prices: {symbol → last}; settings: {startEquity}; dayStartMs: start of the viewer's current day.
  function portfolio(journal, prices, settings, cfg, CORE, dayStartMs) {
    const start = n(settings && settings.startEquity);
    const closed = journal.filter((t) => t.status === 'Closed').map((t) => Object.assign({}, t, CORE.tradeCalc(t))).filter((t) => isNum(t.pnl));
    closed.sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
    const realized = closed.reduce((s, t) => s + t.pnl, 0);
    const todayPnl = closed.filter((t) => isNum(t.closedAt) && t.closedAt >= dayStartMs).reduce((s, t) => s + t.pnl, 0);
    const open = journal.filter((t) => t.status === 'Open').map((t) => positionView(t, prices[t.symbol], cfg));
    const unreal = open.reduce((s, p) => s + (isNum(p.unreal) ? p.unreal : 0), 0), missingPx = open.filter((p) => !(p.price > 0)).map((p) => p.symbol);
    const equity = isNum(start) ? start + realized + unreal : null;
    // equity curve on closed trades (realized), then the current marked-to-market point
    let eq = isNum(start) ? start : 0, peak = eq, mdd = 0, mddPct = 0; const curve = [{ t: null, eq }];
    for (const t of closed) { eq += t.pnl; curve.push({ t: t.closedAt || null, eq, symbol: t.symbol, pnl: t.pnl }); peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); if (peak > 0) mddPct = Math.max(mddPct, (peak - eq) / peak * 100); }
    const peakEq = isNum(equity) ? Math.max(peak, equity) : peak;
    const curDD = isNum(equity) && peakEq > 0 ? (peakEq - equity) / peakEq * 100 : null;
    const exposure = open.reduce((s, p) => s + (p.value || 0), 0);
    const byN = {}; for (const p of open) { const k = p.narrative || 'OTHER'; byN[k] = (byN[k] || 0) + (p.value || 0); }
    const sector = Object.entries(byN).map(([k, v]) => ({ narrative: k, value: v, share: exposure > 0 ? v / exposure : null })).sort((a, b) => b.value - a.value);
    const hhi = exposure > 0 ? sector.reduce((s, x) => s + (x.share || 0) ** 2, 0) * 10000 : null;
    const stats = CORE.journalStats(journal, 20);
    return {
      startEquity: start, realized, unrealized: unreal, equity, todayPnl, peakEquity: peakEq, drawdownPct: curDD, maxDrawdown: mdd, maxDrawdownPct: mddPct, curve,
      open: open.map((p) => Object.assign(p, { allocPct: isNum(equity) && equity > 0 && p.value ? p.value / equity * 100 : null })), exposure, exposurePct: isNum(equity) && equity > 0 ? exposure / equity * 100 : null, cash: isNum(equity) ? equity - exposure : null,
      sector, sectorHHI: hhi, missingPrices: missingPx, stats, counts: Object.fromEntries(STATUSES.map((s) => [s, journal.filter((t) => t.status === s).length])),
    };
  }
  // Risk state for SIG.riskGate, derived from the journal (replaces manual entry once a starting equity is set).
  function riskState(pf) {
    if (!isNum(pf.startEquity)) return null;
    return { equity: pf.equity, peakEquity: pf.peakEquity, todayPnl: pf.todayPnl, open: pf.open.map((p) => ({ symbol: p.symbol, narrative: p.narrative, riskAmt: p.riskAmt })), source: 'journal' };
  }

  return { STATUSES, validateEntry, fromPlan, positionView, corr, corrMatrix, correlatedExposure, portfolio, riskState };
})();

/* ==== HISTORICAL TESTING, WALK-FORWARD VALIDATION & PAPER TRADING (Phase 7) — pure functions ====
   What can be replayed honestly: only the price-derived part of the system. Narrative, attention, wallet and on-chain
   history are not available point-in-time from free sources (CoinGecko categories and Etherscan samples are "now"),
   so the historical test replays the Phase 5 trade rules that come from prices alone:
     D1/H4/H1/M15 multi-timeframe verdict = BULLISH CONFIRMED (QUANT.mtf)
     + legacy SMC plan with a valid stop ≤ maxSlPct and net R:R ≥ minRR (CORE.signal)
     + optional Quant-score gate (0.4·D1 + 0.6·H4), the only CIS component that exists historically.
   Rules: closed candles only (every view uses candles whose close time ≤ the decision time); triggered plans fill at the
   next M15 open, limit plans when price reaches the entry within 24 h; net R:R is re-checked at the actual fill;
   exits on M15 candles with a stop hit first when stop and target fall in one candle (CORE.simulateExit),
   fees + slippage on both sides. Each candidate's exit is simulated independently, so position limits and gates
   can be applied afterwards without re-running the replay. */
const BT = (() => {
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const GRID = [null, 40, 50, 55, 60, 65, 70, 75];
  // Pre-declared rule variants (fixed before testing, to limit curve fitting). 'base' = the live Phase 5 rules.
  const VARIANTS = [
    { id: 'base', name: 'Live rules (auto stop, TP2)' },
    { id: 'zone', name: 'Stop below H1 zone', P: { slMode: 'zone' } },
    { id: 'zoneBuf', name: 'Stop below H1 zone + 0.5 ATR', P: { slMode: 'zone', slBufferAtr: 0.5 } },
    { id: 'floor1', name: 'Stop ≥ 1 ATR(1H)', stopFloorAtr: 1 },
    { id: 'floor1.5', name: 'Stop ≥ 1.5 ATR(1H)', stopFloorAtr: 1.5 },
    { id: 'floor1-TP1', name: 'Stop ≥ 1 ATR(1H), target TP1', stopFloorAtr: 1, P: { rrTarget: 'TP1' } },
    { id: 'floor1-partial', name: 'Stop ≥ 1 ATR(1H), half at TP1 then stop to entry', stopFloorAtr: 1, exitMode: 'partial' },
  ];

  /* ---------- candles ---------- */
  // Merge kline pages (any order), dedupe by open time, keep closed candles only.
  function mergePages(pages, nowMs) {
    const m = new Map();
    for (const p of pages) for (const k of p || []) if (Array.isArray(k) && k.length >= 7) m.set(+k[0], k);
    return [...m.values()].sort((a, b) => a[0] - b[0]).filter((k) => +k[6] < nowMs);
  }
  // Which [endTime] pages are needed to cover [fromMs, toMs] for a timeframe (1000 candles per page, newest first).
  function pagePlan(fromMs, toMs, tfMs, perPage = 1000) {
    const ends = []; let e = toMs;
    while (e > fromMs && ends.length < 60) { ends.push(e); e -= perPage * tfMs; }
    return ends;
  }

  /* ---------- replay ---------- */
  // series: {'1d','4h','1h','15m': normalized closed candles}; btc: same shape for BTCUSDT (relative strength) or null.
  // opts: {startT, endT, P (CORE params with feePct, slipPct, minRR, maxSlPct, rrTarget), window, maxBars, filters}
  function createReplay(series, btc, opts, CORE, QUANT) {
    const P = opts.P || CORE.DEFAULT_PARAMS, W = opts.window || 300, maxBars = opts.maxBars || 672, limitBars = opts.limitBars || 96;
    const m15 = series['15m'], startT = opts.startT || 0, endT = opts.endT || Infinity;
    let i = m15.findIndex((k) => k.ct >= startT); if (i < 0) i = m15.length; i = Math.max(i, W);
    const startIdx = i, ptr = { '1d': 0, '4h': 0, '1h': 0 }, cnt = {}, cache = {};
    const funnel = { steps: 0, noData: 0, macroOrH4: 0, noSetup: 0, noEntry: 0, confirmed: 0 };
    const variants = opts.variants && opts.variants.length ? opts.variants : [{ id: 'base' }];
    const vP = {}, vfun = {}, vseen = {};
    for (const v of variants) { vP[v.id] = Object.assign({}, P, v.P || {}); vfun[v.id] = { noPlan: 0, badStop: 0, lowRR: 0, gapInvalid: 0, limitNotFilled: 0, rrAtFill: 0, late: 0, stoppedBefore: 0, candidates: 0 }; vseen[v.id] = new Set(); }
    const cands = [];
    function view(tf, t) {
      const arr = series[tf]; let p = ptr[tf];
      while (p < arr.length && arr[p].ct <= t) p++;
      ptr[tf] = p;
      if (cnt[tf] !== p) { cnt[tf] = p; const sl = arr.slice(Math.max(0, p - W), p); cache[tf] = p >= P.minCandles ? QUANT.analyze(sl, tf, CORE, btc && btc[tf]) : { ok: false }; }
      return cache[tf];
    }
    return {
      get total() { return m15.length - startIdx; },
      get done() { return i >= m15.length || m15[i].ct > endT; },
      get progress() { return Math.min(1, (i - startIdx) / Math.max(1, m15.length - startIdx)); },
      step(n) {
        for (let s = 0; s < n && i < m15.length && m15[i].ct <= endT; s++, i++) {
          const t = m15[i].ct; funnel.steps++;
          const d = view('1d', t), h4 = view('4h', t), h1 = view('1h', t);
          if (!d.ok || !h4.ok || !h1.ok) { funnel.noData++; continue; }
          // cheap pre-checks that QUANT.mtf would also fail (identical outcome, skips the M15 analysis)
          const pre = QUANT.mtf({ '1d': d, '4h': h4, '1h': h1, '15m': { ok: true, lastEvent: null, cross: {}, close: 0, ind: {} } });
          if (!pre.steps[0].pass || !pre.steps[1].pass) { funnel.macroOrH4++; continue; }
          if (!pre.steps[2].pass) { funnel.noSetup++; continue; }
          const m = QUANT.analyze(m15.slice(i + 1 - W, i + 1), '15m', CORE, btc && btc['15m']);
          const mt = QUANT.mtf({ '1d': d, '4h': h4, '1h': h1, '15m': m });
          if (mt.verdict !== 'BULLISH CONFIRMED') { funnel.noEntry++; continue; }
          funnel.confirmed++;
          if (i + 1 >= m15.length) continue;
          for (const v of variants) {
            const VP = vP[v.id], vf = vfun[v.id], seenV = vseen[v.id], refIdx = { TP1: 0, TP2: 1, TP3: 2 }[VP.rrTarget] ?? 1;
            const sig = CORE.signal({ d: d._A, h4: h4._A, h1: h1._A, m15: m._A }, m15[i].c, VP, opts.filters || null);
            const p = sig && sig.plan;
            if (!p || !isNum(p.sl)) { vf.noPlan++; continue; }
            let sl = p.sl, slWhy = p.slBasis || '';
            // optional stop floor: never closer than k × ATR(1H) below the planned entry
            const a1 = h1.ind && h1.ind.atr;
            if (v.stopFloorAtr && isNum(a1) && sl > p.entry - v.stopFloorAtr * a1) { sl = p.entry - v.stopFloorAtr * a1; slWhy = `floor ${v.stopFloorAtr}×ATR(1H)`; }
            if (!(sl < p.entry) || (p.entry - sl) / p.entry * 100 > VP.maxSlPct) { vf.badStop++; continue; }
            const tps = p.tps || [], tpRef = tps[Math.min(refIdx, tps.length - 1)], tp1 = tps[0] && tps[0].price;
            const rrPlan = tpRef ? CORE.rr(p.entry, sl, tpRef.price, VP.feePct, VP.slipPct) : null;
            if (!rrPlan || !(rrPlan.net >= VP.minRR)) { vf.lowRR++; continue; }
            const key = p.trigT != null ? 'T' + p.trigT : 'Z' + (p.zone ? p.zone.t : t);
            if (seenV.has(key)) continue; // same trigger already produced a candidate
            // Triggered plans fill at the next M15 open; limit plans (entry at the zone top, no M15 trigger yet) fill only
            // when price trades down to the entry within limitBars, at the better of entry and the candle open.
            // Phase 7.4 — latency and timing. v.delayBars: the trader acts dI = i + delayBars M15 bars after the signal
            // (a late evaluation). v.timing: a triggered (market) plan is taken only if, at the decision bar, the break is
            // < triggerBars old, price is ≤ chaseAtr × ATR(15M) above the break level, TP1 was not touched and net R:R at
            // that price ≥ minRR — the same rules as CORE.entryTiming 'ON TIME'. Limit plans wait for a retrace anyway.
            const dI = i + (v.delayBars || 0);
            if (dI + 1 >= m15.length) continue;
            if (dI > i) { let hit = false; for (let j = i + 1; j <= dI; j++) if (m15[j].l <= sl) { hit = true; break; } if (hit) { seenV.add(key); vf.stoppedBefore++; continue; } }
            if (p.trigT != null && v.timing) {
              const A = m._A, ev = (A.events || []).find((e) => e.t === p.trigT), off = i + 1 - Math.min(W, i + 1);
              const gi = ev ? off + ev.i : null, a15 = A.atrLast, px = m15[dI].c;
              let maxH = -Infinity; if (gi != null) for (let j = gi + 1; j <= dI; j++) maxH = Math.max(maxH, m15[j].h);
              const dist = ev && a15 ? (px - ev.level) / a15 : null, rrNow = px > sl ? CORE.rr(px, sl, tpRef.price, VP.feePct, VP.slipPct).net : null;
              const onTime = gi != null && dI - gi < VP.triggerBars && !(tp1 && maxH >= tp1) && !(dist != null && dist > VP.chaseAtr) && rrNow != null && rrNow >= VP.minRR;
              if (!onTime) { seenV.add(key); vf.late++; continue; }
            }
            let fi = -1, entry = null;
            if (p.trigT != null) { fi = dI + 1; entry = m15[fi].o; }
            else for (let j = dI + 1; j < m15.length && j <= dI + limitBars; j++) { const k = m15[j]; if (k.o <= sl) break; if (k.l <= p.entry) { fi = j; entry = Math.min(p.entry, k.o); break; } }
            seenV.add(key);
            if (fi < 0) { vf.limitNotFilled++; continue; }
            if (!(entry > sl) || !(tpRef.price > entry)) { vf.gapInvalid++; continue; }
            const rrFill = CORE.rr(entry, sl, tpRef.price, VP.feePct, VP.slipPct);
            if (!(rrFill.net >= VP.minRR)) { vf.rrAtFill++; continue; } // the fill moved R:R below the minimum: the plan would not be taken
            const mode = v.exitMode === 'partial' && tp1 > entry && tp1 < tpRef.price ? 'partial' : 'single';
            const ex = CORE.simulateExit(m15, fi, { entry, sl, tp1, tp2: tpRef.price, mode, maxBars, feePct: VP.feePct, slipPct: VP.slipPct });
            if (!ex) continue;
            vf.candidates++;
            cands.push({ variant: v.id, signalT: t, entryT: m15[fi].t, kind: p.trigT != null ? 'MARKET' : 'LIMIT', planEntry: p.entry, entry, sl, slWhy, tp: tpRef.price, planRR: rrPlan.net, fillRR: rrFill.net, quant: isNum(mt.quant) ? mt.quant : null, qD1: d.quant.score, qH4: h4.quant.score,
              setup: (mt.steps[2] && mt.steps[2].state) || '', zone: p.zone ? p.zone.src : null, atrPctD1: d.ind.atrPct, exitT: ex.exitT, exitPx: ex.exitPx, reason: ex.reason, r: ex.r, open: !!ex.open });
          }
        }
      },
      result() { const v0 = variants[0].id; return { cands: variants.length === 1 ? cands : cands, funnel: Object.assign({}, funnel, vfun[v0]), byVariant: vfun, from: m15[startIdx] && m15[startIdx].t, to: m15[Math.min(i, m15.length) - 1] && m15[Math.min(i, m15.length) - 1].ct, bars: i - startIdx }; },
    };
  }

  /* ---------- statistics ---------- */
  function stats(rs) {
    const n = rs.length; if (!n) return { n: 0 };
    const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
    const sum = rs.reduce((a, b) => a + b, 0), mean = sum / n;
    const sd = n > 1 ? Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1)) : null;
    let eq = 0, peak = 0, mdd = 0; for (const r of rs) { eq += r; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); }
    const gp = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
    return { n, winRate: wins.length / n, avgR: mean, totalR: sum, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : null, maxDDR: mdd, sd, tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : null, avgWin: wins.length ? gp / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null };
  }

  /* ---------- portfolio simulation over candidates ---------- */
  // cands: [{symbol, entryT, exitT, r, quant, open}] from several symbols. Takes a candidate only if it passes the gate,
  // its symbol is flat and fewer than maxOpen positions are open. Open (unfinished) trades are excluded from statistics.
  function simulate(cands, { minQuant = null, maxOpen = 5, riskPct = 1, from = -Infinity, to = Infinity } = {}) {
    const list = cands.filter((c) => c.entryT >= from && c.entryT < to && (minQuant == null || (isNum(c.quant) && c.quant >= minQuant))).sort((a, b) => a.entryT - b.entryT || String(a.symbol).localeCompare(String(b.symbol)));
    const openPos = []; const taken = []; let skippedBusy = 0, skippedMax = 0;
    for (const c of list) {
      for (let k = openPos.length - 1; k >= 0; k--) if (openPos[k].exitT <= c.entryT) openPos.splice(k, 1);
      if (openPos.some((p) => p.symbol === c.symbol)) { skippedBusy++; continue; }
      if (openPos.length >= maxOpen) { skippedMax++; continue; }
      openPos.push(c); taken.push(c);
    }
    const closed = taken.filter((c) => !c.open);
    const st = stats(closed.map((c) => c.r));
    let eq = 1; const curve = [];
    for (const c of closed.slice().sort((a, b) => a.exitT - b.exitT)) { eq *= 1 + riskPct / 100 * c.r; curve.push({ t: c.exitT, eq, r: c.r }); }
    return Object.assign(st, { taken, closed: closed.length, stillOpen: taken.length - closed.length, skippedBusy, skippedMax, compoundPct: (eq - 1) * 100, curve });
  }
  function gateTable(cands, opts) { return GRID.map((g) => Object.assign({ minQuant: g }, simulate(cands, Object.assign({}, opts, { minQuant: g })))); }

  /* ---------- walk-forward ---------- */
  // Anchored walk-forward: the period is cut into (folds + 1) equal time blocks; for fold k the Quant gate is chosen on
  // blocks 0..k (in-sample, by total R with at least minTrain trades) and applied unchanged to block k+1 (out-of-sample).
  // Variants: candidates carry a `variant` id; each fold chooses the (variant, gate) pair on in-sample data only.
  // With allowFlat, a fold whose best in-sample total R is not positive stands aside (no trades out-of-sample).
  function walkForward(cands, { from, to, folds = 4, minTrain = 8, maxOpen = 5, riskPct = 1, grid = GRID, variants = null, allowFlat = false } = {}) {
    const span = (to - from) / (folds + 1), out = [], oos = [];
    const vids = variants && variants.length ? variants : [null];
    const pick = (v) => (v == null ? cands : cands.filter((c) => c.variant === v));
    for (let k = 0; k < folds; k++) {
      const isTo = from + span * (k + 1), osTo = from + span * (k + 2);
      let best = null;
      for (const v of vids) for (const g of grid) {
        const s = simulate(pick(v), { minQuant: g, maxOpen, riskPct, from, to: isTo });
        if (s.n >= minTrain && (!best || s.totalR > best.s.totalR + 1e-12)) best = { v, g, s };
      }
      const flat = allowFlat && best && !(best.s.totalR > 0);
      const chosen = best ? best.g : null, chosenVariant = best ? best.v : vids[0];
      const os = flat ? simulate([], {}) : simulate(pick(chosenVariant), { minQuant: chosen, maxOpen, riskPct, from: isTo, to: osTo });
      out.push({ fold: k + 1, isFrom: from, isTo, osFrom: isTo, osTo, chosen, chosenVariant, flat, chosenFrom: best ? (flat ? 'stand aside: best in-sample total R ≤ 0' : 'in-sample') : 'default (too few in-sample trades)', is: best ? summary(best.s) : summary(simulate(pick(chosenVariant), { minQuant: null, maxOpen, riskPct, from, to: isTo })), os: summary(os) });
      for (const c of os.taken || []) if (!c.open) oos.push(c);
    }
    const agg = stats(oos.sort((a, b) => a.exitT - b.exitT).map((c) => c.r));
    const isAvg = out.filter((f) => isNum(f.is.avgR)).map((f) => f.is.avgR), meanIS = isAvg.length ? isAvg.reduce((a, b) => a + b, 0) / isAvg.length : null;
    const wfe = isNum(meanIS) && meanIS > 0 && isNum(agg.avgR) ? agg.avgR / meanIS : null;
    const flatFolds = out.filter((f) => f.flat).length;
    const vd = flatFolds === out.length && out.length ? { code: 'STANDS ASIDE', why: 'No variant and gate was profitable on any in-sample block, so the walk-forward never traded' } : verdict(agg, wfe);
    return { folds: out, oos: agg, oosTrades: oos, wfe, flatFolds, verdict: vd };
  }
  const summary = (s) => ({ n: s.n, winRate: s.winRate ?? null, avgR: s.avgR ?? null, totalR: s.totalR ?? null, pf: s.pf ?? null, maxDDR: s.maxDDR ?? null, tStat: s.tStat ?? null });
  // Conservative reading of the out-of-sample result.
  function verdict(oos, wfe, lab = 'Out-of-sample') {
    const l = lab.toLowerCase();
    if (!oos.n || oos.n < 30) return { code: 'NOT PROVEN', why: `Only ${oos.n || 0} ${l} trades; at least 30 are needed before any conclusion` };
    if (!(oos.avgR > 0)) return { code: 'NO EDGE', why: `${lab} expectancy ${oos.avgR.toFixed(3)} R per trade over ${oos.n} trades is not positive (t = ${isNum(oos.tStat) ? oos.tStat.toFixed(2) : '–'})` };
    if (!(oos.tStat >= 2)) return { code: 'NOT SIGNIFICANT', why: `Positive ${l} expectancy (${oos.avgR.toFixed(3)} R) but t = ${isNum(oos.tStat) ? oos.tStat.toFixed(2) : '–'} < 2: could be chance` };
    if (isNum(wfe) && wfe < 0.5) return { code: 'DEGRADES', why: `Out-of-sample keeps only ${(wfe * 100).toFixed(0)}% of the in-sample expectancy` };
    return { code: 'PASSES', why: `${lab} expectancy ${oos.avgR.toFixed(3)} R over ${oos.n} trades, t = ${oos.tStat.toFixed(2)}` };
  }

  /* ---------- paper trading ---------- */
  // A paper trade from a Phase 5 trading plan. Market plans fill at the first M15 open after the signal candle closes;
  // limit plans fill when price trades down to the entry within `expiryBars` M15 candles.
  function paperFromPlan(ev, nowMs, { expiryBars = 96 } = {}) {
    const p = ev.plan; if (!p || !(p.stopLoss < p.entry)) return null;
    const tp = isNum(p.tp2) ? p.tp2 : p.tp1; if (!(tp > p.entry)) return null;
    const market = /^market/i.test(p.entryType || '');
    const ref = ev.candleAt != null ? ev.candleAt : Math.floor(nowMs / 9e5) * 9e5 - 9e5;
    return { symbol: ev.symbol, cohort: ev.decision, narrative: p.narrative || null, cis: p.cis ?? null, signalAt: ev.signalAt || nowMs, candleAt: ref,
      fillAfter: ref + 9e5, kind: market ? 'MARKET' : 'LIMIT', planEntry: p.entry, sl: p.stopLoss, tp, tp1: p.tp1 ?? null, planRR: p.rrTP2 ?? p.rrTP1 ?? null,
      expiresAt: ref + 9e5 * (expiryBars + 1), status: 'PENDING', createdAt: nowMs };
  }
  // m15: closed M15 candles (ascending). Pure: the same candles always give the same state.
  function paperUpdate(tr, m15, { feePct = 0.1, slipPct = 0.05, maxBars = 672 } = {}) {
    if (tr.status === 'CLOSED' || tr.status === 'EXPIRED' || tr.status === 'INVALID') return tr;
    const out = Object.assign({}, tr);
    const after = m15.filter((k) => k.t >= tr.fillAfter);
    if (!after.length) return out;
    let fi = -1, fill = null;
    if (tr.kind === 'MARKET') { fi = 0; fill = after[0].o; }
    else for (let j = 0; j < after.length; j++) {
      const k = after[j]; if (k.t >= tr.expiresAt) break;
      if (k.l <= tr.sl && k.o <= tr.sl) { out.status = 'INVALID'; out.why = 'Opened below the stop before the entry filled'; out.updatedAt = k.ct; return out; }
      if (k.l <= tr.planEntry) { fi = j; fill = Math.min(tr.planEntry, k.o); break; }
    }
    if (fi < 0) { if (after[after.length - 1].ct >= tr.expiresAt - 1) { out.status = 'EXPIRED'; out.why = 'Entry not reached before expiry'; out.updatedAt = tr.expiresAt; } return out; }
    if (!(fill > tr.sl)) { out.status = 'INVALID'; out.why = 'Fill at or below the stop'; out.updatedAt = after[fi].ct; return out; }
    out.entry = fill; out.entryT = after[fi].t;
    const ex = CORE_simulate(after, fi, { entry: fill, sl: tr.sl, tp1: tr.tp1, tp2: tr.tp, mode: 'single', maxBars, feePct, slipPct });
    if (!ex) { out.status = 'OPEN'; return out; }
    if (ex.open) { out.status = 'OPEN'; out.markPx = ex.exitPx; out.markR = ex.r; out.updatedAt = ex.exitT; return out; }
    Object.assign(out, { status: 'CLOSED', exit: ex.exitPx, exitT: ex.exitT, reason: ex.reason, r: ex.r, updatedAt: ex.exitT });
    return out;
  }
  let CORE_simulate = null; // bound to CORE.simulateExit by bind()
  function bind(CORE) { CORE_simulate = CORE.simulateExit; return API; }
  function paperStats(trades) {
    const by = {};
    for (const t of trades) { const k = t.cohort || 'OTHER'; (by[k] = by[k] || []).push(t); }
    const res = {};
    for (const [k, list] of Object.entries(by)) {
      const closed = list.filter((t) => t.status === 'CLOSED' && isNum(t.r)).sort((a, b) => a.exitT - b.exitT);
      res[k] = Object.assign(stats(closed.map((t) => t.r)), { total: list.length, pending: list.filter((t) => t.status === 'PENDING').length, open: list.filter((t) => t.status === 'OPEN').length, expired: list.filter((t) => t.status === 'EXPIRED' || t.status === 'INVALID').length });
    }
    return res;
  }


  /* ---------- signal outcomes (what happened after each decision) ---------- */
  // One record per decision episode: the first evaluation of each unbroken run of the same decision per pair.
  function episodes(signals) {
    const by = {};
    for (const x of signals) if (x && x.symbol && x.decision && x.candleAt != null) (by[x.symbol] = by[x.symbol] || []).push(x);
    const out = [];
    for (const list of Object.values(by)) {
      list.sort((a, b) => a.candleAt - b.candleAt);
      let prev = null;
      for (const x of list) { if (!prev || prev.decision !== x.decision || x.candleAt - prev.candleAt > 6 * 36e5) out.push(x); prev = x; }
    }
    return out.sort((a, b) => b.candleAt - a.candleAt);
  }
  // m15: closed M15 candles starting at the decision candle. Reference = close of the decision candle (the price the
  // decision saw). Returns are measured at +1/+3/+7 days; a horizon not yet reached stays null (never extrapolated).
  const HZ = { d1: 96, d3: 288, d7: 672 };
  function outcome(m15, refT) {
    const k0 = m15.findIndex((k) => k.t === refT); if (k0 < 0) return null;
    const ref = m15[k0].c, after = m15.slice(k0 + 1), o = { ref, bars: after.length };
    for (const [h, n] of Object.entries(HZ)) {
      if (after.length < n) { o[h] = null; continue; }
      const w = after.slice(0, n);
      o[h] = { ret: (w[n - 1].c / ref - 1) * 100, up: (Math.max(...w.map((x) => x.h)) / ref - 1) * 100, dn: (Math.min(...w.map((x) => x.l)) / ref - 1) * 100 };
    }
    if (after.length) o.sofar = { ret: (after[after.length - 1].c / ref - 1) * 100, up: (Math.max(...after.map((x) => x.h)) / ref - 1) * 100, dn: (Math.min(...after.map((x) => x.l)) / ref - 1) * 100 };
    o.complete = after.length >= HZ.d7;
    return o;
  }
  function outcomeStats(rows) {
    const res = {};
    for (const dec of ['BUY', 'WATCH', 'AVOID']) {
      const list = rows.filter((r) => r.decision === dec && r.outcome);
      const h = {};
      for (const k of ['d1', 'd3', 'd7']) {
        const v = list.map((r) => r.outcome[k]).filter(Boolean);
        h[k] = v.length ? { n: v.length, avgRet: v.reduce((a, x) => a + x.ret, 0) / v.length, medRet: v.map((x) => x.ret).sort((a, b) => a - b)[v.length >> 1], up5: v.filter((x) => x.up >= 5).length / v.length, up10: v.filter((x) => x.up >= 10).length / v.length, dn5: v.filter((x) => x.dn <= -5).length / v.length } : { n: 0 };
      }
      res[dec] = { episodes: list.length, ...h };
    }
    return res;
  }

  const API = { GRID, VARIANTS, episodes, outcome, outcomeStats, mergePages, pagePlan, createReplay, stats, simulate, gateTable, walkForward, verdict, paperFromPlan, paperUpdate, paperStats, bind };
  return API;
})();

/* ==== ENTRY HYPOTHESES (Phase 7.2) — pure functions ====
   Three alternative long-entry rules, written down before testing, each grounded in a known market effect:
     BREAKOUT  — H4 close above the prior 20-bar high on above-average volume, with D1 above EMA200 (momentum/breakout).
     PULLBACK  — H4 pullback to EMA21 inside an established uptrend (D1 close > EMA50 > EMA200, H4 EMA21 > EMA50,
                 ADX ≥ 20 with +DI > −DI), closing back above EMA21 as a bullish candle (trend continuation).
     RS_LEADER — pairs beating BTC by ≥ 5% over 20 days and above D1 EMA50, entering on an H1 EMA13×21 bullish cross
                 with H1 close above EMA50 (cross-sectional relative strength).
   Common rules: decisions on closed candles only (indicators are causal, computed over the whole series but read at the
   last closed bar ≤ decision time); market entry at the next M15 open; target at net R:R = minRR after fees and
   slippage; stop ≤ maxSlPct; exits on M15 with the stop first when both fall in one candle; time exit after maxBars. */
const ENT = (() => {
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const RULES = [
    { id: 'BREAKOUT', name: 'H4 20-bar breakout on volume, D1 above EMA200', tf: '4h' },
    { id: 'PULLBACK', name: 'H4 pullback to EMA21 in a D1 + H4 uptrend', tf: '4h' },
    { id: 'RS_LEADER', name: 'Relative-strength leader, H1 EMA13×21 cross', tf: '1h' },
    // Phase 7.3 — early reversal: enter on the first bullish H4 change of character while D1 is still not bullish
    { id: 'REVERSAL', name: 'Early reversal: H4 bullish CHoCH/MSS while D1 not bullish', tf: '4h', structural: true },
    { id: 'REVERSAL_VOL', name: 'Early reversal on volume (H4 CHoCH/MSS, volume ≥ 1.5× average)', tf: '4h', structural: true },
    // Phase 7.5 — intraday momentum burst, decided at every M15 close (written before testing):
    //   price +5% or more over the last 4 closed M15 candles (1 hour), quote volume of those 4 candles ≥ 3× the
    //   average 4-candle volume of the previous 24 hours, close in the top 30% of the hour's range.
    //   Stop below the hour's low (− 0.25 × ATR(15M)), up to 12% (bursts are wide); one signal per pair per 4 hours;
    //   time exit after 24 hours.
    { id: 'MOMENTUM', name: 'M15 momentum burst: +5% in 1 h on ≥ 3× volume', tf: '15m', maxSl: 12, maxBars: 96 },
    { id: 'MOMENTUM_TREND', name: 'Momentum burst with D1 close above EMA50', tf: '15m', maxSl: 12, maxBars: 96 },
    { id: 'MOMENTUM_1R', name: 'Momentum burst, 1R target (hit-rate check)', tf: '15m', maxSl: 12, maxBars: 96, rr: 1 },
  ];
  // Momentum burst test at M15 index q (pure; shared by the replay and the live alarm).
  function burst(m, q) {
    if (q < 100) return null;
    const a = m.a, c = a[q].c, c4 = a[q - 4].c; if (!(c4 > 0)) return null;
    const ret = c / c4 - 1; if (ret < 0.05) return null;
    let v4 = 0, hi = -Infinity, lo = Infinity; for (let k = q - 3; k <= q; k++) { v4 += m.qv[k]; hi = Math.max(hi, a[k].h); lo = Math.min(lo, a[k].l); }
    let vb = 0; for (let k = q - 99; k <= q - 4; k++) vb += m.qv[k]; vb = vb / 96 * 4;
    const volX = vb > 0 ? v4 / vb : null; if (!(volX >= 3)) return null;
    const pos = hi > lo ? (c - lo) / (hi - lo) : 0; if (pos < 0.7) return null;
    const atr = m.atr[q]; if (!isNum(atr)) return null;
    return { ret, volX, pos, lo, hi, sl: lo - 0.25 * atr };
  }
  // Target price whose net R:R (after costs on both sides) equals `rr`.
  function targetFor(e, s, rr, feePct, slipPct) {
    const c = (feePct + slipPct) / 100, netRisk = e - s + e * c + s * c;
    return (rr * netRisk + e * (1 + c)) / (1 - c);
  }
  // Causal indicator arrays for one timeframe.
  function prep(a, CORE, QUANT) {
    const c = a.map((x) => x.c), qv = a.map((x) => (isNum(x.qv) ? x.qv : x.v * x.c));
    const D = QUANT.adx(a.map((x) => x.h), a.map((x) => x.l), c, 14);
    const hh20 = a.map((_, i) => { if (i < 20) return null; let m = -Infinity; for (let k = i - 20; k < i; k++) m = Math.max(m, a[k].h); return m; });
    return { a, e13: CORE.ema(c, 13), e21: CORE.ema(c, 21), e50: CORE.ema(c, 50), e200: CORE.ema(c, 200), atr: CORE.atr(a, 14), adx: D.adx, pdi: D.pdi, mdi: D.mdi, qvS: CORE.sma(qv, 20), qv, hh20 };
  }
  // Index of the last bar with close time ≤ t (pointer advances monotonically).
  function cursor(arr) { let p = -1; return (t) => { while (p + 1 < arr.length && arr[p + 1].ct <= t) p++; return p; }; }

  // Returns the candidate (stop, signal description) or null for one rule at one decision time.
  function evaluateRule(id, X, idx, btcD, btcIdx, P) {
    const d = X['1d'], h4 = X['4h'], h1 = X['1h'], i = idx['1d'], j = idx['4h'], k = idx['1h'];
    if (i < 1 || j < 25 || k < 25) return null;
    const D1 = d.a[i];
    if (id === 'MOMENTUM' || id === 'MOMENTUM_TREND' || id === 'MOMENTUM_1R') {
      const b = burst(X['15m'], idx['15m']); if (!b) return null;
      if (id === 'MOMENTUM_TREND' && !(isNum(d.e50[i]) && D1.c > d.e50[i])) return null;
      return { sl: b.sl, why: `+${(b.ret * 100).toFixed(1)}% in 1 h on ${b.volX.toFixed(1)}× volume, close at ${(b.pos * 100).toFixed(0)}% of the range` };
    }
    if (id === 'BREAKOUT') {
      const b = h4.a[j];
      if (!(isNum(d.e200[i]) && D1.c > d.e200[i])) return null;
      if (!(isNum(h4.hh20[j]) && b.c > h4.hh20[j])) return null;
      if (!(isNum(h4.qvS[j - 1]) && h4.qv[j] > 1.5 * h4.qvS[j - 1])) return null;
      const atr = h4.atr[j]; if (!isNum(atr)) return null;
      return { sl: Math.min(b.l, b.c - 1.5 * atr), why: `H4 close ${b.c} > 20-bar high ${h4.hh20[j]}, volume ${(h4.qv[j] / h4.qvS[j - 1]).toFixed(2)}×` };
    }
    if (id === 'PULLBACK') {
      const b = h4.a[j];
      if (!(isNum(d.e200[i]) && D1.c > d.e50[i] && d.e50[i] > d.e200[i])) return null;
      if (!(isNum(h4.e50[j]) && h4.e21[j] > h4.e50[j])) return null;
      if (!(isNum(h4.adx[j]) && h4.adx[j] >= 20 && h4.pdi[j] > h4.mdi[j])) return null;
      if (!(b.l <= h4.e21[j] && b.c > h4.e21[j] && b.c > b.o)) return null;
      const atr = h4.atr[j]; if (!isNum(atr)) return null;
      let lo = Infinity; for (let q = j - 4; q <= j; q++) lo = Math.min(lo, h4.a[q].l);
      return { sl: lo - 0.25 * atr, why: `H4 tagged EMA21 ${h4.e21[j].toPrecision(6)} and closed above it; ADX ${h4.adx[j].toFixed(1)}` };
    }
    if (id === 'REVERSAL' || id === 'REVERSAL_VOL') {
      const S4 = X.struct; if (!S4 || !S4.h4 || !S4.h4.ok || !S4.d1 || !S4.d1.ok) return null;
      if (S4.d1Bull) return null; // D1 already bullish: the live rules handle it
      const ev = S4.h4.lastEvent; if (!(ev && ev.dir === 'bull' && (ev.type === 'CHoCH' || ev.type === 'MSS') && ev.barsAgo === 0)) return null;
      if (id === 'REVERSAL_VOL' && !(isNum(h4.qvS[j - 1]) && h4.qv[j] >= 1.5 * h4.qvS[j - 1])) return null;
      const atr = h4.atr[j]; if (!isNum(atr)) return null;
      let lo = Infinity; for (let q = Math.max(0, j - 9); q <= j; q++) lo = Math.min(lo, h4.a[q].l);
      return { sl: lo - 0.25 * atr, why: `H4 bullish ${ev.type} above ${ev.level}; D1 not bullish` };
    }
    if (id === 'RS_LEADER') {
      if (!btcD || btcIdx < 20 || i < 20) return null;
      const rs = (D1.c / d.a[i - 20].c - btcD.a[btcIdx].c / btcD.a[btcIdx - 20].c) * 100;
      if (!(rs >= 5 && isNum(d.e50[i]) && D1.c > d.e50[i])) return null;
      const b = h1.a[k];
      if (!(isNum(h1.e50[k]) && h1.e13[k] > h1.e21[k] && h1.e13[k - 1] <= h1.e21[k - 1] && b.c > h1.e50[k])) return null;
      const atr = h1.atr[k]; if (!isNum(atr)) return null;
      return { sl: b.c - 2 * atr, why: `RS vs BTC +${rs.toFixed(1)}% over 20 days; H1 EMA13 crossed above EMA21` };
    }
    return null;
  }

  // Replays the rules over history. series/btc: {'1d','4h','1h','15m'} closed candles. Decisions at every H1 close
  // (H4 rules only when that H1 close is also an H4 close).
  function replay(series, btc, { startT = 0, endT = Infinity, rules = RULES.map((r) => r.id), P, maxBars = 672 } = {}, CORE, QUANT) {
    const X = { '1d': prep(series['1d'], CORE, QUANT), '4h': prep(series['4h'], CORE, QUANT), '1h': prep(series['1h'], CORE, QUANT) };
    const r15 = rules.filter((r) => (RULES.find((x) => x.id === r) || {}).tf === '15m');
    if (r15.length) X['15m'] = prep(series['15m'], CORE, QUANT);
    const B = btc ? prep(btc['1d'], CORE, QUANT) : X['1d'];
    const cur = { '1d': cursor(series['1d']), '4h': cursor(series['4h']), '1h': cursor(series['1h']) }, cb = cursor(B.a);
    const m15 = series['15m'], m15ByT = new Map(m15.map((x, q) => [x.t, q]));
    const cands = [], funnel = Object.fromEntries(rules.map((r) => [r, { signals: 0, badStop: 0, noFill: 0, candidates: 0 }]));
    const needStruct = rules.some((r) => (RULES.find((x) => x.id === r) || {}).structural), dCache = { i: -1, a: null };
    // M15 rules: decided at every M15 close, market entry at the next M15 open, one signal per rule per 4 hours.
    if (r15.length) {
      const c1d = cursor(series['1d']), c4h = cursor(series['4h']), c1h = cursor(series['1h']), last = {};
      for (let q = 0; q + 1 < m15.length; q++) {
        const t = m15[q].ct; if (t < startT || t > endT) continue;
        const idx = { '1d': c1d(t), '4h': c4h(t), '1h': c1h(t), '15m': q };
        for (const id of r15) {
          if (last[id] != null && q - last[id] < 16) continue;
          const rule = RULES.find((r) => r.id === id), s = evaluateRule(id, X, idx, null, 0, P); if (!s) continue;
          funnel[id].signals++; last[id] = q;
          const fi = q + 1, entry = m15[fi].o, sl = s.sl, cap = rule.maxSl || P.maxSlPct;
          if (!(sl > 0 && sl < entry) || (entry - sl) / entry * 100 > cap) { funnel[id].badStop++; continue; }
          const rr = rule.rr || P.minRR, tp = targetFor(entry, sl, rr, P.feePct, P.slipPct);
          const ex = CORE.simulateExit(m15, fi, { entry, sl, tp1: tp, tp2: tp, mode: 'single', maxBars: rule.maxBars || maxBars, feePct: P.feePct, slipPct: P.slipPct });
          if (!ex) continue;
          funnel[id].candidates++;
          cands.push({ variant: id, signalT: t, entryT: m15[fi].t, kind: 'MARKET', planEntry: entry, entry, sl, tp, planRR: rr, fillRR: rr, quant: null, setup: id, why: s.why, exitT: ex.exitT, exitPx: ex.exitPx, reason: ex.reason, r: ex.r, open: !!ex.open });
        }
      }
    }
    for (const h of series['1h']) {
      if (h.ct < startT || h.ct > endT) continue;
      const t = h.ct, idx = { '1d': cur['1d'](t), '4h': cur['4h'](t), '1h': cur['1h'](t) }, bi = cb(t);
      const isH4Close = idx['4h'] >= 0 && series['4h'][idx['4h']].ct === t;
      X.struct = null;
      if (isH4Close && needStruct && idx['4h'] >= 60 && idx['1d'] >= 60) {
        const j = idx['4h'], i = idx['1d'];
        if (dCache.i !== i) { dCache.i = i; dCache.a = QUANT.analyze(series['1d'].slice(Math.max(0, i - 299), i + 1), '1d', CORE, null); }
        const ah = QUANT.analyze(series['4h'].slice(Math.max(0, j - 299), j + 1), '4h', CORE, null);
        const ph = { ok: true, lastEvent: null, cross: {}, close: 0, ind: {}, obs: [], fvgs: [] };
        const mt = dCache.a && dCache.a.ok && ah.ok ? QUANT.mtf({ '1d': dCache.a, '4h': ah, '1h': ph, '15m': ph }) : null;
        X.struct = { d1: dCache.a, h4: ah, d1Bull: !!(mt && mt.steps[0].pass) };
      }
      for (const id of rules) {
        const rule = RULES.find((r) => r.id === id); if (rule.tf === '15m') continue; if (rule.tf === '4h' && !isH4Close) continue;
        const s = evaluateRule(id, X, idx, btc ? B : null, bi, P); if (!s) continue;
        funnel[id].signals++;
        const fi = m15ByT.get(t + 1); if (fi == null) { funnel[id].noFill++; continue; }
        const entry = m15[fi].o, sl = s.sl;
        if (!(sl > 0 && sl < entry) || (entry - sl) / entry * 100 > P.maxSlPct) { funnel[id].badStop++; continue; }
        const tp = targetFor(entry, sl, P.minRR, P.feePct, P.slipPct);
        const ex = CORE.simulateExit(m15, fi, { entry, sl, tp1: tp, tp2: tp, mode: 'single', maxBars, feePct: P.feePct, slipPct: P.slipPct });
        if (!ex) continue;
        funnel[id].candidates++;
        cands.push({ variant: id, signalT: t, entryT: m15[fi].t, kind: 'MARKET', planEntry: entry, entry, sl, tp, planRR: P.minRR, fillRR: P.minRR, quant: null, setup: id, why: s.why, exitT: ex.exitT, exitPx: ex.exitPx, reason: ex.reason, r: ex.r, open: !!ex.open });
      }
    }
    return { cands, funnel };
  }
  return { RULES, targetFor, prep, evaluateRule, replay, burst };
})();

function runEngineTests(E) {
  const out = [];
  const T = (area, name, fn) => { try { const r = fn(); out.push({ area, name, pass: r === true, detail: r === true ? 'ok' : String(r) }); } catch (e) { out.push({ area, name, pass: false, detail: 'threw: ' + e.message }); } };
  const eq = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
  const H = 36e5;
  const mk = (arr, t0 = 1700000000000 - (1700000000000 % H), iv = H) => arr.map((x, i) => ({ t: t0 + i * iv, o: x[0], h: x[1], l: x[2], c: x[3], v: x[4] ?? 100, ct: t0 + (i + 1) * iv - 1, closed: true }));

  T('Timeframe mapping', '15m/1h/4h/1d interval ms', () => E.TF_MS['15m'] === 9e5 && E.TF_MS['1h'] === 36e5 && E.TF_MS['4h'] === 144e5 && E.TF_MS['1d'] === 864e5 || 'mapping wrong');
  T('Closed-candle validation', 'forming candle flagged, stale detection', () => {
    const now = 1794312001807;
    const raw = [[1794304800000, '1', '2', '0.5', '1.5', '10', 1794308399999, '15'], [1794308400000, '1.5', '2', '1', '1.8', '10', 1794311999999, '18'], [1794312000000, '1.8', '1.9', '1.7', '1.8', '1', 1794315599999, '2']];
    const n = E.normalizeKlines(raw, { symbol: 'X', tf: '1h', nowMs: now });
    if (n.candles[1].closed !== true || n.candles[2].closed !== false) return 'closed flags wrong';
    if (n.meta.freshness !== 'FRESH') return 'should be fresh';
    const s = E.normalizeKlines(raw.slice(0, 1), { symbol: 'X', tf: '1h', nowMs: now + 5 * 36e5 });
    if (s.meta.status !== 'DATA STALE') return 'stale not detected';
    const bad = E.normalizeKlines([[1, '1', '0.5', '0.9', '1', '1', 2]], { symbol: 'X', tf: '1h', nowMs: now });
    return bad.meta.valid === false || 'OHLC inconsistency not caught';
  });
  T('Data normalization', 'extractJSON tolerates trailing text', () => { const r = E.extractJSON('{"a":[1,2]}\n\n[Instructions...]'); return (r && r.a && r.a[1] === 2) || 'parse failed'; });
  T('Indicators', 'SMA/EMA/ATR/RSI', () => {
    const s = E.sma([1, 2, 3, 4, 5], 3); if (!eq(s[4], 4) || s[1] !== null) return 'sma';
    const e = E.ema([1, 2, 3, 4, 5, 6], 3); if (!eq(e[2], 2) || !eq(e[3], 3) || !eq(e[5], 5)) return 'ema ' + e;
    const c = mk(Array.from({ length: 20 }, (_, i) => [10, 11, 9, 10]));
    const a = E.atr(c, 14); if (!eq(a[19], 2)) return 'atr ' + a[19];
    const r = E.rsi(Array.from({ length: 20 }, (_, i) => i), 14); if (r[19] !== 100) return 'rsi';
    return true;
  });
  // zig-zag: up, down, up past prior high, down past prior low
  const zig = [];
  const path = [10, 11, 12, 13, 14, 15, 14, 13, 12, 11, 12, 13, 14, 15, 16, 17, 16, 15, 14, 13, 12, 11, 10, 9, 10, 11, 12];
  path.forEach((p, i) => zig.push([p - 0.2, p + 0.5, p - 0.5, p + 0.2, 100]));
  const zc = mk(zig);
  T('Market structure', 'swing detection + HH/HL labels', () => {
    const sw = E.findSwings(zc, 2, 2);
    const hs = sw.filter((s) => s.type === 'H').map((s) => s.i), ls = sw.filter((s) => s.type === 'L').map((s) => s.i);
    if (hs.join() !== '5,15') return 'highs ' + hs;
    if (ls.join() !== '9,23') return 'lows ' + ls;
    const lab = sw.map((s) => s.label).join();
    return lab === 'H,L,HH,LL' || 'labels ' + lab;
  });
  T('Market structure', 'BOS then CHoCH on close', () => {
    const sw = E.findSwings(zc, 2, 2), A = E.atr(zc, 5);
    const { events, trend } = E.structureEvents(zc, sw, A);
    const s = events.map((e) => e.dir + ':' + e.type + '@' + e.i).join();
    // high@5 (15.5) broken when close > 15.5 → i=14 (close 16.2); low@9 (10.5) broken when close<10.5 → i=22 (10.2)
    return (s === 'bull:BOS@14,bear:CHoCH@22' && trend === 'bear') || 'events ' + s + ' trend ' + trend;
  });
  T('Liquidity', 'SSL sweep & reclaim detected', () => {
    const arr = [[12, 12.5, 11.5, 12], [12, 12.2, 11, 11.2], [11.2, 11.5, 10, 10.5], [10.5, 11.6, 10.4, 11.5], [11.5, 12, 11.2, 11.8], [11.8, 12.4, 11.6, 12.2], [12.2, 12.6, 9.6, 10.8], [10.8, 11.4, 10.6, 11.2]];
    const c = mk(arr); const sw = E.findSwings(c, 2, 2);
    const low = sw.find((s) => s.type === 'L'); if (!low || low.i !== 2) return 'swing low not at 2';
    const L = E.liquidity(c, sw, E.atr(c, 3));
    const ssl = L.levels.find((l) => l.type === 'SSL');
    return (ssl.swept && ssl.sweptAt === 6 && ssl.sweepType === 'Sweep & Reclaim' && eq(ssl.sweepExtreme, 9.6)) || JSON.stringify(ssl);
  });
  T('Liquidity', 'equal lows (EQL) within tolerance', () => {
    const arr = [[12, 12.5, 11.5, 12], [12, 12, 11, 11.2], [11.2, 11.5, 10, 10.5], [10.5, 11.6, 10.4, 11.5], [11.5, 12, 11.2, 11.8], [11.8, 11.9, 10.6, 10.8], [10.8, 11, 10.02, 10.4], [10.4, 11.2, 10.3, 11], [11, 11.6, 10.9, 11.4], [11.4, 11.8, 11.2, 11.6]];
    const c = mk(arr); const sw = E.findSwings(c, 2, 2);
    const L = E.liquidity(c, sw, E.atr(c, 3), { eqTolAtr: 0.2 });
    return L.equals.some((e) => e.type === 'EQL') || 'no EQL ' + JSON.stringify(sw.map((s) => [s.type, s.i, s.price]));
  });
  T('OB & FVG', 'bullish FVG detected, size and mitigation', () => {
    const c = mk([[10, 10.5, 9.8, 10.2], [10.2, 12, 10.1, 11.8], [11.8, 12.5, 11, 12.3], [12.3, 12.4, 10.8, 11]]);
    const f = E.findFVGs(c, [1, 1, 1, 1], { minAtr: 0.1 });
    const b = f.find((x) => x.dir === 'bull');
    if (!b || !eq(b.bottom, 10.5) || !eq(b.top, 11)) return 'fvg ' + JSON.stringify(f);
    return (b.status === 'Partially mitigated' && eq(b.filled, 0.4)) || 'mitigation ' + b.filled;
  });
  T('OB & FVG', 'bullish OB = last down candle before displacement BOS', () => {
    const arr = [[10, 10.6, 9.9, 10.5], [10.5, 11, 10.4, 10.9], [10.9, 11.2, 10.7, 11.1], [11.1, 11.15, 10.6, 10.7], [10.7, 10.8, 10.2, 10.3], [10.3, 10.4, 9.95, 10.05], [10.05, 10.2, 9.7, 9.8], [9.8, 11, 9.75, 10.9], [10.9, 11.9, 10.8, 11.8], [11.8, 12.2, 11.6, 12.1], [12.1, 12.3, 11.9, 12.2], [12.2, 12.4, 12, 12.3]];
    const c = mk(arr); const A = E.atr(c, 3); const sw = E.findSwings(c, 2, 2);
    const st = E.structureEvents(c, sw, A); const fv = E.findFVGs(c, A, { minAtr: 0.1 });
    const obs = E.findOrderBlocks(c, st.events, A, fv);
    const ob = obs.find((o) => o.dir === 'bull');
    if (!ob) return 'no OB; events ' + JSON.stringify(st.events.map((e) => [e.dir, e.type, e.i]));
    return (ob.i === 6 && ob.confirmed && ob.validity === 'Valid') || JSON.stringify({ i: ob.i, conf: ob.confirmed, v: ob.validity });
  });
  T('Entry/SL/TP', 'net R:R includes fees and slippage', () => {
    const r = E.rr(100, 95, 115, 0.1, 0.05);
    if (!eq(r.gross, 3)) return 'gross ' + r.gross;
    const cst = 0.0015; const net = (15 - 100 * cst - 115 * cst) / (5 + 100 * cst + 95 * cst);
    return eq(r.net, net) || 'net ' + r.net;
  });
  T('Exchange filters', 'tick/step rounding without float drift', () => {
    if (E.roundStep(74414.987, '0.01000000', 'floor') !== 74414.98) return 'tick ' + E.roundStep(74414.987, '0.01000000');
    if (E.roundStep(0.0013449, '0.00001000', 'floor') !== 0.00134) return 'step';
    if (E.roundStep(0.3, '0.1', 'floor') !== 0.3) return 'fp guard 0.3';
    if (E.roundStep(1234.5, '1.00000000', 'floor') !== 1234) return 'int step';
    return E.stepDecimals('0.00001000') === 5 || 'decimals';
  });
  T('Position sizing', '1% risk with LOT_SIZE / NOTIONAL', () => {
    const f = { tickSize: '0.01000000', stepSize: '0.00001000', minQty: 0.00001, maxQty: 9000, minNotional: 5, maxNotional: 9e6 };
    const p = E.positionSize({ equity: 10000, riskPct: 1, entry: 74414.98, sl: 73000, feePct: 0.1, slipPct: 0.05 }, f);
    if (p.errors.length) return p.errors.join();
    if (!(p.netLoss <= 100 + 1e-6 && p.netLoss > 95)) return 'netLoss ' + p.netLoss;
    if (Math.abs(p.qty / 0.00001 - Math.round(p.qty / 0.00001)) > 1e-6) return 'qty not on step';
    const small = E.positionSize({ equity: 100, riskPct: 1, entry: 74414.98, sl: 74000, feePct: 0.1, slipPct: 0.05 }, { ...f, minNotional: 5 });
    return small.qty * 74414.98 >= 5 || small.errors.some((e) => /NOTIONAL|minQty/.test(e)) || 'min notional not enforced';
  });
  T('Signal validation', 'NO TRADE when data missing', () => { const s = E.signal({ d: null, h4: null, h1: null, m15: null }, 100); return s.status === 'NO TRADE' || s.status; });
  T('Journal CRUD', 'stats: win rate, PF, R, drawdown', () => {
    const tr = [
      { status: 'Closed', entry: 100, sl: 95, exit: 110, qty: 1, fees: 0, setup: 'A', exitDate: '2026-01-01' },
      { status: 'Closed', entry: 100, sl: 95, exit: 95, qty: 1, fees: 0, setup: 'A', exitDate: '2026-01-02' },
      { status: 'Closed', entry: 100, sl: 95, exit: 95, qty: 1, fees: 0, setup: 'B', exitDate: '2026-01-03' },
      { status: 'Open', entry: 100, sl: 95, qty: 1 },
    ];
    const s = E.journalStats(tr, 3);
    if (s.n !== 3 || !s.enough) return 'n';
    if (!eq(s.winRate, 1 / 3) || !eq(s.profitFactor, 1) || !eq(s.netPnl, 0) || !eq(s.maxDD, 10) || !eq(s.avgR, 0)) return JSON.stringify(s);
    return E.journalStats(tr, 20).enough === false || 'min trades gate';
  });
  T('Import/export', 'CSV round-trip with quotes, commas, newlines', () => {
    const rows = [{ id: 'a1', symbol: 'BTCUSDT', status: 'Closed', note: 'Swept, "clean"\nreclaim', entry: 1 }];
    const p = E.parseCSV(E.toCSV(rows));
    return (p.rows[0].note === rows[0].note && p.rows[0].symbol === 'BTCUSDT') || JSON.stringify(p);
  });
  T('Import/export', 'trade validation rejects bad rows', () => {
    const e1 = E.validateTrade({ symbol: 'BTCUSDT', status: 'Closed', entry: '1', exit: '' });
    const e2 = E.validateTrade({ symbol: 'BTCUSDT', status: 'Open', entry: '1' });
    return (e1.length === 1 && e2.length === 0) || JSON.stringify([e1, e2]);
  });
  T('Entry/SL/TP', 'SMC stop: auto picks 15M protected low, zone fallback, liquidity-aware shift', () => {
    const P = { ...E.DEFAULT_PARAMS, slBufferAtr: 0.25, liqBufferAtr: 0.5, slMode: 'auto' };
    const a = E.computeStop({ zoneLow: 90, protectedLow: 95, entry: 100, atr1h: 2, atr15: 0.8, pools: [], P });
    if (a.used !== 'refined' || !eq(a.sl, 94.8)) return 'auto refined ' + JSON.stringify(a);
    const b = E.computeStop({ zoneLow: 90, protectedLow: 89, entry: 100, atr1h: 2, atr15: 0.8, pools: [], P });
    if (b.used !== 'zone' || !eq(b.sl, 89.5)) return 'fallback ' + JSON.stringify(b);
    const c = E.computeStop({ zoneLow: 90, protectedLow: 95, entry: 100, atr1h: 2, atr15: 0.8, pools: [{ price: 94.5, src: '15M EQL' }, { price: 80, src: 'far' }], P });
    if (!(c.liq && c.liq.price === 94.5 && eq(c.sl, 94.3))) return 'liquidity ' + JSON.stringify(c);
    const d = E.computeStop({ zoneLow: 90, protectedLow: 95, entry: 100, atr1h: 2, atr15: 0.8, pools: [], P: { ...P, slMode: 'zone' } });
    if (d.used !== 'zone' || !eq(d.sl, 89.5)) return 'zone mode';
    const e2 = E.computeStop({ zoneLow: 90, protectedLow: null, entry: 100, atr1h: 2, atr15: 0.8, pools: [], P: { ...P, slMode: 'refined' } });
    return e2.sl === null || 'refined without trigger must fail';
  });
  T('Signal validation', 'entry timing returns NO DATA / NO SETUP safely', () => {
    const t1 = E.entryTiming({}, { dataOk: false }, 100);
    const t2 = E.entryTiming({ m15: { candles: [{}], atrLast: 1, events: [], swings: [], fvgs: [], obs: [] }, h4: {} }, { dataOk: true, status: 'NO TRADE', checks: [{ id: 1, pass: false }, { id: 2, pass: true }], plan: { zone: null, tps: [], rrs: [] } }, 100);
    return (t1.label === 'NO DATA' && t2.label === 'NO SETUP') || t1.label + ' ' + t2.label;
  });
  T('Backtest', 'exit simulation: target, stop, same-candle stop priority, partial + BE', () => {
    const c = mk([[100, 101, 99, 100], [100, 106, 99.5, 105], [105, 111, 104, 110]]);
    const a = E.simulateExit(c, 0, { entry: 100, sl: 95, tp1: 105, tp2: 110, mode: 'single', feePct: 0, slipPct: 0 });
    if (!(a.reason === 'Target' && a.exitIdx === 2 && eq(a.r, 2))) return 'target ' + JSON.stringify(a);
    const b = E.simulateExit(mk([[100, 111, 94, 100]]), 0, { entry: 100, sl: 95, tp1: 105, tp2: 110, feePct: 0, slipPct: 0 });
    if (!(b.reason === 'Stop loss' && eq(b.r, -1))) return 'same-candle ' + JSON.stringify(b);
    const g = E.simulateExit(mk([[90, 92, 89, 91]]), 0, { entry: 100, sl: 95, tp1: 105, tp2: 110, feePct: 0, slipPct: 0 });
    if (!eq(g.r, -2)) return 'gap through stop should fill at open ' + g.r;
    const p = E.simulateExit(mk([[100, 106, 99, 105], [105, 105.5, 99.5, 100]]), 0, { entry: 100, sl: 95, tp1: 105, tp2: 110, mode: 'partial', feePct: 0, slipPct: 0 });
    return (p.reason === 'BE after TP1' && eq(p.r, 0.5)) || 'partial ' + JSON.stringify(p);
  });
  return out;
}

/* ==== PHASE 1 ACCEPTANCE TESTS — synthetic inputs, run in Node and in System Health ==== */
async function runPhase1Tests(CORE, D) {
  const out = [];
  const T = async (area, name, fn) => { try { const r = await fn(); out.push({ area, name, pass: r === true, detail: r === true ? 'ok' : String(r) }); } catch (e) { out.push({ area, name, pass: false, detail: 'threw: ' + (e && e.message || e) }); } };
  const pf = CORE.parseFilters;
  const filt = (o = {}) => [
    { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '100000', tickSize: o.tick || '0.01' },
    { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '9000', stepSize: o.step || '0.001' },
    ...(o.noNotional ? [] : [{ filterType: o.oldNotional ? 'MIN_NOTIONAL' : 'NOTIONAL', minNotional: '5' }]),
  ];
  const sym = (base, o = {}) => ({ symbol: o.name || base + (o.quote || 'USDT'), baseAsset: base, quoteAsset: o.quote || 'USDT', status: o.status || 'TRADING', isSpotTradingAllowed: o.spot !== false, permissions: o.perm || [], permissionSets: o.sets || [['SPOT', 'MARGIN']], filters: filt(o) });
  const info = { serverTime: 1700000000000, symbols: [
    sym('BTC'), sym('ETH', { oldNotional: true }), sym('OLD', { status: 'BREAK' }), sym('NOSPOT', { spot: false }), sym('USDC'),
    sym('BTCUP'), sym('AAPLB'), sym('ARB'), sym('BAD', { tick: '0' }), sym('NON', { noNotional: true }), sym('ETH', { quote: 'BTC' }),
    sym('NOPERM', { sets: [['MARGIN']] }), sym('X', { name: 'XUSDTT' }),
  ] };
  const H = 36e5;

  await T('Universe', 'only USDT quote pairs are considered', () => { const u = D.buildUniverse(info, {}, pf, 1700000000000); return u.quoteTotal === 12 || `quoteTotal ${u.quoteTotal}`; });
  await T('Universe', 'eligible = TRADING + spot allowed + valid filters, minus policy exclusions', () => { const u = D.buildUniverse(info, {}, pf, 1700000000000); return JSON.stringify(u.eligible) === JSON.stringify(['ARBUSDT', 'BTCUSDT', 'ETHUSDT']) || u.eligible.join(','); });
  await T('Universe', 'BREAK status is excluded with reason "status"', () => { const u = D.buildUniverse(info, {}, pf, 0); const x = u.excluded.find((e) => e.symbol === 'OLDUSDT'); return (x && x.reasons.includes('status')) || JSON.stringify(x); });
  await T('Universe', 'isSpotTradingAllowed=false is excluded', () => { const u = D.buildUniverse(info, {}, pf, 0); const x = u.excluded.find((e) => e.symbol === 'NOSPOTUSDT'); return (x && x.reasons.includes('spotAllowed')) || JSON.stringify(x); });
  await T('Universe', 'missing SPOT permission is excluded', () => { const u = D.buildUniverse(info, {}, pf, 0); const x = u.excluded.find((e) => e.symbol === 'NOPERMUSDT'); return (x && x.reasons.includes('spotPermission')) || JSON.stringify(x); });
  await T('Universe', 'query permissions=SPOT counts as SPOT permission when sets are hidden', () => { const s = sym('ZZZ', { sets: [] }); return D.validateSymbol(s, { queriedWithSpot: true }, pf).valid === true && D.validateSymbol(s, {}, pf).valid === false || 'wrong'; });
  await T('Universe', 'symbol name must equal base + quote', () => { const v = D.validateSymbol(info.symbols[12], {}, pf); return v.failed.includes('symbol') || v.failed.join(','); });
  await T('Universe', 'non-Latin base names are valid and flagged; symbols with spaces are not', () => { const a = D.validateSymbol(sym('牛来'), {}, pf), b = D.validateSymbol(sym('A B'), {}, pf); return (a.valid && a.flags.includes('NON_LATIN_NAME') && !b.valid) || JSON.stringify([a.failed, a.flags, b.failed]); });
  await T('Universe', 'zero tick size and missing notional fail validation', () => { const u = D.buildUniverse(info, {}, pf, 0); const a = u.excluded.find((e) => e.symbol === 'BADUSDT'), b = u.excluded.find((e) => e.symbol === 'NONUSDT'); return (a.reasons.includes('tickSize') && b.reasons.includes('minNotional')) || JSON.stringify([a, b]); });
  await T('Universe', 'MIN_NOTIONAL (older filter) is accepted as min notional', () => { const v = D.validateSymbol(info.symbols[1], {}, pf); return (v.valid && v.filters.minNotional === 5 && v.filters.notionalType === 'MIN_NOTIONAL') || JSON.stringify(v.filters); });
  await T('Universe', 'stablecoin, leveraged and tokenized-stock flags; ARB is not a stock token', () => { const f = (b) => D.validateSymbol(sym(b), {}, pf).flags.join(); return (f('USDC') === 'STABLECOIN' && f('BTCUP') === 'LEVERAGED_TOKEN' && f('AAPLB') === 'STOCK_TOKEN' && f('ARB') === '') || [f('USDC'), f('BTCUP'), f('AAPLB'), f('ARB')].join('|'); });
  await T('Universe', 'policy exclusions can be switched off', () => { const u = D.buildUniverse(info, { excludeStables: false, excludeLeveraged: false, excludeStockTokens: false }, pf, 0); return u.eligibleCount === 6 || u.eligible.join(','); });
  await T('Universe', 'clock offset from serverTime', () => D.buildUniverse(info, {}, pf, 1700000000500).clockOffsetMs === -500 || 'offset wrong');
  await T('Universe', 'missing symbols array returns ok:false, never an empty "valid" universe', () => D.buildUniverse({}, {}, pf, 0).ok === false || 'no error');
  await T('Universe', 'diff reports added, removed and status changes', () => { const d = D.diffUniverse({ A: 'ELIGIBLE', B: 'ELIGIBLE', C: 'BREAK' }, { A: 'ELIGIBLE', C: 'ELIGIBLE', D: 'ELIGIBLE' }); return (d.added.join() === 'D' && d.removed.join() === 'B' && d.changed.length === 1 && d.changed[0].to === 'ELIGIBLE') || JSON.stringify(d); });

  const now = 1700000000000;
  const uni = { eligible: ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT'] };
  const tk = [
    { symbol: 'AUSDT', lastPrice: '10', openPrice: '8', priceChangePercent: '25', quoteVolume: '60000000', closeTime: now - 1000, count: 5000, highPrice: '11', lowPrice: '7.5', bidPrice: '9.99', askPrice: '10.01' },
    { symbol: 'BUSDT', lastPrice: '5', openPrice: '5', quoteVolume: '300000', closeTime: now - 10 * 60e3, count: 10 },
    { symbol: 'AUSDT', lastPrice: '10', quoteVolume: '1', closeTime: now },
    { symbol: 'CUSDT', lastPrice: '0', quoteVolume: '100', closeTime: now },
    { symbol: 'ZUSDT', lastPrice: '1', quoteVolume: '1', closeTime: now },
  ];
  await T('Tickers', 'fresh / stale / invalid quality, duplicates flagged, missing listed', () => { const r = D.tickerRows(tk, uni, {}, now); const q = Object.fromEntries(r.rows.map((x) => [x.symbol, x.quality])); return (q.AUSDT === 'FRESH' && q.BUSDT === 'STALE' && q.CUSDT === 'INVALID' && r.issues.length === 1 && r.missing.join() === 'DUSDT' && !q.ZUSDT) || JSON.stringify({ q, i: r.issues, m: r.missing }); });
  await T('Tickers', 'liquidity tier and spread', () => { const a = D.tickerRows(tk, uni, {}, now).rows[0]; return (a.tier === 'A' && Math.abs(a.spreadPct - 0.2) < 1e-9 && D.liqTier(3e5, D.DEFAULTS.liqTiers) === 'E') || JSON.stringify(a); });
  await T('Tickers', 'breadth uses fresh rows only', () => { const b = D.marketBreadth(D.tickerRows(tk, uni, {}, now).rows); return (b.n === 1 && b.up === 1) || JSON.stringify(b); });

  const mk = (n, iv, t0, skip = []) => { const a = []; for (let i = 0; i < n; i++) { if (skip.includes(i)) continue; const t = t0 + i * iv, p = 100 + i; a.push([t, String(p), String(p + 2), String(p - 1), String(p + 1), '10', t + iv - 1, '1000', 5, '6', '600', '0']); } return a; };
  const t0 = Math.floor(now / H) * H - 20 * H;
  await T('Candles', 'fresh series with last candle forming is usable for signals', () => { const q = D.candleQuality(mk(21, H, t0), { symbol: 'X', tf: '1h', nowMs: now, fetchedAt: now, source: 't' }, CORE.normalizeKlines, CORE.TF_MS); return (q.meta.usableForSignals && q.meta.formingCount === 1 && q.meta.lastClosedOpen === t0 + 19 * H) || JSON.stringify(q.meta); });
  await T('Candles', 'missing candles are counted and located', () => { const q = D.candleQuality(mk(21, H, t0, [5, 6, 12]), { symbol: 'X', tf: '1h', nowMs: now, fetchedAt: now, source: 't' }, CORE.normalizeKlines, CORE.TF_MS); return (q.meta.missingCount === 3 && q.meta.gaps.length === 2 && q.meta.gaps[0].missing === 2 && q.meta.verdict === 'VALID WITH GAPS') || JSON.stringify(q.meta); });
  await T('Candles', 'stale series is not usable for signals', () => { const q = D.candleQuality(mk(21, H, t0 - 10 * H), { symbol: 'X', tf: '1h', nowMs: now, fetchedAt: now, source: 't' }, CORE.normalizeKlines, CORE.TF_MS); return (!q.meta.usableForSignals && q.meta.verdict === 'DATA STALE') || q.meta.verdict; });
  await T('Candles', '5m timeframe is mapped (gaps and freshness work on M5)', () => { const iv = 3e5, s = Math.floor(now / iv) * iv - 10 * iv; const q = D.candleQuality(mk(11, iv, s, [3]), { symbol: 'X', tf: '5m', nowMs: now, fetchedAt: now, source: 't' }, CORE.normalizeKlines, CORE.TF_MS); return (q.meta.missingCount === 1 && q.meta.freshness === 'FRESH') || JSON.stringify(q.meta); });
  await T('Candles', 'duplicate open times are removed, latest copy kept', () => { const c = [{ t: 1, c: 1 }, { t: 2, c: 2 }, { t: 2, c: 3 }]; const d = D.dedupeCandles(c); return (d.duplicates === 1 && d.candles.length === 2 && d.candles[1].c === 3) || JSON.stringify(d); });
  await T('Candles', 'reconcile matches same candle, flags different open times', () => { const a = { t: 1, c: 100 }; return (D.reconcile(a, { t: 1, c: 100.01 }).ok && !D.reconcile(a, { t: 2, c: 100 }).ok && !D.reconcile(a, { t: 1, c: 101 }).ok) || 'wrong'; });

  await T('Reliability', 'source state OK → DEGRADED → DOWN → OK', () => { let t = 0; const m = D.createSourceMonitor(() => t++); m.record('s', true, 100); const a = m.get('s').state; m.record('s', false, null, { code: 'x' }); const b = m.get('s').state; m.record('s', false); m.record('s', false); const c = m.get('s').state; m.record('s', true, 50); return (a === 'OK' && b === 'DEGRADED' && c === 'DOWN' && m.get('s').state === 'OK' && m.snapshot()[0].p50 === 100) || [a, b, c].join(); });
  await T('Reliability', 'backoff grows exponentially and is capped', () => { const r = () => 0.999999; return (D.backoffMs(0, 500, 8000, r) === 499 && D.backoffMs(2, 500, 8000, r) === 1999 && D.backoffMs(10, 500, 8000, r) === 7999) || [D.backoffMs(0, 500, 8000, r), D.backoffMs(2, 500, 8000, r)].join(); });
  await T('Reliability', 'retry only retryable errors and honour retryAfterMs', async () => {
    const waits = []; let n = 0;
    const v = await D.withRetry(async () => { n++; if (n < 3) throw { code: 'rate_limited', retryable: true, retryAfterMs: 1200 }; return 'ok'; }, { tries: 3, isRetryable: (e) => e.retryable, sleep: async (ms) => { waits.push(ms); }, rand: () => 0 });
    let m = 0, threw = false; try { await D.withRetry(async () => { m++; throw { code: 'not_granted' }; }, { tries: 3, isRetryable: (e) => !!e.retryable, sleep: async () => {} }); } catch (e) { threw = true; }
    return (v === 'ok' && n === 3 && waits.join() === '1200,1200' && m === 1 && threw) || JSON.stringify({ v, n, waits, m });
  });
  await T('Reliability', 'event de-duplication within TTL', () => { let t = 0; const d = D.createDedupe(100, () => t); const a = d.seen('k'), b = d.seen('k'); t = 200; const c = d.seen('k'); return (a === false && b === true && c === false) || [a, b, c].join(); });
  return out;
}

/* ==== PHASE 2 ACCEPTANCE TESTS — synthetic inputs ==== */
async function runPhase2Tests(CORE, A, N) {
  const out = [];
  const T = async (area, name, fn) => { try { const r = await fn(); out.push({ area, name, pass: r === true, detail: r === true ? 'ok' : String(r) }); } catch (e) { out.push({ area, name, pass: false, detail: 'threw: ' + (e && e.message || e) }); } };
  const DAY = 864e5, t0 = Date.UTC(2026, 6, 1), now = t0 + 130 * DAY + 3600e3;
  // raw kline rows for n closed days with a given daily growth rate and volume path
  const kl = (n, g, vol = () => 1e6, trades = () => 1000, start = 100) => { const a = []; let p = start; for (let i = 0; i < n; i++) { const t = t0 + i * DAY; const c = p * (1 + g(i)); a.push([t, String(p), String(Math.max(p, c) * 1.01), String(Math.min(p, c) * 0.99), String(c), '1', t + DAY - 1, String(vol(i)), trades(i), '0.5', String(vol(i) / 2), '0']); p = c; } return a; };

  /* taxonomy */
  await T('Taxonomy', 'Render categories map to AI, DePIN and Consumer & Social; portfolios and indexes ignored', () => { const m = N.mapCategories(['Artificial Intelligence (AI)', 'NFT', 'Metaverse', 'Solana Ecosystem', 'DePIN', 'Multicoin Capital Portfolio', 'GMCI DePIN Index', 'Made in USA']); return (m.labels.join() === 'AI,DEPIN,GAMING,SOCIAL' && m.primary === 'AI' && m.ignored.length === 4) || JSON.stringify(m); });
  await T('Taxonomy', 'memecoin outranks AI as primary for "AI Meme"', () => { const m = N.mapCategories(['AI Meme', 'Meme']); return (m.primary === 'MEME' && m.labels.includes('AI')) || JSON.stringify(m); });
  await T('Taxonomy', 'Layer 1, Layer 2, restaking, RWA, stablecoin, payments, privacy, interoperability, infrastructure, DeFi rules', () => {
    const p = (c) => N.mapCategories([c]).primary;
    const got = [p('Layer 1 (L1)'), p('Layer 2 (L2)'), p('Liquid Restaking Tokens'), p('Real World Assets (RWA)'), p('Stablecoins'), p('Payment Solutions'), p('Privacy Coins'), p('Interoperability'), p('Oracle'), p('Decentralized Exchange (DEX)')].join();
    return got === 'L1,L2,RESTAKING,RWA,STABLE,PAYMENTS,PRIVACY,INTEROP,INFRA,DEFI' || got; });
  await T('Taxonomy', 'no matching category gives OTHER with LOW confidence, never a guessed narrative', () => { const c = N.classify('XYZ', { id: 'xyz', confidence: 'HIGH' }, { categories: ['Solana Ecosystem'] }); return (c.primary === 'OTHER' && c.confidence === 'LOW') || JSON.stringify(c); });
  await T('Taxonomy', 'unresolved ticker gives OTHER, LOW, with the reason', () => { const c = N.classify('XYZ', null, null); return (c.primary === 'OTHER' && c.confidence === 'LOW' && /No CoinGecko/.test(c.note)) || JSON.stringify(c); });
  await T('Taxonomy', 'manual labels override and are marked verified', () => { const c = N.classify('XYZ', null, null, { labels: ['DEFI', 'AI'] }); return (c.primary === 'AI' && c.verified && c.source === 'Manual') || JSON.stringify(c); });
  await T('Taxonomy', 'CoinGecko id: unique match HIGH, rank pick MEDIUM, symbol mismatch rejected, 1000-prefix stripped', () => {
    const a = N.resolveCgId({ selected: { identity: { id: 'render-token' }, symbol: 'RENDER', name: 'Render', marketCapRank: 78 } }, 'RENDER');
    const b = N.resolveCgId({ candidates: [{ identity: { id: 'x2' }, symbol: 'abc', marketCapRank: 900 }, { identity: { id: 'x1' }, symbol: 'ABC', marketCapRank: 50 }] }, 'ABC');
    const c = N.resolveCgId({ selected: { identity: { id: 'wrong' }, symbol: 'OTHER' } }, 'ABC');
    const d = N.resolveCgId({ selected: { identity: { id: 'sats' }, symbol: 'SATS' } }, '1000SATS');
    return (a.confidence === 'HIGH' && b.id === 'x1' && b.confidence === 'MEDIUM' && c === null && d.id === 'sats') || JSON.stringify([a, b, c, d]); });

  /* features */
  await T('Features', 'only closed daily candles are used; duplicates dropped', () => { const r = kl(10, () => 0.01); r.push(r[9].slice()); r.push([t0 + 10 * DAY, '1', '1', '1', '1', '1', now + 1000, '1', 1, '0', '0', '0']); const s = A.dailySeries(r, now); return (s.length === 10) || s.length; });
  await T('Features', '7/30-day returns, EMA50 position, 20-day averages', () => { const s = A.dailySeries(kl(120, () => 0.01), now); const f = A.assetFeatures(s, { quoteVol: 2e6, trades: 3000, chgPct: 1 }, CORE.ema, CORE.rsi); return (Math.abs(f.ret7 - (Math.pow(1.01, 7) - 1) * 100) < 1e-6 && f.aboveEma50 === true && f.qvAvg20 === 1e6 && f.nAvg20 === 1000 && f.qv24 === 2e6) || JSON.stringify(f); });
  await T('Features', 'short history leaves 30/90-day return unavailable instead of zero', () => { const f = A.assetFeatures(A.dailySeries(kl(20, () => 0.01), now), null, CORE.ema, CORE.rsi); return (f.ret30 === null && f.ret90 === null && f.ema50 === null) || JSON.stringify(f); });
  await T('Order book', 'imbalance inside ±1% band only', () => { const o = A.obImbalance({ bids: [['99.9', '10'], ['98', '1000']], asks: [['100.1', '5'], ['105', '1000']] }); return (Math.abs(o.imb - (999 - 500.5) / (999 + 500.5)) < 1e-9 && o.bidUsd === 999) || JSON.stringify(o); });
  await T('Order book', 'empty or crossed book is unavailable', () => (A.obImbalance({ bids: [], asks: [['1', '1']] }) === null && A.obImbalance({ bids: [['2', '1']], asks: [['1', '1']] }) === null) || 'not null');

  /* attention */
  const mkA = (sym, raw) => ({ symbol: sym, base: sym, raw });
  await T('Attention', 'weights are 25/20/20/15/10/10 and sum to 1', () => { const w = A.WEIGHTS; return (w.relVolume === 0.25 && w.volGrowth === 0.2 && w.momentum === 0.2 && w.relStrength === 0.15 && w.tradeActivity === 0.1 && w.obImbalance === 0.1 && Math.abs(Object.values(w).reduce((s, x) => s + x, 0) - 1) < 1e-12) || JSON.stringify(w); });
  await T('Attention', 'every component is scored 0–100', () => { const r = A.score([mkA('A', { relVolume: 1, volGrowth: 0, momentum: -5, relStrength: -3, tradeActivity: 1, obImbalance: -1 }), mkA('B', { relVolume: 3, volGrowth: 0.5, momentum: 10, relStrength: 4, tradeActivity: 2, obImbalance: 1 })]); const all = r.flatMap((x) => Object.values(x.comp).map((c) => c.score).filter((v) => v != null)); return (all.every((v) => v >= 0 && v <= 100) && r[1].attention === 100 && r[0].attention === 0) || JSON.stringify(r.map((x) => x.attention)); });
  await T('Attention', 'missing component is UNAVAILABLE (null), weights re-normalised, coverage reported', () => { const r = A.score([mkA('A', { relVolume: 1, volGrowth: 0, momentum: 0, relStrength: 0, tradeActivity: 1, obImbalance: null }), mkA('B', { relVolume: 2, volGrowth: 1, momentum: 1, relStrength: 1, tradeActivity: 2, obImbalance: null })]); return (r[0].comp.obImbalance.score === null && r[1].attention === 100 && Math.abs(r[1].coverage - 0.9) < 1e-9 && r[0].comp.social.score === null) || JSON.stringify(r[1]); });
  await T('Attention', 'social attention is always UNAVAILABLE until a verified source exists', () => { const r = A.score([mkA('A', { relVolume: 1, social: 99 })]); return (r[0].comp.social.score === null && r[0].comp.social.raw === null) || 'social scored'; });
  await T('Attention', 'percentile rank: ties share the middle rank', () => (A.pctRank([1, 2, 2, 3], 2) === 50 && A.pctRank([1, 2, 3], 3) === 100 && A.pctRank([5], 5) === 50 && A.pctRank([1, 2], null) === null) || 'rank wrong');
  await T('Attention', 'relative strength uses 7/30/90 weights vs BTC', () => { const r = A.rawComponents({ ret7: 10, ret30: 20, ret90: 30 }, { ret7: 0, ret30: 0, ret90: 0 }, null); return Math.abs(r.relStrength - (3 + 10 + 6)) < 1e-9 || r.relStrength; });

  /* narratives */
  const asset = (sym, g, vol) => { const s = A.dailySeries(kl(120, g, vol), now); return { symbol: sym + 'USDT', base: sym, series: s, f: A.assetFeatures(s, null, CORE.ema, CORE.rsi) }; };
  const hot = (i) => (i >= 113 ? 0.04 : 0.0), flat = () => 0, down = () => -0.004;
  const assets = [asset('H1', hot, (i) => (i >= 113 ? 3e6 : 1e6)), asset('H2', hot, (i) => (i >= 113 ? 3e6 : 1e6)), asset('H3', hot, (i) => (i >= 113 ? 3e6 : 1e6)),
    asset('F1', flat), asset('F2', flat), asset('F3', flat), asset('D1', down), asset('D2', down), asset('D3', down), asset('X1', flat)];
  const tax = {}; for (const a of assets) tax[a.base] = { labels: a.base[0] === 'H' ? ['AI'] : a.base[0] === 'F' ? ['DEFI'] : a.base[0] === 'D' ? ['GAMING'] : ['OTHER'], confidence: 'HIGH', name: a.base === 'H1' ? 'Hotcoin' : null };
  const heads = [{ title: 'AI agent tokens rally', url: 'u1', postedAt: new Date(now - 3600e3).toISOString() }, { title: 'Hotcoin lists new pairs', url: 'u2', postedAt: new Date(now - 7200e3).toISOString() }, { title: 'Old AI news', url: 'u3', postedAt: new Date(now - 10 * DAY).toISOString() }];
  const res = N.compute(assets, tax, heads, now);
  const g = (k) => res.narratives.find((x) => x.key === k);
  await T('Narrative', 'outperforming narrative scores momentum above 50, laggard below 50', () => (g('AI').momentum > 70 && g('GAMING').momentum < 50) || [g('AI').momentum, g('GAMING').momentum].join());
  await T('Narrative', 'growth rate rises when the narrative takes a bigger share of volume', () => (g('AI').growth > 50 && g('DEFI').growth < 50) || [g('AI').growth, g('DEFI').growth].join());
  await T('Narrative', 'freshness = 100 − (days outperforming − 1) × 100/14; 0 when underperforming', () => (g('AI').inputs.streakDays === 7 && Math.abs(g('AI').freshness - (100 - 6 * 100 / 14)) < 1e-9 && g('GAMING').freshness === 0) || [g('AI').freshness, g('AI').inputs.streakDays, g('GAMING').freshness].join());
  await T('Narrative', 'catalyst counts only recent headlines matching a keyword or a member name, de-duplicated', () => (g('AI').headlines.length === 2 && g('AI').catalyst === 50 && g('DEFI').catalyst === 0) || JSON.stringify(g('AI').headlines));
  await T('Narrative', 'catalyst is UNAVAILABLE when no headlines were fetched', () => { const r = N.compute(assets, tax, null, now); return r.narratives.find((x) => x.key === 'AI').catalyst === null || 'scored'; });
  await T('Narrative', 'adoption = half above EMA50 share + half positive 7-day share', () => (g('AI').adoption === 100 && g('GAMING').adoption === 0) || [g('AI').adoption, g('GAMING').adoption].join());
  await T('Narrative', 'fewer than 3 members is UNAVAILABLE with the reason', () => (g('OTHER').status === 'UNAVAILABLE' && /needs 3/.test(g('OTHER').why) && g('RWA').status === 'UNAVAILABLE') || JSON.stringify(g('OTHER')));
  await T('Narrative', 'confidence scales with member count and taxonomy confidence', () => { const t2 = JSON.parse(JSON.stringify(tax)); t2.H1.confidence = t2.H2.confidence = t2.H3.confidence = 'LOW'; const r = N.compute(assets, t2, heads, now).narratives.find((x) => x.key === 'AI'); return (g('AI').confidence === Math.round(100 * 3 / 8) && r.confidence < g('AI').confidence) || [g('AI').confidence, r.confidence].join(); });
  await T('Narrative', 'every scored narrative has exactly one of the 5 lifecycle stages', () => res.narratives.filter((x) => x.status === 'OK').every((x) => ['EMERGING', 'GROWING', 'MAINSTREAM', 'OVERHEATED', 'DECLINING'].includes(x.lifecycle)) || 'bad stage');
  await T('Narrative', 'lifecycle rules: overheated, emerging, mainstream, growing, declining', () => { const L = (m) => N.lifecycle(m).stage; const got = [L({ momentum: 85, adoption: 80, medRsi: 75, freshness: 10, med7: 12 }), L({ momentum: 60, freshness: 90, adoption: 40, med7: 3 }), L({ momentum: 60, freshness: 20, adoption: 70, med7: 2 }), L({ momentum: 60, freshness: 50, adoption: 50, med7: 1 }), L({ momentum: 30, med7: 1 })].join(); return got === 'OVERHEATED,EMERGING,MAINSTREAM,GROWING,DECLINING' || got; });
  await T('Narrative', 'outperforming but falling in absolute terms is DECLINING, with the reason (found on live data 12 Nov)', () => { const r = N.lifecycle({ momentum: 62, freshness: 80, adoption: 25, med7: -4.1 }); return (r.stage === 'DECLINING' && /absolute/.test(r.why)) || JSON.stringify(r); });
  await T('Taxonomy', 'DeFi outranks Stablecoin Issuer; Privacy Infrastructure does not become primary over RWA (Aave, Chainlink cases)', () => { const a = N.mapCategories(['Decentralized Finance (DeFi)', 'Stablecoin Issuer', 'Lending/Borrowing Protocols']), b = N.mapCategories(['Infrastructure', 'Oracle', 'Real World Assets (RWA)', 'Privacy Infrastructure']), c = N.mapCategories(['Privacy Coins', 'Layer 1 (L1)']); return (a.primary === 'DEFI' && b.primary === 'RWA' && c.primary === 'PRIVACY') || [a.primary, b.primary, c.primary].join(); });
  await T('Taxonomy', 'stored records get the current primary on load', () => N.reprimary({ labels: ['STABLE', 'DEFI'], primary: 'STABLE' }).primary === 'DEFI' || 'not updated');
  await T('Narrative', 'history keeps 30 daily points for snapshots', () => (g('AI').history.length === 30 && g('AI').history[29].t === res.lastClosedDay) || g('AI').history.length);
  await T('Narrative', 'asset narrative score = best scored label, OTHER excluded', () => { const a = N.assetNarrative('H1', tax, res), b = N.assetNarrative('X1', tax, res); return (a.narrative === 'AI' && a.score === g('AI').score && b.score === null) || JSON.stringify([a, b]); });
  return out;
}

/* ==== PHASE 3 ACCEPTANCE TESTS — synthetic inputs ==== */
async function runPhase3Tests(CORE, Q) {
  const out = [];
  const T = async (area, name, fn) => { try { const r = await fn(); out.push({ area, name, pass: r === true, detail: r === true ? 'ok' : String(r) }); } catch (e) { out.push({ area, name, pass: false, detail: 'threw: ' + (e && e.message || e) }); } };
  const H = 36e5, t0 = Date.UTC(2026, 0, 1);
  // candles from a close path; wick = 0.4% unless overridden
  const mk = (closes, opt = {}) => closes.map((c, i) => { const o = i ? closes[i - 1] : c; const w = (opt.wick || 0.004) * c; return { t: t0 + i * H, o, h: Math.max(o, c) + w, l: Math.min(o, c) - w, c, v: 100, qv: 100 * c, ct: t0 + (i + 1) * H - 1, closed: true }; });
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const walk = (n, drift = 0) => { const a = [100]; for (let i = 1; i < n; i++) a.push(a[i - 1] * (1 + drift + (rnd() - 0.5) * 0.03)); return a; };

  await T('Indicators', 'ADX high with +DI > −DI in a steady uptrend, low in a flat range', () => {
    const up = mk(Array.from({ length: 120 }, (_, i) => 100 * Math.pow(1.01, i))), fl = mk(Array.from({ length: 120 }, (_, i) => 100 + 2 * Math.sin(i / 2) + (rnd() - 0.5)));
    const a = Q.adx(up.map((x) => x.h), up.map((x) => x.l), up.map((x) => x.c)), b = Q.adx(fl.map((x) => x.h), fl.map((x) => x.l), fl.map((x) => x.c));
    return (a.adx[119] > 40 && a.pdi[119] > a.mdi[119] && b.adx[119] < 25) || [a.adx[119], b.adx[119]].join(); });
  await T('Indicators', 'ADX of a perfectly flat series is 0, not a rounding artefact of 100', () => { const z = Array(60).fill(100); const r = Q.adx(z.map((x) => x + 0.5), z.map((x) => x - 0.5), z); return r.adx[59] === 0 || r.adx[59]; });
  await T('Indicators', 'ROC 10 = close / close 10 bars ago − 1', () => { const r = Q.roc([100, 1, 1, 1, 1, 1, 1, 1, 1, 1, 110], 10); return Math.abs(r[10] - 10) < 1e-9 && r[9] === null || r.join(); });
  await T('Indicators', 'EMA 13/21/50/200 and relative strength vs BTC on the same timeframe', () => { const a = mk(walk(260, 0.004)), b = mk(walk(260, 0)); const ind = Q.indicators(a, CORE, b); const L = 259; const exp = ((a[L].c / a[L - 20].c) - (b[L].c / b[L - 20].c)) * 100; return (ind.e13[L] != null && ind.e200[L] != null && ind.e200[198] === null && Math.abs(ind.rsVsBtc - exp) < 1e-9) || JSON.stringify([ind.e200[198], ind.rsVsBtc, exp]); });
  await T('Indicators', 'relative volume = last closed bar ÷ average of the 20 before it', () => { const c = mk(Array(40).fill(100)); c[39].qv = 300 * 100; c.forEach((x, i) => { if (i < 39) x.qv = 100 * 100; }); const ind = Q.indicators(c, CORE, null); return Math.abs(ind.relVol - 3) < 1e-9 || ind.relVol; });

  // down 60 bars then up: EMA13 crosses above EMA21
  const downUp = (upBars, pullback) => { const a = []; for (let i = 0; i < 60; i++) a.push(120 - i * 0.4); for (let i = 1; i <= upBars; i++) a.push(a[a.length - 1] * 1.006); if (pullback) for (const p of pullback) a.push(a[a.length - 1] * p); return mk(a); };
  await T('EMA 13×21', 'bullish cross found on closed candles with its age', () => { const c = downUp(14); const r = Q.emaCross(c, Q.indicators(c, CORE)); return (r.crossDir === 'bull' && r.crossBarsAgo >= 0 && r.crossBarsAgo <= 14 && ['FRESH CROSS', 'AWAITING RETEST', 'RETEST CONFIRMED', 'RETEST OLD'].includes(r.state)) || JSON.stringify(r); });
  await T('EMA 13×21', 'pullback that wicks into EMA21 and closes above it = RETEST CONFIRMED', () => {
    let c = downUp(25); const ind0 = Q.indicators(c, CORE); const L = c.length - 1, e21 = ind0.e21[L];
    const k = { t: c[L].t + H, o: c[L].c, c: e21 * 1.004, h: c[L].c * 1.001, l: e21 * 0.999, v: 100, qv: 1e4, ct: c[L].t + 2 * H - 1, closed: true };
    c = c.concat([k]); const r = Q.emaCross(c, Q.indicators(c, CORE)); return (r.state === 'RETEST CONFIRMED' && r.retestBarsAgo === 0) || JSON.stringify(r); });
  await T('EMA 13×21', 'a close below EMA21 after the cross = FAILED', () => { const c = downUp(20, [0.97, 0.97]); const r = Q.emaCross(c, Q.indicators(c, CORE)); return r.state === 'FAILED' || r.state === 'BEARISH' || JSON.stringify(r); });
  await T('EMA 13×21', 'falling market reports BEARISH, never a bullish setup', () => { const c = mk(Array.from({ length: 80 }, (_, i) => 100 - i * 0.3)); const r = Q.emaCross(c, Q.indicators(c, CORE)); return r.state === 'BEARISH' || JSON.stringify(r); });

  await T('SMC', 'displacement = body ≥ 1.5 ATR and ≥ 60% of the range', () => { const c = mk(Array(40).fill(100).map((x, i) => x + (i % 2 ? 0.2 : -0.2))); c.push({ t: c[39].t + H, o: 100, c: 106, h: 106.3, l: 99.9, v: 1, qv: 1, closed: true }); const ind = Q.indicators(c, CORE); const d = Q.displacements(c, ind.atr); return (d.length === 1 && d[0].dir === 'bull' && d[0].barsAgo === 0) || JSON.stringify(d); });
  await T('SMC', 'no look-ahead: structure events from a prefix equal the full-series events before that point', () => {
    const all = mk(walk(300, 0.0005), { wick: 0.006 }); let bad = null;
    for (const k of [120, 170, 230, 280]) {
      const pre = CORE.analyzeTF(all.slice(0, k), '1h'), full = CORE.analyzeTF(all, '1h');
      const a = pre.events.map((e) => e.type + e.dir + e.i).join(), b = full.events.filter((e) => e.i < k).map((e) => e.type + e.dir + e.i).join();
      const sa = pre.swings.map((s) => s.type + s.i).join(), sb = full.swings.filter((s) => s.confirmedAt <= k - 1).map((s) => s.type + s.i).join();
      if (a !== b || sa !== sb) { bad = k; break; }
    }
    return bad === null || 'prefix mismatch at ' + bad; });
  await T('SMC', 'forming candle is ignored by every calculation', () => { const c = mk(walk(150, 0.001)); const f = Object.assign({}, c[149], { t: c[149].t + H, c: c[149].c * 1.5, h: c[149].c * 1.6, closed: false }); const a = Q.analyze(c, '1h', CORE), b = Q.analyze(c.concat([f]), '1h', CORE); return (a.close === b.close && a.quant.score === b.quant.score && a.cross.state === b.cross.state) || 'forming candle changed the result'; });
  await T('SMC', 'analysis reports BOS/CHoCH, order blocks, FVGs, sweeps, equal levels and premium/discount', () => { const r = Q.analyze(mk(walk(300, 0.0008), { wick: 0.008 }), '4h', CORE); return (r.ok && Array.isArray(r.events) && Array.isArray(r.obs) && Array.isArray(r.fvgs) && Array.isArray(r.sweeps) && Array.isArray(r.equals) && r.range && ['Premium', 'Discount', 'Equilibrium'].includes(r.range.zone)) || JSON.stringify(Object.keys(r)); });
  await T('SMC', 'fewer than 60 closed candles is not analysed', () => { const r = Q.analyze(mk(walk(40)), '1h', CORE); return (r.ok === false && /40 closed/.test(r.why)) || JSON.stringify(r); });

  await T('Quant score', 'bull stack scores above bear stack; both within 0–100', () => { const up = mk(Array.from({ length: 260 }, (_, i) => 100 * Math.pow(1.003, i) * (1 + 0.01 * Math.sin(i / 3)))), dn = mk(Array.from({ length: 260 }, (_, i) => 100 * Math.pow(0.997, i) * (1 + 0.01 * Math.sin(i / 3)))); const a = Q.analyze(up, '4h', CORE).quant.score, b = Q.analyze(dn, '4h', CORE).quant.score; return (a > 60 && b < 40 && a <= 100 && b >= 0) || [a, b].join(); });
  await T('Quant score', 'weights 35/20/15/10/10/10 sum to 1', () => Math.abs(Object.values(Q.QW).reduce((s, x) => s + x, 0) - 1) < 1e-12 || 'sum');

  const st = (o) => Object.assign({ ok: true, close: 100, ind: { ema50: 90, ema200: 80, ema21: 99 }, structure: 'bull', lastEvent: { dir: 'bull', type: 'BOS', barsAgo: 2 }, cross: { state: 'RETEST CONFIRMED', why: 'x', crossDir: 'bull', crossBarsAgo: 4 }, obs: [], fvgs: [], range: { zone: 'Discount' }, quant: { score: 70 } }, o);
  const good = { '1d': st(), '4h': st(), '1h': st(), '15m': st(), '5m': st() };
  const q = (bad) => Object.fromEntries(['1d', '4h', '1h', '15m', '5m'].map((k) => [k, { usableForSignals: k !== bad }]));
  await T('MTF', 'all four required timeframes aligned = BULLISH CONFIRMED', () => { const r = Q.mtf(good, q()); return (r.verdict === 'BULLISH CONFIRMED' && r.bullishConfirmed && r.steps.length === 5) || r.verdict + ' ' + r.why; });
  await T('MTF', 'stale M15 data = DATA NOT USABLE even when everything else is bullish', () => { const r = Q.mtf(good, q('15m')); return (r.verdict === 'DATA NOT USABLE' && !r.bullishConfirmed) || r.verdict; });
  await T('MTF', 'D1 and H4 bearish = BEARISH', () => { const r = Q.mtf(Object.assign({}, good, { '1d': st({ close: 70, ind: { ema50: 75, ema200: 80, ema21: 72 } }), '4h': st({ structure: 'bear' }) }), q()); return r.verdict === 'BEARISH' || r.verdict; });
  await T('MTF', 'higher timeframes bullish but no M15 confirmation = DEVELOPING', () => { const r = Q.mtf(Object.assign({}, good, { '15m': st({ lastEvent: { dir: 'bear', type: 'BOS', barsAgo: 1 }, cross: { crossDir: 'bear' } }) }), q()); return (r.verdict === 'DEVELOPING' && /15M/.test(r.why)) || r.verdict + ' ' + r.why; });
  await T('MTF', 'M5 is optional and never blocks confirmation', () => { const g2 = Object.assign({}, good); delete g2['5m']; const r = Q.mtf(g2, q()); return r.verdict === 'BULLISH CONFIRMED' || r.verdict; });
  await T('MTF', 'asset Quant score = 0.4 D1 + 0.6 H4', () => { const r = Q.mtf(Object.assign({}, good, { '1d': st({ quant: { score: 50 } }), '4h': st({ quant: { score: 80 } }) }), q()); return Math.abs(r.quant - 68) < 1e-9 || r.quant; });
  return out;
}

/* ==== PHASE 4 ACCEPTANCE TESTS — synthetic inputs ==== */
async function runPhase4Tests(F) {
  const out = [];
  const T = async (area, name, fn) => { try { const r = await fn(); out.push({ area, name, pass: r === true, detail: r === true ? 'ok' : String(r) }); } catch (e) { out.push({ area, name, pass: false, detail: 'threw: ' + (e && e.message || e) }); } };
  const H4 = 4 * 36e5, t0 = Date.UTC(2026, 0, 1), now = t0 + 100 * H4 + 1000;
  // kline rows with quote volume qv and taker buy share b
  const kl = (n, qv, b) => Array.from({ length: n }, (_, i) => { const t = t0 + i * H4, q = typeof qv === 'function' ? qv(i) : qv, s = typeof b === 'function' ? b(i) : b; return [t, '1', '1', '1', '1', '1', t + H4 - 1, String(q), 10, '0', String(q * s), '0']; });

  await T('Kline flow', 'delta = taker buy − taker sell; 24h = last 6 closed H4 bars', () => { const k = F.klineFlow(kl(100, 1000, (i) => (i >= 94 ? 0.6 : 0.5)), now); return (k.h24.qv === 6000 && Math.abs(k.h24.delta - 1200) < 1e-9 && Math.abs(k.h24.imb - 0.2) < 1e-12 && Math.abs(k.d7.imb - 1200 / 42000) < 1e-12) || JSON.stringify(k.h24); });
  await T('Kline flow', 'forming bar, duplicates and impossible rows (taker > total) are dropped', () => { const r = kl(100, 1000, 0.5); r.push([t0 + 100 * H4, '1', '1', '1', '1', '1', now + H4, '99999', 1, '0', '99999', '0']); r.push(r[5].slice()); r[10][10] = '2000'; const k = F.klineFlow(r, now); return k.bars === 99 || k.bars; });
  await T('Kline flow', 'too little history leaves the window UNAVAILABLE (null), not zero', () => { const k = F.klineFlow(kl(20, 1000, 0.5), now); return (k.h24 !== null && k.d7 === null && k.d7prev === null) || JSON.stringify(k); });
  await T('Kline flow', 'previous 7-day window is the 42 bars before the last 42', () => { const k = F.klineFlow(kl(100, (i) => (i >= 58 ? 2000 : 1000), 0.5), now); return (k.d7.qv === 84000 && k.d7prev.qv === 42000) || [k.d7.qv, k.d7prev.qv].join(); });

  const ag = (rows) => rows.map((r, i) => ({ a: r.id ?? i, p: String(r.p ?? 100), q: String(r.q), T: 1000 + i * 1000, m: r.side === 'SELL' }));
  await T('Trades', 'buyerIsMaker = taker sell; imbalance from notional', () => { const f = F.tradeFlow(ag([{ q: 3, side: 'BUY' }, { q: 1, side: 'SELL' }])); return (f.buyUsd === 300 && f.sellUsd === 100 && f.imb === 0.5) || JSON.stringify(f); });
  await T('Trades', 'large threshold = max(10,000 USDT, 50 × median)', () => { const rows = Array(20).fill({ q: 1, side: 'BUY' }).concat([{ q: 150, side: 'BUY' }, { q: 120, side: 'SELL' }, { q: 99, side: 'BUY' }]); const f = F.tradeFlow(ag(rows)); return (f.thresholdUsd === 10000 && f.largeN === 2 && f.largeBuyUsd === 15000 && f.largeSellUsd === 12000) || JSON.stringify([f.thresholdUsd, f.largeN]); });
  await T('Trades', 'duplicate aggregate ids counted once; window span reported in minutes', () => { const f = F.tradeFlow(ag([{ id: 1, q: 1, side: 'BUY' }, { id: 1, q: 1, side: 'BUY' }, { id: 2, q: 1, side: 'SELL' }])); return (f.n === 2 && Math.abs(f.spanMin - 2000 / 60000) < 1e-12) || JSON.stringify(f); });
  await T('Trades', 'empty trade list is UNAVAILABLE (null)', () => F.tradeFlow([]) === null && F.tradeFlow(null) === null || 'not null');
  await T('Trades', 'largest trades are EXCHANGE_TRADE records with no wallet address', () => { const f = F.tradeFlow(ag([{ q: 500, side: 'BUY' }].concat(Array(10).fill({ q: 1, side: 'SELL' })))); return (f.biggest.length === 1 && f.biggest[0].kind === 'EXCHANGE_TRADE' && !('address' in f.biggest[0]) && !('wallet' in f.biggest[0])) || JSON.stringify(f.biggest); });

  await T('Flow score', 'balanced flow = 50; all buy = 100; bounded 0–100', () => { const k0 = { h24: { imb: 0 }, d7: { imb: 0 } }, t0f = { imb: 0, largeN: 5, largeImb: 0 }; const k1 = { h24: { imb: 1 }, d7: { imb: 1 } }, t1 = { imb: 1, largeN: 5, largeImb: 1 }; const a = F.flowScore(k0, t0f), b = F.flowScore(k1, t1), c = F.flowScore({ h24: { imb: -1 }, d7: { imb: -1 } }, { imb: -1, largeN: 5, largeImb: -1 }); return (a.score === 50 && b.score === 100 && c.score === 0) || [a.score, b.score, c.score].join(); });
  await T('Flow score', 'weights 30/25/25/20; missing trades re-normalise over kline parts', () => { const s = F.flowScore({ h24: { imb: 0.1 }, d7: { imb: 0 } }, null); return (Math.abs(s.score - (0.3 * 75 + 0.25 * 50) / 0.55) < 1e-9 && Math.abs(s.coverage - 0.55) < 1e-12 && Math.abs(Object.values(F.FW).reduce((a, x) => a + x, 0) - 1) < 1e-12) || JSON.stringify(s); });
  await T('Flow score', 'fewer than 3 large trades leaves the large-trade part UNAVAILABLE', () => { const s = F.flowScore(null, { imb: 0, largeN: 2, largeImb: 1 }); return (s.parts.large === undefined && s.parts.tradeFlow === 50) || JSON.stringify(s.parts); });
  await T('Wallet score', 'no on-chain source = EXCHANGE ONLY with half coverage; nothing = UNAVAILABLE', () => { const a = F.walletScore({ score: 60, coverage: 1 }, null), b = F.walletScore(null, null), c = F.walletScore({ score: 60, coverage: 1 }, { score: 80 }); return (a.mode === 'EXCHANGE ONLY' && a.score === 60 && a.coverage === 0.5 && b.mode === 'UNAVAILABLE' && b.score === null && c.score === 70 && c.mode === 'HYBRID') || JSON.stringify([a, b, c]); });

  await T('Concentration', 'top shares and HHI', () => { const c = F.concentration([50, 30, 20]); return (c.top1 === 0.5 && c.top10 === 1 && Math.abs(c.hhi - 3800) < 1e-9) || JSON.stringify(c); });
  await T('Narrative flow', 'sums delta and volume per narrative; a pair counts in each of its narratives', () => {
    const k = (qv, imb) => ({ h24: { qv, delta: qv * imb }, d7: { qv: qv * 7, delta: qv * 7 * imb }, d7prev: { qv: qv * 7 } });
    const rows = [{ symbol: 'A', labels: ['AI'], k: k(100, 0.1) }, { symbol: 'B', labels: ['AI', 'DEFI'], k: k(300, -0.1) }, { symbol: 'C', labels: ['DEFI'], k: k(600, 0.2) }];
    const r = F.narrativeFlow(rows, [['AI', 'AI'], ['DEFI', 'DeFi'], ['L1', 'Layer 1']]); const ai = r[0], df = r[1];
    return (ai.qv24 === 400 && Math.abs(ai.delta24 - (10 - 30)) < 1e-9 && Math.abs(ai.share24 - 0.4) < 1e-12 && df.topIn[0] === 'C' && r[2].status === 'UNAVAILABLE') || JSON.stringify([ai, df.topIn]); });

  await T('Wallet registry', 'valid EVM, Bitcoin, Solana and Tron addresses accepted; EVM lower-cased', () => { const base = { label: 'Test', entity: 'EXCHANGE', source: 'Etherscan tag', verification: 'UNVERIFIED', confidence: 'MEDIUM' }; const v = [['ethereum', '0x28C6c06298d514Db089934071355E5743bf21d60'], ['bitcoin', 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97'], ['solana', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'], ['tron', 'TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm']].map(([chain, address]) => F.validateWallet(Object.assign({ chain, address }, base))); return (v.every((x) => x.ok) && v[0].record.address === '0x28c6c06298d514db089934071355e5743bf21d60') || JSON.stringify(v.map((x) => x.errs)); });
  await T('Wallet registry', 'bad address, missing source, unknown chain rejected with reasons', () => { const a = F.validateWallet({ chain: 'ethereum', address: '0x123', label: 'x', entity: 'WHALE', source: '', verification: 'UNVERIFIED', confidence: 'LOW' }), b = F.validateWallet({ chain: 'dogechain', address: 'x' }); return (!a.ok && a.errs.some((e) => /address/.test(e)) && a.errs.some((e) => /Source/.test(e)) && !b.ok && b.errs.includes('Unknown chain')) || JSON.stringify([a, b]); });
  await T('Wallet registry', 'VERIFIED requires an https reference; UNVERIFIED cannot be HIGH confidence', () => { const base = { chain: 'ethereum', address: '0x28c6c06298d514db089934071355e5743bf21d60', label: 'x', entity: 'EXCHANGE', source: 'y' }; const a = F.validateWallet(Object.assign({ verification: 'VERIFIED', confidence: 'HIGH' }, base)), b = F.validateWallet(Object.assign({ verification: 'UNVERIFIED', confidence: 'HIGH' }, base)), c = F.validateWallet(Object.assign({ verification: 'VERIFIED', confidence: 'HIGH', reference: 'https://etherscan.io/address/0x28c6' }, base)); return (!a.ok && !b.ok && c.ok) || JSON.stringify([a.errs, b.errs]); });
  await T('Chain adapters', 'without the Etherscan connector every adapter is UNAVAILABLE with a reason', () => { const s = F.adapterStatus({ etherscan: false }); return (s.every((a) => a.state === 'UNAVAILABLE' && a.why)) || JSON.stringify(s); });
  await T('Chain adapters', 'with Etherscan, only free-tier EVM chains become READY; paid chains say why', () => { const s = F.adapterStatus({ etherscan: true }); return (s.filter((a) => a.state === 'READY').map((a) => a.chain).join() === 'ethereum,arbitrum,polygon' && /paid/.test(s.find((a) => a.chain === 'bsc').why) && s.find((a) => a.chain === 'bitcoin').state === 'UNAVAILABLE') || JSON.stringify(s.map((a) => a.chain + a.state)); });
  /* on-chain */
  const tx = (o, i) => Object.assign({ hash: '0x' + i, timeStamp: String(1000 + i * 10), from: '0x' + '1'.repeat(40), to: '0x' + '2'.repeat(40), value: '1000000000000000000', tokenDecimal: '18' }, o);
  const EX = '0x' + 'e'.repeat(40), Z = F.ZERO;
  await T('On-chain', 'decimals handled exactly; USD from Binance price', () => { const rows = Array.from({ length: 30 }, (_, i) => tx({ value: '2500000', tokenDecimal: '6' }, i)); const m = F.onchainSample(rows, 4, new Set()); return (Math.abs(m.totalUsd - 30 * 2.5 * 4) < 1e-9) || m.totalUsd; });
  await T('On-chain', 'mint from and burn to the zero address measured as net supply change', () => { const rows = Array.from({ length: 30 }, (_, i) => tx(i === 0 ? { from: Z, value: '10000000000000000000' } : i === 1 ? { to: Z, value: '4000000000000000000' } : {}, i)); const m = F.onchainSample(rows, 1, new Set()); return (m.mintUsd === 10 && m.burnUsd === 4 && Math.abs(m.netMintShare - 6 / (10 + 4 + 28)) < 1e-12) || JSON.stringify([m.mintUsd, m.burnUsd, m.netMintShare]); });
  await T('On-chain', 'exchange outflow minus inflow from labelled wallets only', () => { const rows = Array.from({ length: 30 }, (_, i) => tx(i < 3 ? { from: EX } : i === 3 ? { to: EX } : {}, i)); const m = F.onchainSample(rows, 100, new Set([EX])); return (m.exN === 4 && m.exOutUsd === 300 && m.exInUsd === 100 && m.exImb === 0.5) || JSON.stringify(m); });
  await T('On-chain', 'identical transfers without logIndex all count; repeated logIndex counted once', () => { const a = Array.from({ length: 25 }, () => tx({ hash: '0xaa' }, 1)); const b = Array.from({ length: 25 }, (_, i) => tx({ logIndex: String(i % 20) }, 1)); return (F.onchainSample(a, 1, new Set()).n === 25 && F.onchainSample(b, 1, new Set()).n === 20) || 'dedupe wrong'; });
  await T('On-chain', 'fewer than 20 transfers = insufficient, score UNAVAILABLE', () => { const m = F.onchainSample([tx({}, 1)], 1, new Set()); const s = F.onchainScore(m); return (m.insufficient && s.score === null) || JSON.stringify(s); });
  await T('On-chain', 'score needs two parts: supply alone is not enough', () => { const rows = Array.from({ length: 30 }, (_, i) => tx({}, i)); const s = F.onchainScore(F.onchainSample(rows, 1, new Set())); return (s.score === null && s.parts.supply === 50) || JSON.stringify(s); });
  await T('On-chain', 'exchange outflow + neutral supply = above 50 with coverage 0.7', () => { const rows = Array.from({ length: 30 }, (_, i) => tx(i < 4 ? { from: EX } : {}, i)); const s = F.onchainScore(F.onchainSample(rows, 100, new Set([EX]))); return (Math.abs(s.score - (0.5 * 100 + 0.2 * 50) / 0.7) < 1e-9 && Math.abs(s.coverage - 0.7) < 1e-12) || JSON.stringify(s); });
  await T('On-chain', 'whale trend compares large transfers in the newer vs older half', () => { const big = '50000000000000000000000'; const rows = Array.from({ length: 40 }, (_, i) => tx(i >= 34 ? { value: big } : i === 2 ? { value: big } : {}, i)); const m = F.onchainSample(rows, 1, new Set()); const s = F.onchainScore(m); return (m.large1 === 1 && m.large2 === 6 && s.parts.whaleTrend > 50) || JSON.stringify([m.large1, m.large2, m.thresholdUsd, s.parts]); });
  await T('On-chain', 'contract accepted only when CoinGecko canonical id matches the taxonomy id', () => { const res = { selected: { identity: { type: 'token', chain: 'ethereum', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA' }, canonicalCoinId: 'chainlink' }, candidates: [{ identity: { type: 'token', chain: 'ethereum', address: '0x' + 'b'.repeat(40) }, canonicalCoinId: 'stake-link-staked-link' }] }; const a = F.resolveContract(res, 'chainlink'), b = F.resolveContract(res, 'other'), c = F.resolveContract(res, 'stake-link-staked-link'); return (a.address === '0x514910771af9ca656af840dff83e8264ecf986ca' && b === null && c.address === '0x' + 'b'.repeat(40)) || JSON.stringify([a, b, c]); });
  await T('Wallet score', 'HYBRID coverage uses the on-chain coverage', () => { const w = F.walletScore({ score: 60, coverage: 1 }, { score: 40, coverage: 0.7 }); return (w.mode === 'HYBRID' && w.score === 50 && Math.abs(w.coverage - 0.85) < 1e-12) || JSON.stringify(w); });
  return out;
}

/* ==== PHASE 5 ACCEPTANCE TESTS — synthetic inputs ==== */
async function runPhase5Tests(CORE, G) {
  const out = [];
  const T = async (area, name, fn) => { try { const r = await fn(); out.push({ area, name, pass: r === true, detail: r === true ? 'ok' : String(r) }); } catch (e) { out.push({ area, name, pass: false, detail: 'threw: ' + (e && e.message || e) }); } };
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  /* CIS */
  await T('CIS', 'weights 25/25/20/20/10 sum to 1', () => (G.W.narrative === 0.25 && G.W.attention === 0.25 && G.W.wallet === 0.2 && G.W.quant === 0.2 && G.W.risk === 0.1 && near(Object.values(G.W).reduce((a, x) => a + x, 0), 1)) || JSON.stringify(G.W));
  await T('CIS', 'full inputs: weighted sum, FULL quality', () => { const r = G.cis({ narrative: { score: 80 }, attention: { score: 60 }, wallet: { score: 50 }, quant: { score: 90 }, risk: { score: 100 } }); return (near(r.cis, 0.25 * 80 + 0.25 * 60 + 0.2 * 50 + 0.2 * 90 + 0.1 * 100) && r.quality === 'FULL' && r.cls === 'STRONG') || JSON.stringify(r); });
  await T('CIS', 'missing narrative re-normalises over the rest and is PARTIAL', () => { const r = G.cis({ attention: { score: 60 }, wallet: { score: 50 }, quant: { score: 90 }, risk: { score: 100 } }); return (near(r.cis, (0.25 * 60 + 0.2 * 50 + 0.2 * 90 + 0.1 * 100) / 0.75) && r.quality === 'PARTIAL' && r.missing.join() === 'narrative') || JSON.stringify(r); });
  await T('CIS', 'exchange-only wallet (coverage 0.5) marks CIS PARTIAL', () => { const r = G.cis({ narrative: { score: 50 }, attention: { score: 50 }, wallet: { score: 50, coverage: 0.5, mode: 'EXCHANGE ONLY' }, quant: { score: 50 }, risk: { score: 50 } }); return (r.quality === 'PARTIAL' && r.partial.join() === 'wallet' && near(r.coverage, 0.9)) || JSON.stringify(r); });
  await T('CIS', 'HYBRID wallet with ≥ 75% coverage and all inputs measured = FULL; coverage still reported', () => { const r = G.cis({ narrative: { score: 50 }, attention: { score: 50, coverage: 1 }, wallet: { score: 50, coverage: 0.85, mode: 'HYBRID' }, quant: { score: 50 }, risk: { score: 50, coverage: 1 } }); return (r.quality === 'FULL' && near(r.coverage, 1 - 0.2 * 0.15)) || JSON.stringify(r); });
  await T('CIS', 'exchange-only wallet stays PARTIAL even at full exchange coverage', () => { const r = G.cis({ narrative: { score: 50 }, attention: { score: 50 }, wallet: { score: 50, coverage: 1, mode: 'EXCHANGE ONLY' }, quant: { score: 50 }, risk: { score: 50 } }); return r.quality === 'PARTIAL' || r.quality; });
  await T('CIS', 'attention without the order book (coverage 0.9) still counts as complete; risk with tier only (0.4) does not', () => { const r = G.cis({ narrative: { score: 50 }, attention: { score: 50, coverage: 0.9 }, wallet: { score: 50, coverage: 0.85, mode: 'HYBRID' }, quant: { score: 50 }, risk: { score: 50, coverage: 0.4 } }); return (r.quality === 'PARTIAL' && r.partial.join() === 'risk') || JSON.stringify(r); });
  await T('CIS', 'missing Quant or Attention makes CIS UNAVAILABLE, never zero', () => { const r = G.cis({ narrative: { score: 90 }, attention: { score: 90 }, wallet: { score: 90 }, risk: { score: 90 } }); return (r.cis === null && r.quality === 'UNAVAILABLE') || JSON.stringify(r); });
  await T('CIS', 'classes: 85 ELITE, 70 STRONG, 55 DEVELOPING, 40 WEAK, 39.9 POOR', () => [85, 70, 55, 40, 39.9].map(G.cisClass).join() === 'ELITE,STRONG,DEVELOPING,WEAK,POOR' || [85, 70, 55, 40, 39.9].map(G.cisClass).join());
  await T('Risk score', 'tier, ATR% and spread map to documented bands', () => { const a = G.riskScore({ tier: 'A', atrPctD1: 2, spreadPct: 0.02 }), b = G.riskScore({ tier: 'E', atrPctD1: 12, spreadPct: 0.5 }), c = G.riskScore({ tier: 'B' }); return (a.score === 100 && near(b.score, 0.4 * 15 + 0.35 * 15 + 0.25 * 20) && c.score === 85 && near(c.coverage, 0.4)) || JSON.stringify([a, b, c]); });

  /* config */
  await T('Config', 'defaults: 1% risk, 5 positions, 3% daily loss, 5% / 10% drawdown, R:R 2, long-only', () => { const c = G.DEFAULT_CFG; return (c.riskPct === 1 && c.maxOpen === 5 && c.dailyLossPct === 3 && c.ddWarnPct === 5 && c.ddStopPct === 10 && c.minRR === 2) || JSON.stringify(c); });
  await T('Config', 'out-of-range values are reset with a reason; warning kept below stop', () => { const r = G.normalizeCfg({ riskPct: 40, ddWarnPct: 12, ddStopPct: 10, minRR: 'x' }); return (r.cfg.riskPct === 1 && r.cfg.ddWarnPct === 5 && r.cfg.minRR === 2 && r.fixes.length === 3) || JSON.stringify(r); });

  /* risk gate */
  const cfg = G.normalizeCfg({ equity: 10000 }).cfg;
  await T('Risk gate', 'clean account passes', () => { const g = G.riskGate({ equity: 10000, peakEquity: 10000, todayPnl: 0, open: [] }, cfg, 'AUSDT', 'AI', 100); return (g.ok && g.heatPct === 1) || JSON.stringify(g.blocks); });
  await T('Risk gate', '5 open positions blocks a sixth', () => { const open = ['A', 'B', 'C', 'D', 'E'].map((s) => ({ symbol: s + 'USDT', riskAmt: 0 })); const g = G.riskGate({ equity: 10000, open }, cfg, 'XUSDT', null, 50); return (!g.ok && g.blocks.includes('slots')) || JSON.stringify(g.blocks); });
  await T('Risk gate', 'daily loss of 3% blocks; 2.9% passes', () => { const a = G.riskGate({ equity: 10000, todayPnl: -300, open: [] }, cfg, 'X', null, 10), b = G.riskGate({ equity: 10000, todayPnl: -290, open: [] }, cfg, 'X', null, 10); return (!a.ok && a.blocks.includes('daily') && b.ok) || JSON.stringify([a.blocks, b.blocks]); });
  await T('Risk gate', 'drawdown 6% warns but passes; 10% blocks', () => { const a = G.riskGate({ equity: 9400, peakEquity: 10000, open: [] }, cfg, 'X', null, 10), b = G.riskGate({ equity: 9000, peakEquity: 10000, open: [] }, cfg, 'X', null, 10); return (a.ok && a.warn && !b.ok && b.blocks.includes('ddStop')) || JSON.stringify([a, b.blocks]); });
  await T('Risk gate', 'already holding, narrative cap and heat cap block', () => { const open = [{ symbol: 'AUSDT', narrative: 'AI', riskAmt: 200 }, { symbol: 'BUSDT', narrative: 'AI', riskAmt: 200 }]; const g = G.riskGate({ equity: 10000, open }, cfg, 'AUSDT', 'AI', 150); return (['dup', 'narr', 'heat'].every((k) => g.blocks.includes(k))) || JSON.stringify(g.blocks); });
  await T('Risk gate', 'missing equity blocks every BUY', () => { const g = G.riskGate({ open: [] }, G.normalizeCfg({}).cfg, 'X', null, null); return (!g.ok && g.blocks.includes('equity')) || JSON.stringify(g.blocks); });

  /* evaluate */
  const fresh = { usableForSignals: true, lastClosedOpen: 1 };
  const base = () => ({
    symbol: 'AUSDT', narrative: 'AI', nowMs: 1000, cfg, riskState: { equity: 10000, peakEquity: 10000, todayPnl: 0, open: [] },
    cis: { cis: 78, cls: 'STRONG', quality: 'PARTIAL' }, mtf: { verdict: 'BULLISH CONFIRMED', why: 'aligned', steps: [] }, quality: { '1d': fresh, '4h': fresh, '1h': fresh, '15m': fresh },
    ticker: { quality: 'FRESH', tier: 'A', spreadPct: 0.02 }, filters: { tickSize: '0.01', stepSize: '0.001', minQty: 0.001, minNotional: 5 },
    legacy: { plan: { entry: 100, sl: 96, slBasis: 'zone low', tps: [{ price: 106, src: 'H1 BSL' }, { price: 110, src: 'H4 BSL' }], zone: { src: 'H1 bullish OB' }, entryType: 'Market' } },
    timing: { label: 'ON TIME', reasons: ['Break confirmed 15 min ago'] },
    sizing: CORE.positionSize, rr: CORE.rr,
  });
  await T('Signal', 'all hard filters pass = BUY with a complete trading plan', () => { const r = G.evaluate(base()); const p = r.plan; const keys = ['symbol', 'narrative', 'cis', 'entry', 'stopLoss', 'tp1', 'tp2', 'rrTP2', 'qty', 'riskAmount', 'timeframe', 'setup', 'signalAt', 'dataQuality', 'invalidation']; return (r.decision === 'BUY' && keys.every((k) => p[k] != null) && p.rrTP2 >= 2 && p.riskPct <= 1.0001) || JSON.stringify({ d: r.decision, f: r.hard.filter((h) => !h.pass), missing: keys.filter((k) => p && p[k] == null) }); });
  await T('Signal', 'position size: ≤ 1% net loss at SL after fees and slippage, rounded to step size', () => { const r = G.evaluate(base()); const q = r.plan.qty; return (Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6 && r.plan.riskAmount <= 100 + 1e-6 && r.plan.riskAmount > 95) || JSON.stringify(r.plan); });
  await T('Signal', 'a failed hard filter overrides a high CIS (stale M15 with CIS 95 = AVOID)', () => { const c = base(); c.cis = { cis: 95, cls: 'ELITE', quality: 'FULL' }; c.quality['15m'] = { usableForSignals: false }; const r = G.evaluate(c); return (r.decision === 'AVOID' && r.failed.includes('data')) || r.decision + ' ' + r.failed; });
  await T('Signal', 'R:R below 2 is not a BUY (TP2 at 105 with SL 96)', () => { const c = base(); c.legacy.plan.tps = [{ price: 103 }, { price: 105 }]; const r = G.evaluate(c); return (r.decision === 'WATCH' && r.failed.join() === 'rr') || r.decision + ' ' + r.failed; });
  await T('Signal', 'no TP2 above entry = R:R fails with the reason', () => { const c = base(); c.legacy.plan.tps = [{ price: 106 }]; const r = G.evaluate(c); return (r.failed.includes('rr') && /No TP2/.test(r.hard.find((h) => h.id === 'rr').detail)) || JSON.stringify(r.hard.find((h) => h.id === 'rr')); });
  await T('Signal', 'CIS 65 with everything else valid = WATCH, not BUY', () => { const c = base(); c.cis = { cis: 65, cls: 'DEVELOPING', quality: 'PARTIAL' }; const r = G.evaluate(c); return (r.decision === 'WATCH' && r.failed.join() === 'cis') || r.decision + ' ' + r.failed; });
  await T('Signal', 'DEVELOPING setup with CIS ≥ 55 = WATCH', () => { const c = base(); c.mtf.verdict = 'DEVELOPING'; const r = G.evaluate(c); return r.decision === 'WATCH' || r.decision; });
  await T('Signal', 'bearish MTF = AVOID even with CIS 90', () => { const c = base(); c.cis = { cis: 90, cls: 'ELITE', quality: 'FULL' }; c.mtf.verdict = 'BEARISH'; const r = G.evaluate(c); return r.decision === 'AVOID' || r.decision; });
  await T('Signal', 'tier D or wide spread fails liquidity', () => { const c = base(); c.ticker.tier = 'D'; const a = G.evaluate(c); const d = base(); d.ticker.spreadPct = 0.5; const b = G.evaluate(d); return (a.failed.includes('liq') && b.failed.includes('liq') && a.decision === 'AVOID') || JSON.stringify([a.failed, b.failed]); });
  await T('Signal', 'stop wider than 8% fails the stop filter', () => { const c = base(); c.legacy.plan.sl = 90; c.legacy.plan.tps = [{ price: 115 }, { price: 130 }]; const r = G.evaluate(c); return r.failed.includes('stop') || r.failed; });
  await T('Signal', 'notional below the exchange minimum fails sizing', () => { const c = base(); c.riskState.equity = 10; c.filters.minNotional = 50; const r = G.evaluate(c); return (r.failed.includes('size') && /below/.test(r.hard.find((h) => h.id === 'size').detail)) || JSON.stringify(r.hard.find((h) => h.id === 'size')); });
  await T('Signal', 'risk controls blocking = not BUY', () => { const c = base(); c.riskState.todayPnl = -400; const r = G.evaluate(c); return (r.decision !== 'BUY' && r.failed.includes('risk')) || r.decision; });
  await T('Signal', 'chasing the break keeps the plan as WATCH and shows the retrace limit; timing off restores BUY', () => { const c = base(); c.timing = { label: 'CHASING', reasons: ['Price is 1.80× ATR(15M) above the break level (max 1)'], limit: { price: 98.5, src: '15M FVG', rr: 3.1 }, distAtr: 1.8 }; const r = G.evaluate(c); const c2 = base(); c2.timing = c.timing; c2.cfg = Object.assign({}, c2.cfg || {}, { requireTiming: false }); const r2 = G.evaluate(c2); return (r.decision === 'WATCH' && r.failed.join() === 'timing' && /retrace limit 98.5/.test(r.hard.find((h) => h.id === 'timing').detail) && r.plan.timing.label === 'CHASING' && r2.decision === 'BUY') || JSON.stringify([r.decision, r.failed, r2.decision, r2.failed]); });
  await T('Signal', 'spot long-only: stop above entry is rejected', () => { const c = base(); c.legacy.plan.sl = 101; const r = G.evaluate(c); return (r.decision !== 'BUY' && r.failed.includes('stop')) || r.decision; });
  return out;
}

/* ==== PHASE 6 ACCEPTANCE TESTS — synthetic inputs ==== */
async function runPhase6Tests(CORE, PF, G) {
  const out = [];
  const T = async (area, name, fn) => { try { const r = await fn(); out.push({ area, name, pass: r === true, detail: r === true ? 'ok' : String(r) }); } catch (e) { out.push({ area, name, pass: false, detail: 'threw: ' + (e && e.message || e) }); } };
  const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
  const cfg = { feePct: 0.1, slipPct: 0.05 };
  const day0 = Date.UTC(2026, 10, 1), D = 864e5;
  const J = [
    { symbol: 'AUSDT', status: 'Closed', entry: 100, sl: 95, exit: 110, qty: 10, fees: 2, openedAt: day0, closedAt: day0 + D, setup: 'EMA retest' },      // +98, R = 98/50
    { symbol: 'BUSDT', status: 'Closed', entry: 50, sl: 48, exit: 47, qty: 20, fees: 1, openedAt: day0, closedAt: day0 + 2 * D, setup: 'Zone tap' },       // −61
    { symbol: 'CUSDT', status: 'Closed', entry: 10, sl: 9, exit: 12, qty: 50, fees: 1, openedAt: day0, closedAt: day0 + 3 * D, setup: 'EMA retest' },      // +99
    { symbol: 'DUSDT', status: 'Open', entry: 20, sl: 19, qty: 100, fees: 2, narrative: 'AI', openedAt: day0 + 3 * D },
    { symbol: 'EUSDT', status: 'Open', entry: 5, sl: 4.5, qty: 200, fees: 1, narrative: 'AI', openedAt: day0 + 3 * D },
    { symbol: 'FUSDT', status: 'Open', entry: 1, sl: 0.9, qty: 1000, fees: 1, narrative: 'DEFI', openedAt: day0 + 3 * D },
    { symbol: 'GUSDT', status: 'Planned', entry: 3, sl: 2.8, tp: 3.6, qty: 10 },
    { symbol: 'HUSDT', status: 'Cancelled' },
  ];
  const px = { DUSDT: 22, EUSDT: 4.8, FUSDT: 1.1 };
  const pf = PF.portfolio(J, px, { startEquity: 10000 }, cfg, CORE, day0 + 3 * D);

  await T('Journal', 'long-only validation: stop below entry, target above, exits required', () => { const a = PF.validateEntry({ symbol: 'XUSDT', status: 'Open', entry: 10, sl: 11, qty: 1 }, CORE), b = PF.validateEntry({ symbol: 'XUSDT', status: 'Closed', entry: 10, sl: 9, qty: 1 }, CORE), c = PF.validateEntry({ symbol: 'XUSDT', status: 'Planned', entry: 10, sl: 9, tp: 12 }, CORE), d = PF.validateEntry({ symbol: 'XUSDT', status: 'Open', entry: 10, sl: 9 }, CORE); return (a.some((e) => /below entry/.test(e)) && b.some((e) => /exit/.test(e)) && c.length === 0 && d.some((e) => /quantity/.test(e))) || JSON.stringify([a, b, c, d]); });
  await T('Journal', 'non-Latin and 1-letter Binance bases are valid symbols; lower-case or non-USDT are not', () => { const ok = (s) => !PF.validateEntry({ symbol: s, status: 'Planned' }, CORE).includes('symbol must be a USDT pair'); return (ok('牛来USDT') && ok('WUSDT') && !ok('btcusdt') && !ok('BTCFDUSD')) || 'symbol rule'; });
  await T('Journal', 'trade plan becomes a Planned entry with plan levels and signal reference', () => { const t = PF.fromPlan({ symbol: 'SOLUSDT', entry: 81.34, stopLoss: 80.25, tp1: 82, tp2: 83.92, qty: 75.053, cis: 72, narrative: 'L1', setup: 'x' }, 'SOLUSDT-1', day0); return (t.status === 'Planned' && t.sl === 80.25 && t.tp === 83.92 && t.tp1 === 82 && t.reference === 'SOLUSDT-1' && PF.validateEntry(t, CORE).length === 0) || JSON.stringify(t); });
  await T('Performance', 'realized PnL, win rate, profit factor, expectancy (reused legacy journalStats)', () => { const s = pf.stats; return (near(pf.realized, 98 - 61 + 99) && s.n === 3 && near(s.winRate, 2 / 3) && near(s.profitFactor, (98 + 99) / 61) && near(s.expectancy, 136 / 3)) || JSON.stringify(s); });
  await T('Performance', 'average R multiple = mean of pnl ÷ initial risk', () => near(pf.stats.avgR, (98 / 50 + -61 / 40 + 99 / 50) / 3) || pf.stats.avgR);
  await T('Performance', 'max drawdown on the realized equity curve, in USDT and %', () => (near(pf.maxDrawdown, 61) && near(pf.maxDrawdownPct, 61 / 10098 * 100)) || [pf.maxDrawdown, pf.maxDrawdownPct].join());
  await T('Portfolio', 'unrealized PnL marks open positions to the live price, net of fees and exit costs', () => { const d = pf.open.find((p) => p.symbol === 'DUSDT'); return near(d.unreal, 100 * 2 - 2 - 100 * 22 * 0.0015) || d.unreal; });
  await T('Portfolio', 'equity = start + realized + unrealized; exposure and allocation from market value', () => { const exp = 2200 + 960 + 1100; return (near(pf.equity, 10000 + 136 + pf.unrealized) && near(pf.exposure, exp) && near(pf.open[0].allocPct, 2200 / pf.equity * 100)) || JSON.stringify([pf.equity, pf.exposure]); });
  await T('Portfolio', 'sector concentration by narrative with HHI', () => { const ai = pf.sector.find((x) => x.narrative === 'AI'); return (near(ai.share, 3160 / 4260) && near(pf.sectorHHI, ((3160 / 4260) ** 2 + (1100 / 4260) ** 2) * 10000)) || JSON.stringify(pf.sector); });
  await T('Portfolio', 'today PnL counts only trades closed since the start of the day', () => near(pf.todayPnl, 99) || pf.todayPnl);
  await T('Portfolio', 'open risk per position = qty × (entry − stop) + stop exit costs + fees paid', () => { const f = pf.open.find((p) => p.symbol === 'FUSDT'); return near(f.riskAmt, 1000 * 0.1 + 1000 * 0.9 * 0.0015 + 1) || f.riskAmt; });
  await T('Portfolio', 'missing live price is listed, never valued at zero', () => { const p = PF.portfolio(J, { DUSDT: 22 }, { startEquity: 10000 }, cfg, CORE, 0); return (p.missingPrices.join() === 'EUSDT,FUSDT' && p.open.find((x) => x.symbol === 'EUSDT').unreal === null) || JSON.stringify(p.missingPrices); });
  await T('Risk link', 'derived risk state feeds the Phase 5 risk gate (open slots, narrative cap, daily PnL)', () => { const rs = PF.riskState(pf); const c = G.normalizeCfg({ maxPerNarrative: 2 }).cfg; const g = G.riskGate(rs, c, 'ZUSDT', 'AI', 10); return (rs.source === 'journal' && rs.open.length === 3 && near(rs.equity, pf.equity) && !g.ok && g.blocks.includes('narr')) || JSON.stringify([rs, g.blocks]); });
  await T('Risk link', 'no starting equity = no derived state (manual mode stays)', () => PF.riskState(PF.portfolio(J, px, {}, cfg, CORE, 0)) === null || 'derived');
  await T('Correlation', 'identical return paths correlate 1, mirrored −1, too short = null', () => { const a = Array.from({ length: 40 }, (_, i) => 100 * Math.exp(0.01 * Math.sin(i))), b = a.map((x) => x * 2), c = a.map((x) => 1e4 / x); const m = PF.corrMatrix({ A: a, B: b, C: c }); return (near(m.A.B, 1, 1e-9) && near(m.A.C, -1, 1e-9) && PF.corr([1, 2], [1, 2]) === null) || JSON.stringify(m.A); });
  await T('Correlation', 'correlated exposure sums positions with a partner at ≥ 0.7', () => { const m = { A: { B: 0.8, C: 0.1 }, B: { A: 0.8, C: 0.2 }, C: { A: 0.1, B: 0.2 } }; const r = PF.correlatedExposure([{ symbol: 'A', value: 100 }, { symbol: 'B', value: 50 }, { symbol: 'C', value: 70 }], m, 1000); return (r.symbols.join() === 'A,B' && r.value === 150 && r.pctEquity === 15) || JSON.stringify(r); });
  await T('Journal', 'CSV export keeps the legacy column set and escapes commas and quotes', () => { const csv = CORE.toCSV([{ id: '1', symbol: 'AUSDT', status: 'Closed', note: 'a, "b"' }]); const p = CORE.parseCSV(csv); return (p.header.join() === CORE.JCOLS.join() && p.rows[0].note === 'a, "b"') || csv; });
  return out;
}

/* ==== PHASE 7 ACCEPTANCE TESTS — synthetic inputs ==== */
async function runPhase7Tests(CORE, QUANT, BT, SIG, ENT) {
  const out = [];
  const T = async (area, name, fn) => { try { const r = await fn(); out.push({ area, name, pass: r === true, detail: r === true ? 'ok' : String(r) }); } catch (e) { out.push({ area, name, pass: false, detail: 'threw: ' + (e && e.message || e) }); } };
  const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
  const H = 36e5, Q = 9e5;
  const cand = (symbol, h0, h1, r, quant, open = false) => ({ symbol, entryT: h0 * H, exitT: h1 * H, r, quant, open });

  await T('Data', 'kline pages merge by open time, sorted, unclosed candle dropped', () => { const k = (t, ct) => [t, '1', '1', '1', '1', '1', ct, '1']; const m = BT.mergePages([[k(2, 2.9), k(3, 3.9)], [k(1, 1.9), k(2, 2.9)], [k(4, 9)]], 5); return m.map((x) => x[0]).join() === '1,2,3' || m.map((x) => x[0]).join(); });
  await T('Data', 'page plan covers the requested range newest-first, 1,000 candles a page', () => { const e = BT.pagePlan(0, 2500 * Q, Q); return (e.length === 3 && e[0] === 2500 * Q && e[2] === 500 * Q) || e.join(); });
  await T('Statistics', 'win rate, expectancy, profit factor, max drawdown and t-statistic', () => { const s = BT.stats([2, -1, -1, 3, -1]); const sd = Math.sqrt(((2 - 0.4) ** 2 + 3 * (-1.4) ** 2 + (3 - 0.4) ** 2) / 4); return (near(s.winRate, 0.4) && near(s.avgR, 0.4) && near(s.pf, 5 / 3) && near(s.maxDDR, 2) && near(s.tStat, 0.4 / (sd / Math.sqrt(5)))) || JSON.stringify(s); });
  await T('Portfolio', 'one position per symbol: an overlapping candidate on the same pair is skipped', () => { const s = BT.simulate([cand('A', 0, 5, 1, 60), cand('A', 2, 6, -1, 60), cand('A', 5, 7, 2, 60)]); return (s.n === 2 && near(s.totalR, 3) && s.skippedBusy === 1) || JSON.stringify([s.n, s.totalR, s.skippedBusy]); });
  await T('Portfolio', 'max open positions is enforced across pairs', () => { const s = BT.simulate([cand('A', 0, 9, 1, 60), cand('B', 1, 9, 1, 60), cand('C', 2, 9, 1, 60)], { maxOpen: 2 }); return (s.n === 2 && s.skippedMax === 1) || JSON.stringify(s); });
  await T('Portfolio', 'Quant gate filters candidates; unfinished trades never enter the statistics', () => { const s = BT.simulate([cand('A', 0, 1, 1, 80), cand('B', 0, 1, -1, 30), cand('C', 0, 1, 5, 90, true)], { minQuant: 50 }); return (s.n === 1 && s.stillOpen === 1 && near(s.totalR, 1)) || JSON.stringify([s.n, s.stillOpen, s.totalR]); });
  await T('Portfolio', 'compounded return at 1% risk per trade', () => { const s = BT.simulate([cand('A', 0, 1, 2, 60), cand('A', 1, 2, -1, 60)], { riskPct: 1 }); return near(s.compoundPct, (1.02 * 0.99 - 1) * 100) || s.compoundPct; });
  // walk-forward: candidates with quant ≥ 60 win, the rest lose
  const wfC = []; for (let h = 0; h < 500; h += 2) wfC.push(cand('S' + (h % 10), h, h + 1, (h / 2) % 3 === 0 ? 2 : -1, (h / 2) % 3 === 0 ? 70 : 45));
  await T('Walk-forward', 'gate chosen in-sample and applied unchanged out-of-sample', () => { const w = BT.walkForward(wfC, { from: 0, to: 500 * H, folds: 4, minTrain: 5 }); return (w.folds.every((f) => f.chosen >= 50 && f.chosen <= 70) && w.oos.n > 0 && w.oos.avgR > 1.9) || JSON.stringify(w.folds.map((f) => [f.chosen, f.os.n, f.os.avgR])); });
  await T('Walk-forward', 'no look-ahead: changing out-of-sample outcomes never changes the chosen gate', () => {
    const a = BT.walkForward(wfC, { from: 0, to: 500 * H, folds: 4, minTrain: 5 });
    const b = BT.walkForward(wfC.map((c) => (c.entryT >= 200 * H ? Object.assign({}, c, { r: -c.r }) : c)), { from: 0, to: 500 * H, folds: 4, minTrain: 5 });
    return (a.folds[0].chosen === b.folds[0].chosen && a.folds[0].is.totalR === b.folds[0].is.totalR && a.folds[0].os.totalR !== undefined) || JSON.stringify([a.folds[0], b.folds[0]]);
  });
  await T('Walk-forward', 'verdict is conservative: < 30 OOS trades = NOT PROVEN; negative = NO EDGE; t < 2 = NOT SIGNIFICANT', () => { const v1 = BT.verdict(BT.stats([1, 1, 1]), 1), v2 = BT.verdict(BT.stats(Array(40).fill(-0.2)), 1), v3 = BT.verdict(BT.stats(Array.from({ length: 40 }, (_, i) => (i % 2 ? 2.1 : -2))), 1), v4 = BT.verdict(BT.stats(Array.from({ length: 40 }, (_, i) => (i % 2 ? 2 : -0.5))), 0.9); return (v1.code === 'NOT PROVEN' && v2.code === 'NO EDGE' && v3.code === 'NOT SIGNIFICANT' && v4.code === 'PASSES') || [v1.code, v2.code, v3.code, v4.code].join(); });
  // synthetic M15 candles for paper trading
  const mk = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1, ct: t + Q - 1, closed: true });
  const plan = (entryType) => ({ symbol: 'XUSDT', decision: 'BUY', candleAt: 0, signalAt: Q, plan: { entry: 100, stopLoss: 98, tp1: 102, tp2: 104, entryType, rrTP2: 2, cis: 72 } });
  await T('Paper', 'market plan fills at the first M15 open after the signal candle', () => { const p = BT.paperFromPlan(plan('Market/limit near current price'), Q); const u = BT.paperUpdate(p, [mk(0, 99, 99, 99, 99), mk(Q, 100.5, 101, 100.2, 100.8)]); return (u.status === 'OPEN' && u.entry === 100.5 && u.entryT === Q) || JSON.stringify(u); });
  await T('Paper', 'target hit closes with net R after fees and slippage', () => { const p = BT.paperFromPlan(plan('Market'), Q); const u = BT.paperUpdate(p, [mk(Q, 100, 101, 99.5, 100.5), mk(2 * Q, 100.5, 104.5, 100.4, 104)]); const cst = 0.0015; return (u.status === 'CLOSED' && u.reason === 'Target' && near(u.r, (104 - 100 - 100 * cst - 104 * cst) / 2)) || JSON.stringify(u); });
  await T('Paper', 'stop and target in the same candle counts as the stop', () => { const p = BT.paperFromPlan(plan('Market'), Q); const u = BT.paperUpdate(p, [mk(Q, 100, 104.5, 97.5, 101)]); return (u.status === 'CLOSED' && u.reason === 'Stop loss' && u.r < -1) || JSON.stringify(u); });
  await T('Paper', 'limit plan waits for price to reach the entry, then fills at the better of entry and open', () => { const p = BT.paperFromPlan(plan('Limit at zone top'), Q); const a = BT.paperUpdate(p, [mk(Q, 101, 102, 100.5, 101.5)]); const b = BT.paperUpdate(p, [mk(Q, 101, 102, 100.5, 101.5), mk(2 * Q, 99.8, 100.2, 99.5, 100)]); return (a.status === 'PENDING' && b.status === 'OPEN' && b.entry === 99.8) || JSON.stringify([a.status, b]); });
  await T('Paper', 'limit plan expires when the entry is never reached', () => { const p = BT.paperFromPlan(plan('Limit'), Q, { expiryBars: 2 }); const u = BT.paperUpdate(p, [mk(Q, 101, 102, 100.5, 101), mk(2 * Q, 101, 102, 100.5, 101), mk(3 * Q, 101, 102, 100.5, 101)]); return (u.status === 'EXPIRED') || JSON.stringify(u); });
  await T('Paper', 'candles before the signal are ignored (no look-back fills)', () => { const p = BT.paperFromPlan(plan('Limit'), Q); const u = BT.paperUpdate(p, [mk(0, 99, 99, 95, 96)]); return u.status === 'PENDING' || JSON.stringify(u); });
  await T('Paper', 'plans without a valid stop or a target above entry are not paper-traded', () => BT.paperFromPlan({ symbol: 'X', decision: 'BUY', plan: { entry: 100, stopLoss: 101, tp2: 110 } }, 0) === null && BT.paperFromPlan({ symbol: 'X', decision: 'BUY', plan: { entry: 100, stopLoss: 99, tp1: 99.5 } }, 0) === null || 'accepted');
  await T('Paper', 'statistics split by cohort (BUY vs WATCH)', () => { const s = BT.paperStats([{ cohort: 'BUY', status: 'CLOSED', r: 2, exitT: 1 }, { cohort: 'BUY', status: 'OPEN' }, { cohort: 'WATCH', status: 'CLOSED', r: -1, exitT: 1 }]); return (s.BUY.n === 1 && s.BUY.open === 1 && s.WATCH.avgR === -1) || JSON.stringify(s); });

  // replay on a synthetic uptrend with pullbacks: closed candles only and identical decisions on a truncated history
  const series = (() => {
    const mkTf = (tfMs, n, endT) => { const a = []; for (let k = 0; k < n; k++) { const t = endT - (n - k) * tfMs, x = t / 36e5; const base = 100 * Math.exp(x / 4000) * (1 + 0.03 * Math.sin(x / 9) + 0.012 * Math.sin(x / 2.3)); const o = base, c = base * (1 + 0.002 * Math.sin(x * 1.7)), h = Math.max(o, c) * 1.003, l = Math.min(o, c) * 0.997; a.push({ t, o, h, l, c, v: 100 + 50 * Math.abs(Math.sin(x)), qv: c * 100, ct: t + tfMs - 1, closed: true }); } return a; };
    const end = 2000 * 36e5 * 10;
    return { '1d': mkTf(864e5, 400, end), '4h': mkTf(144e5, 900, end), '1h': mkTf(36e5, 1500, end), '15m': mkTf(Q, 3000, end) };
  })();
  const runR = (ser, endT) => { const r = BT.createReplay(ser, null, { startT: ser['15m'][400].ct, endT, P: CORE.DEFAULT_PARAMS }, CORE, QUANT); while (!r.done) r.step(400); return r.result(); };
  await T('Replay', 'every replay step reaches a verdict and the funnel accounts for all steps', () => { const r = runR(series); const f = r.funnel; const sum = f.noData + f.macroOrH4 + f.noSetup + f.noEntry + f.confirmed; return (f.steps === r.bars && sum === f.steps) || JSON.stringify(f); });
  await T('Replay', 'no look-ahead: decisions before time T are identical with candles after T removed', () => {
    const full = runR(series), cut = series['15m'][2000].ct;
    const trunc = Object.fromEntries(Object.entries(series).map(([k, a]) => [k, a.filter((x) => x.ct <= cut)]));
    const part = runR(trunc);
    const sig = (c) => [c.signalT, c.entryT, c.entry, c.sl, c.tp, c.quant && c.quant.toFixed(6)].join('|');
    const A = full.cands.filter((c) => c.entryT <= cut).map(sig).join(';'), B = part.cands.filter((c) => c.entryT <= cut).map(sig).join(';');
    return (full.funnel.confirmed > 0 && A === B) || `confirmed ${full.funnel.confirmed}, full ${full.cands.length} vs truncated ${part.cands.length}`;
  });
  await T('Replay', 'market plans fill at the next M15 open, limit plans only at or below their entry; R:R re-checked at the fill', () => { const r = runR(series); const m = series['15m']; return r.cands.every((c) => { const j = m.findIndex((k) => k.t === c.entryT); const ok = c.kind === 'MARKET' ? (j > 0 && m[j - 1].ct === c.signalT && c.entry === m[j].o) : (j > 0 && m[j].t > c.signalT && c.entry <= c.planEntry && m[j].l <= c.planEntry); return ok && c.sl < c.entry && c.tp > c.entry && c.fillRR >= CORE.DEFAULT_PARAMS.minRR; }) || 'bad fill'; });
  await T('Walk-forward', 'variants: the fold picks the variant that won in-sample; a losing best stands aside when allowed', () => {
    const c = []; for (let h = 0; h < 500; h += 2) { c.push(Object.assign(cand('S' + (h % 10), h, h + 1, h < 300 ? 1 : -1, 60), { variant: 'a' })); c.push(Object.assign(cand('S' + (h % 10), h, h + 1, -0.5, 60), { variant: 'b' })); }
    const w = BT.walkForward(c, { from: 0, to: 500 * H, folds: 4, minTrain: 5, variants: ['a', 'b'], grid: [null] });
    const all = c.map((x) => Object.assign({}, x, { r: -Math.abs(x.r) })), w2 = BT.walkForward(all, { from: 0, to: 500 * H, folds: 4, minTrain: 5, variants: ['a', 'b'], grid: [null], allowFlat: true });
    return (w.folds[0].chosenVariant === 'a' && w2.flatFolds === 4 && w2.oos.n === 0) || JSON.stringify([w.folds.map((f) => f.chosenVariant), w2.flatFolds]);
  });
  await T('Signals', 'NO EDGE from the latest historical test blocks BUY when required; other verdicts and the switch-off do not', () => {
    if (!SIG) return 'no SIG';
    const base = { symbol: 'XUSDT', nowMs: 0, cis: { cis: 80, cls: 'STRONG', quality: 'FULL' } };
    const run = (v, req) => { const cfg = SIG.normalizeCfg({ equity: 10000, requireEdge: req }).cfg; const e = SIG.evaluate(Object.assign({}, base, { cfg, validation: v })); const h = e.hard.find((x) => x.id === 'edge'); return h ? h.pass : 'absent'; };
    return (run({ code: 'NO EDGE', why: 'x' }, true) === false && run({ code: 'NOT PROVEN', why: 'x' }, true) === true && run({ code: 'NO EDGE', why: 'x' }, false) === 'absent' && run(null, true) === 'absent') || [run({ code: 'NO EDGE', why: 'x' }, true), run({ code: 'NOT PROVEN', why: 'x' }, true), run({ code: 'NO EDGE', why: 'x' }, false), run(null, true)].join();
  });
  await T('Outcomes', 'one episode per unbroken run of the same decision per pair', () => { const e = BT.episodes([{ symbol: 'A', decision: 'AVOID', candleAt: 0 }, { symbol: 'A', decision: 'AVOID', candleAt: 9e5 }, { symbol: 'A', decision: 'WATCH', candleAt: 18e5 }, { symbol: 'A', decision: 'AVOID', candleAt: 27e5 }, { symbol: 'B', decision: 'AVOID', candleAt: 0 }]); return (e.length === 4 && e.filter((x) => x.symbol === 'A').map((x) => x.decision).join() === 'AVOID,WATCH,AVOID') || JSON.stringify(e); });
  await T('Outcomes', 'returns from the decision candle close; unreached horizons stay null', () => { const m = []; for (let i = 0; i < 300; i++) m.push({ t: i * Q, o: 100, h: 100 + i * 0.1 + 1, l: 100 - 1, c: 100 + i * 0.1, ct: i * Q + Q - 1 }); const o = BT.outcome(m, 0); return (near(o.ref, 100) && near(o.d1.ret, (100 + 96 * 0.1) / 100 * 100 - 100, 1e-9) && near(o.d3.up, (100 + 288 * 0.1 + 1 - 100), 1e-9) && o.d7 === null && o.complete === false) || JSON.stringify(o); });
  await T('Outcomes', 'cohort statistics: average return and share of +5% / +10% excursions', () => { const r = (dec, ret, up) => ({ decision: dec, outcome: { d1: { ret, up, dn: -1 }, d3: null, d7: null } }); const s = BT.outcomeStats([r('AVOID', 2, 12), r('AVOID', -4, 1), r('WATCH', 1, 6)]); return (s.AVOID.d1.n === 2 && near(s.AVOID.d1.avgRet, -1) && near(s.AVOID.d1.up10, 0.5) && s.WATCH.d1.up5 === 1 && s.BUY.d1.n === 0) || JSON.stringify(s); });
  await T('Signals', 'CIS inputs older than the limit fail the data filter, fresh ones pass', () => {
    if (!SIG) return 'no SIG';
    const cfg = SIG.normalizeCfg({ equity: 10000 }).cfg, q = { usableForSignals: true }, base = { symbol: 'XUSDT', nowMs: 0, cfg, cis: { cis: 80, cls: 'STRONG', quality: 'FULL' }, quality: { '1d': q, '4h': q, '1h': q, '15m': q }, ticker: { quality: 'FRESH' }, mtf: { verdict: 'BULLISH CONFIRMED' } };
    const f = (age) => SIG.evaluate(Object.assign({}, base, { inputsAgeH: age })).hard.find((x) => x.id === 'data');
    return (f(2).pass === true && f(7).pass === false && /7\.0 h old/.test(f(7).detail) && cfg.maxInputAgeH === 6) || JSON.stringify([f(2), f(7)]);
  });
  await T('Signals', 'live plan status from the current price: zone, above entry (chase), targets, stop', () => {
    if (!SIG) return 'no SIG';
    const cfg = SIG.normalizeCfg({}).cfg, p = { entry: 100, stopLoss: 96, tp1: 104, tp2: 110 };
    const st = (px) => SIG.liveStatus(p, px, CORE, cfg);
    const a = st(100.2), b = st(103), c = st(105), d = st(111), e = st(95.9), f = st(98);
    return (a.state === 'IN ENTRY ZONE' && b.state === 'ABOVE ENTRY' && b.chase === true && c.state === 'PAST TP1' && d.state === 'PAST TP2' && e.state === 'AT OR BELOW STOP' && f.state === 'IN ENTRY ZONE' && near(a.toStop, (96 / 100.2 - 1) * 100) && SIG.liveStatus(p, 0, CORE, cfg) === null) || JSON.stringify([a, b, c, d, e, f].map((x) => x.state));
  });
  await T('Signals', 'entry timing is a hard filter: CHASING keeps a plan as WATCH, ON TIME passes; expired live plans are flagged', () => {
    if (!SIG) return 'no SIG';
    const cfg = SIG.normalizeCfg({}).cfg;
    const p = { entry: 100, stopLoss: 96, tp1: 104, tp2: 110 };
    const a = SIG.liveStatus(p, 105, CORE, cfg), b = SIG.liveStatus(p, 100.1, CORE, cfg);
    const off = SIG.normalizeCfg({ requireTiming: 'false' }).cfg;
    return (cfg.requireTiming === true && off.requireTiming === false && a.expired === true && b.expired === false) || JSON.stringify({ a, b });
  });
  await T('Entries', 'momentum burst: +5% in 1 h on ≥ 3× volume near the high fires; low volume or a close at the low does not', () => {
    if (!ENT || !ENT.burst) return 'no ENT.burst';
    const mk = (lastQv, lastC) => { const a = []; for (let i = 0; i < 110; i++) a.push({ t: i * 9e5, ct: (i + 1) * 9e5 - 1, o: 100, h: 100.5, l: 99.5, c: 100, v: 1, qv: 100 });
      [102, 104, 106, lastC].forEach((c, k) => { const i = 106 + k, p = a[i - 1].c; a[i] = { t: i * 9e5, ct: (i + 1) * 9e5 - 1, o: p, h: Math.max(p, c) + 0.2, l: Math.min(p, c) - 0.2, c, v: 1, qv: lastQv }; });
      return ENT.prep(a, CORE, QUANT); };
    const hot = ENT.burst(mk(500, 108), 109), cold = ENT.burst(mk(150, 108), 109), weak = ENT.burst(mk(500, 101), 109);
    return (hot && near(hot.ret, 108 / 100 - 1) && hot.volX > 3 && hot.sl < hot.lo && cold === null && weak === null) || JSON.stringify({ hot, cold, weak });
  });
  if (ENT) {
    await T('Entry rules', 'target sits at exactly the minimum net R:R after fees and slippage', () => { const tp = ENT.targetFor(100, 97, 2, 0.1, 0.05); return near(CORE.rr(100, 97, tp, 0.1, 0.05).net, 2, 1e-9) || CORE.rr(100, 97, tp, 0.1, 0.05).net; });
    const P7 = Object.assign({}, CORE.DEFAULT_PARAMS);
    // synthetic trending series with swings; volume rises on up-moves
    const eser = (() => { const f = (x) => 100 * Math.exp(x / 3000) * (1 + 0.05 * Math.sin(x / 20)); const end = 36e5 * 20000;
      const mkTf = (tfMs, n) => { const a = []; for (let k = 0; k < n; k++) { const t = end - (n - k) * tfMs, x = t / 36e5, o = f(x), c = f(x + tfMs / 36e5), v = 100 * (1 + Math.max(0, (c - o) / o * 300)); a.push({ t, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v, qv: c * v, ct: t + tfMs - 1, closed: true }); } return a; };
      return { '1d': mkTf(864e5, 400), '4h': mkTf(144e5, 900), '1h': mkTf(36e5, 2000), '15m': mkTf(Q, 4000) }; })();
    const runE = (ser, endT) => ENT.replay(ser, null, { startT: ser['15m'][400].ct, endT, P: P7 }, CORE, QUANT);
    await T('Entry rules', 'decisions on closed bars only: H4 rules fire only at H4 closes, entry at the next M15 open', () => { const r = runE(eser); const m = eser['15m'], h4 = new Set(eser['4h'].map((x) => x.ct)); return (r.cands.length > 0 && r.cands.every((c) => { const j = m.findIndex((k) => k.t === c.entryT); return m[j].t === c.signalT + 1 && c.entry === m[j].o && (c.variant === 'RS_LEADER' || h4.has(c.signalT)); })) || `n=${r.cands.length}`; });
    await T('Entry rules', 'no look-ahead: signals before T are identical when candles after T are removed', () => {
      const full = runE(eser), cut = eser['15m'][2500].ct, trunc = Object.fromEntries(Object.entries(eser).map(([k, a]) => [k, a.filter((x) => x.ct <= cut)]));
      const part = runE(trunc), sig = (c) => [c.variant, c.signalT, c.entry, c.sl.toFixed(8)].join('|');
      return (full.cands.length > 0 && full.cands.filter((c) => c.entryT <= cut).map(sig).join() === part.cands.filter((c) => c.entryT <= cut).map(sig).join()) || 'differs';
    });
  }
  return out;
}
const API = { version: '7.1.0-phase7', CORE, DATA, ATTN, NARR, QUANT, FLOW, SIG, PORT, BT: BT.bind(CORE), ENT, runLegacyTests: () => runEngineTests(CORE), runPhase1Tests: () => runPhase1Tests(CORE, DATA), runPhase2Tests: () => runPhase2Tests(CORE, ATTN, NARR), runPhase3Tests: () => runPhase3Tests(CORE, QUANT), runPhase4Tests: () => runPhase4Tests(FLOW), runPhase5Tests: () => runPhase5Tests(CORE, SIG), runPhase6Tests: () => runPhase6Tests(CORE, PORT, SIG), runPhase7Tests: () => runPhase7Tests(CORE, QUANT, BT.bind(CORE), SIG, ENT) };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.CISEngine = API;
})(typeof window !== 'undefined' ? window : globalThis);
