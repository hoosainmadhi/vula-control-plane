import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { setToken } from '../api';

interface LayoutProps {
  title: string;
  children: ReactNode;
}

interface NavItem {
  to: string;
  label: string;
}

/** Fleet apps the control plane operates. Business content lives elsewhere. */
const NAV: NavItem[] = [
  { to: '/', label: 'Clients' },
  { to: '/plans', label: 'Plans' },
  { to: '/billing', label: 'Billing' },
  { to: '/devices', label: 'Devices' },
  { to: '/errors', label: 'Errors' },
];

export default function Layout({ title, children }: LayoutProps) {
  const navigate = useNavigate();
  const signOut = (): void => {
    setToken(null);
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/vula-mark.svg" alt="Vula" className="h-8 w-8 shrink-0" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-black text-slate-900">Control Plane</h1>
              <p className="hidden text-xs text-slate-400 sm:block">Vula application fleet</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* §44: the environment must always be visible, so an operator can
                never mistake a dev action for a production one. */}
            <span className="hidden rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-700 sm:inline">
              Development
            </span>
            <button
              onClick={signOut}
              className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-200"
            >
              Sign out
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-[1600px] gap-1 px-4 sm:px-6">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition ${
                  isActive
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-[1600px] px-4 py-4 sm:px-6 sm:py-8">
        <h2 className="mb-4 text-xl font-black text-slate-900 sm:mb-6">{title}</h2>
        {children}
      </main>
    </div>
  );
}
