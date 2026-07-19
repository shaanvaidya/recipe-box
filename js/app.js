/* Recipe Box app: state, hash router, views, event wiring. */
(function () {
  "use strict";

  var Ing = window.RecipeBox.Ingredients;
  var Imp = window.RecipeBox.Importers;
  var GH = window.RecipeBox.GitHub;

  var APP_VERSION = "5 — 2026-07-19";
  var CATEGORIES = ["breakfast", "mains", "sides", "soups & salads", "pasta", "dessert", "baking", "drinks", "snacks", "sauces & staples", "other"];
  var IDX_KEY = "rb_index";
  var RECIPE_KEY = "rb_recipe_";

  var state = {
    route: { name: "list" },
    index: null,          // {version, recipes[]}
    indexLoaded: false,
    query: "",
    category: null,
    tags: new Set(),
    sort: "recent",
    current: null,        // full recipe being viewed
    scale: 1,
    metric: false,
    checked: new Set(),   // checked ingredient rows (per session)
    addMode: "url",
    draft: null,          // form draft (add/edit)
    editingId: null,
    photoUrls: {},        // id -> objectURL (session cache)
    cook: null            // {recipe, step, wakeLock, showIngs}
  };

  // ---------- tiny DOM helpers ----------

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function toast(msg, ms) {
    var t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fmtDate(iso) {
    if (!iso) return "";
    // date-only strings would parse as UTC midnight and shift a day locally
    var d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + "T12:00:00") : new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function fmtMinutes(m) {
    if (!m) return null;
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60), r = m % 60;
    return h + " hr" + (r ? " " + r + " min" : "");
  }

  // ---------- offline cache ----------

  function cacheIndex(idx) {
    try { localStorage.setItem(IDX_KEY, JSON.stringify(idx)); } catch (e) { }
  }
  function cachedIndex() {
    try { return JSON.parse(localStorage.getItem(IDX_KEY)); } catch (e) { return null; }
  }
  function cacheRecipe(r) {
    try { localStorage.setItem(RECIPE_KEY + r.id, JSON.stringify(r)); } catch (e) { }
  }
  function cachedRecipe(id) {
    try { return JSON.parse(localStorage.getItem(RECIPE_KEY + id)); } catch (e) { return null; }
  }
  function uncacheRecipe(id) {
    try { localStorage.removeItem(RECIPE_KEY + id); } catch (e) { }
  }

  // ---------- banner ----------

  function showBanner(html) {
    var b = $("#banner");
    b.innerHTML = html;
    b.hidden = false;
  }
  function hideBanner() { $("#banner").hidden = true; }
  function handleApiError(err, fallbackMsg) {
    if (err && err.noToken) {
      showBanner('No access key on this device — <a href="#/settings">add it in Settings</a> to see your recipes.');
    } else if (err && err.authError) {
      showBanner('Your access token was rejected (it may have expired). <a href="#/settings">Paste a new one in Settings</a>.');
    } else if (!navigator.onLine) {
      toast("You're offline");
    } else {
      toast(fallbackMsg || "Something went wrong talking to GitHub");
      if (window.console) console.error(err);
    }
  }

  // ---------- theme ----------

  function initTheme() {
    $("#theme-toggle").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      var next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) { }
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function (ev) {
      var stored = null;
      try { stored = localStorage.getItem("theme"); } catch (e) { }
      if (!stored) document.documentElement.setAttribute("data-theme", ev.matches ? "dark" : "light");
    });
  }

  // ---------- router ----------

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, "");
    var qs = "";
    var qi = h.indexOf("?");
    if (qi !== -1) { qs = h.slice(qi + 1); h = h.slice(0, qi); }
    var parts = h.split("/").filter(Boolean);
    var params = {};
    qs.split("&").forEach(function (kv) {
      if (!kv) return;
      var p = kv.split("=");
      params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || "");
    });
    if (!parts.length) return { name: "list", params: params };
    if (parts[0] === "recipe" && parts[1]) return { name: "recipe", id: decodeURIComponent(parts[1]), params: params };
    if (parts[0] === "add") return { name: "add", params: params };
    if (parts[0] === "edit" && parts[1]) return { name: "edit", id: decodeURIComponent(parts[1]), params: params };
    if (parts[0] === "convert") return { name: "convert", params: params };
    if (parts[0] === "settings") return { name: "settings", params: params };
    return { name: "list", params: params };
  }

  function onRoute() {
    exitCookMode();
    state.route = parseHash();
    var name = state.route.name;
    ["list", "recipe", "add", "edit", "convert", "settings"].forEach(function (v) {
      $("#view-" + v).hidden = (v !== name);
    });
    document.querySelectorAll("[data-nav]").forEach(function (a) {
      var key = a.getAttribute("data-nav");
      var active = (key === "home" && name === "list") ||
        (key === "add" && (name === "add" || name === "edit")) ||
        (key === "convert" && name === "convert") ||
        (key === "settings" && name === "settings");
      a.classList.toggle("active", active);
    });
    $("main").classList.toggle("wide", name === "recipe");
    window.scrollTo(0, 0);
    if (name === "list") renderList();
    else if (name === "recipe") openRecipe(state.route.id);
    else if (name === "add") renderAdd();
    else if (name === "edit") openEdit(state.route.id);
    else if (name === "convert") renderConvert();
    else if (name === "settings") renderSettings();
  }

  // ---------- index loading ----------

  function loadIndex(force) {
    if (!GH.hasToken()) {
      state.index = null;
      state.indexLoaded = true;
      return Promise.resolve(null);
    }
    var cached = cachedIndex();
    if (cached && !state.index) {
      state.index = cached;
      state.indexLoaded = true;
    }
    if (state.index && !force && loadIndex._fetched) return Promise.resolve(state.index);
    return GH.loadIndex().then(function (idx) {
      loadIndex._fetched = true;
      state.index = idx;
      state.indexLoaded = true;
      cacheIndex(idx);
      hideBanner();
      return idx;
    }).catch(function (err) {
      state.indexLoaded = true;
      if (!state.index) handleApiError(err, "Couldn't load your recipes");
      return state.index;
    });
  }

  // ---------- list view ----------

  function allTags() {
    var seen = {};
    var out = [];
    (state.index ? state.index.recipes : []).forEach(function (r) {
      (r.tags || []).forEach(function (t) {
        if (!seen[t]) { seen[t] = true; out.push(t); }
      });
    });
    return out.sort();
  }

  function usedCategories() {
    var seen = {};
    (state.index ? state.index.recipes : []).forEach(function (r) {
      if (r.category) seen[r.category] = true;
    });
    return CATEGORIES.filter(function (c) { return seen[c]; })
      .concat(Object.keys(seen).filter(function (c) { return CATEGORIES.indexOf(c) === -1; }).sort());
  }

  function ingredientHaystack(id) {
    var r = cachedRecipe(id);
    if (!r || !r.ingredients) return "";
    return r.ingredients.map(function (i) { return i.raw || ""; }).join(" ").toLowerCase();
  }

  function filteredRecipes() {
    var list = (state.index ? state.index.recipes : []).slice();
    var q = state.query.trim().toLowerCase();
    if (state.category) list = list.filter(function (r) { return r.category === state.category; });
    if (state.tags.size) {
      list = list.filter(function (r) {
        var tags = r.tags || [];
        var all = true;
        state.tags.forEach(function (t) { if (tags.indexOf(t) === -1) all = false; });
        return all;
      });
    }
    if (q) {
      list = list.filter(function (r) {
        if (r.title.toLowerCase().indexOf(q) !== -1) return true;
        if ((r.tags || []).join(" ").toLowerCase().indexOf(q) !== -1) return true;
        return ingredientHaystack(r.id).indexOf(q) !== -1;
      });
    }
    if (state.sort === "alpha") {
      list.sort(function (a, b) { return a.title.localeCompare(b.title); });
    } else if (state.sort === "favorites") {
      list.sort(function (a, b) {
        if (!!b.favorite - !!a.favorite) return (!!b.favorite - !!a.favorite);
        return String(b.updatedAt).localeCompare(String(a.updatedAt));
      });
    } else {
      list.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
    }
    return list;
  }

  function renderList() {
    var v = $("#view-list");
    if (!GH.hasToken()) {
      v.innerHTML =
        '<div class="empty-state">' +
        '<span class="empty-glyph">Recipe Box</span>' +
        "<h2>A personal cookbook</h2>" +
        "<p>This is Shaan’s private recipe box. Recipes only appear on devices that hold the key.</p>" +
        '<p><a class="btn" href="#/convert">Use the measurement converter</a> &nbsp; ' +
        '<a class="btn-ghost btn" href="#/settings">I have the key</a></p>' +
        "</div>";
      loadIndex();
      return;
    }

    if (!state.indexLoaded && !state.index) {
      v.innerHTML = '<div class="empty-state"><div class="spinner" style="margin:0 auto"></div></div>';
      loadIndex().then(function () { if (state.route.name === "list") renderList(); });
      return;
    }

    var recipes = state.index ? state.index.recipes : [];
    var html = "";
    html += '<h1 class="view-title">Recipes</h1>';
    html += '<p class="view-sub">' + recipes.length + (recipes.length === 1 ? " recipe" : " recipes") + " in the box</p>";

    if (!recipes.length) {
      html += '<div class="empty-state">' +
        '<span class="empty-glyph">~</span>' +
        "<h2>Nothing in the box yet</h2>" +
        "<p>Add your first recipe from a link, pasted text, or by hand.</p>" +
        '<a class="btn btn-accent" href="#/add">Add a recipe</a></div>';
      v.innerHTML = html;
      refreshIndexInBackground();
      return;
    }

    html += '<div class="list-controls">' +
      '<input type="search" class="search-input" id="search-input" placeholder="Search recipes or ingredients…" value="' + esc(state.query) + '">' +
      '<select id="sort-select" aria-label="Sort">' +
      '<option value="recent"' + (state.sort === "recent" ? " selected" : "") + ">Newest</option>" +
      '<option value="alpha"' + (state.sort === "alpha" ? " selected" : "") + ">A–Z</option>" +
      '<option value="favorites"' + (state.sort === "favorites" ? " selected" : "") + ">Favorites</option>" +
      "</select></div>";

    var cats = usedCategories();
    var tags = allTags();
    html += '<div class="filter-rows">';
    if (cats.length) {
      html += '<div class="chip-row" id="cat-row"><span class="chip-row-label">Category</span>';
      cats.forEach(function (c) {
        html += '<button class="chip' + (state.category === c ? " active" : "") + '" data-cat="' + esc(c) + '">' + esc(c) + "</button>";
      });
      html += "</div>";
    }
    if (tags.length) {
      html += '<div class="chip-row" id="tag-row"><span class="chip-row-label">Tags</span>';
      tags.forEach(function (t) {
        html += '<button class="chip chip-tag' + (state.tags.has(t) ? " active" : "") + '" data-tag="' + esc(t) + '">' + esc(t) + "</button>";
      });
      html += "</div>";
    }
    html += "</div>";

    var list = filteredRecipes();
    if (!list.length) {
      html += '<div class="empty-state"><h2>No matches</h2><p>Try a different search or clear the filters.</p></div>';
    } else {
      html += '<ul class="recipe-list">';
      list.forEach(function (r) {
        var meta = [];
        if (r.category) meta.push(r.category);
        if (r.totalMinutes) meta.push(fmtMinutes(r.totalMinutes));
        html += '<li class="recipe-item"><a href="#/recipe/' + encodeURIComponent(r.id) + '">' +
          (r.favorite ? '<span class="fav-star">★</span>' : "") +
          '<span class="recipe-item-title">' + esc(r.title) + "</span>" +
          '<span class="leader"></span>' +
          '<span class="recipe-item-meta">' + esc(meta.join(" · ")) + "</span>" +
          '<span class="mobile-meta">' + esc(meta.join(" · ")) + "</span>" +
          "</a></li>";
      });
      html += "</ul>";
      html += '<p class="count-note">' + list.length + " shown</p>";
    }
    v.innerHTML = html;

    var si = $("#search-input");
    si.addEventListener("input", function () {
      state.query = si.value;
      rerenderListPreservingFocus();
    });
    $("#sort-select").addEventListener("change", function (e) {
      state.sort = e.target.value;
      renderList();
    });
    v.querySelectorAll("[data-cat]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.category = state.category === b.getAttribute("data-cat") ? null : b.getAttribute("data-cat");
        renderList();
      });
    });
    v.querySelectorAll("[data-tag]").forEach(function (b) {
      b.addEventListener("click", function () {
        var t = b.getAttribute("data-tag");
        if (state.tags.has(t)) state.tags.delete(t); else state.tags.add(t);
        renderList();
      });
    });
    refreshIndexInBackground();
  }

  function rerenderListPreservingFocus() {
    var pos = $("#search-input") ? $("#search-input").selectionStart : null;
    renderList();
    var si = $("#search-input");
    if (si && pos !== null) {
      si.focus();
      si.setSelectionRange(pos, pos);
    }
  }

  function refreshIndexInBackground() {
    if (refreshIndexInBackground._busy || !GH.hasToken()) return;
    refreshIndexInBackground._busy = true;
    GH.loadIndex().then(function (idx) {
      refreshIndexInBackground._busy = false;
      var changed = JSON.stringify(idx) !== JSON.stringify(state.index);
      state.index = idx;
      state.indexLoaded = true;
      loadIndex._fetched = true;
      cacheIndex(idx);
      if (changed && state.route.name === "list") rerenderListPreservingFocus();
    }).catch(function () { refreshIndexInBackground._busy = false; });
  }

  // ---------- recipe view ----------

  function openRecipe(id) {
    state.scale = 1;
    state.metric = false;
    state.checked = new Set();
    var cached = cachedRecipe(id);
    if (cached) {
      state.current = cached;
      renderRecipe();
    } else {
      $("#view-recipe").innerHTML = '<div class="empty-state"><div class="spinner" style="margin:0 auto"></div></div>';
    }
    if (!GH.hasToken()) {
      if (!cached) $("#view-recipe").innerHTML = '<div class="empty-state"><h2>Not available</h2><p>This device doesn’t hold the key.</p></div>';
      return;
    }
    GH.loadRecipe(id).then(function (r) {
      cacheRecipe(r);
      var changed = JSON.stringify(r) !== JSON.stringify(state.current);
      state.current = r;
      if (state.route.name === "recipe" && state.route.id === id && (changed || !cached)) renderRecipe();
    }).catch(function (err) {
      if (!cached) {
        if (!navigator.onLine) {
          $("#view-recipe").innerHTML = '<div class="empty-state"><h2>Not available offline</h2><p>Open this recipe once while online and it’ll be cached.</p></div>';
        } else if (err.status === 404) {
          $("#view-recipe").innerHTML = '<div class="empty-state"><h2>Recipe not found</h2><p>It may have been deleted on another device.</p></div>';
        } else {
          handleApiError(err, "Couldn't load that recipe");
        }
      }
    });
  }

  function renderRecipe() {
    var r = state.current;
    if (!r) return;
    var v = $("#view-recipe");
    var html = "";

    html += '<div class="recipe-head">';
    html += '<div class="recipe-cat">' + esc(r.category || "uncategorized") +
      (r.favorite ? ' <span class="fav-star">★ favorite</span>' : "") + "</div>";
    html += '<h1 class="recipe-title">' + esc(r.title) + "</h1>";
    var meta = [];
    if (r.servings) meta.push("<strong>" + esc(getScaledServings(r)) + "</strong> servings");
    if (r.prepMinutes) meta.push("prep <strong>" + fmtMinutes(r.prepMinutes) + "</strong>");
    if (r.cookMinutes) meta.push("cook <strong>" + fmtMinutes(r.cookMinutes) + "</strong>");
    if (meta.length) html += '<div class="recipe-meta-row">' + meta.join("<span aria-hidden=\"true\">·</span>") + "</div>";
    if (r.tags && r.tags.length) {
      html += '<div class="recipe-tags">' + r.tags.map(function (t) { return '<span class="tag-static">' + esc(t) + "</span>"; }).join("") + "</div>";
    }
    html += "</div>";

    if (r.hasPhoto) {
      var cachedUrl = state.photoUrls[r.id];
      html += cachedUrl
        ? '<img class="recipe-photo" id="recipe-photo" src="' + cachedUrl + '" alt="">'
        : '<div class="recipe-photo-ph" id="recipe-photo-ph">photo…</div>';
    }

    html += '<div class="recipe-actions">' +
      '<button class="btn btn-accent" id="cook-btn">Cook</button>' +
      '<button class="btn" id="fav-btn">' + (r.favorite ? "★ Unfavorite" : "☆ Favorite") + "</button>" +
      '<a class="btn" href="#/edit/' + encodeURIComponent(r.id) + '">Edit</a>' +
      '<button class="btn btn-ghost btn-danger" id="delete-btn">Delete</button>' +
      "</div>";

    // scale / unit bar
    html += '<div class="scale-bar">' +
      '<div class="seg" id="scale-seg">' +
      scaleBtn(0.5, "½×") + scaleBtn(1, "1×") + scaleBtn(2, "2×") + scaleBtn(3, "3×") +
      "</div>" +
      '<input type="number" step="0.25" min="0.1" class="scale-input" id="scale-input" value="' + state.scale + '" aria-label="Custom scale">' +
      '<div class="seg" id="unit-seg">' +
      '<button data-unit="us" class="' + (!state.metric ? "active" : "") + '">US</button>' +
      '<button data-unit="metric" class="' + (state.metric ? "active" : "") + '">Metric</button>' +
      "</div>" +
      "</div>";

    html += '<div class="recipe-columns">';
    html += '<div class="recipe-col-ings">';
    html += '<h2 class="section-head">Ingredients</h2>';
    html += '<ul class="ing-list" id="ing-list">';
    (r.ingredients || []).forEach(function (ing, i) {
      if (Ing.isSectionHeader(ing)) {
        html += '<li class="ing-section">' + esc(Ing.sectionLabel(ing.raw)) + "</li>";
        return;
      }
      var d = Ing.displayIngredient(ing, { factor: state.scale, metric: state.metric });
      html += '<li><label class="ing-row"><input type="checkbox" data-ing="' + i + '"' + (state.checked.has(i) ? " checked" : "") + ">" +
        '<span class="ing-text">' +
        (d.qtyText ? '<span class="ing-qty">' + esc(d.qtyText) + "</span> " : "") +
        esc(d.itemText) + "</span></label></li>";
    });
    html += "</ul></div>";

    html += '<div class="recipe-col-steps">';
    html += '<h2 class="section-head">Steps</h2>';
    html += '<ol class="steps-list">';
    (r.steps || []).forEach(function (s) {
      html += "<li><span>" + esc(state.metric ? Ing.annotateStepText(s) : s) + "</span></li>";
    });
    html += "</ol></div></div>";

    html += '<h2 class="section-head">Notes</h2>';
    html += '<div class="notes-block" id="notes-block">';
    var notes = (r.notes || []).slice().reverse();
    if (!notes.length) html += '<p class="view-sub" style="margin:0">No cooking notes yet — jot one down after you make it.</p>';
    notes.forEach(function (n) {
      html += '<div class="note-item"><div class="note-date">' + esc(fmtDate(n.date)) + '</div><div class="note-text">' + esc(n.text) + "</div></div>";
    });
    html += '<div class="note-form"><textarea id="note-input" placeholder="e.g. Used half the sugar — better."></textarea>' +
      '<button class="btn" id="note-btn">Add note</button></div>';
    html += "</div>";

    if (r.sourceUrl) {
      html += '<p class="source-line">Source: <a href="' + esc(r.sourceUrl) + '" target="_blank" rel="noopener">' + esc(shortUrl(r.sourceUrl)) + "</a></p>";
    }
    html += '<p class="source-line">Added ' + esc(fmtDate(r.createdAt)) + (r.updatedAt !== r.createdAt ? " · updated " + esc(fmtDate(r.updatedAt)) : "") + "</p>";

    v.innerHTML = html;

    // photo lazy-load
    if (r.hasPhoto && !state.photoUrls[r.id] && GH.hasToken()) {
      GH.getPhotoObjectUrl(r.id).then(function (url) {
        state.photoUrls[r.id] = url;
        var ph = $("#recipe-photo-ph");
        if (ph && state.route.name === "recipe" && state.route.id === r.id) {
          ph.outerHTML = '<img class="recipe-photo" src="' + url + '" alt="">';
        }
      }).catch(function () {
        var ph = $("#recipe-photo-ph");
        if (ph) ph.textContent = navigator.onLine ? "photo unavailable" : "photo not available offline";
      });
    }

    // events
    $("#cook-btn").addEventListener("click", function () { enterCookMode(r); });
    $("#fav-btn").addEventListener("click", toggleFavorite);
    $("#delete-btn").addEventListener("click", deleteCurrent);
    v.querySelectorAll("#scale-seg button").forEach(function (b) {
      b.addEventListener("click", function () {
        state.scale = parseFloat(b.getAttribute("data-scale"));
        renderRecipe();
      });
    });
    $("#scale-input").addEventListener("change", function (e) {
      var f = parseFloat(e.target.value);
      if (f > 0 && f <= 50) { state.scale = f; renderRecipe(); }
    });
    v.querySelectorAll("#unit-seg button").forEach(function (b) {
      b.addEventListener("click", function () {
        state.metric = b.getAttribute("data-unit") === "metric";
        renderRecipe();
      });
    });
    v.querySelectorAll("[data-ing]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var i = parseInt(cb.getAttribute("data-ing"), 10);
        if (cb.checked) state.checked.add(i); else state.checked.delete(i);
      });
    });
    $("#note-btn").addEventListener("click", addNote);
  }

  function scaleBtn(f, label) {
    return '<button data-scale="' + f + '" class="' + (state.scale === f ? "active" : "") + '">' + label + "</button>";
  }
  function getScaledServings(r) {
    if (!r.servings) return "";
    var s = r.servings * state.scale;
    return (s === Math.floor(s)) ? String(s) : s.toFixed(1);
  }
  function shortUrl(u) {
    return String(u).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 60);
  }

  function requireOnlineAndToken() {
    if (!GH.hasToken()) { toast("Add your access key in Settings first"); return false; }
    if (!navigator.onLine) { toast("You're offline — try again when connected"); return false; }
    return true;
  }

  function toggleFavorite() {
    if (!requireOnlineAndToken()) return;
    var r = state.current;
    r.favorite = !r.favorite;
    r.updatedAt = new Date().toISOString();
    renderRecipe();
    GH.saveRecipe(r).then(function () {
      cacheRecipe(r);
      refreshIndexInBackground();
    }).catch(function (err) {
      r.favorite = !r.favorite;
      renderRecipe();
      handleApiError(err, "Couldn't save favorite");
    });
  }

  function addNote() {
    if (!requireOnlineAndToken()) return;
    var input = $("#note-input");
    var text = input.value.trim();
    if (!text) return;
    var r = state.current;
    r.notes = r.notes || [];
    r.notes.push({ date: todayISO(), text: text });
    r.updatedAt = new Date().toISOString();
    $("#note-btn").disabled = true;
    GH.saveRecipe(r).then(function () {
      cacheRecipe(r);
      renderRecipe();
      toast("Note saved");
    }).catch(function (err) {
      r.notes.pop();
      $("#note-btn").disabled = false;
      handleApiError(err, "Couldn't save note");
    });
  }

  function deleteCurrent() {
    var r = state.current;
    if (!requireOnlineAndToken()) return;
    if (!confirm('Delete "' + r.title + '"? This removes it from the box (it stays in the repo’s git history).')) return;
    GH.deleteRecipe(r.id, r.hasPhoto).then(function () {
      uncacheRecipe(r.id);
      toast("Recipe deleted");
      loadIndex._fetched = false;
      location.hash = "#/";
    }).catch(function (err) { handleApiError(err, "Couldn't delete"); });
  }

  // ---------- add / edit ----------

  function blankDraft() {
    return {
      title: "", sourceUrl: null, category: "", tags: [],
      servings: null, prepMinutes: null, cookMinutes: null,
      ingredientsText: "", stepsText: "",
      imageUrl: null, pendingPhotoB64: null, photoPreview: null,
      warning: null
    };
  }

  function draftFromImport(d) {
    var draft = blankDraft();
    draft.title = d.title || "";
    draft.sourceUrl = d.sourceUrl;
    draft.category = normalizeCategory(d.category);
    draft.tags = d.tags || [];
    draft.servings = d.servings;
    draft.prepMinutes = d.prepMinutes;
    draft.cookMinutes = d.cookMinutes;
    draft.ingredientsText = (d.ingredients || []).join("\n");
    draft.stepsText = (d.steps || []).join("\n");
    draft.imageUrl = d.imageUrl || null;
    draft.warning = d.confidence === "heuristic"
      ? "Read heuristically — double-check ingredients and steps before saving." : null;
    return draft;
  }

  function normalizeCategory(c) {
    if (!c) return "";
    c = String(c).toLowerCase().trim();
    if (CATEGORIES.indexOf(c) !== -1) return c;
    var map = {
      "dinner": "mains", "main": "mains", "main course": "mains", "main dish": "mains", "entree": "mains", "entrée": "mains", "lunch": "mains",
      "side": "sides", "side dish": "sides", "appetizer": "snacks", "appetizers": "snacks", "snack": "snacks",
      "soup": "soups & salads", "salad": "soups & salads", "soups": "soups & salads", "salads": "soups & salads",
      "desserts": "dessert", "sweets": "dessert", "cake": "baking", "bread": "baking", "cookies": "baking",
      "drink": "drinks", "beverage": "drinks", "beverages": "drinks", "cocktail": "drinks",
      "sauce": "sauces & staples", "condiment": "sauces & staples", "condiments": "sauces & staples", "staple": "sauces & staples",
      "brunch": "breakfast"
    };
    return map[c] || c;
  }

  function renderAdd() {
    var v = $("#view-add");
    state.editingId = null;
    var mode = state.route.params.mode || state.addMode;
    state.addMode = mode;
    if (!state.draft) state.draft = blankDraft();

    var html = '<h1 class="view-title">Add a recipe</h1>';
    html += '<div class="seg add-tabs" id="add-tabs">' +
      '<button data-mode="url" class="' + (mode === "url" ? "active" : "") + '">From a link</button>' +
      '<button data-mode="text" class="' + (mode === "text" ? "active" : "") + '">Paste text</button>' +
      '<button data-mode="form" class="' + (mode === "form" ? "active" : "") + '">By hand</button>' +
      "</div>";

    if (mode === "url") {
      html += '<div class="import-panel">' +
        '<div class="import-row">' +
        '<input type="url" id="import-url" placeholder="https://cooking… paste a recipe link" value="">' +
        '<button class="btn btn-accent" id="import-btn">Import</button>' +
        "</div>" +
        '<div class="import-status" id="import-status"></div>' +
        '<p class="import-hint">Works with most recipe sites (anything with standard recipe markup). ' +
        "If a site can’t be fetched, you’ll be offered the paste-text route instead.</p>" +
        "</div>";
      html += '<div id="import-form-slot"></div>';
    } else if (mode === "text") {
      html += '<div class="import-panel">' +
        '<textarea id="import-text" rows="10" placeholder="Paste the whole recipe — title, ingredients, steps. Headers like ‘Ingredients:’ help but aren’t required."></textarea>' +
        '<div style="margin-top:0.6rem"><button class="btn btn-accent" id="parse-text-btn">Parse it</button></div>' +
        '<div class="import-status" id="import-status"></div>' +
        "</div>";
      html += '<div id="import-form-slot"></div>';
    } else {
      html += '<div id="import-form-slot"></div>';
    }

    v.innerHTML = html;

    v.querySelectorAll("#add-tabs button").forEach(function (b) {
      b.addEventListener("click", function () {
        state.addMode = b.getAttribute("data-mode");
        location.hash = "#/add?mode=" + state.addMode;
      });
    });

    if (mode === "url") {
      var doImport = function () {
        var url = $("#import-url").value.trim();
        if (!url) return;
        if (!navigator.onLine) { toast("You're offline"); return; }
        var status = $("#import-status");
        $("#import-btn").disabled = true;
        status.classList.remove("error");
        status.innerHTML = '<div class="spinner"></div> Fetching…';
        Imp.importFromUrl(url, function (msg) {
          status.innerHTML = '<div class="spinner"></div> ' + esc(msg);
        }).then(function (result) {
          $("#import-btn").disabled = false;
          status.textContent = "";
          state.draft = draftFromImport(result.draft);
          if (result.warning) state.draft.warning = result.warning;
          renderForm($("#import-form-slot"));
          $("#import-form-slot").scrollIntoView({ behavior: "smooth", block: "start" });
        }).catch(function (err) {
          $("#import-btn").disabled = false;
          status.classList.add("error");
          status.textContent = (err && err.message ? err.message : "Import failed.") +
            " Try the “Paste text” tab: open the page, select the recipe, copy, and paste it there.";
        });
      };
      $("#import-btn").addEventListener("click", doImport);
      $("#import-url").addEventListener("keydown", function (e) { if (e.key === "Enter") doImport(); });
    } else if (mode === "text") {
      $("#parse-text-btn").addEventListener("click", function () {
        var text = $("#import-text").value;
        if (!text.trim()) return;
        var d = Imp.parseTextRecipe(text);
        if (!d.ingredients.length && !d.steps.length) {
          var st = $("#import-status");
          st.classList.add("error");
          st.textContent = "Couldn't split that into ingredients and steps — edit it below by hand.";
        }
        state.draft = draftFromImport(d);
        renderForm($("#import-form-slot"));
        $("#import-form-slot").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } else {
      renderForm($("#import-form-slot"));
    }
  }

  function openEdit(id) {
    var v = $("#view-edit");
    state.editingId = id;
    var r = cachedRecipe(id);
    var build = function (recipe) {
      var draft = blankDraft();
      draft.title = recipe.title;
      draft.sourceUrl = recipe.sourceUrl;
      draft.category = recipe.category || "";
      draft.tags = recipe.tags || [];
      draft.servings = recipe.servings;
      draft.prepMinutes = recipe.prepMinutes;
      draft.cookMinutes = recipe.cookMinutes;
      draft.ingredientsText = (recipe.ingredients || []).map(function (i) { return i.raw; }).join("\n");
      draft.stepsText = (recipe.steps || []).join("\n");
      draft._existing = recipe;
      state.draft = draft;
      v.innerHTML = '<h1 class="view-title">Edit recipe</h1><div id="edit-form-slot"></div>';
      renderForm($("#edit-form-slot"));
    };
    if (r) { build(r); return; }
    v.innerHTML = '<div class="empty-state"><div class="spinner" style="margin:0 auto"></div></div>';
    GH.loadRecipe(id).then(build).catch(function (err) {
      handleApiError(err, "Couldn't load recipe to edit");
      v.innerHTML = '<div class="empty-state"><h2>Couldn’t load recipe</h2></div>';
    });
  }

  function renderForm(slot) {
    var d = state.draft;
    var isEdit = !!state.editingId;
    var html = "";
    if (d.warning) {
      html += '<div class="banner">' + esc(d.warning) + "</div>";
    }
    html += '<div class="form-grid">';
    html += '<div class="field"><label for="f-title">Title</label><input type="text" id="f-title" value="' + esc(d.title) + '" placeholder="e.g. Chana Masala"></div>';
    html += '<div class="field-row">' +
      '<div class="field"><label for="f-category">Category</label>' +
      '<input type="text" id="f-category" list="cat-list" value="' + esc(d.category) + '" placeholder="mains">' +
      '<datalist id="cat-list">' + CATEGORIES.map(function (c) { return '<option value="' + esc(c) + '">'; }).join("") + "</datalist></div>" +
      '<div class="field"><label for="f-tags">Tags <span style="text-transform:none;letter-spacing:0">(comma-separated)</span></label>' +
      '<input type="text" id="f-tags" value="' + esc(d.tags.join(", ")) + '" placeholder="indian, weeknight"></div>' +
      "</div>";
    html += '<div class="field-row">' +
      '<div class="field"><label for="f-servings">Servings</label><input type="number" id="f-servings" min="1" value="' + (d.servings || "") + '"></div>' +
      '<div class="field"><label for="f-prep">Prep (min)</label><input type="number" id="f-prep" min="0" value="' + (d.prepMinutes || "") + '"></div>' +
      '<div class="field"><label for="f-cook">Cook (min)</label><input type="number" id="f-cook" min="0" value="' + (d.cookMinutes || "") + '"></div>' +
      "</div>";
    html += '<div class="field"><label for="f-ingredients">Ingredients — one per line</label>' +
      '<textarea id="f-ingredients" rows="10" placeholder="1 ½ cups chickpeas&#10;2 tbsp olive oil&#10;salt, to taste">' + esc(d.ingredientsText) + "</textarea>" +
      '<div class="form-hint">End a line with “:” to make a section header (e.g. <em>For the sauce:</em>)</div>' +
      '<div class="parse-preview" id="parse-preview" hidden></div></div>';
    html += '<div class="field"><label for="f-steps">Steps — one per line</label>' +
      '<textarea id="f-steps" rows="10" placeholder="Heat the oil in a large pan.&#10;Add the onion and cook until golden.">' + esc(d.stepsText) + "</textarea></div>";
    html += '<div class="field"><label>Photo</label><div class="photo-field" id="photo-field">' +
      '<input type="file" id="f-photo" accept="image/*" style="max-width:16rem">' +
      '<span id="photo-status" class="form-hint"></span>' +
      "</div></div>";
    if (d.sourceUrl) {
      html += '<p class="form-hint">Source: ' + esc(shortUrl(d.sourceUrl)) + "</p>";
    }
    html += "</div>";
    html += '<div class="form-actions">' +
      '<button class="btn btn-accent" id="save-btn">' + (isEdit ? "Save changes" : "Save to the box") + "</button>" +
      '<a class="btn btn-ghost" href="' + (isEdit ? "#/recipe/" + encodeURIComponent(state.editingId) : "#/") + '">Cancel</a>' +
      '<span id="save-status" class="form-hint"></span>' +
      "</div>";
    slot.innerHTML = html;

    var ingTa = $("#f-ingredients", slot);
    var preview = $("#parse-preview", slot);
    var updatePreview = function () {
      var lines = ingTa.value.split("\n").filter(function (l) { return l.trim(); });
      if (!lines.length) { preview.hidden = true; return; }
      preview.hidden = false;
      preview.innerHTML = "<strong style='font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em'>How I read it</strong><br>" +
        lines.map(function (l) {
          var p = Ing.parseIngredient(l);
          if (Ing.isSectionHeader(p)) return '<span class="ps">— ' + esc(Ing.sectionLabel(l)) + " —</span>";
          if (p.qty === null) return "· " + esc(l);
          var qty = Ing.formatQty(p.qty) + (p.qtyHigh ? "–" + Ing.formatQty(p.qtyHigh) : "");
          return '· <span class="pq">' + esc(qty) + "</span>" +
            (p.unit ? ' <span class="pu">' + esc(p.unit) + "</span>" : "") +
            " " + esc(p.item || "");
        }).join("<br>");
    };
    ingTa.addEventListener("input", debounce(updatePreview, 300));
    updatePreview();

    // photo: import-url thumbnail or picked file
    if (d.photoPreview) setPhotoThumb(slot, d.photoPreview);
    else if (d.imageUrl && !d.pendingPhotoB64) {
      $("#photo-status", slot).textContent = "importing photo from the page…";
      fetchImageAsJpeg(d.imageUrl).then(function (res) {
        d.pendingPhotoB64 = res.b64;
        d.photoPreview = res.dataUrl;
        if ($("#photo-field", slot)) {
          setPhotoThumb(slot, res.dataUrl);
          $("#photo-status", slot).textContent = "photo imported from the page";
        }
      }).catch(function () {
        if ($("#photo-status", slot)) $("#photo-status", slot).textContent = "couldn't import the page photo — pick one manually if you like";
      });
    }
    $("#f-photo", slot).addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      $("#photo-status", slot).textContent = "compressing…";
      compressImageFile(file).then(function (res) {
        d.pendingPhotoB64 = res.b64;
        d.photoPreview = res.dataUrl;
        setPhotoThumb(slot, res.dataUrl);
        $("#photo-status", slot).textContent = "ready (" + Math.round(res.b64.length * 3 / 4 / 1024) + " KB)";
      }).catch(function () {
        $("#photo-status", slot).textContent = "couldn't read that image";
      });
    });

    $("#save-btn", slot).addEventListener("click", function () { saveDraft(slot); });
  }

  function setPhotoThumb(slot, dataUrl) {
    var pf = $("#photo-field", slot);
    var old = pf.querySelector(".photo-thumb");
    if (old) old.remove();
    var img = document.createElement("img");
    img.className = "photo-thumb";
    img.src = dataUrl;
    pf.insertBefore(img, pf.firstChild);
  }

  function saveDraft(slot) {
    if (!requireOnlineAndToken()) return;
    var d = state.draft;
    var title = $("#f-title", slot).value.trim();
    if (!title) { toast("Give it a title"); return; }
    var ingredients = $("#f-ingredients", slot).value.split("\n")
      .map(function (l) { return l.trim(); }).filter(Boolean)
      .map(function (l) { return Ing.parseIngredient(l); });
    var steps = $("#f-steps", slot).value.split("\n")
      .map(function (l) { return l.trim(); }).filter(Boolean);
    var now = new Date().toISOString();
    var existing = d._existing;

    var recipe = existing ? JSON.parse(JSON.stringify(existing)) : {};
    recipe.title = title;
    recipe.sourceUrl = d.sourceUrl || (existing ? existing.sourceUrl : null);
    recipe.category = normalizeCategory($("#f-category", slot).value.trim()) || null;
    recipe.tags = $("#f-tags", slot).value.split(",").map(function (t) { return t.trim().toLowerCase(); }).filter(Boolean);
    recipe.servings = parseInt($("#f-servings", slot).value, 10) || null;
    recipe.prepMinutes = parseInt($("#f-prep", slot).value, 10) || null;
    recipe.cookMinutes = parseInt($("#f-cook", slot).value, 10) || null;
    recipe.ingredients = ingredients;
    recipe.steps = steps;
    recipe.notes = existing ? (existing.notes || []) : [];
    recipe.favorite = existing ? !!existing.favorite : false;
    recipe.createdAt = existing ? existing.createdAt : now;
    recipe.updatedAt = now;
    if (!existing) {
      recipe.id = makeId(title);
      recipe.hasPhoto = false;
    }
    if (d.pendingPhotoB64) recipe.hasPhoto = true;

    var btn = $("#save-btn", slot);
    var status = $("#save-status", slot);
    btn.disabled = true;
    status.textContent = "saving…";

    var photoStep = d.pendingPhotoB64
      ? GH.putPhoto(recipe.id, d.pendingPhotoB64).then(function () {
        if (state.photoUrls[recipe.id]) { URL.revokeObjectURL(state.photoUrls[recipe.id]); delete state.photoUrls[recipe.id]; }
      })
      : Promise.resolve();

    photoStep.then(function () {
      return GH.saveRecipe(recipe);
    }).then(function (result) {
      cacheRecipe(recipe);
      loadIndex._fetched = false;
      state.draft = null;
      state.editingId = null;
      toast(result.indexOk ? "Saved" : "Saved (index will catch up)");
      location.hash = "#/recipe/" + encodeURIComponent(recipe.id);
    }).catch(function (err) {
      btn.disabled = false;
      status.textContent = "";
      handleApiError(err, "Couldn't save — your text is still here, try again");
    });
  }

  function makeId(title) {
    var slug = title.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "recipe";
    var d = new Date();
    var id = slug + "-" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    var existing = state.index ? state.index.recipes : [];
    var base = id, n = 2;
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].id === id) { id = base + "-" + (n++); i = -1; }
    }
    return id;
  }

  // ---------- photos ----------

  function compressImageFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function () {
        var img = new Image();
        img.onerror = reject;
        img.onload = function () { resolve(drawToJpeg(img)); };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function fetchImageAsJpeg(url) {
    var attempts = [url, "https://api.allorigins.win/raw?url=" + encodeURIComponent(url)];
    function tryAt(i) {
      if (i >= attempts.length) return Promise.reject(new Error("image fetch failed"));
      return fetch(attempts[i]).then(function (res) {
        if (!res.ok) throw new Error("http " + res.status);
        return res.blob();
      }).then(function (blob) {
        if (!/^image\//.test(blob.type) && blob.size < 2000) throw new Error("not an image");
        return createImageBitmap(blob).then(drawToJpeg);
      }).catch(function () { return tryAt(i + 1); });
    }
    return tryAt(0);
  }

  function drawToJpeg(img) {
    var MAX = 1200;
    var w = img.width, h = img.height;
    if (!w || !h) throw new Error("bad image");
    var scale = Math.min(1, MAX / Math.max(w, h));
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    var dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    return { dataUrl: dataUrl, b64: dataUrl.split(",")[1] };
  }

  // ---------- cook mode ----------

  function enterCookMode(recipe) {
    state.cook = { recipe: recipe, step: 0, wakeLock: null, showIngs: false };
    renderCookMode();
    $("#cook-mode").hidden = false;
    document.body.style.overflow = "hidden";
    acquireWakeLock();
    document.addEventListener("visibilitychange", onVisibility);
  }

  function acquireWakeLock() {
    if (!state.cook) return;
    if ("wakeLock" in navigator) {
      navigator.wakeLock.request("screen").then(function (wl) {
        if (state.cook) state.cook.wakeLock = wl; else wl.release();
      }).catch(function () { });
    }
  }
  function onVisibility() {
    if (document.visibilityState === "visible" && state.cook) acquireWakeLock();
  }

  function exitCookMode() {
    if (!state.cook) return;
    if (state.cook.wakeLock) { try { state.cook.wakeLock.release(); } catch (e) { } }
    document.removeEventListener("visibilitychange", onVisibility);
    state.cook = null;
    $("#cook-mode").hidden = true;
    document.body.style.overflow = "";
  }

  function renderCookMode() {
    var c = state.cook;
    var r = c.recipe;
    var steps = r.steps || [];
    var el = $("#cook-mode");
    var stepText = steps.length ? steps[c.step] : "This recipe has no steps written down.";
    if (state.metric) stepText = Ing.annotateStepText(stepText);

    var html = '<div class="cook-head">' +
      '<button class="btn btn-ghost" id="cook-exit">✕ Exit</button>' +
      '<span class="cook-title">' + esc(r.title) + "</span>" +
      '<span class="cook-progress">' + (steps.length ? (c.step + 1) + " / " + steps.length : "—") + "</span>" +
      "</div>";
    html += '<div class="cook-body"><div class="cook-step-text">' +
      '<span class="cook-step-num">Step ' + (c.step + 1) + "</span>" + esc(stepText) + "</div></div>";
    if (!("wakeLock" in navigator)) {
      html += '<div class="cook-hint">Tip: keep your screen awake in your phone settings while cooking.</div>';
    }
    html += '<div class="cook-nav">' +
      '<button class="btn" id="cook-prev"' + (c.step === 0 ? " disabled" : "") + ">← Back</button>" +
      '<button class="btn" id="cook-ings">Ingredients</button>' +
      (c.step < steps.length - 1
        ? '<button class="btn btn-accent" id="cook-next">Next →</button>'
        : '<button class="btn btn-accent" id="cook-done">Done</button>') +
      "</div>";
    html += '<div class="cook-ing-sheet" id="cook-ing-sheet"' + (c.showIngs ? "" : " hidden") + '><ul class="ing-list">';
    (r.ingredients || []).forEach(function (ing, i) {
      if (Ing.isSectionHeader(ing)) {
        html += '<li class="ing-section">' + esc(Ing.sectionLabel(ing.raw)) + "</li>";
        return;
      }
      var d = Ing.displayIngredient(ing, { factor: state.scale, metric: state.metric });
      html += '<li><label class="ing-row"><input type="checkbox" data-cing="' + i + '"' + (state.checked.has(i) ? " checked" : "") + ">" +
        '<span class="ing-text">' + (d.qtyText ? '<span class="ing-qty">' + esc(d.qtyText) + "</span> " : "") + esc(d.itemText) + "</span></label></li>";
    });
    html += "</ul></div>";
    el.innerHTML = html;

    $("#cook-exit").addEventListener("click", exitCookMode);
    if ($("#cook-prev")) $("#cook-prev").addEventListener("click", function () { c.step = Math.max(0, c.step - 1); renderCookMode(); });
    if ($("#cook-next")) $("#cook-next").addEventListener("click", function () { c.step++; renderCookMode(); });
    if ($("#cook-done")) $("#cook-done").addEventListener("click", exitCookMode);
    $("#cook-ings").addEventListener("click", function () { c.showIngs = !c.showIngs; renderCookMode(); });
    el.querySelectorAll("[data-cing]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var i = parseInt(cb.getAttribute("data-cing"), 10);
        if (cb.checked) state.checked.add(i); else state.checked.delete(i);
      });
    });
  }

  // ---------- converter ----------

  var convState = { tab: "volume" };

  function renderConvert() {
    var v = $("#view-convert");
    var html = '<h1 class="view-title">Converter</h1>' +
      '<p class="view-sub">Kitchen math, no recipe required.</p>';
    html += '<div class="seg conv-tabs" id="conv-tabs">' +
      convTabBtn("volume", "Volume") + convTabBtn("weight", "Weight") +
      convTabBtn("temp", "Oven") + convTabBtn("baking", "Cups ↔ Grams") +
      "</div>";
    html += '<div class="conv-panel" id="conv-panel"></div>';
    html += quickRefHtml();
    v.innerHTML = html;
    v.querySelectorAll("#conv-tabs button").forEach(function (b) {
      b.addEventListener("click", function () {
        convState.tab = b.getAttribute("data-tab");
        renderConvert();
      });
    });
    renderConvPanel();
  }

  function convTabBtn(id, label) {
    return '<button data-tab="' + id + '" class="' + (convState.tab === id ? "active" : "") + '">' + label + "</button>";
  }

  function unitOptions(kind, selected) {
    return Ing.UNITS.filter(function (u) { return u.kind === kind; })
      .map(function (u) {
        return '<option value="' + u.id + '"' + (u.id === selected ? " selected" : "") + ">" + esc(u.many) + "</option>";
      }).join("");
  }

  function renderConvPanel() {
    var p = $("#conv-panel");
    var tab = convState.tab;
    var html = "";
    if (tab === "baking") {
      html += '<div class="conv-ing-select"><select id="cv-density">' +
        Ing.DENSITIES.map(function (d) { return '<option value="' + d.id + '">' + esc(d.label) + "</option>"; }).join("") +
        "</select></div>";
      html += '<div class="conv-grid">' +
        '<div class="conv-cell"><input type="number" id="cv-a" value="1" step="any"><select id="cv-a-unit">' + unitOptions("volume", "cup") + "</select></div>" +
        '<div class="conv-eq">=</div>' +
        '<div class="conv-cell"><input type="number" id="cv-b" step="any"><span class="form-hint" style="text-align:center">grams</span></div>' +
        "</div>";
      html += '<p class="conv-footnote">Spoon-and-level cup measures. Densities are sensible averages — close enough for cooking, double-check for finicky baking.</p>';
    } else if (tab === "temp") {
      html += '<div class="conv-grid">' +
        '<div class="conv-cell"><input type="number" id="cv-a" value="350" step="any"><span class="form-hint" style="text-align:center">°F</span></div>' +
        '<div class="conv-eq">=</div>' +
        '<div class="conv-cell"><input type="number" id="cv-b" step="any"><span class="form-hint" style="text-align:center">°C</span></div>' +
        "</div>";
      html += '<p class="conv-footnote">For fan/convection ovens, drop about 20°C (25°F).</p>';
    } else {
      var defA = tab === "volume" ? "cup" : "oz";
      var defB = tab === "volume" ? "ml" : "g";
      html += '<div class="conv-grid">' +
        '<div class="conv-cell"><input type="number" id="cv-a" value="1" step="any"><select id="cv-a-unit">' + unitOptions(tab, defA) + "</select></div>" +
        '<div class="conv-eq">=</div>' +
        '<div class="conv-cell"><input type="number" id="cv-b" step="any"><select id="cv-b-unit">' + unitOptions(tab, defB) + "</select></div>" +
        "</div>";
    }
    p.innerHTML = html;

    var a = $("#cv-a"), b = $("#cv-b");
    var aUnit = $("#cv-a-unit"), bUnit = $("#cv-b-unit"), density = $("#cv-density");

    function calc(fromA) {
      var src = fromA ? a : b, dst = fromA ? b : a;
      var val = parseFloat(src.value);
      if (isNaN(val)) { dst.value = ""; return; }
      var out = null;
      if (tab === "temp") {
        out = fromA ? (val - 32) * 5 / 9 : val * 9 / 5 + 32;
      } else if (tab === "baking") {
        out = fromA
          ? Ing.volumeToGrams(val, aUnit.value, density.value)
          : Ing.gramsToVolume(val, aUnit.value, density.value);
      } else {
        out = fromA
          ? Ing.convertAmount(val, aUnit.value, bUnit.value)
          : Ing.convertAmount(val, bUnit.value, aUnit.value);
      }
      dst.value = out === null ? "" : String(Math.round(out * 100) / 100);
    }
    a.addEventListener("input", function () { calc(true); });
    b.addEventListener("input", function () { calc(false); });
    if (aUnit) aUnit.addEventListener("change", function () { calc(true); });
    if (bUnit) bUnit.addEventListener("change", function () { calc(true); });
    if (density) density.addEventListener("change", function () { calc(true); });
    calc(true);
  }

  function quickRefHtml() {
    return '<div class="conv-quickref"><h2 class="section-head">Quick reference</h2><table>' +
      "<tr><th>This</th><th>Equals</th></tr>" +
      "<tr><td>1 tbsp</td><td>3 tsp · 15 ml</td></tr>" +
      "<tr><td>1 cup</td><td>16 tbsp · 240 ml</td></tr>" +
      "<tr><td>1 stick butter</td><td>½ cup · 113 g</td></tr>" +
      "<tr><td>1 cup flour</td><td>120 g</td></tr>" +
      "<tr><td>1 cup sugar</td><td>200 g</td></tr>" +
      "<tr><td>1 lb</td><td>454 g</td></tr>" +
      "<tr><td>350°F</td><td>175°C · gas 4</td></tr>" +
      "<tr><td>425°F</td><td>220°C · gas 7</td></tr>" +
      "</table></div>";
  }

  // ---------- settings ----------

  function renderSettings() {
    var v = $("#view-settings");
    var hasToken = GH.hasToken();
    var html = '<h1 class="view-title">Settings</h1>';

    html += '<div class="settings-block"><h2>Access key</h2>' +
      "<p>Recipes live in the private GitHub repo <code>" + GH.OWNER + "/" + GH.REPO + "</code>. " +
      "Paste a fine-grained personal access token (Contents: read &amp; write, that repo only) to unlock this device.</p>" +
      '<div class="import-row"><input type="password" id="token-input" placeholder="github_pat_…" autocomplete="off">' +
      '<button class="btn btn-accent" id="token-save">Unlock</button></div>' +
      '<p class="token-status" id="token-status">' + (hasToken ? "checking stored key…" : "no key on this device") + "</p>" +
      (hasToken ? '<button class="btn btn-ghost btn-danger btn-small" id="token-clear">Forget key on this device</button>' : "") +
      "</div>";

    html += '<div class="settings-block"><h2>Maintenance</h2>' +
      "<p>If the recipe list ever looks out of sync (a save was interrupted), rebuild the index from the recipe files.</p>" +
      '<button class="btn" id="rebuild-btn"' + (hasToken ? "" : " disabled") + ">Rebuild index</button> " +
      '<span class="form-hint" id="rebuild-status"></span>' +
      "<p style=\"margin-top:1rem\">After app updates that improve ingredient parsing, re-run the parser over every saved recipe so old recipes benefit too. Original text is never touched — only the parsed quantities/units are refreshed.</p>" +
      '<button class="btn" id="reparse-btn"' + (hasToken ? "" : " disabled") + ">Reparse all recipes</button> " +
      '<span class="form-hint" id="reparse-status"></span></div>';

    html += '<div class="settings-block"><h2>About</h2>' +
      "<p>A personal recipe box. The app itself is a public static page; every recipe, note, and photo stays in the private data repo, versioned by git. " +
      "On iPhone/Android, use “Add to Home Screen” to install it like an app.</p>" +
      '<p class="form-hint">App version ' + esc(APP_VERSION) + "</p></div>";

    v.innerHTML = html;

    if (hasToken) {
      GH.validate().then(function (res) {
        var el = $("#token-status");
        if (!el) return;
        if (res.ok) {
          el.textContent = "✓ unlocked — connected to " + res.repo + (res.isPrivate ? " (private)" : " (⚠ repo is PUBLIC)");
          el.className = "token-status ok";
        } else {
          el.textContent = res.reason === "repo-not-found"
            ? "✗ token works but repo " + GH.OWNER + "/" + GH.REPO + " wasn't found — create it on GitHub"
            : "✗ stored token was rejected — paste a fresh one";
          el.className = "token-status bad";
        }
      }).catch(function () {
        var el = $("#token-status");
        if (el) el.textContent = navigator.onLine ? "couldn't reach GitHub" : "offline — can't verify key right now";
      });
    }

    $("#token-save").addEventListener("click", function () {
      var t = $("#token-input").value.trim();
      if (!t) return;
      GH.setToken(t);
      var el = $("#token-status");
      el.textContent = "checking…";
      el.className = "token-status";
      GH.validate().then(function (res) {
        if (res.ok) {
          hideBanner();
          loadIndex._fetched = false;
          state.index = null;
          state.indexLoaded = false;
          toast("Unlocked — loading your recipes");
          renderSettings();
          loadIndex(true);
        } else {
          GH.setToken(null);
          el.textContent = res.reason === "repo-not-found"
            ? "✗ token accepted but repo not found — create " + GH.OWNER + "/" + GH.REPO + " first"
            : "✗ that token was rejected by GitHub";
          el.className = "token-status bad";
        }
      }).catch(function () {
        el.textContent = "couldn't reach GitHub — are you online?";
        el.className = "token-status bad";
      });
    });

    var clearBtn = $("#token-clear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      if (!confirm("Forget the key on this device? Cached recipes will also be cleared.")) return;
      GH.setToken(null);
      try {
        Object.keys(localStorage).forEach(function (k) {
          if (k.indexOf("rb_") === 0) localStorage.removeItem(k);
        });
      } catch (e) { }
      state.index = null;
      state.indexLoaded = false;
      loadIndex._fetched = false;
      toast("Key forgotten");
      renderSettings();
    });

    $("#reparse-btn").addEventListener("click", function () {
      if (!requireOnlineAndToken()) return;
      var st = $("#reparse-status");
      $("#reparse-btn").disabled = true;
      GH.reparseRecipes(reparseRecipeData, function (i, n, changed) {
        st.textContent = "checking " + i + " / " + n + (changed ? " (" + changed + " updated)" : "") + "…";
      }).then(function (res) {
        res.updated.forEach(cacheRecipe);
        if (state.current && res.updated.some(function (r) { return r.id === state.current.id; })) state.current = null;
        st.textContent = "done — " + res.updated.length + " of " + res.checked + " recipes updated";
        $("#reparse-btn").disabled = false;
      }).catch(function (err) {
        st.textContent = "reparse failed";
        $("#reparse-btn").disabled = false;
        handleApiError(err, "Reparse failed");
      });
    });

    $("#rebuild-btn").addEventListener("click", function () {
      if (!requireOnlineAndToken()) return;
      var st = $("#rebuild-status");
      $("#rebuild-btn").disabled = true;
      GH.rebuildIndex(function (i, n) { st.textContent = "reading " + i + " / " + n + "…"; })
        .then(function (idx) {
          st.textContent = "done — " + idx.recipes.length + " recipes indexed";
          state.index = idx;
          cacheIndex(idx);
          $("#rebuild-btn").disabled = false;
        }).catch(function (err) {
          st.textContent = "rebuild failed";
          $("#rebuild-btn").disabled = false;
          handleApiError(err, "Rebuild failed");
        });
    });
  }

  // ---------- misc ----------

  // Re-run the current parser over a recipe's ingredient raw strings.
  // Returns the updated recipe, or null when parsing is already up to date.
  function reparseRecipeData(recipe) {
    var changed = false;
    var newIngs = (recipe.ingredients || []).map(function (ing) {
      var p = Ing.parseIngredient(ing && ing.raw !== undefined ? ing.raw : String(ing));
      if (JSON.stringify(p) !== JSON.stringify(ing)) changed = true;
      return p;
    });
    if (!changed) return null;
    var copy = JSON.parse(JSON.stringify(recipe));
    copy.ingredients = newIngs;
    // deliberately not bumping updatedAt: this is a technical refresh, and
    // leaving it alone keeps the index entries valid without rewriting them
    return copy;
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      var args = arguments, self = this;
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // ---------- boot ----------

  function boot() {
    initTheme();
    window.addEventListener("hashchange", onRoute);
    if (!location.hash) location.hash = "#/";
    onRoute();
    loadIndex();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(function () { });
    }
  }

  boot();
})();
