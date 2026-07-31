// =============================================================================
// Answer composer — extractive answers with inline citation references.
//
// Architecture (post-cohesion):
//   1. The cohesive ranked pool is guaranteed to come from 1-2 related docs.
//   2. We pool ALL sentences across all chunks in that pool and score them
//      globally, NOT 2-per-chunk. Per-chunk slicing was the source of leaked
//      noise from neighboring profiles in densely-packed chunks (e.g. a
//      leadership doc where multiple bios live in one chunk).
//   3. Stopwords are stripped from query terms BEFORE sentence scoring. Without
//      this, "the", "is", "of" cause virtually any English sentence to score
//      positive, drowning out the real signal.
//   4. There is no fallback to first-sentence-of-chunk. A sentence makes it
//      into the answer only if it contains at least one non-stopword query
//      token. Honest "I don't know" beats a fabricated sentence.
//   5. When a chunk's section_path leaf looks like a named entity (a person's
//      name, a product name), we prepend it to the sentence. This is what
//      makes "who founded X" actually answerable — the names live in section
//      headings, not in the body text.
// =============================================================================

import { tokenize, expandAgainstVocab, synonymTokens, isBoilerplateSection } from './search.js?v=5';

const MAX_TOTAL_SENTENCES = 5;
const MIN_SENTENCE_LEN = 25;

// English stopwords that pollute query-term scoring. Kept minimal — only the
// highest-frequency function words that appear in nearly every sentence. We
// don't strip "what", "how", "why" etc. because those still narrow the
// domain a little when combined with content words.
const QUERY_STOPWORDS = new Set([
  'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
  'and', 'or', 'but', 'if', 'as', 'so',
  'this', 'that', 'these', 'those',
  'it', 'its', 'do', 'does', 'did',
  'who', 'whom',
]);

function contentTerms(query) {
  return tokenize(query).filter(t => !QUERY_STOPWORDS.has(t));
}

// =============================================================================
// Sentence splitting & scoring
// =============================================================================
function splitSentences(text) {
  return text
    .replace(/\n+/g, ' ')
    .match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [];
}

function scoreSentence(sentence, queryTerms) {
  const tokens = new Set(tokenize(sentence));
  let hits = 0;
  for (const t of queryTerms) if (tokens.has(t)) hits++;
  if (hits === 0) return 0;
  // Reward sentences that match more distinct query terms (covers more of the
  // intent), with a soft length-normalization preference for mid-length.
  const tokenCount = tokens.size;
  const lenPenalty = Math.min(1, tokenCount / 18) * Math.min(1, 45 / Math.max(tokenCount, 1));
  return hits * (0.55 + 0.45 * lenPenalty);
}

// Section-path leaf heuristic: looks like a person/proper-noun name worth
// prepending to its associated sentence. Two to four capitalized words, no
// generic section vocabulary.
const GENERIC_SECTION_WORDS = /\b(section|chapter|part|overview|introduction|conclusion|appendix|abstract|service|product|company|team|leadership|executive|board|page|brief|summary|history|mission|vision|purpose|growth)\b/i;

function nameLikeLeaf(s) {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (trimmed.length < 4 || trimmed.length > 45) return null;
  if (GENERIC_SECTION_WORDS.test(trimmed)) return null;
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 4) return null;
  // Each word must start with a capital letter (allow apostrophes/periods/hyphens for names like O'Brien, Jr., Madhu-Murty)
  if (!words.every(w => /^[A-Z][A-Za-z'.\-]*$/.test(w))) return null;
  return trimmed;
}

// Dedup by content-word signature so near-duplicate sentences don't all show
function dedupKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
}

// =============================================================================
// Build answer + citation map
// =============================================================================
export function buildAnswer(query, ranked, chunks, cohesion = {}) {
  const isConfident = cohesion.isConfident !== false;

  if (ranked.length === 0) {
    return {
      answerHtml: "I couldn't find anything in the indexed corpus that matches that question. Try rephrasing, or check the suggested questions above.",
      citations: [],
      lowConfidence: true,
    };
  }

  if (!isConfident) {
    const top = chunks[ranked[0].chunkIdx];
    return {
      answerHtml:
        `I'm not finding a strong match for that question across the indexed corpus. ` +
        `The closest passage is from <strong>${top.document_name}</strong>, but the relevance signal is weak — ` +
        `it may not directly answer what you asked. Try a more specific question, or ask about a named entity from the graph.`,
      citations: [{ num: 1, chunkIdx: ranked[0].chunkIdx, chunk: top, score: ranked[0].score, confidence: 0.3 }],
      lowConfidence: true,
    };
  }

  const queryTerms = contentTerms(query);
  if (queryTerms.length === 0) {
    return {
      answerHtml: 'Please ask a more specific question — I need at least one content word to search on.',
      citations: [],
      lowConfidence: true,
    };
  }

  // Expand each query term with morphological variants present in the corpus,
  // mirroring what BM25 retrieval already did. Without this, a typo-tolerant
  // query like "...how found it" retrieves the Founding Story chunk (BM25
  // saw "found" → "founded") but scores its sentences at 0 here because the
  // literal "found" token doesn't appear. The wrong chunks would then win
  // sentence ranking. Vocabulary is sourced from the cohesion stage.
  const vocab = cohesion.bm25Index?.termId || {};
  const expandedQueryTerms = [];
  for (const t of queryTerms) {
    if (Object.keys(vocab).length > 0) {
      const variants = expandAgainstVocab(t, vocab);
      for (const v of variants) expandedQueryTerms.push(v);
      // Domain synonyms present in the corpus, so an extracted sentence that
      // uses the manual's terminology still scores against a lay-worded query.
      for (const s of synonymTokens(t, vocab)) expandedQueryTerms.push(s);
    } else {
      expandedQueryTerms.push(t);
    }
  }
  const scoringTerms = expandedQueryTerms.length > queryTerms.length ? expandedQueryTerms : queryTerms;

  // === Global sentence pool across cohesive chunks ===
  const seen = new Set();
  const candidates = [];

  for (const r of ranked) {
    const chunk = chunks[r.chunkIdx];
    // Skip boilerplate sections — URL lists, press releases, version stamps,
    // and other meta-content that's keyword-dense but not actually answer
    // material. Half the corpus chunks are in these sections.
    if (isBoilerplateSection(chunk.section_path)) continue;
    const leaf = chunk.section_path?.[chunk.section_path.length - 1];
    const namePrefix = nameLikeLeaf(leaf);
    const sentences = splitSentences(chunk.text);

    for (const raw of sentences) {
      const s = raw.trim();
      if (s.length < MIN_SENTENCE_LEN) continue;
      const sScore = scoreSentence(s, scoringTerms);
      if (sScore === 0) continue;

      const key = dedupKey(s);
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        sentence: s,
        score: sScore,
        chunkScore: r.score,
        chunkIdx: r.chunkIdx,
        chunk,
        namePrefix,
      });
    }
  }

  // Rank: sentence-match score primary, originating chunk BM25 score as tiebreaker
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.chunkScore - a.chunkScore;
  });

  // Fallback path: cohesion correctly identified the doc (filename match) but
  // the body uses synonyms or rephrasing for the query terms, so no sentence
  // strictly matches. Example: the doc title names the product but the body
  // refers to it by a synonym or abbreviation. In that case, take the first sentence of each
  // top non-boilerplate chunk — we already know the chunk is on-topic.
  if (candidates.length === 0 && cohesion.docNameMatch) {
    for (const r of ranked.slice(0, 3)) {
      const chunk = chunks[r.chunkIdx];
      if (isBoilerplateSection(chunk.section_path)) continue;
      const sentences = splitSentences(chunk.text);
      const first = sentences.find(s => s.trim().length >= MIN_SENTENCE_LEN);
      if (!first) continue;
      const trimmed = first.trim();
      const key = dedupKey(trimmed);
      if (seen.has(key)) continue;
      seen.add(key);
      const leaf = chunk.section_path?.[chunk.section_path.length - 1];
      candidates.push({
        sentence: trimmed,
        score: 0.5,
        chunkScore: r.score,
        chunkIdx: r.chunkIdx,
        chunk,
        namePrefix: nameLikeLeaf(leaf),
      });
    }
  }

  const selected = candidates.slice(0, MAX_TOTAL_SENTENCES);

  if (selected.length === 0) {
    const top = chunks[ranked[0].chunkIdx];
    return {
      answerHtml:
        `The closest match is from <strong>${top.document_name}</strong>, but no passage there directly addresses your query terms. ` +
        `Try rephrasing, or click an entity in the graph to drill in.`,
      citations: [{ num: 1, chunkIdx: ranked[0].chunkIdx, chunk: top, score: ranked[0].score, confidence: 0.3 }],
      lowConfidence: true,
    };
  }

  // Citation numbering: each unique chunk gets ONE citation number, assigned
  // in the order it's first referenced by a selected sentence.
  const citationsByChunk = new Map();
  const pieces = [];
  for (const c of selected) {
    if (!citationsByChunk.has(c.chunkIdx)) {
      const num = citationsByChunk.size + 1;
      citationsByChunk.set(c.chunkIdx, {
        num,
        chunkIdx: c.chunkIdx,
        chunk: c.chunk,
        score: c.chunkScore,
      });
    }
    const cite = citationsByChunk.get(c.chunkIdx);
    const displayText = c.namePrefix ? `${c.namePrefix} — ${c.sentence}` : c.sentence;
    pieces.push(`${displayText}<sup class="cite-ref" data-cite="${cite.num}">[${cite.num}]</sup>`);
  }

  const citations = [...citationsByChunk.values()];
  const maxScore = Math.max(...citations.map(c => c.score), 0.001);
  for (const c of citations) c.confidence = c.score / maxScore;

  return {
    answerHtml: pieces.join(' '),
    citations,
    lowConfidence: false,
    primarySource: cohesion.dominantDoc || null,
  };
}
