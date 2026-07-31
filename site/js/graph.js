// =============================================================================
// Knowledge graph — renders entities and relationships, highlights reasoning trace.
// =============================================================================

// Theme-aware color resolution (reads computed CSS variables)
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  return {
    NODE_BASE: cs.getPropertyValue('--node-base').trim() || (isLight ? '#B8C5DE' : '#4A5694'),
    NODE_RELATED: cs.getPropertyValue('--qz-blue').trim() || '#4D7CFF',
    NODE_ACTIVE: cs.getPropertyValue('--qz-pink').trim() || '#EE1C5C',
    EDGE_BASE: isLight ? 'rgba(77, 124, 255, 0.22)' : 'rgba(120, 140, 200, 0.35)',
    EDGE_ACTIVE: cs.getPropertyValue('--qz-pink').trim() || '#EE1C5C',
    LABEL: isLight ? '#4F5B7D' : '#C9D2EA',
  };
}

// =============================================================================
// Graph wrapper
// =============================================================================
export class KnowledgeGraph {
  constructor(container, index) {
    this.container = container;
    this.index = index;
    this.entitiesById = new Map(index.entities.map(e => [e.id, e]));
    this.chunksById = new Map(index.chunks.map(c => [c.id, c]));
    this.relationships = index.relationships;

    this.nodes = null;
    this.edges = null;
    this.network = null;
    this.onEntityClick = null;
  }

  render() {
    const C = themeColors();
    const nodes = this.index.entities.map(e => ({
      id: e.id,
      label: e.name,
      title: `${e.name} · ${e.mention_count} mentions`,
      value: e.mention_count,
      color: { background: C.NODE_BASE, border: C.NODE_BASE, highlight: { background: C.NODE_ACTIVE, border: C.NODE_ACTIVE } },
      font: { color: C.LABEL, size: 12, face: 'Inter' },
      borderWidth: 0,
      shape: 'dot',
    }));

    const edges = this.relationships.map((r, i) => ({
      id: i,
      from: r.source,
      to: r.target,
      value: r.weight,
      color: { color: C.EDGE_BASE, highlight: C.EDGE_ACTIVE, opacity: 0.5 },
      smooth: { type: 'continuous', roundness: 0.2 },
    }));

    this.nodes = new vis.DataSet(nodes);
    this.edges = new vis.DataSet(edges);

    const data = { nodes: this.nodes, edges: this.edges };

    const options = {
      autoResize: true,
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -42,
          centralGravity: 0.008,
          springLength: 130,
          springConstant: 0.06,
          damping: 0.55,
          avoidOverlap: 0.7,
        },
        stabilization: { iterations: 220, updateInterval: 25 },
        minVelocity: 0.15,
      },
      interaction: {
        hover: true,
        tooltipDelay: 180,
        dragNodes: true,
        zoomView: true,
      },
      nodes: {
        scaling: { min: 8, max: 30, label: { enabled: true, min: 11, max: 16 } },
        shadow: { enabled: true, color: 'rgba(238, 28, 92, 0.22)', size: 10, x: 0, y: 0 },
      },
      edges: {
        width: 0.5,
        scaling: { min: 0.4, max: 3 },
        smooth: { type: 'continuous', roundness: 0.18 },
      },
    };

    this.network = new vis.Network(this.container, data, options);

    this.network.on('click', params => {
      if (params.nodes.length > 0 && this.onEntityClick) {
        this.onEntityClick(params.nodes[0]);
      }
    });

    // Auto-fit after stabilization
    this.network.once('stabilizationIterationsDone', () => {
      this.network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
    });

    // Re-color nodes + edges when theme toggles
    this._lastTrace = null;
    this._themeObserver = new MutationObserver(() => this._recolor());
    this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // Re-apply theme-aware colors. If a trace is active, re-run it; otherwise reset.
  _recolor() {
    if (this._lastTrace && this._lastTrace.length > 0) {
      this.highlightTrace(this._lastTrace);
    } else {
      this.resetHighlight();
    }
  }

  // ===========================================================================
  // Reasoning trace: highlight entities that appear in the retrieved chunks,
  // plus their direct neighbors, and the edges connecting them.
  // ===========================================================================
  highlightTrace(retrievedChunkIds) {
    this._lastTrace = [...retrievedChunkIds];
    const activeEntityIds = new Set();
    for (const cid of retrievedChunkIds) {
      const chunk = this.chunksById.get(cid);
      if (!chunk) continue;
      for (const eid of chunk.entities || []) activeEntityIds.add(eid);
    }

    const neighborIds = new Set();
    const activeEdgeIds = new Set();
    for (let i = 0; i < this.relationships.length; i++) {
      const r = this.relationships[i];
      const srcActive = activeEntityIds.has(r.source);
      const tgtActive = activeEntityIds.has(r.target);
      if (srcActive && tgtActive) {
        activeEdgeIds.add(i);
      } else if (srcActive) {
        neighborIds.add(r.target);
        activeEdgeIds.add(i);
      } else if (tgtActive) {
        neighborIds.add(r.source);
        activeEdgeIds.add(i);
      }
    }

    const C = themeColors();
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const activeLabel = isLight ? '#FFFFFF' : '#FFE9F0';
    const relatedLabel = isLight ? '#FFFFFF' : '#E6EEFF';
    const baseLabel = isLight ? '#8893B5' : '#6E78A0';

    const nodeUpdates = [];
    for (const entity of this.index.entities) {
      let color, fontColor, borderWidth, size, opacity;
      if (activeEntityIds.has(entity.id)) {
        // Activated — full bright pink, slightly bigger
        color = C.NODE_ACTIVE;
        fontColor = activeLabel;
        borderWidth = 3;
        size = 28;
        opacity = 1.0;
      } else if (neighborIds.has(entity.id)) {
        // Neighbor — bright blue, normal size
        color = C.NODE_RELATED;
        fontColor = relatedLabel;
        borderWidth = 1;
        size = 18;
        opacity = 0.95;
      } else {
        // Unrelated — fade hard. This is the "BOOM, everything unrelated
        // disappears" effect. Without aggressive fade, the activation is
        // too subtle for a director sitting 4 feet from the screen.
        color = C.NODE_BASE;
        fontColor = baseLabel;
        borderWidth = 0;
        size = 6;
        opacity = 0.12;
      }
      nodeUpdates.push({
        id: entity.id,
        color: { background: color, border: color, opacity },
        font: { color: fontColor, size: 12, face: 'Inter' },
        borderWidth,
        size,
        opacity,
      });
    }
    this.nodes.update(nodeUpdates);

    const edgeUpdates = this.relationships.map((r, i) => ({
      id: i,
      color: activeEdgeIds.has(i)
        ? { color: C.EDGE_ACTIVE, opacity: 0.9 }
        : { color: C.EDGE_BASE, opacity: 0.04 },   // was 0.15 — make unrelated nearly invisible
      width: activeEdgeIds.has(i) ? Math.max(1.2, Math.log(r.weight + 1) * 1.1) : 0.2,
    }));
    this.edges.update(edgeUpdates);

    if (activeEntityIds.size > 0) {
      this.network.fit({
        nodes: [...activeEntityIds, ...neighborIds],
        animation: { duration: 600, easingFunction: 'easeInOutQuad' },
      });
      // Trigger the BOOM CSS flash (radial pink pulse from center) — gives
      // a visceral "activated" feel even before the user notices the fade.
      const canvas = this.container;
      if (canvas) {
        canvas.classList.remove('graph-activated');
        // Force reflow so re-adding the class re-runs the animation
        void canvas.offsetWidth;
        canvas.classList.add('graph-activated');
        setTimeout(() => canvas.classList.remove('graph-activated'), 1700);
      }
    }

    return {
      activeEntities: [...activeEntityIds].map(id => this.entitiesById.get(id)).filter(Boolean),
      neighborCount: neighborIds.size,
      edgeCount: activeEdgeIds.size,
    };
  }

  resetHighlight() {
    this._lastTrace = null;
    const C = themeColors();
    const nodeUpdates = this.index.entities.map(e => ({
      id: e.id,
      color: { background: C.NODE_BASE, border: C.NODE_BASE, opacity: 1.0 },
      font: { color: C.LABEL, size: 12, face: 'Inter' },
      borderWidth: 0,
      size: 14,
      opacity: 1.0,
    }));
    this.nodes.update(nodeUpdates);

    const edgeUpdates = this.relationships.map((r, i) => ({
      id: i,
      color: { color: C.EDGE_BASE, opacity: 0.5 },
      width: 0.5,
    }));
    this.edges.update(edgeUpdates);
  }

  focusEntity(entityId) {
    this.network.selectNodes([entityId]);
    this.network.focus(entityId, {
      scale: 1.2,
      animation: { duration: 400, easingFunction: 'easeInOutQuad' },
    });
  }
}
