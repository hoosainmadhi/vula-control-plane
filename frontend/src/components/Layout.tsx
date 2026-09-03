import type { ReactNode } from 'react';
import { setToken } from '../api';

interface LayoutProps {
  title: string;
  children: ReactNode;
}

export default function Layout({ title, children }: LayoutProps) {
  const logout = (): void => {
    setToken(null);
    window.location.href = '/login';
  };
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-baseline gap-3">
            <h1 className="font-semibold tracking-tight text-slate-900">Vula Control Plane</h1>
            <span className="text-sm text-slate-500">{title}</span>
          </div>
          <button
            onClick={logout}
            className="text-sm text-slate-500 transition-colors hover:text-slate-900"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
