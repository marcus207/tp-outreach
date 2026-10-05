import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { analyticsApi } from '../lib/api';
import { Shield, CheckCircle, AlertTriangle, XCircle, RefreshCw, TrendingUp, Mail, Eye, UserMinus } from 'lucide-react';

function StatusBadge({ status }: { status: string }) {
  if (status === 'PASS') return <span className="flex items-center gap-1 text-emerald-400 text-sm font-medium"><CheckCircle size={14} /> Pass</span>;
  if (status === 'WARN') return <span className="flex items-center gap-1 text-amber-400 text-sm font-medium"><AlertTriangle size={14} /> Warning</span>;
  return <span className="flex items-center gap-1 text-red-400 text-sm font-medium"><XCircle size={14} /> Fail</span>;
}

function ScoreRing({ score }: { score: number }) {
  const color = score >= 8 ? '#10b981' : score >= 5 ? '#f59e0b' : '#dc2626';
  const pct = (score / 10) * 100;
  const r = 54;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;

  return (
    <div className="relative w-36 h-36 mx-auto">
      <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="#1A2A3D" strokeWidth="8" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.5s ease' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold" style={{ color }}>{score}</span>
        <span className="text-xs text-[#6B7E8F]">out of 10</span>
      </div>
    </div>
  );
}

export default function Deliverability() {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['deliverability'],
    queryFn: () => analyticsApi.deliverability().then(r => r.data),
  });

  const runCheck = async () => {
    setRunning(true);
    try {
      await analyticsApi.runDeliverabilityCheck();
      queryClient.invalidateQueries({ queryKey: ['deliverability'] });
    } catch (e) {
      console.error('Check failed:', e);
    }
    setRunning(false);
  };

  const latest = data?.latest;
  const history = data?.history || [];

  if (isLoading) return <div className="p-8 text-[#6B7E8F]">Loading...</div>;

  if (!latest) return (
    <div className="p-8">
      <h1 className="text-xl font-bold text-white mb-4">Email Deliverability</h1>
      <p className="text-[#6B7E8F] mb-4">No checks have been run yet.</p>
      <button onClick={runCheck} disabled={running}
        className="px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm flex items-center gap-2">
        <RefreshCw size={14} className={running ? 'animate-spin' : ''} /> Run Check Now
      </button>
    </div>
  );

  const accounts = typeof latest.account_stats === 'string' ? JSON.parse(latest.account_stats) : (latest.account_stats || []);
  const spfIssues = typeof latest.spf_issues === 'string' ? JSON.parse(latest.spf_issues) : (latest.spf_issues || []);
  const dkimIssues = typeof latest.dkim_issues === 'string' ? JSON.parse(latest.dkim_issues) : (latest.dkim_issues || []);
  const dmarcIssues = typeof latest.dmarc_issues === 'string' ? JSON.parse(latest.dmarc_issues) : (latest.dmarc_issues || []);
  const blacklistListed = typeof latest.blacklist_listed === 'string' ? JSON.parse(latest.blacklist_listed) : (latest.blacklist_listed || []);
  const allIssues = [
    ...spfIssues.map((i: string) => ({ check: 'SPF', issue: i })),
    ...dkimIssues.map((i: string) => ({ check: 'DKIM', issue: i })),
    ...dmarcIssues.map((i: string) => ({ check: 'DMARC', issue: i })),
    ...blacklistListed.map((bl: string) => ({ check: 'Blacklist', issue: `Listed on ${bl}` })),
  ];

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2"><Shield size={20} /> Email Deliverability</h1>
          <p className="text-[#6B7E8F] text-sm mt-1">
            Last checked {new Date(latest.checked_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
        <button onClick={runCheck} disabled={running}
          className="px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
          <RefreshCw size={14} className={running ? 'animate-spin' : ''} /> {running ? 'Running...' : 'Run Check Now'}
        </button>
      </div>

      {/* Score + Auth Checks */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-6">
          <p className="text-[#6B7E8F] text-xs uppercase tracking-widest text-center mb-3">Overall Score</p>
          <ScoreRing score={Number(latest.overall_score)} />
        </div>

        <div className="lg:col-span-2 bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-6">
          <p className="text-white font-semibold text-sm mb-4">Authentication Checks</p>
          <div className="space-y-3">
            {[
              { name: 'SPF', score: latest.spf_score, status: latest.spf_status, detail: latest.spf_record },
              { name: 'DKIM', score: latest.dkim_score, status: latest.dkim_status, detail: `Selector: ${latest.dkim_selector || 'none'}` },
              { name: 'DMARC', score: latest.dmarc_score, status: latest.dmarc_status, detail: latest.dmarc_record },
              { name: 'Blacklists', score: latest.blacklist_score, status: latest.blacklist_status, detail: `${latest.blacklist_clean}/${latest.blacklist_total} clean` },
              { name: 'Reverse DNS', score: latest.rdns_score, status: latest.rdns_status, detail: latest.rdns_ptr },
            ].map(c => (
              <div key={c.name} className="flex items-center justify-between py-2 border-b border-[#1A2A3D] last:border-0">
                <div>
                  <span className="text-white text-sm font-medium">{c.name}</span>
                  <span className="text-[#6B7E8F] text-xs ml-3">{c.detail}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-[#6B7E8F] text-sm">{c.score}/10</span>
                  <StatusBadge status={c.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 7-Day Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 flex items-center gap-3">
          <Mail size={20} className="text-teal-400" />
          <div>
            <div className="text-2xl font-bold text-white">{(latest.total_sent_7d || 0).toLocaleString()}</div>
            <div className="text-[#6B7E8F] text-xs">Sent (7 days)</div>
          </div>
        </div>
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 flex items-center gap-3">
          <Eye size={20} className="text-blue-400" />
          <div>
            <div className="text-2xl font-bold text-white">{latest.open_rate_7d || 0}%</div>
            <div className="text-[#6B7E8F] text-xs">Open Rate (7 days)</div>
          </div>
        </div>
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 flex items-center gap-3">
          <UserMinus size={20} className="text-amber-400" />
          <div>
            <div className="text-2xl font-bold text-white">{latest.unsubscribes_7d || 0}</div>
            <div className="text-[#6B7E8F] text-xs">Unsubscribes (7 days)</div>
          </div>
        </div>
      </div>

      {/* Per-Account Stats */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-6 mb-6">
        <p className="text-white font-semibold text-sm mb-4">Account Performance (7 days)</p>
        <table className="w-full">
          <thead>
            <tr className="text-[#6B7E8F] text-xs uppercase">
              <th className="text-left pb-3">Account</th>
              <th className="text-center pb-3">Sent</th>
              <th className="text-center pb-3">Bounced</th>
              <th className="text-center pb-3">Failed</th>
              <th className="text-center pb-3">Bounce Rate</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a: any) => (
              <tr key={a.email} className="border-t border-[#1A2A3D]">
                <td className="py-3 text-white text-sm">{a.email}</td>
                <td className="py-3 text-center text-[#e0e0e0] text-sm">{(a.sent || 0).toLocaleString()}</td>
                <td className="py-3 text-center text-[#e0e0e0] text-sm">{a.bounced || 0}</td>
                <td className="py-3 text-center text-[#e0e0e0] text-sm">{a.failed || 0}</td>
                <td className="py-3 text-center text-sm font-semibold" style={{
                  color: (a.bounce_rate || 0) > 2 ? '#dc2626' : (a.bounce_rate || 0) > 0.5 ? '#f59e0b' : '#10b981'
                }}>{a.bounce_rate || 0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Issues */}
      {allIssues.length > 0 && (
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-6 mb-6">
          <p className="text-white font-semibold text-sm mb-4">Issues</p>
          <div className="space-y-2">
            {allIssues.map((item: any, i: number) => (
              <div key={i} className="flex items-center gap-3 py-2 border-b border-[#1A2A3D] last:border-0">
                <span className="text-amber-400 text-xs font-medium bg-amber-400/10 px-2 py-0.5 rounded">{item.check}</span>
                <span className="text-[#e0e0e0] text-sm">{item.issue}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 1 && (
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-6">
          <p className="text-white font-semibold text-sm mb-4">Check History</p>
          <table className="w-full">
            <thead>
              <tr className="text-[#6B7E8F] text-xs uppercase">
                <th className="text-left pb-3">Date</th>
                <th className="text-center pb-3">Score</th>
                <th className="text-center pb-3">SPF</th>
                <th className="text-center pb-3">DKIM</th>
                <th className="text-center pb-3">DMARC</th>
                <th className="text-center pb-3">Blacklists</th>
                <th className="text-center pb-3">Sent</th>
                <th className="text-center pb-3">Open Rate</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h: any) => (
                <tr key={h.id} className="border-t border-[#1A2A3D]">
                  <td className="py-2 text-[#e0e0e0] text-sm">{new Date(h.checked_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td>
                  <td className="py-2 text-center text-white text-sm font-bold">{h.overall_score}</td>
                  <td className="py-2 text-center"><StatusBadge status={h.spf_status} /></td>
                  <td className="py-2 text-center"><StatusBadge status={h.dkim_status} /></td>
                  <td className="py-2 text-center"><StatusBadge status={h.dmarc_status} /></td>
                  <td className="py-2 text-center"><StatusBadge status={h.blacklist_status} /></td>
                  <td className="py-2 text-center text-[#e0e0e0] text-sm">{(h.total_sent_7d || 0).toLocaleString()}</td>
                  <td className="py-2 text-center text-[#e0e0e0] text-sm">{h.open_rate_7d || 0}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
