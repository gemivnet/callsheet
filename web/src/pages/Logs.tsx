import React from 'react';
import { useFetch } from '../hooks.js';

interface LogsData {
  lines: string[];
  total: number;
}

export function Logs() {
  const { data, loading, refetch } = useFetch<LogsData>('/api/logs?lines=200');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Logs</h2>
        <button className="btn btn-secondary" onClick={refetch}>Refresh</button>
      </div>

      {loading && <p className="muted">Loading...</p>}

      {data && (
        <div className="card">
          <div className="card-meta" style={{ marginBottom: '0.5rem' }}>
            Showing last {data.lines.length} of {data.total} lines
          </div>
          <pre className="log-viewer">
            {data.lines.length > 0 ? data.lines.join('\n') : 'No logs yet.'}
          </pre>
        </div>
      )}
    </div>
  );
}
