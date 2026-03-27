import React from 'react';
import { useFetch } from '../hooks.js';

interface ConnectorInfo {
  name: string;
  enabled: boolean;
  has_auth: boolean;
  has_validate: boolean;
}

const LABELS: Record<string, string> = {
  weather: 'Weather',
  todoist: 'Todoist',
  google_calendar: 'Google Calendar',
  gmail: 'Gmail',
  aviation_weather: 'Aviation Weather',
  market: 'Market',
  home_assistant: 'Home Assistant',
  actual_budget: 'Actual Budget',
};

interface Props {
  onNavigate: (page: { name: 'connector-detail'; connector: string }) => void;
}

export function Connectors({ onNavigate }: Props) {
  const { data, loading } = useFetch<{ connectors: ConnectorInfo[] }>('/api/connectors');

  return (
    <div>
      <h2>Connectors</h2>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        Data sources that feed into your daily brief.
      </p>

      {loading && <p className="muted">Loading...</p>}

      {data && (
        <div className="card">
          <div className="list">
            {data.connectors.map((conn) => (
              <button
                key={conn.name}
                className="list-item"
                onClick={() =>
                  onNavigate({ name: 'connector-detail', connector: conn.name })
                }
              >
                <div>
                  <div className="list-title">{LABELS[conn.name] ?? conn.name}</div>
                  <div className="list-subtitle">
                    {conn.has_auth && 'OAuth'}
                    {conn.has_auth && conn.has_validate && ' · '}
                    {conn.has_validate && 'Validatable'}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span
                    className={`badge ${conn.enabled ? 'badge-green' : 'badge-gray'}`}
                  >
                    {conn.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <span className="muted">›</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
