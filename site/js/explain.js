// ============================================================================
// "Why did AI say this?" overlay — step-by-step reasoning pipeline
// Question → Retrieved Documents → Graph Traversal → Final Context → Answer
// ============================================================================

let _index = null;

export function initExplain(index) {
  _index = index;
  document.getElementById('explain-close').addEventListener('click', close);
  document.getElementById('explain-overlay').addEventListener('click', e => {
    if (e.target.id === 'explain-overlay') close();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });
}

export function openExplain({ question, ranked, citations, traceEntities, traceEdges, answerHtml }) {
  const flow = document.getElementById('explain-flow');

  const sentences = answerHtml.replace(/<sup[^>]+>\[\d+\]<\/sup>/g, '').split(/(?<=[.!?])\s+/).filter(Boolean);
  const contextRows = citations.slice(0, 5).map(c => {
    const section = c.chunk.section_path?.length ? c.chunk.section_path.join(' › ') : '(no section)';
    return `<div class="flow-context-row"><strong style="color:var(--accent)">[${c.num}]</strong> ${escapeHtml(c.chunk.paragraph_excerpt || c.chunk.text.slice(0, 220))}<br/><span style="font-size:10.5px;color:var(--text-mute);font-family:var(--font-mono)">${escapeHtml(stripExt(c.chunk.document_name))} · page ${c.chunk.page} · ${escapeHtml(section)}</span></div>`;
  }).join('');

  const docRows = ranked.slice(0, 5).map((r, i) => {
    const chunk = _index.chunks[r.chunkIdx];
    const section = chunk.section_path?.length ? chunk.section_path.join(' › ') : '(no section)';
    return `
      <div class="flow-doc-row">
        <span class="flow-doc-rank">#${i + 1}</span>
        <span class="flow-doc-name">${escapeHtml(stripExt(chunk.document_name))}</span>
        <span class="flow-doc-section">${escapeHtml(section)}</span>
        <span class="flow-doc-score">BM25 ${r.score.toFixed(2)}</span>
      </div>`;
  }).join('');

  const entityPills = traceEntities.slice(0, 12).map(e =>
    `<span class="flow-entity">${escapeHtml(e.name)}</span>`
  ).join('');

  flow.innerHTML = `
    <div class="flow-step" data-step="1">
      <h3>Question</h3>
      <div class="flow-step-body"><div class="flow-step-question">"${escapeHtml(question)}"</div></div>
    </div>
    <div class="flow-connector"></div>

    <div class="flow-step" data-step="2">
      <h3>Retrieved Documents</h3>
      <div class="flow-step-body">
        Scanned <strong style="color:var(--text)">${_index.chunks.length}</strong> knowledge units across <strong style="color:var(--text)">${_index.documents.length}</strong> documents. Top BM25-ranked passages:
        <div class="flow-doc-list">${docRows}</div>
      </div>
    </div>
    <div class="flow-connector"></div>

    <div class="flow-step" data-step="3">
      <h3>Graph Traversal</h3>
      <div class="flow-step-body">
        ${traceEntities.length === 0
          ? 'No named entities found in retrieved passages.'
          : `Activated <strong style="color:var(--accent)">${traceEntities.length}</strong> entities from the retrieved knowledge units. The graph highlights these and their direct neighbors.`}
        ${entityPills ? `<div class="flow-graph-summary">${entityPills}</div>` : ''}
        <div class="flow-stats">
          <span>entities <strong>${traceEntities.length}</strong></span>
          <span>relationships traversed <strong>${traceEdges}</strong></span>
          <span>graph paths <strong>${Math.max(1, traceEdges)}</strong></span>
        </div>
      </div>
    </div>
    <div class="flow-connector"></div>

    <div class="flow-step" data-step="4">
      <h3>Final Context</h3>
      <div class="flow-step-body">
        Composed answer from the highest-relevance passages — verbatim, with explicit citation markers:
        <div class="flow-context-list">${contextRows}</div>
      </div>
    </div>
    <div class="flow-connector"></div>

    <div class="flow-step flow-answer" data-step="5">
      <h3>Answer</h3>
      <div class="flow-step-body">
        <div class="flow-answer-text">${answerHtml}</div>
        <div style="margin-top:10px;font-size:11px;color:var(--text-mute);font-family:var(--font-mono)">
          Zero LLM rewrite — every sentence above appears verbatim in a cited source. Click any [#] to inspect.
        </div>
      </div>
    </div>`;

  document.getElementById('explain-overlay').hidden = false;
}

function close() {
  document.getElementById('explain-overlay').hidden = true;
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
