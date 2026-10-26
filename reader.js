/*
 * Décodeur — lecture d'une capture de graphique MT5, sans IA.
 *
 * Entrées : les pixels de la capture ({width, height, data RGBA}) et le texte reconnu par iOS
 * (liste {text, x, y, w, h} en coordonnées normalisées, origine en haut à gauche).
 * Sortie : les bougies en prix (ouverture, plus haut, plus bas, clôture), la paire, l'unité de temps,
 * l'échelle des prix et des indicateurs de qualité de lecture.
 */
(function (root) {
  "use strict";

  var TF_ORDER = ["M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30", "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1"];

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** Lit un nombre affiché sur l'axe des prix ("4166.80", "4 166,80", "1.08452"). */
  function parsePrice(text) {
    // Corrige les confusions fréquentes de la lecture de texte (lettre O lue au lieu du zéro, tiret parasite)
    var t = String(text || "").replace(/[\s\u00a0\u202f']/g, "");
    t = t.replace(/(\d)[Oo]/g, "$10").replace(/[Oo](\d)/g, "0$1").replace(/(\d)[Oo]/g, "$10");
    t = t.replace(/^[^0-9A-Za-z]{1,2}/, "").replace(/[^0-9A-Za-z]{1,2}$/, "");
    if (!/^[0-9][0-9.,]*$/.test(t)) return null;
    if (t.indexOf(",") > -1 && t.indexOf(".") > -1) {
      t = t.replace(/,/g, "");
    } else if (t.indexOf(",") > -1) {
      var parts = t.split(",");
      if (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3 && parts[0] !== "0") t = parts.join("");
      else if (parts.length === 2) t = parts[0] + "." + parts[1];
      else return null;
    }
    if ((t.match(/\./g) || []).length > 1) return null;
    var v = Number(t);
    if (!isFinite(v) || v <= 0) return null;
    var dec = t.indexOf(".") > -1 ? t.split(".")[1].length : 0;
    return { value: v, decimals: dec };
  }

  function parseTimeframe(text) {
    var m = String(text || "").toUpperCase().match(/\b(MN1?|W1|D1|H12|H8|H6|H4|H3|H2|H1|M30|M20|M15|M12|M10|M6|M5|M4|M3|M2|M1)\b/);
    if (!m) return "";
    return m[1] === "MN" ? "MN1" : m[1];
  }

  function parseSymbol(text) {
    var up = String(text || "").toUpperCase();
    if (/\bGOLD\b/.test(up)) return "XAUUSD";
    if (/\bSILVER\b/.test(up)) return "XAGUSD";
    var m = up.match(/\b(XAU|XAG|[A-Z]{3})([A-Z]{3})(?=[^A-Z]|$)/);
    if (!m) return "";
    var sym = m[1] + m[2];
    var known = /^(XAU|XAG)|^(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD)(USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD)$/;
    return known.test(sym) ? sym : "";
  }

  /** Relation linéaire entre la hauteur à l'écran (pixels) et le prix, robuste aux erreurs de lecture. */
  function fitScale(points, tolPx) {
    if (points.length < 2) return null;
    var best = null;
    for (var i = 0; i < points.length; i++) {
      for (var j = i + 1; j < points.length; j++) {
        var dy = points[j].y - points[i].y;
        if (Math.abs(dy) < 6) continue;
        var a = (points[j].v - points[i].v) / dy;
        if (!(a < 0)) continue;
        var b = points[i].v - a * points[i].y;
        var tol = Math.abs(a) * tolPx;
        var inliers = [], err = 0;
        for (var k = 0; k < points.length; k++) {
          var e = Math.abs(a * points[k].y + b - points[k].v);
          if (e <= tol) { inliers.push(points[k]); err += e; }
        }
        if (!best || inliers.length > best.inliers.length || (inliers.length === best.inliers.length && err < best.err)) {
          best = { a: a, b: b, inliers: inliers, err: err };
        }
      }
    }
    if (!best || best.inliers.length < 2) return null;
    // Ajustement final par moindres carrés sur les points retenus
    var n = best.inliers.length, sy = 0, sv = 0, syy = 0, syv = 0;
    best.inliers.forEach(function (p) { sy += p.y; sv += p.v; syy += p.y * p.y; syv += p.y * p.v; });
    var den = n * syy - sy * sy;
    var a2 = den ? (n * syv - sy * sv) / den : best.a;
    var b2 = (sv - a2 * sy) / n;
    if (!(a2 < 0)) { a2 = best.a; b2 = best.b; }
    var resid = 0;
    best.inliers.forEach(function (p) { resid = Math.max(resid, Math.abs(a2 * p.y + b2 - p.v)); });
    return { a: a2, b: b2, inliers: best.inliers, maxResidual: resid };
  }

  /** Repère la zone du graphique et l'échelle des prix à partir du texte reconnu. */
  function locate(img, ocr) {
    var W = img.width, H = img.height;
    var items = (ocr || []).map(function (o) {
      return {
        text: String(o.text || ""),
        x0: o.x * W, y0: o.y * H, x1: (o.x + o.w) * W, y1: (o.y + o.h) * H,
        cx: (o.x + o.w / 2) * W, cy: (o.y + o.h / 2) * H
      };
    });
    var labels = [];
    items.forEach(function (it) {
      if (it.cx < 0.62 * W) return;
      var p = parsePrice(it.text);
      if (p) labels.push({ it: it, v: p.value, decimals: p.decimals, y: it.cy });
    });
    var heights = labels.map(function (l) { return l.it.y1 - l.it.y0; });
    var lh = median(heights) || 0.012 * H;
    var scale = fitScale(labels, Math.max(3, 0.35 * lh));
    if (!scale) return { error: "axe" };

    var used = labels.filter(function (l) { return scale.inliers.indexOf(l) > -1; });
    var ys = used.map(function (l) { return l.y; }).sort(function (a, b) { return a - b; });
    var gaps = [];
    for (var i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > lh) gaps.push(ys[i] - ys[i - 1]);
    var spacing = median(gaps) || 6 * lh;

    var right = Math.min.apply(null, used.map(function (l) { return l.it.x0; })) - Math.max(4, 0.004 * W);
    var top = ys[0] - 1.1 * spacing;
    var bottom = ys[ys.length - 1] + 1.1 * spacing;

    // Le titre du graphique (paire, unité de temps) borne le haut ; l'axe du temps borne le bas.
    var symbol = "", tf = "", headerBottom = -1;
    items.forEach(function (it) {
      if (it.cy > ys[0] + spacing || it.cx > 0.75 * W) return;
      var s = parseSymbol(it.text), t = parseTimeframe(it.text);
      if (s && !symbol) symbol = s;
      if (t && !tf) tf = t;
      if ((s || t) && it.cy < ys[0]) headerBottom = Math.max(headerBottom, it.y1);
    });
    if (headerBottom > 0) top = Math.max(top, headerBottom + 4);
    items.forEach(function (it) {
      if (it.cx > right || it.cy < ys[ys.length - 1]) return;
      if (/\d{1,2}:\d{2}/.test(it.text) || /\b(janv|févr|mars|avr|mai|juin|juil|août|sept|oct|nov|déc|jan|feb|mar|apr|may|jun|jul|aug|sep|dec)\b/i.test(it.text)) {
        bottom = Math.min(bottom, it.y0 - 4);
      }
    });
    top = Math.max(0, Math.round(top));
    bottom = Math.min(H - 1, Math.round(bottom));
    right = Math.max(10, Math.round(right));
    var decimals = Math.max.apply(null, used.map(function (l) { return l.decimals; }));
    return {
      region: { left: 0, right: right, top: top, bottom: bottom },
      scale: scale, symbol: symbol, tf: tf, decimals: decimals, labelCount: used.length, labelHeight: lh
    };
  }

  // Familles de couleur : 1 rouge, 2 vert, 3 bleu.
  function classify(img, reg) {
    var W = img.width, d = img.data;
    var w = reg.right - reg.left, h = reg.bottom - reg.top;
    var fam = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      var p = ((reg.top + y) * W + reg.left) * 4;
      for (var x = 0; x < w; x++, p += 4) {
        var r = d[p], g = d[p + 1], b = d[p + 2];
        var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        var dl = mx - mn;
        if (mx < 60 || dl < 45 || dl / mx < 0.3) continue;
        var hue;
        if (mx === r) hue = 60 * (((g - b) / dl) % 6);
        else if (mx === g) hue = 60 * ((b - r) / dl + 2);
        else hue = 60 * ((r - g) / dl + 4);
        if (hue < 0) hue += 360;
        var f = 0;
        if (hue <= 25 || hue >= 330) f = 1;
        else if (hue >= 75 && hue <= 175) f = 2;
        else if (hue > 175 && hue <= 255) f = 3;
        fam[y * w + x] = f;
      }
    }
    return { fam: fam, w: w, h: h };
  }

  /** Efface les lignes horizontales (prix actuel, niveaux d'ordres) sans couper les bougies. */
  function removeHorizontalLines(c) {
    var fam = c.fam, w = c.w, h = c.h;
    var counts = new Int32Array(4);
    for (var y = 0; y < h; y++) {
      counts[1] = counts[2] = counts[3] = 0;
      var row = y * w;
      for (var x = 0; x < w; x++) counts[fam[row + x]]++;
      for (var f = 1; f <= 3; f++) {
        if (counts[f] < 0.3 * w) continue;
        for (x = 0; x < w; x++) {
          var i = row + x;
          if (fam[i] !== f) continue;
          var up = y >= 3 && fam[i - 3 * w] === f;
          var down = y + 3 < h && fam[i + 3 * w] === f;
          if (!up && !down) fam[i] = 0;
        }
      }
    }
  }

  function components(c) {
    var fam = c.fam, w = c.w, h = c.h, n = w * h;
    var label = new Int32Array(n);
    var order = new Int32Array(n);
    var stack = new Int32Array(n);
    var comps = [], pos = 0;
    for (var start = 0; start < n; start++) {
      var f = fam[start];
      if (!f || label[start]) continue;
      var id = comps.length + 1;
      var comp = { id: id, fam: f, start: pos, end: pos, minX: w, maxX: -1, minY: h, maxY: -1 };
      var sp = 0;
      stack[sp++] = start;
      label[start] = id;
      while (sp) {
        var i = stack[--sp];
        order[pos++] = i;
        var x = i % w, y = (i - x) / w;
        if (x < comp.minX) comp.minX = x;
        if (x > comp.maxX) comp.maxX = x;
        if (y < comp.minY) comp.minY = y;
        if (y > comp.maxY) comp.maxY = y;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
            var j = yy * w + xx;
            if (fam[j] === f && !label[j]) { label[j] = id; stack[sp++] = j; }
          }
        }
      }
      comp.end = pos;
      comp.count = comp.end - comp.start;
      comp.width = comp.maxX - comp.minX + 1;
      comp.height = comp.maxY - comp.minY + 1;
      comp.fill = comp.count / (comp.width * comp.height);
      if (comp.count >= 6) comps.push(comp);
    }
    return { comps: comps, order: order };
  }

  /** Mesure une bougie (ou une part de composante) sur une plage de colonnes. */
  function measure(comp, order, w, x0, x1) {
    var rows = {}, top = Infinity, bottom = -Infinity;
    for (var k = comp.start; k < comp.end; k++) {
      var i = order[k], x = i % w;
      if (x < x0 || x > x1) continue;
      var y = (i - x) / w;
      var r = rows[y];
      if (!r) rows[y] = r = [x, x];
      else { if (x < r[0]) r[0] = x; if (x > r[1]) r[1] = x; }
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    if (top === Infinity) return null;
    var width = x1 - x0 + 1;
    var need = Math.max(2, Math.ceil(0.5 * width));
    var bTop = Infinity, bBottom = -Infinity;
    if (width >= 3) {
      for (var key in rows) {
        var rr = rows[key];
        if (rr[1] - rr[0] + 1 >= need) {
          var yv = +key;
          if (yv < bTop) bTop = yv;
          if (yv > bBottom) bBottom = yv;
        }
      }
    }
    var thin = bTop === Infinity;
    return { x0: x0, x1: x1, top: top, bottom: bottom, bodyTop: thin ? null : bTop, bodyBottom: thin ? null : bBottom, thin: thin };
  }

  function extractCandles(img, reg) {
    var c = classify(img, reg);
    removeHorizontalLines(c);
    var cc = components(c);
    var comps = cc.comps, w = c.w, h = c.h;
    var tall = comps.filter(function (k) { return k.height >= 3 && k.width <= 0.08 * w; });
    var medW = median(tall.map(function (k) { return k.width; })) || 3;

    // Choix des couleurs des bougies : le rouge pour les baissières, le vert ou le bleu pour les haussières.
    function candleLike(k) { return k.height >= 3 && k.width <= 3 * medW && k.minX > 0; }
    var counts = [0, 0, 0, 0];
    comps.forEach(function (k) { if (candleLike(k)) counts[k.fam]++; });
    var bullFam = counts[2] >= counts[3] ? 2 : 3;
    if (counts[1] < 3 || counts[bullFam] < 3) {
      return { error: "couleurs", counts: counts };
    }

    var kept = comps.filter(function (k) {
      if (k.fam !== 1 && k.fam !== bullFam) return false;
      if (k.height < 3) return false;
      // Objet coupé par un bord de la zone : bougie partielle, étiquette de prix, volume tronqué.
      if (k.minX === 0 || k.maxX >= w - 1 || k.minY === 0 || k.maxY >= h - 1) return false;
      if (k.width >= 4 * medW && (k.height <= 4 || k.fill < 0.3)) return false;
      var nearEdge = k.minY < 0.12 * h || k.maxY > 0.88 * h;
      if (k.width >= 3 * medW && k.fill >= 0.85 && nearEdge) return false;
      return true;
    });

    // Volumes : barres posées sur une même ligne de base en bas du graphique.
    var bottoms = {};
    kept.forEach(function (k) { var key = Math.round(k.maxY / 3); bottoms[key] = (bottoms[key] || 0) + 1; });
    var modeKey = null, modeCount = 0;
    for (var key in bottoms) if (bottoms[key] > modeCount) { modeCount = bottoms[key]; modeKey = +key; }
    var volumeRemoved = 0;
    if (modeKey !== null && modeCount >= Math.max(5, 0.2 * kept.length) && modeKey * 3 > 0.6 * h) {
      kept = kept.filter(function (k) {
        var isVol = Math.abs(Math.round(k.maxY / 3) - modeKey) <= 1;
        if (isVol) volumeRemoved++;
        return !isVol;
      });
    }

    // Pas entre deux bougies, pour séparer celles qui se touchent.
    var centers = kept.filter(function (k) { return k.width <= 1.6 * medW; })
      .map(function (k) { return (k.minX + k.maxX) / 2; }).sort(function (a, b) { return a - b; });
    var diffs = [];
    for (var i = 1; i < centers.length; i++) if (centers[i] - centers[i - 1] > 0.8 * medW) diffs.push(centers[i] - centers[i - 1]);
    var pitch = median(diffs) || medW * 1.4;

    var out = [];
    kept.forEach(function (k) {
      var parts = 1;
      if (k.width > 1.8 * medW) parts = Math.max(1, Math.round((k.width + (pitch - medW)) / pitch));
      var pw = k.width / parts;
      for (var p = 0; p < parts; p++) {
        var x0 = k.minX + Math.round(p * pw), x1 = k.minX + Math.round((p + 1) * pw) - 1;
        var m = measure(k, cc.order, w, x0, x1);
        if (!m || m.bottom - m.top < 2) continue;
        m.bull = k.fam === bullFam;
        m.xc = (m.x0 + m.x1) / 2;
        out.push(m);
      }
    });
    out.sort(function (a, b) { return a.xc - b.xc; });
    // Fusion de doublons : deux morceaux d'une même bougie coupée par une ligne (mèche traversée par une moyenne mobile).
    var merged = [];
    out.forEach(function (m) {
      var prev = merged[merged.length - 1];
      var vGap = prev ? Math.max(m.top - prev.bottom, prev.top - m.bottom) : Infinity;
      if (prev && m.xc - prev.xc < 0.45 * pitch && prev.bull === m.bull && vGap <= 8) {
        prev.top = Math.min(prev.top, m.top);
        prev.bottom = Math.max(prev.bottom, m.bottom);
        if (m.bodyTop !== null) {
          prev.bodyTop = prev.bodyTop === null ? m.bodyTop : Math.min(prev.bodyTop, m.bodyTop);
          prev.bodyBottom = prev.bodyBottom === null ? m.bodyBottom : Math.max(prev.bodyBottom, m.bodyBottom);
          prev.thin = false;
        }
        prev.x1 = Math.max(prev.x1, m.x1);
        prev.xc = (prev.x0 + prev.x1) / 2;
      } else merged.push(m);
    });
    return { candles: merged, medW: medW, pitch: pitch, bullFam: bullFam, volumeRemoved: volumeRemoved };
  }

  /** Lecture complète : renvoie {ok, candles, symbol, tf, decimals, quality, overlay} ou {ok:false, error, message}. */
  function read(img, ocr) {
    var loc = locate(img, ocr);
    if (loc.error) {
      return { ok: false, error: "axe", message: "Je n'arrive pas à lire l'axe des prix. Fais une capture où les prix sont bien visibles à droite du graphique." };
    }
    var ex = extractCandles(img, loc.region);
    if (ex.error) {
      return { ok: false, error: "couleurs", message: "Je ne reconnais pas les bougies. Utilise des bougies vertes (hausse) et rouges (baisse) sur fond uni, sans indicateur de même couleur." };
    }
    var reg = loc.region, a = loc.scale.a, b = loc.scale.b;
    function price(yLocal) { return a * (yLocal + reg.top) + b; }
    var candles = ex.candles.map(function (m) {
      var hi = price(m.top), lo = price(m.bottom), o, c;
      if (m.thin) {
        var rng = hi - lo;
        o = m.bull ? lo + 0.3 * rng : hi - 0.3 * rng;
        c = m.bull ? hi - 0.3 * rng : lo + 0.3 * rng;
      } else {
        var bt = price(m.bodyTop), bb = price(m.bodyBottom);
        o = m.bull ? bb : bt;
        c = m.bull ? bt : bb;
      }
      return {
        o: o, h: hi, l: lo, c: c, bull: m.bull, thin: m.thin,
        px: { x: m.xc + reg.left, top: m.top + reg.top, bottom: m.bottom + reg.top }
      };
    });
    var warnings = [];
    if (candles.length < 25) warnings.push("peu");
    if (ex.medW < 3 || candles.filter(function (k) { return k.thin; }).length > 0.3 * candles.length) warnings.push("fines");
    if (loc.labelCount < 3) warnings.push("echelle");
    var holes = 0;
    for (var hi2 = 1; hi2 < candles.length; hi2++) {
      if (candles[hi2].px.x - candles[hi2 - 1].px.x > 1.6 * ex.pitch) holes++;
    }
    if (holes > Math.max(2, 0.05 * candles.length)) warnings.push("trous");
    return {
      ok: candles.length >= 8,
      error: candles.length >= 8 ? null : "bougies",
      message: candles.length >= 8 ? "" : "Trop peu de bougies lues. Dézoome un peu dans MT5 et retire les indicateurs du graphique.",
      candles: candles,
      symbol: loc.symbol, tf: loc.tf, decimals: loc.decimals,
      scale: { a: a, b: b, labels: loc.labelCount, maxResidual: loc.scale.maxResidual },
      region: reg,
      quality: { candleWidth: ex.medW, pitch: ex.pitch, volumeRemoved: ex.volumeRemoved, holes: holes, warnings: warnings },
      priceToY: function (p) { return (p - b) / a; }
    };
  }

  root.DecodeurReader = {
    read: read, extractCandles: extractCandles, parsePrice: parsePrice, parseSymbol: parseSymbol, parseTimeframe: parseTimeframe,
    fitScale: fitScale, TF_ORDER: TF_ORDER
  };
})(typeof window !== "undefined" ? window : globalThis);
