import React, { useState, useEffect, useMemo } from 'react';
import {
  Printer,
  FileText,
  Layers,
  ArrowUpDown,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { api, DocumentItem, PrinterItem, safeRandomUUID } from '../api/client';

interface Props {
  document: DocumentItem;
  printers: PrinterItem[];
  onJobSubmitted: () => void;
}

/**
 * Frontend mirror of TRD 4.1 resolvePrintPages for instant 0ms Live Sheet Counter feedback.
 */
function computeLivePages(input: {
  totalPages: number;
  range: string;
  subset: 'all' | 'odd' | 'even';
  reverse: boolean;
  duplex: 'none' | 'long-edge' | 'short-edge';
  copies: number;
}): {
  pages: number[];
  logicalPageCount: number;
  physicalSheets: number;
  error: string | null;
} {
  try {
    const { totalPages, range, subset, reverse, duplex, copies } = input;
    if (!Number.isInteger(totalPages) || totalPages < 1) {
      return { pages: [], logicalPageCount: 0, physicalSheets: 0, error: 'Invalid document page count' };
    }
    if (!Number.isInteger(copies) || copies < 1 || copies > 100) {
      return { pages: [], logicalPageCount: 0, physicalSheets: 0, error: 'Copies must be 1–100' };
    }

    let pages: number[] = [];
    if (!range.trim()) {
      pages = Array.from({ length: totalPages }, (_, idx) => idx + 1);
    } else {
      const tokens = range
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      for (const token of tokens) {
        if (/^[0-9]+$/.test(token)) {
          const p = Number(token);
          if (p < 1 || p > totalPages) {
            return {
              pages: [],
              logicalPageCount: 0,
              physicalSheets: 0,
              error: `Page ${p} exceeds document bounds (1–${totalPages})`,
            };
          }
          pages.push(p);
        } else if (/^[0-9]+-[0-9]+$/.test(token)) {
          const [start, end] = token.split('-').map(Number);
          if (start < 1 || end > totalPages || start > end) {
            return {
              pages: [],
              logicalPageCount: 0,
              physicalSheets: 0,
              error: `Invalid range "${token}" (valid: 1–${totalPages})`,
            };
          }
          for (let p = start; p <= end; p++) pages.push(p);
        } else {
          return {
            pages: [],
            logicalPageCount: 0,
            physicalSheets: 0,
            error: `Malformed range token "${token}"`,
          };
        }
      }
    }

    if (subset === 'odd') pages = pages.filter((p) => p % 2 !== 0);
    if (subset === 'even') pages = pages.filter((p) => p % 2 === 0);

    if (pages.length === 0) {
      return {
        pages: [],
        logicalPageCount: 0,
        physicalSheets: 0,
        error: 'No pages match current range and odd/even filter',
      };
    }

    if (reverse) pages = [...pages].reverse();

    const logicalPageCount = pages.length;
    const sheetsPerCopy =
      duplex === 'none' ? logicalPageCount : Math.ceil(logicalPageCount / 2);
    const physicalSheets = sheetsPerCopy * copies;

    return { pages, logicalPageCount, physicalSheets, error: null };
  } catch (e: any) {
    return {
      pages: [],
      logicalPageCount: 0,
      physicalSheets: 0,
      error: e?.message || 'Validation error',
    };
  }
}

export const PageSlicerAndPrintPanel: React.FC<Props> = ({
  document,
  printers,
  onJobSubmitted,
}) => {
  const [selectedPrinterId, setSelectedPrinterId] = useState<string>(
    printers[0]?.id || ''
  );
  const [range, setRange] = useState<string>('');
  const [subset, setSubset] = useState<'all' | 'odd' | 'even'>('all');
  const [reverse, setReverse] = useState<boolean>(false);
  const [copies, setCopies] = useState<number>(1);
  const [duplex, setDuplex] = useState<'none' | 'long-edge' | 'short-edge'>(
    'none'
  );
  const [colorMode, setColorMode] = useState<'monochrome' | 'color'>(
    'monochrome'
  );
  const [mediaSize, setMediaSize] = useState<string>('A4');
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'ok' | 'err';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!selectedPrinterId && printers.length > 0) {
      setSelectedPrinterId(printers[0].id);
    }
  }, [printers, selectedPrinterId]);

  const activePrinter = useMemo(
    () => printers.find((p) => p.id === selectedPrinterId) || printers[0],
    [printers, selectedPrinterId]
  );

  const liveCalc = useMemo(
    () =>
      computeLivePages({
        totalPages: document.pageCount,
        range,
        subset,
        reverse,
        duplex,
        copies,
      }),
    [document.pageCount, range, subset, reverse, duplex, copies]
  );

  const handleDispatchPrint = async () => {
    if (liveCalc.error || !activePrinter) return;
    setSubmitting(true);
    setStatusMessage(null);
    try {
      const idempotencyKey = safeRandomUUID();
      const res = await api.request('/print-jobs', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey,
          documentId: document.id,
          printerId: activePrinter.id,
          options: {
            range,
            subset,
            reverse,
            copies,
            duplex,
            colorMode,
            mediaSize,
          },
        }),
      });
      setStatusMessage({
        type: 'ok',
        text: `Job queued (${res.cupsJobId || res.state}) — ${res.physicalSheets} physical sheet(s)`,
      });
      onJobSubmitted();
    } catch (err: any) {
      setStatusMessage({
        type: 'err',
        text: err?.message || 'Failed to dispatch print job',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div>
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            <Printer className="w-4 h-4 text-emerald-400" />
            Granular Page Slicer & Print Orchestrator
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {document.originalFilename} ({document.pageCount} pages)
          </p>
        </div>
        <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          v{document.revisionNumber}
        </span>
      </div>

      {/* Target Printer */}
      <div>
        <label className="block text-xs font-medium text-slate-300 mb-1.5">
          Target CUPS / Remote Printer
        </label>
        <select
          value={selectedPrinterId}
          onChange={(e) => setSelectedPrinterId(e.target.value)}
          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
        >
          {printers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName} [{p.adapterType === 'LOCAL_CUPS' ? 'Local CUPS' : 'Remote Agent'} • {p.operationalState}]
            </option>
          ))}
        </select>
      </div>

      {/* Custom Page Range */}
      <div>
        <label className="block text-xs font-medium text-slate-300 mb-1">
          Custom Page Ranges (leave empty for all 1–{document.pageCount})
        </label>
        <input
          type="text"
          value={range}
          onChange={(e) => setRange(e.target.value)}
          placeholder="e.g. 1-3, 5, 8-10"
          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
        />
      </div>

      {/* Page Subset Filter & Print Order Toggle */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Page Subset Filter
          </label>
          <div className="grid grid-cols-3 gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
            {(['all', 'odd', 'even'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setSubset(opt)}
                className={`py-1.5 text-xs font-medium rounded-md capitalize transition ${
                  subset === opt
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Print Order (Manual Duplex Helper)
          </label>
          <button
            type="button"
            onClick={() => setReverse(!reverse)}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-xs font-medium transition ${
              reverse
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                : 'bg-slate-950 border-slate-800 text-slate-300'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <ArrowUpDown className="w-3.5 h-3.5" />
              {reverse ? 'Reverse (N → 1)' : 'Normal (1 → N)'}
            </span>
            <span className="text-[11px] opacity-75">
              {reverse ? 'Face-Up Stack' : 'Standard'}
            </span>
          </button>
        </div>
      </div>

      {/* Hardware Capabilities: Copies, Duplex, Color, Paper Size */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Copies
          </label>
          <input
            type="number"
            min={1}
            max={100}
            value={copies}
            onChange={(e) => setCopies(Number(e.target.value || 1))}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm text-white"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Hardware Duplex
          </label>
          <select
            value={duplex}
            onChange={(e) => setDuplex(e.target.value as any)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white"
          >
            <option value="none">1-Sided (None)</option>
            {activePrinter?.capabilities?.duplex !== false && (
              <>
                <option value="long-edge">2-Sided Long-Edge</option>
                <option value="short-edge">2-Sided Short-Edge</option>
              </>
            )}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Color Mode
          </label>
          <select
            value={colorMode}
            onChange={(e) => setColorMode(e.target.value as any)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white"
          >
            <option value="monochrome">Monochrome (B&W)</option>
            {activePrinter?.capabilities?.color && (
              <option value="color">Full Color</option>
            )}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Paper Media
          </label>
          <select
            value={mediaSize}
            onChange={(e) => setMediaSize(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white"
          >
            {(activePrinter?.capabilities?.media || ['A4', 'Letter']).map(
              (m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              )
            )}
          </select>
        </div>
      </div>

      {/* Real-time Live Sheet Counter Box */}
      <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-emerald-400" />
            Live Physical Sheet Counter
          </span>
          {liveCalc.error ? (
            <span className="text-xs text-rose-400 font-medium">
              Invalid Selection
            </span>
          ) : (
            <span className="text-lg font-bold text-emerald-400">
              {liveCalc.physicalSheets} sheet{liveCalc.physicalSheets === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {liveCalc.error ? (
          <p className="text-xs text-rose-400 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {liveCalc.error}
          </p>
        ) : (
          <div className="text-xs text-slate-400 space-y-1">
            <div>
              Logical pages sliced:{' '}
              <strong className="text-slate-200">
                {liveCalc.logicalPageCount}
              </strong>{' '}
              ×{' '}
              <strong className="text-slate-200">
                {copies} cop{copies === 1 ? 'y' : 'ies'}
              </strong>{' '}
              ({duplex === 'none' ? 'Single-sided' : `Duplex ${duplex}`})
            </div>
            <div className="truncate text-[11px] text-slate-500">
              Spool Sequence:{' '}
              <code className="text-emerald-300 bg-slate-900 px-1.5 py-0.5 rounded">
                [{liveCalc.pages.slice(0, 24).join(', ')}
                {liveCalc.pages.length > 24 ? ', ...' : ''}]
              </code>
            </div>
          </div>
        )}
      </div>

      {statusMessage && (
        <div
          className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
            statusMessage.type === 'ok'
              ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
              : 'bg-rose-500/10 border border-rose-500/30 text-rose-300'
          }`}
        >
          {statusMessage.type === 'ok' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0" />
          )}
          <span>{statusMessage.text}</span>
        </div>
      )}

      <button
        type="button"
        disabled={Boolean(liveCalc.error) || submitting || !activePrinter}
        onClick={handleDispatchPrint}
        className="w-full py-2.5 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-semibold text-sm transition flex items-center justify-center gap-2"
      >
        <FileText className="w-4 h-4" />
        {submitting
          ? 'Slicing & Spooling to Print Queue...'
          : `Slice & Print (${liveCalc.physicalSheets} Physical Sheet${
              liveCalc.physicalSheets === 1 ? '' : 's'
            })`}
      </button>
    </div>
  );
};
