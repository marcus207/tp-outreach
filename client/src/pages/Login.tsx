import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { authApi } from '../lib/api';

interface LoginProps {
  onSuccess: () => void;
  onForgotPassword: () => void;
}

export default function Login({ onSuccess, onForgotPassword }: LoginProps) {
  const [email, setEmail] = useState('marcus@tp.finance');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await authApi.login(email, password);
      onSuccess();
    } catch {
      setError('Invalid email or password');
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
          <h1 className="text-[#E0E8EE] font-semibold text-xl mb-6">Sign In</h1>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[#6B7E8F] text-sm mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="marcus@tp.finance"
                className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded-lg px-4 py-3
                           focus:outline-none focus:border-[#1993C5] transition-colors"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-[#6B7E8F] text-sm mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your password"
                  className="w-full bg-[#0A131E] border border-[#1A2A3D] text-[#B0BEC5] rounded-lg px-4 py-3 pr-11
                             focus:outline-none focus:border-[#1993C5] transition-colors"
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

            {error && (
              <div className="bg-red-900/20 border border-red-800/30 rounded px-3 py-2 text-red-400 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email || !password}
              className="w-full bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 disabled:cursor-not-allowed
                         text-white font-medium rounded-lg py-3 transition-colors"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <div className="mt-4 text-center">
            <button
              onClick={onForgotPassword}
              className="text-[#6B7E8F] hover:text-[#74DFF6] text-sm transition-colors"
            >
              Forgot password?
            </button>
          </div>
        </div>

        <div className="text-center mt-6 text-[#6B7E8F] text-xs">
          Private access only
        </div>
      </div>
    </div>
  );
}
