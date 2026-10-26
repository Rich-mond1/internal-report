(function () {
  "use strict";

  var APP_VERSION = "v10";
  var SCHEMA = 2;

  var DB_NAME = "storeVisitDB";
  var STORE_NAME = "kv";
  var VISIT_KEY = "currentVisit";
  var HISTORY_PREFIX = "lastReport:";

  // ---------- Rating scales ----------
  var SCALE5 = [
    { v: "good",  label: "Good",           cls: "r-good",  tag: "GOOD" },
    { v: "minor", label: "Minor issue",    cls: "r-minor", tag: "MINOR ISSUE" },
    { v: "needs", label: "Needs work",     cls: "r-needs", tag: "NEEDS WORK" },
    { v: "below", label: "Below standard", cls: "r-below", tag: "BELOW STANDARD" },
    { v: "poor",  label: "Poor",           cls: "r-poor",  tag: "POOR" }
  ];
  var YESNO = [
    { v: "yes", label: "Yes", cls: "r-good", tag: "YES" },
    { v: "no",  label: "No",  cls: "r-poor", tag: "NO" }
  ];
  var TRENDS = [
    { v: "resolved", label: "Resolved", cls: "t-resolved", head: "✅ RESOLVED" },
    { v: "improved", label: "Improved", cls: "t-improved", head: "↗ IMPROVED" },
    { v: "same",     label: "Same",     cls: "t-same",     head: "= SAME" },
    { v: "worse",    label: "Worse",    cls: "t-worse",    head: "↘ WORSE" }
  ];
  var TREND_REPORT_ORDER = ["worse", "same", "improved", "resolved"];

  var GROUPS = [
    { id: "visit",      title: "",                      style: "grid" },
    { id: "ip",         title: "IP menu",               style: "buttons" },
    { id: "compliance", title: "Compliance & records",  style: "collapse" }
  ];

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---------- Data (normalised so older data.js files still load) ----------
  function normalizeData(raw) {
    raw = raw || {};
    var features = (raw.features || []).map(function (f) { return { id: f.id, name: f.name || f.id }; });
    var shops = (raw.shops || []).map(function (s) {
      if (typeof s === "string") return { name: s, features: [] };
      return { name: s.name, features: (s.features || []).slice() };
    }).filter(function (s) { return s.name; });
    var cats = (raw.categories || []).map(function (c) {
      var legacy10 = c.ratingType === "scale10";
      return {
        id: c.id,
        name: c.name,
        icon: c.icon || "📋",
        group: c.group || "visit",
        feature: c.feature || "",
        items: (c.items || []).map(function (i) {
          return { id: i.id, label: i.label, type: i.type || (legacy10 ? "scale10" : "scale5"), feature: i.feature || "" };
        })
      };
    });
    return { features: features, shops: shops, categories: cats, recipientEmail: raw.recipientEmail || "" };
  }

  var DB = normalizeData(window.STORE_CHECKLIST_DATA);

  var visit = null;
  var prev = null;          // last exported report for the current shop (snapshot)
  var prevMap = {};
  var currentCategoryId = null;
  var saveTimer = null;
  var openGroups = {};
  var gridScrollY = 0;

  // ---------- IndexedDB ----------
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, "readonly");
        var req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = function () { resolve(req.result ? req.result.value : null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbSet(key, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put({ key: key, value: value });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbDelete(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function persistVisit() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { idbSet(VISIT_KEY, visit); }, 250);
  }

  // ---------- Dates ----------
  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function prettyDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    if (!m) return iso || "";
    return parseInt(m[3], 10) + " " + MONTHS[parseInt(m[2], 10) - 1] + " " + m[1];
  }

  // ---------- Visit model ----------
  function newVisit() {
    return {
      schema: SCHEMA,
      shopName: "",
      manager: "",
      visitDate: todayISO(),
      overallScore: null,
      finalComment: "",
      categories: {},
      carriedShop: "",
      exportSig: ""
    };
  }

  function ensureCategoryState(catId) {
    var st = visit.categories[catId];
    if (!st) { st = { items: {}, comment: "", custom: [] }; visit.categories[catId] = st; }
    if (!st.items) st.items = {};
    if (!st.custom) st.custom = [];
    return st;
  }

  function visitSig() {
    return JSON.stringify([visit.shopName, visit.categories, visit.finalComment, visit.overallScore]);
  }

  // ---------- Shops, features, visibility ----------
  function findShop(name) {
    for (var i = 0; i < DB.shops.length; i++) {
      if (DB.shops[i].name === name) return DB.shops[i];
    }
    return null;
  }

  function shopHas(feature) {
    if (!feature) return true;
    var s = findShop(visit ? visit.shopName : "");
    return !!s && s.features.indexOf(feature) !== -1;
  }

  function groupOf(cat) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].id === cat.group) return cat.group;
    return "visit";
  }

  function itemVisible(item) { return shopHas(item.feature); }

  function customCount(catId) {
    var st = visit && visit.categories[catId];
    return st && st.custom ? st.custom.length : 0;
  }

  function catVisible(cat) {
    if (!shopHas(cat.feature)) return false;
    if (cat.items.length && !cat.items.some(itemVisible)) return customCount(cat.id) > 0;
    return true;
  }

  function visibleCats(groupId) {
    return DB.categories.filter(function (c) { return groupOf(c) === groupId && catVisible(c); });
  }

  function orderedCats() {
    var out = [];
    GROUPS.forEach(function (g) { out = out.concat(visibleCats(g.id)); });
    return out;
  }

  function findCategory(catId) {
    for (var i = 0; i < DB.categories.length; i++) {
      if (DB.categories[i].id === catId) return DB.categories[i];
    }
    return null;
  }

  function itemsFor(cat) {
    var list = cat.items.filter(itemVisible);
    var st = visit.categories[cat.id];
    if (st && st.custom) {
      st.custom.forEach(function (c) {
        list.push({ id: c.id, label: c.label, type: c.type || "scale5", custom: true, carried: !!c.carried });
      });
    }
    return list;
  }

  // ---------- Ratings ----------
  function typeOf(item) {
    return item.type === "yesno" || item.type === "scale10" ? item.type : "scale5";
  }

  function optionsFor(item) {
    return typeOf(item) === "yesno" ? YESNO : SCALE5;
  }

  function findOption(item, rating) {
    var opts = optionsFor(item);
    for (var i = 0; i < opts.length; i++) if (opts[i].v === rating) return opts[i];
    return null;
  }

  function validRating(type, r) {
    if (r === null || r === undefined) return false;
    if (type === "scale10") return typeof r === "number" && r >= 1 && r <= 10;
    if (type === "yesno") return r === "yes" || r === "no";
    return SCALE5.some(function (o) { return o.v === r; });
  }

  function getItemState(st, itemId) {
    return st.items[itemId] || { rating: null, note: "", trend: null };
  }

  function currentRating(item, is) {
    return is && validRating(typeOf(item), is.rating) ? is.rating : null;
  }

  function validTrend(t) {
    return TRENDS.some(function (o) { return o.v === t; });
  }

  function currentTrend(is) {
    return is && validTrend(is.trend) ? is.trend : null;
  }

  function setItemRating(st, itemId, rating) {
    var cur = getItemState(st, itemId);
    cur.rating = cur.rating === rating ? null : rating;
    if (cur.rating === null && !cur.trend) cur.note = "";
    st.items[itemId] = cur;
  }

  function setItemTrend(st, itemId, trend) {
    var cur = getItemState(st, itemId);
    cur.trend = cur.trend === trend ? null : trend;
    if ((cur.rating === null || cur.rating === undefined) && !cur.trend) cur.note = "";
    st.items[itemId] = cur;
  }

  function setItemNote(st, itemId, note) {
    var cur = getItemState(st, itemId);
    cur.note = note;
    st.items[itemId] = cur;
  }

  // "action" = needs attention now, "improve" = should get better, "good" = fine
  function severity(item, rating) {
    var t = typeOf(item);
    if (t === "scale10") return rating <= 3 ? "action" : rating <= 6 ? "improve" : "good";
    if (t === "yesno") return rating === "no" ? "action" : "good";
    if (rating === "poor" || rating === "below") return "action";
    if (rating === "good") return "good";
    return "improve";
  }

  function ratingLabel(item, rating) {
    if (typeOf(item) === "scale10") return rating + "/10";
    var o = findOption(item, rating);
    return o ? o.label : String(rating);
  }

  function ratingTag(item, rating) {
    if (typeOf(item) === "scale10") return rating + "/10";
    var o = findOption(item, rating);
    return o ? o.tag : String(rating).toUpperCase();
  }

  function scoreTier(v) {
    if (v <= 3) return "tier-low";
    if (v <= 7) return "tier-mid";
    return "tier-high";
  }

  // Higher rank = worse. Used to derive a trend when an item is re-rated without picking one.
  function rankOf(item, rating) {
    var t = typeOf(item);
    if (t === "scale10") return 10 - rating;
    if (t === "yesno") return rating === "no" ? 4 : 0;
    for (var i = 0; i < SCALE5.length; i++) if (SCALE5[i].v === rating) return i;
    return null;
  }

  function deriveTrend(item, prevRating, nowRating) {
    var type = typeOf(item);
    if (!validRating(type, prevRating) || !validRating(type, nowRating)) return null;
    if (severity(item, nowRating) === "good") return "resolved";
    var a = rankOf(item, prevRating), b = rankOf(item, nowRating);
    if (a === null || b === null) return null;
    return b < a ? "improved" : b > a ? "worse" : "same";
  }

  // explicit choice wins; otherwise derived from last visit's rating
  function trendFor(cat, item, is) {
    var explicit = currentTrend(is);
    if (explicit) return { value: explicit, derived: false };
    var r = currentRating(item, is);
    var p = prevEntry(cat.id, item.id);
    if (r !== null && p) {
      var d = deriveTrend(item, p.rating, r);
      if (d) return { value: d, derived: true };
    }
    return { value: null, derived: false };
  }

  function hasData(catId) {
    var st = visit.categories[catId];
    if (!st) return false;
    var any = Object.keys(st.items || {}).some(function (k) {
      var s = st.items[k];
      return !!s && ((s.rating !== null && s.rating !== undefined) || !!s.trend);
    });
    return any || !!(st.comment && st.comment.trim());
  }

  function anyVisitData() {
    return !!(visit.finalComment && visit.finalComment.trim()) ||
      visit.overallScore !== null ||
      DB.categories.some(function (c) { return hasData(c.id); });
  }

  // ---------- Follow-up (last exported report per shop, stored on this device) ----------
  function prevKey(catId, itemId) { return catId + "|" + itemId; }

  function setPrev(snap) {
    prev = snap || null;
    prevMap = {};
    if (prev && prev.open) {
      prev.open.forEach(function (o) { prevMap[prevKey(o.cat, o.id)] = o; });
    }
  }

  function prevEntry(catId, itemId) {
    return prevMap[prevKey(catId, itemId)] || null;
  }

  function prevOpenCount(cat) {
    if (!prev) return 0;
    return itemsFor(cat).filter(function (it) { return !!prevEntry(cat.id, it.id); }).length;
  }

  function prevTotalOpen() {
    var n = 0;
    orderedCats().forEach(function (c) { n += prevOpenCount(c); });
    return n;
  }

  function prevDateLabel() {
    return prettyDate((prev && (prev.date || prev.savedAt)) || "");
  }

  function loadPrev() {
    var shop = visit.shopName;
    if (!shop) { setPrev(null); return Promise.resolve(); }
    return idbGet(HISTORY_PREFIX + shop).then(function (snap) {
      if (visit.shopName !== shop) return;
      setPrev(snap);
      adoptCarried();
    }).catch(function () {
      if (visit.shopName === shop) setPrev(null);
    });
  }

  // Custom items that were still open last time come back as items for this visit.
  function adoptCarried() {
    if (visit.carriedShop === visit.shopName) return;
    Object.keys(visit.categories).forEach(function (cid) {
      var st = visit.categories[cid];
      st.custom = (st.custom || []).filter(function (c) {
        if (c.carried) { delete st.items[c.id]; return false; }
        return true;
      });
    });
    if (prev && prev.open) {
      prev.open.forEach(function (o) {
        if (!o.custom) return;
        var cat = findCategory(o.cat);
        if (!cat) return;
        var st = ensureCategoryState(cat.id);
        for (var i = 0; i < st.custom.length; i++) if (st.custom[i].id === o.id) return;
        st.custom.push({ id: o.id, label: o.label, type: o.type || "scale5", carried: true });
      });
    }
    visit.carriedShop = visit.shopName;
    persistVisit();
  }

  // Open items stay open until you resolve them: not re-checked => carried with last rating.
  function snapshotRating(cat, item, is) {
    var r = currentRating(item, is);
    if (r !== null) return r;
    var p = prevEntry(cat.id, item.id);
    if (!p || !validRating(typeOf(item), p.rating)) return null;
    if (currentTrend(is) === "resolved") return null;
    return p.rating;
  }

  function makeSnapshot() {
    var open = [];
    var comments = {};
    orderedCats().forEach(function (cat) {
      var st = visit.categories[cat.id];
      if (st && st.comment && st.comment.trim()) comments[cat.id] = st.comment.trim();
      itemsFor(cat).forEach(function (item) {
        var is = st ? st.items[item.id] : null;
        var r = snapshotRating(cat, item, is);
        if (r === null || severity(item, r) === "good") return;
        var note = is && is.note ? is.note.trim() : "";
        if (!note && currentRating(item, is) === null) {
          var p = prevEntry(cat.id, item.id);
          if (p && p.note) note = p.note;
        }
        open.push({
          cat: cat.id, id: item.id, label: item.label, type: typeOf(item),
          rating: r, note: note, custom: !!item.custom
        });
      });
    });
    return {
      shop: visit.shopName,
      date: visit.visitDate,
      manager: visit.manager,
      score: visit.overallScore,
      savedAt: new Date().toISOString(),
      open: open,
      comments: comments
    };
  }

  function saveSnapshot() {
    if (!visit.shopName) return Promise.resolve();
    return idbSet(HISTORY_PREFIX + visit.shopName, makeSnapshot()).catch(function () {});
  }

  // ---------- Migration of drafts saved by older versions ----------
  var LEGACY_CAT_MAP = {
    "entrance": "front", "cutlery-sauce": "sauce", "displays": "food-line", "food-line": "food-line",
    "prep-area": "prep", "cleaning": "cleaning", "fridges-freezers": "fridges-storage", "equipment": "prep",
    "staff": "team", "knowledge": "team", "sushi": "sushi", "availability": "aggregators",
    "experience": "experience", "storage": "fridges-storage", "rubbish": "cleaning",
    "packaging": "presentation", "office": "records", "presentation": "presentation",
    "health-safety": "hs-coshh", "coshh": "hs-coshh", "deliveries": "fridges-storage",
    "pest-control": "food-safety", "allergen-labelling": "food-safety"
  };
  var LEGACY_NAMES = {
    "entrance": "Entrance", "cutlery-sauce": "Cutlery & Sauce Stations", "displays": "Displays / Fridges",
    "food-line": "Food Line / Fridge", "prep-area": "Prep Area", "cleaning": "Cleaning",
    "fridges-freezers": "Fridges & Freezers", "equipment": "Equipment", "staff": "Staff",
    "knowledge": "Knowledge", "sushi": "Sushi Section", "availability": "Availability",
    "experience": "Experience", "storage": "Storage", "rubbish": "Rubbish", "packaging": "Packaging",
    "office": "Office", "presentation": "Store Presentation", "health-safety": "Health & Safety",
    "coshh": "COSHH / Chemicals", "deliveries": "Deliveries", "pest-control": "Pest Control",
    "allergen-labelling": "Allergen Labelling"
  };
  var LEGACY_RATING = { bien: "good", mejorar: "needs", mal: "poor" };
  // Items removed or merged in v10: if an old draft had data on them, it is kept as a custom item.
  var LEGACY_DROPPED = {
    en6: "iPad/kiosk sanitised",
    di5: "Labels present & correct",
    fl7: "Hot food availability check",
    su3: "Aggregator tablet organised",
    eq2: "Oven deep clean weekly",
    fr4: "Walking fridge deep clean",
    fr5: "Fridges moved & cleaned behind",
    so4: "Staff room cleared before Friday evening",
    st6: "Uniforms taken home & washed daily"
  };
  var LEGACY_SHOP = { "Bow Lane": "Bow Lane IP" };

  function convertLegacyRating(rating, type) {
    if (rating === null || rating === undefined) return null;
    if (typeof rating === "number") return type === "scale10" ? rating : null;
    var mapped = LEGACY_RATING[rating];
    if (!mapped) return null;
    if (type === "yesno") return mapped === "good" ? "yes" : "no";
    if (type === "scale10") return null;
    return mapped;
  }

  function migrateVisit(old) {
    var nv = newVisit();
    nv.shopName = LEGACY_SHOP[old.shopName] || old.shopName || "";
    nv.manager = old.manager || "";
    nv.visitDate = old.visitDate || todayISO();
    nv.overallScore = old.overallScore === undefined ? null : old.overallScore;
    nv.finalComment = old.finalComment || "";

    var home = {};
    var typeById = {};
    DB.categories.forEach(function (c) {
      c.items.forEach(function (i) { home[i.id] = c.id; typeById[i.id] = typeOf(i); });
    });

    var commentParts = {};
    var oldCats = old.categories || {};
    Object.keys(oldCats).forEach(function (oldCat) {
      var st = oldCats[oldCat] || {};
      var target = LEGACY_CAT_MAP[oldCat];
      var items = st.items || {};
      Object.keys(items).forEach(function (itemId) {
        var is = items[itemId];
        if (!is) return;
        var note = is.note || "";
        var hasRating = is.rating !== null && is.rating !== undefined;
        if (!hasRating && !note.trim()) return;
        if (home[itemId]) {
          var cs = nv.categories[home[itemId]];
          if (!cs) { cs = { items: {}, comment: "", custom: [] }; nv.categories[home[itemId]] = cs; }
          cs.items[itemId] = { rating: convertLegacyRating(is.rating, typeById[itemId]), note: note, trend: null };
        } else if (LEGACY_DROPPED[itemId] && target && findCategory(target)) {
          var ts = nv.categories[target];
          if (!ts) { ts = { items: {}, comment: "", custom: [] }; nv.categories[target] = ts; }
          var cid = "x" + itemId;
          ts.custom.push({ id: cid, label: LEGACY_DROPPED[itemId], type: "scale5", carried: false });
          ts.items[cid] = { rating: convertLegacyRating(is.rating, "scale5"), note: note, trend: null };
        }
      });
      if (st.comment && st.comment.trim() && target && findCategory(target)) {
        (commentParts[target] = commentParts[target] || []).push({ from: LEGACY_NAMES[oldCat] || oldCat, text: st.comment.trim() });
      }
    });

    Object.keys(commentParts).forEach(function (target) {
      var parts = commentParts[target];
      var text = parts.length === 1 ? parts[0].text : parts.map(function (p) { return p.from + ": " + p.text; }).join("\n");
      var cs = nv.categories[target];
      if (!cs) { cs = { items: {}, comment: "", custom: [] }; nv.categories[target] = cs; }
      cs.comment = text;
    });
    return nv;
  }

  // ---------- DOM refs ----------
  var el = {};
  function cacheEls() {
    [
      "screen-info", "screen-grid", "screen-category",
      "input-shop", "input-manager", "input-date", "btn-continue",
      "summary-text", "btn-edit-info", "groups-root", "followup-panel",
      "score-picker", "btn-export", "btn-new-visit", "shop-error", "score-readout", "btn-clear-score",
      "build-version-text", "btn-update-app", "final-comment",
      "btn-back", "btn-back-bottom", "btn-next", "category-title", "category-items", "category-comment",
      "category-prev-comment", "btn-add-item", "add-item-form", "new-item-label", "btn-confirm-add-item",
      "btn-cancel-add-item", "sync-indicator"
    ].forEach(function (id) { el[id] = document.getElementById(id); });
  }

  function populateShopOptions() {
    DB.shops.forEach(function (shop) {
      var opt = document.createElement("option");
      opt.value = shop.name;
      opt.textContent = shop.name;
      el["input-shop"].appendChild(opt);
    });
  }

  function ensureShopOption(name) {
    if (!name) return;
    var opts = el["input-shop"].options;
    for (var i = 0; i < opts.length; i++) if (opts[i].value === name) return;
    var opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    el["input-shop"].appendChild(opt);
  }

  function showScreen(name, restoreScroll) {
    ["screen-info", "screen-grid", "screen-category"].forEach(function (id) {
      el[id].hidden = id !== name;
    });
    window.scrollTo(0, restoreScroll ? gridScrollY : 0);
  }

  // ---------- Rendering ----------
  function renderInfoScreen() {
    ensureShopOption(visit.shopName);
    el["input-shop"].value = visit.shopName || "";
    el["input-manager"].value = visit.manager || "";
    el["input-date"].value = visit.visitDate || todayISO();
    el["shop-error"].hidden = true;
  }

  function renderSummary() {
    var parts = [];
    if (visit.shopName) parts.push(visit.shopName);
    if (visit.manager) parts.push(visit.manager);
    if (visit.visitDate) parts.push(visit.visitDate);
    el["summary-text"].textContent = parts.length ? parts.join(" · ") : "Edit shop / manager / date";
  }

  function renderFollowupPanel() {
    var box = el["followup-panel"];
    if (!prev) { box.hidden = true; box.textContent = ""; return; }
    var n = prevTotalOpen();
    box.hidden = false;
    box.textContent = "";
    var title = document.createElement("div");
    title.className = "followup-title";
    var sub = document.createElement("div");
    sub.className = "followup-sub";
    if (n > 0) {
      title.textContent = "Follow-up · last report " + prevDateLabel() + " · " + n + " open item" + (n === 1 ? "" : "s");
      sub.textContent = "Red badges show where. Open a category and mark each one Resolved / Improved / Same / Worse.";
    } else {
      title.textContent = "Last report " + prevDateLabel() + " — nothing was left open";
      sub.textContent = "";
    }
    box.appendChild(title);
    if (sub.textContent) box.appendChild(sub);
  }

  function buildBadge(count) {
    var b = document.createElement("span");
    b.className = "cat-badge";
    b.textContent = String(count);
    return b;
  }

  function buildCard(cat) {
    var card = document.createElement("div");
    card.className = "cat-card" + (hasData(cat.id) ? " has-data" : "");
    card.setAttribute("data-cat-id", cat.id);
    var dot = document.createElement("span");
    dot.className = "cat-dot";
    var icon = document.createElement("span");
    icon.className = "cat-icon";
    icon.textContent = cat.icon;
    var name = document.createElement("span");
    name.className = "cat-name";
    name.textContent = cat.name;
    card.appendChild(dot);
    card.appendChild(icon);
    card.appendChild(name);
    var pc = prevOpenCount(cat);
    if (pc > 0) card.appendChild(buildBadge(pc));
    card.addEventListener("click", function () { openCategory(cat.id, false); });
    return card;
  }

  function buildCardGrid(cats) {
    var grid = document.createElement("div");
    grid.className = "category-grid";
    cats.forEach(function (c) { grid.appendChild(buildCard(c)); });
    return grid;
  }

  function buildGroupButton(cat) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "group-btn" + (hasData(cat.id) ? " has-data" : "");
    btn.setAttribute("data-cat-id", cat.id);
    var icon = document.createElement("span");
    icon.className = "group-btn-icon";
    icon.textContent = cat.icon;
    var name = document.createElement("span");
    name.className = "group-btn-name";
    name.textContent = cat.name;
    var arrow = document.createElement("span");
    arrow.className = "group-btn-arrow";
    arrow.textContent = "›";
    btn.appendChild(icon);
    btn.appendChild(name);
    var pc = prevOpenCount(cat);
    if (pc > 0) {
      var b = buildBadge(pc);
      b.className = "cat-badge inline";
      btn.appendChild(b);
    }
    btn.appendChild(arrow);
    btn.addEventListener("click", function () { openCategory(cat.id, false); });
    return btn;
  }

  function renderGrid() {
    renderSummary();
    el["final-comment"].value = visit.finalComment || "";
    renderFollowupPanel();
    var root = el["groups-root"];
    root.innerHTML = "";

    GROUPS.forEach(function (g) {
      var cats = visibleCats(g.id);
      if (!cats.length) return;

      if (g.style === "grid") {
        root.appendChild(buildCardGrid(cats));
      } else if (g.style === "buttons") {
        var h = document.createElement("div");
        h.className = "group-title";
        h.textContent = g.title;
        root.appendChild(h);
        cats.forEach(function (c) { root.appendChild(buildGroupButton(c)); });
      } else {
        var anyData = cats.some(function (c) { return hasData(c.id); });
        var anyPrev = cats.some(function (c) { return prevOpenCount(c) > 0; });
        var explicit = openGroups[g.id];
        var isOpen = explicit === undefined ? (anyData || anyPrev) : explicit;
        var toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "group-toggle" + (anyData ? " has-data" : "");
        toggle.setAttribute("data-group", g.id);
        toggle.textContent = (isOpen ? "▾ " : "▸ ") + g.title + " (" + cats.length + ")";
        toggle.addEventListener("click", function () {
          openGroups[g.id] = !isOpen;
          renderGrid();
        });
        root.appendChild(toggle);
        if (isOpen) root.appendChild(buildCardGrid(cats));
      }
    });
    renderScorePicker();
  }

  function renderScorePicker() {
    el["score-picker"].innerHTML = "";
    for (var i = 1; i <= 5; i++) {
      (function (val) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "score-btn" + (visit.overallScore === val ? " selected" : "");
        btn.textContent = String(val);
        btn.addEventListener("click", function () {
          visit.overallScore = val;
          persistVisit();
          renderScorePicker();
        });
        el["score-picker"].appendChild(btn);
      })(i);
    }
    el["score-readout"].textContent = visit.overallScore ? ("Selected: " + visit.overallScore + "/5") : "Not set";
  }

  function nextCategory(catId) {
    var cat = findCategory(catId);
    if (!cat) return null;
    var list = visibleCats(groupOf(cat));
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === catId) return list[i + 1] || null;
    }
    return null;
  }

  function openCategory(catId, fromNext) {
    if (!fromNext && !el["screen-grid"].hidden) gridScrollY = window.scrollY || 0;
    currentCategoryId = catId;
    var cat = findCategory(catId);
    var st = ensureCategoryState(catId);

    el["category-title"].textContent = cat.icon + " " + cat.name;

    var pc = prev && prev.comments ? prev.comments[catId] : "";
    if (pc) {
      el["category-prev-comment"].hidden = false;
      el["category-prev-comment"].textContent = "Last visit comment (" + prevDateLabel() + "): " + pc;
    } else {
      el["category-prev-comment"].hidden = true;
      el["category-prev-comment"].textContent = "";
    }

    renderItems(cat);
    el["add-item-form"].hidden = true;
    el["btn-add-item"].hidden = false;
    el["new-item-label"].value = "";
    el["category-comment"].value = st.comment || "";

    var nxt = nextCategory(catId);
    el["btn-next"].textContent = nxt ? "Done → " + nxt.name : "Done → Categories";
    showScreen("screen-category");
  }

  function renderItems(cat) {
    el["category-items"].innerHTML = "";
    var items = itemsFor(cat);
    if (!items.length) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No items in this category yet. Add one below or leave a comment.";
      el["category-items"].appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      el["category-items"].appendChild(buildItemRow(cat, item));
    });
  }

  function shownTrend0(cat, item, is) { return trendFor(cat, item, is); }

  function rebuildRow(cat, item, row) {
    row.parentNode.replaceChild(buildItemRow(cat, item), row);
  }

  function buildItemRow(cat, item) {
    var st = ensureCategoryState(cat.id);
    var is = getItemState(st, item.id);
    var rating = currentRating(item, is);
    var trend = currentTrend(is);
    var p = prevEntry(cat.id, item.id);
    var type = typeOf(item);

    var row = document.createElement("div");
    row.className = "item-row";
    row.setAttribute("data-item-id", item.id);

    var label = document.createElement("div");
    label.className = "item-label";
    label.textContent = item.label;
    if (item.custom) {
      var tagEl = document.createElement("span");
      tagEl.className = "item-tag";
      tagEl.textContent = item.carried ? "carried over" : "added";
      label.appendChild(tagEl);
    }
    row.appendChild(label);

    if (p) {
      var pl = document.createElement("div");
      pl.className = "prev-line";
      var shown = validRating(type, p.rating) ? ratingLabel(item, p.rating) : "";
      pl.textContent = "Last visit (" + prevDateLabel() + "): " + (shown || "open") + (p.note ? " — " + p.note : "");
      row.appendChild(pl);
    }

    var btnRow = document.createElement("div");
    if (type === "scale10") {
      btnRow.className = "scale-buttons";
      for (var n = 1; n <= 10; n++) {
        (function (val) {
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "scale-btn" + (rating === val ? " selected " + scoreTier(val) : "");
          btn.textContent = String(val);
          btn.addEventListener("click", function () {
            setItemRating(st, item.id, val);
            persistVisit();
            rebuildRow(cat, item, row);
          });
          btnRow.appendChild(btn);
        })(n);
      }
    } else {
      btnRow.className = "rating-buttons" + (type === "yesno" ? " yesno" : "");
      optionsFor(item).forEach(function (o) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rating-btn " + o.cls + (rating === o.v ? " selected" : "");
        btn.setAttribute("data-rating", o.v);
        btn.textContent = o.label;
        btn.addEventListener("click", function () {
          setItemRating(st, item.id, o.v);
          persistVisit();
          rebuildRow(cat, item, row);
        });
        btnRow.appendChild(btn);
      });
    }
    row.appendChild(btnRow);

    if (p) {
      var tl = document.createElement("div");
      tl.className = "trend-label";
      tl.textContent = "Since last visit:" + (shownTrend0(cat, item, is).derived ? " (auto — tap to override)" : "");
      row.appendChild(tl);
      var tr = document.createElement("div");
      tr.className = "trend-row";
      var shownTrend = trendFor(cat, item, is);
      TRENDS.forEach(function (o) {
        var tb = document.createElement("button");
        tb.type = "button";
        tb.className = "trend-btn " + o.cls + (trend === o.v ? " selected" : (shownTrend.derived && shownTrend.value === o.v ? " auto" : ""));
        tb.setAttribute("data-trend", o.v);
        tb.textContent = o.label;
        tb.addEventListener("click", function () {
          setItemTrend(st, item.id, o.v);
          persistVisit();
          rebuildRow(cat, item, row);
        });
        tr.appendChild(tb);
      });
      row.appendChild(tr);
    }

    if (rating !== null || trend) {
      var noteWrap = document.createElement("div");
      noteWrap.className = "item-note-wrap";
      if (is.note) {
        noteWrap.appendChild(buildNoteTextarea(cat.id, item.id, is.note));
      } else {
        var toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "item-note-toggle";
        toggle.textContent = "+ Add note (optional)";
        toggle.addEventListener("click", function () {
          noteWrap.innerHTML = "";
          var ta = buildNoteTextarea(cat.id, item.id, "");
          noteWrap.appendChild(ta);
          ta.focus();
        });
        noteWrap.appendChild(toggle);
      }
      row.appendChild(noteWrap);
    }

    if (item.custom) {
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "item-remove";
      rm.textContent = "Remove item";
      rm.addEventListener("click", function () {
        var touched = rating !== null || trend || (is.note && is.note.trim());
        if (touched && !window.confirm("Remove this item and what you entered on it?")) return;
        st.custom = st.custom.filter(function (c) { return c.id !== item.id; });
        delete st.items[item.id];
        persistVisit();
        renderItems(cat);
      });
      row.appendChild(rm);
    }
    return row;
  }

  function buildNoteTextarea(catId, itemId, value) {
    var ta = document.createElement("textarea");
    ta.className = "item-note-textarea";
    ta.rows = 2;
    ta.placeholder = "Note (optional)";
    ta.value = value;
    ta.addEventListener("input", function () {
      setItemNote(ensureCategoryState(catId), itemId, ta.value);
      persistVisit();
    });
    return ta;
  }

  function newItemId() {
    return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  function addCustomItem(catId, label) {
    var st = ensureCategoryState(catId);
    st.custom.push({ id: newItemId(), label: label, type: "scale5", carried: false });
    persistVisit();
  }

  function saveCategoryComment() {
    if (!currentCategoryId) return;
    var st = ensureCategoryState(currentCategoryId);
    st.comment = el["category-comment"].value;
    persistVisit();
  }

  function backToGrid() {
    saveCategoryComment();
    currentCategoryId = null;
    renderGrid();
    showScreen("screen-grid", true);
  }

  function goNext() {
    var cid = currentCategoryId;
    saveCategoryComment();
    var nxt = cid ? nextCategory(cid) : null;
    if (nxt) openCategory(nxt.id, true);
    else backToGrid();
  }

  // ---------- Export ----------
  function entryNoteLines(note) {
    var t = (note || "").trim();
    if (!t) return [];
    var parts = t.split(/\r?\n/);
    var out = ["  ↳ " + parts[0]];
    for (var i = 1; i < parts.length; i++) {
      if (parts[i].trim()) out.push("    " + parts[i]);
    }
    return out;
  }

  function collectEntries() {
    var entries = [];
    orderedCats().forEach(function (cat) {
      var st = visit.categories[cat.id];
      if (!st) return;
      itemsFor(cat).forEach(function (item) {
        var is = st.items[item.id];
        var r = currentRating(item, is);
        var tf = trendFor(cat, item, is);
        if (r === null && !tf.value) return;
        entries.push({
          cat: cat, item: item, rating: r, trend: tf.value,
          sev: r !== null ? severity(item, r) : null,
          note: is && is.note ? is.note : ""
        });
      });
    });
    return entries;
  }

  // Items that were open last time and were neither re-rated nor given a trend
  function collectUnchecked() {
    var out = [];
    if (!prev) return out;
    orderedCats().forEach(function (cat) {
      var st = visit.categories[cat.id];
      itemsFor(cat).forEach(function (item) {
        var p = prevEntry(cat.id, item.id);
        if (!p || !validRating(typeOf(item), p.rating)) return;
        var is = st ? st.items[item.id] : null;
        if (currentRating(item, is) !== null || currentTrend(is)) return;
        out.push({ cat: cat, item: item, p: p });
      });
    });
    return out;
  }

  function categoryComment(cat) {
    var st = visit.categories[cat.id];
    return st && st.comment ? st.comment.trim() : "";
  }

  function buildEmailBody() {
    var lines = [];
    lines.push("STORE VISIT REPORT");
    lines.push("Shop: " + (visit.shopName || "-"));
    lines.push("Manager on duty: " + (visit.manager || "-"));
    lines.push("Visit date: " + (visit.visitDate || "-"));
    if (visit.overallScore) lines.push("Overall score: " + visit.overallScore + "/5");
    lines.push("");

    var entries = collectEntries();
    var tracked = entries.filter(function (e) { return !!e.trend; });
    var plain = entries.filter(function (e) { return !e.trend; });
    var commentShown = {};

    // FOLLOW-UP: items with a trend appear only here (never duplicated below)
    var unchecked = collectUnchecked();
    if (tracked.length || unchecked.length) {
      lines.push("🔁 FOLLOW-UP" + (prev ? " (since " + prevDateLabel() + ")" : ""));
      lines.push("");
      TREND_REPORT_ORDER.forEach(function (tv) {
        var list = tracked.filter(function (e) { return e.trend === tv; });
        if (!list.length) return;
        var head = "";
        TRENDS.forEach(function (o) { if (o.v === tv) head = o.head; });
        lines.push(head);
        list.forEach(function (e) {
          var p = prevEntry(e.cat.id, e.item.id);
          var was = p && validRating(typeOf(e.item), p.rating) ? ratingTag(e.item, p.rating) : "";
          var now = e.rating !== null ? ratingTag(e.item, e.rating) : "";
          var detail = was && now ? " (was " + was + " → now " + now + ")" : was ? " (was " + was + ")" : now ? " (now " + now + ")" : "";
          lines.push("• " + e.cat.name + ": " + e.item.label + detail);
          entryNoteLines(e.note).forEach(function (l) { lines.push(l); });
        });
        lines.push("");
      });
      if (unchecked.length) {
        lines.push("❔ NOT RE-CHECKED (still open)");
        unchecked.forEach(function (u) {
          lines.push("• " + u.cat.name + ": " + u.item.label + " (was " + ratingTag(u.item, u.p.rating) + ")");
          entryNoteLines(u.p.note).forEach(function (l) { lines.push(l); });
        });
        lines.push("");
      }
    }

    function writeSection(sev, heading) {
      var list = plain.filter(function (e) { return e.sev === sev; });
      if (!list.length) return;
      lines.push(heading);
      lines.push("");
      var lastCat = null;
      list.forEach(function (e, idx) {
        if (lastCat !== e.cat.id) {
          if (lastCat !== null) lines.push("");
          lines.push(e.cat.name);
          lastCat = e.cat.id;
        }
        lines.push("• " + e.item.label + " (" + ratingTag(e.item, e.rating) + ")");
        entryNoteLines(e.note).forEach(function (l) { lines.push(l); });
        var next = list[idx + 1];
        if (!next || next.cat.id !== e.cat.id) {
          var c = categoryComment(e.cat);
          if (c && !commentShown[e.cat.id]) {
            lines.push("Comment: " + c);
            commentShown[e.cat.id] = true;
          }
        }
      });
      lines.push("");
    }

    writeSection("action", "🚨 ACTION REQUIRED");
    writeSection("improve", "⚠️ TO IMPROVE");

    // GOOD: compact, one line per category (items with notes are listed on their own)
    var good = plain.filter(function (e) { return e.sev === "good"; });
    if (good.length) {
      lines.push("✅ GOOD");
      lines.push("");
      var seen = [];
      good.forEach(function (e) { if (seen.indexOf(e.cat.id) === -1) seen.push(e.cat.id); });
      seen.forEach(function (cid) {
        var mine = good.filter(function (e) { return e.cat.id === cid; });
        var plainOnes = mine.filter(function (e) { return !(e.note && e.note.trim()); });
        var withNotes = mine.filter(function (e) { return e.note && e.note.trim(); });
        var catName = mine[0].cat.name;
        if (plainOnes.length) {
          lines.push(catName + ": " + plainOnes.map(function (e) {
            return e.item.label + (typeOf(e.item) === "scale10" ? " (" + e.rating + "/10)" : "");
          }).join(" · "));
        }
        withNotes.forEach(function (e) {
          lines.push((plainOnes.length ? "" : catName + ": ") + "• " + e.item.label + " (" + ratingTag(e.item, e.rating) + ")");
          entryNoteLines(e.note).forEach(function (l) { lines.push(l); });
        });
      });
      lines.push("");
    }

    // COMMENTS not already shown under a category above
    var pending = orderedCats().filter(function (c) { return categoryComment(c) && !commentShown[c.id]; });
    if (pending.length) {
      lines.push("💬 COMMENTS");
      lines.push("");
      pending.forEach(function (c) {
        lines.push(c.name + ": " + categoryComment(c));
        lines.push("");
      });
    }

    var finalComment = (visit.finalComment || "").trim();
    if (finalComment) {
      lines.push("SUMMARY");
      lines.push(finalComment);
      lines.push("");
    }

    if (!entries.length && !pending.length && !finalComment) {
      lines.push("(Nothing recorded yet)");
      lines.push("");
    }

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
  }

  function doExport() {
    saveCategoryComment();
    var subject = "Store Visit Report - " + (visit.shopName || "Unnamed shop") + " - " + (visit.visitDate || todayISO());
    var body = buildEmailBody();

    saveSnapshot();
    visit.exportSig = visitSig();
    persistVisit();

    if (navigator.share) {
      navigator.share({ title: subject, text: body }).catch(function () {
        // User cancelled the share sheet or it failed silently — respect that, no fallback.
      });
      return;
    }

    var to = DB.recipientEmail ? DB.recipientEmail.trim() : "";
    var href = "mailto:" + to + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
    window.location.href = href;
  }

  // ---------- Wiring ----------
  function enterGrid() {
    renderGrid();
    showScreen("screen-grid");
    loadPrev().then(function () {
      if (!el["screen-grid"].hidden) {
        var y = window.scrollY || 0;
        renderGrid();
        window.scrollTo(0, y);
      }
    });
  }

  function wireEvents() {
    el["btn-continue"].addEventListener("click", function () {
      var shop = el["input-shop"].value.trim();
      if (!shop) {
        el["shop-error"].hidden = false;
        el["input-shop"].focus();
        return;
      }
      el["shop-error"].hidden = true;
      visit.shopName = shop;
      visit.manager = el["input-manager"].value.trim();
      visit.visitDate = el["input-date"].value || todayISO();
      persistVisit();
      enterGrid();
    });

    el["input-shop"].addEventListener("change", function () {
      el["shop-error"].hidden = true;
    });

    el["btn-edit-info"].addEventListener("click", function () {
      renderInfoScreen();
      showScreen("screen-info");
    });

    el["btn-back"].addEventListener("click", backToGrid);
    el["btn-back-bottom"].addEventListener("click", backToGrid);
    el["btn-next"].addEventListener("click", goNext);

    el["category-comment"].addEventListener("input", function () {
      if (!currentCategoryId) return;
      var st = ensureCategoryState(currentCategoryId);
      st.comment = el["category-comment"].value;
      persistVisit();
    });

    el["btn-add-item"].addEventListener("click", function () {
      el["add-item-form"].hidden = false;
      el["btn-add-item"].hidden = true;
      el["new-item-label"].focus();
    });
    el["btn-cancel-add-item"].addEventListener("click", function () {
      el["add-item-form"].hidden = true;
      el["btn-add-item"].hidden = false;
      el["new-item-label"].value = "";
    });
    function confirmAdd() {
      var label = el["new-item-label"].value.trim();
      if (!label || !currentCategoryId) return;
      addCustomItem(currentCategoryId, label);
      el["new-item-label"].value = "";
      el["add-item-form"].hidden = true;
      el["btn-add-item"].hidden = false;
      renderItems(findCategory(currentCategoryId));
    }
    el["btn-confirm-add-item"].addEventListener("click", confirmAdd);
    el["new-item-label"].addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); confirmAdd(); }
    });

    el["btn-export"].addEventListener("click", doExport);

    el["final-comment"].addEventListener("input", function () {
      visit.finalComment = el["final-comment"].value;
      persistVisit();
    });

    el["btn-update-app"].addEventListener("click", function () {
      el["btn-update-app"].textContent = "Updating...";
      var cleanup = Promise.resolve();

      if ("serviceWorker" in navigator) {
        cleanup = navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister(); }));
        });
      }

      cleanup.then(function () {
        if ("caches" in window) {
          return caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (k) { return caches.delete(k); }));
          });
        }
      }).then(function () {
        location.reload();
      }).catch(function () {
        location.reload();
      });
    });

    el["btn-clear-score"].addEventListener("click", function () {
      visit.overallScore = null;
      persistVisit();
      renderScorePicker();
    });

    el["btn-new-visit"].addEventListener("click", function () {
      var msg;
      if (anyVisitData() && visit.exportSig !== visitSig()) {
        msg = "This visit has changes that were NOT exported yet. Clear it anyway?";
      } else {
        msg = "Start a new visit? The last exported report for this shop stays saved for follow-up.";
      }
      if (!window.confirm(msg)) return;
      visit = newVisit();
      setPrev(null);
      idbDelete(VISIT_KEY);
      renderInfoScreen();
      showScreen("screen-info");
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden" && visit) {
        clearTimeout(saveTimer);
        idbSet(VISIT_KEY, visit);
      }
    });

    window.addEventListener("online", updateSyncIndicator);
    window.addEventListener("offline", updateSyncIndicator);
  }

  function updateSyncIndicator() {
    el["sync-indicator"].classList.toggle("offline", !navigator.onLine);
    el["sync-indicator"].title = navigator.onLine ? "Online" : "No connection (offline mode)";
  }

  // ---------- Init ----------
  function init() {
    cacheEls();
    el["build-version-text"].textContent = APP_VERSION;
    populateShopOptions();
    wireEvents();
    updateSyncIndicator();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }

    idbGet(VISIT_KEY).then(function (saved) {
      var migrated = false;
      if (saved && saved.schema !== SCHEMA) {
        saved = migrateVisit(saved);
        migrated = true;
      }
      visit = saved || newVisit();
      if (!visit.categories) visit.categories = {};
      if (migrated) persistVisit();
      var started = !!(visit.shopName || visit.manager || Object.keys(visit.categories).length);
      if (started) {
        enterGrid();
      } else {
        renderInfoScreen();
        showScreen("screen-info");
      }
    }).catch(function () {
      visit = newVisit();
      renderInfoScreen();
      showScreen("screen-info");
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
