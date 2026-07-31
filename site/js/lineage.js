// ============================================================================
// Source Lineage — vertical tree showing how an answer traces back to paragraphs
// ============================================================================

let _onChunkClick = null;

export function initLineage(callbacks = {}) {
  _onChunkClick = callbacks.onChunkClick || (() => {});
}

export function renderLineage(question, answerText, citations) {
  const body = document.getElementById('lineage-body');

  if (!citations || citations.length === 0) {
    body.innerHTML = `
      <div class="lineage-empty">
        <p>No sources retrieved for this question.</p>
      </div>`;
    return;
  }

  // Group citations by document → page → section
  const byDoc = new Map();
  for (const c of citations) {
    const docKey = c.chunk.document_name;
    if (!byDoc.has(docKey)) byDoc.set(docKey, []);
    byDoc.get(docKey).push(c);
  }

  const plainAnswer = answerText.replace(/<[^>]+>/g, '').trim();
  const truncatedAnswer = plainAnswer.length > 240 ? plainAnswer.slice(0, 240) + '…' : plainAnswer;

  const html = `
    <div class="lineage-root">
      <div class="lineage-answer">
        <div class="lineage-eyebrow">Answer</div>
        <div class="lineage-answer-text">${escapeHtml(truncatedAnswer)}</div>
      </div>

      <div class="lineage-tree">
        ${[...byDoc.entries()].map(([docName, cites]) => `
          <div class="lineage-doc">
            <div class="lineage-doc-head">
              <span class="lineage-doc-name">${escapeHtml(stripExt(docName))}</span>
              <span class="lineage-doc-stat">${cites.length} citation${cites.length === 1 ? '' : 's'}</span>
            </div>
            ${cites.map(c => renderPage(c)).join('')}
          </div>
        `).join('')}
      </div>
    </div>`;

  body.innerHTML = html;

  body.querySelectorAll('[data-cid]').forEach(el => {
    el.addEventListener('click', () => {
      _onChunkClick(parseInt(el.dataset.cid, 10));
    });
  });

  document.getElementById('lineage-status').textContent =
    `${byDoc.size} document${byDoc.size === 1 ? '' : 's'} · ${citations.length} citation${citations.length === 1 ? '' : 's'} · click any paragraph to inspect`;
}

function renderPage(citation) {
  const c = citation.chunk;
  const sectionPath = c.section_path?.length ? c.section_path.join(' › ') : '(no section)';
  return `
    <div class="lineage-page">
      <div class="lineage-page-info">[${citation.num}] page ${c.page} · ¶${c.paragraph_indices.join(', ¶')}</div>
      <div class="lineage-section">${escapeHtml(sectionPath)}</div>
      <div class="lineage-paragraph" data-cid="${c.id}">
        <div class="lineage-para-num">excerpt</div>
        <div class="lineage-para-text">${escapeHtml(c.paragraph_excerpt || c.text.slice(0, 200))}</div>
      </div>
    </div>`;
}

// Helpers
function stripExt(name) {
  return name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
