import React from 'react';
import { useFetch } from '../hooks.js';

interface MemoryEntry {
  date: string;
  insights: string[];
}

export function Memory() {
  const { data, loading, refetch } = useFetch<{ memories: MemoryEntry[] }>('/api/memory');

  const handleDelete = async (date: string) => {
    if (!confirm(`Delete memory for ${date}?`)) return;
    await fetch(`/api/memory/${date}`, { method: 'DELETE' });
    refetch();
  };

  return (
    <div>
      <div className="page-header">
        <h2>Memory</h2>
        <p className="page-description">Insights extracted from each brief for continuity across days.</p>
      </div>

      {loading && <p className="muted">Loading...</p>}

      {data && data.memories.length === 0 && (
        <div className="empty-state">
          <p>No memories yet. Generate a brief first.</p>
        </div>
      )}

      {data?.memories.map((mem) => (
        <div key={mem.date} className="card" style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>{mem.date}</h3>
            <button className="btn btn-danger-small" onClick={() => handleDelete(mem.date)}>
              Delete
            </button>
          </div>
          <ul className="insight-list">
            {mem.insights.map((insight, i) => (
              <li key={i}>{insight}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
