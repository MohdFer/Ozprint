/**
 * TRD 4.1 Deterministic Page-Range, Odd/Even & Reverse Resolver
 */

export interface PageResolveInput {
  totalPages: number;
  range?: string; // e.g. "1-6, 9, 11-12" (empty = all pages)
  subset?: 'all' | 'odd' | 'even';
  reverse?: boolean; // true = print N -> 1 (manual duplexing)
  duplex?: 'none' | 'long-edge' | 'short-edge';
  copies?: number;
}

export interface PageResolveResult {
  pages: number[]; // Ordered 1-based page numbers to slice
  logicalPageCount: number;
  physicalSheets: number;
}

export function resolvePrintPages(input: PageResolveInput): PageResolveResult {
  const {
    totalPages,
    range = '',
    subset = 'all',
    reverse = false,
    duplex = 'none',
    copies = 1,
  } = input;

  if (!Number.isInteger(totalPages) || totalPages < 1) {
    throw new Error('INVALID_DOCUMENT_PAGE_COUNT');
  }
  if (!Number.isInteger(copies) || copies < 1 || copies > 100) {
    throw new Error('INVALID_COPY_COUNT');
  }
  if (!['all', 'odd', 'even'].includes(subset)) {
    throw new Error(`INVALID_SUBSET_FILTER:${subset}`);
  }
  if (!['none', 'long-edge', 'short-edge'].includes(duplex)) {
    throw new Error(`INVALID_DUPLEX_MODE:${duplex}`);
  }

  let pages: number[] = [];

  if (!range.trim()) {
    pages = Array.from({ length: totalPages }, (_, idx) => idx + 1);
  } else {
    const tokens = range
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length > 100) {
      throw new Error('RANGE_EXCEEDS_MAX_SEGMENTS');
    }

    for (const token of tokens) {
      if (/^[0-9]+$/.test(token)) {
        const page = Number(token);
        if (page < 1 || page > totalPages) {
          throw new Error(`PAGE_OUT_OF_BOUNDS:${page}`);
        }
        pages.push(page);
      } else if (/^[0-9]+-[0-9]+$/.test(token)) {
        const [start, end] = token.split('-').map(Number);
        if (start < 1 || end > totalPages || start > end) {
          throw new Error(`INVALID_PAGE_RANGE:${token}`);
        }
        for (let p = start; p <= end; p++) {
          pages.push(p);
        }
      } else {
        throw new Error(`MALFORMED_RANGE_TOKEN:${token}`);
      }
    }
  }

  if (subset === 'odd') {
    pages = pages.filter((p) => p % 2 !== 0);
  } else if (subset === 'even') {
    pages = pages.filter((p) => p % 2 === 0);
  }

  if (pages.length === 0) {
    throw new Error('EMPTY_RESOLVED_PAGE_SET');
  }

  if (reverse) {
    pages = [...pages].reverse();
  }

  const logicalPageCount = pages.length;
  const sheetsPerCopy =
    duplex === 'none' ? logicalPageCount : Math.ceil(logicalPageCount / 2);
  const physicalSheets = sheetsPerCopy * copies;

  return {
    pages,
    logicalPageCount,
    physicalSheets,
  };
}
