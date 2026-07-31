// ============================================================================
// Insights dashboard — knowledge density heatmap, interactive word cloud, timeline
// ============================================================================

let _index = null;
let _onEntityClick = null;

export function initInsights(index, callbacks = {}) {
  _index = index;
  _onEntityClick = callbacks.onEntityClick || (() => {});

  renderHeatmap();
  renderWordCloud();
  renderTimeline();
  setupTabs();
}

// ===========================================================================
// Tab switching
// ===========================================================================
function setupTabs() {
  const tabs = document.querySelectorAll('#insight-tabs .tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll('.insight-panel').forEach(p => {
        p.classList.toggle('is-active', p.dataset.panel === target);
      });
    });
  });
}

// ===========================================================================
// Heatmap — knowledge density by document
// ===========================================================================
function renderHeatmap() {
  const panel = document.getElementById('panel-heatmap');
  const rows = _index.documents.map(doc => {
    const chunks = _index.chunks.filter(c => c.document_id === doc.id);
    const entities = new Set();
    for (const c of chunks) for (const eid of (c.entities || [])) entities.add(eid);
    const density = chunks.length * 0.6 + entities.size * 0.8;
    return { name: doc.name, chunks: chunks.length, entities: entities.size, density };
  });

  const max = Math.max(...rows.map(r => r.density), 1);
  rows.sort((a, b) => b.density - a.density);

  const html = `
    <div class="heatmap">
      <p class="heatmap-intro">Coverage by domain — chunks indexed and entities surfaced per document.</p>
      ${rows.map(r => {
        const pct = Math.max(8, Math.round((r.density / max) * 100));
        return `
          <div class="hm-row">
            <span class="hm-label" title="${escapeHtml(r.name)}">${escapeHtml(stripExt(r.name))}</span>
            <div class="hm-track">
              <div class="hm-fill" style="width:${pct}%">
                <span class="hm-value">${r.chunks}c · ${r.entities}e</span>
              </div>
            </div>
          </div>`;
      }).join('')}
    </div>`;
  panel.innerHTML = html;
}

// ===========================================================================
// Word cloud — top entities, sized by mention count, clickable
// ===========================================================================
function renderWordCloud() {
  const panel = document.getElementById('panel-cloud');
  const top = [..._index.entities]
    .sort((a, b) => b.mention_count - a.mention_count)
    .slice(0, 30);

  if (top.length === 0) {
    panel.innerHTML = '<p class="heatmap-intro">No entities surfaced yet.</p>';
    return;
  }

  const max = top[0].mention_count;
  const min = top[top.length - 1].mention_count;
  const range = Math.max(max - min, 1);

  panel.innerHTML = `
    <p class="heatmap-intro">Top concepts in the corpus — click to focus the graph.</p>
    <div class="wordcloud">
      ${top.map(e => {
        const t = (e.mention_count - min) / range;
        const size = 14 + Math.round(t * 22);  // 14px → 36px
        const opacity = 0.6 + t * 0.4;
        return `<button class="wc-word" data-eid="${e.id}" style="font-size:${size}px;opacity:${opacity.toFixed(2)}">${escapeHtml(e.name)}</button>`;
      }).join('')}
    </div>`;

  panel.querySelectorAll('.wc-word').forEach(btn => {
    btn.addEventListener('click', () => _onEntityClick(parseInt(btn.dataset.eid, 10)));
  });
}

// ===========================================================================
// Timeline — knowledge growth across documents
// Demo data: 8-month synthetic timeline derived from document ordering
// ===========================================================================
function renderTimeline() {
  const panel = document.getElementById('panel-timeline');
  const docs = _index.documents;
  if (docs.length === 0) {
    panel.innerHTML = '<p class="heatmap-intro">No documents indexed.</p>';
    return;
  }

  // Distribute documents across recent months for visualization
  const months = makeMonthBuckets(8);
  const docsPerBucket = Math.max(1, Math.ceil(docs.length / months.length));
  const events = [];
  let cursor = 0;
  for (let i = 0; i < months.length; i++) {
    const slot = docs.slice(cursor, cursor + docsPerBucket);
    cursor += docsPerBucket;
    months[i].docCount = slot.length;
    months[i].chunkCount = slot.reduce((s, d) => s + d.chunk_count, 0);
    if (slot.length > 0) {
      events.push({ month: months[i].label, docs: slot.map(d => stripExt(d.name)), chunks: months[i].chunkCount });
    }
  }

  const maxBar = Math.max(...months.map(m => m.chunkCount), 1);

  panel.innerHTML = `
    <p class="heatmap-intro">Knowledge growth — chunks added per month across the corpus.</p>
    <div class="timeline">
      <div class="tl-axis">
        <span>${months[0].label}</span>
        <span>${months[Math.floor(months.length / 2)].label}</span>
        <span>${months[months.length - 1].label}</span>
      </div>
      <div class="tl-bars">
        ${months.map(m => {
          const h = Math.max(4, Math.round((m.chunkCount / maxBar) * 90));
          return `<div class="tl-bar" style="height:${h}px" title="${m.label}: ${m.chunkCount} chunks"></div>`;
        }).join('')}
      </div>
      <div class="tl-events">
        ${events.slice(-4).reverse().map(e => `
          <div class="tl-event">
            <span class="tl-event-date">${e.month}</span>
            <span class="tl-event-text">${escapeHtml(e.docs.join(', '))}</span>
            <span class="tl-event-count">+${e.chunks} chunks</span>
          </div>`).join('')}
      </div>
    </div>`;
}

// ===========================================================================
// Helpers
// ===========================================================================
function makeMonthBuckets(count) {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const now = new Date();
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      label: `${names[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`,
      docCount: 0,
      chunkCount: 0,
    });
  }
  return out;
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
