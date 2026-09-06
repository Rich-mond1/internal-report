(function () {
  "use strict";

  var DATA = (window.STORE_CHECKLIST_DATA && window.STORE_CHECKLIST_DATA.categories) || [];
  var SHOPS = (window.STORE_CHECKLIST_DATA && window.STORE_CHECKLIST_DATA.shops) || [];
  var RECIPIENT_EMAIL = (window.STORE_CHECKLIST_DATA && window.STORE_CHECKLIST_DATA.recipientEmail) || "";

  var DB_NAME = "storeVisitDB";
  var STORE_NAME = "kv";
  var VISIT_KEY = "currentVisit";

  var visit = null;
  var currentCategoryId = null;
  var saveTimer = null;

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

  // ---------- Visit model ----------
  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function newVisit() {
    return {
      shopName: "",
      manager: "",
      visitDate: todayISO(),
      overallScore: null,
      categories: {}
    };
  }

  function ensureCategoryState(catId) {
    if (!visit.categories[catId]) {
      visit.categories[catId] = { items: {}, comment: "" };
    }
    return visit.categories[catId];
  }

  function getItemState(state, itemId) {
    return state.items[itemId] || { rating: null, note: "" };
  }

  function setItemRating(state, itemId, rating) {
    var cur = getItemState(state, itemId);
    cur.rating = cur.rating === rating ? null : rating;
    if (cur.rating === null) cur.note = ""; // clear note if rating cleared
    state.items[itemId] = cur;
  }

  function setItemNote(state, itemId, note) {
    var cur = getItemState(state, itemId);
    cur.note = note;
    state.items[itemId] = cur;
  }

  function isRated(itemState) {
    return !!itemState && itemState.rating !== null && itemState.rating !== undefined;
  }

  function isUrgent(cat, rating) {
    if (cat.ratingType === "scale10") return typeof rating === "number" && rating <= 3;
    return rating === "mal";
  }

  function formatRatingTag(cat, rating) {
    if (cat.ratingType === "scale10") return rating + "/10";
    return rating === "bien" ? "OK" : rating === "mejorar" ? "NEEDS WORK" : "POOR";
  }

  function scoreTier(v) {
    if (v <= 3) return "tier-low";
    if (v <= 7) return "tier-mid";
    return "tier-high";
  }

  function hasData(catId) {
    var state = visit.categories[catId];
    if (!state) return false;
    var hasRating = Object.keys(state.items || {}).some(function (k) { return isRated(state.items[k]); });
    var hasComment = !!(state.comment && state.comment.trim());
    return hasRating || hasComment;
  }

  // ---------- DOM refs ----------
  var el = {};
  function cacheEls() {
    [
      "screen-info", "screen-grid", "screen-category",
      "input-shop", "input-manager", "input-date", "btn-continue",
      "summary-text", "btn-edit-info", "category-grid",
      "score-picker", "btn-export", "btn-new-visit", "shop-error", "score-readout", "btn-clear-score",
      "btn-back", "category-title", "category-items", "category-comment",
      "sync-indicator"
    ].forEach(function (id) { el[id] = document.getElementById(id); });
  }

  function populateShopOptions() {
    SHOPS.forEach(function (shop) {
      var opt = document.createElement("option");
      opt.value = shop;
      opt.textContent = shop;
      el["input-shop"].appendChild(opt);
    });
  }

  function showScreen(name) {
    ["screen-info", "screen-grid", "screen-category"].forEach(function (id) {
      el[id].hidden = id !== name;
    });
  }

  // ---------- Rendering ----------
  function renderInfoScreen() {
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

  function renderGrid() {
    renderSummary();
    el["category-grid"].innerHTML = "";
    DATA.forEach(function (cat) {
      var card = document.createElement("div");
      card.className = "cat-card" + (hasData(cat.id) ? " has-data" : "");
      card.setAttribute("data-cat-id", cat.id);
      card.innerHTML =
        '<span class="cat-dot"></span>' +
        '<span class="cat-icon">' + cat.icon + "</span>" +
        '<span class="cat-name">' + escapeHtml(cat.name) + "</span>";
      card.addEventListener("click", function () { openCategory(cat.id); });
      el["category-grid"].appendChild(card);
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

  function findCategory(catId) {
    for (var i = 0; i < DATA.length; i++) {
      if (DATA[i].id === catId) return DATA[i];
    }
    return null;
  }

  function openCategory(catId) {
    currentCategoryId = catId;
    var cat = findCategory(catId);
    var state = ensureCategoryState(catId);

    el["category-title"].textContent = cat.icon + " " + cat.name;
    el["category-items"].innerHTML = "";

    if (!cat.items.length) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No items in this category yet. You can still leave a comment below.";
      el["category-items"].appendChild(empty);
    } else {
      cat.items.forEach(function (item) {
        var row = document.createElement("div");
        row.className = "item-row";
        var itemState = getItemState(state, item.id);

        var label = document.createElement("div");
        label.className = "item-label";
        label.textContent = item.label;
        row.appendChild(label);

        var btnRow = document.createElement("div");
        btnRow.className = cat.ratingType === "scale10" ? "scale-buttons" : "rating-buttons";

        if (cat.ratingType === "scale10") {
          for (var n = 1; n <= 10; n++) {
            (function (val) {
              var btn = document.createElement("button");
              btn.type = "button";
              var sel = itemState.rating === val;
              btn.className = "scale-btn" + (sel ? " selected " + scoreTier(val) : "");
              btn.textContent = String(val);
              btn.addEventListener("click", function () {
                setItemRating(state, item.id, val);
                persistVisit();
                openCategory(catId);
              });
              btnRow.appendChild(btn);
            })(n);
          }
        } else {
          [["bien", "Good"], ["mejorar", "Needs work"], ["mal", "Poor"]].forEach(function (pair) {
            var rating = pair[0], text = pair[1];
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "rating-btn" + (itemState.rating === rating ? " selected" : "");
            btn.setAttribute("data-rating", rating);
            btn.textContent = text;
            btn.addEventListener("click", function () {
              setItemRating(state, item.id, rating);
              persistVisit();
              openCategory(catId); // re-render this category to reflect selection
            });
            btnRow.appendChild(btn);
          });
        }
        row.appendChild(btnRow);

        if (isRated(itemState)) {
          var noteWrap = document.createElement("div");
          noteWrap.className = "item-note-wrap";
          if (itemState.note) {
            noteWrap.appendChild(buildNoteTextarea(item.id, itemState.note));
          } else {
            var toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "item-note-toggle";
            toggle.textContent = "+ Add note (optional)";
            toggle.addEventListener("click", function () {
              noteWrap.innerHTML = "";
              var ta = buildNoteTextarea(item.id, "");
              noteWrap.appendChild(ta);
              ta.focus();
            });
            noteWrap.appendChild(toggle);
          }
          row.appendChild(noteWrap);
        }

        el["category-items"].appendChild(row);
      });
    }

    el["category-comment"].value = state.comment || "";
    showScreen("screen-category");
  }

  function buildNoteTextarea(itemId, value) {
    var ta = document.createElement("textarea");
    ta.className = "item-note-textarea";
    ta.rows = 2;
    ta.placeholder = "Note (optional)";
    ta.value = value;
    ta.addEventListener("input", function () {
      var state = ensureCategoryState(currentCategoryId);
      setItemNote(state, itemId, ta.value);
      persistVisit();
    });
    return ta;
  }

  function backToGrid() {
    if (currentCategoryId) {
      var state = ensureCategoryState(currentCategoryId);
      state.comment = el["category-comment"].value;
      persistVisit();
    }
    currentCategoryId = null;
    renderGrid();
    showScreen("screen-grid");
  }

  // ---------- Export ----------
  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function ratingIcon(cat, rating) {
    if (cat.ratingType === "scale10") return "(" + rating + "/10)";
    return rating === "bien" ? "✅" : rating === "mejorar" ? "⚠️" : "❌";
  }

  function buildEmailBody() {
    var lines = [];
    lines.push("STORE VISIT REPORT");
    lines.push("Shop: " + (visit.shopName || "-"));
    lines.push("Manager on duty: " + (visit.manager || "-"));
    lines.push("Visit date: " + (visit.visitDate || "-"));
    if (visit.overallScore) lines.push("Overall score: " + visit.overallScore + "/5");
    lines.push("");

    var urgent = [];
    DATA.forEach(function (cat) {
      var state = visit.categories[cat.id];
      if (!state) return;
      cat.items.forEach(function (item) {
        var it = state.items[item.id];
        if (isRated(it) && isUrgent(cat, it.rating)) {
          urgent.push("❌ [" + cat.name + "] " + item.label + " (" + formatRatingTag(cat, it.rating) + ")");
        }
      });
    });
    if (urgent.length) {
      lines.push("🚨 URGENT / ACTION REQUIRED");
      lines = lines.concat(urgent);
      lines.push("");
    }

    DATA.forEach(function (cat) {
      var state = visit.categories[cat.id];
      if (!state) return;
      var rated = cat.items.filter(function (item) { return isRated(state.items[item.id]); });
      var comment = (state.comment || "").trim();
      if (!rated.length && !comment) return;

      lines.push(cat.name.toUpperCase());
      rated.forEach(function (item) {
        var it = state.items[item.id];
        lines.push(ratingIcon(cat, it.rating) + " " + item.label);
        if (it.note && it.note.trim()) lines.push("   ↳ Note: " + it.note.trim());
      });
      if (comment) lines.push("Comment: " + comment);
      lines.push("");
    });

    return lines.join("\n");
  }

  function doExport() {
    var subject = "Store Visit Report - " + (visit.shopName || "Unnamed shop") + " - " + (visit.visitDate || todayISO());
    var body = buildEmailBody();

    if (navigator.share) {
      navigator.share({ title: subject, text: body }).catch(function () {
        // User cancelled the share sheet or it failed silently — respect that, no fallback.
      });
      return;
    }

    var to = RECIPIENT_EMAIL ? RECIPIENT_EMAIL.trim() : "";
    var href = "mailto:" + to + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
    window.location.href = href;
  }

  // ---------- Wiring ----------
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
      renderGrid();
      showScreen("screen-grid");
    });

    el["input-shop"].addEventListener("change", function () {
      el["shop-error"].hidden = true;
    });

    el["btn-edit-info"].addEventListener("click", function () {
      renderInfoScreen();
      showScreen("screen-info");
    });

    el["btn-back"].addEventListener("click", backToGrid);

    el["category-comment"].addEventListener("input", function () {
      if (!currentCategoryId) return;
      var state = ensureCategoryState(currentCategoryId);
      state.comment = el["category-comment"].value;
      persistVisit();
      var card = el["category-grid"].querySelector('[data-cat-id="' + currentCategoryId + '"]');
      if (card) card.classList.toggle("has-data", hasData(currentCategoryId));
    });

    el["btn-export"].addEventListener("click", doExport);

    el["btn-clear-score"].addEventListener("click", function () {
      visit.overallScore = null;
      persistVisit();
      renderScorePicker();
    });

    el["btn-new-visit"].addEventListener("click", function () {
      if (!window.confirm("This clears the current visit without saving. Continue?")) return;
      visit = newVisit();
      idbDelete(VISIT_KEY);
      renderInfoScreen();
      showScreen("screen-info");
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
    populateShopOptions();
    wireEvents();
    updateSyncIndicator();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }

    idbGet(VISIT_KEY).then(function (saved) {
      visit = saved || newVisit();
      var started = !!(visit.shopName || visit.manager || Object.keys(visit.categories || {}).length);
      if (started) {
        renderGrid();
        showScreen("screen-grid");
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
