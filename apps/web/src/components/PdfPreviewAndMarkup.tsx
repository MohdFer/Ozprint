import React, { useState, useEffect, useRef } from 'react';
import {
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Type,
  PenTool,
  Stamp,
  EyeOff,
  ShieldAlert,
  Save,
  Trash2,
  Image as ImageIcon,
  History,
} from 'lucide-react';
import { api, DocumentItem } from '../api/client';

interface OverlayItem {
  id: string;
  page: number;
  type: 'text' | 'stamp' | 'mask' | 'redact' | 'signature';
  x: number; // normalized [0..1]
  y: number; // normalized [0..1]
  width: number; // normalized [0..1]
  height: number; // normalized [0..1]
  text?: string;
  color?: string;
  points?: Array<{ x: number; y: number }>;
}

interface Props {
  document: DocumentItem;
  revisions: DocumentItem[];
  onSelectRevision: (doc: DocumentItem) => void;
  onRevisionCreated: (newDoc: DocumentItem) => void;
}

export const PdfPreviewAndMarkup: React.FC<Props> = ({
  document,
  revisions,
  onSelectRevision,
  onRevisionCreated,
}) => {
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [zoom, setZoom] = useState<number>(1);
  const [activeTool, setActiveTool] = useState<
    'none' | 'text' | 'stamp' | 'mask' | 'redact' | 'signature'
  >('none');
  const [overlays, setOverlays] = useState<OverlayItem[]>([]);
  const [customText, setCustomText] = useState<string>('Confidential Note');
  const [stampLabel, setStampLabel] = useState<string>('APPROVED');
  const [isDrawingSig, setIsDrawingSig] = useState<boolean>(false);
  const [currentSigPoints, setCurrentSigPoints] = useState<
    Array<{ x: number; y: number }>
  >([]);
  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);

  const canvasContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrentPage(1);
    setOverlays([]);
    setFeedback(null);

    let revoked = false;
    let objectUrl: string | null = null;

    async function loadPdfBinary() {
      try {
        const headers: Record<string, string> = {};
        const token = api.getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(api.getStreamUrl(document.id), {
          headers,
          credentials: 'include',
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (!revoked) {
          objectUrl = URL.createObjectURL(blob);
          setPdfBlobUrl(objectUrl);
        }
      } catch {
        // Ignore
      }
    }

    loadPdfBinary();
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [document.id]);

  const getNormalizedCoords = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0.2, y: 0.2 };
    const x = Math.max(0.02, Math.min(0.92, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0.02, Math.min(0.92, (e.clientY - rect.top) / rect.height));
    return { x, y };
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool === 'none') return;
    const { x, y } = getNormalizedCoords(e);

    if (activeTool === 'signature') {
      setIsDrawingSig(true);
      setCurrentSigPoints([{ x, y }]);
      return;
    }

    const newItem: OverlayItem = {
      id: crypto.randomUUID(),
      page: currentPage,
      type: activeTool,
      x,
      y,
      width: activeTool === 'mask' || activeTool === 'redact' ? 0.28 : 0.22,
      height: activeTool === 'mask' || activeTool === 'redact' ? 0.07 : 0.05,
      text:
        activeTool === 'text'
          ? customText
          : activeTool === 'stamp'
            ? stampLabel
            : undefined,
      color:
        activeTool === 'stamp'
          ? '#dc2626'
          : activeTool === 'text'
            ? '#0f172a'
            : undefined,
    };

    setOverlays((prev) => [...prev, newItem]);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawingSig || activeTool !== 'signature') return;
    const { x, y } = getNormalizedCoords(e);
    setCurrentSigPoints((prev) => [...prev, { x, y }]);
  };

  const handleCanvasMouseUp = () => {
    if (isDrawingSig && currentSigPoints.length > 1) {
      setOverlays((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          page: currentPage,
          type: 'signature',
          x: currentSigPoints[0].x,
          y: currentSigPoints[0].y,
          width: 0.2,
          height: 0.08,
          color: '#1d4ed8',
          points: currentSigPoints,
        },
      ]);
    }
    setIsDrawingSig(false);
    setCurrentSigPoints([]);
  };

  const handleExportMarkupRevision = async () => {
    const markupItems = overlays.filter((o) => o.type !== 'redact');
    if (markupItems.length === 0) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await api.request(`/documents/${document.id}/annotate`, {
        method: 'POST',
        body: JSON.stringify({
          annotations: markupItems,
          revisionNote: `Flattened ${markupItems.length} annotation(s)`,
        }),
      });
      setFeedback(
        `Saved new non-destructive revision v${res.document.revisionNumber}`
      );
      setOverlays((prev) => prev.filter((o) => o.type === 'redact'));
      onRevisionCreated(res.document);
    } catch (err: any) {
      setFeedback(`Error: ${err?.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleExecuteTrueRedaction = async () => {
    const redactItems = overlays.filter((o) => o.type === 'redact');
    if (redactItems.length === 0) return;
    setSaving(true);
    setFeedback(null);
    try {
      const byPage = new Map<
        number,
        Array<{ x: number; y: number; w: number; h: number; fill: string }>
      >();
      for (const item of redactItems) {
        const list = byPage.get(item.page) || [];
        list.push({
          x: item.x,
          y: item.y,
          w: item.width,
          h: item.height,
          fill: '#000000',
        });
        byPage.set(item.page, list);
      }

      const redactions = Array.from(byPage.entries()).map(([page, rects]) => ({
        page,
        rects,
      }));

      const res = await api.request(`/documents/${document.id}/redact`, {
        method: 'POST',
        body: JSON.stringify({
          redactions,
          revisionNote: `True Redaction burned into page(s) ${redactions
            .map((r) => r.page)
            .join(', ')}`,
        }),
      });
      setFeedback(
        `True Redaction complete: created vector-stripped revision v${res.document.revisionNumber}`
      );
      setOverlays((prev) => prev.filter((o) => o.type !== 'redact'));
      onRevisionCreated(res.document);
    } catch (err: any) {
      setFeedback(`Error: ${err?.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadImagesZip = async (format: 'png' | 'jpeg') => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      const token = api.getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`/api/documents/${document.id}/convert`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ format, dpi: 200 }),
      });
      if (!res.ok) throw new Error('Conversion failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = `${document.originalFilename.replace(/\.pdf$/i, '')}_${format}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setFeedback(`Conversion error: ${err?.message}`);
    }
  };

  const pageOverlays = overlays.filter((o) => o.page === currentPage);
  const hasVisualMarkup = overlays.some((o) => o.type !== 'redact');
  const hasTrueRedactions = overlays.some((o) => o.type === 'redact');

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl flex flex-col overflow-hidden">
      {/* Top Toolbar: Page Navigation, Zoom & Format Export */}
      <div className="p-3 bg-slate-950 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-slate-200 border border-slate-800"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs font-medium text-slate-300 px-2">
            Page <strong className="text-white">{currentPage}</strong> of{' '}
            <strong className="text-white">{document.pageCount}</strong>
          </span>
          <button
            type="button"
            disabled={currentPage >= document.pageCount}
            onClick={() =>
              setCurrentPage((p) => Math.min(document.pageCount, p + 1))
            }
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-slate-200 border border-slate-800"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <div className="h-4 w-px bg-slate-800 mx-1" />

          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.15).toFixed(2)))}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800"
            title="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-slate-400 w-12 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(1.8, +(z + 0.15).toFixed(2)))}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800"
            title="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>

        {/* Bidirectional Conversion Export Buttons */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleDownloadImagesZip('png')}
            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-xs text-slate-300 border border-slate-800 flex items-center gap-1.5"
          >
            <ImageIcon className="w-3.5 h-3.5 text-sky-400" />
            Export PNG ZIP
          </button>
          <button
            type="button"
            onClick={() => handleDownloadImagesZip('jpeg')}
            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-xs text-slate-300 border border-slate-800 flex items-center gap-1.5"
          >
            <ImageIcon className="w-3.5 h-3.5 text-amber-400" />
            Export JPG ZIP
          </button>
        </div>
      </div>

      {/* Markup vs True Redaction Tool Bar */}
      <div className="p-2.5 bg-slate-900/90 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              setActiveTool(activeTool === 'text' ? 'none' : 'text')
            }
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition ${
              activeTool === 'text'
                ? 'bg-emerald-600 text-white border-emerald-500'
                : 'bg-slate-950 text-slate-300 border-slate-800 hover:text-white'
            }`}
          >
            <Type className="w-3.5 h-3.5" />
            Text Box
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveTool(activeTool === 'signature' ? 'none' : 'signature')
            }
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition ${
              activeTool === 'signature'
                ? 'bg-emerald-600 text-white border-emerald-500'
                : 'bg-slate-950 text-slate-300 border-slate-800 hover:text-white'
            }`}
          >
            <PenTool className="w-3.5 h-3.5" />
            Freehand Sign
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveTool(activeTool === 'stamp' ? 'none' : 'stamp')
            }
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition ${
              activeTool === 'stamp'
                ? 'bg-emerald-600 text-white border-emerald-500'
                : 'bg-slate-950 text-slate-300 border-slate-800 hover:text-white'
            }`}
          >
            <Stamp className="w-3.5 h-3.5" />
            Stamp
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveTool(activeTool === 'mask' ? 'none' : 'mask')
            }
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition ${
              activeTool === 'mask'
                ? 'bg-amber-600 text-white border-amber-500'
                : 'bg-slate-950 text-amber-300 border-slate-800 hover:border-amber-500/40'
            }`}
            title="Places a white overlay box (Visual Masking only; underlying text remains in PDF)"
          >
            <EyeOff className="w-3.5 h-3.5" />
            Visual Mask (White Box)
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveTool(activeTool === 'redact' ? 'none' : 'redact')
            }
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition ${
              activeTool === 'redact'
                ? 'bg-rose-600 text-white border-rose-500'
                : 'bg-slate-950 text-rose-300 border-slate-800 hover:border-rose-500/40'
            }`}
            title="True Redaction: Permanently strips text/vectors and rasterizes the affected page"
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            True Redaction (Strip & Rasterize)
          </button>

          {activeTool === 'text' && (
            <input
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="Annotation text..."
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-white"
            />
          )}

          {activeTool === 'stamp' && (
            <select
              value={stampLabel}
              onChange={(e) => setStampLabel(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white"
            >
              <option value="APPROVED">APPROVED</option>
              <option value="CONFIDENTIAL">CONFIDENTIAL</option>
              <option value="DRAFT">DRAFT</option>
              <option value="PAID">PAID</option>
            </select>
          )}
        </div>

        <div className="flex items-center gap-2">
          {overlays.length > 0 && (
            <button
              type="button"
              onClick={() => setOverlays([])}
              className="px-2 py-1 rounded-lg bg-slate-950 hover:bg-slate-800 text-xs text-slate-400 flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear ({overlays.length})
            </button>
          )}

          {hasVisualMarkup && (
            <button
              type="button"
              disabled={saving}
              onClick={handleExportMarkupRevision}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5"
            >
              <Save className="w-3.5 h-3.5" />
              Save Annotated Revision
            </button>
          )}

          {hasTrueRedactions && (
            <button
              type="button"
              disabled={saving}
              onClick={handleExecuteTrueRedaction}
              className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center gap-1.5"
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              Burn True Redaction
            </button>
          )}
        </div>
      </div>

      {feedback && (
        <div className="px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20 text-xs text-emerald-300">
          {feedback}
        </div>
      )}

      {/* Main Viewport + Fabric/Canvas Overlay */}
      <div className="p-4 bg-slate-950/60 flex justify-center overflow-auto min-h-[480px]">
        <div
          ref={canvasContainerRef}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          style={{
            width: `${Math.round(560 * zoom)}px`,
            height: `${Math.round(760 * zoom)}px`,
          }}
          className={`relative bg-white shadow-2xl rounded border border-slate-700 overflow-hidden select-none ${
            activeTool !== 'none' ? 'cursor-crosshair' : 'cursor-default'
          }`}
        >
          {/* Native PDF Preview Layer */}
          {pdfBlobUrl ? (
            <iframe
              title="PDF Preview"
              src={`${pdfBlobUrl}#page=${currentPage}&toolbar=0&navpanes=0`}
              className={`w-full h-full border-0 ${
                activeTool !== 'none' ? 'pointer-events-none' : ''
              }`}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
              Loading PDF Page {currentPage}...
            </div>
          )}

          {/* Interactive Annotation & Redaction Layer */}
          {pageOverlays.map((item) => (
            <div
              key={item.id}
              style={{
                left: `${item.x * 100}%`,
                top: `${item.y * 100}%`,
                width: `${item.width * 100}%`,
                height: `${item.height * 100}%`,
              }}
              className={`absolute flex items-center justify-between px-2 text-xs font-semibold rounded shadow ${
                item.type === 'mask'
                  ? 'bg-white border-2 border-amber-400 text-amber-700'
                  : item.type === 'redact'
                    ? 'bg-black/95 border-2 border-rose-500 text-rose-400'
                    : item.type === 'stamp'
                      ? 'border-2 border-rose-600 text-rose-600 bg-rose-50/80 tracking-wider'
                      : item.type === 'signature'
                        ? 'border border-blue-500/50 bg-blue-50/30 text-blue-800'
                        : 'bg-yellow-100/90 border border-slate-400 text-slate-900'
              }`}
            >
              <span className="truncate">
                {item.type === 'mask'
                  ? '[Visual Mask]'
                  : item.type === 'redact'
                    ? '[TRUE REDACT]'
                    : item.type === 'signature'
                      ? '✒️ Signature'
                      : item.text}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOverlays((prev) => prev.filter((o) => o.id !== item.id));
                }}
                className="ml-1 text-[10px] opacity-75 hover:opacity-100"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Non-Destructive Revision History Bar */}
      {revisions.length > 0 && (
        <div className="p-3 bg-slate-950 border-t border-slate-800 flex items-center gap-2 overflow-x-auto">
          <span className="text-xs font-medium text-slate-400 flex items-center gap-1 shrink-0">
            <History className="w-3.5 h-3.5 text-emerald-400" />
            Revision Lineage:
          </span>
          {revisions.map((rev) => (
            <button
              key={rev.id}
              type="button"
              onClick={() => onSelectRevision(rev)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium shrink-0 border transition ${
                rev.id === document.id
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
              }`}
              title={rev.revisionNote || 'Revision'}
            >
              v{rev.revisionNumber}: {rev.revisionNote || 'Initial'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
