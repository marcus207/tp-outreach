import React, { useState } from 'react';
import axios from 'axios';

interface ForgotPasswordProps {
  onBack: () => void;
}

export default function ForgotPassword({ onBack }: ForgotPasswordProps) {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handleRequest = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await axios.post('/outreach/api/auth/forgot-password');
      setMessage(res.data?.message || '');
      setSent(true);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        setError('Too many reset requests. Please try again later.');
      } else {
        setError('Failed to request a reset link. Please try again.');
      }
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
          <h1 className="text-[#E0E8EE] font-semibold text-xl mb-2">Reset Password</h1>

          {!sent ? (
            <>
              <p className="text-[#6B7E8F] text-sm mb-6">
                A reset link will be sent to <span className="text-[#B0BEC5]">marcus@tp.finance</span>.
              </p>

              {error && (
                <div className="bg-red-900/20 border border-red-800/30 rounded px-3 py-2 text-red-400 text-sm mb-4">
                  {error}
                </div>
              )}

              <button
                onClick={handleRequest}
                disabled={loading}
                className="w-full bg-[#1993C5] hover:bg-[#1578A2] disabled:opacity-50 disabled:cursor-not-allowed
                           text-white font-medium rounded-lg py-3 transition-colors mb-4"
              >
                {loading ? 'Generating link...' : 'Send Reset Link'}
              </button>
            </>
          ) : (
            <div className="mb-4">
              <p className="text-green-400 text-sm">
                {message || 'If password reset is configured, a reset link has been emailed to the account owner. It expires in 1 hour.'}
              </p>
            </div>
          )}

          <button
            onClick={onBack}
            className="w-full text-[#6B7E8F] hover:text-[#B0BEC5] text-sm transition-colors py-2"
          >
            ← Back to sign in
          </button>
        </div>
      </div>
    </div>
  );
}
