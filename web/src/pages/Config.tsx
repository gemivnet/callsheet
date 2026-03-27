import React, { useState, useEffect } from 'react';

export function Config() {
  const [config, setConfig] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => {
        setConfig(JSON.stringify(data, null, 2));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const parsed = JSON.parse(config);
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      if (res.ok) {
        setStatus('Saved!');
      } else {
        const err = await res.json();
        setStatus(`Error: ${err.error}`);
      }
    } catch (e) {
      setStatus(`Invalid JSON: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2>Config</h2>
      <p className="muted">Edit your config.yaml (shown as JSON). Changes are saved back as YAML.</p>

      {loading && <p className="muted">Loading...</p>}

      {!loading && (
        <div className="card">
          <textarea
            className="config-editor"
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            rows={30}
          />
          <div className="button-row" style={{ marginTop: '1rem' }}>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Config'}
            </button>
            {status && <span className={status.startsWith('Error') ? 'error' : 'success'}>{status}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
