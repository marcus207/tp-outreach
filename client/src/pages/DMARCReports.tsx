import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { analyticsApi } from '../lib/api';
import { Shield, CheckCircle, AlertTriangle, XCircle, RefreshCw, Globe, Server, Mail, TrendingUp } from 'lucide-react';

function PassBadge({ pass, total }: { pass: number; total: number }) {
  const pct = total > 0 ? (pass / total) * 100 : 100;
  if (pct >= 99) return <span className="flex items-center gap-1 text-emerald-400 text-sm font-medium"><CheckCircle size={14} /> {pct.toFixed(1)}%</span>;
  if (pct >= 90) return <span className="flex items-center gap-1 text-amber-400 text-sm font-medium"><AlertTriangle size={14} /> {pct.toFixed(1)}%</span>;
  return <span className="flex items-center gap-1 text-red-400 text-sm font-medium"><XCircle size={14} /> {pct.toFixed(1)}%</span>;
}

function ScoreRing({ pct }: { pct: number }) {
  const color = pct >= 99 ? '#10b981' : pct >= 90 ? '#f59e0b' : '#dc2626';
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
        <span className="text-3xl font-bold" style={{ color }}>{pct.toFixed(1)}%</span>
        <span className="text-xs text-[#6B7E8F]">DMARC pass</span>
      </div>
    </div>
  );
}

export default function DMARCReports() {
  const queryClient = useQueryClient();
  const [scanning, setScanning] = useState(false);
  const [days, setDays] = useState(30);

  const { data, isLoading } = useQuery({
    queryKey: ['dmarc', days],
    queryFn: () => analyticsApi.dmarc(days).then(r => r.data),
  });

  const runScan = async () => {
    setScanning(true);
    try {
      await analyticsApi.dmarcScan();
      queryClient.invalidateQueries({ queryKey: ['dmarc'] });
    } catch (e) {
      console.error('DMARC scan failed:', e);
    }
    setScanning(false);
  };

  const summary = data?.summary;
  const byOrg = data?.by_org || [];
  const daily = data?.daily || [];
  const reports = data?.reports || [];

  if (isLoading) return <div className="p-8 text-[#6B7E8F]">Loading...</div>;

  if (!summary || summary.total_reports === 0) return (
    <div className="p-8">
      <h1 className="text-xl font-bold text-white mb-2 flex items-center gap-2"><Shield size={20} className="text-teal-400" /> DMARC Reports</h1>
      <p className="text-[#6B7E8F] mb-4">No DMARC reports found. Click scan to fetch reports from Gmail and archive them from your inbox.</p>
      <button onClick={runScan} disabled={scanning}
        className="px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
        <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} /> {scanning ? 'Scanning Gmail...' : 'Scan & Archive'}
      </button>
    </div>
  );

  return (
    <div className="p-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2"><Shield size={20} className="text-teal-400" /> DMARC Reports</h1>
          <p className="text-[#6B7E8F] text-sm mt-1">
            {summary.total_reports} report{summary.total_reports !== 1 ? 's' : ''} covering {summary.total_messages.toLocaleString()} messages
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select value={days} onChange={e => setDays(Number(e.target.value))}
            className="bg-[#0D1B2A] border border-[#1A2A3D] text-white text-sm rounded-lg px-3 py-2">
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <button onClick={runScan} disabled={scanning}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
            <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} /> {scanning ? 'Scanning...' : 'Scan & Archive'}
          </button>
        </div>
      </div>

      {/* Overall Score + Auth Rates */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-6">
          <ScoreRing pct={summary.pass_rate} />
        </div>
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 flex items-center gap-3">
          <Mail size={20} className="text-teal-400" />
          <div>
            <div className="text-2xl font-bold text-white">{summary.total_messages.toLocaleString()}</div>
            <div className="text-[#6B7E8F] text-xs">Messages Checked</div>
          </div>
        </div>
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 flex items-center gap-3">
          <CheckCircle size={20} className="text-emerald-400" />
          <div>
            <div className="text-2xl font-bold text-white">{summary.spf_pass_rate}%</div>
            <div className="text-[#6B7E8F] text-xs">SPF Pass Rate</div>
          </div>
        </div>
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 flex items-center gap-3">
          <CheckCircle size={20} className="text-emerald-400" />
          <div>
            <div className="text-2xl font-bold text-white">{summary.dkim_pass_rate}%</div>
            <div className="text-[#6B7E8F] text-xs">DKIM Pass Rate</div>
          </div>
        </div>
      </div>

      {/* Daily Trend */}
      {daily.length > 1 && (
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-6 mb-6">
          <p className="text-white font-semibold text-sm mb-4 flex items-center gap-2">
            <TrendingUp size={16} /> Daily Authentication Volume
          </p>
          <div className="h-32 flex items-end gap-1">
            {daily.map((d: any) => {
              const maxVal = Math.max(...daily.map((dd: any) => dd.messages), 1);
              const total = d.messages || 0;
              const passH = total > 0 ? (d.pass_count / maxVal) * 100 : 0;
              const failH = total > 0 ? (d.fail_count / maxVal) * 100 : 0;
              return (
                <div key={d.date} className="flex-1 flex flex-col items-center gap-0" title={`${d.date}: ${d.pass_count} pass, ${d.fail_count} fail`}>
                  <div className="w-full flex flex-col justify-end" style={{ height: '100px' }}>
                    {failH > 0 && <div className="w-full bg-red-500/60 rounded-t-sm" style={{ height: `${failH}%`, minHeight: failH > 0 ? '2px' : 0 }} />}
                    <div className="w-full bg-emerald-500/60 rounded-t-sm" style={{ height: `${passH}%`, minHeight: passH > 0 ? '2px' : 0 }} />
                  </div>
                  {daily.length <= 14 && (
                    <span className="text-[#6B7E8F] text-[9px] mt-1 whitespace-nowrap">
                      {new Date(d.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-4 mt-3">
            <div className="flex items-center gap-1.5 text-[#6B7E8F] text-xs">
              <div className="w-3 h-3 rounded-sm bg-emerald-500/60" /> Pass
            </div>
            <div className="flex items-center gap-1.5 text-[#6B7E8F] text-xs">
              <div className="w-3 h-3 rounded-sm bg-red-500/60" /> Fail
            </div>
          </div>
        </div>
      )}

      {/* Reporting Organisations */}
      {byOrg.length > 0 && (
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-6 mb-6">
          <p className="text-white font-semibold text-sm mb-4 flex items-center gap-2">
            <Globe size={16} /> Reporting Organisations
          </p>
          <table className="w-full">
            <thead>
              <tr className="text-[#6B7E8F] text-xs uppercase">
                <th className="text-left pb-3">Organisation</th>
                <th className="text-center pb-3">Reports</th>
                <th className="text-center pb-3">Messages</th>
                <th className="text-center pb-3">Pass</th>
                <th className="text-center pb-3">Fail</th>
                <th className="text-center pb-3">Pass Rate</th>
              </tr>
            </thead>
            <tbody>
              {byOrg.map((o: any) => (
                <tr key={o.org_name} className="border-t border-[#1A2A3D]">
                  <td className="py-3 text-white text-sm">{o.org_name}</td>
                  <td className="py-3 text-center text-[#e0e0e0] text-sm">{o.report_count}</td>
                  <td className="py-3 text-center text-[#e0e0e0] text-sm">{o.total_messages.toLocaleString()}</td>
                  <td className="py-3 text-center text-emerald-400 text-sm">{o.pass_count.toLocaleString()}</td>
                  <td className="py-3 text-center text-sm" style={{ color: o.fail_count > 0 ? '#dc2626' : '#6B7E8F' }}>
                    {o.fail_count}
                  </td>
                  <td className="py-3 text-center">
                    <PassBadge pass={o.pass_count} total={o.total_messages} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Individual Reports */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-6 mb-6">
        <p className="text-white font-semibold text-sm mb-4 flex items-center gap-2">
          <Server size={16} /> Report History
        </p>
        <table className="w-full">
          <thead>
            <tr className="text-[#6B7E8F] text-xs uppercase">
              <th className="text-left pb-3">Period</th>
              <th className="text-left pb-3">From</th>
              <th className="text-center pb-3">Messages</th>
              <th className="text-center pb-3">SPF</th>
              <th className="text-center pb-3">DKIM</th>
              <th className="text-center pb-3">Overall</th>
            </tr>
          </thead>
          <tbody>
            {reports.slice(0, 50).map((r: any) => (
              <tr key={r.id} className="border-t border-[#1A2A3D]">
                <td className="py-2 text-[#e0e0e0] text-sm">
                  {new Date(r.date_begin).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  {' - '}
                  {new Date(r.date_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </td>
                <td className="py-2 text-white text-sm">{r.org_name}</td>
                <td className="py-2 text-center text-[#e0e0e0] text-sm">{r.total_messages}</td>
                <td className="py-2 text-center">
                  <PassBadge pass={r.spf_pass} total={r.total_messages} />
                </td>
                <td className="py-2 text-center">
                  <PassBadge pass={r.dkim_pass} total={r.total_messages} />
                </td>
                <td className="py-2 text-center">
                  <PassBadge pass={r.pass_count} total={r.total_messages} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {reports.length === 0 && (
          <p className="text-[#6B7E8F] text-sm text-center py-4">No reports found for this period</p>
        )}
      </div>

      {/* Source IPs from latest report */}
      {reports.length > 0 && reports[0].source_ips?.length > 0 && (
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-6">
          <p className="text-white font-semibold text-sm mb-4">Source IPs (Latest Report)</p>
          <table className="w-full">
            <thead>
              <tr className="text-[#6B7E8F] text-xs uppercase">
                <th className="text-left pb-3">IP Address</th>
                <th className="text-center pb-3">Messages</th>
                <th className="text-center pb-3">SPF</th>
                <th className="text-center pb-3">DKIM</th>
                <th className="text-center pb-3">Disposition</th>
              </tr>
            </thead>
            <tbody>
              {reports[0].source_ips.map((ip: any, i: number) => (
                <tr key={i} className="border-t border-[#1A2A3D]">
                  <td className="py-2 text-white text-sm font-mono">{ip.ip}</td>
                  <td className="py-2 text-center text-[#e0e0e0] text-sm">{ip.count}</td>
                  <td className="py-2 text-center text-sm" style={{ color: ip.spf === 'pass' ? '#10b981' : '#dc2626' }}>
                    {ip.spf}
                  </td>
                  <td className="py-2 text-center text-sm" style={{ color: ip.dkim === 'pass' ? '#10b981' : '#dc2626' }}>
                    {ip.dkim}
                  </td>
                  <td className="py-2 text-center text-[#e0e0e0] text-sm">{ip.disposition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
