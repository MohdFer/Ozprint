import { describe, it, expect } from 'vitest';
import { resolvePrintPages } from '../../apps/server/src/core/pageResolver';

describe('TRD 4.1 & Section 7 — Page Resolver Unit Tests', () => {
  it('resolves "1-5" + odd subset to [1, 3, 5]', () => {
    const res = resolvePrintPages({
      totalPages: 10,
      range: '1-5',
      subset: 'odd',
      reverse: false,
      duplex: 'none',
      copies: 1,
    });
    expect(res.pages).toEqual([1, 3, 5]);
    expect(res.logicalPageCount).toBe(3);
    expect(res.physicalSheets).toBe(3);
  });

  it('resolves "1-5" + even subset + reverse to [4, 2]', () => {
    const res = resolvePrintPages({
      totalPages: 10,
      range: '1-5',
      subset: 'even',
      reverse: true,
      duplex: 'none',
      copies: 1,
    });
    expect(res.pages).toEqual([4, 2]);
    expect(res.logicalPageCount).toBe(2);
    expect(res.physicalSheets).toBe(2);
  });

  it('matches TRD 5.2 contract example ("1-10" + odd + reverse -> [9, 7, 5, 3, 1], 5 sheets)', () => {
    const res = resolvePrintPages({
      totalPages: 12,
      range: '1-10',
      subset: 'odd',
      reverse: true,
      duplex: 'none',
      copies: 1,
    });
    expect(res.pages).toEqual([9, 7, 5, 3, 1]);
    expect(res.logicalPageCount).toBe(5);
    expect(res.physicalSheets).toBe(5);
  });

  it('calculates duplex physical sheets and copy multipliers accurately', () => {
    const res = resolvePrintPages({
      totalPages: 10,
      range: '1-5',
      subset: 'all',
      reverse: false,
      duplex: 'long-edge',
      copies: 3,
    });
    expect(res.pages).toEqual([1, 2, 3, 4, 5]);
    expect(res.logicalPageCount).toBe(5);
    // ceil(5 / 2) = 3 physical sheets per copy * 3 copies = 9 sheets
    expect(res.physicalSheets).toBe(9);
  });

  it('throws typed error on out-of-bounds pages (0 and 999)', () => {
    expect(() =>
      resolvePrintPages({
        totalPages: 5,
        range: '0',
      })
    ).toThrow(/PAGE_OUT_OF_BOUNDS:0/);

    expect(() =>
      resolvePrintPages({
        totalPages: 5,
        range: '1-3, 999',
      })
    ).toThrow(/PAGE_OUT_OF_BOUNDS:999/);
  });

  it('throws EMPTY_RESOLVED_PAGE_SET when even subset is applied to a 1-page PDF', () => {
    expect(() =>
      resolvePrintPages({
        totalPages: 1,
        range: '1',
        subset: 'even',
      })
    ).toThrow('EMPTY_RESOLVED_PAGE_SET');
  });

  it('throws typed validation errors on inverted ranges, invalid copies, or malformed tokens', () => {
    expect(() =>
      resolvePrintPages({
        totalPages: 10,
        range: '6-3',
      })
    ).toThrow(/INVALID_PAGE_RANGE:6-3/);

    expect(() =>
      resolvePrintPages({
        totalPages: 10,
        range: '1-3, foo',
      })
    ).toThrow(/MALFORMED_RANGE_TOKEN:foo/);

    expect(() =>
      resolvePrintPages({
        totalPages: 0,
      })
    ).toThrow('INVALID_DOCUMENT_PAGE_COUNT');

    expect(() =>
      resolvePrintPages({
        totalPages: 5,
        copies: 101,
      })
    ).toThrow('INVALID_COPY_COUNT');
  });
});
