// =============================================================================
// BM25 client — queries the precomputed index in-memory.
// =============================================================================

const TOKEN_RE = /[A-Za-z0-9]+/g;

export function tokenize(text) {
  const out = [];
  const matches = text.toLowerCase().matchAll(TOKEN_RE);
  for (const m of matches) {
    if (m[0].length > 1) out.push(m[0]);
  }
  return out;
}

// Boilerplate sections — keyword-dense URL/metadata content that's not
// answer material. Filtering at retrieval time prevents documents from
// winning cohesion via their footer/citations alone (e.g. a product's blog
// post titles outranking the actual founding-story doc for a founding query).
// Centralized here so both cohesion and answer composer use the same rule.
const BOILERPLATE_SECTION_RE = /\b(evidence|references|channels|sources|press\s*releases?|recognitions?|insights\s*&?\s*blogs?|blogs?|whitepapers?|reports?|videos?|youtube|linkedin|twitter|official\s+\S+\s+pages?|version|tone)\b/i;

export function isBoilerplateSection(section_path) {
  if (!section_path || section_path.length === 0) return false;
  for (const s of section_path) {
    if (BOILERPLATE_SECTION_RE.test(s)) return true;
  }
  return false;
}

// Tokens extracted from a document filename — used as a corroborating signal
// during cohesion clustering. `03_Product_ValidAIte.docx` → ['product', 'validaite'].
// Numbers, separators, extension stripped.
export function docNameTokens(name) {
  if (!name) return [];
  return [...new Set(
    name.toLowerCase()
      .replace(/\.[a-z]+$/, '')
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 1 && !/^\d+$/.test(t))
  )];
}

// Light morphological expansion. Without this, BM25 misses common variants:
// "started" never matches "started" in the corpus (token absent) but the
// corpus has "starts", "starting". Same for "found" vs "founded".
// We walk the vocabulary once per query term and grab terms that share a
// stem prefix. Limited to 6 variants to keep precision tight.
export function expandAgainstVocab(term, vocab, maxVariants = 6) {
  if (term.length < 4) return [term];
  let stem = term;
  if      (term.endsWith('ies') && term.length > 5) stem = term.slice(0, -3);
  else if (term.endsWith('ing') && term.length > 5) stem = term.slice(0, -3);
  else if (term.endsWith('ed')  && term.length > 4) stem = term.slice(0, -2);
  else if (term.endsWith('er')  && term.length > 4) stem = term.slice(0, -2);
  else if (term.endsWith('es')  && term.length > 4) stem = term.slice(0, -2);
  else if (term.endsWith('s')   && term.length > 3 && !term.endsWith('ss')) stem = term.slice(0, -1);

  const prefix = stem.length >= 4 ? stem : term;
  const variants = new Set([term]);
  for (const vocabTerm of Object.keys(vocab)) {
    if (variants.size >= maxVariants) break;
    if (vocabTerm.length < prefix.length || vocabTerm.length > prefix.length + 5) continue;
    if (vocabTerm.startsWith(prefix)) variants.add(vocabTerm);
  }
  return [...variants];
}

// =============================================================================
// Ranker
// =============================================================================
export class BM25 {
  constructor(bm25Index) {
    this.termId = bm25Index.term_id;
    this.idf = bm25Index.idf;
    this.docLen = bm25Index.doc_len;
    this.avgdl = bm25Index.avgdl;
    this.postings = bm25Index.postings;
    this.k1 = bm25Index.k1;
    this.b = bm25Index.b;
    this.N = bm25Index.doc_len.length;
  }

  search(query, topK = 6) {
    const terms = tokenize(query);
    if (terms.length === 0 || this.N === 0) return [];

    const scores = new Float32Array(this.N);
    const seen = new Set();

    for (const term of terms) {
      const variants = expandAgainstVocab(term, this.termId);
      for (const variant of variants) {
        const tid = this.termId[variant];
        if (tid === undefined) continue;
        // Original term gets full IDF; variants get a damped weight so we
        // don't double-count "founded" + "founder" + "founding" as 3x signal.
        const weight = variant === term ? 1.0 : 0.55;
        const idf = this.idf[tid] * weight;
        const posting = this.postings[tid] || [];
        for (const [chunkIdx, tf] of posting) {
          const dl = this.docLen[chunkIdx];
          const norm = 1 - this.b + this.b * (dl / this.avgdl);
          const score = idf * (tf * (this.k1 + 1)) / (tf + this.k1 * norm);
          scores[chunkIdx] += score;
          seen.add(chunkIdx);
        }
      }
    }

    const ranked = [];
    for (const idx of seen) {
      if (scores[idx] > 0) ranked.push({ chunkIdx: idx, score: scores[idx] });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, topK);
  }
}

// =============================================================================
// Document-cohesion clustering with filename-as-topic signal.
//
// Cohesion uses TWO signals:
//   (a) Aggregate BM25 score per source document
//   (b) Document-filename match: how many query content-terms appear in the
//       document's filename tokens. For a templated corpus (one doc per
//       product, service, etc.), the filename is the strongest topical signal
//       available and pure BM25 body-match can lose to keyword-dense
//       neighbors — e.g. "What is ValidAIte?" pure-BM25-wins by service brief
//       that mentions ValidAIte 7 times, even though the actual product doc
//       has 9 mentions in a shorter chunk count.
//
// confidence = high if either distinctness is strong OR the dominant doc's
// filename matches the query. Filename matching gives us a corpus-size-
// invariant floor that distinctness alone (which weakens with larger corpora)
// can't provide.
// =============================================================================
// Stopwords that should NOT count toward the rare-term confidence check, even
// when they're statistically rare. "where", "how", "when" can have high IDF
// in templated corpora simply because the body text rarely uses these words —
// but they're question words, not topic words. Without this filter, a query
// like "Where is X located?" misleadingly passes the rare-term gate via
// "where" alone, even though the corpus contains no location data.
const CONTENT_STOPWORDS = new Set([
  'the','is','are','was','were','be','been','being','am',
  'a','an','of','in','on','at','to','for','with','by','from','into','onto',
  'and','or','but','if','as','so','than','then',
  'this','that','these','those','there','here',
  'it','its','do','does','did','done',
  'who','whom','what','when','where','why','how','which','whose',
  'tell','me','my','your','our','their','his','her',
  'about','can','could','would','should','may','might','must','shall','will',
  'have','has','had','having',
]);

export function cohereByDocument(rawRanked, chunks, opts = {}) {
  const maxChunks = opts.maxChunks ?? 8;
  const dominanceThreshold = opts.dominanceThreshold ?? 1.5;
  const minConfidentRatio = opts.minConfidentRatio ?? 1.5;
  const queryTerms = opts.queryTerms || [];
  const docNameBoost = opts.docNameBoost ?? 4.0;
  const bm25Index = opts.bm25Index || null;
  const rareTermDocFraction = opts.rareTermDocFraction ?? 0.35;

  if (rawRanked.length === 0) {
    return { ranked: [], confidence: 0, docIds: [], dominantDoc: null, isConfident: false, docNameMatch: false };
  }

  // Suppress boilerplate chunks BEFORE computing per-document aggregates.
  // A doc with 10 URL/blog-title chunks shouldn't outrank a doc with 2
  // substantive body chunks — but with raw BM25 it does, and that's what
  // routes "When was X founded?" to the QMentisAI Insights & Blogs section
  // (which mentions "founders" in blog titles) instead of the actual
  // Founding Story chunk in Company History.
  // Fall back to unfiltered ranking only if everything is boilerplate —
  // in that case the answer composer will hit its low-confidence path
  // honestly.
  const nonBoiler = rawRanked.filter(r => !isBoilerplateSection(chunks[r.chunkIdx].section_path));
  const workingRanked = nonBoiler.length >= 2 ? nonBoiler : rawRanked;

  const docScores = new Map();
  const docNameMatches = new Map();
  const docNameCache = new Map();
  for (const r of workingRanked) {
    const chunk = chunks[r.chunkIdx];
    const docId = chunk.document_id;
    docScores.set(docId, (docScores.get(docId) || 0) + r.score);
    if (!docNameMatches.has(docId)) {
      let tokens = docNameCache.get(chunk.document_name);
      if (!tokens) {
        tokens = new Set(docNameTokens(chunk.document_name));
        docNameCache.set(chunk.document_name, tokens);
      }
      let hits = 0;
      for (const qt of queryTerms) {
        if (CONTENT_STOPWORDS.has(qt)) continue;
        if (tokens.has(qt)) hits++;
      }
      docNameMatches.set(docId, hits);
    }
  }

  for (const [docId, score] of docScores) {
    const hits = docNameMatches.get(docId) || 0;
    if (hits > 0) docScores.set(docId, score + docNameBoost * hits);
  }

  // Sort docs by boosted aggregate. Filename hits dominate when present
  // because cluster size doesn't beat explicit topic naming.
  const sortedDocs = [...docScores.entries()].sort((a, b) => {
    const ha = docNameMatches.get(a[0]) || 0;
    const hb = docNameMatches.get(b[0]) || 0;
    if (hb !== ha) return hb - ha;
    return b[1] - a[1];
  });
  const topDocId = sortedDocs[0][0];
  const secondDocId = sortedDocs[1]?.[0];
  const topNameHits = docNameMatches.get(topDocId) || 0;
  const secondNameHits = docNameMatches.get(secondDocId) || 0;
  const topDocAgg = sortedDocs[0][1];
  const secondDocAgg = sortedDocs[1]?.[1] || 0;

  // Keep-set policy:
  //   - Top doc has strictly MORE filename hits than runner-up → hard-prefer
  //     top alone. "mobile testing services" picks 18_Mobile (2 hits) over
  //     10_Functional (1 hit), not both.
  //   - Equal nonzero filename hits → keep both for context blending.
  //   - No filename signal anywhere → fall back to BM25 dominance ratio.
  let keepDocIds;
  if (topNameHits > secondNameHits) {
    keepDocIds = new Set([topDocId]);
  } else if (topNameHits > 0) {
    keepDocIds = new Set([topDocId, secondDocId]);
  } else {
    const dominates = secondDocAgg === 0 || topDocAgg / secondDocAgg >= dominanceThreshold;
    keepDocIds = new Set(dominates ? [topDocId] : [topDocId, secondDocId]);
  }

  const filtered = workingRanked
    .filter(r => keepDocIds.has(chunks[r.chunkIdx].document_id))
    .slice(0, maxChunks);

  // Report dominantDoc as the highest-aggregate-score document, not just the
  // doc of the single highest-scoring chunk. That distinction matters when
  // two docs are kept and the runner-up's best chunk outscores the leader's
  // best chunk individually.
  const topDocChunk = workingRanked.find(r => chunks[r.chunkIdx].document_id === topDocId);
  const dominantDoc = topDocChunk ? chunks[topDocChunk.chunkIdx].document_name : null;

  // Confidence rule with stopword-aware rare-term gate
  const topScore = filtered[0]?.score || 0;
  const tailIdx = Math.min(workingRanked.length - 1, 9);
  const tailScore = workingRanked[tailIdx]?.score || 0.0001;
  const distinctness = topScore / tailScore;
  const docNameMatch = topNameHits > 0;

  let hasRareTerm = false;
  if (bm25Index && queryTerms.length > 0) {
    const totalDocs = bm25Index.docLen.length;
    const threshold = totalDocs * rareTermDocFraction;
    outer: for (const qt of queryTerms) {
      if (CONTENT_STOPWORDS.has(qt)) continue;
      const tid = bm25Index.termId[qt];
      if (tid !== undefined) {
        // Term is in vocab — judge it on its own literal df. Do NOT consider
        // its morphological variants. Otherwise common terms like "qualizeal"
        // (df=305, not rare) would incorrectly pass the rare check via their
        // junk plurals ("qualizeals" df=2) and confidently answer queries
        // about topics the corpus doesn't actually cover.
        const df = (bm25Index.postings[tid] || []).length;
        if (df > 0 && df < threshold) { hasRareTerm = true; break outer; }
      } else {
        // Term is NOT in vocab — try morphological variants. This handles
        // typo-tolerant queries: "started" → "starts"/"starting"/"startup",
        // "found" → "founded"/"founder"/"founding". If any rare variant
        // exists, the query has distinguishing signal.
        const variants = expandAgainstVocab(qt, bm25Index.termId);
        for (const v of variants) {
          if (v === qt) continue;
          const vtid = bm25Index.termId[v];
          if (vtid === undefined) continue;
          const df = (bm25Index.postings[vtid] || []).length;
          if (df > 0 && df < threshold) { hasRareTerm = true; break outer; }
        }
      }
    }
  } else {
    hasRareTerm = true;
  }

  const isConfident = docNameMatch || (hasRareTerm && distinctness >= minConfidentRatio);
  const confidence = Math.min(1, Math.max(distinctness / 4, docNameMatch ? 0.75 : 0));

  return {
    ranked: filtered,
    confidence,
    distinctness,
    isConfident,
    docNameMatch,
    hasRareTerm,
    docIds: [...keepDocIds],
    dominantDoc,
    totalDocsConsidered: sortedDocs.length,
    bm25Index, // for downstream morphological expansion in answer.js
  };
}
