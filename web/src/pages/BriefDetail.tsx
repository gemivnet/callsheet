import React from 'react';
import { useFetch } from '../hooks.js';

interface BriefItem {
  label: string;
  time?: string;
  note?: string;
  checkbox?: boolean;
  highlight?: boolean;
  urgent?: boolean;
}

interface BriefSection {
  heading: string;
  items?: BriefItem[];
  body?: string;
}

interface Brief {
  title: string;
  subtitle?: string;
  sections: BriefSection[];
}

interface Props {
  date: string;
  onBack: () => void;
}

export function BriefDetail({ date, onBack }: Props) {
  const { data: brief, loading, error } = useFetch<Brief>(`/api/briefs/${date}`);

  return (
    <div>
      <button className="btn btn-secondary" onClick={onBack} style={{ marginBottom: '1rem' }}>
        &larr; Back to Briefs
      </button>

      {loading && <p className="muted">Loading...</p>}
      {error && <p className="error">Error: {error}</p>}

      {brief && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
            <div>
              <h2 style={{ margin: 0 }}>{brief.title}</h2>
              {brief.subtitle && <p className="muted" style={{ margin: 0 }}>{brief.subtitle}</p>}
              <p className="list-subtitle">{date}</p>
            </div>
            <a
              href={`/api/briefs/${date}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
              style={{ marginLeft: 'auto' }}
            >
              View PDF
            </a>
          </div>

          {brief.sections.map((section, i) => (
            <div key={i} className="card" style={{ marginBottom: '1rem' }}>
              <h3>{section.heading}</h3>

              {section.body && <p className="brief-body">{section.body}</p>}

              {section.items && section.items.length > 0 && (
                <div className="list">
                  {section.items.map((item, j) => (
                    <div key={j} className={`brief-item ${item.urgent ? 'urgent' : ''} ${item.highlight ? 'highlight' : ''}`}>
                      {item.checkbox && <span className="checkbox">☐</span>}
                      {item.time && <span className="item-time">{item.time}</span>}
                      <span className="item-label">{item.label}</span>
                      {item.note && <span className="item-note">{item.note}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
