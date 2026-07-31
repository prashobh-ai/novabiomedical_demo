"""Pre-build a BM25 index that the browser can query without any server."""
from __future__ import annotations

import math
from collections import Counter

from .chunker import Chunk, tokenize

K1 = 1.5
B = 0.75


def build_bm25_index(chunks: list[Chunk]) -> dict:
    """
    Returns a JSON-serializable index containing:
      - vocab: list of unique terms
      - term_id: {term -> int}
      - idf: list[float] aligned with vocab
      - doc_len: list[int] aligned with chunks
      - avgdl: float
      - postings: {term_id -> [[chunk_idx, tf], ...]}
      - k1, b: BM25 hyperparameters
    """
    N = len(chunks)
    if N == 0:
        return {"vocab": [], "idf": [], "doc_len": [], "avgdl": 0, "postings": {}, "k1": K1, "b": B}

    # Document frequency per term
    df: Counter = Counter()
    doc_terms: list[Counter] = []
    for chunk in chunks:
        tf = Counter(chunk.tokens)
        doc_terms.append(tf)
        for term in tf:
            df[term] += 1

    vocab = sorted(df.keys())
    term_id = {t: i for i, t in enumerate(vocab)}

    # BM25 IDF (Lucene variant — never negative for common terms)
    idf = [math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5)) for t in vocab]

    # Postings: term_id -> [(chunk_idx, tf)]
    postings: dict[int, list[list[int]]] = {i: [] for i in range(len(vocab))}
    for chunk_idx, tf in enumerate(doc_terms):
        for term, count in tf.items():
            postings[term_id[term]].append([chunk_idx, count])

    doc_len = [len(c.tokens) for c in chunks]
    avgdl = sum(doc_len) / N if N else 0

    return {
        "vocab": vocab,
        "term_id": term_id,
        "idf": idf,
        "doc_len": doc_len,
        "avgdl": avgdl,
        "postings": postings,
        "k1": K1,
        "b": B,
    }
