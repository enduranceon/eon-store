import type { MatchRpcClient } from "./http.ts";

export const COACH_ID = "11111111-1111-4111-8111-111111111111";
export const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
export const RECORD_ID = "33333333-3333-4333-8333-333333333333";
export const TOKEN = "a".repeat(43);
export const ANSWERS = {
  version: 1,
  focus_goals: ["start", "routine"],
  focus_levels: ["beginner"],
  service_formats: ["florianopolis", "online"],
  communication_style: "close",
  approach: "Planejamento individual com comunicação próxima e ajustes frequentes.",
  experience: "Atendimento de iniciantes em corrida.",
};

export function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

export function equal(actual: unknown, expected: unknown): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

export function rpcMock(data: unknown = {}, error: { code?: string; message?: string } | null = null) {
  const calls: { name: string; args?: Record<string, unknown> }[] = [];
  let factories = 0;
  const client: MatchRpcClient = {
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve({ data, error });
    },
  };
  return { calls, factories: () => factories, createServiceClient() { factories += 1; return client; } };
}

export function post(body: unknown, url = "https://example.test/functions/v1/coach-match-form") {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
