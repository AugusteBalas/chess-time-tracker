// background.js v1.3.3
const STORAGE_GAMES = 'gamesV7';
const LEGACY_KEYS = ['gamesV4','gamesV5','gamesV6'];
const STORAGE_CFG = 'cfgV1'; // {debug:boolean}

function toDateKey(tsMs = Date.now()) {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function getCfg() {
  const cfg = (await chrome.storage.local.get(STORAGE_CFG))[STORAGE_CFG] || {};
  return { debug: !!cfg.debug };
}

async function setCfg(cfg) {
  await chrome.storage.local.set({ [STORAGE_CFG]: { ...(await getCfg()), ...cfg } });
}

function mergeGames(oldG, newG) {
  const durationSeconds = Math.max(Number(oldG.durationSeconds||0), Number(newG.durationSeconds||0));
  return {
    ...oldG,
    ...newG,
    durationSeconds,
    result: newG.result || oldG.result || null,
    opponent: newG.opponent || oldG.opponent || null,
    tcString: newG.tcString || oldG.tcString || null,
    baseMinutes: newG.baseMinutes || oldG.baseMinutes || null,
    bucket: newG.bucket || oldG.bucket || null,
    color: newG.color || oldG.color || null,
    url: newG.url || oldG.url || null,
    key: newG.key || oldG.key || null,
    source: newG.source || oldG.source || null,
  };
}

function near(a, b, ms) { return Math.abs((a||0) - (b||0)) <= ms; }

async function upsertGame(game) {
  const cfg = await getCfg();
  if (cfg.debug) console.log('[CTT/bg] recordGame', game);

  // Drop likely noise: <2s and <3 timestamps
  if ((Number(game.durationSeconds||0) < 2) && Number(game.timestampCount||0) < 3) {
    if (cfg.debug) console.log('[CTT/bg] drop tiny record', game);
    return;
  }

  const store = (await chrome.storage.local.get(STORAGE_GAMES))[STORAGE_GAMES] || {};
  const keyDate = toDateKey(game.startedAt || game.endedAt || Date.now());
  if (!store[keyDate]) store[keyDate] = [];

  const list = store[keyDate];
  let idx = -1;

  // 1) Exact key
  if (game.key) idx = list.findIndex(g => g.key === game.key);

  // 2) Same href + same result + endedAt ~60s
  if (idx < 0 && game.url && game.endedAt) {
    idx = list.findIndex(g => g.url === game.url && g.result === game.result && near(g.endedAt, game.endedAt, 60000));
  }

  // 3) Same href + startedAt ~60s
  if (idx < 0 && game.url && game.startedAt) {
    idx = list.findIndex(g => g.url === game.url && near(g.startedAt, game.startedAt, 60000));
  }

  if (idx >= 0) list[idx] = mergeGames(list[idx], game);
  else list.push(game);

  await chrome.storage.local.set({ [STORAGE_GAMES]: store });
}

function dateInRange(dateKey, fromMs, toMs) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d).getTime();
  const dayEnd = dayStart + 24 * 3600 * 1000 - 1;
  return !(dayEnd < fromMs || dayStart > toMs);
}

function rangeToFromMs(range) {
  const now = Date.now();
  if (range === 'today') {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  if (range === '7d') return now - 7 * 24 * 3600 * 1000;
  if (range === '30d') return now - 30 * 24 * 3600 * 1000;
  return 0;
}

async function getStats(range) {
  const store = (await chrome.storage.local.get(STORAGE_GAMES))[STORAGE_GAMES] || {};
  const fromMs = rangeToFromMs(range);
  const toMs = Date.now();
  const perTC = {};
  const perBucket = {};
  let grandTotal = 0;

  for (const [dateKey, games] of Object.entries(store)) {
    if (!dateInRange(dateKey, fromMs, toMs)) continue;
    for (const g of games) {
      const secs = Number(g.durationSeconds || 0);
      const baseM = g.baseMinutes || (g.tcString ? parseInt(String(g.tcString).split('+')[0], 10) : null);
      const tcLabel = g.tcString || (baseM ? `${baseM}m` : 'unknown');
      const bkt = g.bucket || (baseM!=null ? (baseM < 3 ? 'bullet' : baseM <=5 ? 'blitz' : baseM<=15 ? 'rapid' : 'classical') : 'unknown');

      perTC[tcLabel] = (perTC[tcLabel] || 0) + secs;
      perBucket[bkt] = (perBucket[bkt] || 0) + secs;
      grandTotal += secs;
    }
  }
  return { perTC, perBucket, grandTotal };
}

async function getGames(range) {
  const store = (await chrome.storage.local.get(STORAGE_GAMES))[STORAGE_GAMES] || {};
  const fromMs = rangeToFromMs(range);
  const toMs = Date.now();
  const result = [];
  for (const [dateKey, games] of Object.entries(store)) {
    if (!dateInRange(dateKey, fromMs, toMs)) continue;
    result.push(...games);
  }
  result.sort((a,b) => (b.startedAt||0) - (a.startedAt||0));
  return result;
}

async function exportCSV() {
  const store = (await chrome.storage.local.get(STORAGE_GAMES))[STORAGE_GAMES] || {};
  const lines = [['date','startedAt','endedAt','durationSeconds','tc','bucket','rated','color','result','opponent','url','key','source','timestampCount']];
  for (const [dateKey, games] of Object.entries(store)) {
    for (const g of games) {
      const baseM = g.baseMinutes || (g.tcString ? parseInt(String(g.tcString).split('+')[0], 10) : '');
      const bkt = g.bucket || (baseM!=='' ? (baseM < 3 ? 'bullet' : baseM <=5 ? 'blitz' : baseM<=15 ? 'rapid' : 'classical') : '');
      lines.push([
        dateKey,
        String(g.startedAt||''),
        String(g.endedAt||''),
        String(g.durationSeconds||0),
        g.tcString || (baseM?`${baseM}m`:''),
        bkt,
        g.rated ? 'yes' : 'no',
        g.color || '',
        g.result || '',
        g.opponent || '',
        g.url || '',
        g.key || '',
        g.source || '',
        String(g.timestampCount||0)
      ]);
    }
  }
  return lines.map(row => row.map(x => `"${String(x).replaceAll('"', '""')}"`).join(',')).join('\n');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const { debug } = await getCfg();
      if (debug) console.log('[CTT/bg]', msg);

      if (msg?.type === 'recordGame') {
        await upsertGame(msg.game);
        sendResponse({ ok: true });
      } else if (msg?.type === 'getStats') {
        const stats = await getStats(msg.range || 'all');
        sendResponse({ ok: true, stats });
      } else if (msg?.type === 'getGames') {
        const games = await getGames(msg.range || 'all');
        sendResponse({ ok: true, games });
      } else if (msg?.type === 'resetAll') {
        await chrome.storage.local.remove([STORAGE_GAMES, ...LEGACY_KEYS]);
        sendResponse({ ok: true });
      } else if (msg?.type === 'exportCSV') {
        const csv = await exportCSV();
        sendResponse({ ok: true, csv });
      } else if (msg?.type === 'setCfg') {
        await setCfg(msg.cfg || {});
        sendResponse({ ok: true });
      } else if (msg?.type === 'getCfg') {
        const cfg = await getCfg();
        sendResponse({ ok: true, cfg });
      } else {
        sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e) {
      console.error('[CTT/bg] error', e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});