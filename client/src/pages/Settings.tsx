import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, Plus, Trash2, Save, ExternalLink, Key, Clock, Bell } from 'lucide-react';
import { settingsApi, apolloApi, EmailAccount } from '../lib/api';

function EmailAccountCard({
  account,
  onDisconnect,
  onUpdate,
}: {
  account: EmailAccount;
  onDisconnect: () => void;
  onUpdate: (data: { daily_limit?: number; hourly_limit?: number }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [dailyLimit, setDailyLimit] = useState(account.daily_limit);
  const [hourlyLimit, setHourlyLimit] = useState(account.hourly_limit);

  const dailyPct = Math.round((account.sends_today / account.daily_limit) * 100);
  const hourlyPct = Math.round((account.sends_this_hour / account.hourly_limit) * 100);

  return (
    <div className="bg-[#0A131E] border border-[#1A2A3D] rounded-lg p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-[#B0BEC5] font-medium">
            {account.display_name || account.email}
          </div>
          {account.display_name && (
            <div className="text-[#6B7E8F] text-xs">{account.email}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            (account as any).has_oauth ? 'bg-green-900/30 text-green-400' : 'bg-amber-900/30 text-amber-400'
          }`}>
            {(account as any).has_oauth ? 'Connected' : 'Not connected'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm mb-3">
        <div>
          <div className="text-[#6B7E8F] text-xs mb-1">Today: {account.sends_today} / {account.daily_limit}</div>
          <div className="h-1 bg-[#1A2A3D] rounded overflow-hidden">
            <div
              className={`h-full rounded ${dailyPct > 80 ? 'bg-amber-400' : 'bg-[#1993C5]'}`}
              style={{ width: `${Math.min(100, dailyPct)}%` }}
            />
          </div>
        </div>
        <div>
          <div className="text-[#6B7E8F] text-xs mb-1">This hour: {account.sends_this_hour} / {account.hourly_limit}</div>
          <div className="h-1 bg-[#1A2A3D] rounded overflow-hidden">
            <div
              className={`h-full rounded ${hourlyPct > 80 ? 'bg-amber-400' : 'bg-[#1993C5]'}`}
              style={{ width: `${Math.min(100, hourlyPct)}%` }}
            />
          </div>
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[#6B7E8F] text-xs mb-1 block">Daily Limit</label>
              <input
                type="number"
                value={dailyLimit}
                onChange={(e) => setDailyLimit(parseInt(e.target.value) || 0)}
                className="w-full bg-[#0D1B2A] border border-[#1A2A3D] text-[#B0BEC5] rounded px-2 py-1 text-sm focus:outline-none focus:border-[#1993C5]"
              />
            </div>
            <div className="flex-1">
              <label className="text-[#6B7E8F] text-xs mb-1 block">Hourly Limit</label>
              <input
                type="number"
                value={hourlyLimit}
                onChange={(e) => setHourlyLimit(parseInt(e.target.value) || 0)}
                className="w-full bg-[#0D1B2A] border border-[#1A2A3D] text-[#B0BEC5] rounded px-2 py-1 text-sm focus:outline-none focus:border-[#1993C5]"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { onUpdate({ daily_limit: dailyLimit, hourly_limit: hourlyLimit }); setEditing(false); }}
              className="flex-1 bg-[#1993C5] hover:bg-[#1578A2] text-white text-sm rounded py-1.5 transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="flex-1 border border-[#1A2A3D] text-[#6B7E8F] text-sm rounded py-1.5 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => setEditing(true)}
            className="text-xs text-[#6B7E8F] hover:text-[#B0BEC5] transition-colors"
          >
            Edit limits
          </button>
          <span className="text-[#1A2A3D]">·</span>
          <button
            onClick={() => { if (confirm(`Disconnect ${account.email}?`)) onDisconnect(); }}
            className="text-xs text-[#6B7E8F] hover:text-red-400 transition-colors"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const queryClient = useQueryClient();
  const [apolloKey, setApolloKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');

  const { data: accounts, isLoading: accountsLoading } = useQuery({
    queryKey: ['email-accounts'],
    queryFn: () => settingsApi.getEmailAccounts().then((r) => r.data),
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.get().then((r) => r.data),
  });

  const [windowStart, setWindowStart] = useState('08:00');
  const [windowEnd, setWindowEnd] = useState('18:00');
  const [skipWeekends, setSkipWeekends] = useState(true);
  const [sendGapMinutes, setSendGapMinutes] = useState('5');
  const [creditsThreshold, setCreditsThreshold] = useState('50');
  const [limitPct, setLimitPct] = useState('90');

  React.useEffect(() => {
    if (settings) {
      if (settings.send_window_start) setWindowStart(settings.send_window_start as string);
      if (settings.send_window_end) setWindowEnd(settings.send_window_end as string);
      if (settings.send_gap_minutes) setSendGapMinutes(String(settings.send_gap_minutes));
      if (settings.dripify_alert_credits_threshold) setCreditsThreshold(String(settings.dripify_alert_credits_threshold));
      if (settings.dripify_alert_limit_pct) setLimitPct(String(settings.dripify_alert_limit_pct));
    }
  }, [settings]);

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => settingsApi.disconnectEmailAccount(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['email-accounts'] }),
  });

  const updateAccountMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<EmailAccount> }) =>
      settingsApi.updateEmailAccount(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['email-accounts'] }),
  });

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {
        send_window_start: windowStart,
        send_window_end: windowEnd,
        skip_weekends: skipWeekends,
        send_gap_minutes: parseInt(sendGapMinutes) || 5,
        dripify_alert_credits_threshold: parseInt(creditsThreshold),
        dripify_alert_limit_pct: parseInt(limitPct),
      };
      await settingsApi.update(updates);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaved('Settings saved');
      setTimeout(() => setSaved(''), 3000);
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-[#E0E8EE] text-2xl font-bold">Settings</h1>
        <p className="text-[#6B7E8F] text-sm mt-1">Configure your outreach engine</p>
      </div>

      {/* Gmail Accounts */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[#E0E8EE] font-semibold flex items-center gap-2">
            <Mail size={16} /> Gmail Accounts
          </h2>
          <a
            href="/outreach/api/auth/gmail"
            className="flex items-center gap-2 bg-[#1993C5] hover:bg-[#1578A2] text-white rounded px-3 py-1.5 text-sm transition-colors"
          >
            <Plus size={13} /> Connect Gmail
          </a>
        </div>

        {accountsLoading ? (
          <div className="text-[#6B7E8F] text-sm">Loading accounts...</div>
        ) : !accounts || accounts.length === 0 ? (
          <div className="text-center py-6 text-[#6B7E8F] text-sm">
            No Gmail accounts connected yet.
            <br />
            <a href="/outreach/api/auth/gmail" className="text-[#1993C5] hover:text-[#74DFF6] mt-1 inline-block">
              Connect your first account →
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            {accounts.map((acc) => (
              <EmailAccountCard
                key={acc.id}
                account={acc}
                onDisconnect={() => disconnectMutation.mutate(acc.id)}
                onUpdate={(data) => updateAccountMutation.mutate({ id: acc.id, data })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Apollo API */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-5">
        <h2 className="text-[#E0E8EE] font-semibold flex items-center gap-2 mb-4">
          <Key size={16} /> Apollo.io API
        </h2>
        <div className="flex gap-2">
          <input
            type="password"
            value={apolloKey}
            onChange={(e) => setApolloKey(e.target.value)}
            placeholder="Set via APOLLO_API_KEY env variable"
            className="flex-1 bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                       focus:outline-none focus:border-[#1993C5]"
          />
          <button
            onClick={() => apolloApi.sync('full')}
            className="flex items-center gap-2 border border-[#1A2A3D] hover:border-[#1993C5] text-[#B0BEC5] rounded px-3 py-2 text-sm transition-colors"
          >
            Sync Full
          </button>
        </div>
        <p className="text-[#6B7E8F] text-xs mt-2">
          Apollo API key is configured via the <code className="text-[#74DFF6]">APOLLO_API_KEY</code> environment variable.
        </p>
      </div>

      {/* Send Window */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-5">
        <h2 className="text-[#E0E8EE] font-semibold flex items-center gap-2 mb-4">
          <Clock size={16} /> Default Send Window
        </h2>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-[#6B7E8F] text-sm mb-1">Window Start (UTC)</label>
            <input
              type="time"
              value={windowStart}
              onChange={(e) => setWindowStart(e.target.value)}
              className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                         focus:outline-none focus:border-[#1993C5]"
            />
          </div>
          <div>
            <label className="block text-[#6B7E8F] text-sm mb-1">Window End (UTC)</label>
            <input
              type="time"
              value={windowEnd}
              onChange={(e) => setWindowEnd(e.target.value)}
              className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                         focus:outline-none focus:border-[#1993C5]"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-[#B0BEC5] text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={skipWeekends}
            onChange={(e) => setSkipWeekends(e.target.checked)}
            className="accent-[#1993C5]"
          />
          Skip weekends by default
        </label>
        <div className="mt-4">
          <label className="block text-[#6B7E8F] text-sm mb-1">Delay Between Sends (minutes)</label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={1}
              max={60}
              value={sendGapMinutes}
              onChange={(e) => setSendGapMinutes(e.target.value)}
              className="w-24 bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                         focus:outline-none focus:border-[#1993C5]"
            />
            <span className="text-[#6B7E8F] text-xs">
              {parseInt(sendGapMinutes) > 0
                ? `~${Math.floor(60 / parseInt(sendGapMinutes))} emails/hour within send window`
                : ''}
            </span>
          </div>
          <p className="text-[#6B7E8F] text-xs mt-1">
            Emails are only sent during the window above. Outside hours, they queue until the next window opens.
          </p>
        </div>
      </div>

      {/* Dripify Alerts */}
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 mb-5">
        <h2 className="text-[#E0E8EE] font-semibold flex items-center gap-2 mb-4">
          <Bell size={16} /> Dripify Alert Thresholds
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[#6B7E8F] text-sm mb-1">Low Credits Alert (below)</label>
            <input
              type="number"
              value={creditsThreshold}
              onChange={(e) => setCreditsThreshold(e.target.value)}
              className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                         focus:outline-none focus:border-[#1993C5]"
            />
          </div>
          <div>
            <label className="block text-[#6B7E8F] text-sm mb-1">Limit Usage Alert (above %)</label>
            <input
              type="number"
              value={limitPct}
              min={50}
              max={100}
              onChange={(e) => setLimitPct(e.target.value)}
              className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2 text-sm
                         focus:outline-none focus:border-[#1993C5]"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSaveSettings}
          disabled={saving}
          className="flex items-center gap-2 bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded-lg px-5 py-2.5 transition-colors"
        >
          <Save size={14} />
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {saved && <span className="text-green-400 text-sm">{saved}</span>}
      </div>
    </div>
  );
}
