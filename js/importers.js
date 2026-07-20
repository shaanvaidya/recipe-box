/* Recipe importers: URL fetch via proxy chain, JSON-LD / microdata
   extraction, and paste-text heuristics. All paths produce a "draft":
   { title, sourceUrl, servings, prepMinutes, cookMinutes,
     ingredients: [raw strings], steps: [strings],
     category, tags: [], imageUrl, confidence: "structured"|"heuristic" } */
(function () {
  "use strict";

  var Ingredients = (typeof window !== "undefined" && window.RecipeBox && window.RecipeBox.Ingredients)
    ? window.RecipeBox.Ingredients
    : (typeof require !== "undefined" ? require("./ingredients.js") : null);

  // Ordered fetch chain. A personal CORS proxy (e.g. Cloudflare Worker) can be
  // prepended here later: { name: "worker", kind: "html", build: function(u){...} }
  var PROXIES = [
    // direct first: a few sites allow CORS, and it fails fast when not
    { name: "direct", kind: "html", timeout: 6000, build: function (u) { return u; } },
    // fast and currently keyless (2026-07); may rate-limit under heavy use
    { name: "cors.sh", kind: "html", timeout: 10000, build: function (u) { return "https://proxy.cors.sh/" + u; } },
    // allorigins: slow and hangs some days, but a solid second opinion
    { name: "allorigins", kind: "html", timeout: 20000, build: function (u) { return "https://api.allorigins.win/raw?url=" + encodeURIComponent(u); } },
    { name: "codetabs", kind: "html", timeout: 15000, build: function (u) { return "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u); } }
    // corsproxy.io and r.jina.ai now require API keys; a personal Cloudflare
    // Worker can still be prepended here later.
  ];

  // ----- generic helpers -----

  function stripTags(s) {
    s = String(s).replace(/<[^>]*>/g, " ");
    if (typeof document !== "undefined") {
      var ta = document.createElement("textarea");
      ta.innerHTML = s;
      s = ta.value;
    } else {
      s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
    }
    return s.replace(/\s+/g, " ").trim();
  }

  function asArray(v) {
    if (v === null || v === undefined) return [];
    return Array.isArray(v) ? v : [v];
  }

  function firstString(v) {
    var arr = asArray(v);
    for (var i = 0; i < arr.length; i++) {
      if (typeof arr[i] === "string" && arr[i].trim()) return arr[i].trim();
    }
    return null;
  }

  // ----- JSON-LD -----

  function typeContainsRecipe(t) {
    var types = asArray(t);
    for (var i = 0; i < types.length; i++) {
      if (typeof types[i] === "string" && /(^|\/)Recipe$/i.test(types[i].trim())) return true;
    }
    return false;
  }

  // Recursively collect nodes with @type Recipe from any JSON-LD shape
  // (top-level object, array, @graph, nested mainEntity, etc.)
  function findRecipeNodes(obj, found, depth) {
    found = found || [];
    depth = depth || 0;
    if (!obj || typeof obj !== "object" || depth > 6) return found;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) findRecipeNodes(obj[i], found, depth + 1);
      return found;
    }
    if (typeContainsRecipe(obj["@type"])) found.push(obj);
    var keys = ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "hasPart"];
    for (var k = 0; k < keys.length; k++) {
      if (obj[keys[k]]) findRecipeNodes(obj[keys[k]], found, depth + 1);
    }
    return found;
  }

  function flattenInstructions(ins, out) {
    out = out || [];
    var arr = asArray(ins);
    for (var i = 0; i < arr.length; i++) {
      var step = arr[i];
      if (typeof step === "string") {
        // A single blob string: split on newlines or numbered markers.
        var parts = step.split(/\r?\n+|(?=\b\d+[\.\)]\s)/).map(stripTags).filter(Boolean);
        if (parts.length > 1) parts.forEach(function (p) { out.push(p); });
        else if (stripTags(step)) out.push(stripTags(step));
      } else if (step && typeof step === "object") {
        if (step.itemListElement) {
          // HowToSection: prefix with its name if useful, then flatten.
          flattenInstructions(step.itemListElement, out);
        } else {
          var text = step.text || step.name || "";
          if (stripTags(text)) out.push(stripTags(text));
        }
      }
    }
    return out;
  }

  function extractImageUrl(image) {
    var arr = asArray(image);
    for (var i = 0; i < arr.length; i++) {
      var im = arr[i];
      if (typeof im === "string" && im.trim()) return im.trim();
      if (im && typeof im === "object") {
        var u = firstString(im.url) || firstString(im.contentUrl);
        if (u) return u;
      }
    }
    return null;
  }

  // author: string | {name} | array of either -> display name or null
  function extractAuthor(a) {
    var arr = asArray(a);
    for (var i = 0; i < arr.length; i++) {
      if (typeof arr[i] === "string" && arr[i].trim()) return stripTags(arr[i]);
      if (arr[i] && typeof arr[i] === "object" && typeof arr[i].name === "string" && arr[i].name.trim()) {
        return stripTags(arr[i].name);
      }
    }
    return null;
  }

  function extractTags(node) {
    var tags = [];
    var kw = node.keywords;
    if (typeof kw === "string") tags = kw.split(",");
    else if (Array.isArray(kw)) tags = kw.filter(function (t) { return typeof t === "string"; });
    var cuisine = asArray(node.recipeCuisine).filter(function (t) { return typeof t === "string"; });
    tags = tags.concat(cuisine);
    var seen = {};
    var out = [];
    tags.forEach(function (t) {
      t = stripTags(t).toLowerCase().trim();
      if (!t || t.length > 28 || t.split(/\s+/).length > 3) return;
      if (seen[t]) return;
      seen[t] = true;
      out.push(t);
    });
    return out.slice(0, 8);
  }

  function mapJsonLdRecipe(node, sourceUrl) {
    var ingredients = asArray(node.recipeIngredient !== undefined ? node.recipeIngredient : node.ingredients)
      .filter(function (x) { return typeof x === "string"; })
      .map(stripTags)
      .filter(Boolean);
    var steps = flattenInstructions(node.recipeInstructions);
    if (!ingredients.length && !steps.length) return null;
    return {
      title: stripTags(firstString(node.name) || "") || null,
      sourceUrl: sourceUrl || null,
      credit: extractAuthor(node.author),
      servings: Ingredients ? Ingredients.parseServings(node.recipeYield) : null,
      prepMinutes: Ingredients ? Ingredients.isoDurationToMinutes(firstString(node.prepTime)) : null,
      cookMinutes: Ingredients ? Ingredients.isoDurationToMinutes(firstString(node.cookTime) || firstString(node.totalTime)) : null,
      ingredients: ingredients,
      steps: steps,
      category: stripTags(firstString(node.recipeCategory) || "").toLowerCase() || null,
      tags: extractTags(node),
      imageUrl: extractImageUrl(node.image),
      confidence: "structured"
    };
  }

  // scriptTexts: array of raw <script type="application/ld+json"> contents.
  function extractFromJsonLdStrings(scriptTexts, sourceUrl) {
    for (var i = 0; i < scriptTexts.length; i++) {
      var data;
      try {
        data = JSON.parse(scriptTexts[i]);
      } catch (e) {
        // tolerate trailing junk / HTML comments around the JSON
        try {
          var cleaned = scriptTexts[i].replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
          data = JSON.parse(cleaned);
        } catch (e2) { continue; }
      }
      var nodes = findRecipeNodes(data);
      for (var n = 0; n < nodes.length; n++) {
        var draft = mapJsonLdRecipe(nodes[n], sourceUrl);
        if (draft) return draft;
      }
    }
    return null;
  }

  // ----- microdata fallback (browser only) -----

  // Paragraph-ish chunks (direct text nodes, <p>, <li>) inside a directions
  // container -> one step each.
  function collectStepBlocks(el, out) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) {
        var t = stripTags(n.textContent);
        if (t) out.push(t);
      } else if (n.nodeType === 1) {
        if (/^(p|li)$/i.test(n.tagName)) {
          var t2 = stripTags(n.textContent);
          if (t2) out.push(t2);
        } else {
          collectStepBlocks(n, out);
        }
      }
    }
  }

  function extractMicrodata(doc, sourceUrl) {
    var scope = doc.querySelector('[itemtype*="schema.org/Recipe"], [itemtype*="schema.org/recipe"]');
    if (!scope) return null;
    function propText(name) {
      var els = scope.querySelectorAll('[itemprop="' + name + '"]');
      var out = [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var v = el.getAttribute("content") || el.getAttribute("datetime") || el.textContent || "";
        v = stripTags(v);
        if (v) out.push(v);
      }
      return out;
    }
    var ingredients = propText("recipeIngredient");
    if (!ingredients.length) ingredients = propText("ingredients");
    var steps = propText("recipeInstructions");
    if (!steps.length) {
      // Some plugins (e.g. Jetpack on smittenkitchen) mark the directions
      // block by class only, with steps as loose text nodes and <p>s.
      var dir = scope.querySelector('[class*="directions"], [class*="instructions"]') ||
        doc.querySelector('[class*="recipe-directions"], [class*="recipe-instructions"]');
      if (dir) collectStepBlocks(dir, steps);
    }
    if (steps.length === 1) {
      var split = steps[0].split(/(?=\b\d+[\.\)]\s)/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (split.length > 1) steps = split;
    }
    if (!ingredients.length && !steps.length) return null;
    var img = scope.querySelector('[itemprop="image"]');
    return {
      title: propText("name")[0] || null,
      sourceUrl: sourceUrl || null,
      servings: Ingredients ? Ingredients.parseServings(propText("recipeYield")[0]) : null,
      prepMinutes: Ingredients ? Ingredients.isoDurationToMinutes(propText("prepTime")[0]) : null,
      cookMinutes: Ingredients ? Ingredients.isoDurationToMinutes(propText("cookTime")[0] || propText("totalTime")[0]) : null,
      ingredients: ingredients,
      steps: steps,
      category: (propText("recipeCategory")[0] || "").toLowerCase() || null,
      tags: [],
      imageUrl: img ? (img.getAttribute("content") || img.getAttribute("src")) : null,
      confidence: "structured"
    };
  }

  // Browser entry: full HTML string -> draft or null.
  function extractFromHtml(html, sourceUrl) {
    if (typeof DOMParser === "undefined") return null;
    var doc = new DOMParser().parseFromString(html, "text/html");
    var scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    var texts = [];
    for (var i = 0; i < scripts.length; i++) texts.push(scripts[i].textContent || "");
    var draft = extractFromJsonLdStrings(texts, sourceUrl);
    if (draft) return draft;
    draft = extractMicrodata(doc, sourceUrl);
    if (draft) return draft;
    return null;
  }

  // ----- paste-text heuristics -----

  var HEADER_RE = /^\s*(?:for\s+the\s+)?(ingredients?|directions?|instructions?|method|steps?|preparation)\s*:?\s*$/i;
  var STEP_HEADER_RE = /^(directions?|instructions?|method|steps?|preparation)$/i;

  function looksLikeIngredient(line) {
    if (line.length > 90) return false;
    if (/^[-*•·]\s/.test(line)) return true;
    if (/^\d+[\.\)]\s/.test(line)) return false;      // "1. Preheat..." is a step
    if (/^[\d¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/.test(line)) return true;
    if (/^(a|an|one|two|three|half|salt|pepper|pinch|handful|juice|zest)\b/i.test(line) && line.length < 60 && !/[.!?]$/.test(line)) return true;
    return false;
  }

  function looksLikeStep(line) {
    if (/^\d+[\.\)]\s/.test(line)) return true;
    if (/^step\s*\d+/i.test(line)) return true;
    if (line.length > 90) return true;
    if (/[.!?]$/.test(line) && line.length > 40) return true;
    return false;
  }

  function cleanStep(line) {
    return line.replace(/^\d+[\.\)]\s*/, "").replace(/^step\s*\d+\s*[:.\-]?\s*/i, "").trim();
  }

  function cleanIngredient(line) {
    return line.replace(/^[-*•·]\s*/, "").trim();
  }

  function parseTextRecipe(text) {
    var rawLines = String(text).split(/\r?\n/).map(function (l) { return l.trim(); });
    // r.jina.ai preamble: "Title: X" / "URL Source: Y" / "Markdown Content:"
    var jinaTitle = null;
    if (rawLines.length && /^Title:\s*/i.test(rawLines[0])) {
      jinaTitle = rawLines[0].replace(/^Title:\s*/i, "").trim();
      rawLines = rawLines.filter(function (l) {
        return !/^(Title|URL Source|Markdown Content|Published Time):/i.test(l);
      });
    }
    var lines = [];
    rawLines.forEach(function (l) {
      l = l.replace(/^#+\s*/, "").replace(/^\*\*(.*)\*\*$/, "$1").trim();
      lines.push(l);
    });

    // Pass 1: explicit section headers
    var headerIdx = [];
    lines.forEach(function (l, i) {
      var m = l.match(HEADER_RE);
      if (m) headerIdx.push({ i: i, kind: /^ingredients?$/i.test(m[1]) ? "ing" : "steps" });
    });

    var ingredients = [], steps = [], title = jinaTitle;

    var ingHeader = null, stepHeader = null;
    headerIdx.forEach(function (h) {
      if (h.kind === "ing" && ingHeader === null) ingHeader = h;
      if (h.kind === "steps" && stepHeader === null) stepHeader = h;
    });

    if (ingHeader) {
      var ingEnd = lines.length;
      headerIdx.forEach(function (h) { if (h.i > ingHeader.i && h.i < ingEnd) ingEnd = h.i; });
      for (var i = ingHeader.i + 1; i < ingEnd; i++) {
        if (lines[i]) ingredients.push(cleanIngredient(lines[i]));
      }
      if (!title) {
        for (var t = 0; t < ingHeader.i; t++) {
          if (lines[t] && !HEADER_RE.test(lines[t])) { title = lines[t]; break; }
        }
      }
    }
    if (stepHeader) {
      var stepEnd = lines.length;
      headerIdx.forEach(function (h) { if (h.i > stepHeader.i && h.i < stepEnd) stepEnd = h.i; });
      for (var s = stepHeader.i + 1; s < stepEnd; s++) {
        if (lines[s]) steps.push(cleanStep(lines[s]));
      }
    }

    // Pass 2: no headers — classify with a single best split point.
    if (!ingHeader && !stepHeader) {
      var content = [];
      lines.forEach(function (l, i) { if (l) content.push({ text: l, i: i }); });
      if (content.length) {
        if (!title) title = content[0].text;
        var body = content.slice(title === content[0].text ? 1 : 0);
        // Score each split: lines before k treated as ingredients, after as steps.
        var bestK = 0, bestScore = -Infinity;
        for (var k = 0; k <= body.length; k++) {
          var score = 0;
          for (var a = 0; a < k; a++) score += looksLikeIngredient(body[a].text) ? 1 : -1;
          for (var b = k; b < body.length; b++) score += looksLikeStep(body[b].text) ? 1 : -0.5;
          if (score > bestScore) { bestScore = score; bestK = k; }
        }
        for (var x = 0; x < bestK; x++) ingredients.push(cleanIngredient(body[x].text));
        for (var y = bestK; y < body.length; y++) steps.push(cleanStep(body[y].text));
      }
    }

    return {
      title: title || null,
      sourceUrl: null,
      servings: null,
      prepMinutes: null,
      cookMinutes: null,
      ingredients: ingredients,
      steps: steps,
      category: null,
      tags: [],
      imageUrl: null,
      confidence: "heuristic"
    };
  }

  // ----- URL import (browser only) -----

  function fetchWithTimeout(url, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    return fetch(url, { signal: ctrl.signal, headers: { "Accept": "text/html,*/*" } })
      .finally(function () { clearTimeout(timer); });
  }

  // Resolves {draft, via, warning?}; rejects with Error (.allFailed = true when
  // every proxy failed) so the UI can offer the paste fallback.
  function importFromUrl(url, onStatus) {
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    var fetchedButNoRecipe = false;

    function tryProxy(idx) {
      if (idx >= PROXIES.length) {
        var err = new Error(fetchedButNoRecipe
          ? "Fetched the page but couldn't find recipe data on it."
          : "Couldn't fetch that page.");
        err.allFailed = !fetchedButNoRecipe;
        err.noRecipe = fetchedButNoRecipe;
        return Promise.reject(err);
      }
      var proxy = PROXIES[idx];
      if (onStatus) onStatus(idx === 0 ? "Fetching page…" : "Fetching page (attempt " + (idx + 1) + " — slower route)…");
      return fetchWithTimeout(proxy.build(url), proxy.timeout || 10000)
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.text();
        })
        .then(function (body) {
          if (!body || body.length < 200) throw new Error("Empty response");
          if (proxy.kind === "html") {
            var draft = extractFromHtml(body, url);
            if (draft) return { draft: draft, via: proxy.name };
            fetchedButNoRecipe = true;
            throw new Error("No structured recipe data");
          }
          // text proxy (jina): heuristic parse
          var tDraft = parseTextRecipe(body);
          if (tDraft.ingredients.length >= 2 && tDraft.steps.length >= 1) {
            tDraft.sourceUrl = url;
            return {
              draft: tDraft, via: proxy.name,
              warning: "This page had no structured recipe data, so the recipe was read heuristically — double-check it."
            };
          }
          throw new Error("Could not parse text");
        })
        .catch(function () { return tryProxy(idx + 1); });
    }
    return tryProxy(0);
  }

  var API = {
    PROXIES: PROXIES,
    extractFromJsonLdStrings: extractFromJsonLdStrings,
    extractFromHtml: extractFromHtml,
    parseTextRecipe: parseTextRecipe,
    importFromUrl: importFromUrl,
    stripTags: stripTags
  };

  if (typeof window !== "undefined") {
    window.RecipeBox = window.RecipeBox || {};
    window.RecipeBox.Importers = API;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
