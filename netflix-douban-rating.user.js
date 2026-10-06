// ==UserScript==
// @name         Netflix 豆瓣评分
// @name:en      Netflix Douban Rating
// @namespace    https://github.com/JulianHunag/netflix-douban-rating
// @version      0.2.3
// @description  在 Netflix 首页卡片上直接显示豆瓣评分：按 Netflix 编号经 Wikidata 精确对应豆瓣 / IMDb，查不到再按片名推断；剧集显示 Netflix 上最新一季的分数；同时显示 IMDb 评分
// @description:en Show Douban ratings on Netflix browse cards. Matches by Netflix ID via Wikidata (Douban / IMDb ID), falls back to title search; shows the IMDb rating next to it.
// @author       JulianHunag
// @license      MIT
// @homepageURL  https://github.com/JulianHunag/netflix-douban-rating
// @updateURL    https://raw.githubusercontent.com/JulianHunag/netflix-douban-rating/main/netflix-douban-rating.user.js
// @downloadURL  https://raw.githubusercontent.com/JulianHunag/netflix-douban-rating/main/netflix-douban-rating.user.js
// @match        https://www.netflix.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @grant        GM_addElement
// @grant        GM_registerMenuCommand
// @connect      douban.com
// @connect      query.wikidata.org
// @connect      datasets.imdbws.com
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Core: Douban / Wikidata lookup and matching. No DOM access, so the
   * same code runs under Node for tests (see the module.exports check below).
   * ------------------------------------------------------------------ */
  const Core = (() => {
    const CACHE_VERSION = 1;
    const DAY = 864e5;
    const TTL = { ok: 7 * DAY, none: 2 * DAY, wikidata: 30 * DAY, short: 3600e3 };
    // Douban flags an IP after too many anonymous requests, so stay well below that.
    const REQUEST_GAP_MS = 2500;
    const HOURLY_LIMIT = 120;
    const HOUR = 3600e3;
    const BLOCK_MS = 15 * 60e3;       // first pause after Douban blocks us; doubles on each repeat
    const MAX_BLOCK_MS = 4 * HOUR;

    const CN_DIGIT = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    function cnToInt(s) {
      if (/^\d+$/.test(s)) return +s;
      if (s.length === 1 && CN_DIGIT[s]) return CN_DIGIT[s];
      const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
      return m ? (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0) : null;
    }

    // Douban season suffixes: "第三季", "第2部", "Season 4", "最终季".
    const SEASON_RE = /\s*(?:第\s*([0-9一二三四五六七八九十两]+)\s*[季部]|(?:season|series)\s*(\d+)|最终季|最終季|完结篇|final season)\s*$/i;

    function seasonNo(title) {
      const m = String(title || '').match(SEASON_RE);
      if (!m) return null;
      if (m[1]) return cnToInt(m[1]);
      if (m[2]) return +m[2];
      return null;
    }

    function baseTitle(title) {
      return String(title || '').replace(SEASON_RE, '').replace(SEASON_RE, '').trim();
    }

    function norm(s) {
      return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    }

    function decodeEntities(s) {
      return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e) => {
        const k = e.toLowerCase();
        if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k];
      });
    }

    // www.douban.com/search?cat=1002 result list -> [{sid, kind, title, rating, votes, orig, year, note}]
    function parseSearch(html) {
      const out = [];
      for (const block of String(html).split('<div class="result">').slice(1)) {
        const sid = (block.match(/sid:\s*(\d+)/) || [])[1];
        if (!sid) continue;
        const h3 = (block.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1] || '';
        const kind = (h3.match(/<span>\[([^\]]+)\]<\/span>/) || [])[1] || '';
        const title = decodeEntities(((h3.match(/<a [^>]*>([\s\S]*?)<\/a>/) || [])[1] || '').replace(/<[^>]+>/g, ''))
          .replace(/\s+/g, ' ').trim();
        const rateText = (block.match(/class="rating_nums">([^<]*)</) || [])[1];
        const rating = rateText && !isNaN(parseFloat(rateText)) ? parseFloat(rateText) : null;
        const votes = +((block.match(/\((\d+)人评价\)/) || [])[1] || 0);
        const cast = decodeEntities((block.match(/class="subject-cast">([^<]*)</) || [])[1] || '').trim();
        const orig = ((cast.match(/^原名:([^/]*)/) || [])[1] || '').trim();
        const year = +((cast.match(/(\d{4})\s*$/) || [])[1] || 0) || null;
        const note = rating == null ? (block.match(/\((尚未上映|暂无评分|评价人数不足)\)/) || [])[1] || null : null;
        out.push({ sid, kind, title, rating, votes, orig, year, note });
      }
      return out;
    }

    // movie.douban.com/j/subject_abstract -> same shape as a search result.
    // Its title mixes Chinese and original names ("怪奇物语 第一季 Stranger Things Season 1 (2016)"),
    // so keep the leading Chinese tokens only.
    function parseAbstract(text, sid) {
      let j;
      try { j = JSON.parse(text); } catch (e) { return null; }
      const s = j && j.subject;
      if (!s || !s.id) return null;
      const full = String(s.title || '').replace(/[\u200e\u200f]/g, '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
      const zh = [];
      for (const tok of full.split(/\s+/)) {
        if (/\p{Script=Han}/u.test(tok) && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(tok)) zh.push(tok);
        else break;
      }
      const rating = s.rate ? parseFloat(s.rate) : NaN;
      return {
        sid: String(s.id || sid),
        kind: s.is_tv ? '电视剧' : '电影',
        title: zh.length ? zh.join(' ') : full,
        rating: isNaN(rating) ? null : rating,
        votes: 0,
        orig: '',
        year: +s.release_year || null,
        note: null,
      };
    }

    function isBlocked(res) {
      if (!res) return false;
      if (res.status === 403 || res.status === 418 || res.status === 429) return true;
      if (/sec\.douban\.com|accounts\.douban\.com|\/misc\/sorry/.test(res.url || '')) return true;
      return /检测到有异常请求|异常请求从你的 IP 发出/.test(res.text || '');
    }

    function familyKey(r) {
      return r.kind + '|' + norm(baseTitle(r.title));
    }

    // All seasons of the same show found in the search pool.
    function family(pool, anchor) {
      const key = familyKey(anchor);
      const anchorOrig = norm(baseTitle(anchor.orig));
      const seen = new Set([anchor.sid]);
      const fam = [anchor];
      for (const r of pool) {
        if (seen.has(r.sid) || familyKey(r) !== key) continue;
        const o = norm(baseTitle(r.orig));
        if (anchorOrig && o && anchorOrig !== o) continue;
        seen.add(r.sid);
        fam.push(r);
      }
      return fam;
    }

    function withSeasons(fam) {
      const list = fam.map(r => Object.assign({}, r, { season: seasonNo(r.title) }));
      if (list.length > 1) {
        for (const r of list) if (r.season == null && baseTitle(r.title) === r.title) r.season = 1;
      }
      list.sort((a, b) => (a.year || 9999) - (b.year || 9999) || (a.season || 0) - (b.season || 0));
      return list;
    }

    // Prefer the season Netflix lists as its latest, else the newest rated season.
    function pickDisplay(list, nf) {
      if (nf && nf.seasons) {
        const hit = list.find(r => r.season === nf.seasons && r.rating != null);
        if (hit) return hit;
      }
      for (let i = list.length - 1; i >= 0; i--) if (list[i].rating != null) return list[i];
      return list[list.length - 1];
    }

    // Title fallback when no ID mapping exists. Returns {item, conf} or null.
    function matchByTitle(pool, nf) {
      const nt = norm(nf.title);
      if (!nt) return null;
      const wantKind = nf.type === 'Movie' ? '电影' : nf.type === 'Show' ? '电视剧' : '';
      const groups = new Map();
      for (const r of pool) {
        const k = r.kind === '电视剧' ? familyKey(r) + '|' + norm(baseTitle(r.orig)) : 'sid|' + r.sid;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      const scored = [];
      for (const g of groups.values()) {
        const r0 = g[0];
        const t = norm(baseTitle(r0.title));
        const o = norm(baseTitle(r0.orig));
        let s;
        if (t === nt || (o && o === nt)) s = 10;
        else if (Math.min(t.length, nt.length) >= 2 && (t.includes(nt) || nt.includes(t))) s = 3;
        else continue;
        if (wantKind) s += r0.kind === wantKind ? 4 : -6;
        const years = g.map(r => r.year).filter(Boolean);
        if (nf.year && years.length) {
          const lo = Math.min(...years);
          const hi = Math.max(...years);
          if (r0.kind === '电视剧') s += nf.year >= lo - 1 && nf.year <= hi + 1 ? 4 : nf.year > hi ? 0 : -5;
          else s += Math.abs(lo - nf.year) <= 1 ? 4 : Math.abs(lo - nf.year) <= 2 ? 1 : -5;
        }
        scored.push({ g, s, votes: Math.max(0, ...g.map(r => r.votes || 0)) });
      }
      scored.sort((a, b) => b.s - a.s || b.votes - a.votes);
      const best = scored[0];
      if (!best || best.s < 10) return null;
      const tied = scored[1] && scored[1].s === best.s;
      return { item: best.g[0], conf: best.s >= 18 && !tied ? 'high' : 'low' };
    }

    // IMDb title.ratings.tsv -> columns sorted by numeric tconst, for binary search.
    function parseImdbRatings(tsv, minVotes) {
      const ids = [];
      const ratings = [];
      const votes = [];
      let pos = tsv.indexOf('\n') + 1; // skip header
      while (pos > 0 && pos < tsv.length) {
        let end = tsv.indexOf('\n', pos);
        if (end < 0) end = tsv.length;
        const t1 = tsv.indexOf('\t', pos);
        const t2 = tsv.indexOf('\t', t1 + 1);
        if (t1 > pos && t2 > t1 && t2 < end) {
          const v = +tsv.slice(t2 + 1, end);
          if (v >= minVotes) {
            ids.push(+tsv.slice(pos + 2, t1));
            ratings.push(Math.round(+tsv.slice(t1 + 1, t2) * 10));
            votes.push(v);
          }
        }
        pos = end + 1;
      }
      // String order of tconst is not numeric order once ids reach 8 digits.
      const order = Uint32Array.from(ids.keys()).sort((a, b) => ids[a] - ids[b]);
      const n = order.length;
      const table = { ids: new Uint32Array(n), ratings: new Uint8Array(n), votes: new Uint32Array(n) };
      for (let i = 0; i < n; i++) {
        const j = order[i];
        table.ids[i] = ids[j];
        table.ratings[i] = ratings[j];
        table.votes[i] = votes[j];
      }
      return table;
    }

    function lookupImdb(table, tt) {
      const id = +String(tt).replace(/^tt/, '');
      let lo = 0;
      let hi = table.ids.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = table.ids[mid];
        if (v === id) return { tt: String(tt), rating: table.ratings[mid] / 10, votes: table.votes[mid] };
        if (v < id) lo = mid + 1;
        else hi = mid - 1;
      }
      return null;
    }

    function slim(r) {
      return {
        sid: r.sid, title: r.title, rating: r.rating, votes: r.votes || 0,
        year: r.year || null, season: r.season == null ? null : r.season, note: r.note || null,
      };
    }

    /**
     * env.http(url, headers) -> Promise<{status, url, text}>
     * env.store: {get(key), set(key, value)}
     */
    function createResolver(env) {
      const http = env.http;
      const store = env.store;
      const log = env.log || (() => {});
      const now = env.now || (() => Date.now());
      const gapMs = env.gapMs == null ? REQUEST_GAP_MS : env.gapMs;
      const hourlyLimit = env.hourlyLimit == null ? HOURLY_LIMIT : env.hourlyLimit;
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      // ---- Douban request queue: one request at a time, visible cards first ----
      // Pause state lives in the store so every Netflix tab honours it.
      const queue = [];
      let pumping = false;
      let lastAt = 0;

      const blockedUntil = () => +store.get('blockedUntil') || 0;

      function recentRequests() {
        const t = now();
        return (store.get('reqLog') || []).filter(x => t - x < HOUR);
      }

      // When the self-imposed hourly limit frees a slot again (0 if not at the limit).
      function quotaUntil() {
        const reqs = recentRequests();
        return reqs.length >= hourlyLimit ? reqs[reqs.length - hourlyLimit] + HOUR : 0;
      }

      function pausedUntil() {
        return Math.max(blockedUntil(), quotaUntil());
      }

      function pauseError() {
        const e = new Error('douban requests paused');
        e.paused = now() < blockedUntil() ? 'blocked' : 'quota';
        return e;
      }

      function douban(url, prio) {
        if (now() < pausedUntil()) return Promise.reject(pauseError());
        return new Promise((resolve, reject) => {
          queue.push({ url, prio: prio || (() => 0), resolve, reject });
          pump();
        });
      }

      async function pump() {
        if (pumping) return;
        pumping = true;
        try {
          while (queue.length) {
            let bi = 0;
            let bp = -Infinity;
            for (let i = 0; i < queue.length; i++) {
              const p = queue[i].prio();
              if (p > bp) { bp = p; bi = i; }
            }
            const task = queue.splice(bi, 1)[0];
            const wait = lastAt + gapMs + Math.random() * gapMs * 0.3 - now();
            if (wait > 0) await sleep(wait);
            // Re-check after the wait: another tab may have paused us meanwhile.
            if (now() < pausedUntil()) { task.reject(pauseError()); continue; }
            lastAt = now();
            store.set('reqLog', recentRequests().concat(lastAt));
            try {
              const res = await http(task.url);
              if (isBlocked(res)) {
                const n = (+store.get('blockCount') || 0) + 1;
                const until = now() + Math.min(BLOCK_MS * 2 ** (n - 1), MAX_BLOCK_MS);
                store.set('blockCount', n);
                store.set('blockedUntil', until);
                log('douban blocked this IP (#' + n + '), paused until', new Date(until).toLocaleTimeString());
                task.reject(pauseError());
              } else if (res.status !== 200) {
                task.reject(new Error('HTTP ' + res.status + ' ' + task.url));
              } else {
                if (store.get('blockCount')) store.set('blockCount', 0);
                task.resolve(res.text);
              }
            } catch (e) {
              task.reject(e);
            }
          }
        } finally {
          pumping = false;
        }
      }

      const memo = new Map();
      function memoized(url, prio, parse) {
        if (!memo.has(url)) {
          memo.set(url, douban(url, prio).then(parse).catch(e => { memo.delete(url); throw e; }));
        }
        return memo.get(url);
      }
      const search = (q, prio) =>
        memoized('https://www.douban.com/search?cat=1002&q=' + encodeURIComponent(q), prio, parseSearch);
      const abstract = (sid, prio) =>
        memoized('https://movie.douban.com/j/subject_abstract?subject_id=' + sid, prio, t => parseAbstract(t, sid));

      // ---- Wikidata, batched: the item found by Netflix ID (P1874) or Douban film ID (P4529)
      //      -> its IMDb IDs (P345) and Douban film IDs ----
      function wikidataLookup(prop, cachePrefix) {
        const waiting = new Map();
        let timer = null;

        async function flush() {
          timer = null;
          const batch = [...waiting.entries()].slice(0, 80);
          for (const [key] of batch) waiting.delete(key);
          if (waiting.size) timer = setTimeout(flush, 300);
          const found = {};
          let ok = false;
          try {
            const values = batch.map(([key]) => '"' + key + '"').join(' ');
            const q = 'SELECT ?k ?imdb ?douban WHERE { VALUES ?k { ' + values + ' } ?item wdt:' + prop + ' ?k . ' +
              'OPTIONAL { ?item wdt:P345 ?imdb } OPTIONAL { ?item wdt:P4529 ?douban } }';
            const res = await http('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), {
              Accept: 'application/sparql-results+json',
              'Api-User-Agent': 'netflix-douban-rating (https://github.com/JulianHunag/netflix-douban-rating)',
            });
            if (res.status === 200) {
              for (const b of JSON.parse(res.text).results.bindings) {
                const e = found[b.k.value] || (found[b.k.value] = { imdb: [], douban: [] });
                if (b.imdb && !e.imdb.includes(b.imdb.value)) e.imdb.push(b.imdb.value);
                if (b.douban && !e.douban.includes(b.douban.value)) e.douban.push(b.douban.value);
              }
              ok = true;
            } else {
              log('wikidata HTTP', res.status);
            }
          } catch (e) {
            log('wikidata failed', e);
          }
          for (const [key, waiters] of batch) {
            const f = found[key] || { imdb: [], douban: [] };
            const v = { ts: now(), imdb: f.imdb, douban: f.douban, failed: !ok };
            if (ok) store.set(cachePrefix + key, v);
            waiters.forEach(w => w(v));
          }
        }

        return key => {
          const c = store.get(cachePrefix + key);
          if (c && now() - c.ts < TTL.wikidata) return Promise.resolve(c);
          return new Promise(resolve => {
            if (!waiting.has(key)) waiting.set(key, []);
            waiting.get(key).push(resolve);
            if (!timer) timer = setTimeout(flush, 300);
          });
        };
      }
      const wikidata = wikidataLookup('P1874', 'w:');
      // Netflix IDs differ by region, so many items lack ours; their Douban ID still leads to IMDb.
      const wikidataByDouban = wikidataLookup('P4529', 'd:');

      // ---- Resolve one Netflix title ----
      async function doResolve(nf, prio) {
        const wd = await wikidata(nf.id);
        const manual = store.get('o:' + nf.id);
        const wanted = manual ? [String(manual)] : wd.douban;
        const isShow = nf.type === 'Show';
        let pool = [];
        let anchor = null;
        let via = '';
        let conf = 'exact';
        const searched = new Set();
        const searchInto = async q => {
          const k = norm(q);
          if (!k || searched.has(k)) return;
          searched.add(k);
          pool = pool.concat(await search(q, prio));
        };

        if (wanted.length) {
          via = manual ? 'manual' : 'wikidata';
          if (isShow && nf.title) await searchInto(nf.title);
          anchor = pool.find(r => wanted.includes(r.sid)) || await abstract(wanted[0], prio);
        } else if (wd.imdb.length) {
          via = 'imdb';
          anchor = (await search(wd.imdb[0], prio))[0] || null;
        }
        if (!anchor && nf.title) {
          via = 'title';
          await searchInto(nf.title);
          const m = matchByTitle(pool, nf);
          if (m) { anchor = m.item; conf = m.conf; }
        }
        if (!anchor) return { status: 'none', via: via || 'title', transient: wd.failed };

        const tv = isShow || anchor.kind === '电视剧';
        let list = [anchor];
        if (tv) {
          let fam = family(pool, anchor);
          // Other seasons may be missing from the first search; try the Chinese base title, then the original title.
          for (const q of [baseTitle(anchor.title), baseTitle(anchor.orig)]) {
            if (fam.length > 1 || (nf.seasons != null && nf.seasons <= 1)) break;
            await searchInto(q);
            fam = family(pool, anchor);
          }
          list = withSeasons(fam);
        }
        return {
          status: 'ok',
          via,
          conf,
          shown: slim(pickDisplay(list, nf)),
          seasons: list.length > 1 ? list.map(slim) : null,
          transient: wd.failed && via === 'title',
        };
      }

      function getCached(id) {
        const c = store.get('r:' + id);
        if (!c || c.v !== CACHE_VERSION) return null;
        const ttl = c.ttl || (c.status === 'ok' ? TTL.ok : TTL.none);
        return now() - c.ts < ttl ? c : null;
      }

      const inflight = new Map();
      function resolve(nf, prio) {
        const hit = getCached(nf.id);
        if (hit) return Promise.resolve(hit);
        if (inflight.has(nf.id)) return inflight.get(nf.id);
        const p = doResolve(nf, prio).then(r => {
          r.v = CACHE_VERSION;
          r.ts = now();
          if (r.transient) r.ttl = TTL.short;
          store.set('r:' + nf.id, r);
          return r;
        }, e => {
          if (e && e.paused) return { status: e.paused };
          log('resolve failed', nf, e);
          return { status: 'error', message: String((e && e.message) || e) };
        }).finally(() => inflight.delete(nf.id));
        inflight.set(nf.id, p);
        return p;
      }

      return {
        resolve,
        getCached,
        imdbIds: id => wikidata(id).then(w => (w.failed ? null : w.imdb)),
        imdbIdsByDouban: sids => Promise.all(sids.map(sid => wikidataByDouban(sid))).then(ws => {
          for (const w of ws) if (w.imdb.length) return w.imdb;
          return ws.some(w => w.failed) ? null : [];
        }),
        pausedUntil,
        // Lets the user force a retry; blockCount is kept so a still-blocked IP backs off further.
        clearBlock() { store.set('blockedUntil', 0); },
      };
    }

    return {
      CACHE_VERSION, HOURLY_LIMIT, parseSearch, parseAbstract, isBlocked, seasonNo, baseTitle, norm,
      family, withSeasons, pickDisplay, matchByTitle, parseImdbRatings, lookupImdb, createResolver,
    };
  })();

  if (typeof module === 'object' && module.exports) {
    module.exports = Core;
    return;
  }

  /* ------------------------------------------------------------------ *
   * Page hook: runs in Netflix's own JS world. Netflix's GraphQL
   * responses already carry title, type, latestYear and season count for
   * every card; forward them so we never have to ask Netflix ourselves.
   * ------------------------------------------------------------------ */
  function pageHook() {
    if (window.__nfdbHooked) return;
    window.__nfdbHooked = true;
    document.documentElement.setAttribute('data-nfdb-hook', '1');

    function collect(root, videos, episodes) {
      const walk = o => {
        if (Array.isArray(o)) { for (const x of o) walk(x); return; }
        if (!o || typeof o !== 'object') return;
        const tn = o.__typename;
        if ((tn === 'Show' || tn === 'Movie') && o.videoId) {
          const id = String(o.videoId);
          const v = videos[id] || (videos[id] = { id, type: tn });
          if (typeof o.title === 'string') v.title = o.title;
          if (o.latestYear) v.year = o.latestYear;
          if (o.runtimeSec) v.runtime = o.runtimeSec;
          if (o.seasons && typeof o.seasons.totalCount === 'number') v.seasons = o.seasons.totalCount;
          if (tn === 'Show' && o.currentEpisode && o.currentEpisode.videoId) episodes[o.currentEpisode.videoId] = id;
        }
        for (const k in o) {
          const v = o[k];
          if (v && typeof v === 'object') walk(v);
        }
      };
      walk(root);
    }

    function handle(text) {
      if (typeof text !== 'string' || text.indexOf('"videoId"') < 0) return;
      const videos = {};
      const episodes = {};
      let parts;
      try { parts = [JSON.parse(text)]; } catch (e) {
        // multipart / incremental delivery: parse each JSON chunk separately
        parts = [];
        for (const chunk of text.split(/\r?\n--[^\r\n]*\r?\n/)) {
          const a = chunk.indexOf('{');
          const b = chunk.lastIndexOf('}');
          if (a < 0 || b <= a) continue;
          try { parts.push(JSON.parse(chunk.slice(a, b + 1))); } catch (e2) { /* ignore */ }
        }
      }
      for (const p of parts) collect(p, videos, episodes);
      const list = Object.values(videos);
      if (!list.length && !Object.keys(episodes).length) return;
      document.dispatchEvent(new CustomEvent('nfdb:meta', { detail: JSON.stringify({ videos: list, episodes }) }));
    }

    const origFetch = window.fetch;
    window.fetch = function (input) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/graphql') >= 0) p.then(r => r.clone().text()).then(handle, () => {});
      } catch (e) { /* never break Netflix */ }
      return p;
    };

    // The billboard has no link to its title, so read the id from React props on request.
    document.addEventListener('nfdb:ask-id', e => {
      const el = e.target;
      try {
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
        let f = key && el[key];
        for (let i = 0; f && i < 60; i++, f = f.return) {
          const p = f.memoizedProps;
          if (!p || typeof p !== 'object') continue;
          let id = /^\d+$/.test(String(p.entityId || '')) ? String(p.entityId) : null;
          if (!id && p.trackingInfo && /^\d+$/.test(String(p.trackingInfo.videoId || ''))) id = String(p.trackingInfo.videoId);
          if (!id && typeof p.unifiedEntityId === 'string' && /^Video:\d+$/.test(p.unifiedEntityId)) id = p.unifiedEntityId.slice(6);
          if (id) { el.setAttribute('data-nfdb-vid', id); return; }
        }
      } catch (err) { /* ignore */ }
    });
  }

  function injectPageHook() {
    const code = '(' + pageHook.toString() + ')();';
    const root = document.head || document.documentElement;
    const s = document.createElement('script');
    s.textContent = code;
    root.appendChild(s);
    s.remove();
    if (document.documentElement.getAttribute('data-nfdb-hook') !== '1' && typeof GM_addElement === 'function') {
      try { GM_addElement(root, 'script', { textContent: code }); } catch (e) { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------------ *
   * Netflix UI
   * ------------------------------------------------------------------ */
  const log = (...a) => { if (GM_getValue('debug', false)) console.debug('[nfdb]', ...a); };
  const store = {
    get: k => GM_getValue(k, null),
    set: (k, v) => GM_setValue(k, v),
  };

  function gmHttp(url, headers) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: headers || {},
        anonymous: true, // never send the user's Douban login cookies
        timeout: 20000,
        onload: r => resolve({ status: r.status, url: r.finalUrl || url, text: r.responseText || '' }),
        onerror: () => reject(new Error('network error: ' + url)),
        ontimeout: () => reject(new Error('timeout: ' + url)),
      });
    });
  }

  const resolver = Core.createResolver({ http: gmHttp, store, log });

  /* ---- IMDb fallback: official non-commercial dataset, used when Douban gives no score ---- */
  const IMDB_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
  const IMDB_MAX_AGE = 7 * 864e5;
  const IMDB_MIN_VOTES = 20;
  const IMDB_KEY = 'imdb-ratings';
  let imdbTable = null; // Promise<table|null>

  // The ~9 MB table lives in IndexedDB, not GM storage, which is loaded into every page.
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('netflix-douban-rating', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => { db.close(); resolve(req && req.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }

  function gmBinary(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        anonymous: true,
        timeout: 120000,
        onload: r => (r.status === 200 ? resolve(r.response) : reject(new Error('HTTP ' + r.status + ' ' + url))),
        onerror: () => reject(new Error('network error: ' + url)),
        ontimeout: () => reject(new Error('timeout: ' + url)),
      });
    });
  }

  function loadImdb() {
    if (imdbTable) return imdbTable;
    imdbTable = (async () => {
      let saved = null;
      try { saved = await idb('readonly', s => s.get(IMDB_KEY)); } catch (e) { log('imdb cache read failed', e); }
      if (saved && Date.now() - saved.ts < IMDB_MAX_AGE) return saved;
      try {
        const buf = await gmBinary(IMDB_URL);
        const gz = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
        const table = Object.assign(Core.parseImdbRatings(await new Response(gz).text(), IMDB_MIN_VOTES), { ts: Date.now() });
        idb('readwrite', s => s.put(table, IMDB_KEY)).catch(e => log('imdb cache write failed', e));
        log('imdb ratings loaded', table.ids.length);
        return table;
      } catch (e) {
        log('imdb download failed', e);
        setTimeout(() => { imdbTable = null; }, 10 * 60e3); // allow another try later
        return saved; // a stale table beats none
      }
    })();
    return imdbTable;
  }

  const imdbById = new Map(); // Netflix id -> {tt, rating, votes, ts}, or null when there is none

  // IMDb rating via Wikidata's exact IMDb ID. Independent of Douban, so it shows right away.
  async function ensureImdb(id) {
    if (imdbById.has(id)) return;
    imdbById.set(id, null);
    try {
      let ids = await resolver.imdbIds(id);
      let via = 'netflix';
      if (ids && !ids.length) {
        // Wikidata has no item with this Netflix ID: go through the Douban match instead.
        const r = results.get(id);
        if (r && r.status === 'ok') {
          const sids = [r.shown.sid].concat((r.seasons || []).map(x => x.sid));
          ids = await resolver.imdbIdsByDouban([...new Set(sids)].slice(0, 6));
          via = 'douban';
        }
      }
      if (!ids) { imdbById.delete(id); return; } // Wikidata failed; try again on the next pass
      if (!ids.length) return;
      const table = await loadImdb();
      const hit = table && Core.lookupImdb(table, ids[0]);
      if (!hit) return;
      imdbById.set(id, Object.assign(hit, { ts: table.ts, via }));
      renderId(id);
    } catch (e) {
      log('imdb lookup failed', id, e);
      imdbById.delete(id);
    }
  }

  const CARD_SEL = 'a[href*="jbv="][data-uia*="card"]';
  const MODAL_SEL = '[data-uia^="modal-motion-container"]';
  const BILLBOARD_SEL = '[data-uia="billboard"]';
  const SIMILAR_SEL = '[data-uia="titleCard--container"]'; // "更多类似影片" in the detail modal
  const meta = new Map();      // Netflix id -> {id, type, title, year, runtime, seasons}
  const epToShow = new Map();  // episode id -> show id (episodic cards link to an episode)
  const metaWaiters = new Map();
  const results = new Map();   // Netflix id -> resolver result or {status: 'pending'}
  const visible = new Set();   // cards currently in (or near) the viewport
  const observed = new WeakSet();
  let pinnedIds = new Set();   // titles in an open preview / detail modal or the billboard; fetched first

  document.addEventListener('nfdb:meta', e => {
    let d;
    try { d = JSON.parse(e.detail); } catch (err) { return; }
    for (const v of d.videos || []) {
      meta.set(v.id, Object.assign(meta.get(v.id) || {}, v));
      const ws = metaWaiters.get(v.id);
      if (ws && v.title) { metaWaiters.delete(v.id); ws.forEach(w => w()); }
    }
    for (const [ep, show] of Object.entries(d.episodes || {})) epToShow.set(String(ep), show);
    scheduleScan();
  });

  function waitMeta(id, ms) {
    const m = meta.get(id);
    if (m && m.title) return Promise.resolve();
    return new Promise(resolve => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      if (!metaWaiters.has(id)) metaWaiters.set(id, []);
      metaWaiters.get(id).push(done);
    });
  }

  // Where the badge goes for a card or a modal, and which Netflix title it shows.
  function cardInfo(a) {
    const m = (a.getAttribute('href') || '').match(/[?&]jbv=(\d+)/);
    if (!m) return null;
    const episodic = /episodic/.test(a.getAttribute('data-uia') || '');
    return {
      host: a,
      id: episodic ? epToShow.get(m[1]) || null : m[1],
      label: episodic ? null : a.getAttribute('aria-label'),
      episodic,
      kind: 'card',
    };
  }

  // "More like this" cards have no link; their video id sits in Netflix's tracking context.
  function similarInfo(card) {
    let id = null;
    const ctx = card.querySelector('[data-ui-tracking-context]');
    try {
      id = String(JSON.parse(decodeURIComponent(ctx.getAttribute('data-ui-tracking-context'))).video_id);
    } catch (e) { /* not rendered yet */ }
    return {
      host: card,
      id: /^\d+$/.test(id || '') ? id : null,
      label: card.getAttribute('aria-label'),
      episodic: false,
      kind: 'similar',
    };
  }

  function infoFor(el) {
    return el.matches(CARD_SEL) ? cardInfo(el) : similarInfo(el);
  }

  function modalInfo(modal) {
    const detail = /DETAIL/.test(modal.getAttribute('data-uia') || '');
    const link = modal.querySelector('a[href*="/title/"]');
    const m = (link && link.getAttribute('href').match(/\/title\/(\d+)/)) ||
      (detail && (location.search.match(/[?&]jbv=(\d+)/) || location.pathname.match(/\/title\/(\d+)/)));
    return {
      host: modal.querySelector('[data-uia="previewModal--player_container"]') || modal,
      id: m ? m[1] : null,
      label: null,
      episodic: false,
      kind: detail ? 'detail' : 'mini',
    };
  }

  // The billboard's metadata row ("节目 • 剧情片 • 2013 • 共 6 季") hosts the badge.
  function billboardInfo(bb) {
    const host = bb.querySelector('[data-uia="attributes-elements"]');
    if (!host) return null;
    bb.removeAttribute('data-nfdb-vid');
    bb.dispatchEvent(new CustomEvent('nfdb:ask-id', { bubbles: true }));
    let id = bb.getAttribute('data-nfdb-vid');
    // aria-label looks like "精选内容：《浴血黑帮, 第 1 季》"
    const label = ((bb.getAttribute('aria-label') || '').match(/《(.+)》/) || [])[1];
    const title = label ? label.replace(/[,，]\s*第\s*\d+\s*季$/, '').trim() : null;
    if (!id && title) {
      for (const m of meta.values()) {
        if (m.title && Core.norm(m.title) === Core.norm(title)) { id = m.id; break; }
      }
    }
    const text = host.textContent || '';
    return {
      host,
      id,
      label: title,
      episodic: false,
      kind: 'billboard',
      type: /共\s*\d+\s*[季集]|节目/.test(text) ? 'Show' : undefined,
      year: +((text.match(/(?:19|20)\d{2}/) || [])[0] || 0) || undefined,
      seasons: +((text.match(/共\s*(\d+)\s*季/) || [])[1] || 0) || undefined,
    };
  }

  function prio(id) {
    if (pinnedIds.has(id)) return 2;
    for (const a of visible) if (a.dataset.nfdbId === id) return 1;
    return 0;
  }

  function ensure(info) {
    const id = info && info.id;
    if (!id) return;
    ensureImdb(id);
    if (results.has(id)) { renderId(id); return; }
    const cached = resolver.getCached(id);
    if (cached) { results.set(id, cached); renderId(id); return; }
    results.set(id, { status: 'pending' });
    renderId(id);
    (async () => {
      await waitMeta(id, 1500);
      const m = meta.get(id) || {};
      const nf = {
        id,
        type: m.type || info.type || (info.episodic ? 'Show' : undefined),
        title: m.title || info.label,
        year: m.year || info.year,
        runtime: m.runtime,
        seasons: m.seasons || info.seasons,
      };
      const r = await resolver.resolve(nf, () => prio(id));
      results.set(id, r);
      renderId(id);
      // A fresh Douban match can lead to an IMDb ID that the Netflix ID could not.
      if (r.status === 'ok' && imdbById.get(id) === null) { imdbById.delete(id); ensureImdb(id); }
      if (RETRY_STATUSES.has(r.status)) scheduleRetry(r.status);
    })();
  }

  const RETRY_STATUSES = new Set(['blocked', 'quota', 'error']);
  let retryTimer = null;
  function scheduleRetry(kind) {
    if (retryTimer) return;
    const wait = kind === 'error' ? 60e3 : Math.max(resolver.pausedUntil() - Date.now() + 1000, 30e3);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      for (const [id, r] of results) if (RETRY_STATUSES.has(r.status)) results.delete(id);
      scan();
    }, wait);
  }

  function clock(t) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderId(id) {
    for (const host of document.querySelectorAll('[data-nfdb-id="' + id + '"]')) render(host);
  }

  const VIA_TEXT = {
    wikidata: 'Wikidata 精确对应',
    imdb: 'IMDb 编号精确对应',
    manual: '手动指定',
    title: '按片名推断',
  };

  function seasonLabel(r) {
    return r.season ? '第' + r.season + '季' : r.title;
  }

  function tierClass(rating) {
    return rating >= 8 ? 'nfdb-good' : rating >= 6 ? 'nfdb-mid' : 'nfdb-bad';
  }

  function part(cls, logoText, valueText) {
    const p = document.createElement('span');
    p.className = 'nfdb-part ' + cls;
    const logo = document.createElement('i');
    logo.textContent = logoText;
    const val = document.createElement('b');
    val.textContent = valueText;
    p.append(logo, val);
    return p;
  }

  // Badge = Douban part (score or why there is none) + IMDb part when an exact IMDb rating exists.
  function paint(badge, r, kind, imdb) {
    badge.className = 'nfdb-badge nfdb-' + kind;
    badge.textContent = '';
    const dou = part('nfdb-dou', '豆', '');
    const val = dou.querySelector('b');
    badge.append(dou);
    const lines = [];
    const until = () => clock(resolver.pausedUntil());
    if (r.status === 'ok' && r.shown.rating != null) {
      const s = r.shown;
      val.textContent = s.rating.toFixed(1) + (r.conf === 'low' ? '?' : '');
      val.classList.add(tierClass(s.rating));
      if (r.conf === 'low') dou.classList.add('nfdb-low');
      lines.push('豆瓣 ' + s.rating.toFixed(1) + '　' + s.title + (s.year ? '（' + s.year + '）' : '') +
        (s.votes ? '　' + s.votes.toLocaleString() + ' 人评价' : ''));
    } else {
      dou.classList.add('nfdb-off');
      if (r.status === 'pending') {
        val.textContent = '…';
        lines.push('正在查豆瓣评分');
      } else if (r.status === 'ok') {
        val.textContent = '–';
        lines.push('豆瓣：' + r.shown.title + '　' + (r.shown.note || '暂无评分'));
      } else if (r.status === 'none') {
        val.textContent = '–';
        lines.push('豆瓣上没找到对应条目（片名差异，或被豆瓣搜索隐藏）');
      } else if (r.status === 'blocked') {
        val.textContent = '限流';
        lines.push('豆瓣把这个 IP 的匿名请求判为异常，暂停到 ' + until() + ' 再试（脚本不带你的豆瓣登录信息）');
      } else if (r.status === 'quota') {
        val.textContent = '暂停';
        lines.push('本小时已查询豆瓣 ' + Core.HOURLY_LIMIT + ' 次，为避免被豆瓣限流，暂停到 ' + until());
      } else {
        val.textContent = '!';
        lines.push('豆瓣查询失败：' + (r.message || '') + '，稍后自动重试');
      }
    }
    if (r.status === 'ok') {
      const s = r.shown;
      if (r.seasons && r.seasons.length > 1) {
        if (s.season) {
          const sl = document.createElement('small');
          sl.textContent = kind === 'card' ? 'S' + s.season : '第' + s.season + '季';
          dou.append(sl);
        }
        lines.push('各季：' + r.seasons.map(x => seasonLabel(x) + ' ' + (x.rating != null ? x.rating.toFixed(1) : '–')).join('　'));
      }
      lines.push('匹配：' + (VIA_TEXT[r.via] || r.via) + (r.conf === 'low' ? '（不确定）' : ''));
    }
    if (imdb) {
      const ip = part('nfdb-imdb', 'IMDb', imdb.rating.toFixed(1));
      ip.querySelector('b').classList.add(tierClass(imdb.rating));
      badge.append(ip);
      lines.push('IMDb ' + imdb.rating.toFixed(1) + '　' + imdb.votes.toLocaleString() + ' 人评分（官方数据集，' +
        new Date(imdb.ts).toLocaleDateString() + ' 下载' + (imdb.via === 'douban' ? '；经豆瓣条目对应' : '') + '）');
      lines.push('Information courtesy of IMDb (https://www.imdb.com). Used with permission.');
    }
    lines.push((imdb ? '点豆瓣部分打开豆瓣，点 IMDb 部分打开 IMDb' : '点击打开豆瓣') + '　Alt+点击手动纠正豆瓣条目');
    badge.title = lines.join('\n');
  }

  function render(host) {
    const id = host.dataset.nfdbId;
    const r = id && results.get(id);
    let badge = host.querySelector(':scope > .nfdb-badge');
    if (!r) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      // Only make static hosts positioned; never override Netflix's own absolute/fixed layout.
      if (getComputedStyle(host).position === 'static') host.classList.add('nfdb-host');
      host.appendChild(badge);
    }
    paint(badge, r, host.dataset.nfdbKind || 'card', imdbById.get(id) || null);
  }

  function openDouban(host, id) {
    const r = results.get(id);
    if (r && r.status === 'ok') {
      window.open('https://movie.douban.com/subject/' + r.shown.sid + '/', '_blank', 'noopener');
      return;
    }
    const m = meta.get(id);
    const q = (m && m.title) || host.getAttribute('aria-label');
    if (q) window.open('https://search.douban.com/movie/subject_search?search_text=' + encodeURIComponent(q), '_blank', 'noopener');
  }

  function correct(host, id) {
    const r = results.get(id);
    const cur = r && r.status === 'ok' ? 'https://movie.douban.com/subject/' + r.shown.sid + '/' : '';
    const input = window.prompt('输入正确的豆瓣条目链接或编号（清空则取消手动指定）', cur);
    if (input === null) return;
    const sid = (input.match(/(\d{4,})/) || [])[1];
    if (sid) GM_setValue('o:' + id, sid);
    else GM_deleteValue('o:' + id);
    GM_deleteValue('r:' + id);
    results.delete(id);
    ensure({ id, label: host.getAttribute('aria-label'), episodic: false });
  }

  // Badge clicks must not reach Netflix (it would open the title modal).
  function onBadgeEvent(e) {
    const badge = e.target.closest && e.target.closest('.nfdb-badge');
    if (!badge) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.type !== 'click') return;
    const host = badge.parentElement;
    const id = host && host.dataset.nfdbId;
    if (!id) return;
    const imdb = imdbById.get(id);
    if (e.altKey) correct(host, id);
    else if (imdb && e.target.closest('.nfdb-imdb')) window.open('https://www.imdb.com/title/' + imdb.tt + '/', '_blank', 'noopener');
    else openDouban(host, id);
  }

  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (en.isIntersecting) { visible.add(en.target); ensure(infoFor(en.target)); }
      else visible.delete(en.target);
    }
  }, { rootMargin: '200px 300px' });

  function sync(info, active) {
    if (!info) return;
    const host = info.host;
    const id = info.id || '';
    if (host.dataset.nfdbKind !== info.kind) host.dataset.nfdbKind = info.kind;
    if (host.dataset.nfdbId !== id) {
      host.dataset.nfdbId = id;
      render(host);
      if (active) ensure(info);
    } else if (id && results.has(id) && !host.querySelector(':scope > .nfdb-badge')) {
      render(host);
    } else if (active && id && !results.has(id)) {
      ensure(info);
    }
  }

  function scan() {
    for (const el of document.querySelectorAll(CARD_SEL + ',' + SIMILAR_SEL)) {
      if (!observed.has(el)) { observed.add(el); io.observe(el); }
      sync(infoFor(el), visible.has(el));
    }
    const ids = new Set();
    const pinned = [...document.querySelectorAll(MODAL_SEL)].map(modalInfo)
      .concat([...document.querySelectorAll(BILLBOARD_SEL)].map(billboardInfo));
    for (const info of pinned) {
      if (!info) continue;
      if (info.id) ids.add(info.id);
      sync(info, true);
    }
    pinnedIds = ids;
  }

  let scanQueued = false;
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; scan(); }, 150);
  }

  const STYLE = `
    .nfdb-host { position: relative !important; }
    .nfdb-badge {
      position: absolute; top: 6px; right: 6px; z-index: 5;
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 6px 2px 3px; border-radius: 4px;
      background: rgba(20, 20, 20, .82); color: #fff;
      font: 600 12px/16px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: 0 1px 4px rgba(0, 0, 0, .6); cursor: pointer; pointer-events: auto;
      letter-spacing: 0; white-space: nowrap;
    }
    .nfdb-badge i {
      font-style: normal; font-size: 11px; line-height: 15px; width: 15px; height: 15px;
      text-align: center; border-radius: 3px; background: #2e963d; color: #fff;
    }
    .nfdb-badge b { font-weight: 700; }
    .nfdb-badge small { font-size: 10px; font-weight: 400; opacity: .7; }
    .nfdb-badge.nfdb-mini, .nfdb-badge.nfdb-detail {
      top: 12px; right: 12px; z-index: 10; gap: 6px; padding: 4px 10px 4px 5px; border-radius: 6px;
      font-size: 16px; line-height: 22px;
    }
    .nfdb-badge.nfdb-detail { right: auto; left: 16px; top: 16px; }
    .nfdb-badge.nfdb-similar { right: auto; left: 10px; top: 10px; } /* duration sits top-right */
    .nfdb-badge.nfdb-mini i, .nfdb-badge.nfdb-detail i { width: 22px; height: 22px; line-height: 22px; font-size: 14px; }
    .nfdb-badge.nfdb-mini small, .nfdb-badge.nfdb-detail small { font-size: 13px; }
    .nfdb-badge.nfdb-billboard {
      position: static; align-self: center; margin-left: 12px; gap: 6px;
      padding: 4px 10px 4px 5px; border-radius: 6px; font-size: 18px; line-height: 24px;
    }
    .nfdb-badge.nfdb-billboard i { width: 24px; height: 24px; line-height: 24px; font-size: 15px; }
    .nfdb-badge.nfdb-billboard small { font-size: 14px; }
    .nfdb-part { display: inline-flex; align-items: center; gap: inherit; }
    .nfdb-part + .nfdb-part { margin-left: 2px; padding-left: 6px; border-left: 1px solid rgba(255, 255, 255, .25); }
    .nfdb-imdb i {
      width: auto !important; padding: 0 3px; background: #f5c518; color: #000;
      font-weight: 800; font-size: 10px; letter-spacing: -.2px;
    }
    .nfdb-badge.nfdb-mini .nfdb-imdb i, .nfdb-badge.nfdb-detail .nfdb-imdb i,
    .nfdb-badge.nfdb-billboard .nfdb-imdb i { padding: 0 5px; font-size: 13px; }
    .nfdb-badge b.nfdb-good { color: #ffcc33; }
    .nfdb-badge b.nfdb-bad { color: #c8c8c8; }
    .nfdb-off { color: rgba(255, 255, 255, .6); }
    .nfdb-off i { background: #5a5a5a; }
    .nfdb-dou.nfdb-low b { text-decoration: underline dashed rgba(255, 255, 255, .6); text-underline-offset: 3px; }
    .nfdb-badge:hover { background: rgba(0, 0, 0, .95); }
  `;

  function clearCache() {
    for (const k of GM_listValues()) if (/^(r|w):/.test(k)) GM_deleteValue(k);
    resolver.clearBlock();
    results.clear();
    document.querySelectorAll('.nfdb-badge').forEach(b => b.remove());
    document.querySelectorAll('[data-nfdb-id]').forEach(h => h.removeAttribute('data-nfdb-id'));
    scan();
  }

  injectPageHook();
  GM_addStyle(STYLE);
  for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
    document.addEventListener(t, onBadgeEvent, true);
  }
  GM_registerMenuCommand('清空豆瓣评分缓存（保留手动纠正）', clearCache);
  GM_registerMenuCommand('切换调试日志', () => {
    GM_setValue('debug', !GM_getValue('debug', false));
    console.info('[nfdb] debug =', GM_getValue('debug', false));
  });

  const start = () => {
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
    });
    window.addEventListener('popstate', scheduleScan);
    scan();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
