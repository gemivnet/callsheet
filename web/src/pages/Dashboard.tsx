import React, { useState } from 'react';
import { useFetch } from '../hooks.js';

interface HealthData {
  status: string;
  mode: string;
  uptime_seconds: number;
  generating: boolean;
}

interface BriefSummary {
  date: string;
  title: string;
  subtitle: string | null;
  sections: number;
}

interface Props {
  onNavigate: (page: { name: 'brief'; date: string }) => void;
}

export function Dashboard({ onNavigate }: Props) {
  const { data: health } = useFetch<HealthData>('/api/health');
  const { data: briefsData, refetch } = useFetch<{ briefs: BriefSummary[] }>('/api/briefs');
  const [generating, setGenerating] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const todayBrief = briefsData?.briefs?.find((b) => b.date === today);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch('/api/briefs/generate', { method: 'POST' });
      if (res.ok) refetch();
    } finally {
      setGenerating(false);
    }
  };

  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <div>
      <h2>Dashboard</h2>

      <div className="card-grid">
        <div className="card">
          <div className="card-label">Status</div>
          <div className="card-value" style={{ color: health ? '#16a34a' : '#9ca3af' }}>
            {health ? 'Online' : 'Loading...'}
          </div>
          {health && <div className="card-meta">Uptime: {formatUptime(health.uptime_seconds)}</div>}
        </div>

        <div className="card">
          <div className="card-label">Today&apos;s Brief</div>
          <div className="card-value">
            {todayBrief ? (
              <button className="link-button" onClick={() => onNavigate({ name: 'brief', date: today })}>
                {todayBrief.title}
              </button>
            ) : (
              <span style={{ color: '#9ca3af' }}>Not generated</span>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-label">Total Briefs</div>
          <div className="card-value">{briefsData?.briefs?.length ?? 0}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <h3>Quick Actions</h3>
        <div className="button-row">
          <button className="btn btn-primary" onClick={handleGenerate} disabled={generating}>
            {generating ? 'Generating...' : 'Generate Brief Now'}
          </button>
        </div>
      </div>

      {briefsData && briefsData.briefs.length > 0 && (
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <h3>Recent Briefs</h3>
          <div className="list">
            {briefsData.briefs.slice(0, 7).map((brief) => (
              <button
                key={brief.date}
                className="list-item"
                onClick={() => onNavigate({ name: 'brief', date: brief.date })}
              >
                <div>
                  <div className="list-title">{brief.title}</div>
                  {brief.subtitle && <div className="list-subtitle">{brief.subtitle}</div>}
                </div>
                <span className="list-meta">{brief.date}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
