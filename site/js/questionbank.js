// =============================================================================
// Curated question bank + fuzzy matcher.
//
// Strategy: keep a large set of vetted questions (each verified to return a
// strong, fully-cited answer). When a user asks something, we first find the
// most similar bank question. If the match is strong enough, we answer using
// that canonical question's phrasing — which we know retrieves well — instead
// of the user's raw wording. If nothing matches, the caller falls back to a
// plain live search on the corpus.
//
// Everything still runs through the real ask() pipeline afterwards, so
// citations, the knowledge graph, and lineage stay in sync — the bank only
// *canonicalizes the query*, it never ships a canned answer.
// =============================================================================

import { tokenize, synonymTokens } from './search.js?v=5';

// Vetted questions — each was confirmed to return a confident, cited answer
// against the indexed manuals (StatStrip Glucose, Lactate, StatSensor
// Creatinine, Lactate Plus). Grow this list freely; only the matcher and the
// demo chips read it.
export const QUESTION_BANK = [
  // --- Glucose (StatStrip Glucose / Xpress 2) ---
  'What is the intended use of the StatStrip Glucose meter?',
  'What is the measuring range for glucose?',
  'What is the reportable range for the glucose test?',
  'What sample volume does the glucose test need?',
  'Can the glucose meter be used on neonates?',
  'What sample types can be used for glucose testing?',
  'What substances interfere with glucose results?',
  'Does hematocrit affect glucose readings?',
  'Does acetaminophen affect glucose results?',
  'Does maltose interfere with the glucose test?',
  'Does oxygen affect the glucose measurement?',
  'How do I perform quality control on the glucose meter?',
  'What are the glucose control solution ranges?',
  'How is the StatStrip glucose meter calibrated?',
  'What error messages appear on the glucose meter?',
  'What are the storage conditions for glucose test strips?',
  'What is the operating temperature for the glucose meter?',
  'How accurate is the StatStrip glucose meter?',
  'What are the warnings for glucose testing?',
  'What are the limitations of the glucose test?',
  'How do I run a glucose test?',
  'What units does the glucose meter report in?',
  'Can the glucose meter be used at the point of care?',
  'What is the clinical use of glucose monitoring?',
  'Is the glucose meter approved for critically ill patients?',
  // --- Lactate (StatStrip Lactate / Lactate Plus Xpress2) ---
  'What is the intended use of the StatStrip Lactate meter?',
  'What is the measuring range for lactate?',
  'What sample volume does the lactate test require?',
  'What substances interfere with lactate results?',
  'How do I run quality control for lactate?',
  'What is the clinical significance of measuring lactate?',
  'What sample types are used for lactate testing?',
  'How accurate is the lactate meter?',
  'What are the operating temperature and humidity limits?',
  'What error codes appear on the lactate meter?',
  'How do I clean and disinfect the lactate meter?',
  // --- Creatinine (StatSensor Creatinine) ---
  'What is the intended use of the StatSensor Creatinine analyzer?',
  'What is the reportable range for creatinine?',
  'How does hematocrit affect creatinine measurement?',
  'What sample volume does the creatinine test need?',
  'How do I perform a quality control test on the StatSensor Creatinine meter?',
  'What substances interfere with creatinine results?',
  'How is eGFR calculated on the StatSensor?',
  'What are the creatinine control solution levels?',
  // --- General / device ---
  'How do I store the test strips?',
  'How do I clean the meter?',
  'How do I dispose of used test strips?',
  'What are the general warnings and precautions?',
  'How long does a test take?',
  'What does the meter need for calibration?',
  'What is the expiration of the test strips?',
];

// Minimal stopword set for similarity — mirrors the retrieval stopwords so the
// match keys on topical content, not question scaffolding.
const STOP = new Set([
  'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'into', 'onto',
  'and', 'or', 'but', 'if', 'as', 'so', 'than', 'then',
  'this', 'that', 'these', 'those', 'there', 'here',
  'it', 'its', 'do', 'does', 'did', 'done', 'can', 'could', 'would', 'should',
  'who', 'whom', 'what', 'when', 'where', 'why', 'how', 'which', 'whose',
  'i', 'me', 'my', 'you', 'your', 'we', 'our', 'they', 'their',
  'about', 'need', 'needs', 'needed', 'use', 'used', 'using', 'get', 'got',
  'much', 'many', 'any', 'some', 'will', 'shall', 'may', 'might', 'must', 'have', 'has', 'had',
]);

// Light two-phase stemmer (plural, then verb) so singular/plural and simple
// verb forms collide during matching (neonate/neonates, reading/readings,
// strip/strips) without mangling non-plurals (glucose stays glucose).
function stem(t) {
  if (t.length <= 3) return t;
  // plural → singular
  if (t.endsWith('ies') && t.length > 4) t = t.slice(0, -3) + 'y';
  else if (/(ches|shes|xes|zes|sses)$/.test(t)) t = t.slice(0, -2);
  else if (t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  // verb inflection
  if (t.endsWith('ing') && t.length > 5) t = t.slice(0, -3);
  else if (t.endsWith('ed') && t.length > 4) t = t.slice(0, -2);
  return t;
}

// Expand a phrase into a corpus-oriented content-token set: drop stopwords,
// add domain-synonym expansions so "blood" and "sample" collide, and stem so
// plural/verb variants line up.
function contentSet(text, vocab) {
  const toks = tokenize(text).filter(t => !STOP.has(t));
  const set = new Set();
  for (const t of toks) {
    set.add(stem(t));
    if (vocab) for (const s of synonymTokens(t, vocab)) set.add(stem(s));
  }
  return set;
}

// Cosine-style set similarity in [0, 1].
function setSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.sqrt(a.size * b.size);
}

// Precompute bank token sets lazily (needs the vocab, available after boot).
let _bankSets = null;
let _bankVocab = null;
function ensureBankSets(vocab) {
  if (_bankSets && _bankVocab === vocab) return;
  _bankVocab = vocab;
  _bankSets = QUESTION_BANK.map(q => contentSet(q, vocab));
}

// Find the closest bank question to `query`. Returns { question, score, index }
// or null. `score` is a 0..1 similarity; the caller decides the threshold.
export function matchQuestionBank(query, opts = {}) {
  const vocab = opts.vocab || null;
  ensureBankSets(vocab);
  const qSet = contentSet(query, vocab);
  if (qSet.size === 0) return null;
  let best = -1, bestScore = 0;
  for (let i = 0; i < _bankSets.length; i++) {
    const s = setSimilarity(qSet, _bankSets[i]);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  if (best < 0) return null;
  return { question: QUESTION_BANK[best], score: bestScore, index: best };
}
