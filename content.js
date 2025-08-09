// content.js v1.3.3
(() => {
  if (window.__CTT_V133__) return;
  window.__CTT_V133__ = true;

  let CFG_DEBUG = false;
  chrome.runtime.sendMessage({ type: 'getCfg' }).then(res => {
    if (res && res.ok && res.cfg) CFG_DEBUG = !!res.cfg.debug;
  }).catch(() => {});
  const log = (...a) => { if (CFG_DEBUG) console.log('[CTT/content]', ...a); };

  const STATE = { IDLE:'idle', WAITING:'waiting', IN_GAME:'in_game', OVER:'over' };
  let state = STATE.IDLE;
  let current = null;
  let lastHref = location.href;
  let lastMoveCount = 0;
  let stableSince = Date.now();
  let lastClockSample = { t: 0, vals: [] };
  let pageFinished = false; // latch: finished UI present

  const EXCLUDES = [/\/puzzles/i, /\/lessons/i, /\/analysis/i, /\/news/i];
  const isExcluded = () => EXCLUDES.some(r => r.test(location.pathname));
  const isPlayPage = () => !isExcluded() && (/\/play\/online|\/live|\/game\/live\//i.test(location.pathname) || !!document.querySelector('chess-board, .board, .game-board, [data-cy="board"]'));

  function parseTimeStr(s) {
    const m = s?.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const h = m[3] ? parseInt(m[1],10) : 0;
    const mm = m[3] ? parseInt(m[2],10) : parseInt(m[1],10);
    const ss = m[3] ? parseInt(m[3],10) : parseInt(m[2],10);
    if ([h,mm,ss].some(Number.isNaN)) return null;
    return h*3600 + mm*60 + ss;
  }

  function getClocks() {
    const nodes = Array.from(document.querySelectorAll('[role="timer"], [class*="clock"], .v5-game-clock, time')).filter(el => /\d{1,2}:\d{2}(:\d{2})?/.test((el.textContent||'').trim()));
    const uniq = [];
    const seen = new Set();
    for (const el of nodes) {
      const t = (el.textContent||'').trim();
      const key = t+'|'+(el.offsetTop|0)+'|'+(el.offsetLeft|0);
      if (!seen.has(key)) { seen.add(key); uniq.push(el); }
    }
    uniq.sort((a,b) => (b.getBoundingClientRect().width*b.getBoundingClientRect().height) - (a.getBoundingClientRect().width*a.getBoundingClientRect().height));
    return uniq.slice(0,2).map(el => parseTimeStr((el.textContent||'').trim())).filter(v => v!=null);
  }

  function sampleClocks() {
    const now = Date.now();
    const vals = getClocks();
    if (vals.length < 2) return { decreasing:false, stable:false };
    if (lastClockSample.t === 0) {
      lastClockSample = { t: now, vals };
      return { decreasing:false, stable:false };
    }
    const dec = vals.some((v,i) => v < lastClockSample.vals[i] - 0.5);
    const same = vals.every((v,i) => Math.abs(v - lastClockSample.vals[i]) < 0.5);
    lastClockSample = { t: now, vals };
    return { decreasing: dec, stable: same };
  }

  const moveTimestampNodes = () => Array.from(document.querySelectorAll('[data-move-list-el="timestamp"][data-time][data-ply]'));
  function sumPerMoveTenths() {
    const nodes = moveTimestampNodes();
    if (!nodes.length) return { seconds: null, count: 0 };
    let tenths = 0; let counted = 0;
    for (const el of nodes) {
      const v = parseInt(el.getAttribute('data-time'), 10);
      if (Number.isFinite(v)) { tenths += v; counted++; }
    }
    const seconds = tenths / 10;
    log('sumPerMoveTenths()', { nodes: counted, tenths, seconds });
    return { seconds, count: counted };
  }

  const getMoveCount = () => document.querySelectorAll('[data-ply]').length;

  function detectResultText() {
    const gr = document.querySelector('.game-result');
    if (gr) {
      const t = (gr.textContent||'').trim();
      if (t) return t;
    }
    const txt = document.body.innerText || '';
    if (/\b1\s*[–-]\s*0\b/.test(txt)) return '1-0';
    if (/\b0\s*[–-]\s*1\b/.test(txt)) return '0-1';
    if (/1\/2-1\/2|½\s*[–-]\s*½|Draw|Nulle/i.test(txt)) return '1/2-1/2';
    if (/You won|Victoire|Gagné/i.test(txt)) return 'win';
    if (/You lost|Défaite|Perdu/i.test(txt)) return 'loss';
    return null;
  }

  function gameOverPresent() {
    return !!document.querySelector('.game-result') || Array.from(document.querySelectorAll('button,[role="button"]')).some(b => {
      const t = (b.textContent||b.getAttribute('aria-label')||'').toLowerCase();
      return t.includes('rematch') || t.includes('revanche') || t.includes('game review') || t.includes('analyse');
    });
  }

  function bucketFromBaseMinutes(mins) {
    if (!mins && mins !== 0) return 'unknown';
    if (mins < 3) return 'bullet';
    if (mins <= 5) return 'blitz';
    if (mins <= 15) return 'rapid';
    return 'classical';
  }

  function bucketFromText(txt) {
    if (!txt) return null;
    const t = txt.toLowerCase();
    if (/\b(bullet|ultra-?bullet)\b/.test(t)) return 'bullet';
    if (/\b(blitz)\b/.test(t)) return 'blitz';
    if (/\b(rapid|rapide)\b/.test(t)) return 'rapid';
    if (/\b(classical|classique)\b/.test(t)) return 'classical';
    return null;
    }

  function tryReadTCOnce() {
    // Look in many likely places; FR/EN
    const areas = Array.from(document.querySelectorAll(`
      header, [role="banner"], [data-cy], button, .tabs, .controls, .ui_v5-title, .header,
      .game-controls, .play-tabs, .section, .game-details, .game-over, .game-header,
      [class*="time"], [class*="control"], [aria-label*="Time"], [title*="Time"]
    `));
    const seen = new Set();
    let tcString = null, baseMinutes = null, bucket = null;

    for (const el of areas) {
      const txt = (el.innerText || el.textContent || '').trim();
      if (!txt || seen.has(txt)) continue;
      seen.add(txt);

      // e.g. "3|2" or "3+2"
      const m1 = txt.match(/(\d{1,3})\s*[\|\+]\s*(\d{1,2})/);
      if (m1) {
        const a = parseInt(m1[1],10), b = parseInt(m1[2],10);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          tcString = `${a}+${b}`;
          baseMinutes = baseMinutes || a;
        }
      }

      // e.g. "3 min" / "3m"
      const m2 = txt.match(/\b(\d{1,3})\s*(?:min|minutes?|m)\b/i);
      if (m2) {
        const a = parseInt(m2[1],10);
        if (Number.isFinite(a)) baseMinutes = baseMinutes || a;
      }

      // bucket by word
      bucket = bucket || bucketFromText(txt);
    }

    if (!bucket && baseMinutes != null) bucket = bucketFromBaseMinutes(baseMinutes);
    return { tcString, baseMinutes, bucket };
  }

  async function waitForTC(maxMs = 2000) {
    const start = Date.now();
    let best = { tcString:null, baseMinutes:null, bucket:null };
    while (Date.now() - start < maxMs) {
      const t = tryReadTCOnce();
      if (t.tcString || t.baseMinutes || t.bucket) {
        best = t;
        if (t.tcString && (t.baseMinutes!=null) && t.bucket) break;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return best;
  }

  function detectOpponent() {
    const links = Array.from(document.querySelectorAll('a[href*="/member/"]'));
    const names = links.map(a => (a.innerText||'').trim()).filter(Boolean);
    if (names.length >= 2) {
      const youIdx = names.findIndex(n => /You|Vous/i.test(n));
      if (youIdx === 0) return names[1];
      if (youIdx === 1) return names[0];
      return names[1];
    }
    return names[0] || null;
  }

  function detectColor() {
    const txt = document.body.innerText || '';
    if (/\bWhite\b.*\byou\b/i.test(txt) || /\bVous\b.*Blancs/i.test(txt)) return 'white';
    if (/\bBlack\b.*\byou\b/i.test(txt) || /\bVous\b.*Noirs/i.test(txt)) return 'black';
    return null;
  }

  function getGameKey() {
    const m = location.pathname.match(/\/game\/live\/(\d+)/);
    if (m) return `live:${m[1]}`;
    return `href:${location.href}`;
  }

  async function beginWaiting() {
    if (gameOverPresent()) {
      pageFinished = true;
      state = STATE.OVER;
      log('WAITING blocked: pageFinished');
      // Record once if we land post-game
      const { seconds, count } = sumPerMoveTenths();
      const tc = await waitForTC(2000);
      const baseMinutes = tc.baseMinutes || (tc.tcString ? parseInt(tc.tcString.split('+')[0],10) : null);
      const bucket = tc.bucket || (baseMinutes!=null ? bucketFromBaseMinutes(baseMinutes) : null);
      const game = {
        key: getGameKey(),
        startedAt: Date.now(),
        endedAt: Date.now(),
        durationSeconds: (seconds && seconds > 0) ? seconds : 0,
        timestampCount: count || 0,
        tcString: tc.tcString || null,
        baseMinutes,
        bucket: bucket || 'unknown',
        color: detectColor(),
        opponent: detectOpponent(),
        result: detectResultText(),
        source: (seconds && seconds > 0) ? 'moveTimes(data-time)' : 'noData',
        url: location.href,
        reason: 'finished_page_once'
      };
      chrome.runtime.sendMessage({ type: 'recordGame', game }).catch(()=>{});
      return;
    }
    pageFinished = false;
    state = STATE.WAITING;
    current = null;
    lastMoveCount = getMoveCount();
    stableSince = Date.now();
    log('WAITING');
  }

  async function maybeStartGame() {
    if (state !== STATE.WAITING) return;
    if (pageFinished || gameOverPresent()) return;
    const clocks = sampleClocks();
    const moves = getMoveCount();
    const tsCount = moveTimestampNodes().length;
    if (clocks.decreasing || moves >= 2 || tsCount >= 1) {
      const tc = await waitForTC(2000);
      const baseMinutes = tc.baseMinutes || (tc.tcString ? parseInt(tc.tcString.split('+')[0],10) : null);
      const bucket = tc.bucket || (baseMinutes!=null ? bucketFromBaseMinutes(baseMinutes) : null);
      current = {
        key: getGameKey(),
        startedAt: Date.now(),
        tcString: tc.tcString || null,
        baseMinutes,
        bucket: bucket || 'unknown',
        color: detectColor(),
        url: location.href
      };
      state = STATE.IN_GAME;
      log('IN_GAME start', current);
    }
  }

  async function finalize(reason) {
    if (state !== STATE.IN_GAME) return;
    state = STATE.OVER;
    const endedAt = Date.now();
    const { seconds, count } = sumPerMoveTenths();
    const dwell = current?.startedAt ? Math.max(0, Math.round((endedAt - current.startedAt)/1000)) : 0;
    let durationSeconds = (seconds && seconds > 0) ? seconds : dwell;
    const res = detectResultText();
    // Enrich TC if missing
    if (!current.tcString || current.baseMinutes==null || !current.bucket) {
      const tc = await waitForTC(1500);
      current.tcString = current.tcString || tc.tcString || null;
      current.baseMinutes = current.baseMinutes || tc.baseMinutes || (tc.tcString ? parseInt(tc.tcString.split('+')[0],10) : null);
      current.bucket = current.bucket || tc.bucket || (current.baseMinutes!=null ? bucketFromBaseMinutes(current.baseMinutes) : 'unknown');
    }
    const game = {
      ...(current || {}),
      endedAt,
      durationSeconds,
      timestampCount: count || 0,
      opponent: detectOpponent(),
      result: res || null,
      source: (seconds && seconds > 0) ? 'moveTimes(data-time)' : 'dwellFallback',
      reason
    };
    log('FINALIZE', game);
    try { await chrome.runtime.sendMessage({ type: 'recordGame', game }); } catch {}
    current = null;
  }

  function onUrlChange() {
    if (location.href === lastHref) return;
    const prev = lastHref;
    lastHref = location.href;
    pageFinished = false;
    log('URL change', prev, '→', lastHref);
    if (!isPlayPage()) { state = STATE.IDLE; return; }
    beginWaiting();
  }
  const push = history.pushState, rep = history.replaceState;
  history.pushState = function() { push.apply(this, arguments); setTimeout(onUrlChange, 0); };
  history.replaceState = function() { rep.apply(this, arguments); setTimeout(onUrlChange, 0); };
  window.addEventListener('popstate', () => setTimeout(onUrlChange, 0));

  const obs = new MutationObserver(() => {
    if (!isPlayPage()) return;
    const mc = getMoveCount();
    if (mc !== lastMoveCount) { lastMoveCount = mc; stableSince = Date.now(); }
    if (gameOverPresent() && state === STATE.IN_GAME) finalize('ui_result');
  });
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  setInterval(() => {
    if (!isPlayPage()) { state = STATE.IDLE; return; }
    if (state === STATE.IDLE) beginWaiting();
    if (state === STATE.WAITING) maybeStartGame();
    if (state === STATE.IN_GAME) {
      const sample = sampleClocks();
      const inactivityMs = Date.now() - stableSince;
      if (gameOverPresent()) finalize('explicit');
      else if (sample.stable && inactivityMs > 15000) finalize('stable_clocks');
    }
  }, 1000);

  window.addEventListener('beforeunload', () => { if (state === STATE.IN_GAME) finalize('unload'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state === STATE.IN_GAME && gameOverPresent()) finalize('hidden_after_over');
  }, { passive: true });

  if (isPlayPage()) beginWaiting();
})();