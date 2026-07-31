"""Entity extraction — regex-based, no model downloads (Phase 1 = simple & portable)."""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

from .chunker import Chunk


# =============================================================================
# Entity patterns
# =============================================================================
STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to", "for",
    "with", "from", "by", "is", "are", "was", "were", "be", "been", "being",
    "has", "have", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "can", "this", "that", "these", "those",
    "it", "its", "they", "them", "their", "we", "our", "you", "your",
    "about", "as", "if", "into", "through", "during", "before", "after",
    "above", "below", "between", "under", "over", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "any",
    "both", "each", "few", "more", "most", "other", "some", "such", "no",
    "nor", "not", "only", "own", "same", "so", "than", "too", "very",
    "just", "also", "however", "therefore", "thus", "hence", "page", "section",
    "chapter", "figure", "table",
}

# Proper noun sequences (e.g., "Knowledge Fabric", "Microsoft Agent Framework")
PROPER_NOUN_RE = re.compile(
    r"\b([A-Z][a-zA-Z0-9]+(?:[\s-][A-Z][a-zA-Z0-9]+){0,4})\b"
)
# Acronyms (3-6 caps)
ACRONYM_RE = re.compile(r"\b([A-Z]{2,6})\b")


@dataclass
class EntityMention:
    name: str
    canonical: str
    chunk_id: int
    document_id: int
    kind: str


# Generic words that look like entities but rarely carry meaning standalone
WEAK_GENERICS = {
    "phase", "section", "chapter", "figure", "table", "appendix", "introduction",
    "overview", "summary", "conclusion", "background", "details", "page",
    "week", "day", "month", "year", "team", "group", "system", "platform",
    "data", "content", "result", "results", "step", "steps", "part",
}

LEADING_ARTICLES = {
    "the", "a", "an",
    # Common sentence-starter words that aren't part of a real entity name
    "for", "every", "each", "some", "most", "any", "all", "this", "that",
    "these", "those", "when", "if", "since", "while", "although",
    "however", "therefore", "thus",
}


def _canonicalize(name: str) -> str:
    """Lowercase, collapse whitespace, strip leading articles ('the knowledge fabric' → 'knowledge fabric')."""
    canon = re.sub(r"\s+", " ", name.strip()).lower()
    parts = canon.split(" ", 1)
    if len(parts) > 1 and parts[0] in LEADING_ARTICLES:
        canon = parts[1]
    return canon


def _display_name(name: str) -> str:
    """Strip a leading article for display, preserving original casing of the rest."""
    parts = name.strip().split(" ", 1)
    if len(parts) > 1 and parts[0].lower() in LEADING_ARTICLES:
        return parts[1]
    return name.strip()


# =============================================================================
# Extraction
# =============================================================================
def extract_from_text(text: str) -> list[tuple[str, str]]:
    """Returns list of (surface_name, kind)."""
    found: list[tuple[str, str]] = []

    for m in PROPER_NOUN_RE.finditer(text):
        name = m.group(1).strip()
        words = name.split()
        # Skip if all words are stopwords (e.g. "The And")
        if all(w.lower() in STOPWORDS for w in words):
            continue
        # Skip very short single proper nouns that are common articles
        if len(words) == 1 and len(name) < 3:
            continue
        # Skip if first word is a sentence-starter that's actually a stopword
        if len(words) == 1 and name.lower() in STOPWORDS:
            continue
        found.append((name, "proper_noun"))

    for m in ACRONYM_RE.finditer(text):
        acronym = m.group(1)
        if acronym.lower() in STOPWORDS:
            continue
        # Avoid duplicating with proper_noun matches
        found.append((acronym, "acronym"))

    return found


def extract_entities_from_chunks(chunks: list[Chunk]) -> tuple[list[dict], list[EntityMention]]:
    """
    Returns:
      entities: list of {id, name, canonical, kind, mention_count, document_ids, chunk_ids}
      mentions: flat list of EntityMention for relationship mining
    """
    canonical_to_id: dict[str, int] = {}
    entities: dict[int, dict] = {}
    mentions: list[EntityMention] = []
    next_id = 0

    for chunk in chunks:
        for surface, kind in extract_from_text(chunk.text):
            canon = _canonicalize(surface)
            if canon in WEAK_GENERICS:
                continue
            # Skip if the whole canonical is a sentence-starter word (single token entity)
            if " " not in canon and canon in LEADING_ARTICLES:
                continue
            if canon not in canonical_to_id:
                canonical_to_id[canon] = next_id
                entities[next_id] = {
                    "id": next_id,
                    "name": _display_name(surface),
                    "canonical": canon,
                    "kind": kind,
                    "mention_count": 0,
                    "document_ids": set(),
                    "chunk_ids": set(),
                }
                next_id += 1
            eid = canonical_to_id[canon]
            entities[eid]["mention_count"] += 1
            entities[eid]["document_ids"].add(chunk.document_id)
            entities[eid]["chunk_ids"].add(chunk.chunk_id)
            mentions.append(
                EntityMention(
                    name=surface,
                    canonical=canon,
                    chunk_id=chunk.chunk_id,
                    document_id=chunk.document_id,
                    kind=kind,
                )
            )

    # Convert sets to lists for JSON serialization
    entity_list = []
    for ent in entities.values():
        ent["document_ids"] = sorted(ent["document_ids"])
        ent["chunk_ids"] = sorted(ent["chunk_ids"])
        entity_list.append(ent)

    # Filter: drop singleton mentions that aren't acronyms (likely noise)
    entity_list = [
        e for e in entity_list
        if e["mention_count"] >= 2 or e["kind"] == "acronym"
    ]
    keep_ids = {e["id"] for e in entity_list}
    mentions = [m for m in mentions if canonical_to_id[m.canonical] in keep_ids]

    return entity_list, mentions


# =============================================================================
# Relationship mining — co-occurrence within a chunk
# =============================================================================
def build_relationships(
    entities: list[dict],
    mentions: list[EntityMention],
) -> list[dict]:
    canonical_to_id = {e["canonical"]: e["id"] for e in entities}

    # Group mentions by chunk
    by_chunk: dict[int, set[int]] = defaultdict(set)
    for m in mentions:
        eid = canonical_to_id.get(m.canonical)
        if eid is not None:
            by_chunk[m.chunk_id].add(eid)

    # Co-occurrence weights
    weights: dict[tuple[int, int], int] = defaultdict(int)
    co_chunks: dict[tuple[int, int], set[int]] = defaultdict(set)
    for chunk_id, eids in by_chunk.items():
        ids = sorted(eids)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                key = (ids[i], ids[j])
                weights[key] += 1
                co_chunks[key].add(chunk_id)

    rels = []
    for (a, b), w in weights.items():
        if w < 2:  # Phase 1 filter: only co-occurrences seen at least twice
            continue
        rels.append({
            "source": a,
            "target": b,
            "weight": w,
            "evidence_chunks": sorted(co_chunks[(a, b)]),
            "kind": "co_occurs_with",
        })

    rels.sort(key=lambda r: r["weight"], reverse=True)
    return rels
