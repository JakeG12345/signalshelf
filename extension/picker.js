const $ = s => document.querySelector(s);
const send = msg => chrome.runtime.sendMessage(msg).catch(e => ({ ok: false, error: e.message }));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { items: [], saved: new Set(), selected: new Set() };

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const shown = state.items.filter(i => !q || `${i.title} ${i.creator}`.toLowerCase().includes(q));
  $('#list').innerHTML = shown.map(i => {
    const saved = state.saved.has(i.key);
    return `<li class="${saved ? 'saved' : ''}"><label>
      <input type="checkbox" data-key="${esc(i.key)}" ${state.selected.has(i.key) ? 'checked' : ''} ${saved ? 'disabled' : ''}>
      <span><span class="t">${esc(i.title)}</span><br><span class="s">${esc(i.creator)}</span></span>
      <span class="when">${saved ? '' : esc(i.length || '')}</span></label></li>`;
  }).join('');
  const n = state.selected.size;
  $('#count').textContent = n ? `${n} selected` : 'Tick what you want to keep.';
  $('#save').disabled = !n;
  $('#save').textContent = n ? `Save ${n} to shelf` : 'Save to shelf';
  return shown;
}

async function start() {
  const res = await send({ type: 'KT_HISTORY' });
  if (!res.ok) { $('#status').textContent = res.error; $('#status').className = 'err'; return; }
  state.items = res.data;
  const ex = await send({ type: 'KT_EXISTS', ids: state.items.map(i => i.key) });
  if (ex.ok) state.saved = new Set(ex.data.saved);
  else { $('#status').textContent = ex.error; $('#status').className = 'err'; return; }
  $('#status').textContent = `Your ${state.items.length} most recent videos. Transcripts are added when the video has captions.`;
  $('#bar').hidden = false; $('#foot').hidden = false;
  render();
}

$('#list').addEventListener('change', e => {
  const k = e.target.dataset?.key; if (!k) return;
  e.target.checked ? state.selected.add(k) : state.selected.delete(k);
  render();
});
$('#q').addEventListener('input', render);
$('#all').addEventListener('click', () => { render().forEach(i => { if (!state.saved.has(i.key)) state.selected.add(i.key); }); render(); });
$('#none').addEventListener('click', () => { state.selected.clear(); render(); });

$('#save').addEventListener('click', async () => {
  const picks = state.items.filter(i => state.selected.has(i.key));
  const btn = $('#save'); btn.disabled = true;
  $('#progress').hidden = false; $('#count').hidden = true;
  let done = 0, failed = 0;
  const queue = [...picks];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const i = queue.shift();
      const r = await send({ type: 'KT_INGEST_URL', url: i.url, status: 'watched' });
      if (r.ok) { state.saved.add(i.key); state.selected.delete(i.key); } else failed++;
      done++;
      $('#progress i').style.width = `${Math.round(done / picks.length * 100)}%`;
      btn.textContent = `Saving ${done} of ${picks.length}…`;
    }
  }));
  $('#progress').hidden = true; $('#count').hidden = false;
  render();
  $('#count').textContent = failed ? `Saved ${picks.length - failed}. ${failed} failed; try them again.` : `Saved ${picks.length} to your shelf.`;
});

start();
