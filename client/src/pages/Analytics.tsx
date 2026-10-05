import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { analyticsApi } from '../lib/api';
import {
  Mail, MousePointer, MessageSquare, Users, Activity,
  AlertTriangle, UserMinus, Radio, Send, XCircle,
  CheckCircle, Clock, BarChart2, Building2, CalendarOff,
  Zap, TrendingUp,
} from 'lucide-react';

function StatCard({ label, value, sub, color = '#1993C5', icon }: {
  label: string; value: string | number; sub?: string; color?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5">
      <div className="flex items-center gap-2 text-[#6B7E8F] text-sm mb-1">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-bold" style={{ color }}>{value}</div>
      {sub && <div className="text-[#6B7E8F] text-xs mt-1">{sub}</div>}
    </div>
  );
}

export default function Analytics() {
  const [days, setDays] = useState(7);

  const { data: overview } = useQuery({
    queryKey: ['analytics', 'overview', days],
    queryFn: () => analyticsApi.overview(days).then((r) => r.data),
  });

  const { data: overview24h } = useQuery({
    queryKey: ['analytics', 'overview', 1],
    queryFn: () => analyticsApi.overview(1).then((r) => r.data),
    refetchInterval: 60000,
  });

  const { data: overview7d } = useQuery({
    queryKey: ['analytics', 'overview', 7],
    queryFn: () => analyticsApi.overview(7).then((r) => r.data),
    refetchInterval: 60000,
  });

  const { data: daily } = useQuery({
    queryKey: ['analytics', 'daily', days],
    queryFn: () => analyticsApi.daily(days).then((r) => r.data),
  });

  const { data: accounts } = useQuery({
    queryKey: ['analytics', 'accounts', days],
    queryFn: () => analyticsApi.accounts(days).then((r) => r.data),
    refetchInterval: 60000,
  });

  const { data: campaigns } = useQuery({
    queryKey: ['analytics', 'campaigns', days],
    queryFn: () => analyticsApi.campaigns(days).then((r) => r.data),
  });

  const { data: failedEmails } = useQuery({
    queryKey: ['analytics', 'failed-emails', days],
    queryFn: () => analyticsApi.failedEmails(days).then((r) => r.data),
    refetchInterval: 60000,
  });

  const { data: broadcasts } = useQuery({
    queryKey: ['analytics', 'broadcasts'],
    queryFn: () => analyticsApi.broadcasts().then((r) => r.data),
  });

  const { data: stale } = useQuery({
    queryKey: ['analytics', 'stale-contacts'],
    queryFn: () => analyticsApi.staleContacts().then((r) => r.data),
  });

  const { data: recent } = useQuery({
    queryKey: ['analytics', 'recent'],
    queryFn: () => analyticsApi.recent().then((r) => r.data),
    refetchInterval: 30000,
  });

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const formatHour = (hourStr: string) => {
    const d = new Date(hourStr);
    return `${d.getUTCHours().toString().padStart(2, '0')}:00`;
  };

  const o = overview as any;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-[#E0E8EE] text-2xl font-bold">Analytics</h1>
        <p className="text-[#6B7E8F] text-sm mt-1">Email performance overview</p>
      </div>

      {/* Performance Overview — 24h vs 7d */}
      {(overview24h || overview7d) && (() => {
        const d = overview24h as any;
        const w = overview7d as any;
        const rows = [
          { label: 'Emails Sent', d: (d?.total_sent ?? 0).toLocaleString(), w: (w?.total_sent ?? 0).toLocaleString(), color: '#74DFF6' },
          { label: 'Open Rate', d: `${d?.open_rate ?? 0}%`, w: `${w?.open_rate ?? 0}%`, detail_d: `${(d?.unique_opens ?? 0).toLocaleString()} opens`, detail_w: `${(w?.unique_opens ?? 0).toLocaleString()} opens`, color: '#1993C5' },
          { label: 'Click Rate', d: `${d?.click_rate ?? 0}%`, w: `${w?.click_rate ?? 0}%`, detail_d: `${(d?.unique_clicks ?? 0).toLocaleString()} clicks`, detail_w: `${(w?.unique_clicks ?? 0).toLocaleString()} clicks`, color: '#1993C5' },
          { label: 'Reply Rate', d: `${d?.reply_rate ?? 0}%`, w: `${w?.reply_rate ?? 0}%`, detail_d: `${d?.total_replies ?? 0} replies`, detail_w: `${w?.total_replies ?? 0} replies`, color: '#22c55e' },
          { label: 'Failed', d: (d?.total_failed ?? 0).toLocaleString(), w: (w?.total_failed ?? 0).toLocaleString(), color: (d?.total_failed ?? 0) > 0 || (w?.total_failed ?? 0) > 0 ? '#dc2626' : '#6B7E8F' },
          { label: 'Bounced', d: (d?.total_bounced ?? 0).toLocaleString(), w: (w?.total_bounced ?? 0).toLocaleString(), color: (d?.total_bounced ?? 0) > 0 || (w?.total_bounced ?? 0) > 0 ? '#dc2626' : '#6B7E8F' },
          { label: 'Auto-Replies', d: (d?.total_auto_replies ?? 0).toLocaleString(), w: (w?.total_auto_replies ?? 0).toLocaleString(), color: '#6B7E8F' },
          { label: 'Out of Office', d: (d?.total_ooo ?? 0).toLocaleString(), w: (w?.total_ooo ?? 0).toLocaleString(), color: '#f59e0b' },
          { label: 'Unsubscribes', d: (d?.total_unsubscribes ?? 0).toLocaleString(), w: (w?.total_unsubscribes ?? 0).toLocaleString(), color: (d?.total_unsubscribes ?? 0) > 0 || (w?.total_unsubscribes ?? 0) > 0 ? '#f59e0b' : '#6B7E8F' },
          { label: 'Left Company', d: (d?.total_left_company ?? 0).toLocaleString(), w: (w?.total_left_company ?? 0).toLocaleString(), color: '#dc2626' },
          { label: 'Enrollments', d: (d?.active_enrollments ?? 0).toLocaleString(), w: (w?.active_enrollments ?? 0).toLocaleString(), detail_d: `${d?.cancelled_enrollments ?? 0} cancelled`, detail_w: `${w?.cancelled_enrollments ?? 0} cancelled`, color: '#f59e0b' },
          { label: 'Broadcasts', d: (d?.total_broadcasts ?? 0).toLocaleString(), w: (w?.total_broadcasts ?? 0).toLocaleString(), detail_d: `${(d?.broadcast_sent ?? 0).toLocaleString()} sent`, detail_w: `${(w?.broadcast_sent ?? 0).toLocaleString()} sent`, color: '#a78bfa' },
        ];
        return (
          <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg mb-6 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1A2A3D]">
                  <th className="text-left text-[#6B7E8F] font-medium py-3 px-5 w-1/3">Metric</th>
                  <th className="text-right text-[#6B7E8F] font-medium py-3 px-5 w-1/3">Last 24 Hours</th>
                  <th className="text-right text-[#6B7E8F] font-medium py-3 px-5 w-1/3">Last 7 Days</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.label} className={i < rows.length - 1 ? 'border-b border-[#1A2A3D]/50' : ''}>
                    <td className="py-3 px-5 text-[#E0E8EE] font-medium">{row.label}</td>
                    <td className="py-3 px-5 text-right">
                      <span className="text-lg font-bold" style={{ color: row.color }}>{row.d}</span>
                      {(row as any).detail_d && <div className="text-[#6B7E8F] text-xs mt-0.5">{(row as any).detail_d}</div>}
                    </td>
                    <td className="py-3 px-5 text-right">
                      <span className="text-lg font-bold" style={{ color: row.color }}>{row.w}</span>
                      {(row as any).detail_w && <div className="text-[#6B7E8F] text-xs mt-0.5">{(row as any).detail_w}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })()}

      {/* Hourly Send Volume — last 24h bar chart */}
      {recent && (recent as any).hourly?.length > 0 && (
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-6">
          <h2 className="text-[#E0E8EE] font-semibold mb-4">Hourly Send Volume (24h)</h2>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={(recent as any).hourly}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A2A3D" />
              <XAxis
                dataKey="hour"
                tickFormatter={formatHour}
                stroke="#6B7E8F"
                tick={{ fill: '#6B7E8F', fontSize: 10 }}
              />
              <YAxis stroke="#6B7E8F" tick={{ fill: '#6B7E8F', fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#0D1B2A', border: '1px solid #1A2A3D', borderRadius: 6 }}
                labelStyle={{ color: '#B0BEC5' }}
                labelFormatter={formatHour}
              />
              <Bar dataKey="sent" fill="#1993C5" radius={[2, 2, 0, 0]} name="Sent" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Daily Chart */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[#E0E8EE] font-semibold">Daily Send Volume</h2>
          <div className="flex gap-2">
            {[1, 7, 14, 30].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1 rounded text-sm transition-colors ${
                  days === d
                    ? 'bg-[#1993C5] text-white'
                    : 'text-[#6B7E8F] hover:text-[#B0BEC5]'
                }`}
              >
                {d === 1 ? '24h' : `${d}d`}
              </button>
            ))}
          </div>
        </div>

        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={daily || []}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1A2A3D" />
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              stroke="#6B7E8F"
              tick={{ fill: '#6B7E8F', fontSize: 11 }}
            />
            <YAxis stroke="#6B7E8F" tick={{ fill: '#6B7E8F', fontSize: 11 }} />
            <Tooltip
              contentStyle={{ background: '#0D1B2A', border: '1px solid #1A2A3D', borderRadius: 6 }}
              labelStyle={{ color: '#B0BEC5' }}
              itemStyle={{ color: '#74DFF6' }}
              labelFormatter={formatDate}
            />
            <Line
              type="monotone"
              dataKey="sent"
              stroke="#1993C5"
              strokeWidth={2}
              dot={false}
              name="Sent"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Account Health */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-6">
        <h2 className="text-[#E0E8EE] font-semibold mb-4">Sending Account Health</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#6B7E8F] border-b border-[#1A2A3D]">
                <th className="text-left py-2 pr-4">Account</th>
                <th className="text-right py-2 pr-4">Today</th>
                <th className="text-right py-2 pr-4">This Hour</th>
                <th className="text-right py-2 pr-4">Sent</th>
                <th className="text-right py-2 pr-4">Failed</th>
                <th className="text-right py-2 pr-4">Fail Rate</th>
                <th className="text-right py-2 pr-4">Queued</th>
                <th className="text-right py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {(accounts || []).map((acc: any) => {
                const dailyPct = (acc.sends_today / acc.daily_limit) * 100;
                const failRate = parseFloat(acc.fail_rate) || 0;
                return (
                  <tr key={acc.id} className="border-b border-[#1A2A3D]/50 hover:bg-[#1A2A3D]/20">
                    <td className="py-2.5 pr-4">
                      <div className="text-[#B0BEC5]">{acc.display_name || acc.email}</div>
                      {acc.display_name && <div className="text-[#6B7E8F] text-xs">{acc.email}</div>}
                      <div className="text-[#6B7E8F] text-xs">
                        Limits: {acc.daily_limit}/day, {acc.hourly_limit}/hr
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <span className={dailyPct > 80 ? 'text-amber-400' : 'text-[#B0BEC5]'}>
                        {acc.sends_today}
                      </span>
                      <span className="text-[#6B7E8F] text-xs">/{acc.daily_limit}</span>
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <span className="text-[#B0BEC5]">{acc.sends_this_hour}</span>
                      <span className="text-[#6B7E8F] text-xs">/{acc.hourly_limit}</span>
                    </td>
                    <td className="py-2.5 pr-4 text-right text-[#B0BEC5]">
                      {parseInt(acc.total_sent || 0).toLocaleString()}
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <span className={parseInt(acc.total_failed || 0) > 0 ? 'text-red-400' : 'text-[#6B7E8F]'}>
                        {parseInt(acc.total_failed || 0).toLocaleString()}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <span className={`font-semibold ${
                        failRate > 2 ? 'text-red-400' : failRate > 0.5 ? 'text-amber-400' : 'text-emerald-400'
                      }`}>
                        {failRate}%
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-right text-[#6B7E8F]">
                      {parseInt(acc.total_queued || 0).toLocaleString()}
                    </td>
                    <td className="py-2.5 text-right">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        acc.is_active
                          ? 'bg-green-900/30 text-green-400'
                          : 'bg-red-900/30 text-red-400'
                      }`}>
                        {acc.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {(!accounts || accounts.length === 0) && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-[#6B7E8F]">
                    No email accounts connected
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Failed Emails */}
      {failedEmails && (failedEmails as any).emails?.length > 0 && (
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-6">
          <h2 className="text-[#E0E8EE] font-semibold mb-4">
            <XCircle size={16} className="inline mr-2 text-red-400" />
            Failed Emails ({(failedEmails as any).emails.length})
          </h2>

          {(failedEmails as any).summary?.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {(failedEmails as any).summary.map((s: any) => (
                <span key={s.reason} className="text-xs px-2 py-1 rounded bg-red-900/20 text-red-400 border border-red-900/30">
                  {s.reason}: {parseInt(s.count).toLocaleString()}
                </span>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#6B7E8F] border-b border-[#1A2A3D]">
                  <th className="text-left py-2 pr-4">Contact</th>
                  <th className="text-left py-2 pr-4">From</th>
                  <th className="text-left py-2 pr-4">Sequence</th>
                  <th className="text-left py-2 pr-4">Error</th>
                  <th className="text-left py-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {(failedEmails as any).emails.map((f: any) => (
                  <tr key={f.id} className="border-b border-[#1A2A3D]/50 hover:bg-[#1A2A3D]/20">
                    <td className="py-2.5 pr-4">
                      <div className="text-[#B0BEC5]">{f.first_name} {f.last_name}</div>
                      <div className="text-[#6B7E8F] text-xs">{f.to_email}</div>
                      {f.company && <div className="text-[#6B7E8F] text-xs">{f.company}</div>}
                    </td>
                    <td className="py-2.5 pr-4 text-[#6B7E8F] text-xs">{f.from_email}</td>
                    <td className="py-2.5 pr-4 text-[#6B7E8F] text-xs max-w-[180px] truncate">{f.sequence_name || '-'}</td>
                    <td className="py-2.5 pr-4">
                      <span className="text-xs text-red-400">{f.error_message || 'Unknown error'}</span>
                    </td>
                    <td className="py-2.5 text-[#6B7E8F] text-xs whitespace-nowrap">
                      {new Date(f.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      {' '}
                      {new Date(f.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Broadcast History */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-6">
        <h2 className="text-[#E0E8EE] font-semibold mb-4">Article Broadcasts</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#6B7E8F] border-b border-[#1A2A3D]">
                <th className="text-left py-2 pr-4">Article</th>
                <th className="text-left py-2 pr-4">Sector</th>
                <th className="text-right py-2 pr-4">Contacts</th>
                <th className="text-right py-2 pr-4">Sent</th>
                <th className="text-left py-2 pr-4">Status</th>
                <th className="text-left py-2">Date</th>
              </tr>
            </thead>
            <tbody>
              {(broadcasts || []).map((b: any) => (
                <tr key={b.id} className="border-b border-[#1A2A3D]/50 hover:bg-[#1A2A3D]/20">
                  <td className="py-2.5 pr-4 max-w-[300px]">
                    <div className="text-[#B0BEC5] truncate">{b.title}</div>
                    <div className="text-[#6B7E8F] text-xs">{(b.subsectors || []).join(', ')}</div>
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="text-xs px-2 py-0.5 rounded bg-[#1993C5]/20 text-[#74DFF6]">
                      {b.sector || 'general'}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-right text-[#B0BEC5]">
                    {(b.total_contacts || 0).toLocaleString()}
                  </td>
                  <td className="py-2.5 pr-4 text-right text-[#B0BEC5]">
                    {(b.total_sent || 0).toLocaleString()}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      b.status === 'cancelled' ? 'bg-red-900/30 text-red-400' :
                      b.status === 'sending' ? 'bg-blue-900/30 text-blue-400' :
                      b.status === 'completed' ? 'bg-green-900/30 text-green-400' :
                      'bg-amber-900/30 text-amber-400'
                    }`}>
                      {b.status}
                    </span>
                  </td>
                  <td className="py-2.5 text-[#6B7E8F] text-xs">
                    {b.sent_at ? new Date(b.sent_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '-'}
                  </td>
                </tr>
              ))}
              {(!broadcasts || (broadcasts as any[]).length === 0) && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[#6B7E8F]">
                    No broadcasts yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Stale Contacts */}
      {stale && ((stale as any).zero_engagement?.length > 0 || (stale as any).ooo?.length > 0 || (stale as any).left_company?.length > 0) && (
        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-6">
          <h2 className="text-[#E0E8EE] font-semibold mb-4">
            <AlertTriangle size={16} className="inline mr-2 text-amber-400" />
            Stale Contacts
          </h2>

          {(stale as any).left_company?.length > 0 && (
            <div className="mb-5">
              <h3 className="text-red-400 text-sm font-semibold mb-2">Left Company (auto-removed)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[#6B7E8F] border-b border-[#1A2A3D]">
                      <th className="text-left py-2 pr-4">Contact</th>
                      <th className="text-left py-2 pr-4">Company</th>
                      <th className="text-left py-2">Detected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(stale as any).left_company.map((c: any) => (
                      <tr key={c.id} className="border-b border-[#1A2A3D]/50">
                        <td className="py-2 pr-4">
                          <div className="text-[#B0BEC5]">{c.first_name} {c.last_name}</div>
                          <div className="text-[#6B7E8F] text-xs">{c.email}</div>
                        </td>
                        <td className="py-2 pr-4 text-[#6B7E8F]">{c.company || '-'}</td>
                        <td className="py-2 text-[#6B7E8F] text-xs">
                          {c.detected_at ? new Date(c.detected_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(stale as any).ooo?.length > 0 && (
            <div className="mb-5">
              <h3 className="text-amber-400 text-sm font-semibold mb-2">Out of Office</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[#6B7E8F] border-b border-[#1A2A3D]">
                      <th className="text-left py-2 pr-4">Contact</th>
                      <th className="text-left py-2 pr-4">Company</th>
                      <th className="text-left py-2">OOO Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(stale as any).ooo.map((c: any) => (
                      <tr key={c.id} className="border-b border-[#1A2A3D]/50">
                        <td className="py-2 pr-4">
                          <div className="text-[#B0BEC5]">{c.first_name} {c.last_name}</div>
                          <div className="text-[#6B7E8F] text-xs">{c.email}</div>
                        </td>
                        <td className="py-2 pr-4 text-[#6B7E8F]">{c.company || '-'}</td>
                        <td className="py-2 text-[#6B7E8F] text-xs">
                          {c.ooo_at ? new Date(c.ooo_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(stale as any).zero_engagement?.length > 0 && (
            <div>
              <h3 className="text-[#6B7E8F] text-sm font-semibold mb-2">Zero Engagement (4+ sends, no opens/clicks/replies)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[#6B7E8F] border-b border-[#1A2A3D]">
                      <th className="text-left py-2 pr-4">Contact</th>
                      <th className="text-left py-2 pr-4">Company</th>
                      <th className="text-right py-2 pr-4">Sends</th>
                      <th className="text-left py-2">Last Sent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(stale as any).zero_engagement.map((c: any) => (
                      <tr key={c.id} className="border-b border-[#1A2A3D]/50">
                        <td className="py-2 pr-4">
                          <div className="text-[#B0BEC5]">{c.first_name} {c.last_name}</div>
                          <div className="text-[#6B7E8F] text-xs">{c.email}</div>
                        </td>
                        <td className="py-2 pr-4 text-[#6B7E8F]">{c.company || '-'}</td>
                        <td className="py-2 pr-4 text-right text-[#B0BEC5]">{c.total_sends}</td>
                        <td className="py-2 text-[#6B7E8F] text-xs">
                          {c.last_sent ? new Date(c.last_sent).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Per-Campaign Stats */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5">
        <h2 className="text-[#E0E8EE] font-semibold mb-4">Sequence Performance</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#6B7E8F] border-b border-[#1A2A3D]">
                <th className="text-left py-2 pr-4">Sequence</th>
                <th className="text-right py-2 pr-4">Sent</th>
                <th className="text-right py-2 pr-4">Open Rate</th>
                <th className="text-right py-2 pr-4">Click Rate</th>
                <th className="text-right py-2 pr-4">Replies</th>
                <th className="text-right py-2">Enrollments</th>
              </tr>
            </thead>
            <tbody>
              {(campaigns || []).map((c: any) => (
                <tr key={c.id} className="border-b border-[#1A2A3D]/50 hover:bg-[#1A2A3D]/20">
                  <td className="py-2.5 pr-4">
                    <div className="text-[#B0BEC5]">{c.name}</div>
                    <div className="text-[#6B7E8F] text-xs capitalize">{c.status}</div>
                  </td>
                  <td className="py-2.5 pr-4 text-right text-[#B0BEC5]">{parseInt(c.emails_sent || 0).toLocaleString()}</td>
                  <td className="py-2.5 pr-4 text-right text-[#1993C5]">{c.open_rate}%</td>
                  <td className="py-2.5 pr-4 text-right text-[#1993C5]">{c.click_rate}%</td>
                  <td className="py-2.5 pr-4 text-right text-green-400">{c.replies}</td>
                  <td className="py-2.5 text-right text-[#B0BEC5]">
                    {c.active_enrollments} / {c.total_enrollments}
                  </td>
                </tr>
              ))}
              {(!campaigns || (campaigns as unknown[]).length === 0) && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[#6B7E8F]">
                    No sequence data yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
