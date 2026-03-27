import React, { useState } from 'react';
import { useFetch } from '../hooks.js';

interface ConnectorInfo {
  name: string;
  enabled: boolean;
  has_auth: boolean;
  has_validate: boolean;
}

interface CheckResult {
  icon: string;
  message: string;
  detail: string;
}

export function Connectors() {
  const { data, loading } = useFetch<{ connectors: ConnectorInfo[] }>('/api/connectors');
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, CheckResult[]>>({});

  const handleTest = async (name: string) => {
    setTesting(name);
    try {
      const res = await fetch(`/api/connectors/${name}/test`, { method: 'POST' });
      const data = await res.json();
      setResults((prev) => ({ ...prev, [name]: data.checks ?? [] }));
    } catch {
      setResults((prev) => ({ ...prev, [name]: [{ icon: '✗', message: 'Test failed', detail: '' }] }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div>
      <h2>Connectors</h2>

      {loading && <p className="muted">Loading...</p>}

      <div className="card-grid">
        {data?.connectors.map((conn) => (
          <div key={conn.name} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="card-label">{conn.name}</div>
              <span className={`badge ${conn.enabled ? 'badge-green' : 'badge-gray'}`}>
                {conn.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div className="card-meta" style={{ marginTop: '0.5rem' }}>
              {conn.has_auth && 'OAuth'} {conn.has_validate && '• Validatable'}
            </div>
            {conn.has_validate && (
              <button
                className="btn btn-secondary"
                style={{ marginTop: '0.75rem' }}
                onClick={() => handleTest(conn.name)}
                disabled={testing === conn.name}
              >
                {testing === conn.name ? 'Testing...' : 'Test'}
              </button>
            )}
            {results[conn.name] && (
              <div className="test-results">
                {results[conn.name].map((check, i) => (
                  <div key={i} className="test-check">
                    <span>{check.icon}</span>
                    <span>{check.message}</span>
                    {check.detail && <span className="muted"> — {check.detail}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
