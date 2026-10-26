/*
 * Décodeur — moteur d'analyse technique, sans IA.
 *
 * Reçoit des bougies (ouverture, plus haut, plus bas, clôture) lues sur une ou plusieurs captures,
 * calcule indicateurs, structure, niveaux, figures et chandeliers, en tire un score de confluence,
 * des scénarios chiffrés, puis rédige chaque point en version technique et en version simple.
 * Le résultat a la même forme que celle qu'affiche l'interface.
 */
(function (root) {
  "use strict";

  var TF_ORDER = ["M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30", "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1"];
  var TF_LABEL = { M1: "1 minute", M5: "5 minutes", M15: "15 minutes", M30: "30 minutes", H1: "1 heure", H4: "4 heures", D1: "1 jour", W1: "1 semaine" };

  // ---------- Outils numériques ----------

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function last(a, k) { return a[a.length - 1 - (k || 0)]; }
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }

  function ema(values, period) {
    var out = new Array(values.length), k = 2 / (period + 1), e = values[0];
    var seedN = Math.min(period, values.length);
    var seed = mean(values.slice(0, seedN));
    for (var i = 0; i < values.length; i++) {
      if (i < seedN - 1) { out[i] = null; continue; }
      if (i === seedN - 1) { e = seed; out[i] = e; continue; }
      e = values[i] * k + e * (1 - k);
      out[i] = e;
    }
    return out;
  }

  function rsi(closes, period) {
    var out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    var g = 0, l = 0;
    for (var i = 1; i <= period; i++) {
      var d = closes[i] - closes[i - 1];
      if (d > 0) g += d; else l -= d;
    }
    g /= period; l /= period;
    out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (i = period + 1; i < closes.length; i++) {
      d = closes[i] - closes[i - 1];
      g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
      l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  function atr(c, period) {
    var tr = c.map(function (k, i) {
      if (i === 0) return k.h - k.l;
      var pc = c[i - 1].c;
      return Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
    });
    var p = Math.min(period, tr.length);
    var a = mean(tr.slice(0, p));
    for (var i = p; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
    return a;
  }

  function macd(closes) {
    if (closes.length < 35) return null;
    var e12 = ema(closes, 12), e26 = ema(closes, 26);
    var line = closes.map(function (_, i) { return e12[i] !== null && e26[i] !== null ? e12[i] - e26[i] : null; });
    var valid = line.filter(function (v) { return v !== null; });
    var sig = ema(valid, 9);
    var hist = valid.map(function (v, i) { return sig[i] === null ? null : v - sig[i]; });
    return { line: last(valid), signal: last(sig), hist: last(hist), histPrev: last(hist, 1) };
  }

  function slope(points) {
    var n = points.length;
    if (n < 2) return 0;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    points.forEach(function (p) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; });
    var den = n * sxx - sx * sx;
    return den ? (n * sxy - sx * sy) / den : 0;
  }

  function lineAt(points, x) {
    var s = slope(points);
    var mx = mean(points.map(function (p) { return p.x; })), my = mean(points.map(function (p) { return p.y; }));
    return my + s * (x - mx);
  }

  function swings(c, k) {
    var highs = [], lows = [];
    for (var i = k; i < c.length - k; i++) {
      var isH = true, isL = true;
      for (var j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (c[j].h > c[i].h || (j > i && c[j].h === c[i].h)) isH = false;
        if (c[j].l < c[i].l || (j > i && c[j].l === c[i].l)) isL = false;
      }
      if (isH) highs.push({ i: i, p: c[i].h });
      if (isL) lows.push({ i: i, p: c[i].l });
    }
    return { highs: highs, lows: lows };
  }

  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    var e = Math.pow(10, Math.floor(Math.log10(raw)));
    var b = raw / e;
    return (b <= 1 ? 1 : b <= 2 ? 2 : b <= 5 ? 5 : 10) * e;
  }

  // ---------- Briques d'analyse ----------

  function analyseSeries(candles, decimals) {
    var c = candles;
    var n = c.length;
    var closes = c.map(function (k) { return k.c; });
    var tick = Math.pow(10, -decimals);
    var avgRange = mean(c.map(function (k) { return k.h - k.l; }));
    var A = Math.max(atr(c, 14), avgRange * 0.2, tick);
    var e20 = ema(closes, Math.min(20, Math.max(2, n - 1)));
    var e50 = n >= 55 ? ema(closes, 50) : null;
    var r = rsi(closes, 14);
    var m = macd(closes);
    var sw = swings(c, n >= 60 ? 3 : 2);
    var price = last(closes);

    // Structure des sommets et des creux
    var H = sw.highs.slice(-2), L = sw.lows.slice(-2), dir = 0, code = "indéterminée";
    if (H.length === 2 && L.length === 2) {
      var hh = H[1].p > H[0].p, hl = L[1].p > L[0].p;
      if (hh && hl) { dir = 1; code = "haussière"; }
      else if (!hh && !hl) { dir = -1; code = "baissière"; }
      else code = hh ? "en élargissement" : "en compression";
    }
    var win = c.slice(-Math.min(40, n));
    var regSlope = slope(win.map(function (k, i) { return { x: i, y: k.c }; })) / A;

    // Niveaux : regroupement des sommets et creux proches, chiffres ronds, extrêmes de la zone visible
    var tol = Math.max(0.35 * A, 2 * tick);
    var cands = [];
    sw.highs.forEach(function (s) { cands.push({ p: s.p, i: s.i, kind: "sommet" }); });
    sw.lows.forEach(function (s) { cands.push({ p: s.p, i: s.i, kind: "creux" }); });
    var hiAll = Math.max.apply(null, c.map(function (k) { return k.h; }));
    var loAll = Math.min.apply(null, c.map(function (k) { return k.l; }));
    cands.push({ p: hiAll, i: -1, kind: "extrême haut" });
    cands.push({ p: loAll, i: -1, kind: "extrême bas" });
    cands.sort(function (a, b) { return a.p - b.p; });
    var clusters = [];
    cands.forEach(function (k) {
      var cl = clusters[clusters.length - 1];
      if (cl && k.p - cl.max <= tol) { cl.items.push(k); cl.max = k.p; }
      else clusters.push({ items: [k], max: k.p });
    });
    var round = niceStep(A * 3);
    var levels = clusters.map(function (cl) {
      var pts = cl.items.filter(function (k) { return k.kind === "sommet" || k.kind === "creux"; });
      var p = mean(cl.items.map(function (k) { return k.p; }));
      var extreme = cl.items.some(function (k) { return k.kind.indexOf("extrême") === 0; });
      var nearRound = Math.round(p / round) * round;
      var isRound = Math.abs(nearRound - p) <= tol;
      var score = pts.length + (extreme ? 0.5 : 0) + (isRound ? 0.5 : 0);
      return { p: p, touches: pts.length, extreme: extreme, round: isRound, roundValue: nearRound, score: score,
        kinds: cl.items.map(function (k) { return k.kind; }) };
    });
    // Chiffres ronds proches du prix sans autre niveau à côté
    for (var rv = Math.ceil((price - 3 * A) / round) * round; rv <= price + 3 * A; rv += round) {
      if (rv < loAll - A || rv > hiAll + A) continue;
      if (!levels.some(function (l) { return Math.abs(l.p - rv) <= tol; })) {
        levels.push({ p: rv, touches: 0, extreme: false, round: true, roundValue: rv, score: 0.5, kinds: ["chiffre rond"] });
      }
    }
    var gapMin = 0.15 * A;
    var res = levels.filter(function (l) { return l.p > price + gapMin; }).sort(function (a, b) { return a.p - b.p; }).slice(0, 3);
    var sup = levels.filter(function (l) { return l.p < price - gapMin; }).sort(function (a, b) { return b.p - a.p; }).slice(0, 3);
    [res, sup].forEach(function (list) {
      list.forEach(function (l) { l.force = l.score >= 3 ? "forte" : l.score >= 2 ? "moyenne" : "faible"; });
    });

    // Figures chartistes
    var figures = [];
    var hs = sw.highs.slice(-3), ls = sw.lows.slice(-3);
    if (hs.length >= 2 && ls.length >= 2) {
      var sH = slope(hs.map(function (s) { return { x: s.i, y: s.p }; })) / A;
      var sL = slope(ls.map(function (s) { return { x: s.i, y: s.p }; })) / A;
      var th = 0.03;
      var up = function (s) { return s > th; }, down = function (s) { return s < -th; }, flat = function (s) { return !up(s) && !down(s); };
      var upper = lineAt(hs.map(function (s) { return { x: s.i, y: s.p }; }), n - 1);
      var lower = lineAt(ls.map(function (s) { return { x: s.i, y: s.p }; }), n - 1);
      var shape = null;
      if (up(sH) && up(sL)) shape = sL > sH * 1.4 ? "biseau ascendant" : "canal ascendant";
      else if (down(sH) && down(sL)) shape = Math.abs(sH) > Math.abs(sL) * 1.4 ? "biseau descendant" : "canal descendant";
      else if (flat(sH) && flat(sL)) shape = "range";
      else if (down(sH) && up(sL)) shape = "triangle symétrique";
      else if (flat(sH) && up(sL)) shape = "triangle ascendant";
      else if (down(sH) && flat(sL)) shape = "triangle descendant";
      else if (up(sH) && down(sL)) shape = "élargissement";
      // Figure retenue seulement si ses bornes encadrent à peu près le prix et restent proches
      var plausible = upper > lower && upper >= price - A && lower <= price + A && upper - price <= 5 * A && price - lower <= 5 * A;
      if (shape && plausible) figures.push({ kind: shape, upper: upper, lower: lower });
    }
    // Double sommet / double creux : les deux points extrêmes récents, séparés par un vrai creux (ou sommet),
    // et le prix déjà reparti dans l'autre sens.
    var recentFrom = Math.max(0, n - 60);
    var rHighs = sw.highs.filter(function (s) { return s.i >= recentFrom; });
    var rLows = sw.lows.filter(function (s) { return s.i >= recentFrom; });
    if (rHighs.length >= 2) {
      var top1 = rHighs.reduce(function (a, b) { return b.p > a.p ? b : a; });
      var twin = rHighs.filter(function (s) { return s !== top1 && Math.abs(s.p - top1.p) <= 0.5 * A && Math.abs(s.i - top1.i) >= 5; })
        .sort(function (a, b) { return Math.abs(a.p - top1.p) - Math.abs(b.p - top1.p); })[0];
      if (twin) {
        var hA = top1.i < twin.i ? top1 : twin, hB = top1.i < twin.i ? twin : top1;
        var trough = Math.min.apply(null, c.slice(hA.i, hB.i + 1).map(function (k) { return k.l; }));
        if (Math.min(hA.p, hB.p) - trough >= 1.2 * A && hB.i >= n - 30 && price < hB.p - 0.5 * A) {
          figures.push({ kind: "double sommet", top: (hA.p + hB.p) / 2, neck: trough, confirmed: price < trough });
        }
      }
    }
    if (rLows.length >= 2) {
      var bot1 = rLows.reduce(function (a, b) { return b.p < a.p ? b : a; });
      var twinL = rLows.filter(function (s) { return s !== bot1 && Math.abs(s.p - bot1.p) <= 0.5 * A && Math.abs(s.i - bot1.i) >= 5; })
        .sort(function (a, b) { return Math.abs(a.p - bot1.p) - Math.abs(b.p - bot1.p); })[0];
      if (twinL) {
        var lA = bot1.i < twinL.i ? bot1 : twinL, lB = bot1.i < twinL.i ? twinL : bot1;
        var crest = Math.max.apply(null, c.slice(lA.i, lB.i + 1).map(function (k) { return k.h; }));
        if (crest - Math.max(lA.p, lB.p) >= 1.2 * A && lB.i >= n - 30 && price > lB.p + 0.5 * A) {
          figures.push({ kind: "double creux", bottom: (lA.p + lB.p) / 2, neck: crest, confirmed: price > crest });
        }
      }
    }
    // Cassure de la zone récente
    var breakout = 0, brkLevel = null;
    if (n >= 15) {
      var ref = c.slice(Math.max(0, n - 22), n - 2);
      var refHi = Math.max.apply(null, ref.map(function (k) { return k.h; }));
      var refLo = Math.min.apply(null, ref.map(function (k) { return k.l; }));
      if (price > refHi + 0.1 * A) { breakout = 1; brkLevel = refHi; }
      else if (price < refLo - 0.1 * A) { breakout = -1; brkLevel = refLo; }
    }

    // Chandeliers : dernière bougie clôturée et bougie en cours
    var patterns = [];
    function trendBefore(i) {
      var s = c.slice(Math.max(0, i - 6), i);
      if (s.length < 3) return 0;
      return s[s.length - 1].c < s[0].c ? -1 : s[s.length - 1].c > s[0].c ? 1 : 0;
    }
    function candleAt(i, stateLabel) {
      if (i < 1) return;
      var k = c[i], p = c[i - 1];
      var body = Math.abs(k.c - k.o), rng = Math.max(k.h - k.l, tick);
      var upW = k.h - Math.max(k.o, k.c), loW = Math.min(k.o, k.c) - k.l;
      var bull = k.c > k.o, pBull = p.c > p.o, pBody = Math.abs(p.c - p.o);
      var tb = trendBefore(i);
      if (bull && !pBull && k.c >= p.o && k.o <= p.c && body > pBody * 1.05) patterns.push({ kind: "avalement haussier", dir: 1, i: i, state: stateLabel });
      else if (!bull && pBull && k.c <= p.o && k.o >= p.c && body > pBody * 1.05) patterns.push({ kind: "avalement baissier", dir: -1, i: i, state: stateLabel });
      else if (body <= 0.1 * rng && rng > 0.5 * A) patterns.push({ kind: "doji", dir: 0, i: i, state: stateLabel });
      else if (loW >= 2 * body && upW <= 0.35 * rng * 0.5 && loW >= 0.55 * rng && tb <= 0) patterns.push({ kind: "marteau", dir: 1, i: i, state: stateLabel });
      else if (upW >= 2 * body && loW <= 0.35 * rng * 0.5 && upW >= 0.55 * rng && tb >= 0) patterns.push({ kind: "étoile filante", dir: -1, i: i, state: stateLabel });
      else if (loW >= 0.6 * rng && rng > 0.8 * A) patterns.push({ kind: "mèche de rejet basse", dir: 1, i: i, state: stateLabel });
      else if (upW >= 0.6 * rng && rng > 0.8 * A) patterns.push({ kind: "mèche de rejet haute", dir: -1, i: i, state: stateLabel });
      if (i >= 2) {
        var a = c[i - 2], aBody = Math.abs(a.c - a.o), mid = (a.o + a.c) / 2;
        if (a.c < a.o && aBody > 0.8 * A && pBody < 0.4 * aBody && bull && k.c > mid) patterns.push({ kind: "étoile du matin", dir: 1, i: i, state: stateLabel });
        if (a.c > a.o && aBody > 0.8 * A && pBody < 0.4 * aBody && !bull && k.c < mid) patterns.push({ kind: "étoile du soir", dir: -1, i: i, state: stateLabel });
      }
    }
    candleAt(n - 2, "clôturée");
    candleAt(n - 1, "en cours");

    // Divergences du RSI
    var divergence = 0;
    if (sw.highs.length >= 2) {
      var a1 = last(sw.highs, 1), a2 = last(sw.highs);
      if (a2.i >= n - 15 && a2.p > a1.p && r[a2.i] !== null && r[a1.i] !== null && r[a2.i] < r[a1.i] - 2) divergence = -1;
    }
    if (!divergence && sw.lows.length >= 2) {
      var b1 = last(sw.lows, 1), b2 = last(sw.lows);
      if (b2.i >= n - 15 && b2.p < b1.p && r[b2.i] !== null && r[b1.i] !== null && r[b2.i] > r[b1.i] + 2) divergence = 1;
    }

    // Mouvement récent : chute depuis un sommet récent ou montée depuis un creux récent
    var lb = Math.min(30, n), seg = c.slice(n - lb), hiI = 0, loI = 0;
    seg.forEach(function (k, i) { if (k.h > seg[hiI].h) hiI = i; if (k.l < seg[loI].l) loI = i; });
    var fromHi = (seg[hiI].h - price) / A, fromLo = (price - seg[loI].l) / A, leg = 0, legFrom = null, legBars = 0;
    if (fromHi >= 3 && fromHi > 2 * fromLo && hiI < lb - 4) { leg = -1; legFrom = seg[hiI].h; legBars = lb - 1 - hiI; }
    else if (fromLo >= 3 && fromLo > 2 * fromHi && loI < lb - 4) { leg = 1; legFrom = seg[loI].l; legBars = lb - 1 - loI; }

    var e20v = last(e20), e20prev = e20[Math.max(0, n - 6)];
    return {
      n: n, price: price, atr: A, tick: tick, decimals: decimals,
      ema20: e20v, ema20Slope: e20v !== null && e20prev !== null ? (e20v - e20prev) / A : 0,
      ema50: e50 ? last(e50) : null, rsi: last(r), macd: m,
      structure: { dir: dir, code: code, highs: H, lows: L }, regSlope: regSlope,
      leg: leg, legFrom: legFrom, legBars: legBars,
      res: res, sup: sup, figures: figures, breakout: breakout, breakoutLevel: brkLevel,
      patterns: patterns, divergence: divergence, round: round,
      lastRange: last(c).h - last(c).l, hi: hiAll, lo: loAll
    };
  }

  function scoreSeries(s, contextDir) {
    var parts = [];
    function add(v, label) { if (v) parts.push({ v: v, label: label }); }
    add(2 * s.structure.dir, s.structure.dir > 0 ? "structure haussière" : "structure baissière");
    add(s.regSlope > 0.05 ? 0.5 : s.regSlope < -0.05 ? -0.5 : 0, "pente des clôtures");
    add(1.5 * s.leg, s.leg > 0 ? "montée récente" : "chute récente");
    if (s.ema20 !== null) {
      add(s.price > s.ema20 ? 0.5 : -0.5, s.price > s.ema20 ? "prix au-dessus de l'EMA20" : "prix sous l'EMA20");
      add(s.ema20Slope > 0.1 ? 0.5 : s.ema20Slope < -0.1 ? -0.5 : 0, "pente de l'EMA20");
    }
    if (s.ema50 !== null && s.ema20 !== null) add(s.ema20 > s.ema50 ? 0.75 : -0.75, s.ema20 > s.ema50 ? "EMA20 au-dessus de l'EMA50" : "EMA20 sous l'EMA50");
    if (s.rsi !== null) {
      add(s.rsi > 55 ? 0.5 : s.rsi < 45 ? -0.5 : 0, "RSI");
      add(s.rsi > 70 ? -0.5 : s.rsi < 30 ? 0.5 : 0, s.rsi > 70 ? "surachat" : "survente");
    }
    if (s.macd && s.macd.hist !== null) add(s.macd.hist > 0 ? 0.5 : -0.5, "MACD");
    var pc = s.patterns.filter(function (p) { return p.dir !== 0; });
    pc.forEach(function (p) { add(p.dir * (p.state === "clôturée" ? 1 : 0.5), p.kind); });
    add(s.divergence, s.divergence > 0 ? "divergence haussière du RSI" : "divergence baissière du RSI");
    add(s.breakout, s.breakout > 0 ? "cassure haussière" : "cassure baissière");
    s.figures.forEach(function (f) {
      if (f.kind === "double sommet") add(f.confirmed ? -1.5 : -0.75, "double sommet");
      if (f.kind === "double creux") add(f.confirmed ? 1.5 : 0.75, "double creux");
      if (f.kind === "biseau ascendant") add(-0.5, f.kind);
      if (f.kind === "biseau descendant") add(0.5, f.kind);
      if (f.kind === "triangle ascendant") add(0.5, f.kind);
      if (f.kind === "triangle descendant") add(-0.5, f.kind);
    });
    if (s.sup[0] && s.price - s.sup[0].p < 0.6 * s.atr) add(0.5, "proche d'un support");
    if (s.res[0] && s.res[0].p - s.price < 0.6 * s.atr) add(-0.5, "proche d'une résistance");
    if (contextDir) add(1.5 * contextDir, "tendance de la grande unité");
    var total = parts.reduce(function (t, p) { return t + p.v; }, 0);
    return { total: total, parts: parts, up: clamp(Math.round(50 + total * 5), 10, 90) };
  }

  // ---------- Rédaction ----------

  function makeWriter(decimals) {
    var nf = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    var nf1 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
    return {
      p: function (v) { return nf.format(v); },
      n1: function (v) { return nf1.format(v); }
    };
  }

  var LEXIQUE = {
    support: "Support : prix où les acheteurs ont déjà fait remonter le cours.",
    resistance: "Résistance : prix où les vendeurs ont déjà fait baisser le cours.",
    ema: "EMA (moyenne mobile exponentielle) : moyenne des derniers prix qui donne plus de poids aux plus récents.",
    rsi: "RSI : mesure l'élan de 0 à 100 ; au-dessus de 70 le prix a beaucoup monté, sous 30 il a beaucoup baissé.",
    macd: "MACD : compare deux moyennes mobiles pour dire si l'élan accélère ou ralentit.",
    atr: "ATR : taille moyenne d'une bougie ; sert à placer des stops adaptés à l'agitation du marché.",
    structure: "Structure : suite des sommets et des creux ; plus hauts = hausse, plus bas = baisse.",
    avalement: "Avalement : bougie qui recouvre entièrement la précédente, signe que l'autre camp reprend la main.",
    marteau: "Marteau : bougie à longue mèche basse ; les vendeurs ont poussé, les acheteurs ont repris.",
    etoile: "Étoile filante : bougie à longue mèche haute ; les acheteurs ont poussé, les vendeurs ont repris.",
    doji: "Doji : bougie sans corps ; ouverture et clôture presque égales, le marché hésite.",
    meche: "Mèche de rejet : longue mèche qui montre qu'un prix a été refusé.",
    etoileMatin: "Étoile du matin / du soir : enchaînement de trois bougies qui annonce souvent un retournement.",
    double: "Double sommet / double creux : le prix bute deux fois au même niveau, puis repart dans l'autre sens.",
    cou: "Ligne de cou : niveau dont la cassure confirme une figure de retournement.",
    canal: "Canal : le prix évolue entre deux lignes parallèles.",
    triangle: "Triangle : les sommets et les creux se rapprochent ; une cassure suit souvent.",
    biseau: "Biseau : canal qui se resserre, souvent suivi d'une sortie dans le sens opposé à la pente.",
    range: "Range : le prix tourne en rond entre un plancher et un plafond.",
    divergence: "Divergence : le prix va dans un sens mais l'élan (RSI) ne suit pas ; signe d'essoufflement.",
    cassure: "Cassure : clôture franche au-delà d'un niveau important.",
    stop: "Stop : prix où tu sors en perte si le scénario ne se réalise pas."
  };

  function analyze(input) {
    var captures = (input.captures || []).filter(function (cap) { return cap && cap.candles && cap.candles.length >= 8; });
    if (!captures.length) {
      return { lisible: false, probleme: "Aucune capture exploitable : il faut au moins 8 bougies lisibles." };
    }
    var style = input.style || "scalping";
    var now = input.now ? new Date(input.now) : new Date();
    // Unités de temps : choix de l'utilisateur pour une seule capture, sinon lecture sur chaque capture.
    captures.forEach(function (cap, idx) {
      cap.tf = (captures.length === 1 && input.tf) ? input.tf : (cap.tf || input.tf || "");
      cap.rank = TF_ORDER.indexOf(cap.tf);
      cap.idx = idx;
    });
    var sorted = captures.slice().sort(function (a, b) { return a.rank - b.rank; });
    var main = sorted[0];
    var ctxCap = sorted.length > 1 && last(sorted).rank > main.rank ? last(sorted) : null;
    var symbol = input.pair || main.symbol || (ctxCap && ctxCap.symbol) || "";
    var decimals = Math.max(main.decimals || 0, /^XA[UG]/.test(symbol) ? 2 : 0) || 2;
    var w = makeWriter(decimals);
    var P = w.p;

    var s = analyseSeries(main.candles, decimals);
    var ctx = ctxCap ? analyseSeries(ctxCap.candles, Math.max(ctxCap.decimals || 0, decimals)) : null;
    var contextDir = 0;
    if (ctx) {
      var cs = scoreSeries(ctx, 0);
      contextDir = cs.total >= 2 ? 1 : cs.total <= -2 ? -1 : 0;
    }
    var sc = scoreSeries(s, contextDir);
    var up = sc.up, bias = up >= 60 ? "achat" : up <= 40 ? "vente" : "attente";
    var A = s.atr;
    var terms = {};
    function term(k) { terms[k] = true; }
    var tfMain = main.tf || "";
    var tfText = tfMain ? tfMain : "l'unité de temps de la capture";

    // ----- Niveaux -----
    function levelTech(l, isRes) {
      var bits = [];
      if (l.touches >= 2) bits.push((isRes ? "plafond touché " : "plancher touché ") + l.touches + " fois");
      else if (l.touches === 1) bits.push(isRes ? "ancien sommet" : "ancien creux");
      if (l.extreme) bits.push(isRes ? "plus haut de la zone visible" : "plus bas de la zone visible");
      if (l.round) bits.push("chiffre rond (" + P(l.roundValue) + ")");
      var dist = Math.abs(l.p - s.price);
      bits.push("à " + P(dist) + " du prix, soit " + w.n1(dist / A) + " ATR");
      return bits.join(", ") + ".";
    }
    function levelClair(l, isRes) {
      if (l.force === "forte") return isRes ? "Plafond solide : les vendeurs y ont déjà repoussé le prix plusieurs fois." : "Plancher solide : les acheteurs y ont déjà fait remonter le prix plusieurs fois.";
      if (l.round && l.touches === 0) return "Prix rond : beaucoup de traders y placent des ordres, le prix y réagit souvent.";
      if (l.extreme) return isRes ? "Le plus haut de la capture : à dépasser pour continuer la hausse." : "Le plus bas de la capture : s'il cède, la baisse peut accélérer.";
      return isRes ? "Obstacle possible au-dessus du prix." : "Appui possible sous le prix.";
    }
    var niveaux = [];
    s.res.slice().reverse().forEach(function (l) { niveaux.push({ type: "resistance", prix: round(l.p), force: l.force, technique: levelTech(l, true), en_clair: levelClair(l, true) }); });
    s.sup.forEach(function (l) { niveaux.push({ type: "support", prix: round(l.p), force: l.force, technique: levelTech(l, false), en_clair: levelClair(l, false) }); });
    if (niveaux.length) { term("support"); term("resistance"); }

    function round(v) { var f = Math.pow(10, decimals); return Math.round(v * f) / f; }

    // ----- Tendance -----
    function trendText(x, label) {
      var st = x.structure;
      var t = "Structure " + st.code;
      if (st.highs.length === 2 && st.lows.length === 2) {
        t += " (sommets " + P(st.highs[0].p) + " puis " + P(st.highs[1].p) + ", creux " + P(st.lows[0].p) + " puis " + P(st.lows[1].p) + ")";
      }
      t += ".";
      if (x.ema20 !== null) t += " Prix " + (x.price > x.ema20 ? "au-dessus" : "en dessous") + " de l'EMA20 (" + P(x.ema20) + ")";
      if (x.ema50 !== null) t += ", EMA20 " + (x.ema20 > x.ema50 ? "au-dessus" : "en dessous") + " de l'EMA50 (" + P(x.ema50) + ")";
      if (x.ema20 !== null) t += ".";
      t += " Pente des " + Math.min(40, x.n) + " dernières clôtures : " + (x.regSlope > 0 ? "+" : "") + w.n1(x.regSlope * 100) + " % d'ATR par bougie.";
      var clair;
      if (st.dir > 0) clair = "Sur " + label + ", la tendance monte : chaque creux est plus haut que le précédent.";
      else if (st.dir < 0) clair = "Sur " + label + ", la tendance baisse : chaque sommet est plus bas que le précédent.";
      else if (st.code === "en compression") clair = "Sur " + label + ", le prix se resserre : ni les acheteurs ni les vendeurs ne dominent, une sortie se prépare.";
      else clair = "Sur " + label + ", pas de direction nette : le prix oscille sans tendance claire.";
      term("structure"); term("ema");
      return { technique: t, en_clair: clair };
    }
    var contexte, courtTerme;
    if (ctx) {
      contexte = trendText(ctx, ctxCap.tf ? ctxCap.tf : "la grande unité");
      courtTerme = trendText(s, tfText);
    } else {
      contexte = trendText(s, tfText + " (vue d'ensemble de la capture)");
      var recent = s.patterns.length ? s.patterns : [];
      var lastN = main.candles.slice(-8);
      var bulls = lastN.filter(function (k) { return k.c > k.o; }).length;
      var move = last(lastN).c - lastN[0].o;
      courtTerme = {
        technique: "8 dernières bougies : " + bulls + " haussières, " + (8 - bulls) + " baissières, variation " + (move >= 0 ? "+" : "−") + P(Math.abs(move)) + " (" + w.n1(Math.abs(move) / A) + " ATR)." + (recent.length ? " Signal récent : " + recent.map(function (p) { return p.kind; }).join(", ") + "." : ""),
        en_clair: Math.abs(move) < 0.5 * A ? "Ces dernières minutes, le prix fait du sur-place." : move > 0 ? "Ces dernières bougies, les acheteurs ont l'initiative." : "Ces dernières bougies, les vendeurs ont l'initiative."
      };
    }

    // ----- Indicateurs -----
    var indicateurs = [];
    if (s.ema20 !== null) {
      indicateurs.push({ nom: "EMA20" + (s.ema50 !== null ? " / EMA50" : ""), lecture: "EMA20 à " + P(s.ema20) + (s.ema50 !== null ? ", EMA50 à " + P(s.ema50) : "") + ", pente EMA20 " + (s.ema20Slope > 0 ? "positive" : s.ema20Slope < 0 ? "négative" : "plate") + ".",
        en_clair: s.price > s.ema20 ? "Le prix est au-dessus de sa moyenne récente : plutôt bon signe pour les acheteurs." : "Le prix est sous sa moyenne récente : plutôt bon signe pour les vendeurs." });
    }
    if (s.rsi !== null) {
      term("rsi");
      indicateurs.push({ nom: "RSI 14", lecture: "RSI à " + w.n1(s.rsi) + (s.rsi > 70 ? " : zone de surachat." : s.rsi < 30 ? " : zone de survente." : "."),
        en_clair: s.rsi > 70 ? "Le prix a beaucoup monté d'un coup : un repli est fréquent à ce stade." : s.rsi < 30 ? "Le prix a beaucoup baissé d'un coup : un rebond est fréquent à ce stade." : s.rsi > 55 ? "L'élan est plutôt acheteur, sans excès." : s.rsi < 45 ? "L'élan est plutôt vendeur, sans excès." : "L'élan est neutre." });
    }
    if (s.macd && s.macd.hist !== null) {
      term("macd");
      var acc = s.macd.histPrev !== null && Math.abs(s.macd.hist) > Math.abs(s.macd.histPrev);
      indicateurs.push({ nom: "MACD (12, 26, 9)", lecture: "Histogramme " + (s.macd.hist > 0 ? "positif" : "négatif") + (acc ? " et en expansion." : " et en contraction."),
        en_clair: (s.macd.hist > 0 ? "L'élan est haussier" : "L'élan est baissier") + (acc ? " et il se renforce." : " mais il faiblit.") });
    }
    term("atr");
    indicateurs.push({ nom: "ATR 14", lecture: "ATR à " + P(A) + " ; dernière bougie de " + P(s.lastRange) + " (" + w.n1(s.lastRange / A) + " ATR).",
      en_clair: "Une bougie bouge en moyenne de " + P(A) + ". Tes stops doivent laisser au moins cette marge." });
    if (s.divergence) {
      term("divergence");
      indicateurs.push({ nom: "Divergence RSI", lecture: s.divergence > 0 ? "Prix sur un creux plus bas, RSI sur un creux plus haut : divergence haussière." : "Prix sur un sommet plus haut, RSI sur un sommet plus bas : divergence baissière.",
        en_clair: s.divergence > 0 ? "Le prix baisse encore mais avec moins de force : la baisse s'essouffle." : "Le prix monte encore mais avec moins de force : la hausse s'essouffle." });
    }

    // ----- Figures -----
    var figures = [];
    s.figures.forEach(function (f) {
      if (f.kind === "double sommet") {
        term("double"); term("cou");
        figures.push({ nom: "Double sommet", technique: "Deux sommets vers " + P(f.top) + ", ligne de cou à " + P(f.neck) + (f.confirmed ? " : cassée, figure confirmée." : " : pas encore cassée."),
          en_clair: f.confirmed ? "Le prix a buté deux fois au même plafond puis a cassé le plancher : la baisse prend le dessus." : "Le prix a buté deux fois vers " + P(f.top) + ". S'il passe sous " + P(f.neck) + ", la baisse se confirme." });
      } else if (f.kind === "double creux") {
        term("double"); term("cou");
        figures.push({ nom: "Double creux", technique: "Deux creux vers " + P(f.bottom) + ", ligne de cou à " + P(f.neck) + (f.confirmed ? " : cassée, figure confirmée." : " : pas encore cassée."),
          en_clair: f.confirmed ? "Le prix a rebondi deux fois sur le même plancher puis a dépassé le plafond : la hausse prend le dessus." : "Le prix a rebondi deux fois vers " + P(f.bottom) + ". S'il dépasse " + P(f.neck) + ", la hausse se confirme." });
      } else {
        var clairShape = {
          "canal ascendant": "Le prix monte en escalier entre deux lignes parallèles.",
          "canal descendant": "Le prix descend en escalier entre deux lignes parallèles.",
          "range": "Le prix fait des allers-retours entre un plancher et un plafond.",
          "triangle symétrique": "Les mouvements se resserrent : une sortie franche se prépare, dans un sens ou dans l'autre.",
          "triangle ascendant": "Le plafond tient mais les creux montent : les acheteurs poussent, une cassure par le haut est plus probable.",
          "triangle descendant": "Le plancher tient mais les sommets baissent : les vendeurs poussent, une cassure par le bas est plus probable.",
          "biseau ascendant": "Le prix monte de plus en plus difficilement : ce type de figure finit souvent par une baisse.",
          "biseau descendant": "Le prix baisse de plus en plus difficilement : ce type de figure finit souvent par une hausse.",
          "élargissement": "Les mouvements s'agrandissent : le marché est nerveux, prudence."
        }[f.kind];
        if (/canal/.test(f.kind)) term("canal");
        if (/triangle/.test(f.kind)) term("triangle");
        if (/biseau/.test(f.kind)) term("biseau");
        if (f.kind === "range") term("range");
        figures.push({ nom: f.kind.charAt(0).toUpperCase() + f.kind.slice(1) + (tfMain ? " (" + tfMain + ")" : ""),
          technique: "Borne haute vers " + P(f.upper) + ", borne basse vers " + P(f.lower) + " à la dernière bougie.", en_clair: clairShape });
      }
    });
    if (s.breakout) {
      term("cassure");
      figures.push({ nom: s.breakout > 0 ? "Cassure haussière" : "Cassure baissière",
        technique: "Clôture " + (s.breakout > 0 ? "au-dessus du plus haut" : "sous le plus bas") + " des 20 bougies précédentes (" + P(s.breakoutLevel) + ").",
        en_clair: s.breakout > 0 ? "Le prix vient de sortir par le haut de sa zone récente." : "Le prix vient de sortir par le bas de sa zone récente." });
    }

    // ----- Chandeliers -----
    var CLAIR_C = {
      "avalement haussier": "Les acheteurs ont repris toute la bougie précédente : signal de reprise.",
      "avalement baissier": "Les vendeurs ont repris toute la bougie précédente : signal de repli.",
      "doji": "Le marché hésite : ni les acheteurs ni les vendeurs n'ont gagné cette bougie.",
      "marteau": "Les vendeurs ont poussé, puis les acheteurs ont fait remonter le prix : rejet du bas.",
      "étoile filante": "Les acheteurs ont poussé, puis les vendeurs ont fait redescendre le prix : rejet du haut.",
      "mèche de rejet basse": "Le prix est descendu puis a été racheté : les acheteurs défendent ce niveau.",
      "mèche de rejet haute": "Le prix est monté puis a été revendu : les vendeurs défendent ce niveau.",
      "étoile du matin": "Enchaînement de trois bougies qui annonce souvent la fin d'une baisse.",
      "étoile du soir": "Enchaînement de trois bougies qui annonce souvent la fin d'une hausse."
    };
    var chandeliers = s.patterns.map(function (p) {
      var k = main.candles[p.i];
      if (/avalement/.test(p.kind)) term("avalement");
      if (p.kind === "marteau") term("marteau");
      if (p.kind === "étoile filante") term("etoile");
      if (p.kind === "doji") term("doji");
      if (/mèche/.test(p.kind)) term("meche");
      if (/étoile du/.test(p.kind)) term("etoileMatin");
      return { nom: p.kind.charAt(0).toUpperCase() + p.kind.slice(1) + " (bougie " + p.state + ")",
        technique: "O " + P(k.o) + " · H " + P(k.h) + " · B " + P(k.l) + " · C " + P(k.c) + (p.state === "en cours" ? " — à confirmer à la clôture." : "."),
        en_clair: CLAIR_C[p.kind] + (p.state === "en cours" ? " Attends la clôture de la bougie pour t'y fier." : "") };
    });

    // ----- Scénarios -----
    var stopMult = { scalping: 0.5, intraday: 0.8, swing: 1.2 }[style] || 0.6;
    var sb = stopMult * A, eb = 0.15 * A;
    var R1 = s.res[0] ? s.res[0].p : s.hi, R2 = s.res[1] ? s.res[1].p : null, R3 = s.res[2] ? s.res[2].p : null;
    var S1 = s.sup[0] ? s.sup[0].p : s.lo, S2 = s.sup[1] ? s.sup[1].p : null, S3 = s.sup[2] ? s.sup[2].p : null;
    term("stop");
    function longFrom(entry, stop, t1cand, t2cand) {
      var risk = Math.abs(entry - stop);
      var tp1 = t1cand !== null && t1cand - entry >= 0.8 * risk ? t1cand - 0.1 * A : entry + 1.5 * risk;
      var tp2 = t2cand !== null && t2cand - 0.1 * A > tp1 + 0.5 * risk ? t2cand - 0.1 * A : Math.max(tp1 + risk, entry + 2.5 * risk);
      return { entree: round(entry), stop: round(stop), tp1: round(tp1), tp2: round(tp2) };
    }
    function shortFrom(entry, stop, t1cand, t2cand) {
      var risk = Math.abs(entry - stop);
      var tp1 = t1cand !== null && entry - t1cand >= 0.8 * risk ? t1cand + 0.1 * A : entry - 1.5 * risk;
      var tp2 = t2cand !== null && t2cand + 0.1 * A < tp1 - 0.5 * risk ? t2cand + 0.1 * A : Math.min(tp1 - risk, entry - 2.5 * risk);
      return { entree: round(entry), stop: round(stop), tp1: round(tp1), tp2: round(tp2) };
    }
    var buyPullback = function () {
      var lv = longFrom(S1 + eb, S1 - sb, R1, R2);
      return Object.assign({ nom: "Achat sur repli vers le support", type: "achat",
        condition: "Le prix revient vers " + P(S1) + ", y fait une mèche de rejet ou un avalement haussier, puis une bougie " + tfText + " clôture au-dessus de " + P(lv.entree) + ".",
        en_clair: "Attends que le prix revienne sur le plancher de " + P(S1) + " et y rebondisse. Tu achètes vers " + P(lv.entree) + " et tu sors à " + P(lv.stop) + " si le plancher cède." }, lv);
    };
    var buyBreakout = function () {
      var lv = longFrom(R1 + eb, R1 - sb, R2, R3);
      return Object.assign({ nom: "Achat sur cassure de la résistance", type: "achat",
        condition: "Une bougie " + tfText + " clôture au-dessus de " + P(R1) + " ; entrée au retour sur ce niveau ou dès la clôture.",
        en_clair: "Si le prix dépasse franchement " + P(R1) + ", le plafond devient un plancher. Tu achètes vers " + P(lv.entree) + ", stop à " + P(lv.stop) + "." }, lv);
    };
    var sellPullback = function () {
      var lv = shortFrom(R1 - eb, R1 + sb, S1, S2);
      return Object.assign({ nom: "Vente sur rebond vers la résistance", type: "vente",
        condition: "Le prix remonte vers " + P(R1) + ", y fait une mèche de rejet ou un avalement baissier, puis une bougie " + tfText + " clôture sous " + P(lv.entree) + ".",
        en_clair: "Attends que le prix remonte au plafond de " + P(R1) + " et y soit rejeté. Tu vends vers " + P(lv.entree) + " et tu sors à " + P(lv.stop) + " si le plafond cède." }, lv);
    };
    var sellBreakout = function () {
      var lv = shortFrom(S1 - eb, S1 + sb, S2, S3);
      return Object.assign({ nom: "Vente sur cassure du support", type: "vente",
        condition: "Une bougie " + tfText + " clôture sous " + P(S1) + " ; entrée au retour sous ce niveau ou dès la clôture.",
        en_clair: "Si le prix casse franchement " + P(S1) + ", le plancher devient un plafond. Tu vends vers " + P(lv.entree) + ", stop à " + P(lv.stop) + "." }, lv);
    };
    var scenarios;
    var nearS = s.price - S1, nearR = R1 - s.price;
    if (bias === "achat") {
      var mainBuy = nearS <= 2 * A || nearR > 2.5 * A ? buyPullback() : buyBreakout();
      mainBuy.nom = "Principal : " + mainBuy.nom.charAt(0).toLowerCase() + mainBuy.nom.slice(1);
      var altSell = sellBreakout();
      altSell.nom = "Alternatif : " + altSell.nom.charAt(0).toLowerCase() + altSell.nom.slice(1);
      scenarios = [mainBuy, altSell];
    } else if (bias === "vente") {
      var mainSell = nearR <= 2 * A || nearS > 2.5 * A ? sellPullback() : sellBreakout();
      mainSell.nom = "Principal : " + mainSell.nom.charAt(0).toLowerCase() + mainSell.nom.slice(1);
      var altBuy = buyBreakout();
      altBuy.nom = "Alternatif : " + altBuy.nom.charAt(0).toLowerCase() + altBuy.nom.slice(1);
      scenarios = [mainSell, altBuy];
    } else {
      var b1s = buyBreakout(), s1s = sellBreakout();
      b1s.nom = "Si cassure par le haut : achat";
      s1s.nom = "Si cassure par le bas : vente";
      scenarios = [{ nom: "Principal : attendre une sortie de zone", type: "attente",
        condition: "Pas d'entrée tant que le prix reste entre " + P(S1) + " et " + P(R1) + ".",
        entree: null, stop: null, tp1: null, tp2: null,
        en_clair: "Les signaux se contredisent. Laisse le prix choisir sa direction : une clôture au-dessus de " + P(R1) + " ou sous " + P(S1) + " te donnera le signal." }, b1s, s1s];
    }

    // ----- Vigilance -----
    var vigilance = [];
    var paris = parisTime(now);
    var isGold = /^XAU/.test(symbol) || (!symbol && s.price > 500);
    if (isGold && paris !== null && paris >= 22.5 && paris <= 23.75) vigilance.push("Pause quotidienne de l'or vers 23 h : les spreads s'élargissent fortement autour, évite d'entrer.");
    if (paris !== null && paris >= 8.75 && paris <= 9.75) vigilance.push("Ouverture de Londres : volatilité en hausse, les faux départs sont fréquents.");
    if (paris !== null && paris >= 13.75 && paris <= 16) vigilance.push("Séance américaine : annonces économiques possibles, le prix peut bouger brutalement et le spread s'élargir.");
    if (s.lastRange > 2.5 * A) vigilance.push("La dernière bougie est " + w.n1(s.lastRange / A) + " fois plus grande que la moyenne : volatilité anormale, attends que ça se calme.");
    var near = null;
    s.res.concat(s.sup).forEach(function (l) { if (Math.abs(l.p - s.price) < 0.3 * A && (!near || Math.abs(l.p - s.price) < Math.abs(near.p - s.price))) near = l; });
    if (near) vigilance.push("Le prix est collé au niveau de " + P(near.p) + " : attends une réaction nette avant d'agir.");
    if (s.rsi !== null && (s.rsi > 75 || s.rsi < 25)) vigilance.push("RSI extrême (" + w.n1(s.rsi) + ") : mouvement déjà très étendu, ne cours pas après le prix.");
    if (contextDir && ((contextDir > 0 && bias === "vente") || (contextDir < 0 && bias === "achat"))) vigilance.push("La grande unité de temps va dans l'autre sens : réduis la taille ou vise des objectifs courts.");
    (input.warnings || []).forEach(function (wn) { vigilance.push(wn); });

    // ----- Résumé en clair -----
    var trendPhrase;
    var legTxt = s.leg ? (s.leg < 0 ? "recule depuis le sommet de " : "remonte depuis le creux de ") + P(s.legFrom) + " (" + (s.leg < 0 ? "−" : "+") + P(Math.abs(s.price - s.legFrom)) + " en " + s.legBars + " bougies)" : "";
    if (s.structure.dir > 0 && s.leg < 0) trendPhrase = "La tendance de fond monte, mais le prix " + legTxt + " : c'est une correction à surveiller.";
    else if (s.structure.dir < 0 && s.leg > 0) trendPhrase = "La tendance de fond baisse, mais le prix " + legTxt + " : c'est un rebond à surveiller.";
    else if (s.structure.dir > 0) trendPhrase = "Le prix est en tendance haussière : il fait des sommets et des creux de plus en plus hauts.";
    else if (s.structure.dir < 0) trendPhrase = "Le prix est en tendance baissière : ses sommets et ses creux sont de plus en plus bas.";
    else if (s.leg) trendPhrase = "Le prix " + legTxt + ".";
    else trendPhrase = "Le prix n'a pas de direction claire : il oscille entre " + P(S1) + " et " + P(R1) + ".";
    var locPhrase;
    if (nearS <= nearR && nearS < 1.5 * A) locPhrase = "Il est juste au-dessus du plancher de " + P(S1) + ".";
    else if (nearR < nearS && nearR < 1.5 * A) locPhrase = "Il approche du plafond de " + P(R1) + ".";
    else locPhrase = "Il est entre le plancher de " + P(S1) + " et le plafond de " + P(R1) + ".";
    var actPhrase = bias === "achat" ? "Les signaux penchent du côté acheteur (" + up + " %), mais attends le déclencheur décrit plus bas."
      : bias === "vente" ? "Les signaux penchent du côté vendeur (" + (100 - up) + " %), mais attends le déclencheur décrit plus bas."
      : "Les signaux se contredisent : mieux vaut attendre que le prix sorte de cette zone.";
    var enClair = [trendPhrase, locPhrase, actPhrase].join(" ");

    var aRetenir = [];
    var mainSc = scenarios[0];
    if (bias === "achat") {
      aRetenir.push("Zone à surveiller pour acheter : " + P(mainSc.type === "achat" && mainSc.nom.indexOf("repli") > -1 ? S1 : R1) + ".");
      aRetenir.push("Si une bougie " + tfText + " clôture sous " + P(mainSc.stop) + ", l'idée d'achat tombe.");
      aRetenir.push("Premier objectif : " + P(mainSc.tp1) + ".");
    } else if (bias === "vente") {
      aRetenir.push("Zone à surveiller pour vendre : " + P(mainSc.nom.indexOf("rebond") > -1 ? R1 : S1) + ".");
      aRetenir.push("Si une bougie " + tfText + " clôture au-dessus de " + P(mainSc.stop) + ", l'idée de vente tombe.");
      aRetenir.push("Premier objectif : " + P(mainSc.tp1) + ".");
    } else {
      aRetenir.push("Au-dessus de " + P(R1) + " : avantage aux acheteurs.");
      aRetenir.push("Sous " + P(S1) + " : avantage aux vendeurs.");
      aRetenir.push("Entre les deux : pas de trade.");
    }

    var lexique = Object.keys(terms).slice(0, 7).map(function (k) {
      var t = LEXIQUE[k], i = t.indexOf(" : ");
      return { terme: t.slice(0, i), definition: t.slice(i + 3) };
    });

    var tfHeader = ctxCap ? (ctxCap.tf + " + " + tfMain) : tfMain;
    return {
      lisible: true, probleme: "",
      paire: symbol, unite: tfHeader, prix: round(s.price),
      ecart_annonce: input.ecart || "",
      biais: bias, proba_hausse: up, proba_baisse: 100 - up,
      en_clair: enClair, a_retenir: aRetenir,
      contexte: contexte, court_terme: courtTerme,
      niveaux: niveaux, figures: figures, chandeliers: chandeliers, indicateurs: indicateurs,
      scenarios: scenarios, vigilance: vigilance, lexique: lexique,
      score: { total: Math.round(sc.total * 100) / 100, parts: sc.parts },
      capture_principale: main.idx, capture_contexte: ctxCap ? ctxCap.idx : null,
      atr: round(A), bougies: s.n
    };
  }

  function parisTime(d) {
    try {
      var parts = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
      var h = 0, m = 0;
      parts.forEach(function (p) { if (p.type === "hour") h = +p.value; if (p.type === "minute") m = +p.value; });
      return h + m / 60;
    } catch (e) { return null; }
  }

  root.DecodeurEngine = { analyze: analyze, _internals: { ema: ema, rsi: rsi, atr: atr, macd: macd, swings: swings, analyseSeries: analyseSeries, scoreSeries: scoreSeries } };
})(typeof window !== "undefined" ? window : globalThis);
