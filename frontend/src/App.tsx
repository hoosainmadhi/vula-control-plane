import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { getToken } from './api';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import ClientsPage from './pages/ClientsPage';
import ClientDetailPage from './pages/ClientDetailPage';
import StoresPage from './pages/StoresPage';
import StoreDetailPage from './pages/StoreDetailPage';
import PanelsPage from './pages/PanelsPage';
import CompaniesPage from './pages/CompaniesPage';
import PlansPage from './pages/PlansPage';
import BillingPage from './pages/BillingPage';
import ErrorsPage from './pages/ErrorsPage';
import DevicesPage from './pages/DevicesPage';
import VersionsPage from './pages/VersionsPage';
import DeploymentsPage from './pages/DeploymentsPage';
import SettingsPage from './pages/SettingsPage';

function RequireOffice({ children }: { children: ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireOffice>
            <Layout title="Clients">
              <ClientsPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/clients/:id"
        element={
          <RequireOffice>
            <Layout title="Client Details">
              <ClientDetailPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/stores/:id"
        element={
          <RequireOffice>
            <Layout title="Store">
              <StoreDetailPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/stores"
        element={
          <RequireOffice>
            <Layout title="Stores">
              <StoresPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/head-offices"
        element={
          <RequireOffice>
            <Layout title="Head Offices">
              <PanelsPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/companies"
        element={
          <RequireOffice>
            <Layout title="Companies">
              <CompaniesPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/plans"
        element={
          <RequireOffice>
            <Layout title="Plans">
              <PlansPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/billing"
        element={
          <RequireOffice>
            <Layout title="Billing & Invoicing">
              <BillingPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/errors"
        element={
          <RequireOffice>
            <Layout title="Errors">
              <ErrorsPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/devices"
        element={
          <RequireOffice>
            <Layout title="Devices">
              <DevicesPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/versions"
        element={
          <RequireOffice>
            <Layout title="Versions">
              <VersionsPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/deployments"
        element={
          <RequireOffice>
            <Layout title="Deployments">
              <DeploymentsPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireOffice>
            <Layout title="Settings">
              <SettingsPage />
            </Layout>
          </RequireOffice>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
