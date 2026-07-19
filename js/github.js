/* GitHub contents-API client for the private data repo.
   Handles auth, UTF-8-safe base64, sha bookkeeping, and conflict retries. */
(function () {
  "use strict";

  var OWNER = "shaanvaidya";
  var REPO = "recipe-box-data";
  var API_BASE = "https://api.github.com";
  var TOKEN_KEY = "rb_gh_token";
  var SHA_KEY = "rb_shas";

  var shaCache = {};
  try { shaCache = JSON.parse(localStorage.getItem(SHA_KEY) || "{}"); } catch (e) { shaCache = {}; }

  function persistShas() {
    try { localStorage.setItem(SHA_KEY, JSON.stringify(shaCache)); } catch (e) { /* storage full — fine */ }
  }

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch (e) { return null; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t.trim());
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* ignore */ }
  }
  function hasToken() { return !!getToken(); }

  // ----- base64 (UTF-8 safe) -----

  function bytesToB64(bytes) {
    var bin = "";
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function encodeContent(str) {
    return bytesToB64(new TextEncoder().encode(str));
  }
  function decodeContent(b64) {
    var bin = atob(String(b64).replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ----- core request -----

  function request(method, path, body, extraHeaders) {
    var token = getToken();
    if (!token) {
      var e = new Error("No access token");
      e.status = 0;
      e.noToken = true;
      return Promise.reject(e);
    }
    var headers = {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (extraHeaders) for (var k in extraHeaders) headers[k] = extraHeaders[k];
    var opts = { method: method, headers: headers, cache: "no-store" };
    if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
    return fetch(API_BASE + path, opts).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        var err = new Error("GitHub auth failed (" + res.status + ")");
        err.status = res.status;
        err.authError = res.status === 401;
        throw err;
      }
      if (!res.ok) {
        var err2 = new Error("GitHub API error " + res.status);
        err2.status = res.status;
        throw err2;
      }
      if (res.status === 204) return null;
      var raw = extraHeaders && /raw/.test(extraHeaders["Accept"] || "");
      return raw ? res.blob() : res.json();
    });
  }

  function contentsPath(path) {
    return "/repos/" + OWNER + "/" + REPO + "/contents/" + path;
  }

  // ----- file operations -----

  // -> { text, sha } ; err.status 404 when missing
  function getFile(path) {
    return request("GET", contentsPath(path)).then(function (data) {
      shaCache[path] = data.sha;
      persistShas();
      return { text: decodeContent(data.content), sha: data.sha };
    });
  }

  function getFileBlob(path) {
    return request("GET", contentsPath(path), null, { "Accept": "application/vnd.github.raw+json" });
  }

  // contentB64: already base64-encoded content.
  function putFileB64(path, contentB64, message) {
    function attempt(sha, retriesLeft) {
      var body = { message: message, content: contentB64 };
      if (sha) body.sha = sha;
      return request("PUT", contentsPath(path), body).then(function (data) {
        shaCache[path] = data.content.sha;
        persistShas();
        return data;
      }).catch(function (err) {
        if ((err.status === 409 || err.status === 422) && retriesLeft > 0) {
          // stale or missing sha: refetch and retry
          return request("GET", contentsPath(path)).then(function (cur) {
            return attempt(cur.sha, retriesLeft - 1);
          }, function (getErr) {
            if (getErr.status === 404) return attempt(undefined, 0); // vanished: create
            throw err;
          });
        }
        throw err;
      });
    }
    return attempt(shaCache[path], 2);
  }

  function putFileText(path, text, message) {
    return putFileB64(path, encodeContent(text), message);
  }

  function deleteFile(path, message) {
    function attempt(sha, retriesLeft) {
      return request("DELETE", contentsPath(path), { message: message, sha: sha })
        .then(function () {
          delete shaCache[path];
          persistShas();
        })
        .catch(function (err) {
          if ((err.status === 409 || err.status === 422) && retriesLeft > 0) {
            return request("GET", contentsPath(path)).then(function (cur) {
              return attempt(cur.sha, retriesLeft - 1);
            });
          }
          if (err.status === 404) return; // already gone
          throw err;
        });
    }
    var start = shaCache[path]
      ? Promise.resolve(shaCache[path])
      : request("GET", contentsPath(path)).then(function (d) { return d.sha; });
    return start.then(function (sha) { return attempt(sha, 2); });
  }

  function listDir(path) {
    return request("GET", contentsPath(path)).then(function (items) {
      return Array.isArray(items) ? items : [];
    });
  }

  // ----- recipe-box specific -----

  function emptyIndex() { return { version: 1, recipes: [] }; }

  function loadIndex() {
    return getFile("index.json").then(function (f) {
      try {
        var idx = JSON.parse(f.text);
        if (!idx || !Array.isArray(idx.recipes)) return emptyIndex();
        return idx;
      } catch (e) { return emptyIndex(); }
    }, function (err) {
      if (err.status === 404) return emptyIndex();
      throw err;
    });
  }

  // Read-modify-write on index.json with fresh GET each attempt.
  function updateIndex(mutate, message, retriesLeft) {
    if (retriesLeft === undefined) retriesLeft = 2;
    return getFile("index.json").then(function (f) {
      var idx;
      try { idx = JSON.parse(f.text); } catch (e) { idx = emptyIndex(); }
      if (!idx || !Array.isArray(idx.recipes)) idx = emptyIndex();
      return idx;
    }, function (err) {
      if (err.status === 404) return emptyIndex();
      throw err;
    }).then(function (idx) {
      mutate(idx);
      return putFileB64("index.json", encodeContent(JSON.stringify(idx, null, 2)), message)
        .then(function () { return idx; })
        .catch(function (err) {
          if ((err.status === 409 || err.status === 422) && retriesLeft > 0) {
            return updateIndex(mutate, message, retriesLeft - 1);
          }
          throw err;
        });
    });
  }

  function indexEntry(recipe) {
    return {
      id: recipe.id,
      title: recipe.title,
      category: recipe.category || null,
      tags: recipe.tags || [],
      favorite: !!recipe.favorite,
      hasPhoto: !!recipe.hasPhoto,
      totalMinutes: (recipe.prepMinutes || 0) + (recipe.cookMinutes || 0) || null,
      updatedAt: recipe.updatedAt
    };
  }

  // Saves recipe file first (source of truth), then the index entry.
  // Resolves { recipe, indexOk } — indexOk false means index is stale but data is safe.
  function saveRecipe(recipe) {
    var path = "recipes/" + recipe.id + ".json";
    return putFileText(path, JSON.stringify(recipe, null, 2), "Save recipe: " + recipe.title)
      .then(function () {
        return updateIndex(function (idx) {
          var entry = indexEntry(recipe);
          var found = false;
          for (var i = 0; i < idx.recipes.length; i++) {
            if (idx.recipes[i].id === recipe.id) { idx.recipes[i] = entry; found = true; break; }
          }
          if (!found) idx.recipes.push(entry);
        }, "Update index: " + recipe.title)
          .then(function () { return { recipe: recipe, indexOk: true }; })
          .catch(function () { return { recipe: recipe, indexOk: false }; });
      });
  }

  function loadRecipe(id) {
    return getFile("recipes/" + id + ".json").then(function (f) {
      return JSON.parse(f.text);
    });
  }

  function deleteRecipe(id, hasPhoto) {
    return deleteFile("recipes/" + id + ".json", "Delete recipe: " + id)
      .then(function () {
        var photoStep = hasPhoto
          ? deleteFile("photos/" + id + ".jpg", "Delete photo: " + id).catch(function () { })
          : Promise.resolve();
        return photoStep;
      })
      .then(function () {
        return updateIndex(function (idx) {
          idx.recipes = idx.recipes.filter(function (r) { return r.id !== id; });
        }, "Remove from index: " + id).catch(function () { });
      });
  }

  // Regenerate index.json from the recipes/ directory.
  function rebuildIndex(onProgress) {
    return listDir("recipes").then(function (items) {
      var files = items.filter(function (it) { return it.type === "file" && /\.json$/.test(it.name); });
      var recipes = [];
      var chain = Promise.resolve();
      files.forEach(function (f, i) {
        chain = chain.then(function () {
          if (onProgress) onProgress(i + 1, files.length);
          return getFile("recipes/" + f.name).then(function (file) {
            try { recipes.push(indexEntry(JSON.parse(file.text))); } catch (e) { /* skip corrupt */ }
          });
        });
      });
      return chain.then(function () {
        recipes.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
        return updateIndex(function (idx) {
          idx.version = 1;
          idx.recipes = recipes;
        }, "Rebuild index (" + recipes.length + " recipes)");
      });
    });
  }

  function putPhoto(id, base64Jpeg) {
    return putFileB64("photos/" + id + ".jpg", base64Jpeg, "Photo: " + id);
  }

  function getPhotoObjectUrl(id) {
    return getFileBlob("photos/" + id + ".jpg").then(function (blob) {
      return URL.createObjectURL(blob);
    });
  }

  // Token validation: also distinguishes "repo missing" from "bad token".
  function validate() {
    return request("GET", "/repos/" + OWNER + "/" + REPO).then(function (repo) {
      return { ok: true, repo: repo.full_name, isPrivate: !!repo.private };
    }, function (err) {
      if (err.status === 404) return { ok: false, reason: "repo-not-found" };
      if (err.authError || err.status === 403) return { ok: false, reason: "bad-token" };
      throw err;
    });
  }

  var API = {
    OWNER: OWNER,
    REPO: REPO,
    getToken: getToken,
    setToken: setToken,
    hasToken: hasToken,
    validate: validate,
    loadIndex: loadIndex,
    loadRecipe: loadRecipe,
    saveRecipe: saveRecipe,
    deleteRecipe: deleteRecipe,
    rebuildIndex: rebuildIndex,
    putPhoto: putPhoto,
    getPhotoObjectUrl: getPhotoObjectUrl,
    encodeContent: encodeContent,
    decodeContent: decodeContent
  };

  window.RecipeBox = window.RecipeBox || {};
  window.RecipeBox.GitHub = API;
})();
