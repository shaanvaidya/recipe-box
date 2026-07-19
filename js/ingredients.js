/* Ingredient parsing, scaling, and unit conversion. Pure functions only. */
(function () {
  "use strict";

  var FRACTION_GLYPHS = {
    "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4,
    "¾": 3 / 4, "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5,
    "⅘": 4 / 5, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8,
    "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8
  };
  var GLYPH_BY_FRACTION = [
    [1 / 2, "½"], [1 / 3, "⅓"], [2 / 3, "⅔"], [1 / 4, "¼"],
    [3 / 4, "¾"], [1 / 8, "⅛"], [3 / 8, "⅜"], [5 / 8, "⅝"],
    [7 / 8, "⅞"], [1 / 6, "⅙"], [5 / 6, "⅚"]
  ];

  // Units: display singular/plural, aliases (lowercase), kind, factor to base
  // (ml for volume, g for weight). Countables have no factor.
  var UNITS = [
    { id: "tsp", one: "tsp", many: "tsp", aliases: ["tsp", "tsps", "tsp.", "teaspoon", "teaspoons", "t"], kind: "volume", ml: 5 },
    { id: "tbsp", one: "tbsp", many: "tbsp", aliases: ["tbsp", "tbsps", "tbsp.", "tbs", "tablespoon", "tablespoons", "T"], kind: "volume", ml: 15 },
    { id: "cup", one: "cup", many: "cups", aliases: ["cup", "cups", "c", "c."], kind: "volume", ml: 240 },
    { id: "floz", one: "fl oz", many: "fl oz", aliases: ["fl oz", "fl. oz", "fl. oz.", "fluid ounce", "fluid ounces", "floz"], kind: "volume", ml: 30 },
    { id: "pint", one: "pint", many: "pints", aliases: ["pint", "pints", "pt"], kind: "volume", ml: 473 },
    { id: "quart", one: "quart", many: "quarts", aliases: ["quart", "quarts", "qt"], kind: "volume", ml: 946 },
    { id: "gallon", one: "gallon", many: "gallons", aliases: ["gallon", "gallons", "gal"], kind: "volume", ml: 3785 },
    { id: "ml", one: "ml", many: "ml", aliases: ["ml", "ml.", "milliliter", "milliliters", "millilitre", "millilitres"], kind: "volume", ml: 1, metric: true },
    { id: "l", one: "liter", many: "liters", aliases: ["l", "liter", "liters", "litre", "litres"], kind: "volume", ml: 1000, metric: true },
    { id: "oz", one: "oz", many: "oz", aliases: ["oz", "oz.", "ounce", "ounces"], kind: "weight", g: 28 },
    { id: "lb", one: "lb", many: "lbs", aliases: ["lb", "lbs", "lb.", "lbs.", "pound", "pounds"], kind: "weight", g: 454 },
    { id: "g", one: "g", many: "g", aliases: ["g", "g.", "gram", "grams", "gr"], kind: "weight", g: 1, metric: true },
    { id: "kg", one: "kg", many: "kg", aliases: ["kg", "kg.", "kilogram", "kilograms", "kilo", "kilos"], kind: "weight", g: 1000, metric: true },
    // Countables: kept as-is, pluralized, never converted.
    { id: "clove", one: "clove", many: "cloves", aliases: ["clove", "cloves"], kind: "count" },
    { id: "can", one: "can", many: "cans", aliases: ["can", "cans"], kind: "count" },
    { id: "stick", one: "stick", many: "sticks", aliases: ["stick", "sticks"], kind: "count" },
    { id: "pinch", one: "pinch", many: "pinches", aliases: ["pinch", "pinches"], kind: "count" },
    { id: "dash", one: "dash", many: "dashes", aliases: ["dash", "dashes"], kind: "count" },
    { id: "bunch", one: "bunch", many: "bunches", aliases: ["bunch", "bunches"], kind: "count" },
    { id: "slice", one: "slice", many: "slices", aliases: ["slice", "slices"], kind: "count" },
    { id: "head", one: "head", many: "heads", aliases: ["head", "heads"], kind: "count" },
    { id: "sprig", one: "sprig", many: "sprigs", aliases: ["sprig", "sprigs"], kind: "count" },
    { id: "stalk", one: "stalk", many: "stalks", aliases: ["stalk", "stalks"], kind: "count" },
    { id: "piece", one: "piece", many: "pieces", aliases: ["piece", "pieces"], kind: "count" },
    { id: "package", one: "package", many: "packages", aliases: ["package", "packages", "pkg", "packet", "packets"], kind: "count" },
    { id: "handful", one: "handful", many: "handfuls", aliases: ["handful", "handfuls"], kind: "count" },
    { id: "knob", one: "knob", many: "knobs", aliases: ["knob", "knobs"], kind: "count" }
  ];

  var ALIAS_MAP = {};
  UNITS.forEach(function (u) {
    u.aliases.forEach(function (a) { ALIAS_MAP[a.toLowerCase()] = u; });
  });
  var UNIT_MAP = {};
  UNITS.forEach(function (u) { UNIT_MAP[u.id] = u; });

  // g per cup, for cups<->grams conversion. Keys matched against item text.
  var DENSITIES = [
    { id: "flour", label: "All-purpose flour", gPerCup: 120, match: ["flour"] },
    { id: "sugar", label: "Granulated sugar", gPerCup: 200, match: ["sugar"] },
    { id: "brown-sugar", label: "Brown sugar (packed)", gPerCup: 220, match: ["brown sugar"] },
    { id: "powdered-sugar", label: "Powdered sugar", gPerCup: 120, match: ["powdered sugar", "confectioners", "icing sugar"] },
    { id: "butter", label: "Butter", gPerCup: 227, match: ["butter"] },
    { id: "cocoa", label: "Cocoa powder", gPerCup: 100, match: ["cocoa"] },
    { id: "honey", label: "Honey / syrup", gPerCup: 340, match: ["honey", "maple syrup", "molasses", "corn syrup"] },
    { id: "oats", label: "Rolled oats", gPerCup: 90, match: ["oats", "oatmeal"] },
    { id: "rice", label: "Rice (uncooked)", gPerCup: 185, match: ["rice"] },
    { id: "milk", label: "Milk / water", gPerCup: 240, match: ["milk", "water", "buttermilk", "cream"], preferVolume: true },
    { id: "oil", label: "Oil", gPerCup: 218, match: ["oil"], preferVolume: true },
    { id: "choc-chips", label: "Chocolate chips", gPerCup: 170, match: ["chocolate chip", "choc chip"] }
  ];

  // More specific matches (longer keywords) win: "brown sugar" before "sugar".
  var DENSITY_MATCHERS = [];
  DENSITIES.forEach(function (d) {
    d.match.forEach(function (kw) { DENSITY_MATCHERS.push({ kw: kw, d: d }); });
  });
  DENSITY_MATCHERS.sort(function (a, b) { return b.kw.length - a.kw.length; });

  function densityFor(item) {
    if (!item) return null;
    var low = item.toLowerCase();
    for (var i = 0; i < DENSITY_MATCHERS.length; i++) {
      if (low.indexOf(DENSITY_MATCHERS[i].kw) !== -1) return DENSITY_MATCHERS[i].d;
    }
    return null;
  }

  // ----- quantity parsing -----

  // Parses a number at the start of s. Returns {value, rest} or null.
  // Handles: 2 | 1.5 | 1/2 | ½ | 1 ½ | 1½ | 1 1/2
  function parseNumber(s) {
    s = s.replace(/^\s+/, "");
    var m, value = null, rest = s;
    // pure ascii fraction first ("3/4 cup"), so the integer match doesn't eat its numerator
    m = rest.match(/^(\d+)\s*\/\s*(\d+)/);
    if (m && parseInt(m[2], 10) !== 0) {
      return { value: parseInt(m[1], 10) / parseInt(m[2], 10), rest: rest.slice(m[0].length) };
    }
    m = rest.match(/^(\d+(?:\.\d+)?)/);
    if (m) {
      value = parseFloat(m[1]);
      rest = rest.slice(m[1].length);
      // mixed: "1 1/2", "1 ½", "1½" — only if the integer had no decimal point
      if (m[1].indexOf(".") === -1) {
        var frac = parseFractionOnly(rest);
        if (frac) { value += frac.value; rest = frac.rest; }
      }
    } else {
      var f = parseFractionOnly(rest);
      if (f) { value = f.value; rest = f.rest; }
    }
    if (value === null) return null;
    return { value: value, rest: rest };
  }

  function parseFractionOnly(s) {
    var t = s.replace(/^[\s-]{0,2}/, "");
    if (t.length && FRACTION_GLYPHS[t[0]] !== undefined) {
      return { value: FRACTION_GLYPHS[t[0]], rest: t.slice(1) };
    }
    var m = t.match(/^(\d+)\s*\/\s*(\d+)/);
    if (m && parseInt(m[2], 10) !== 0) {
      return { value: parseInt(m[1], 10) / parseInt(m[2], 10), rest: t.slice(m[0].length) };
    }
    return null;
  }

  function matchUnit(s) {
    var t = s.replace(/^\s+/, "");
    // try two-word aliases first ("fl oz", "fluid ounces")
    var m = t.match(/^([A-Za-z]+\.?)(\s+[A-Za-z]+\.?)?/);
    if (!m) return null;
    var two = m[2] ? (m[1] + m[2]).replace(/\s+/g, " ").toLowerCase() : null;
    if (two && ALIAS_MAP[two]) return { unit: ALIAS_MAP[two], rest: t.slice(m[0].length) };
    var one = m[1].toLowerCase();
    // "T" (tablespoon) vs "t" (teaspoon) case-sensitive special case
    if (m[1] === "T" && m[1].length === 1) return { unit: ALIAS_MAP["tbsp"], rest: t.slice(1) };
    if (ALIAS_MAP[one] && !(one === "t" && m[1] === "T")) {
      return { unit: ALIAS_MAP[one], rest: t.slice(m[1].length) };
    }
    return null;
  }

  // Parse one raw ingredient line into {raw, qty, qtyHigh, unit, item}.
  function parseIngredient(raw) {
    var out = { raw: raw, qty: null, qtyHigh: null, unit: null, item: null };
    if (!raw || typeof raw !== "string") return out;
    var s = raw.trim().replace(/^[-*•·]\s*/, "");
    var n1 = parseNumber(s);
    if (!n1) { out.item = s; return out; }
    out.qty = round3(n1.value);
    s = n1.rest;
    // range: "2-3", "2 – 3", "2 to 3"
    var rm = s.match(/^\s*(?:-|–|—|to)\s*/);
    if (rm) {
      var n2 = parseNumber(s.slice(rm[0].length));
      if (n2) { out.qtyHigh = round3(n2.value); s = n2.rest; }
    }
    var um = matchUnit(s);
    if (um) {
      out.unit = um.unit.id;
      s = um.rest;
    }
    s = s.replace(/^\s+/, "").replace(/^of\s+/i, "");
    out.item = s || null;
    return out;
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }

  // ----- display formatting -----

  // 1.5 -> "1 ½", 0.333 -> "⅓", 1.7 -> "1.7", 3 -> "3"
  function formatQty(n) {
    if (n === null || n === undefined || isNaN(n)) return "";
    if (n < 0) return String(n);
    var whole = Math.floor(n);
    var frac = n - whole;
    if (frac < 0.02) return String(whole === 0 ? round1(n) : whole);
    if (frac > 0.98) return String(whole + 1);
    for (var i = 0; i < GLYPH_BY_FRACTION.length; i++) {
      if (Math.abs(frac - GLYPH_BY_FRACTION[i][0]) <= 0.02) {
        var glyph = GLYPH_BY_FRACTION[i][1];
        return whole === 0 ? glyph : whole + " " + glyph;
      }
    }
    return String(round1(n));
  }

  function round1(n) {
    var r = Math.round(n * 10) / 10;
    return (r === Math.floor(r)) ? Math.floor(r) : r;
  }

  function roundFriendly(n, step) { return Math.round(n / step) * step; }

  function friendlyMl(ml) {
    if (ml >= 1000) {
      var l = Math.round(ml / 100) / 10;
      return { value: l, unit: "liter" + (l === 1 ? "" : "s") };
    }
    var v = ml < 100 ? roundFriendly(ml, 5) : roundFriendly(ml, 10);
    if (v < 5) v = Math.round(ml); // tiny amounts: keep precision
    return { value: v, unit: "ml" };
  }

  function friendlyG(g) {
    if (g >= 1000) {
      var kg = Math.round(g / 50) / 20;
      return { value: kg, unit: "kg" };
    }
    var v;
    if (g < 10) v = Math.round(g * 10) / 10;
    else if (g < 30) v = Math.round(g);
    else if (g < 100) v = roundFriendly(g, 5);
    else v = roundFriendly(g, 10);
    return { value: v, unit: "g" };
  }

  // Render an ingredient for display. opts: {factor: 1, metric: false}
  function displayIngredient(ing, opts) {
    opts = opts || {};
    var factor = opts.factor || 1;
    var metric = !!opts.metric;
    if (ing.qty === null || ing.qty === undefined) {
      return { qtyText: "", itemText: ing.raw };
    }
    var qty = ing.qty * factor;
    var qtyHigh = (ing.qtyHigh !== null && ing.qtyHigh !== undefined) ? ing.qtyHigh * factor : null;
    var unit = ing.unit ? UNIT_MAP[ing.unit] : null;
    var item = ing.item || "";

    if (metric && unit && !unit.metric && (unit.kind === "volume" || unit.kind === "weight")) {
      var dens = unit.kind === "volume" ? densityFor(item) : null;
      if (dens && dens.preferVolume) dens = null; // liquids read better in ml than grams
      var conv = function (q) {
        if (unit.kind === "weight") return friendlyG(q * unit.g);
        if (dens) return friendlyG((q * unit.ml / 240) * dens.gPerCup);
        return friendlyMl(q * unit.ml);
      };
      var a = conv(qty);
      if (qtyHigh !== null) {
        var b = conv(qtyHigh);
        return { qtyText: a.value + "–" + b.value + " " + b.unit, itemText: item };
      }
      return { qtyText: a.value + " " + a.unit, itemText: item };
    }

    var qtyText = formatQty(qty);
    if (qtyHigh !== null) qtyText += "–" + formatQty(qtyHigh);
    if (unit) {
      var many = (qtyHigh !== null ? qtyHigh : qty) > 1;
      qtyText += " " + (many ? unit.many : unit.one);
    }
    return { qtyText: qtyText, itemText: item };
  }

  // ----- temperatures in step text -----

  function fToC(f) { return roundFriendly((f - 32) * 5 / 9, 5); }
  function cToF(c) { return Math.round(c * 9 / 5 + 32); }

  // "Bake at 350°F for..." -> "Bake at 350°F (175°C) for..."
  function annotateStepText(text) {
    return String(text).replace(/(\d{2,3})\s*(?:°\s*|degrees?\s+)F\b/gi, function (m, f) {
      return m + " (" + fToC(parseFloat(f)) + "°C)";
    });
  }

  // ----- ingredient section headers -----

  // "For the Eggs", "Sauce:", "# Topping" are headers, not ingredients.
  // Detection is done at render time so recipes imported before this existed
  // (headers saved as qty-less ingredients) display correctly without migration.
  function isSectionHeader(ing) {
    var raw = (typeof ing === "string" ? ing : ing && ing.raw) || "";
    raw = raw.trim();
    if (/^#\s*\S/.test(raw)) return true;
    if (typeof ing === "object" && ing && ing.qty !== null && ing.qty !== undefined) return false;
    if (/^[^:]{2,50}:$/.test(raw)) return true;
    if (/^for\s+(the\s+|a\s+|an\s+)?\S[^,.;]{1,40}$/i.test(raw)) return true;
    return false;
  }

  function sectionLabel(raw) {
    return String(raw).trim().replace(/^#\s*/, "").replace(/:$/, "").trim();
  }

  // ----- misc parsing -----

  function parseServings(v) {
    if (Array.isArray(v)) v = v[0];
    if (typeof v === "number" && isFinite(v)) return Math.round(v);
    if (typeof v !== "string") return null;
    var m = v.match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }

  // ISO-8601 duration ("PT1H30M") -> minutes
  function isoDurationToMinutes(s) {
    if (typeof s !== "string") return null;
    var m = s.match(/^-?P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?/i);
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    return Math.round((parseFloat(m[1] || 0) * 1440) + (parseFloat(m[2] || 0) * 60) + parseFloat(m[3] || 0));
  }

  // ----- converter support -----

  function convertAmount(value, fromId, toId) {
    var from = UNIT_MAP[fromId], to = UNIT_MAP[toId];
    if (!from || !to || from.kind !== to.kind) return null;
    if (from.kind === "volume") return value * from.ml / to.ml;
    if (from.kind === "weight") return value * from.g / to.g;
    return null;
  }

  function volumeToGrams(value, unitId, densityId) {
    var u = UNIT_MAP[unitId];
    var d = null;
    for (var i = 0; i < DENSITIES.length; i++) if (DENSITIES[i].id === densityId) d = DENSITIES[i];
    if (!u || !d || u.kind !== "volume") return null;
    return value * u.ml / 240 * d.gPerCup;
  }

  function gramsToVolume(grams, unitId, densityId) {
    var u = UNIT_MAP[unitId];
    var d = null;
    for (var i = 0; i < DENSITIES.length; i++) if (DENSITIES[i].id === densityId) d = DENSITIES[i];
    if (!u || !d || u.kind !== "volume") return null;
    return grams / d.gPerCup * 240 / u.ml;
  }

  var API = {
    UNITS: UNITS,
    UNIT_MAP: UNIT_MAP,
    DENSITIES: DENSITIES,
    parseIngredient: parseIngredient,
    isSectionHeader: isSectionHeader,
    sectionLabel: sectionLabel,
    formatQty: formatQty,
    displayIngredient: displayIngredient,
    densityFor: densityFor,
    fToC: fToC,
    cToF: cToF,
    annotateStepText: annotateStepText,
    parseServings: parseServings,
    isoDurationToMinutes: isoDurationToMinutes,
    convertAmount: convertAmount,
    volumeToGrams: volumeToGrams,
    gramsToVolume: gramsToVolume
  };

  if (typeof window !== "undefined") {
    window.RecipeBox = window.RecipeBox || {};
    window.RecipeBox.Ingredients = API;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
