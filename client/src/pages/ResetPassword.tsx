import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import axios from 'axios';

interface ResetPasswordProps {
  token: string;
  onSuccess: () => void;
}

export default function ResetPassword({ token, onSuccess }: ResetPasswordProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await axios.post('/outreach/api/auth/reset-password', { token, new_password: password });
      setDone(true);
      setTimeout(onSuccess, 2000);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.error : null;
      setError(msg || 'Failed to reset password. The link may have expired.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A131E] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-[#74DFF6] font-bold text-3xl mb-1">TP.Finance</div>
          <div className="text-[#6B7E8F] text-sm">Outreach Engine</div>
        </div>

        <div className="bg-[#0D1B2A] border border-[#1A2A3D] rounded-xl p-8">
          <h1 className="text-[#E0E8EE] font-semibold text-xl mb-6">Set New Password</h1>

          {done ? (
            <div className="text-green-400 text-sm text-center py-4">
              Password updated. Redirecting to sign in...
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-[#6B7E8F] text-sm mb-1.5">New Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded-lg px-4 py-3 pr-11
                               focus:outline-none focus:border-[#1993C5] transition-colors"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B7E8F] hover:text-[#B0BEC5] transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[#6B7E8F] text-sm mb-1.5">Confirm Password</label>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat password"
                  className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded-lg px-4 py-3
                             focus:outline-none focus:border-[#1993C5] transition-colors"
                />
              </div>

              {error && (
                <div className="bg-red-900/20 border border-red-800/30 rounded px-3 py-2 text-red-400 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !password || !confirm}
                className="w-full bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 disabled:cursor-not-allowed
                           text-white font-medium rounded-lg py-3 transition-colors"
              >
                {loading ? 'Updating...' : 'Update Password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
