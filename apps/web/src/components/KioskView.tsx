import React, { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  QrCode,
  Upload,
  Printer,
  Trash2,
  CheckCircle2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { api, PrinterItem } from '../api/client';

export const KioskView: React.FC = () => {
  const [session, setSession] = useState<any | null>(null);
  const [printers, setPrinters] = useState<PrinterItem[]>([]);
  const [selectedPrinterId, setSelectedPrinterId] = useState<string>('');
  const [range, setRange] = useState<string>('');
  const [subset, setSubset] = useState<'all' | 'odd' | 'even'>('all');
  const [reverse, setReverse] = useState<boolean>(false);
  const [copies, setCopies] = useState<number>(1);
  const [duplex, setDuplex] = useState<'none' | 'long-edge' | 'short-edge'>(
    'none'
  );
  const [uploading, setUploading] = useState<boolean>(false);
  const [printing, setPrinting] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);

  const createNewWalkUpSession = async () => {
    setMessage(null);
    const created = await api.request('/kiosk/sessions', {
      method: 'POST',
      body: JSON.stringify({ maxSheetsAllowed: 50 }),
    });
    const detail = await api.request(`/kiosk/sessions/${created.sessionToken}`);
    setSession(detail.session);
    setPrinters(detail.printers || []);
    if (detail.printers?.[0]?.id) {
      setSelectedPrinterId(detail.printers[0].id);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('kiosk');
    if (urlToken) {
      api
        .request(`/kiosk/sessions/${urlToken}`)
        .then((res) => {
          setSession(res.session);
          setPrinters(res.printers || []);
          if (res.printers?.[0]?.id) setSelectedPrinterId(res.printers[0].id);
        })
        .catch(() => createNewWalkUpSession());
    } else {
      createNewWalkUpSession();
    }
  }, []);

  useEffect(() => {
    if (!session?.sessionToken || session.status !== 'PRINTING') return;
    const timer = setInterval(async () => {
      try {
        const res = await api.request(`/kiosk/sessions/${session.sessionToken}`);
        setSession(res.session);
      } catch {
        // Ignore
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [session?.sessionToken, session?.status]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !session) return;
    setUploading(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api.request(
        `/kiosk/sessions/${session.sessionToken}/upload`,
        {
          method: 'POST',
          body: form,
        }
      );
      setSession(res.session);
      setMessage(
        `Uploaded "${res.document.originalFilename}" (${res.document.pageCount} pages)`
      );
    } catch (err: any) {
      setMessage(`Upload error: ${err?.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleKioskPrint = async () => {
    if (!session) return;
    setPrinting(true);
    setMessage(null);
    try {
      const res = await api.request(
        `/kiosk/sessions/${session.sessionToken}/print`,
        {
          method: 'POST',
          body: JSON.stringify({
            printerId: selectedPrinterId,
            options: {
              range,
              subset,
              reverse,
              copies,
              duplex,
              colorMode: 'monochrome',
              mediaSize: 'A4',
            },
          }),
        }
      );
      setSession(res.session);
      setMessage(
        `Dispatched ${res.job.physicalSheets} sheet(s) to printer. Files will auto-purge upon completion.`
      );
    } catch (err: any) {
      setMessage(`Print error: ${err?.message}`);
    } finally {
      setPrinting(false);
    }
  };

  const handlePurgeNow = async () => {
    if (!session) return;
    const res = await api.request(
      `/kiosk/sessions/${session.sessionToken}/purge`,
      {
        method: 'POST',
      }
    );
    setSession(res.session);
    setMessage('All uploaded files and temporary print slices permanently erased.');
  };

  const qrUrl = session
    ? `${window.location.origin}/?kiosk=${session.sessionToken}`
    : window.location.origin;

  return (
    <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Left: Walk-Up QR Terminal Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col items-center text-center space-y-4">
        <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
          <QrCode className="w-5 h-5" />
          Personal Walk-Up QR Print Kiosk
        </div>
        <p className="text-xs text-slate-400">
          Scan with your phone over Tailscale / LAN to upload and print
          directly. Source files and slices are automatically purged immediately
          after printing.
        </p>

        <div className="p-4 bg-white rounded-2xl shadow-lg">
          <QRCodeSVG value={qrUrl} size={180} />
        </div>

        {session && (
          <div className="text-xs text-slate-400 space-y-1">
            <div>
              Session Status:{' '}
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 font-semibold">
                {session.status}
              </span>
            </div>
            <div className="text-[11px] text-slate-500">
              Max Sheets Quota: {session.maxSheetsAllowed} sheets • Auto-Purge
              Enabled
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={createNewWalkUpSession}
          className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Generate Fresh Walk-Up QR Session
        </button>
      </div>

      {/* Right: Guest Document Upload, Page Slicer & Instant Purge */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            Walk-Up Guest Print Controls
          </h3>
          {session?.documentId && (
            <button
              type="button"
              onClick={handlePurgeNow}
              className="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-xs flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Erase File Now
            </button>
          )}
        </div>

        {/* Step 1: Upload */}
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1.5">
            1. Upload PDF or Image (Opaque Ephemeral Session)
          </label>
          <label className="flex items-center justify-center gap-2 w-full py-3 px-4 border-2 border-dashed border-slate-700 hover:border-emerald-500/60 rounded-xl cursor-pointer bg-slate-950/60 text-xs text-slate-300 transition">
            <Upload className="w-4 h-4 text-emerald-400" />
            <span>
              {uploading
                ? 'Validating Magic Bytes & Uploading...'
                : session?.documentFilename
                  ? `Loaded: ${session.documentFilename} (${session.documentPageCount} pages)`
                  : 'Tap to Select PDF, PNG, or JPEG'}
            </span>
            <input
              type="file"
              accept=".pdf,image/png,image/jpeg"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>

        {/* Step 2: Page Selection & Options */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              2. Target Printer
            </label>
            <select
              value={selectedPrinterId}
              onChange={(e) => setSelectedPrinterId(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
            >
              {printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} ({p.operationalState})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Page Range
              </label>
              <input
                type="text"
                value={range}
                onChange={(e) => setRange(e.target.value)}
                placeholder="All (or e.g. 1-3, 5)"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Odd / Even Subset
              </label>
              <select
                value={subset}
                onChange={(e) => setSubset(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white"
              >
                <option value="all">All Pages</option>
                <option value="odd">Odd Pages Only</option>
                <option value="even">Even Pages Only</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Copies
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={copies}
                onChange={(e) => setCopies(Number(e.target.value || 1))}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Duplex
              </label>
              <select
                value={duplex}
                onChange={(e) => setDuplex(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white"
              >
                <option value="none">1-Sided</option>
                <option value="long-edge">2-Sided Long</option>
                <option value="short-edge">2-Sided Short</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Order
              </label>
              <button
                type="button"
                onClick={() => setReverse(!reverse)}
                className="w-full py-1.5 px-2 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200"
              >
                {reverse ? 'Reverse N→1' : 'Normal 1→N'}
              </button>
            </div>
          </div>
        </div>

        {message && (
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{message}</span>
          </div>
        )}

        <button
          type="button"
          disabled={!session?.documentId || printing}
          onClick={handleKioskPrint}
          className="w-full py-2.5 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-sm font-semibold flex items-center justify-center gap-2 transition"
        >
          <Printer className="w-4 h-4" />
          {printing
            ? 'Spooling Print Job...'
            : 'Print Now & Auto-Purge File'}
        </button>
      </div>
    </div>
  );
};
