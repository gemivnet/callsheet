import React from 'react';
import { useFetch } from '../hooks.js';

interface BriefSummary {
  date: string;
  title: string;
  subtitle: string | null;
  sections: number;
}

interface Props {
  onNavigate: (page: { name: 'brief'; date: string }) => void;
}

export function Briefs({ onNavigate }: Props) {
  const { data, loading } = useFetch<{ briefs: BriefSummary[] }>('/api/briefs');

  return (
    <div>
      <h2>Briefs</h2>

      {loading && <p className="muted">Loading...</p>}

      {data && data.briefs.length === 0 && (
        <p className="muted">No briefs generated yet.</p>
      )}

      {data && data.briefs.length > 0 && (
        <div className="card">
          <div className="list">
            {data.briefs.map((brief) => (
              <button
                key={brief.date}
                className="list-item"
                onClick={() => onNavigate({ name: 'brief', date: brief.date })}
              >
                <div>
                  <div className="list-title">{brief.title}</div>
                  {brief.subtitle && <div className="list-subtitle">{brief.subtitle}</div>}
                  <div className="list-subtitle">{brief.sections} sections</div>
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
