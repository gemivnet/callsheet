import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useFetch } from '../hooks.js';

interface CheckResult {
  icon: string;
  message: string;
  detail: string;
}

interface ConnectorDetailData {
  name: string;
  enabled: boolean;
  has_auth: boolean;
  has_validate: boolean;
  config: Record<string, unknown>;
  checks: CheckResult[];
  accounts: string[] | null;
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
  connector: string;
  onBack: () => void;
}

export function ConnectorDetail({ connector, onBack }: Props) {
  const { data, loading, refetch } = useFetch<ConnectorDetailData>(
    `/api/connectors/${connector}`,
  );
  const [authLoading, setAuthLoading] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<number | null>(null);

  // Poll for popup close and refetch when it does
  const watchPopup = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      if (popupRef.current?.closed) {
        if (pollRef.current) clearInterval(pollRef.current);
        popupRef.current = null;
        setAuthLoading(null);
        refetch();
      }
    }, 500);
  }, [refetch]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleAuth = async (accountName?: string) => {
    setAuthLoading(accountName ?? '__default__');
    try {
      const res = await fetch(`/api/connectors/${connector}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: accountName }),
      });
      const result = await res.json();
      if (result.auth_url) {
        popupRef.current = window.open(
          result.auth_url,
          '_blank',
          'width=500,height=700',
        );
        watchPopup();
      }
    } catch {
      setAuthLoading(null);
    }
  };

  const label = LABELS[connector] ?? connector;

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <button className="link-button" onClick={onBack}>
          ← Back to Connectors
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.25rem',
        }}
      >
        <h2 style={{ marginBottom: 0 }}>{label}</h2>
        {data && (
          <span
            className={`badge ${data.enabled ? 'badge-green' : 'badge-gray'}`}
          >
            {data.enabled ? 'Enabled' : 'Disabled'}
          </span>
        )}
      </div>

      {loading && <p className="muted">Loading...</p>}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Status Checks */}
          <div className="card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '0.75rem',
              }}
            >
              <h3 style={{ marginBottom: 0 }}>Status Checks</h3>
              <button className="btn btn-secondary" onClick={refetch}>
                Re-check
              </button>
            </div>
            {data.checks.length === 0 ? (
              <p className="muted">No validation checks available.</p>
            ) : (
              <div className="check-list">
                {data.checks.map((check, i) => (
                  <div key={i} className="check-item">
                    <span className="check-icon">{check.icon}</span>
                    <span>{check.message}</span>
                    {check.detail && (
                      <span className="muted"> — {check.detail}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Auth section */}
          {data.has_auth && (
            <div className="card">
              <h3>Authorization</h3>
              <p className="muted" style={{ marginBottom: '0.75rem' }}>
                This connector uses OAuth. Authorize accounts to grant read
                access.
              </p>
              {data.accounts && data.accounts.length > 0 ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.5rem',
                  }}
                >
                  {data.accounts.map((acct) => (
                    <div
                      key={acct}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '0.5rem 0',
                        borderBottom: '1px solid #f3f4f6',
                      }}
                    >
                      <span style={{ fontSize: '0.875rem' }}>{acct}</span>
                      <button
                        className="btn btn-primary"
                        onClick={() => handleAuth(acct)}
                        disabled={authLoading === acct}
                        style={{ fontSize: '0.8rem', padding: '0.375rem 0.75rem' }}
                      >
                        {authLoading === acct
                          ? 'Authorizing...'
                          : 'Authorize'}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => handleAuth()}
                  disabled={authLoading !== null}
                >
                  {authLoading ? 'Authorizing...' : `Authorize ${label}`}
                </button>
              )}
            </div>
          )}

          {/* Configuration */}
          <div className="card">
            <h3>Configuration</h3>
            {Object.keys(data.config).length === 0 ? (
              <p className="muted">
                Not configured. Add this connector to your config.yaml.
              </p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.config).map(([key, val]) => (
                    <tr key={key}>
                      <td>
                        <code>{key}</code>
                      </td>
                      <td>
                        {typeof val === 'object'
                          ? JSON.stringify(val, null, 2)
                          : String(val)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
