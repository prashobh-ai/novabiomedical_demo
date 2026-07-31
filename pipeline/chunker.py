"""Chunker — packs paragraphs into BM25-friendly chunks while preserving citation context."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

from .parsers import Paragraph

TARGET_CHARS = 700
MIN_CHARS = 200
OVERLAP_PARAGRAPHS = 1


# =============================================================================
# Data model
# =============================================================================
@dataclass
class Chunk:
    chunk_id: int
    document_id: int
    document_name: str
    page: int
    section_path: list[str]
    paragraph_indices: list[int]
    text: str
    paragraph_excerpt: str  # first sentence — used in citation preview
    tokens: list[str] = field(default_factory=list)


# =============================================================================
# Tokenization (simple but consistent across pipeline and JS client)
# =============================================================================
_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def tokenize(text: str) -> list[str]:
    return [t.lower() for t in _TOKEN_RE.findall(text) if len(t) > 1]


# =============================================================================
# Chunking logic — group paragraphs that share a section, target ~700 chars
# =============================================================================
def _first_sentence(text: str, max_len: int = 200) -> str:
    m = re.search(r"^(.+?[.!?])(\s|$)", text)
    snippet = m.group(1) if m else text[:max_len]
    return snippet[:max_len].strip()


def chunk_paragraphs(
    paragraphs: Iterable[Paragraph],
    document_id: int,
    document_name: str,
    start_chunk_id: int = 0,
) -> list[Chunk]:
    paragraphs = list(paragraphs)
    chunks: list[Chunk] = []
    cur_paras: list[Paragraph] = []
    cur_len = 0
    cur_section: list[str] = []
    cur_page: int = 1
    next_id = start_chunk_id

    def flush(clear_overlap: bool = False):
        nonlocal cur_paras, cur_len, next_id
        if not cur_paras:
            return
        text = "\n\n".join(p.text for p in cur_paras)
        chunks.append(
            Chunk(
                chunk_id=next_id,
                document_id=document_id,
                document_name=document_name,
                page=cur_paras[0].page,
                section_path=list(cur_paras[0].section_path),
                paragraph_indices=[p.paragraph_index for p in cur_paras],
                text=text,
                paragraph_excerpt=_first_sentence(cur_paras[0].text),
                tokens=tokenize(text),
            )
        )
        next_id += 1
        # Overlap is for narrative continuity within a section. When crossing a
        # section boundary we explicitly drop it — overlapping the previous
        # section's tail into the next section's chunk would re-introduce the
        # exact bug we're fixing.
        if not clear_overlap and OVERLAP_PARAGRAPHS and len(cur_paras) > OVERLAP_PARAGRAPHS:
            tail = cur_paras[-OVERLAP_PARAGRAPHS:]
            cur_paras = list(tail)
            cur_len = sum(len(p.text) for p in tail)
        else:
            cur_paras = []
            cur_len = 0

    for para in paragraphs:
        section_changed = para.section_path != cur_section or para.page != cur_page
        # Always flush on section change — even if the current chunk is small.
        # Citation integrity depends on section_path matching the chunk's actual
        # content; bundling paragraphs across a heading boundary makes the
        # metadata lie about what's in the chunk and corrupts downstream answers
        # for structured docs (leadership rosters, FAQs, glossaries, etc.).
        if section_changed and cur_paras:
            flush(clear_overlap=True)
        cur_section = list(para.section_path)
        cur_page = para.page
        cur_paras.append(para)
        cur_len += len(para.text)
        if cur_len >= TARGET_CHARS:
            flush()

    flush()
    return chunks
