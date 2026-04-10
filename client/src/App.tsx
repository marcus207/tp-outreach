import React, { useState, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard,
  Mail,
  Users,
  FileText,
  BarChart2,
  Link2,
  Settings,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { authApi } from './lib/api';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Campaigns from './pages/Campaigns';
import CampaignDetail from './pages/CampaignDetail';
import Contacts from './pages/Contacts';
import Templates from './pages/Templates';
import Analytics from './pages/Analytics';
import Dripify from './pages/Dripify';
import SettingsPage from './pages/Settings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30000,
    },
  },
});

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/campaigns', label: 'Campaigns', icon: Mail },
  { to: '/contacts', label: 'Contacts', icon: Users },
  { to: '/templates', label: 'Templates', icon: FileText },
  { to: '/analytics', label: 'Analytics', icon: BarChart2 },
  { to: '/dripify', label: 'Dripify', icon: Link2 },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Sidebar({ onLogout }: { onLogout: () => void }) {
  return (
    <aside className="w-56 bg-[#0D1B2A] border-r border-[#1A2A3D] flex flex-col min-h-screen">
      <div className="p-5 border-b border-[#1A2A3D]">
        <div className="text-[#74DFF6] font-bold text-lg tracking-wide">TP.Finance</div>
        <div className="text-[#6B7E8F] text-xs mt-0.5">Outreach Engine</div>
      </div>

      <nav className="flex-1 py-4 px-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg mb-1 text-sm transition-colors ${
                isActive
                  ? 'bg-[#1993C5]/20 text-[#74DFF6] border border-[#1993C5]/30'
                  : 'text-[#B0BEC5] hover:bg-[#1A2A3D] hover:text-[#E0E8EE]'
              }`
            }
          >
            <item.icon size={16} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="p-4 border-t border-[#1A2A3D]">
        <button
          onClick={onLogout}
          className="flex items-center gap-2 text-[#6B7E8F] hover:text-[#B0BEC5] text-sm w-full px-3 py-2 rounded transition-colors hover:bg-[#1A2A3D]"
        >
          <LogOut size={15} />
          Logout
        </button>
      </div>
    </aside>
  );
}

function AppLayout({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar onLogout={onLogout} />
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/analytics" replace />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/campaigns/:id" element={<CampaignDetail />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/dripify" element={<Dripify />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}

function AuthGate() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [view, setView] = useState<'login' | 'forgot'>('login');
  const navigate = useNavigate();

  // Check for reset-password token in hash
  const hash = window.location.hash;
  const resetMatch = hash.match(/^#\/reset-password\?token=([a-f0-9]+)$/);
  const resetToken = resetMatch ? resetMatch[1] : null;

  useEffect(() => {
    if (resetToken) return; // skip auth check when on reset page
    authApi.me()
      .then((res) => setAuthenticated(res.data.authenticated))
      .catch(() => setAuthenticated(false));
  }, [resetToken]);

  const handleLogout = async () => {
    await authApi.logout();
    setAuthenticated(false);
    navigate('/');
  };

  if (resetToken) {
    return (
      <ResetPassword
        token={resetToken}
        onSuccess={() => {
          window.location.hash = '/';
          setAuthenticated(false);
        }}
      />
    );
  }

  if (view === 'forgot') {
    return <ForgotPassword onBack={() => setView('login')} />;
  }

  if (authenticated === null) {
    return (
      <div className="min-h-screen bg-[#0A131E] flex items-center justify-center">
        <div className="text-[#6B7E8F]">Loading...</div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <Login
        onSuccess={() => setAuthenticated(true)}
        onForgotPassword={() => setView('forgot')}
      />
    );
  }

  return <AppLayout onLogout={handleLogout} />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <AuthGate />
      </HashRouter>
    </QueryClientProvider>
  );
}
