import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { analyticsApi } from '../lib/api';
import { TrendingUp, Mail, MousePointer, MessageSquare, Users, Activity } from 'lucide-react';

function StatCard({ label, value, sub, color = '#1993C5' }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5">
      <div className="text-[#6B7E8F] text-sm mb-1">{label}</div>
      <div className="text-2xl font-bold" style={{ color }}>{value}</div>
      {sub && <div className="text-[#6B7E8F] text-xs mt-1">{sub}</div>}
    </div>
  );
}

export default function Analytics() {
  const [days, setDays] = useState(30);

  const { data: overview } = useQuery({
    queryKey: ['analytics', 'overview'],
    queryFn: () => analyticsApi.overview().then((r) => r.data),
  });

  const { data: daily } = useQuery({
    queryKey: ['analytics', 'daily', days],
    queryFn: () => analyticsApi.daily(days).then((r) => r.data),
  });

  const { data: accounts } = useQuery({
    queryKey: ['analytics', 'accounts'],
    queryFn: () => analyticsApi.accounts().then((r) => r.data),
    refetchInterval: 60000,
  });

  const { data: campaigns } = useQuery({
    queryKey: ['analytics', 'campaigns'],
    queryFn: () => analyticsApi.campaigns().then((r) => r.data),
  });

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-[#E0E8EE] text-2xl font-bold">Analytics</h1>
        <p className="text-[#6B7E8F] text-sm mt-1">Email performance overview</p>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        <StatCard
          label="Total Sent"
          value={(overview?.total_sent ?? 0).toLocaleString()}
          sub={`${overview?.total_failed ?? 0} failed`}
          color="#74DFF6"
        />
        <StatCard
          label="Open Rate"
          value={`${overview?.open_rate ?? 0}%`}
          sub={`${(overview?.unique_opens ?? 0).toLocaleString()} opens`}
          color="#1993C5"
        />
        <StatCard
          label="Click Rate"
          value={`${overview?.click_rate ?? 0}%`}
          sub={`${(overview?.unique_clicks ?? 0).toLocaleString()} clicks`}
          color="#1993C5"
        />
        <StatCard
          label="Reply Rate"
          value={`${overview?.reply_rate ?? 0}%`}
          sub={`${(overview?.total_replies ?? 0).toLocaleString()} replies`}
          color="#22c55e"
        />
        <StatCard
          label="Active"
          value={(overview?.active_enrollments ?? 0).toLocaleString()}
          sub="enrollments"
          color="#f59e0b"
        />
        <StatCard
          label="Completed"
          value={(overview?.completed_enrollments ?? 0).toLocaleString()}
          sub="sequences"
          color="#6B7E8F"
        />
      </div>

      {/* Daily Chart */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[#E0E8EE] font-semibold">Daily Send Volume</h2>
          <div className="flex gap-2">
            {[7, 14, 30, 60].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1 rounded text-sm transition-colors ${
                  days === d
                    ? 'bg-[#1993C5] text-white'
                    : 'text-[#6B7E8F] hover:text-[#B0BEC5]'
                }`}
              >
                {d}d
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
                <th className="text-right py-2 pr-4">Daily Limit</th>
                <th className="text-right py-2 pr-4">This Hour</th>
                <th className="text-right py-2 pr-4">Hourly Limit</th>
                <th className="text-right py-2 pr-4">7d Sent</th>
                <th className="text-right py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {(accounts || []).map((acc: { id: string; email: string; display_name?: string | null; sends_today: number; daily_limit: number; sends_this_hour: number; hourly_limit: number; sent_last_7d?: number; is_active: boolean }) => {
                const dailyPct = (acc.sends_today / acc.daily_limit) * 100;
                const hourlyPct = (acc.sends_this_hour / acc.hourly_limit) * 100;
                return (
                  <tr key={acc.id} className="border-b border-[#1A2A3D]/50 hover:bg-[#1A2A3D]/20">
                    <td className="py-2.5 pr-4">
                      <div className="text-[#B0BEC5]">{acc.display_name || acc.email}</div>
                      {acc.display_name && <div className="text-[#6B7E8F] text-xs">{acc.email}</div>}
                    </td>
                    <td className="py-2.5 pr-4 text-right">
                      <span className={dailyPct > 80 ? 'text-amber-400' : 'text-[#B0BEC5]'}>
                        {acc.sends_today}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-right text-[#6B7E8F]">{acc.daily_limit}</td>
                    <td className="py-2.5 pr-4 text-right">
                      <span className={hourlyPct > 80 ? 'text-amber-400' : 'text-[#B0BEC5]'}>
                        {acc.sends_this_hour}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-right text-[#6B7E8F]">{acc.hourly_limit}</td>
                    <td className="py-2.5 pr-4 text-right text-[#B0BEC5]">{acc.sent_last_7d ?? 0}</td>
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
                  <td colSpan={7} className="py-8 text-center text-[#6B7E8F]">
                    No email accounts connected
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-Campaign Stats */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5">
        <h2 className="text-[#E0E8EE] font-semibold mb-4">Campaign Performance</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#6B7E8F] border-b border-[#1A2A3D]">
                <th className="text-left py-2 pr-4">Campaign</th>
                <th className="text-right py-2 pr-4">Sent</th>
                <th className="text-right py-2 pr-4">Open Rate</th>
                <th className="text-right py-2 pr-4">Click Rate</th>
                <th className="text-right py-2 pr-4">Replies</th>
                <th className="text-right py-2">Enrollments</th>
              </tr>
            </thead>
            <tbody>
              {(campaigns || []).map((c: { id: string; name: string; status: string; emails_sent: number; open_rate: number; click_rate: number; replies: number; total_enrollments: number; active_enrollments: number }) => (
                <tr key={c.id} className="border-b border-[#1A2A3D]/50 hover:bg-[#1A2A3D]/20">
                  <td className="py-2.5 pr-4">
                    <div className="text-[#B0BEC5]">{c.name}</div>
                    <div className="text-[#6B7E8F] text-xs capitalize">{c.status}</div>
                  </td>
                  <td className="py-2.5 pr-4 text-right text-[#B0BEC5]">{c.emails_sent?.toLocaleString()}</td>
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
                    No campaign data yet
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
