import React, { useState, useEffect, useMemo } from 'react';
import {
  LayoutGrid,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';
import { api, DocumentItem } from '../api/client';

interface Props {
  document: DocumentItem;
  onConverted: (newDoc: DocumentItem) => void;
}

export const NupLayoutPanel: React.FC<Props> = ({ document, onConverted }) => {
  const [pagesPerSheet, setPagesPerSheet] = useState<2 | 4 | 6 | 8 | 9 | 16>(4);
  const [withBorder, setWithBorder] = useState<boolean>(true);
  const [readingDirection, setReadingDirection] = useState<'row' | 'column'>(
    'row'
  );
  const [horizontalOrder, setHorizontalOrder] = useState<'ltr' | 'rtl'>('ltr');
  const [pageSize, setPageSize] = useState<
    'A4' | 'A3' | 'A5' | 'Letter' | 'Legal'
  >('A4');
  const [orientation, setOrientation] = useState<
    'auto' | 'portrait' | 'landscape'
  >('auto');
  const [outerMarginTopMm, setOuterMarginTopMm] = useState<number>(0);
  const [outerMarginBottomMm, setOuterMarginBottomMm] = useState<number>(0);
  const [outerMarginLeftMm, setOuterMarginLeftMm] = useState<number>(0);
  const [outerMarginRightMm, setOuterMarginRightMm] = useState<number>(0);
  const [innerMarginMm, setInnerMarginMm] = useState<number>(5);
  const [outputFilename, setOutputFilename] = useState<string>('');
  const [converting, setConverting] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{
    type: 'ok' | 'err';
    text: string;
  } | null>(null);

  useEffect(() => {
    const base = document.originalFilename.replace(/\.pdf$/i, '');
    setOutputFilename(`${base} - converted`);
    setFeedback(null);
  }, [document.id, document.originalFilename]);

  // Compute live grid preview cells (e.g. [1, 2, 3, 4])
  const previewGrid = useMemo(() => {
    const isLandscape =
      orientation === 'landscape'
        ? true
        : orientation === 'portrait'
          ? false
          : [2, 6, 8].includes(pagesPerSheet);

    let rows = 2;
    let cols = 2;
    if (pagesPerSheet === 2) [rows, cols] = isLandscape ? [1, 2] : [2, 1];
    else if (pagesPerSheet === 4) [rows, cols] = [2, 2];
    else if (pagesPerSheet === 6) [rows, cols] = isLandscape ? [2, 3] : [3, 2];
    else if (pagesPerSheet === 8) [rows, cols] = isLandscape ? [2, 4] : [4, 2];
    else if (pagesPerSheet === 9) [rows, cols] = [3, 3];
    else if (pagesPerSheet === 16) [rows, cols] = [4, 4];

    const colIndices =
      horizontalOrder === 'rtl'
        ? Array.from({ length: cols }, (_, i) => cols - 1 - i)
        : Array.from({ length: cols }, (_, i) => i);
    const rowIndices = Array.from({ length: rows }, (_, i) => i);

    const grid: number[][] = Array.from({ length: rows }, () =>
      Array(cols).fill(0)
    );
    let pageNum = 1;

    if (readingDirection === 'row') {
      for (const r of rowIndices) {
        for (const c of colIndices) {
          grid[r][c] = pageNum++;
        }
      }
    } else {
      for (const c of colIndices) {
        for (const r of rowIndices) {
          grid[r][c] = pageNum++;
        }
      }
    }

    return { rows, cols, isLandscape, grid };
  }, [pagesPerSheet, orientation, readingDirection, horizontalOrder]);

  const resultingSheetCount = Math.ceil(document.pageCount / pagesPerSheet);

  const handleConvertLayout = async () => {
    setConverting(true);
    setFeedback(null);
    try {
      const res = await api.request(`/documents/${document.id}/nup-layout`, {
        method: 'POST',
        body: JSON.stringify({
          pagesPerSheet,
          withBorder,
          readingDirection,
          horizontalOrder,
          pageSize,
          orientation,
          outerMarginTopMm,
          outerMarginBottomMm,
          outerMarginLeftMm,
          outerMarginRightMm,
          innerMarginMm,
          outputFilename: `${outputFilename.trim() || 'converted'}.pdf`,
        }),
      });
      setFeedback({
        type: 'ok',
        text: `Created "${res.document.originalFilename}" (${res.document.pageCount} output sheets from ${document.pageCount} pages)`,
      });
      onConverted(res.document);
    } catch (err: any) {
      setFeedback({
        type: 'err',
        text: err?.message || 'Failed to generate multi-page sheet layout',
      });
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div>
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            <LayoutGrid className="w-4 h-4 text-emerald-400" />
            Multiple Pages Per Sheet (N-Up PDF Layout)
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Define a multi-page per sheet layout or resize page format (e.g.{' '}
            {document.pageCount} pages → {resultingSheetCount} physical{' '}
            {pageSize} sheet{resultingSheetCount === 1 ? '' : 's'})
          </p>
        </div>
        <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
          {pagesPerSheet}-Up
        </span>
      </div>

      {/* Section 1: PDF Page Layout & Visual Grid Preview */}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center border-b border-slate-800/80 pb-4">
        <div className="sm:col-span-7 space-y-2.5">
          <label className="block text-xs font-semibold text-slate-200">
            PDF page layout:
            <span className="block text-[11px] font-normal text-slate-400">
              Format, size, pages per sheet...
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={pagesPerSheet}
              onChange={(e) => setPagesPerSheet(Number(e.target.value) as any)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
            >
              <option value={2}>2 pages per sheet</option>
              <option value={4}>4 pages per sheet</option>
              <option value={6}>6 pages per sheet</option>
              <option value={8}>8 pages per sheet</option>
              <option value={9}>9 pages per sheet</option>
              <option value={16}>16 pages per sheet</option>
            </select>

            <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={withBorder}
                onChange={(e) => setWithBorder(e.target.checked)}
                className="w-4 h-4 rounded accent-emerald-500"
              />
              <span>with border</span>
            </label>
          </div>
        </div>

        {/* Visual Sheet Arrangement Diagram */}
        <div className="sm:col-span-5 flex justify-center">
          <div
            className={`bg-slate-950 border-2 border-slate-700 rounded-lg p-2 shadow-inner flex flex-col justify-center gap-1.5 ${
              previewGrid.isLandscape ? 'w-36 h-24' : 'w-24 h-32'
            }`}
          >
            {previewGrid.grid.map((row, rIdx) => (
              <div key={rIdx} className="flex-1 flex gap-1.5">
                {row.map((num, cIdx) => (
                  <div
                    key={cIdx}
                    className={`flex-1 flex items-center justify-center rounded text-[11px] font-bold text-rose-400 bg-slate-900 ${
                      withBorder
                        ? 'border border-slate-500'
                        : 'border border-transparent'
                    }`}
                  >
                    {num}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Section 2: Reading Direction */}
      <div className="space-y-2 border-b border-slate-800/80 pb-4">
        <label className="block text-xs font-semibold text-slate-200">
          Reading direction:
          <span className="block text-[11px] font-normal text-slate-400">
            In which direction should the pages be arranged?
          </span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <select
            value={readingDirection}
            onChange={(e) => setReadingDirection(e.target.value as any)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
          >
            <option value="row">Row by row</option>
            <option value="column">Column by column</option>
          </select>

          <select
            value={horizontalOrder}
            onChange={(e) => setHorizontalOrder(e.target.value as any)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
          >
            <option value="ltr">Left to right</option>
            <option value="rtl">Right to left</option>
          </select>
        </div>
      </div>

      {/* Section 3: Page Layout (Output Paper Size & Orientation) */}
      <div className="space-y-2 border-b border-slate-800/80 pb-4">
        <label className="block text-xs font-semibold text-slate-200">
          Page layout:
          <span className="block text-[11px] font-normal text-slate-400">
            Which size and orientation should the new page have in the converted
            PDF file?
          </span>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <select
            value={pageSize}
            onChange={(e) => setPageSize(e.target.value as any)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
          >
            <option value="A4">A4</option>
            <option value="A3">A3</option>
            <option value="A5">A5</option>
            <option value="Letter">Letter</option>
            <option value="Legal">Legal</option>
          </select>

          <select
            value={orientation}
            onChange={(e) => setOrientation(e.target.value as any)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
          >
            <option value="auto">Automatic orientation (Standard)</option>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </div>
      </div>

      {/* Section 4: Outer Margin (Top, Left, Right, Bottom in mm) */}
      <div className="space-y-3 border-b border-slate-800/80 pb-4">
        <label className="block text-xs font-semibold text-slate-200">
          Outer margin:
          <span className="block text-[11px] font-normal text-slate-400">
            The space between content and page margin (mm)
          </span>
        </label>

        <div className="flex flex-col items-center space-y-2 bg-slate-950/70 p-3 rounded-xl border border-slate-800">
          {/* Top Margin */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400">Top:</span>
            <input
              type="number"
              min={0}
              max={50}
              value={outerMarginTopMm}
              onChange={(e) => setOuterMarginTopMm(Number(e.target.value || 0))}
              className="w-16 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-center text-xs text-white"
            />
            <span className="text-slate-500">mm</span>
          </div>

          {/* Left / Center Page Icon / Right */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-slate-400">Left:</span>
              <input
                type="number"
                min={0}
                max={50}
                value={outerMarginLeftMm}
                onChange={(e) =>
                  setOuterMarginLeftMm(Number(e.target.value || 0))
                }
                className="w-16 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-center text-xs text-white"
              />
              <span className="text-slate-500">mm</span>
            </div>

            <div className="w-14 h-10 rounded border-2 border-slate-600 bg-slate-900 flex items-center justify-center">
              <div className="w-8 h-5 bg-emerald-500/20 border border-emerald-400/50 rounded-sm" />
            </div>

            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-slate-400">Right:</span>
              <input
                type="number"
                min={0}
                max={50}
                value={outerMarginRightMm}
                onChange={(e) =>
                  setOuterMarginRightMm(Number(e.target.value || 0))
                }
                className="w-16 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-center text-xs text-white"
              />
              <span className="text-slate-500">mm</span>
            </div>
          </div>

          {/* Bottom Margin */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-slate-400">Bottom:</span>
            <input
              type="number"
              min={0}
              max={50}
              value={outerMarginBottomMm}
              onChange={(e) =>
                setOuterMarginBottomMm(Number(e.target.value || 0))
              }
              className="w-16 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-center text-xs text-white"
            />
            <span className="text-slate-500">mm</span>
          </div>
        </div>
      </div>

      {/* Section 5: Inner Margin (Space between sub-pages) */}
      <div className="flex items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <label className="block text-xs font-semibold text-slate-200">
          Inner margin:
          <span className="block text-[11px] font-normal text-slate-400">
            The space between the pages on the sheet
          </span>
        </label>
        <div className="flex items-center gap-1.5 text-xs">
          <input
            type="number"
            min={0}
            max={40}
            value={innerMarginMm}
            onChange={(e) => setInnerMarginMm(Number(e.target.value || 0))}
            className="w-20 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-center text-xs text-white"
          />
          <span className="text-slate-400">mm</span>
        </div>
      </div>

      {/* Section 6: Filename after conversion */}
      <div className="space-y-1.5">
        <label className="block text-xs font-semibold text-slate-200">
          Filename after conversion:
        </label>
        <div className="flex items-center">
          <input
            type="text"
            value={outputFilename}
            onChange={(e) => setOutputFilename(e.target.value)}
            className="flex-1 bg-slate-950 border border-slate-700 rounded-l-lg px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
          />
          <span className="px-3 py-2 bg-slate-800 border border-l-0 border-slate-700 rounded-r-lg text-xs text-slate-300 font-mono">
            .pdf
          </span>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
            feedback.type === 'ok'
              ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
              : 'bg-rose-500/10 border border-rose-500/30 text-rose-300'
          }`}
        >
          {feedback.type === 'ok' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      <button
        type="button"
        disabled={converting}
        onClick={handleConvertLayout}
        className="w-full py-2.5 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 text-white font-semibold text-sm transition flex items-center justify-center gap-2"
      >
        <Sparkles className="w-4 h-4" />
        {converting
          ? 'Generating Multi-Page Sheet PDF...'
          : `Convert to ${pagesPerSheet} Pages/Sheet (${resultingSheetCount} Output Sheet${
              resultingSheetCount === 1 ? '' : 's'
            })`}
      </button>
    </div>
  );
};
