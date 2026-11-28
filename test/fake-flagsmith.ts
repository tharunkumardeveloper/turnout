// In-memory stand-in for the Flagsmith endpoints Turnout's Ship and Revert use. It enforces the same rules
// the real API does where they matter (status transitions, no rollout change once completed).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExperimentDetail, FlagState, Results } from '../src/flagsmith/experiments.ts';

export const ENV = 'envKey123';

export type FakeState = {
  experiment: ExperimentDetail;
  flag: FlagState;
  results: Results | null;
  requests: string[];
  failNext?: string; // "METHOD path" to fail once with a 500
  refreshAnswer?: { status: number; body: unknown }; // POST …/results/refresh/; 202 when unset
  completeBody?: unknown; // the body of POST …/complete/ (Flagsmith 2.295+ requires a rollout decision)
};

export function initialState(): FakeState {
  return {
    experiment: {
      id: 7,
      name: 'shop_release: shop:1.5 vs shop:1.4',
      hypothesis: 'shop:1.5 raises order_placed',
      status: 'running',
      feature: {
        id: 3,
        name: 'shop_release',
        initial_value: 'shop:1.4',
        multivariate_options: [{ id: 11, key: 'v2', string_value: 'shop:1.5' }],
      },
      metrics: [
        { metric: 1, metric_name: 'order_placed', aggregation: 'occurrence', direction: 'up', expected_direction: 'increase' },
        { metric: 2, metric_name: 'doc_latency_ms', aggregation: 'mean', direction: 'down', expected_direction: 'not_increase' },
      ],
      experiment_rollout: {
        enabled: true,
        rollout_percentage: 100,
        feature_state_value: { type: 'string', value: 'shop:1.4' },
        multivariate_feature_state_values: [{ multivariate_feature_option: 11, percentage_allocation: 50 }],
      },
      started_at: '2026-11-17T00:00:00Z',
      ended_at: null,
    },
    flag: {
      environment_default: { enabled: true, value: { type: 'string', value: 'shop:1.4' }, variants: [{ id: 11, weight: 0 }] },
      segment_overrides: [{ segment: { id: 1 }, priority: 0, enabled: true, variants: [{ id: 11, weight: 50 }] }],
    },
    results: {
      as_of: '2026-11-17T01:00:00Z',
      last_error_at: null,
      refresh_requested_at: null,
      is_final: false,
      payload: {
        srm_p_value: null,
        metrics: [
          {
            metric_id: 1,
            variants: { control: { n: 1000, sum: 100, sum_squares: 100 }, v2: { n: 1000, sum: 130, sum_squares: 130 } },
            inference: { v2: { lift: 0.3, ci_low: -0.02, ci_high: 0.62, chance_to_win: 0.967 } },
          },
        ],
      },
    },
    requests: [],
  };
}

const TRANSITIONS: Record<string, string[]> = {
  running: ['paused', 'completed'],
  paused: ['running', 'completed'],
};

export async function startFakeFlagsmith(state: FakeState): Promise<{ apiUrl: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const path = req.url ?? '';
    const key = `${req.method} ${path}`;
    state.requests.push(key);
    const send = (status: number, data?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (state.failNext === key) {
      state.failNext = undefined;
      return send(500, { detail: 'injected failure' });
    }

    const exp = `/api/v1/environments/${ENV}/experiments/${state.experiment.id}`;
    const flagPath = `/api/__future__/environments/${ENV}/features/${state.experiment.feature.id}/`;
    const transition = (to: string) => {
      if (!TRANSITIONS[state.experiment.status]?.includes(to)) {
        return send(400, { detail: `Cannot transition from '${state.experiment.status}' to '${to}'.` });
      }
      state.experiment.status = to as ExperimentDetail['status'];
      if (to === 'completed') state.experiment.ended_at = '2026-11-17T02:00:00Z';
      return send(200, state.experiment);
    };

    if (req.method === 'GET' && path === `${exp}/`) return send(200, state.experiment);
    if (req.method === 'GET' && path === `${exp}/results/`) return send(200, { results: state.results });
    if (req.method === 'POST' && path === `${exp}/results/refresh/`) {
      return state.refreshAnswer ? send(state.refreshAnswer.status, state.refreshAnswer.body) : send(202, {});
    }
    if (req.method === 'POST' && path === `${exp}/pause/`) return transition('paused');
    if (req.method === 'POST' && path === `${exp}/complete/`) {
      state.completeBody = body;
      return transition('completed');
    }
    if (req.method === 'PATCH' && path === `${exp}/rollout/`) {
      if (state.experiment.status === 'completed') {
        return send(400, { detail: 'Cannot change the rollout of a completed experiment.' });
      }
      state.experiment.experiment_rollout = body;
      state.flag.segment_overrides[0]!.variants = body.multivariate_feature_state_values.map(
        (v: { multivariate_feature_option: number; percentage_allocation: number }) => ({ id: v.multivariate_feature_option, weight: v.percentage_allocation }),
      );
      return send(200, state.experiment);
    }
    if (req.method === 'GET' && path === flagPath) return send(200, state.flag);
    if (req.method === 'PATCH' && path === flagPath) {
      const d = body.environment_default ?? {};
      if ('enabled' in d) state.flag.environment_default.enabled = d.enabled;
      if (d.value) state.flag.environment_default.value = d.value;
      if (d.variants) state.flag.environment_default.variants = d.variants;
      return send(200, state.flag);
    }
    send(404, { detail: `fake: no route for ${key}` });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { apiUrl: `http://127.0.0.1:${port}/api/v1/`, close: () => server.close() };
}
