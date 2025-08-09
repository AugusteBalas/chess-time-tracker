function fmtSecs(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2,'0')}s`;
  return `${sec}s`;
}

function renderTable(tableId, obj, emptyLabel='—') {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = '';
  const entries = Object.entries(obj || {}).sort((a,b) => b[1]-a[1]);
  if (entries.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="2">${emptyLabel}</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const [k,v] of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${k}</td><td>${fmtSecs(v)}</td>`;
    tbody.appendChild(tr);
  }
}

async function rpc(type, payload={}, retries=2) {
  let lastErr = null;
  for (let i=0;i<retries;i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type, ...payload });
      if (res?.ok) return res;
      lastErr = new Error(res?.error || 'no response');
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw lastErr || new Error('RPC failed');
}

async function loadStats(range='all') {
  try {
    const res = await rpc('getStats', { range });
    const { perTC, perBucket, grandTotal } = res.stats;
    document.querySelector('#grandTotal').textContent = fmtSecs(grandTotal || 0);
    renderTable('tcTable', perTC, 'Aucune donnée');
    renderTable('bucketTable', perBucket, 'Aucune donnée');
    document.querySelector('#error').style.display = 'none';
  } catch (e) {
    const err = document.querySelector('#error');
    err.textContent = 'Impossible de charger les stats. Réessaie (ou recharge l’extension).';
    err.style.display = 'block';
    console.error('[CTT/popup] loadStats', e);
  }
}

function fmtDate(ms) { try { return new Date(ms).toLocaleString(); } catch { return ''; } }
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function loadGames(range='all') {
  try {
    const res = await rpc('getGames', { range });
    const tbody = document.querySelector('#gamesTable tbody');
    tbody.innerHTML = '';
    const games = res.games || [];
    if (games.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="8">Aucune partie</td>`;
      tbody.appendChild(tr);
      return;
    }
    for (const g of games) {
      const tr = document.createElement('tr');
      const baseM = g.baseMinutes || (g.tcString ? parseInt(String(g.tcString).split('+')[0],10) : null);
      const tc = g.tcString || (baseM ? `${baseM}m` : 'unknown');
      const bkt = g.bucket || (baseM!=null ? (baseM < 3 ? 'bullet' : baseM <=5 ? 'blitz' : baseM<=15 ? 'rapid' : 'classical') : 'unknown');
      const link = g.url ? `<a class="small" href="${escapeHtml(g.url)}" target="_blank">ouvrir</a>` : '';
      tr.innerHTML = `
        <td>${fmtDate(g.startedAt)}</td>
        <td>${escapeHtml(tc)}</td>
        <td>${escapeHtml(bkt)}</td>
        <td>${escapeHtml(g.color || '')}</td>
        <td>${escapeHtml(g.opponent || '')}</td>
        <td>${escapeHtml(g.result || '')}</td>
        <td>${fmtSecs(g.durationSeconds || 0)}</td>
        <td>${link}</td>
      `;
      tbody.appendChild(tr);
    }
    document.querySelector('#error').style.display = 'none';
  } catch (e) {
    const err = document.querySelector('#error');
    err.textContent = 'Impossible de charger les parties. Réessaie (ou recharge l’extension).';
    err.style.display = 'block';
    console.error('[CTT/popup] loadGames', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.controls button').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.controls button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const range = btn.dataset.range;
      await loadStats(range);
      await loadGames(range);
    });
  });

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      document.querySelector(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  document.querySelector('#exportBtn').addEventListener('click', async () => {
    try {
      const res = await rpc('exportCSV');
      const blob = new Blob([res.csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'chess-time-tracker-games.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      const err = document.querySelector('#error');
      err.textContent = 'Export impossible (service worker endormi ?). Ouvre le popup à nouveau ou recharge l’extension.';
      err.style.display = 'block';
    }
  });

  document.querySelector('#resetBtn').addEventListener('click', async () => {
    if (!confirm('Réinitialiser toutes les données ?')) return;
    try {
      await rpc('resetAll');
      const range = document.querySelector('.controls button.active').dataset.range || 'all';
      await loadStats(range);
      await loadGames(range);
    } catch (e) {
      const err = document.querySelector('#error');
      err.textContent = 'Reset impossible. Réessaie.';
      err.style.display = 'block';
    }
  });

  const debugToggle = document.querySelector('#debugToggle');
  debugToggle.addEventListener('change', async () => {
    try { await rpc('setCfg', { cfg: { debug: debugToggle.checked } }); } catch {}
  });

  loadStats('all');
  loadGames('all');
});