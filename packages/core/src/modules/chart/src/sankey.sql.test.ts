/**
 * SQL-shape tests for the sankey statements: render, then `EXPLAIN <sql>` with
 * the bound params against the isolated `openpanel_test` ClickHouse (pinned by
 * test/preload.ts). EXPLAIN resolves columns without executing.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { SqlFragment } from '@openpanel/db/src/clickhouse/sql';
import type { SankeyEvent, SankeyMode, SankeyPathsInput } from './sankey.sql';

const PROJECT_ID = 'test-sql-validation';
const START = '2026-04-14 00:00:00';
const END = '2026-05-15 00:00:00';
const STEPS = 5;
const TOP_ENTRY_EVENTS = ['screen_view'];

/** Server-side events carry session_id '', which is not one session. */
const SESSIONLESS_EXCLUDED = "session_id != ''";

const START_EVENT: SankeyEvent = { name: 'screen_view', whereClause: null };
const END_EVENT: SankeyEvent = { name: 'sign_up', whereClause: null };

let ch: typeof import('@openpanel/db/src/clickhouse/client').ch;
let SK: typeof import('./sankey.sql');

function pathsInput(mode: SankeyMode): SankeyPathsInput {
  return {
    projectId: PROJECT_ID,
    startDate: START,
    endDate: END,
    steps: STEPS,
    mode,
    startEvent: START_EVENT,
    endEvent: mode === 'between' ? END_EVENT : undefined,
    exclude: [],
  };
}

/** How many times `SESSIONLESS_EXCLUDED` appears in the rendered statement. */
function exclusionCount(fragment: SqlFragment): number {
  return fragment.toStatement().query.split(SESSIONLESS_EXCLUDED).length - 1;
}

async function explain(fragment: SqlFragment): Promise<void> {
  const { query, query_params } = fragment.toStatement();
  await ch.command({ query: `EXPLAIN ${query}`, query_params });
}

beforeAll(async () => {
  ({ ch } = await import('@openpanel/db/src/clickhouse/client'));
  SK = await import('./sankey.sql');
  const { bootstrapTestDatabases } = await import(
    '../../../../../../test/bootstrap-databases'
  );
  await bootstrapTestDatabases();
}, 30_000);

describe('sankey.sql — sessionless events', () => {
  it('excludes them from the session paths and the start-event sessions', async () => {
    for (const mode of ['after', 'before'] as const) {
      const topEntries = SK.sankeyTopEntriesQuery(pathsInput(mode));
      const transitions = SK.sankeyTransitionsQuery(
        pathsInput(mode),
        TOP_ENTRY_EVENTS
      );
      expect(exclusionCount(topEntries)).toBe(2);
      expect(exclusionCount(transitions)).toBe(2);
      await explain(topEntries);
      await explain(transitions);
    }
  });

  it('excludes them from both anchor sessions in between mode', async () => {
    const input = pathsInput('between');
    const topEntries = SK.sankeyBetweenTopEntriesQuery(
      input,
      START_EVENT,
      END_EVENT
    );
    const transitions = SK.sankeyBetweenTransitionsQuery(
      input,
      START_EVENT,
      END_EVENT,
      TOP_ENTRY_EVENTS
    );
    expect(exclusionCount(topEntries)).toBe(3);
    expect(exclusionCount(transitions)).toBe(3);
    await explain(topEntries);
    await explain(transitions);
  });

  it('excludes them without an anchor event', async () => {
    const input = { ...pathsInput('after'), startEvent: undefined };
    const topEntries = SK.sankeyTopEntriesQuery(input);
    expect(exclusionCount(topEntries)).toBe(1);
    await explain(topEntries);
  });
});
