import type {
  ConnectorResult,
  ConnectorConfig,
  Brief,
  BriefSection,
  BriefItem,
  CallsheetConfig,
  AutoCloseRecommendation,
  Check,
} from '../src/types.js';

describe('types', () => {
  it('ConnectorResult should satisfy the interface', () => {
    const result: ConnectorResult = {
      source: 'test',
      description: 'A test connector',
      data: { key: 'value' },
      priorityHint: 'high',
    };
    expect(result.source).toBe('test');
    expect(result.priorityHint).toBe('high');
  });

  it('priorityHint should accept all valid values', () => {
    const hints: ConnectorResult['priorityHint'][] = ['high', 'normal', 'low'];
    expect(hints).toHaveLength(3);
  });

  it('Brief should support full structure', () => {
    const item: BriefItem = {
      label: 'Test item',
      time: '9:00 AM',
      note: 'important',
      checkbox: true,
      highlight: false,
      urgent: true,
    };
    const section: BriefSection = {
      heading: 'Schedule',
      items: [item],
      body: 'Some text',
    };
    const brief: Brief = {
      title: 'Daily Brief',
      subtitle: 'March 25',
      sections: [section],
    };

    expect(brief.title).toBe('Daily Brief');
    expect(brief.sections[0].items![0].urgent).toBe(true);
  });

  it('CallsheetConfig should allow optional fields', () => {
    const minimal: CallsheetConfig = {};
    expect(minimal.model).toBeUndefined();

    const full: CallsheetConfig = {
      model: 'claude-sonnet-4-20250514',
      printer: 'Brother',
      output_dir: 'output',
      credentials_dir: 'secrets',
      context: { family: 'Person1 + partner' },
      connectors: { weather: { enabled: true } },
      extras: [{ name: 'Joke', instruction: 'Add a dad joke' }],
      auto_close_tasks: true,
    };
    expect(full.auto_close_tasks).toBe(true);
  });

  it('AutoCloseRecommendation should have required fields', () => {
    const rec: AutoCloseRecommendation = {
      task_id: '123',
      task_content: 'Pay electric bill',
      person: 'Person1',
      reason: 'Payment confirmed in email',
    };
    expect(rec.task_id).toBe('123');
  });

  it('Check tuple should have icon, msg, detail', () => {
    const check: Check = ['✓', 'Token found', '/path/to/token'];
    expect(check).toHaveLength(3);
    expect(check[0]).toBe('✓');
  });

  it('ConnectorConfig should accept arbitrary keys', () => {
    const config: ConnectorConfig = {
      enabled: true,
      lat: 40.7,
      lon: -74.0,
      custom_field: 'value',
    };
    expect(config.enabled).toBe(true);
    expect(config.lat).toBe(40.7);
  });
});
