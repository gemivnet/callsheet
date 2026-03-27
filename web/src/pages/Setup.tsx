import React, { useState } from 'react';

interface Props {
  onComplete: () => void;
}

type Step = 'welcome' | 'api-key' | 'model' | 'connectors' | 'context' | 'review';

const STEPS: Step[] = ['welcome', 'api-key', 'model', 'connectors', 'context', 'review'];

const CONNECTOR_INFO: {
  key: string;
  label: string;
  description: string;
  auth: string;
  fields?: { key: string; label: string; placeholder: string; type?: string }[];
}[] = [
  {
    key: 'weather',
    label: 'Weather',
    description: 'Daily forecast via National Weather Service (US only)',
    auth: 'None',
    fields: [
      { key: 'location', label: 'Location name', placeholder: 'Denver, CO' },
      { key: 'lat', label: 'Latitude', placeholder: '39.7392', type: 'number' },
      { key: 'lon', label: 'Longitude', placeholder: '-104.9903', type: 'number' },
    ],
  },
  {
    key: 'todoist',
    label: 'Todoist',
    description: 'Tasks, inbox, and upcoming items',
    auth: 'API token',
    fields: [
      { key: 'account_name', label: 'Account name', placeholder: 'Your Name' },
      { key: 'token', label: 'API token', placeholder: 'Paste from Todoist settings' },
    ],
  },
  {
    key: 'google_calendar',
    label: 'Google Calendar',
    description: "Today's events + 7-day lookahead",
    auth: 'Google OAuth (set up after wizard)',
    fields: [
      { key: 'account_name', label: 'Account name', placeholder: 'Your Name' },
    ],
  },
  {
    key: 'gmail',
    label: 'Gmail',
    description: 'Scans recent emails for actionable signals',
    auth: 'Google OAuth (set up after wizard)',
    fields: [
      { key: 'account_name', label: 'Account name', placeholder: 'Your Name' },
    ],
  },
  {
    key: 'market',
    label: 'Market',
    description: 'Stock/fund daily snapshot + news',
    auth: 'None',
    fields: [
      { key: 'symbols', label: 'Ticker symbols (comma-separated)', placeholder: 'VTSAX, VTI' },
    ],
  },
  {
    key: 'aviation_weather',
    label: 'Aviation Weather',
    description: 'METAR/TAF for nearby airports (for pilots)',
    auth: 'None',
    fields: [
      {
        key: 'stations',
        label: 'ICAO station codes (comma-separated)',
        placeholder: 'KDEN, KBJC',
      },
    ],
  },
  {
    key: 'home_assistant',
    label: 'Home Assistant',
    description: 'Smart home sensor states + anomalies',
    auth: 'Long-lived access token',
    fields: [
      { key: 'url', label: 'HA URL', placeholder: 'http://homeassistant.local:8123' },
      { key: 'token', label: 'Long-lived access token', placeholder: 'Paste from HA profile' },
    ],
  },
  {
    key: 'actual_budget',
    label: 'Actual Budget',
    description: 'Recent transactions, spending, budget alerts',
    auth: 'Server password',
    fields: [
      { key: 'server_url', label: 'Server URL', placeholder: 'https://budget.example.com/budget' },
      { key: 'password', label: 'Server password', placeholder: '' },
      { key: 'sync_id', label: 'Sync ID', placeholder: 'From Actual Budget settings' },
    ],
  },
];

export function Setup({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-20250514');
  const [enabledConnectors, setEnabledConnectors] = useState<Set<string>>(new Set());
  const [connectorFields, setConnectorFields] = useState<Record<string, Record<string, string>>>(
    {},
  );
  const [context, setContext] = useState<Record<string, string>>({ people: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stepIndex = STEPS.indexOf(step);

  const toggleConnector = (key: string) => {
    setEnabledConnectors((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setField = (connector: string, field: string, value: string) => {
    setConnectorFields((prev) => ({
      ...prev,
      [connector]: { ...prev[connector], [field]: value },
    }));
  };

  const setContextField = (key: string, value: string) => {
    setContext((prev) => ({ ...prev, [key]: value }));
  };

  const addContextField = () => {
    const key = `custom_${Object.keys(context).length}`;
    setContext((prev) => ({ ...prev, [key]: '' }));
  };

  const removeContextField = (key: string) => {
    setContext((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const buildConfig = () => {
    const connectors: Record<string, Record<string, unknown>> = {};

    for (const key of enabledConnectors) {
      const fields = connectorFields[key] ?? {};
      const conn: Record<string, unknown> = { enabled: true };

      switch (key) {
        case 'weather':
          conn.location = fields.location ?? '';
          conn.lat = parseFloat(fields.lat ?? '0') || 0;
          conn.lon = parseFloat(fields.lon ?? '0') || 0;
          break;
        case 'todoist':
          conn.accounts = [
            { name: fields.account_name ?? 'Default', token_env: 'TODOIST_TOKEN_1' },
          ];
          break;
        case 'google_calendar':
          conn.credentials_dir = 'secrets';
          conn.credentials_file = 'credentials.json';
          conn.lookahead_days = 7;
          conn.accounts = [
            { name: fields.account_name ?? 'Default', calendar_ids: ['primary'] },
          ];
          break;
        case 'gmail':
          conn.credentials_dir = 'secrets';
          conn.credentials_file = 'credentials.json';
          conn.query = 'newer_than:2d -category:promotions -category:social';
          conn.max_messages = 25;
          if (fields.account_name) {
            conn.accounts = [{ name: fields.account_name }];
          }
          break;
        case 'market':
          conn.symbols = (fields.symbols ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          break;
        case 'aviation_weather':
          conn.stations = (fields.stations ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          break;
        case 'home_assistant':
          conn.url = fields.url ?? '';
          conn.token_env = 'HA_TOKEN';
          conn.entities = [];
          break;
        case 'actual_budget':
          conn.server_url = fields.server_url ?? '';
          conn.password_env = 'ACTUAL_BUDGET_PASSWORD';
          conn.sync_id = fields.sync_id ?? '';
          conn.lookback_days = 7;
          break;
      }

      connectors[key] = conn;
    }

    // Filter out empty context entries
    const cleanContext: Record<string, string> = {};
    for (const [k, v] of Object.entries(context)) {
      if (v.trim()) cleanContext[k] = v.trim();
    }

    return { model, connectors, context: cleanContext, anthropic_api_key: apiKey || undefined };
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConfig()),
      });
      const data = await res.json();
      if (data.success) {
        onComplete();
      } else {
        setError(data.error ?? 'Failed to save configuration');
      }
    } catch {
      setError('Failed to connect to server');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '2rem' }}>
      {/* Progress */}
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '2rem' }}>
        {STEPS.map((s, i) => (
          <div
            key={s}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: i <= stepIndex ? '#2563eb' : '#e5e7eb',
            }}
          />
        ))}
      </div>

      {/* Welcome */}
      {step === 'welcome' && (
        <div>
          <h2>Welcome to Callsheet</h2>
          <p style={{ color: '#6b7280', lineHeight: 1.6, marginBottom: '1.5rem' }}>
            This wizard will walk you through creating your configuration. You'll set up your
            API key, choose a model, enable connectors, and add household context.
          </p>
          <p style={{ color: '#6b7280', lineHeight: 1.6, marginBottom: '1.5rem' }}>
            You can always change these settings later from the Config page.
          </p>
          <button className="btn btn-primary" onClick={() => setStep('api-key')}>
            Get Started
          </button>
        </div>
      )}

      {/* API Key */}
      {step === 'api-key' && (
        <div>
          <h2>Anthropic API Key</h2>
          <p className="muted" style={{ marginBottom: '1rem' }}>
            Sign up at{' '}
            <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">
              console.anthropic.com
            </a>{' '}
            and add credits ($5 covers months of daily briefs).
          </p>
          <input
            type="password"
            className="config-editor"
            style={{ height: 'auto', padding: '0.625rem 0.75rem', resize: 'none' }}
            placeholder="sk-ant-api03-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.75rem' }}>
            Stored in .env, never committed to git. You can also set this manually later.
          </p>
        </div>
      )}

      {/* Model */}
      {step === 'model' && (
        <div>
          <h2>Choose a Model</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <label
              className="card"
              style={{
                cursor: 'pointer',
                border:
                  model === 'claude-sonnet-4-20250514'
                    ? '2px solid #2563eb'
                    : '1px solid #e5e7eb',
              }}
            >
              <input
                type="radio"
                name="model"
                value="claude-sonnet-4-20250514"
                checked={model === 'claude-sonnet-4-20250514'}
                onChange={(e) => setModel(e.target.value)}
                style={{ display: 'none' }}
              />
              <div style={{ fontWeight: 600 }}>Sonnet</div>
              <div className="muted">
                Fast and cheap. ~$0.02-0.04/day. Great for most households.
              </div>
            </label>
            <label
              className="card"
              style={{
                cursor: 'pointer',
                border:
                  model === 'claude-opus-4-6' ? '2px solid #2563eb' : '1px solid #e5e7eb',
              }}
            >
              <input
                type="radio"
                name="model"
                value="claude-opus-4-6"
                checked={model === 'claude-opus-4-6'}
                onChange={(e) => setModel(e.target.value)}
                style={{ display: 'none' }}
              />
              <div style={{ fontWeight: 600 }}>Opus</div>
              <div className="muted">
                Deeper reasoning, better cross-referencing. ~$0.15-0.20/day.
              </div>
            </label>
          </div>
        </div>
      )}

      {/* Connectors */}
      {step === 'connectors' && (
        <div>
          <h2>Enable Connectors</h2>
          <p className="muted" style={{ marginBottom: '1rem' }}>
            Pick the data sources you want. Start with 1-2 and add more later.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {CONNECTOR_INFO.map((conn) => (
              <div key={conn.key} className="card" style={{ padding: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <input
                    type="checkbox"
                    checked={enabledConnectors.has(conn.key)}
                    onChange={() => toggleConnector(conn.key)}
                    style={{ width: 18, height: 18 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{conn.label}</div>
                    <div className="muted">{conn.description}</div>
                    <div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>Auth: {conn.auth}</div>
                  </div>
                </div>
                {enabledConnectors.has(conn.key) && conn.fields && (
                  <div
                    style={{
                      marginTop: '0.75rem',
                      paddingTop: '0.75rem',
                      borderTop: '1px solid #f3f4f6',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                    }}
                  >
                    {conn.fields.map((field) => (
                      <div key={field.key}>
                        <label
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 500,
                            color: '#6b7280',
                            display: 'block',
                            marginBottom: '0.25rem',
                          }}
                        >
                          {field.label}
                        </label>
                        <input
                          type={field.type ?? 'text'}
                          className="config-editor"
                          style={{
                            height: 'auto',
                            padding: '0.5rem 0.625rem',
                            resize: 'none',
                            fontSize: '0.8rem',
                          }}
                          placeholder={field.placeholder}
                          value={connectorFields[conn.key]?.[field.key] ?? ''}
                          onChange={(e) => setField(conn.key, field.key, e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Context */}
      {step === 'context' && (
        <div>
          <h2>Household Context</h2>
          <p className="muted" style={{ marginBottom: '1rem' }}>
            Tell Claude about your household so it can make smarter connections. Include names,
            schedules, deadlines, health needs — anything that helps personalize the brief.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {Object.entries(context).map(([key, val]) => (
              <div key={key}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.25rem',
                  }}
                >
                  {key === 'people' ? (
                    <label
                      style={{ fontSize: '0.75rem', fontWeight: 500, color: '#6b7280' }}
                    >
                      People
                    </label>
                  ) : (
                    <input
                      type="text"
                      value={key.startsWith('custom_') ? '' : key}
                      placeholder="Label (e.g. work, health, travel)"
                      onChange={(e) => {
                        const newKey = e.target.value || key;
                        if (newKey !== key) {
                          setContext((prev) => {
                            const next: Record<string, string> = {};
                            for (const [k, v] of Object.entries(prev)) {
                              next[k === key ? newKey : k] = v;
                            }
                            return next;
                          });
                        }
                      }}
                      style={{
                        border: 'none',
                        fontSize: '0.75rem',
                        fontWeight: 500,
                        color: '#6b7280',
                        background: 'transparent',
                        outline: 'none',
                      }}
                    />
                  )}
                  {key !== 'people' && (
                    <button
                      className="btn-danger-small"
                      onClick={() => removeContextField(key)}
                      style={{ fontSize: '0.65rem' }}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <textarea
                  className="config-editor"
                  style={{ height: 60, fontSize: '0.8rem' }}
                  placeholder={
                    key === 'people'
                      ? 'Alex (32) and Jordan (30)'
                      : 'Describe this aspect of your household...'
                  }
                  value={val}
                  onChange={(e) => setContextField(key, e.target.value)}
                />
              </div>
            ))}
            <button
              className="btn btn-secondary"
              onClick={addContextField}
              style={{ alignSelf: 'flex-start' }}
            >
              + Add field
            </button>
          </div>
        </div>
      )}

      {/* Review */}
      {step === 'review' && (
        <div>
          <h2>Review</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div className="card">
              <div className="card-label">Model</div>
              <div className="card-value" style={{ fontSize: '0.875rem' }}>
                {model.includes('sonnet') ? 'Sonnet' : 'Opus'}
              </div>
            </div>
            <div className="card">
              <div className="card-label">API Key</div>
              <div className="card-value" style={{ fontSize: '0.875rem' }}>
                {apiKey ? `${apiKey.slice(0, 12)}...` : 'Not set (set manually in .env)'}
              </div>
            </div>
            <div className="card">
              <div className="card-label">Connectors</div>
              <div style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
                {enabledConnectors.size === 0 ? (
                  <span className="muted">None enabled</span>
                ) : (
                  [...enabledConnectors].map((c) => (
                    <span
                      key={c}
                      className="badge badge-green"
                      style={{ marginRight: '0.375rem', marginBottom: '0.25rem' }}
                    >
                      {CONNECTOR_INFO.find((ci) => ci.key === c)?.label ?? c}
                    </span>
                  ))
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-label">Household Context</div>
              <div style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
                {Object.entries(context).filter(([, v]) => v.trim()).length === 0 ? (
                  <span className="muted">None added</span>
                ) : (
                  Object.entries(context)
                    .filter(([, v]) => v.trim())
                    .map(([k]) => (
                      <span
                        key={k}
                        className="badge badge-gray"
                        style={{ marginRight: '0.375rem', marginBottom: '0.25rem' }}
                      >
                        {k}
                      </span>
                    ))
                )}
              </div>
            </div>
          </div>

          {error && <p className="error" style={{ marginTop: '1rem' }}>{error}</p>}

          <div style={{ marginTop: '1rem' }}>
            <p className="muted" style={{ marginBottom: '0.75rem' }}>
              This will create <code>config.yaml</code>
              {apiKey ? ' and update ' : ''}
              {apiKey ? <code>.env</code> : ''} in the project root.
              {enabledConnectors.has('google_calendar') || enabledConnectors.has('gmail')
                ? ' You can authorize Google connectors from the Connectors page after setup.'
                : ''}
            </p>
          </div>
        </div>
      )}

      {/* Navigation */}
      {step !== 'welcome' && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: '1.5rem',
            paddingTop: '1.5rem',
            borderTop: '1px solid #e5e7eb',
          }}
        >
          <button
            className="btn btn-secondary"
            onClick={() => setStep(STEPS[stepIndex - 1])}
          >
            Back
          </button>
          {step === 'review' ? (
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save & Finish'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setStep(STEPS[stepIndex + 1])}>
              Continue
            </button>
          )}
        </div>
      )}
    </div>
  );
}
