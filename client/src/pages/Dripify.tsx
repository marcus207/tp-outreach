import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, AlertCircle, Info, CheckCircle, RefreshCw, Bell, BellOff } from 'lucide-react';
import { dripifyApi } from '../lib/api';

function ProgressBar({ value, max, color = '#1993C5' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const barColor = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : color;
  return (
    <div className="h-1.5 bg-[#1A2A3D] rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, backgroundColor: barColor }}
      />
    </div>
  );
}

function StatBlock({
  label,
  value,
  max,
  warn,
}: {
  label: string;
  value: number | null;
  max?: number | null;
  warn?: boolean;
}) {
  const displayValue = value ?? '—';
  const pct = value !== null && max ? Math.round((value / max) * 100) : null;

  return (
    <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5">
      <div className="text-[#6B7E8F] text-sm mb-2">{label}</div>
      <div className={`text-3xl font-bold mb-1 ${warn ? 'text-amber-400' : 'text-[#74DFF6]'}`}>
        {displayValue}
        {max !== undefined && max !== null && (
          <span className="text-[#6B7E8F] text-base font-normal"> / {max}</span>
        )}
      </div>
      {pct !== null && max !== null && max !== undefined && (
        <>
          <ProgressBar value={value!} max={max} />
          <div className="text-[#6B7E8F] text-xs mt-1">{pct}% used</div>
        </>
      )}
    </div>
  );
}

const alertIcons = {
  info: <Info size={14} className="text-[#1993C5]" />,
  warning: <AlertTriangle size={14} className="text-amber-400" />,
  critical: <AlertCircle size={14} className="text-red-400" />,
};

const alertBg = {
  info: 'bg-[#1993C5]/10 border-[#1993C5]/30',
  warning: 'bg-amber-900/20 border-amber-800/30',
  critical: 'bg-red-900/20 border-red-800/30',
};

export default function Dripify() {
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['dripify'],
    queryFn: () => dripifyApi.latest().then((r) => r.data),
    refetchInterval: 60000,
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => dripifyApi.markAlertRead(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dripify'] }),
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => dripifyApi.markAllRead(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dripify'] }),
  });

  const snapshot = data?.snapshot;
  const alerts = data?.alerts || [];
  const unreadAlerts = alerts.filter((a) => !a.is_read);

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  };

  const creditWarn = snapshot?.search_credits !== null && snapshot?.search_credits !== undefined && snapshot.search_credits < 100;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[#E0E8EE] text-2xl font-bold">Dripify Monitor</h1>
          <p className="text-[#6B7E8F] text-sm mt-1">
            {snapshot
              ? `Last synced: ${formatTime(snapshot.scraped_at)}`
              : 'No data yet — install the Tampermonkey script'}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 border border-[#1A2A3D] text-[#B0BEC5] hover:border-[#1993C5] rounded-lg px-3 py-2 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="text-[#6B7E8F] text-center py-16">Loading Dripify data...</div>
      ) : !snapshot ? (
        <div className="text-center py-16 bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl">
          <AlertCircle size={40} className="mx-auto text-[#1A2A3D] mb-4" />
          <p className="text-[#B0BEC5] font-medium mb-2">No Dripify data yet</p>
          <p className="text-[#6B7E8F] text-sm max-w-md mx-auto">
            Install the Tampermonkey userscript from <code className="text-[#74DFF6]">tampermonkey/dripify-scraper.user.js</code>,
            configure the ingest URL and API key, then visit your Dripify dashboard.
          </p>
        </div>
      ) : (
        <>
          {/* Stats Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            <StatBlock
              label="Search Credits"
              value={snapshot.search_credits}
              warn={creditWarn}
            />
            <StatBlock
              label="Daily Invites"
              value={snapshot.daily_invites_used}
              max={snapshot.daily_invites_limit}
            />
            <StatBlock
              label="Daily Messages"
              value={snapshot.daily_messages_used}
              max={snapshot.daily_messages_limit}
            />
          </div>

          {/* Campaigns */}
          {snapshot.campaigns && snapshot.campaigns.length > 0 && (
            <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-6">
              <h2 className="text-[#E0E8EE] font-semibold mb-4">Active Campaigns</h2>
              <div className="space-y-2">
                {snapshot.campaigns.map((c) => (
                  <div key={c.id} className="flex items-center justify-between py-2 border-b border-[#1A2A3D]/50 last:border-0">
                    <div className="text-[#B0BEC5] text-sm">{c.name}</div>
                    <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                      c.status === 'active' ? 'bg-green-900/30 text-green-400' :
                      c.status === 'paused' ? 'bg-amber-900/30 text-amber-400' :
                      'bg-[#1A2A3D] text-[#6B7E8F]'
                    }`}>
                      {c.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Alerts */}
          <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[#E0E8EE] font-semibold flex items-center gap-2">
                Alerts
                {unreadAlerts.length > 0 && (
                  <span className="bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                    {unreadAlerts.length}
                  </span>
                )}
              </h2>
              {unreadAlerts.length > 0 && (
                <button
                  onClick={() => markAllReadMutation.mutate()}
                  className="flex items-center gap-1.5 text-[#6B7E8F] hover:text-[#B0BEC5] text-sm transition-colors"
                >
                  <BellOff size={13} /> Mark all read
                </button>
              )}
            </div>

            {alerts.length === 0 ? (
              <div className="flex items-center gap-2 text-[#6B7E8F] text-sm">
                <CheckCircle size={14} className="text-green-400" />
                No alerts — everything looks good
              </div>
            ) : (
              <div className="space-y-2">
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`flex items-start gap-3 p-3 rounded-lg border ${alertBg[alert.severity]} ${
                      alert.is_read ? 'opacity-50' : ''
                    }`}
                  >
                    <div className="mt-0.5">{alertIcons[alert.severity]}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[#B0BEC5] text-sm">{alert.message}</div>
                      <div className="text-[#6B7E8F] text-xs mt-0.5">{formatTime(alert.created_at)}</div>
                    </div>
                    {!alert.is_read && (
                      <button
                        onClick={() => markReadMutation.mutate(alert.id)}
                        className="text-[#6B7E8F] hover:text-[#B0BEC5] transition-colors flex-shrink-0"
                        title="Mark as read"
                      >
                        <Bell size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
