import { useState, type FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, setToken } from '../api';
import ErrorBox from '../components/ErrorBox';
import type { LoginResponse } from '../types';

const inputCls =
  'w-full rounded-lg border border-slate-300 px-4 py-3 focus:border-brand-500 focus:outline-none';

export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      setToken(res.token);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4">
      <div className="rounded-2xl bg-white p-6 shadow-lg">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <img src="/vula-mark.svg" alt="Vula" className="h-14 w-14" />
          <div>
            <h1 className="text-lg font-black text-slate-900">Control Plane</h1>
            <p className="text-sm text-slate-400">Office sign in · Vula store fleet</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          {error && <ErrorBox message={error} />}
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-semibold text-slate-700">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-semibold text-slate-700">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${inputCls} pr-12`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-slate-400 hover:text-slate-600"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-brand-600 px-4 py-3 font-bold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="text-center text-xs text-slate-400">
            Dev default: admin@za-pos.local / temp123 (OFFICE_ADMIN_* env vars)
          </p>
        </form>
      </div>
    </div>
  );
}
