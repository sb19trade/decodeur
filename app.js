/*
 * Décodeur — interface. Tout est calculé sur le téléphone :
 * lecture du texte de l'écran par iOS (pont natif « ocr »), lecture des bougies (reader.js),
 * analyse et rédaction (engine.js). Aucune connexion n'est nécessaire.
 */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, k) {
    if (k == null || k === false) return;
    if (Array.isArray(k)) { k.forEach(function (x) { add(el, x); }); return; }
    el.append(k.nodeType ? k : String(k));
  }
  var reduceMotion = false;
  try { reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  // ---------- Stockage : fichiers de l'appli (pont natif), sinon stockage du navigateur ----------
  var nativeStore = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.store;
  var Store = {
    get: function (key, fallback) {
      if (nativeStore) {
        return nativeStore.postMessage({ op: "get", key: key }).then(function (v) {
          if (v == null) return fallback;
          try { return JSON.parse(v); } catch (e) { return fallback; }
        }).catch(function () { return fallback; });
      }
      try { var v = localStorage.getItem(key); return Promise.resolve(v ? JSON.parse(v) : fallback); }
      catch (e) { return Promise.resolve(fallback); }
    },
    set: function (key, value) {
      var str = JSON.stringify(value);
      if (nativeStore) return nativeStore.postMessage({ op: "set", key: key, value: str }).then(function () { return true; }).catch(function () { return false; });
      try { localStorage.setItem(key, str); return Promise.resolve(true); } catch (e) { return Promise.resolve(false); }
    }
  };

  var SETTINGS_KEY = "decodeur.settings", HIST_KEY = "decodeur.history", MAX_HIST = 20;
  var settings = { capital: 300, devise: "EUR", risque: 1, taux: 1.12 };
  var history = [];
  var current = null;

  function num(v) {
    if (v == null || v === "") return null;
    var n = typeof v === "number" ? v : Number(String(v).replace(/\s/g, "").replace(",", "."));
    return isFinite(n) ? n : null;
  }
  function fmt(n, d) {
    if (d == null) d = 2;
    return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  }
  function sym(cur) { return cur === "EUR" ? "€" : cur === "USD" ? "$" : cur; }
  function money(n, cur) { return fmt(n, 2) + " " + sym(cur); }
  function pctTxt(r) { return fmt(r, r % 1 ? 1 : 0) + " %"; }

  function bindSettings() {
    $("#capital").value = settings.capital != null ? String(settings.capital).replace(".", ",") : "";
    $("#devise").value = settings.devise || "EUR";
    $("#risque").value = settings.risque != null ? String(settings.risque).replace(".", ",") : "";
    $("#taux").value = settings.taux != null ? String(settings.taux).replace(".", ",") : "";
    ["capital", "devise", "risque", "taux"].forEach(function (id) {
      $("#" + id).addEventListener("input", function () {
        settings.capital = num($("#capital").value);
        settings.devise = $("#devise").value;
        settings.risque = num($("#risque").value);
        settings.taux = num($("#taux").value);
        Store.set(SETTINGS_KEY, settings);
        updateAcctSummary();
        if (current) renderResult(current, false);
      });
    });
    updateAcctSummary();
  }
  function updateAcctSummary() {
    var c = num(settings.capital), r = num(settings.risque);
    $("#acctSum").textContent = (c > 0 && r > 0) ? fmt(c, 0) + " " + sym(settings.devise) + " · " + pctTxt(r) : "à renseigner";
  }

  // ---------- Instruments : taille de lot, levier particulier (ESMA), décimales ----------
  var MAJ = ["USD", "EUR", "JPY", "GBP", "CAD", "CHF"];
  var FX = /^(USD|EUR|JPY|GBP|CAD|CHF|AUD|NZD|SEK|NOK|DKK|PLN|HUF|CZK|TRY|ZAR|MXN|SGD|HKD|CNH)$/;
  function spec(raw) {
    var p = String(raw || "").toUpperCase().replace(/[^A-Z]/g, "");
    var m = p.match(/^(XAU|XAG|[A-Z]{3})([A-Z]{3})/);
    if (!m) return null;
    var base = m[1], quote = m[2];
    if (base === "XAU") return { base: base, quote: quote, contract: 100, lev: 20, dec: 2, metal: true };
    if (base === "XAG") return { base: base, quote: quote, contract: 5000, lev: 10, dec: 3, metal: true };
    if (!FX.test(base) || !FX.test(quote)) return null;
    return { base: base, quote: quote, contract: 100000, lev: (MAJ.indexOf(base) > -1 && MAJ.indexOf(quote) > -1) ? 30 : 20, dec: quote === "JPY" ? 3 : 5, metal: false };
  }
  function convert(a, from, to) {
    if (a == null) return null;
    if (from === to) return a;
    var t = num(settings.taux);
    if (!(t > 0)) return null;
    if (from === "USD" && to === "EUR") return a / t;
    if (from === "EUR" && to === "USD") return a * t;
    return null;
  }
  function sizing(sc, sp) {
    var e = num(sc.entree), s = num(sc.stop);
    if (e == null || s == null || e === s) return null;
    if (!sp) return { msg: "Taille de position : calcul indisponible pour cette paire.", warn: false };
    var cap = num(settings.capital), r = num(settings.risque), acc = settings.devise;
    if (!(cap > 0) || !(r > 0)) return { msg: "Renseigne ton capital et ton risque dans « Mon compte » pour voir la taille de position.", warn: false };
    var perMin = Math.abs(e - s) * sp.contract * 0.01;
    var perMinAcc = convert(perMin, sp.quote, acc);
    if (perMinAcc == null) return { msg: "Risque pour 0,01 lot : " + money(perMin, sp.quote) + ". Conversion vers ta devise indisponible.", warn: false };
    var allowed = cap * r / 100;
    var n = Math.floor(Math.min(1e6, allowed / perMinAcc + 1e-9));
    if (n < 1) return { msg: "Même 0,01 lot dépasse ton risque : ce stop coûterait " + money(perMinAcc, acc) + " pour " + money(allowed, acc) + " autorisés (" + pctTxt(r) + "). Passe ce trade ou attends un stop plus court.", warn: true };
    return { msg: "Pour risquer " + pctTxt(r) + " (" + money(allowed, acc) + ") : " + fmt(n * 0.01, 2) + " lot maximum, soit " + money(perMinAcc * n, acc) + " perdus si le stop est touché.", warn: false };
  }
  function marginInfo(price, sp) {
    if (!sp) return null;
    var m, cur;
    if (sp.metal) { if (price == null) return null; m = price * sp.contract * 0.01 / sp.lev; cur = sp.quote; }
    else { m = sp.contract * 0.01 / sp.lev; cur = sp.base; }
    var ma = convert(m, cur, settings.devise);
    return ma == null ? null : { amount: ma, lev: sp.lev };
  }
  function ratio(sc) {
    var e = num(sc.entree), s = num(sc.stop), t1 = num(sc.tp1), t2 = num(sc.tp2);
    if (e == null || s == null) return null;
    var risk = Math.abs(e - s);
    if (!risk) return null;
    return { r1: t1 != null ? Math.abs(t1 - e) / risk : null, r2: t2 != null ? Math.abs(t2 - e) / risk : null };
  }

  // ---------- Captures ----------
  var shots = [], MAX_SHOTS = 3;
  function loadImage(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { res({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("decode")); };
      img.src = url;
    });
  }
  function scaledCanvas(src, w, hh, maxSide) {
    var k = Math.min(1, maxSide / Math.max(w, hh));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(hh * k));
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  async function addFiles(fileList) {
    var files = Array.prototype.filter.call(fileList || [], function (f) { return /^image\//.test(f.type) || /\.(png|jpe?g|heic|heif|webp)$/i.test(f.name || ""); });
    if (!files.length) return;
    var room = MAX_SHOTS - shots.length;
    if (room <= 0) { setStatus("Tu as déjà 3 captures. Retire-en une pour en ajouter une autre.", "err"); return; }
    setStatus("Préparation des captures…", "busy");
    for (var i = 0; i < Math.min(room, files.length); i++) {
      try {
        var loaded = await loadImage(files[i]);
        var w = loaded.img.naturalWidth, hh = loaded.img.naturalHeight;
        var full = scaledCanvas(loaded.img, w, hh, 2600);
        var thumb = scaledCanvas(loaded.img, w, hh, 220).toDataURL("image/jpeg", 0.6);
        URL.revokeObjectURL(loaded.url);
        shots.push({ canvas: full, thumb: thumb });
      } catch (e) {
        setStatus("Cette image n'a pas pu être lue. Fais une capture d'écran classique et réessaie.", "err");
      }
    }
    if (files.length > room) setStatus("Seules les 3 premières captures sont gardées.", "err");
    else setStatus(shots.length ? "Prêt. Lance l'analyse." : "", "");
    renderThumbs(); updateGo();
  }
  function renderThumbs() {
    var t = $("#thumbs"); t.replaceChildren();
    shots.forEach(function (s, i) {
      t.append(h("div", { class: "thumb" }, h("img", { src: s.thumb, alt: "Capture " + (i + 1) }),
        h("button", { type: "button", "aria-label": "Retirer la capture " + (i + 1), onclick: function () { shots.splice(i, 1); renderThumbs(); updateGo(); } }, "×")));
    });
    $("#dropHint").textContent = shots.length
      ? shots.length + " / 3 capture" + (shots.length > 1 ? "s" : "") + " · touche pour en ajouter"
      : "Jusqu'à 3 images, par exemple H1 pour le contexte et M5 pour l'entrée.";
  }
  $("#shots").addEventListener("change", function (e) { addFiles(e.target.files); e.target.value = ""; });

  // ---------- Lecture du texte de l'écran (fournie par iOS) ----------
  function recognize(shot, index) {
    var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ocr;
    if (mh) {
      var dataURL = shot.canvas.toDataURL("image/jpeg", 0.92);
      return mh.postMessage({ image: dataURL }).then(function (r) { return Array.isArray(r) ? r : []; });
    }
    if (typeof window.__mockOCR === "function") return Promise.resolve(window.__mockOCR(index));
    return Promise.reject({ code: "no-ocr" });
  }

  // ---------- Analyse ----------
  var busy = false;
  function setStatus(t, cls) { var s = $("#status"); s.textContent = t; s.className = "status" + (cls ? " " + cls : ""); }
  function updateGo() { $("#go").disabled = busy || !shots.length; }
  function radio(name) { var r = document.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : ""; }
  function nextFrame() { return new Promise(function (r) { setTimeout(r, 30); }); }

  var WARN_TEXT = {
    peu: "Peu de bougies lues : dézoome un peu dans MT5.",
    fines: "Bougies très fines : zoome un peu pour que l'ouverture et la clôture soient lisibles.",
    echelle: "Seulement deux prix lus sur l'axe : vérifie que les niveaux dessinés tombent au bon endroit.",
    trous: "Des bougies manquent : retire les indicateurs (moyennes mobiles, volumes) du graphique."
  };

  async function analyze() {
    if (busy || !shots.length) return;
    busy = true; updateGo();
    var meta = { pair: radio("pair"), tf: radio("tf"), style: radio("style"), n: shots.length };
    try {
      var reads = [];
      for (var i = 0; i < shots.length; i++) {
        setStatus("Lecture de la capture " + (i + 1) + " sur " + shots.length + "…", "busy");
        await nextFrame();
        var ocr = await recognize(shots[i], i);
        var cv = shots[i].canvas;
        var data = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height);
        var rd = DecodeurReader.read({ width: data.width, height: data.height, data: data.data }, ocr);
        if (!rd.ok) {
          setStatus((shots.length > 1 ? "Capture " + (i + 1) + " : " : "") + rd.message, "err");
          return;
        }
        reads.push(rd);
      }
      setStatus("Calcul de l'analyse…", "busy");
      await nextFrame();
      // Paire et unité de temps : on se fie au graphique, sinon au choix de l'utilisateur.
      var readSym = reads.map(function (r) { return r.symbol; }).filter(Boolean)[0] || "";
      var pair = readSym || meta.pair;
      var ecart = "";
      if (readSym && meta.pair && readSym !== meta.pair) ecart = "La capture affiche " + readSym + " : j'ai utilisé la paire lue sur le graphique plutôt que " + meta.pair + ".";
      var tfOverride = "";
      if (reads.length === 1) {
        if (reads[0].tf && meta.tf && reads[0].tf !== meta.tf) ecart += (ecart ? " " : "") + "Unité de temps lue : " + reads[0].tf + " (au lieu de " + meta.tf + ").";
        tfOverride = reads[0].tf || meta.tf;
      }
      var warnings = [];
      reads.forEach(function (r) { if (r.quality.warnings.length && !warnings.length) warnings.push("Lecture de la capture imparfaite : regarde « Contrôle de lecture » avant d'agir."); });
      var analysis = DecodeurEngine.analyze({
        captures: reads.map(function (r) { return { candles: r.candles, symbol: r.symbol, tf: r.tf, decimals: r.decimals }; }),
        pair: pair, tf: tfOverride, style: meta.style, now: new Date(), warnings: warnings, ecart: ecart
      });
      var lecture = reads.map(function (r, idx) {
        return {
          overlay: drawOverlay(shots[idx].canvas, r, idx === analysis.capture_principale ? analysis : null),
          tf: r.tf, symbol: r.symbol, candles: r.candles.length, labels: r.scale.labels,
          pxPrice: Math.abs(r.scale.a), decimals: r.decimals,
          warnings: r.quality.warnings.map(function (w) { return WARN_TEXT[w]; }).filter(Boolean)
        };
      });
      var entry = { id: String(Date.now()), at: Date.now(), meta: meta, data: analysis, thumb: shots[0].thumb, lecture: lecture, example: false };
      renderResult(entry, true);
      history.unshift(entry);
      history = history.slice(0, MAX_HIST);
      Store.set(HIST_KEY, history);
      renderHistory();
      setStatus("Analyse terminée.", "ok");
    } catch (e) {
      if (e && e.code === "no-ocr") setStatus("La lecture du texte de l'écran n'est disponible que dans l'appli iPhone.", "err");
      else { setStatus("La lecture a échoué. Réessaie avec une autre capture.", "err"); if (window.console) console.error(e); }
    } finally {
      busy = false; updateGo();
    }
  }
  $("#go").addEventListener("click", analyze);

  // ---------- Contrôle de lecture : la capture avec ce que l'appli a repéré ----------
  function drawOverlay(canvas, rd, analysis) {
    var reg = rd.region;
    var srcY = reg.top, srcH = reg.bottom - reg.top, srcW = canvas.width;
    var outW = Math.min(720, srcW), k = outW / srcW, outH = Math.round(srcH * k);
    var out = document.createElement("canvas");
    out.width = outW; out.height = outH;
    var ctx = out.getContext("2d");
    ctx.drawImage(canvas, 0, srcY, srcW, srcH, 0, 0, outW, outH);
    if (analysis) {
      analysis.niveaux.forEach(function (n) {
        var y = (rd.priceToY(n.prix) - srcY) * k;
        if (y < 0 || y > outH) return;
        var col = n.type === "resistance" ? "#E5484D" : "#30A46C";
        ctx.save();
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(reg.right * k, y); ctx.stroke();
        ctx.restore();
        ctx.font = "600 13px -apple-system, system-ui, sans-serif";
        var label = fmt(n.prix, rd.decimals || 2);
        var tw = ctx.measureText(label).width;
        ctx.fillStyle = col; ctx.fillRect(4, y - 10, tw + 10, 20);
        ctx.fillStyle = "#FFFFFF"; ctx.fillText(label, 9, y + 5);
      });
    }
    ctx.fillStyle = "#FF9F0A";
    rd.candles.forEach(function (c) {
      var x = c.px.x * k;
      [c.px.top, c.px.bottom].forEach(function (yy) {
        ctx.beginPath(); ctx.arc(x, (yy - srcY) * k, 2.4, 0, Math.PI * 2); ctx.fill();
      });
    });
    return out.toDataURL("image/jpeg", 0.8);
  }

  // Dessin d'un graphique simple pour l'exemple du premier lancement
  function drawExampleChart(candles, analysis, decimals) {
    var W = 720, H = 420, padR = 80;
    var c = document.createElement("canvas"); c.width = W; c.height = H;
    var ctx = c.getContext("2d");
    var dark = false;
    try { dark = window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) {}
    ctx.fillStyle = dark ? "#0C0E12" : "#FFFFFF"; ctx.fillRect(0, 0, W, H);
    var hi = Math.max.apply(null, candles.map(function (k) { return k.h; }));
    var lo = Math.min.apply(null, candles.map(function (k) { return k.l; }));
    var pad = (hi - lo) * 0.1; hi += pad; lo -= pad;
    function y(p) { return (hi - p) / (hi - lo) * H; }
    var pitch = (W - padR - 10) / candles.length, cw = Math.max(2, pitch * 0.65);
    ctx.font = "12px ui-monospace, Menlo, monospace";
    ctx.fillStyle = dark ? "#C4C8CE" : "#3C4046";
    var step = (hi - lo) / 6;
    for (var i = 1; i < 6; i++) { var pv = hi - i * step; ctx.fillText(fmt(pv, decimals), W - padR + 6, y(pv) + 4); }
    candles.forEach(function (k, i) {
      var x = 10 + i * pitch + pitch / 2, bull = k.c >= k.o;
      ctx.strokeStyle = ctx.fillStyle = bull ? "#26A65B" : "#E73E48";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y(k.h)); ctx.lineTo(x, y(k.l)); ctx.stroke();
      var t = y(Math.max(k.o, k.c)), b = y(Math.min(k.o, k.c));
      ctx.fillRect(x - cw / 2, t, cw, Math.max(1.5, b - t));
    });
    analysis.niveaux.forEach(function (n) {
      var yy = y(n.prix), col = n.type === "resistance" ? "#E5484D" : "#30A46C";
      ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W - padR, yy); ctx.stroke(); ctx.restore();
    });
    ctx.fillStyle = "#FF9F0A";
    candles.forEach(function (k, i) {
      var x = 10 + i * pitch + pitch / 2;
      [k.h, k.l].forEach(function (p) { ctx.beginPath(); ctx.arc(x, y(p), 2.2, 0, Math.PI * 2); ctx.fill(); });
    });
    return c.toDataURL("image/jpeg", 0.85);
  }

  // ---------- Rendu du résultat ----------
  var BIAS = { achat: "Biais acheteur", vente: "Biais vendeur", attente: "Attendre" };
  function biasKey(b) { b = String(b || "").toLowerCase(); return b === "achat" || b === "vente" ? b : "attente"; }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function txt(x) { return x == null ? "" : String(x); }
  function clairLine(t) { return t ? h("p", { class: "clair" }, h("b", { text: "En clair · " }), txt(t)) : null; }
  function dateTxt(ts) { try { return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(ts)); } catch (e) { return ""; } }

  function renderResult(entry, scroll) {
    current = entry;
    var root = $("#result");
    root.replaceChildren();
    var d = entry.data || {};
    if (entry.example) root.append(h("p", { class: "example-note" }, h("strong", { text: "Exemple de rendu." }), " Calculé sur un graphique d'exemple, pas sur le marché actuel. Ajoute ta capture pour lancer ta propre analyse."));
    if (d.lisible === false) {
      root.append(h("div", { class: "plain" }, h("p", { class: "eyebrow", text: "Lecture impossible" }), h("p", { class: "big", text: txt(d.probleme) })));
      return;
    }
    var sp = spec(d.paire || entry.meta.pair);
    var dec = sp ? sp.dec : 2;
    var P = function (n) { n = num(n); return n == null ? "—" : fmt(n, dec); };
    var price = num(d.prix);

    root.append(h("div", { class: "r-head" },
      h("h2", { class: "r-sym", text: [txt(d.paire) || "Paire ?", txt(d.unite)].filter(Boolean).join(" · ") }),
      h("span", { class: "r-price", text: P(price) }),
      entry.at && !entry.example ? h("span", { class: "r-time", text: "Analyse du " + dateTxt(entry.at) }) : null));
    if (d.ecart_annonce) root.append(h("p", { class: "note-line", text: txt(d.ecart_annonce) }));

    // Verdict
    var bk = biasKey(d.biais), up = Math.max(0, Math.min(100, Math.round(num(d.proba_hausse) || 50))), down = 100 - up;
    root.append(h("div", { class: "verdict" },
      h("span", { class: "pill " + bk, text: BIAS[bk] }),
      h("div", { class: "prob", role: "img", "aria-label": "Signaux haussiers " + up + " %, baissiers " + down + " %" },
        h("div", { class: "probbar" }, h("i", { class: "up", style: "width:" + up + "%" }), h("i", { class: "down", style: "width:" + down + "%" })),
        h("div", { class: "problbl" }, h("span", { class: "u", text: "Signaux haussiers " + up + " %" }), h("span", { class: "d", text: "baissiers " + down + " %" }))),
      h("p", { class: "probnote", text: "Score indicatif tiré des signaux techniques, pas une probabilité garantie." })));

    // En clair
    var plain = h("div", { class: "plain" }, h("p", { class: "eyebrow", text: "En clair" }));
    if (d.en_clair) plain.append(h("p", { class: "big", text: txt(d.en_clair) }));
    if (arr(d.a_retenir).length) plain.append(h("ul", { class: "keep" }, arr(d.a_retenir).map(function (x) { return h("li", { text: txt(x) }); })));
    root.append(plain);

    // Scénarios
    var scs = arr(d.scenarios);
    if (scs.length) {
      var sec = h("section", { class: "sec" }, h("h2", { text: "Scénarios" }), h("p", { class: "sec-sub", text: "Ce qui doit se produire avant d'entrer, et où sortir." }));
      scs.forEach(function (sc) {
        var tk = biasKey(sc.type);
        var card = h("article", { class: "scn" },
          h("div", { class: "scn-h" }, h("h3", { text: txt(sc.nom) }), h("span", { class: "pill sm " + tk, text: tk === "achat" ? "Achat" : tk === "vente" ? "Vente" : "Attente" })),
          sc.condition ? h("p", { class: "cond" }, h("b", { text: "Déclencheur · " }), txt(sc.condition)) : null);
        if ([sc.entree, sc.stop, sc.tp1, sc.tp2].some(function (v) { return num(v) != null; })) {
          card.append(h("dl", { class: "nums" },
            h("div", null, h("dt", { text: "Entrée" }), h("dd", { text: P(sc.entree) })),
            h("div", null, h("dt", { text: "Stop" }), h("dd", { text: P(sc.stop) })),
            h("div", null, h("dt", { text: "Objectif 1" }), h("dd", { text: P(sc.tp1) })),
            h("div", null, h("dt", { text: "Objectif 2" }), h("dd", { text: P(sc.tp2) }))));
        }
        var rr = ratio(sc);
        if (rr && (rr.r1 != null || rr.r2 != null)) {
          var line = h("p", { class: "rr" }, "Gain possible pour 1 risqué : ");
          var parts = [];
          if (rr.r1 != null) parts.push([rr.r1, "objectif 1"]);
          if (rr.r2 != null) parts.push([rr.r2, "objectif 2"]);
          parts.forEach(function (p, i) { if (i) line.append(" · "); line.append(h("b", { text: fmt(p[0], 1) }), " (" + p[1] + ")"); });
          card.append(line);
        }
        card.append(clairLine(sc.en_clair));
        var sz = sizing(sc, sp);
        if (sz) card.append(h("p", { class: "sizing" + (sz.warn ? " warn" : ""), text: sz.msg }));
        sec.append(card);
      });
      var mi = marginInfo(price, sp);
      if (mi) {
        var cap = num(settings.capital), over = cap > 0 && mi.amount > cap;
        sec.append(h("p", { class: "margin-line" + (over ? " warn" : ""), text: "Marge bloquée pour 0,01 lot : environ " + money(mi.amount, settings.devise) + " (levier 1:" + mi.lev + " pour un particulier en Europe)." + (over ? " Ton capital ne couvre pas cette marge." : "") }));
      }
      root.append(sec);
    }

    // Échelle des prix
    var lv = arr(d.niveaux).filter(function (l) { return num(l.prix) != null; });
    if (lv.length) {
      var rows = lv.map(function (l) { return { k: String(l.type).indexOf("res") === 0 ? "res" : "sup", p: num(l.prix), l: l }; });
      if (price != null) rows.push({ k: "now", p: price, l: null });
      rows.sort(function (a, b) { return b.p - a.p; });
      var lad = h("div", { class: "ladder" });
      rows.forEach(function (r) {
        if (r.k === "now") { lad.append(h("div", { class: "rung now" }, h("span", { class: "px", text: P(r.p) }), h("span", { class: "kind", text: "Prix actuel" }), h("span", { class: "dist", text: "" }))); return; }
        var dd = price != null ? r.p - price : null;
        lad.append(h("div", { class: "rung " + r.k },
          h("span", { class: "px", text: P(r.p) }),
          h("span", { class: "kind" }, r.k === "res" ? "Résistance" : "Support", r.l.force ? h("span", { class: "force", text: " · " + r.l.force }) : null),
          h("span", { class: "dist", text: dd == null ? "" : (dd > 0 ? "+" : "−") + fmt(Math.abs(dd), dec) }),
          r.l.en_clair ? h("span", { class: "why", text: txt(r.l.en_clair) }) : null));
      });
      root.append(h("section", { class: "sec" }, h("h2", { text: "Échelle des prix" }), h("p", { class: "sec-sub", text: "Plafonds au-dessus, planchers en dessous, avec l'écart au prix actuel." }), lad));
    }

    if (arr(d.vigilance).length) root.append(h("section", { class: "sec" }, h("h2", { text: "Vigilance" }), h("ul", { class: "vig" }, arr(d.vigilance).map(function (x) { return h("li", { text: txt(x) }); }))));

    // Contrôle de lecture
    if (arr(entry.lecture).length) {
      var rs = h("section", { class: "sec" }, h("h2", { text: "Contrôle de lecture" }),
        h("p", { class: "sec-sub", text: "Points orange : hauts et bas des bougies repérées. Lignes : niveaux retenus. Si le dessin ne colle pas au graphique, refais la capture." }));
      entry.lecture.forEach(function (l, i) {
        var box = h("div", { class: "reading" });
        if (entry.lecture.length > 1) box.append(h("h3", { text: "Capture " + (i + 1) + (l.tf ? " · " + l.tf : "") }));
        if (l.overlay) box.append(h("img", { src: l.overlay, alt: "Capture annotée avec les bougies et niveaux repérés" }));
        box.append(h("div", { class: "legend" },
          h("span", null, h("i", { style: "background:#FF9F0A" }), "bougie repérée"),
          h("span", null, h("i", { style: "background:#E5484D" }), "résistance"),
          h("span", null, h("i", { style: "background:#30A46C" }), "support")));
        if (l.candles != null) box.append(h("p", { class: "meta", text: l.candles + " bougies lues · échelle sur " + l.labels + " prix · 1 px = " + fmt(l.pxPrice, Math.min(6, (l.decimals || 2) + 2)) }));
        arr(l.warnings).forEach(function (w) { box.append(h("p", { class: "warn", text: w })); });
        rs.append(box);
      });
      root.append(rs);
    }

    // Détail technique
    var group = h("div", { class: "techgroup" });
    function block(title, items) { if (items.length) group.append(h("details", { class: "tech" }, h("summary", { text: title }), h("div", { class: "items" }, items))); }
    function item(name, tech, clair) { return h("div", { class: "item" }, name ? h("p", { class: "nm", text: name }) : null, tech ? h("p", { text: tech }) : null, clairLine(clair)); }
    var trend = [];
    if (d.contexte) trend.push(item("Contexte", d.contexte.technique, d.contexte.en_clair));
    if (d.court_terme) trend.push(item("Court terme", d.court_terme.technique, d.court_terme.en_clair));
    block("Tendance", trend);
    block("Niveaux en détail", lv.map(function (l) { return item((String(l.type).indexOf("res") === 0 ? "Résistance " : "Support ") + P(l.prix), l.technique, l.en_clair); }));
    block("Figures chartistes", arr(d.figures).map(function (f) { return item(f.nom, f.technique, f.en_clair); }));
    block("Chandeliers", arr(d.chandeliers).map(function (f) { return item(f.nom, f.technique, f.en_clair); }));
    block("Indicateurs", arr(d.indicateurs).map(function (f) { return item(f.nom, f.lecture, f.en_clair); }));
    if (d.score && arr(d.score.parts).length) {
      var rowsS = arr(d.score.parts).map(function (p) {
        return h("div", { class: "score-row" }, h("span", { text: p.label }), h("b", { class: p.v > 0 ? "plus" : "minus", text: (p.v > 0 ? "+" : "−") + new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Math.abs(p.v)) }));
      });
      rowsS.push(h("div", { class: "score-row" }, h("strong", { text: "Total" }), h("b", { text: (d.score.total > 0 ? "+" : d.score.total < 0 ? "−" : "") + fmt(Math.abs(d.score.total), 2) })));
      rowsS.push(h("p", { class: "clair" }, h("b", { text: "En clair · " }), "Chaque signal ajoute ou retire des points. Le total donne le pourcentage de signaux haussiers : 50 % + 5 points par unité de score."));
      block("Calcul du score", rowsS);
    }
    block("Lexique", arr(d.lexique).map(function (t) { return item(t.terme, t.definition, ""); }));
    if (group.childNodes.length) root.append(h("section", { class: "sec" }, h("h2", { text: "Détail technique" }), group));

    if (scroll) { try { root.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" }); } catch (e) {} }
  }

  // ---------- Historique ----------
  var confirmClear = false;
  function renderHistory() {
    var list = $("#histList"), tools = $("#histTools");
    list.replaceChildren(); tools.replaceChildren();
    if (!history.length) { list.append(h("p", { class: "empty", text: "Tes analyses apparaîtront ici. Elles restent sur ce téléphone." })); return; }
    history.forEach(function (e) {
      var d = e.data || {}, bk = biasKey(d.biais);
      list.append(h("button", { type: "button", class: "hrow", onclick: function () { showView("analyse"); renderResult(e, true); } },
        e.thumb ? h("img", { src: e.thumb, alt: "" }) : h("span", { class: "ph" }),
        h("span", { style: "min-width:0" }, h("span", { class: "t1", text: [txt(d.paire) || "?", txt(d.unite)].filter(Boolean).join(" · ") }), h("br"), h("span", { class: "t2", text: dateTxt(e.at) })),
        h("span", { class: "pill sm " + bk, text: bk === "achat" ? "Achat" : bk === "vente" ? "Vente" : "Attente" })));
    });
    if (confirmClear) {
      tools.append(h("div", { class: "confirm" }, h("span", { text: "Effacer tout l'historique ?" }),
        h("button", { type: "button", class: "danger", onclick: function () { history = []; Store.set(HIST_KEY, history); confirmClear = false; renderHistory(); } }, "Effacer"),
        h("button", { type: "button", onclick: function () { confirmClear = false; renderHistory(); } }, "Annuler")));
    } else {
      tools.append(h("button", { type: "button", class: "linkbtn", onclick: function () { confirmClear = true; renderHistory(); } }, "Effacer l'historique"));
    }
  }

  // ---------- Onglets ----------
  function showView(v) {
    ["analyse", "hist", "guide"].forEach(function (k) {
      $("#view-" + k).hidden = k !== v;
      $("#tab-" + k).setAttribute("aria-selected", k === v ? "true" : "false");
    });
    try { window.scrollTo(0, 0); } catch (e) {}
  }
  Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) {
    b.addEventListener("click", function () { showView(b.getAttribute("data-view")); });
  });

  // ---------- Exemple affiché au premier lancement ----------
  function exampleEntry() {
    var seed = 12;
    function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
    function g() { return (rnd() + rnd() + rnd() - 1.5) * 1.15; }
    var c = 4150, candles = [];
    for (var i = 0; i < 70; i++) {
      var o = c, drift = i < 25 ? 0.35 : i < 40 ? -0.45 : 0.4;
      var cl = o + drift + g() * 1.3;
      candles.push({ o: o, h: Math.max(o, cl) + Math.abs(g()) * 0.7, l: Math.min(o, cl) - Math.abs(g()) * 0.7, c: cl });
      c = cl;
    }
    var analysis = DecodeurEngine.analyze({ captures: [{ candles: candles, symbol: "XAUUSD", tf: "M5", decimals: 2 }], pair: "XAUUSD", tf: "M5", style: "scalping", now: new Date() });
    return {
      id: "exemple", at: null, example: true, meta: { pair: "XAUUSD", tf: "M5", style: "scalping", n: 1 }, data: analysis, thumb: null,
      lecture: [{ overlay: drawExampleChart(candles, analysis, 2), tf: "M5", candles: null, warnings: [] }]
    };
  }

  // ---------- Démarrage ----------
  (async function init() {
    var s = await Store.get(SETTINGS_KEY, null);
    if (s && typeof s === "object") Object.assign(settings, s);
    var hs = await Store.get(HIST_KEY, []);
    history = Array.isArray(hs) ? hs : [];
    bindSettings();
    renderThumbs();
    renderHistory();
    try { renderResult(exampleEntry(), false); } catch (e) { if (window.console) console.error(e); }
    updateGo();
    setStatus(shots.length ? "Prêt. Lance l'analyse." : "Ajoute une capture pour lancer l'analyse.", "");
  })();
})();
