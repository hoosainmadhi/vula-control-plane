import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { setToken } from '../api';

interface LayoutProps {
  title: string;
  children: ReactNode;
}

export default function Layout({ title, children }: LayoutProps) {
  const navigate = useNavigate();
  const signOut = (): void => {
    setToken(null);
    navigate('/login', { replace: true });
  };
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/vula-mark.svg" alt="Vula" className="h-8 w-8 shrink-0" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-black text-slate-900">Control Plane</h1>
              <p className="hidden text-xs text-slate-400 sm:block">Vula store fleet</p>
            </div>
          </div>
          <button
            onClick={signOut}
            className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-4 sm:px-6 sm:py-8">
        <h2 className="mb-4 text-xl font-black text-slate-900 sm:mb-6">{title}</h2>
        {children}
      </main>
    </div>
  );
}
