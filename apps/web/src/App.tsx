import React, { useState, useEffect } from 'react';
import {
  Printer,
  FileText,
  FolderPlus,
  Folder,
  Upload,
  QrCode,
  Shield,
  LogOut,
  Search,
  AlertOctagon,
  CheckCircle,
  XCircle,
  RotateCcw,
  FileImage,
  Trash2,
  LayoutGrid,
} from 'lucide-react';
import {
  api,
  UserProfile,
  DocumentItem,
  PrinterItem,
  PrintJobItem,
} from './api/client';
import { PageSlicerAndPrintPanel } from './components/PageSlicerAndPrintPanel';
import { NupLayoutPanel } from './components/NupLayoutPanel';
import { PdfPreviewAndMarkup } from './components/PdfPreviewAndMarkup';
import { KioskView } from './components/KioskView';
import { AdminDashboard } from './components/AdminDashboard';

export const App: React.FC = () => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loadingAuth, setLoadingAuth] = useState<boolean>(true);
  const [username, setUsername] = useState<string>('admin');
  const [password, setPassword] = useState<string>('ozprint-admin');
  const [loginError, setLoginError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<
    'workspace' | 'queue' | 'kiosk' | 'admin'
  >(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('kiosk') ? 'kiosk' : 'workspace';
  });

  const [rightPanelMode, setRightPanelMode] = useState<'print' | 'nup'>('print');

  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocumentItem | null>(null);
  const [revisions, setRevisions] = useState<DocumentItem[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [newFolderName, setNewFolderName] = useState<string>('');

  const [printers, setPrinters] = useState<PrinterItem[]>([]);
  const [jobs, setJobs] = useState<PrintJobItem[]>([]);
  const [uploadingDoc, setUploadingDoc] = useState<boolean>(false);

  const fetchWorkspaceData = async () => {
    try {
      const [meRes, docsRes, foldersRes, printersRes, jobsRes] =
        await Promise.all([
          api.request('/auth/me'),
          api.request(
            `/documents?${new URLSearchParams({
              ...(selectedFolderId ? { folderId: selectedFolderId } : {}),
              ...(searchQuery ? { search: searchQuery } : {}),
            }).toString()}`
          ),
          api.request('/folders'),
          api.request('/printers'),
          api.request('/print-jobs'),
        ]);
      setUser(meRes.user);
      const docList: DocumentItem[] = docsRes.documents || [];
      setDocuments(docList);
      setFolders(foldersRes.folders || []);
      setPrinters(printersRes.printers || []);
      setJobs(jobsRes.jobs || []);

      if (selectedDoc) {
        const stillExists = docList.find((d) => d.id === selectedDoc.id);
        if (!stillExists) {
          setSelectedDoc(docList[0] || null);
        }
      } else if (docList.length > 0) {
        setSelectedDoc(docList[0]);
      }
    } catch {
      // Ignore if unauthenticated
    }
  };

  useEffect(() => {
    api
      .request('/auth/me')
      .then((res) => {
        setUser(res.user);
        setLoadingAuth(false);
      })
      .catch(() => {
        setLoadingAuth(false);
      });
  }, []);

  useEffect(() => {
    if (user) {
      fetchWorkspaceData();
      const timer = setInterval(fetchWorkspaceData, 3000);
      return () => clearInterval(timer);
    }
  }, [user?.id, selectedFolderId, searchQuery]);

  useEffect(() => {
    if (selectedDoc && user) {
      api
        .request(`/documents/${selectedDoc.id}/revisions`)
        .then((res) => setRevisions(res.revisions || []))
        .catch(() => setRevisions([]));
    }
  }, [selectedDoc?.id, user?.id]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      const res = await api.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      api.setToken(res.token);
      setUser(res.user);
    } catch (err: any) {
      setLoginError(err?.message || 'Login failed');
    }
  };

  const handleLogout = async () => {
    await api.request('/auth/logout', { method: 'POST' }).catch(() => {});
    api.setToken(null);
    setUser(null);
  };

  const handleUploadDocument = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploadingDoc(true);
    try {
      if (files.length > 1) {
        const form = new FormData();
        for (let i = 0; i < files.length; i++) {
          form.append('files', files[i]);
        }
        if (selectedFolderId) form.append('folderId', selectedFolderId);
        const res = await api.request('/conversions/images-to-pdf', {
          method: 'POST',
          body: form,
        });
        setSelectedDoc(res.document);
      } else {
        const form = new FormData();
        form.append('file', files[0]);
        if (selectedFolderId) form.append('folderId', selectedFolderId);
        const res = await api.request('/documents', {
          method: 'POST',
          body: form,
        });
        setSelectedDoc(res.document);
      }
      await fetchWorkspaceData();
    } catch (err: any) {
      alert(`Upload failed: ${err?.message}`);
    } finally {
      setUploadingDoc(false);
      e.target.value = '';
    }
  };

  const handleDeleteDocument = async (
    doc: DocumentItem,
    e?: React.MouseEvent
  ) => {
    if (e) e.stopPropagation();
    try {
      await api.request(`/documents/${doc.id}`, { method: 'DELETE' });
      const remaining = documents.filter((d) => d.id !== doc.id);
      setDocuments(remaining);
      if (selectedDoc?.id === doc.id) {
        setSelectedDoc(remaining[0] || null);
      }
      await fetchWorkspaceData();
    } catch (err: any) {
      alert(`Delete failed: ${err?.message}`);
    }
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    await api.request('/folders', {
      method: 'POST',
      body: JSON.stringify({ name: newFolderName }),
    });
    setNewFolderName('');
    fetchWorkspaceData();
  };

  const handleResolveUnknownJob = async (
    jobId: string,
    resolution: 'CONFIRM_COMPLETED' | 'EXPLICIT_RETRY' | 'CANCEL'
  ) => {
    await api.request(`/print-jobs/${jobId}/resolve-unknown`, {
      method: 'POST',
      body: JSON.stringify({ resolution }),
    });
    fetchWorkspaceData();
  };

  const handleCancelJob = async (jobId: string) => {
    await api.request(`/print-jobs/${jobId}/cancel`, { method: 'POST' });
    fetchWorkspaceData();
  };

  if (!user && activeTab === 'kiosk') {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
        <KioskView />
      </div>
    );
  }

  if (loadingAuth) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400 text-sm">
        Initializing OzPrint v3.0 Platform...
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-7 space-y-6 shadow-2xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
                <Printer className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-white">OzPrint v3.0</h1>
                <p className="text-xs text-slate-400">
                  Document Management & Print Orchestration
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setActiveTab('kiosk')}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-emerald-300 flex items-center gap-1"
            >
              <QrCode className="w-3.5 h-3.5" />
              Walk-Up Kiosk
            </button>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Username or Email
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>

            {loginError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition"
            >
              Sign In to OzPrint Workspace
            </button>
          </form>
        </div>
      </div>
    );
  }

  const unknownJobs = jobs.filter((j) => j.state === 'UNKNOWN');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Header */}
      <header className="bg-slate-900 border-b border-slate-800 px-6 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
              <Printer className="w-5 h-5" />
            </div>
            <div>
              <span className="font-bold text-white tracking-tight">
                OzPrint
              </span>
              <span className="ml-2 px-2 py-0.5 text-[11px] rounded bg-slate-800 text-emerald-400 font-mono">
                v3.0
              </span>
            </div>
          </div>

          <nav className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('workspace')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 ${
                activeTab === 'workspace'
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              Workspace, Slicer & Layout
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('queue')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 ${
                activeTab === 'queue'
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              <Printer className="w-3.5 h-3.5" />
              Live Print Queue ({jobs.length})
              {unknownJobs.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-slate-950 font-bold text-[10px]">
                  !
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('kiosk')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 ${
                activeTab === 'kiosk'
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              <QrCode className="w-3.5 h-3.5" />
              Walk-Up QR Kiosk
            </button>

            {user.role === 'ADMIN' && (
              <button
                type="button"
                onClick={() => setActiveTab('admin')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 ${
                  activeTab === 'admin'
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Shield className="w-3.5 h-3.5" />
                Admin, CUPS & Agents
              </button>
            )}
          </nav>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <div className="bg-slate-950 border border-slate-800 px-3 py-1.5 rounded-lg">
            <span className="text-slate-400">Monthly Quota: </span>
            <strong className="text-emerald-400">
              {user.pagesUsedCurrentPeriod}
            </strong>
            <span className="text-slate-500">
              {' '}
              / {user.monthlyPageQuota} sheets
            </span>
          </div>
          <div className="text-slate-300 font-medium">
            {user.username}{' '}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
              {user.role}
            </span>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
            title="Sign Out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* UNKNOWN State Safety Guardrail Alert */}
      {unknownJobs.length > 0 && (
        <div className="bg-amber-500/15 border-b border-amber-500/40 px-6 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-amber-200">
            <AlertOctagon className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>CUPS Communication Halt Guardrail:</strong>{' '}
              {unknownJobs.length} job(s) entered <code>UNKNOWN</code> state.
              Auto-retry is halted to prevent duplicate physical prints.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setActiveTab('queue')}
            className="px-3 py-1 rounded-lg bg-amber-500 text-slate-950 font-semibold text-xs"
          >
            Review & Confirm in Queue
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 p-6 max-w-[1600px] w-full mx-auto">
        {activeTab === 'workspace' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left Sidebar: Managed Document Library with 1-Click Delete */}
            <div className="lg:col-span-3 space-y-4">
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white">
                    Document Library ({documents.length})
                  </h2>
                  <label className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer flex items-center gap-1.5">
                    <Upload className="w-3.5 h-3.5" />
                    <span>
                      {uploadingDoc ? 'Uploading...' : 'Upload PDF / Images'}
                    </span>
                    <input
                      type="file"
                      multiple
                      accept=".pdf,image/png,image/jpeg"
                      onChange={handleUploadDocument}
                      className="hidden"
                    />
                  </label>
                </div>

                <p className="text-[11px] text-slate-400 flex items-center gap-1">
                  <FileImage className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  Select multiple PNG/JPG images to auto-compile into a single
                  PDF.
                </p>

                {/* Search */}
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search stored PDFs..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white"
                  />
                </div>

                {/* Folders */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Folders</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSelectedFolderId('')}
                      className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
                        selectedFolderId === ''
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'bg-slate-950 text-slate-400 border border-slate-800'
                      }`}
                    >
                      <Folder className="w-3 h-3" />
                      All
                    </button>
                    {folders.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setSelectedFolderId(f.id)}
                        className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
                          selectedFolderId === f.id
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-slate-950 text-slate-400 border border-slate-800'
                        }`}
                      >
                        <Folder className="w-3 h-3" />
                        {f.name}
                      </button>
                    ))}
                  </div>
                  <form
                    onSubmit={handleCreateFolder}
                    className="flex gap-1.5 pt-1"
                  >
                    <input
                      type="text"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder="New folder..."
                      className="flex-1 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-white"
                    />
                    <button
                      type="submit"
                      className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1"
                    >
                      <FolderPlus className="w-3 h-3" />
                      Add
                    </button>
                  </form>
                </div>

                {/* Stored PDF List with Delete Button */}
                <div className="space-y-1.5 max-h-[420px] overflow-y-auto pt-1">
                  {documents.length === 0 ? (
                    <div className="text-center py-8 text-xs text-slate-500">
                      No documents yet. Upload a PDF or image above.
                    </div>
                  ) : (
                    documents.map((doc) => (
                      <div
                        key={doc.id}
                        onClick={() => setSelectedDoc(doc)}
                        className={`w-full text-left p-2.5 rounded-lg border transition flex items-center justify-between gap-2 cursor-pointer ${
                          selectedDoc?.id === doc.id
                            ? 'bg-emerald-500/10 border-emerald-500/40 text-white'
                            : 'bg-slate-950 border-slate-800/80 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium truncate">
                            {doc.originalFilename}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {doc.pageCount} page
                            {doc.pageCount === 1 ? '' : 's'} • v
                            {doc.revisionNumber}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => handleDeleteDocument(doc, e)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/15 transition shrink-0"
                          title={`Delete "${doc.originalFilename}"`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Center: PDF.js Interactive Preview, Markup & True Redaction */}
            <div className="lg:col-span-5">
              {selectedDoc ? (
                <PdfPreviewAndMarkup
                  document={selectedDoc}
                  revisions={revisions}
                  onSelectRevision={(rev) => setSelectedDoc(rev)}
                  onRevisionCreated={(newDoc) => {
                    setSelectedDoc(newDoc);
                    fetchWorkspaceData();
                  }}
                />
              ) : (
                <div className="bg-slate-900 border border-slate-800 rounded-xl h-96 flex items-center justify-center text-slate-500 text-sm">
                  Select or upload a PDF document to preview, slice, or annotate
                </div>
              )}
            </div>

            {/* Right: Toggle between Granular Page Slicer & Print vs. Multi-Page Per Sheet (N-Up Layout) */}
            <div className="lg:col-span-4 space-y-3">
              {selectedDoc ? (
                <>
                  <div className="grid grid-cols-2 gap-1.5 bg-slate-900 p-1.5 rounded-xl border border-slate-800">
                    <button
                      type="button"
                      onClick={() => setRightPanelMode('print')}
                      className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                        rightPanelMode === 'print'
                          ? 'bg-emerald-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <Printer className="w-3.5 h-3.5" />
                      Slice & Print
                    </button>
                    <button
                      type="button"
                      onClick={() => setRightPanelMode('nup')}
                      className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                        rightPanelMode === 'nup'
                          ? 'bg-emerald-600 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <LayoutGrid className="w-3.5 h-3.5" />
                      Multi-Page Per Sheet
                    </button>
                  </div>

                  {rightPanelMode === 'print' ? (
                    <PageSlicerAndPrintPanel
                      document={selectedDoc}
                      printers={printers}
                      onJobSubmitted={() => {
                        fetchWorkspaceData();
                      }}
                    />
                  ) : (
                    <NupLayoutPanel
                      document={selectedDoc}
                      onConverted={(newDoc) => {
                        setSelectedDoc(newDoc);
                        fetchWorkspaceData();
                      }}
                    />
                  )}
                </>
              ) : (
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-xs text-slate-500">
                  Upload a document to configure granular page ranges,
                  multi-page per sheet layouts (2/4/6/8/9/16-up), odd/even
                  subsets, and print to CUPS.
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'queue' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
            <h2 className="text-base font-semibold text-white">
              Persistent Print Job Queue & CUPS Reconciliation State Machine
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2.5">Job ID / CUPS ID</th>
                    <th className="py-2.5">Document</th>
                    <th className="py-2.5">Printer</th>
                    <th className="py-2.5">Resolved Pages</th>
                    <th className="py-2.5">Physical Sheets</th>
                    <th className="py-2.5">Lifecycle State</th>
                    <th className="py-2.5 text-right">Safety Controls</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {jobs.map((job) => (
                    <tr key={job.jobId}>
                      <td className="py-3 font-mono text-slate-300">
                        <div>{job.jobId.slice(0, 8)}</div>
                        <div className="text-[11px] text-slate-500">
                          {job.cupsJobId || 'pending'}
                        </div>
                      </td>
                      <td className="py-3 font-medium text-white">
                        {job.documentFilename}
                      </td>
                      <td className="py-3 text-slate-300">{job.printerName}</td>
                      <td className="py-3 font-mono text-emerald-300">
                        [{job.resolvedPages.slice(0, 10).join(', ')}
                        {job.resolvedPages.length > 10 ? '...' : ''}]
                      </td>
                      <td className="py-3 font-semibold text-white">
                        {job.physicalSheets}
                      </td>
                      <td className="py-3">
                        <span
                          className={`px-2.5 py-1 rounded-full font-semibold text-[11px] ${
                            job.state === 'COMPLETED'
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : job.state === 'PROCESSING' ||
                                  job.state === 'QUEUED'
                                ? 'bg-sky-500/15 text-sky-300'
                                : job.state === 'UNKNOWN'
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                  : 'bg-rose-500/15 text-rose-300'
                          }`}
                        >
                          {job.state}
                        </span>
                        {job.errorMessage && (
                          <div className="text-[11px] text-rose-400 mt-1">
                            {job.errorMessage}
                          </div>
                        )}
                      </td>
                      <td className="py-3 text-right space-x-2">
                        {job.state === 'UNKNOWN' && (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                handleResolveUnknownJob(
                                  job.jobId,
                                  'CONFIRM_COMPLETED'
                                )
                              }
                              className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] flex items-center gap-1"
                              title="Confirm paper printed physically"
                            >
                              <CheckCircle className="w-3 h-3" />
                              Printed OK
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handleResolveUnknownJob(
                                  job.jobId,
                                  'EXPLICIT_RETRY'
                                )
                              }
                              className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-[11px] flex items-center gap-1"
                              title="Explicitly re-spool job once"
                            >
                              <RotateCcw className="w-3 h-3" />
                              Re-Spool
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handleResolveUnknownJob(job.jobId, 'CANCEL')
                              }
                              className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-[11px] flex items-center gap-1"
                            >
                              <XCircle className="w-3 h-3" />
                              Cancel
                            </button>
                          </div>
                        )}
                        {(job.state === 'PROCESSING' ||
                          job.state === 'QUEUED') && (
                          <button
                            type="button"
                            onClick={() => handleCancelJob(job.jobId)}
                            className="px-2.5 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-xs"
                          >
                            Cancel Job
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'kiosk' && <KioskView />}

        {activeTab === 'admin' && user.role === 'ADMIN' && (
          <AdminDashboard
            printers={printers}
            onRefreshPrinters={fetchWorkspaceData}
          />
        )}
      </main>
    </div>
  );
};
