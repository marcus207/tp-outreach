import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus, Play, Pause, Archive, ChevronRight, Mail, Users, TrendingUp } from 'lucide-react';
import { campaignsApi, Campaign } from '../lib/api';

const statusColors: Record<string, string> = {
  draft: 'bg-[#6B7E8F]/20 text-[#6B7E8F]',
  active: 'bg-green-900/30 text-green-400',
  paused: 'bg-amber-900/30 text-amber-400',
  archived: 'bg-red-900/30 text-red-400',
};

function CreateCampaignModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;
    setLoading(true);
    try {
      const res = await campaignsApi.create({ name, description: description || undefined });
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      onClose();
      navigate(`/campaigns/${res.data.id}`);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl w-full max-w-md p-6">
        <h2 className="text-[#E0E8EE] font-semibold text-lg mb-4">New Campaign</h2>
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-[#6B7E8F] text-sm mb-1">Campaign Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q1 CFO Outreach"
              className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2
                         focus:outline-none focus:border-[#1993C5]"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-[#6B7E8F] text-sm mb-1">Description (optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this campaign about?"
              rows={3}
              className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded px-3 py-2
                         focus:outline-none focus:border-[#1993C5] resize-none"
            />
          </div>
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-[#1A2A3D] text-[#B0BEC5] hover:border-[#1993C5] rounded px-4 py-2 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name}
              className="flex-1 bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 text-white rounded px-4 py-2 transition-colors"
            >
              {loading ? 'Creating...' : 'Create Campaign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CampaignCard({ campaign }: { campaign: Campaign }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const statusMutation = useMutation({
    mutationFn: (status: string) => campaignsApi.setStatus(campaign.id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['campaigns'] }),
  });

  const totalSent = Number(campaign.total_sent) || 0;
  const openRate = totalSent > 0 ? Math.round((Number(campaign.total_opens) / totalSent) * 100) : 0;
  const replyRate = totalSent > 0 ? Math.round((Number(campaign.total_replies) / totalSent) * 100) : 0;

  return (
    <div
      className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-lg p-5 hover:border-[#1993C5]/50 transition-colors cursor-pointer"
      onClick={() => navigate(`/campaigns/${campaign.id}`)}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-[#E0E8EE] font-medium truncate">{campaign.name}</h3>
          {campaign.description && (
            <p className="text-[#6B7E8F] text-sm mt-0.5 truncate">{campaign.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 ml-3">
          <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[campaign.status] || statusColors.draft}`}>
            {campaign.status}
          </span>
          <ChevronRight size={14} className="text-[#6B7E8F]" />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 text-center border-t border-[#1A2A3D] pt-3 mt-3">
        <div>
          <div className="text-[#B0BEC5] font-medium">{totalSent.toLocaleString()}</div>
          <div className="text-[#6B7E8F] text-xs">Sent</div>
        </div>
        <div>
          <div className="text-[#1993C5] font-medium">{openRate}%</div>
          <div className="text-[#6B7E8F] text-xs">Opens</div>
        </div>
        <div>
          <div className="text-green-400 font-medium">{replyRate}%</div>
          <div className="text-[#6B7E8F] text-xs">Replies</div>
        </div>
        <div>
          <div className="text-[#B0BEC5] font-medium">{Number(campaign.active_enrollments) || 0}</div>
          <div className="text-[#6B7E8F] text-xs">Active</div>
        </div>
      </div>

      <div className="flex gap-2 mt-3 pt-3 border-t border-[#1A2A3D]" onClick={(e) => e.stopPropagation()}>
        {campaign.status === 'draft' && (
          <button
            onClick={() => statusMutation.mutate('active')}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-green-900/30 text-green-400 rounded hover:bg-green-900/50 transition-colors"
          >
            <Play size={11} /> Activate
          </button>
        )}
        {campaign.status === 'active' && (
          <button
            onClick={() => statusMutation.mutate('paused')}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-amber-900/30 text-amber-400 rounded hover:bg-amber-900/50 transition-colors"
          >
            <Pause size={11} /> Pause
          </button>
        )}
        {campaign.status === 'paused' && (
          <button
            onClick={() => statusMutation.mutate('active')}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-green-900/30 text-green-400 rounded hover:bg-green-900/50 transition-colors"
          >
            <Play size={11} /> Resume
          </button>
        )}
        {campaign.status !== 'archived' && (
          <button
            onClick={() => statusMutation.mutate('archived')}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-[#1A2A3D] text-[#6B7E8F] rounded hover:text-[#B0BEC5] transition-colors"
          >
            <Archive size={11} /> Archive
          </button>
        )}
      </div>
    </div>
  );
}

export default function Campaigns() {
  const [showCreate, setShowCreate] = useState(false);

  const { data: campaigns, isLoading } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => campaignsApi.list().then((r) => r.data),
  });

  const grouped = {
    active: (campaigns || []).filter((c) => c.status === 'active'),
    draft: (campaigns || []).filter((c) => c.status === 'draft'),
    paused: (campaigns || []).filter((c) => c.status === 'paused'),
    archived: (campaigns || []).filter((c) => c.status === 'archived'),
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[#E0E8EE] text-2xl font-bold">Campaigns</h1>
          <p className="text-[#6B7E8F] text-sm mt-1">Email sequence management</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 bg-[#1993C5] hover:bg-[#1578A2] text-white rounded-lg px-4 py-2.5 transition-colors"
        >
          <Plus size={16} />
          New Campaign
        </button>
      </div>

      {isLoading ? (
        <div className="text-[#6B7E8F] text-center py-16">Loading campaigns...</div>
      ) : !campaigns || campaigns.length === 0 ? (
        <div className="text-center py-16">
          <Mail size={40} className="mx-auto text-[#1A2A3D] mb-4" />
          <p className="text-[#6B7E8F]">No campaigns yet</p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-4 text-[#1993C5] hover:text-[#74DFF6] text-sm"
          >
            Create your first campaign
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.active.length > 0 && (
            <div>
              <h2 className="text-[#E0E8EE] font-medium mb-3 flex items-center gap-2">
                <span className="w-2 h-2 bg-green-400 rounded-full"></span> Active
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {grouped.active.map((c) => <CampaignCard key={c.id} campaign={c} />)}
              </div>
            </div>
          )}
          {grouped.draft.length > 0 && (
            <div>
              <h2 className="text-[#E0E8EE] font-medium mb-3 flex items-center gap-2">
                <span className="w-2 h-2 bg-[#6B7E8F] rounded-full"></span> Drafts
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {grouped.draft.map((c) => <CampaignCard key={c.id} campaign={c} />)}
              </div>
            </div>
          )}
          {grouped.paused.length > 0 && (
            <div>
              <h2 className="text-[#E0E8EE] font-medium mb-3 flex items-center gap-2">
                <span className="w-2 h-2 bg-amber-400 rounded-full"></span> Paused
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {grouped.paused.map((c) => <CampaignCard key={c.id} campaign={c} />)}
              </div>
            </div>
          )}
          {grouped.archived.length > 0 && (
            <div>
              <h2 className="text-[#6B7E8F] font-medium mb-3 flex items-center gap-2">
                <span className="w-2 h-2 bg-red-400 rounded-full"></span> Archived
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {grouped.archived.map((c) => <CampaignCard key={c.id} campaign={c} />)}
              </div>
            </div>
          )}
        </div>
      )}

      {showCreate && <CreateCampaignModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}
