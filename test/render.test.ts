import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
jest.unstable_mockModule('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

// Stand-ins for the PDF primitives that pass their children through, so a
// small walker can run every component of the real document tree.
const component = ({ children }: { children?: unknown }) => children ?? null;
const printed: string[] = [];
function walk(node: unknown): void {
  if (node == null || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    printed.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof el.type === 'function') {
    walk((el.type as (p: unknown) => unknown)(el.props ?? {}));
  } else if (el.props) {
    walk(el.props.children);
  }
}
const mockRenderToBuffer = jest.fn(async (doc: unknown) => {
  walk(doc);
  return Buffer.from('%PDF');
});
jest.unstable_mockModule('@react-pdf/renderer', () => ({
  Document: component,
  Page: component,
  View: component,
  Text: component,
  Font: { register: jest.fn(), registerHyphenationCallback: jest.fn() },
  StyleSheet: { create: <T>(styles: T) => styles },
  renderToBuffer: mockRenderToBuffer,
}));

const { renderPdf } = await import('../src/render.js');

describe('renderPdf', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });

  afterEach(() => {
    jest.useRealTimers();
    // Assigning undefined would store the string "undefined".
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("files the PDF under the household's date, not the UTC one", async () => {
    // 8:30 PM on the 14th in New York is already the 15th in UTC.
    process.env.TZ = 'America/New_York';
    jest.setSystemTime(new Date('2030-01-15T01:30:00Z'));

    const path = await renderPdf({ title: 'T', sections: [] }, '/out');

    expect(path).toBe('/out/callsheet_2030-01-14.pdf');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/out/callsheet_2030-01-14.pdf',
      expect.any(Buffer),
    );
    expect(mockMkdirSync).toHaveBeenCalledWith('/out', { recursive: true });
  });

  it('lays out every kind of section and item the brief can carry', async () => {
    printed.length = 0;
    await renderPdf(
      {
        title: 'Wednesday, March 4, 2026',
        subtitle: 'A quiet day',
        sections: [
          {
            heading: 'Executive Brief',
            items: [
              { label: 'Snow tonight — garage the car', urgent: true },
              { label: 'Español: "¿Dónde está?" — Where is it?' },
            ],
          },
          {
            heading: "Today's Schedule",
            items: [{ time: '9:00 AM', label: 'Alex: Practice', note: 'Field 2' }],
          },
          {
            heading: 'Tasks',
            items: [
              { label: 'Put the bins out', checkbox: true, highlight: true },
              { label: 'Renew registration', checkbox: true, note: 'Alex - due Friday' },
            ],
          },
          { heading: 'Notes', body: 'First paragraph.\n\nSecond paragraph.' },
        ],
      },
      '/out',
    );

    const text = printed.join(' ');
    for (const expected of [
      'Wednesday, March 4, 2026',
      'A quiet day',
      'Snow tonight — garage the car',
      'Alex: Practice',
      'Field 2',
      'Renew registration',
      'First paragraph.',
    ]) {
      expect(text).toContain(expected);
    }
  });
});
