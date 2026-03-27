import React from 'react';
import { useFetch } from '../hooks.js';

interface UsageSummary {
  month: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  brief_count: number;
  total_api_calls: number;
  by_model: Record<string, { calls: number; cost: number }>;
}

export function Usage() {
  const { data, loading } = useFetch<UsageSummary>('/api/usage');

  return (
    <div>
      <h2>Usage</h2>

      {loading && <p className="muted">Loading...</p>}

      {data && (
        <>
          <div className="card-grid">
            <div className="card">
              <div className="card-label">Month</div>
              <div className="card-value">{data.month}</div>
            </div>
            <div className="card">
              <div className="card-label">Total Cost</div>
              <div className="card-value">${data.total_cost_usd.toFixed(4)}</div>
            </div>
            <div className="card">
              <div className="card-label">Briefs Generated</div>
              <div className="card-value">{data.brief_count}</div>
            </div>
            <div className="card">
              <div className="card-label">API Calls</div>
              <div className="card-value">{data.total_api_calls}</div>
            </div>
            <div className="card">
              <div className="card-label">Input Tokens</div>
              <div className="card-value">{data.total_input_tokens.toLocaleString()}</div>
            </div>
            <div className="card">
              <div className="card-label">Output Tokens</div>
              <div className="card-value">{data.total_output_tokens.toLocaleString()}</div>
            </div>
          </div>

          {Object.keys(data.by_model).length > 0 && (
            <div className="card" style={{ marginTop: '1.5rem' }}>
              <h3>By Model</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Calls</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.by_model).map(([model, info]) => (
                    <tr key={model}>
                      <td>{model}</td>
                      <td>{info.calls}</td>
                      <td>${info.cost.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
