/**
 * Behavioural test for the overview and pages statements that build state per
 * session, executed against the isolated `openpanel_test` ClickHouse (pinned
 * by test/preload.ts).
 *
 * Events tracked server-side (a secret-authenticated client, no browser) are
 * stored with session_id ''. Grouped or partitioned by session, every such
 * event in a project used to land in one shared session: the user journey
 * drew a path from one user's page to another's (and had to hold every
 * sessionless screen view of the range in one group), and a screen view's
 * duration ran to another user's next view. Seeded here: one real two-page
 * session, and two sessionless users who each viewed one page.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SqlFragment } from '@openpanel/db/src/clickhouse/sql';

const PROJECT_ID = 'overview-sessionless-events-test';
const DAY = '2026-03-11';
const WINDOW_START = `${DAY} 00:00:00`;
const WINDOW_END = `${DAY} 23:59:59`;
const JOURNEY_STEPS = 5;
const TOP_ENTRIES = 3;

const SHARED_PAGE = '/a';
const SESSION_NEXT_PAGE = '/b';
const SERVER_ONLY_PAGE = '/c';
/** The real session's view of SHARED_PAGE lasts until its next view. */
const SECONDS_ON_SHARED_PAGE = 60;
/** That view, averaged with the sessionless one, which stands alone (0). */
const AVERAGE_MINUTES_ON_SHARED_PAGE = 0.5;

const screenView = (
  index: number,
  path: string,
  time: string,
  profileId: string,
  sessionId: string
) => ({
  id: `00000000-0000-0000-0000-0000000000${String(index).padStart(2, '0')}`,
  project_id: PROJECT_ID,
  name: 'screen_view',
  created_at: `${DAY} ${time}`,
  profile_id: profileId,
  device_id: profileId,
  session_id: sessionId,
  path,
});

const SEEDED_EVENTS = [
  screenView(1, SHARED_PAGE, '10:00:00', 'profile-in-session', 'session-1'),
  screenView(
    2,
    SESSION_NEXT_PAGE,
    '10:01:00',
    'profile-in-session',
    'session-1'
  ),
  screenView(3, SHARED_PAGE, '11:00:00', 'server-profile-a', ''),
  screenView(4, SERVER_ONLY_PAGE, '11:02:00', 'server-profile-b', ''),
];

let ch: typeof import('@openpanel/db/src/clickhouse/client').ch;
let OV: typeof import('./overview.sql');
let PG: typeof import('./pages.sql');
let getRawWhereClause: typeof import('../overview.service').getRawWhereClause;

async function rowsOf<Row>(fragment: SqlFragment): Promise<Row[]> {
  const { query, query_params } = fragment.toStatement();
  const result = await ch.query({
    query,
    query_params,
    format: 'JSONEachRow',
    clickhouse_settings: { session_timezone: 'UTC' },
  });
  return result.json<Row>();
}

const journeyInput = {
  projectId: PROJECT_ID,
  startDate: WINDOW_START,
  endDate: WINDOW_END,
  rawFilterWhere: null,
  steps: JOURNEY_STEPS,
};

beforeAll(async () => {
  ({ ch } = await import('@openpanel/db/src/clickhouse/client'));
  OV = await import('./overview.sql');
  PG = await import('./pages.sql');
  ({ getRawWhereClause } = await import('../overview.service'));

  const { bootstrapTestDatabases } = await import(
    '../../../../../../test/bootstrap-databases'
  );
  await bootstrapTestDatabases();

  await ch.command({
    query: `DELETE FROM events WHERE project_id = '${PROJECT_ID}'`,
  });
  await ch.insert({
    table: 'events',
    values: SEEDED_EVENTS,
    format: 'JSONEachRow',
  });
}, 30_000);

afterAll(async () => {
  await ch.command({
    query: `DELETE FROM events WHERE project_id = '${PROJECT_ID}'`,
  });
});

describe('user journey — sessionless events', () => {
  it('starts paths only from real sessions', async () => {
    const rows = await rowsOf<{ entry_page: string; count: string }>(
      OV.topEntriesQuery({ ...journeyInput, topEntries: TOP_ENTRIES })
    );
    expect(rows.map((row) => [row.entry_page, Number(row.count)])).toEqual([
      [SHARED_PAGE, 1],
    ]);
  });

  it('never links one sessionless user to another', async () => {
    const rows = await rowsOf<{
      source: string;
      target: string;
      value: string;
    }>(OV.transitionsQuery({ ...journeyInput, topEntryPages: [SHARED_PAGE] }));
    expect(
      rows.map((row) => [row.source, row.target, Number(row.value)])
    ).toEqual([[SHARED_PAGE, SESSION_NEXT_PAGE, 1]]);
  });
});

describe('screen-view duration — sessionless events', () => {
  it('page-filtered metrics average only views inside a session', async () => {
    const filters = [
      { id: 'a', name: 'path', operator: 'is' as const, value: [SHARED_PAGE] },
    ];
    const rows = await rowsOf<{
      total_screen_views: number | string;
      avg_session_duration: number;
    }>(
      OV.metricsWithPageFilterQuery({
        projectId: PROJECT_ID,
        startDate: WINDOW_START,
        endDate: WINDOW_END,
        interval: 'day',
        rawSessionFilterWhere: getRawWhereClause('sessions', filters),
        rawEventFilterWhere: getRawWhereClause('events', filters),
      })
    );
    const day = rows.find((row) => Number(row.total_screen_views) > 0);

    // The sessionless view still counts as a view; its 0 duration is left out
    // of the average like any session's last view.
    expect(Number(day?.total_screen_views)).toBe(2);
    expect(day?.avg_session_duration).toBe(SECONDS_ON_SHARED_PAGE);
  });

  it('top pages time a sessionless view like a one-view session', async () => {
    const rows = await rowsOf<{
      path: string;
      pageviews: number | string;
      avg_duration: number;
    }>(
      PG.topPagesQuery({
        projectId: PROJECT_ID,
        startDate: WINDOW_START,
        endDate: WINDOW_END,
      })
    );
    const byPath = new Map(rows.map((row) => [row.path, row]));

    expect(Number(byPath.get(SHARED_PAGE)?.pageviews)).toBe(2);
    expect(byPath.get(SHARED_PAGE)?.avg_duration).toBe(
      AVERAGE_MINUTES_ON_SHARED_PAGE
    );
    expect(byPath.get(SERVER_ONLY_PAGE)?.avg_duration).toBe(0);
  });
});
