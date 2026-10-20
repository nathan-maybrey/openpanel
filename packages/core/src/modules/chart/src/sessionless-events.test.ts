/**
 * Behavioural test for session-grouped chart statements, executed against the
 * isolated `openpanel_test` ClickHouse (pinned by test/preload.ts).
 *
 * Events tracked server-side (a secret-authenticated client, no browser) are
 * stored with session_id ''. Grouped by session, every such event in a
 * project used to land in one shared group, so two unrelated users' events
 * formed one session: it completed funnels neither user completed and drew
 * flows neither user took. Seeded here: one real session that converts, and
 * two sessionless users who each did one step.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type SqlFragment, sql } from '@openpanel/db/src/clickhouse/sql';
import type { IChartEvent } from '../../report/report.constants';

const PROJECT_ID = 'chart-sessionless-events-test';
const DAY = '2026-03-10';
const WINDOW_START = `${DAY} 00:00:00`;
const WINDOW_END = `${DAY} 23:59:59`;
const FUNNEL_WINDOW_HOURS = 24;
const MILLISECONDS_PER_HOUR = 3_600_000;
const SECONDS_PER_HOUR = 3600;
const SANKEY_STEPS = 5;

const FIRST_STEP = 'screen_view';
const SECOND_STEP = 'sign_up';

const seededEvent = (
  index: number,
  name: string,
  time: string,
  profileId: string,
  sessionId: string
) => ({
  id: `00000000-0000-0000-0000-0000000000${String(index).padStart(2, '0')}`,
  project_id: PROJECT_ID,
  name,
  created_at: `${DAY} ${time}`,
  profile_id: profileId,
  device_id: profileId,
  session_id: sessionId,
  path: '/',
});

const SEEDED_EVENTS = [
  seededEvent(1, FIRST_STEP, '10:00:00', 'profile-in-session', 'session-1'),
  seededEvent(2, SECOND_STEP, '10:05:00', 'profile-in-session', 'session-1'),
  seededEvent(3, FIRST_STEP, '11:00:00', 'server-profile-a', ''),
  seededEvent(4, SECOND_STEP, '11:01:00', 'server-profile-b', ''),
];

const step = (id: string, name: string): IChartEvent => ({
  id,
  name,
  segment: 'event',
  filters: [],
});

let ch: typeof import('@openpanel/db/src/clickhouse/client').ch;
let funnel: typeof import('./funnel.sql');
let conversion: typeof import('./conversion.sql');
let sankey: typeof import('./sankey.sql');

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

async function funnelLevels(group: 'session_id' | 'profile_id') {
  const base = funnel.funnelBase({
    projectId: PROJECT_ID,
    startDate: WINDOW_START,
    endDate: WINDOW_END,
    eventSeries: [step('A', FIRST_STEP), step('B', SECOND_STEP)],
    breakdowns: [],
    funnelWindowMilliseconds: FUNNEL_WINDOW_HOURS * MILLISECONDS_PER_HOUR,
    group,
    cohortMetadata: new Map(),
    timezone: 'UTC',
  });
  const rows = await rowsOf<{ level: number; count: number | string }>(
    funnel.funnelChartQuery(base)
  );
  return rows.map((row) => ({ level: row.level, count: Number(row.count) }));
}

async function conversionTotals(group: 'session_id' | 'profile_id') {
  const statement = conversion.conversionQuery({
    projectId: PROJECT_ID,
    startDate: WINDOW_START,
    endDate: WINDOW_END,
    interval: 'day',
    group,
    funnelWindowSeconds: FUNNEL_WINDOW_HOURS * SECONDS_PER_HOUR,
    firstEventMatch: sql`events.name = ${sql.string(FIRST_STEP)}`,
    secondEventMatch: sql`events.name = ${sql.string(SECOND_STEP)}`,
    eventNames: [FIRST_STEP, SECOND_STEP],
    firstEventWhere: null,
    secondEventWhere: null,
    breakdownSelects: [],
    breakdownExpressions: [],
    profileJoinFields: [],
    needsGroupArrayJoin: false,
    cohortJoins: [],
  });
  const rows = await rowsOf<{
    total_first: number | string;
    conversions: number | string;
  }>(statement);
  return rows.map((row) => ({
    totalFirst: Number(row.total_first),
    conversions: Number(row.conversions),
  }));
}

beforeAll(async () => {
  ({ ch } = await import('@openpanel/db/src/clickhouse/client'));
  funnel = await import('./funnel.sql');
  conversion = await import('./conversion.sql');
  sankey = await import('./sankey.sql');

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

describe('funnel — sessionless events', () => {
  it('per session, counts only the real session as converted', async () => {
    expect(await funnelLevels('session_id')).toEqual([{ level: 2, count: 1 }]);
  });

  it('per profile, still counts the sessionless users', async () => {
    expect(await funnelLevels('profile_id')).toEqual([
      { level: 2, count: 1 },
      { level: 1, count: 1 },
    ]);
  });
});

describe('conversion — sessionless events', () => {
  it('per session, counts only the real session', async () => {
    expect(await conversionTotals('session_id')).toEqual([
      { totalFirst: 1, conversions: 1 },
    ]);
  });

  it('per profile, still counts the sessionless users', async () => {
    expect(await conversionTotals('profile_id')).toEqual([
      { totalFirst: 2, conversions: 1 },
    ]);
  });
});

describe('sankey — sessionless events', () => {
  const input = {
    projectId: PROJECT_ID,
    startDate: WINDOW_START,
    endDate: WINDOW_END,
    steps: SANKEY_STEPS,
    mode: 'after' as const,
    startEvent: { name: FIRST_STEP, whereClause: null },
    exclude: [],
  };

  it("draws only the real session's path", async () => {
    const entries = await rowsOf<{ entry_event: string; count: string }>(
      sankey.sankeyTopEntriesQuery(input)
    );
    const transitions = await rowsOf<{
      source: string;
      target: string;
      value: string;
    }>(sankey.sankeyTransitionsQuery(input, [FIRST_STEP]));

    expect(entries.map((row) => [row.entry_event, Number(row.count)])).toEqual([
      [FIRST_STEP, 1],
    ]);
    expect(
      transitions.map((row) => [row.source, row.target, Number(row.value)])
    ).toEqual([[FIRST_STEP, SECOND_STEP, 1]]);
  });
});
