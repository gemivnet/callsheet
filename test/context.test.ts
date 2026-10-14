import { datesIn, prepareContext } from '../src/context.js';

describe('datesIn', () => {
  it('reads ISO dates, written dates, ranges and month-only mentions', () => {
    expect(
      datesIn(
        'Trip May 7-25, 2026; check-in 2026-03-01; deadline: end of June 2026; review Sept 9th, 2026; Dec. 2027',
      ),
    ).toEqual(['2026-03-01', '2026-05-25', '2026-06-30', '2026-09-09', '2027-12-31']);
  });

  it('ignores dates without a year and impossible days', () => {
    expect(datesIn('Every Tuesday; May 40, 2026; the 3rd')).toEqual([]);
    expect(datesIn('Feb 30, 2026')).toEqual(['2026-02-28']);
  });

  it('does not count a dated mention twice as a month mention', () => {
    expect(datesIn('April 20, 2026')).toEqual(['2026-04-20']);
  });
});

describe('prepareContext', () => {
  const today = '2026-10-14';

  it('passes current prose through untouched', () => {
    const r = prepareContext(
      { people: 'Two adults and a dog', plans: 'Remodel done by March 2027' },
      today,
    );
    expect(r.entries).toEqual([
      ['people', 'Two adults and a dog'],
      ['plans', 'Remodel done by March 2027'],
    ]);
    expect(r.stale).toEqual([]);
  });

  it('marks prose whose dates have all passed as history', () => {
    const r = prepareContext({ travel: 'Trip May 7-25, 2026. Flag the countdown.' }, today);
    expect(r.stale).toEqual([{ key: 'travel', latest: '2026-05-25' }]);
    expect(r.entries[0][1]).toContain('Every date in this note (latest 2026-05-25) has passed: any plan or deadline it describes is over');
  });

  it('drops an entry whose until date has passed, and keeps a current one as written', () => {
    const r = prepareContext(
      {
        trip: { text: 'Away the week of 2026-09-07', until: '2026-09-13' },
        season: { text: 'Practice season runs through 2026-09-01', until: '2026-12-01' },
        empty: '   ',
        blank: { text: '' },
      },
      today,
    );
    expect(r.expired).toEqual(['trip']);
    // An explicit `until` in the future overrides the date scan.
    expect(r.entries).toEqual([['season', 'Practice season runs through 2026-09-01']]);
    expect(r.stale).toEqual([]);
  });

  it('copes with no context at all', () => {
    expect(prepareContext(undefined, today)).toEqual({ entries: [], expired: [], stale: [] });
  });
});
