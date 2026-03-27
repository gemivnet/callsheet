import React, { useState, useEffect } from 'react';
import { Dashboard } from './pages/Dashboard.js';
import { Briefs } from './pages/Briefs.js';
import { BriefDetail } from './pages/BriefDetail.js';
import { Connectors } from './pages/Connectors.js';
import { ConnectorDetail } from './pages/ConnectorDetail.js';
import { Memory } from './pages/Memory.js';
import { Config } from './pages/Config.js';
import { Logs } from './pages/Logs.js';
import { Usage } from './pages/Usage.js';
import { Setup } from './pages/Setup.js';

type Page =
  | { name: 'dashboard' }
  | { name: 'briefs' }
  | { name: 'brief'; date: string }
  | { name: 'connectors' }
  | { name: 'connector-detail'; connector: string }
  | { name: 'memory' }
  | { name: 'config' }
  | { name: 'logs' }
  | { name: 'usage' };

const navItems: { page: Page; label: string; icon: string }[] = [
  { page: { name: 'dashboard' }, label: 'Dashboard', icon: '📊' },
  { page: { name: 'briefs' }, label: 'Briefs', icon: '📄' },
  { page: { name: 'connectors' }, label: 'Connectors', icon: '🔌' },
  { page: { name: 'memory' }, label: 'Memory', icon: '🧠' },
  { page: { name: 'config' }, label: 'Config', icon: '⚙️' },
  { page: { name: 'usage' }, label: 'Usage', icon: '💰' },
  { page: { name: 'logs' }, label: 'Logs', icon: '📋' },
];

export function App() {
  const [page, setPage] = useState<Page>({ name: 'dashboard' });
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((data: { config_exists: boolean }) => {
        setNeedsSetup(!data.config_exists);
      })
      .catch(() => setNeedsSetup(false));
  }, []);

  const navigate = (p: Page) => setPage(p);

  // Loading state
  if (needsSetup === null) {
    return (
      <div className="layout">
        <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p className="muted">Loading...</p>
        </div>
      </div>
    );
  }

  // Setup wizard
  if (needsSetup) {
    return <Setup onComplete={() => setNeedsSetup(false)} />;
  }

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar-header">
          <h1>Callsheet</h1>
          <span className="sidebar-subtitle">Daily Brief Dashboard</span>
        </div>
        <ul className="nav-list">
          {navItems.map((item) => (
            <li key={item.label}>
              <button
                className={`nav-item ${page.name === item.page.name ? 'active' : ''}`}
                onClick={() => navigate(item.page)}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="content">
        {renderPage(page, navigate)}
      </main>
    </div>
  );
}

function renderPage(page: Page, navigate: (p: Page) => void) {
  switch (page.name) {
    case 'dashboard':
      return <Dashboard onNavigate={navigate} />;
    case 'briefs':
      return <Briefs onNavigate={navigate} />;
    case 'brief':
      return <BriefDetail date={page.date} onBack={() => navigate({ name: 'briefs' })} />;
    case 'connectors':
      return <Connectors onNavigate={navigate} />;
    case 'connector-detail':
      return (
        <ConnectorDetail
          connector={page.connector}
          onBack={() => navigate({ name: 'connectors' })}
        />
      );
    case 'memory':
      return <Memory />;
    case 'config':
      return <Config />;
    case 'usage':
      return <Usage />;
    case 'logs':
      return <Logs />;
  }
}
