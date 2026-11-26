import React, { useState, useEffect } from 'react';
import {
  Server,
  Printer,
  Users,
  Shield,
  RefreshCw,
  Plus,
  Activity,
  KeyRound,
  Trash2,
  Lock,
  X,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { api, PrinterItem } from '../api/client';

interface Props {
  printers: PrinterItem[];
  onRefreshPrinters: () => void;
}

export const AdminDashboard: React.FC<Props> = ({
  printers,
  onRefreshPrinters,
}) => {
  const [users, setUsers] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [health, setHealth] = useState<any | null>(null);
  const [newAgentName, setNewAgentName] = useState<string>('');
  const [enrolledToken, setEnrolledToken] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState<string>('');
  const [newEmail, setNewEmail] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [newQuota, setNewQuota] = useState<number>(500);
  const [discovering, setDiscovering] = useState<boolean>(false);

  const [passwordResetUser, setPasswordResetUser] = useState<any | null>(null);
  const [adminNewPassword, setAdminNewPassword] = useState<string>('');
  const [adminConfirmPassword, setAdminConfirmPassword] = useState<string>('');
  const [passwordResetError, setPasswordResetError] = useState<string | null>(null);
  const [passwordResetSuccess, setPasswordResetSuccess] = useState<string | null>(null);
  const [passwordResetLoading, setPasswordResetLoading] = useState<boolean>(false);

  const loadAdminData = async () => {
    try {
      const [uRes, aRes, lRes, hRes] = await Promise.all([
        api.request('/users'),
        api.request('/agents'),
        api.request('/audit-logs?limit=40'),
        api.request('/health/dependencies'),
      ]);
      setUsers(uRes.users || []);
      setAgents(aRes.agents || []);
      setAuditLogs(lRes.logs || []);
      setHealth(hRes);
    } catch {
      // Ignore if non-admin
    }
  };

  useEffect(() => {
    loadAdminData();
  }, []);

  const handleDiscoverPrinters = async () => {
    setDiscovering(true);
    try {
      await api.request('/printers/discover', { method: 'POST' });
      onRefreshPrinters();
      loadAdminData();
    } catch {
      onRefreshPrinters();
    } finally {
      setDiscovering(false);
    }
  };

  const handleDeletePrinter = async (printerId: string) => {
    await api.request(`/printers/${printerId}`, { method: 'DELETE' });
    onRefreshPrinters();
    loadAdminData();
  };

  const handleEnrollAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAgentName.trim()) return;
    const res = await api.request('/agents/enroll', {
      method: 'POST',
      body: JSON.stringify({ name: newAgentName }),
    });
    setEnrolledToken(res.enrollmentToken);
    setNewAgentName('');
    loadAdminData();
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername || !newEmail || !newPassword) return;
    await api.request('/users', {
      method: 'POST',
      body: JSON.stringify({
        username: newUsername,
        email: newEmail,
        password: newPassword,
        role: 'MEMBER',
        monthlyPageQuota: newQuota,
      }),
    });
    setNewUsername('');
    setNewEmail('');
    setNewPassword('');
    loadAdminData();
  };

  const handleResetUserQuota = async (userId: string) => {
    await api.request(`/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ resetQuotaUsed: true }),
    });
    loadAdminData();
  };

  const handleAdminResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordResetError(null);
    setPasswordResetSuccess(null);

    if (!adminNewPassword) {
      setPasswordResetError('Please enter a new password');
      return;
    }
    if (adminNewPassword.length < 6) {
      setPasswordResetError('Password must be at least 6 characters');
      return;
    }
    if (adminNewPassword !== adminConfirmPassword) {
      setPasswordResetError('Passwords do not match');
      return;
    }

    setPasswordResetLoading(true);
    try {
      await api.request(`/users/${passwordResetUser.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ password: adminNewPassword }),
      });
      setPasswordResetSuccess(
        `Password updated successfully for ${passwordResetUser.username}!`
      );
      setAdminNewPassword('');
      setAdminConfirmPassword('');
      setTimeout(() => {
        setPasswordResetUser(null);
        setPasswordResetSuccess(null);
      }, 1500);
    } catch (err: any) {
      setPasswordResetError(err?.message || 'Failed to update password');
    } finally {
      setPasswordResetLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* System Dependency Health Banner */}
      {health && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Activity className="w-5 h-5 text-emerald-400" />
            <div>
              <h3 className="text-sm font-semibold text-white">
                System Dependencies & Hardware Runtime
              </h3>
              <p className="text-xs text-slate-400">
                DB Driver:{' '}
                <code className="text-emerald-300">
                  {health.databaseDriver}
                </code>
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`px-2.5 py-1 rounded-full border ${
                health.dependencies?.cups?.available
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
              }`}
            >
              CUPS Daemon:{' '}
              {health.dependencies?.cups?.available
                ? 'Connected'
                : 'Not Detected'}
            </span>
            <span
              className={`px-2.5 py-1 rounded-full border ${
                health.dependencies?.pythonWorker?.ok
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  : 'bg-sky-500/10 border-sky-500/30 text-sky-300'
              }`}
            >
              PDF Engine:{' '}
              {health.dependencies?.pythonWorker?.ok
                ? 'Python (pypdf + Pillow)'
                : 'pdf-lib Active'}
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Printer Discovery & Hardware Capabilities */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Printer className="w-4 h-4 text-emerald-400" />
              Registered Local & Remote Printers ({printers.length})
            </h3>
            <button
              type="button"
              disabled={discovering}
              onClick={handleDiscoverPrinters}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white flex items-center gap-1.5"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${discovering ? 'animate-spin' : ''}`}
              />
              Scan CUPS (lpstat)
            </button>
          </div>

          <div className="space-y-2">
            {printers.length === 0 ? (
              <p className="text-xs text-slate-500 py-3">
                No printers registered yet. Click &ldquo;Scan CUPS (lpstat)&rdquo; on your
                Linux print server to detect attached printers.
              </p>
            ) : (
              printers.map((p) => (
                <div
                  key={p.id}
                  className="p-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between text-xs"
                >
                  <div>
                    <div className="font-semibold text-white">
                      {p.displayName}
                    </div>
                    <div className="text-slate-400">
                      <code>{p.systemName}</code> • {p.adapterType} • Media:{' '}
                      {(p.capabilities?.media || ['A4']).join(', ')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-medium">
                      {p.operationalState}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDeletePrinter(p.id)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/15 transition"
                      title={`Remove "${p.displayName}"`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Remote Print Agents (Layer 3 M7) */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Server className="w-4 h-4 text-sky-400" />
            Remote Print Agents (Outbound WSS /ws/agent)
          </h3>

          <form onSubmit={handleEnrollAgent} className="flex gap-2">
            <input
              type="text"
              value={newAgentName}
              onChange={(e) => setNewAgentName(e.target.value)}
              placeholder="Branch office or NAT host name..."
              className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
            />
            <button
              type="submit"
              className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white flex items-center gap-1"
            >
              <KeyRound className="w-3.5 h-3.5" />
              Enroll Agent
            </button>
          </form>

          {enrolledToken && (
            <div className="p-3 rounded-lg bg-sky-500/10 border border-sky-500/30 text-xs space-y-1">
              <div className="font-semibold text-sky-300">
                One-Time Agent Enrollment Token (Copy now):
              </div>
              <code className="block bg-slate-950 p-2 rounded text-emerald-300 break-all">
                AGENT_ENROLLMENT_TOKEN={enrolledToken}
              </code>
            </div>
          )}

          <div className="space-y-2">
            {agents.length === 0 ? (
              <p className="text-xs text-slate-500">
                No remote print agents enrolled yet.
              </p>
            ) : (
              agents.map((a) => (
                <div
                  key={a.id}
                  className="p-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between text-xs"
                >
                  <div>
                    <div className="font-semibold text-white">{a.name}</div>
                    <div className="text-slate-500">
                      Last heartbeat: {a.lastHeartbeatAt || 'Never'}
                    </div>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded font-medium ${
                      a.status === 'ONLINE'
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {a.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* User & Monthly Page Quotas */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Users className="w-4 h-4 text-emerald-400" />
          Users, RBAC & Monthly Page Quotas
        </h3>

        <form
          onSubmit={handleCreateUser}
          className="grid grid-cols-1 sm:grid-cols-5 gap-2"
        >
          <input
            type="text"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder="Username"
            className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
          />
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="Email"
            className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
          />
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Password"
            className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
          />
          <input
            type="number"
            value={newQuota}
            onChange={(e) => setNewQuota(Number(e.target.value || 500))}
            placeholder="Monthly Sheet Quota"
            className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
          />
          <button
            type="submit"
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center justify-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Member
          </button>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2">Username</th>
                <th className="py-2">Email</th>
                <th className="py-2">Role</th>
                <th className="py-2">Sheets Used / Quota</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="py-2.5 font-medium text-white">
                    {u.username}
                  </td>
                  <td className="py-2.5 text-slate-400">{u.email}</td>
                  <td className="py-2.5">
                    <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                      {u.role}
                    </span>
                  </td>
                  <td className="py-2.5 text-slate-300">
                    {u.pagesUsedCurrentPeriod} / {u.monthlyPageQuota} sheets
                  </td>
                  <td className="py-2.5 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setPasswordResetUser(u);
                          setAdminNewPassword('');
                          setAdminConfirmPassword('');
                          setPasswordResetError(null);
                          setPasswordResetSuccess(null);
                        }}
                        className="text-amber-400 hover:text-amber-300 hover:underline flex items-center gap-1 font-medium"
                        title={`Reset password for ${u.username}`}
                      >
                        <KeyRound className="w-3.5 h-3.5" />
                        <span>Change Password</span>
                      </button>
                      <span className="text-slate-700">|</span>
                      <button
                        type="button"
                        onClick={() => handleResetUserQuota(u.id)}
                        className="text-emerald-400 hover:text-emerald-300 hover:underline"
                      >
                        Reset Used Quota
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Immutable Audit Logs */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Shield className="w-4 h-4 text-amber-400" />
          Immutable Audit Trail (SQLite Trigger-Protected)
        </h3>
        <div className="max-h-64 overflow-y-auto space-y-1.5">
          {auditLogs.map((log) => (
            <div
              key={log.id}
              className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-xs"
            >
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-slate-800 text-emerald-300 font-mono">
                  {log.action}
                </span>
                <span className="text-slate-300 font-medium">
                  {log.actorUsername}
                </span>
                <span className="text-slate-500">
                  → {log.targetType} ({log.targetId?.slice(0, 8) || 'N/A'})
                </span>
              </div>
              <span className="text-[11px] text-slate-500">
                {log.createdAt}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Admin User Password Reset Modal */}
      {passwordResetUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div
            className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
            role="dialog"
            aria-modal="true"
          >
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
                  <KeyRound className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    Reset Password
                  </h3>
                  <p className="text-xs text-slate-400">
                    User: <strong className="text-white">{passwordResetUser.username}</strong> ({passwordResetUser.role})
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPasswordResetUser(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAdminResetPassword} className="p-6 space-y-4">
              {passwordResetError && (
                <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                  <span>{passwordResetError}</span>
                </div>
              )}

              {passwordResetSuccess && (
                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
                  <span>{passwordResetSuccess}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  value={adminNewPassword}
                  onChange={(e) => setAdminNewPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  autoComplete="new-password"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  value={adminConfirmPassword}
                  onChange={(e) => setAdminConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password"
                  autoComplete="new-password"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setPasswordResetUser(null)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-300 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={passwordResetLoading}
                  className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-xs font-semibold text-white transition flex items-center gap-1.5"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>
                    {passwordResetLoading ? 'Updating...' : 'Set Password'}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
