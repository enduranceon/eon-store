import {
  DEFAULT_AUTO_RENEWAL_HORIZON_DAYS,
  DEFAULT_RENEWAL_HORIZON_DAYS,
  isSubscriptionCheckRequest,
  normalizeRenewalRequest,
  RenewalRequestValidationError,
} from "./policy.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("renewal scan defaults manual review to 10 days and automatic renewal to 5", () => {
  const result = normalizeRenewalRequest({});

  assert(DEFAULT_RENEWAL_HORIZON_DAYS === 10, "manual window is not 10 days");
  assert(DEFAULT_AUTO_RENEWAL_HORIZON_DAYS === 5, "automatic window is not 5 days");

  assert(
    result.horizonDays === DEFAULT_RENEWAL_HORIZON_DAYS,
    "manual horizon changed",
  );
  assert(
    result.autoHorizonDays === DEFAULT_AUTO_RENEWAL_HORIZON_DAYS,
    "automatic horizon changed",
  );
  assert(result.contractIds === null, "empty IDs should use the normal scan");
});

Deno.test("automatic horizon stays independent from the manual review window", () => {
  const result = normalizeRenewalRequest({
    horizon_days: 3,
    auto_horizon_days: 10,
  });

  assert(result.horizonDays === 3, "general horizon changed");
  assert(result.autoHorizonDays === 10, "automatic horizon changed with manual window");
});

Deno.test("forced renewal IDs are deduplicated and validated", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const result = normalizeRenewalRequest({ contract_ids: [id, id] });

  assert(result.contractIds?.length === 1, "duplicate ID was retained");
  assert(result.contractIds?.[0] === id, "valid ID changed");

  let rejected = false;
  try {
    normalizeRenewalRequest({ contract_ids: ["not-a-uuid"] });
  } catch (error) {
    rejected = error instanceof RenewalRequestValidationError;
  }
  assert(rejected, "invalid ID was accepted");
});

Deno.test("only an exact subscription_check request skips the renewal scan", () => {
  assert(isSubscriptionCheckRequest({ subscription_check: true }), "the check request was not recognized");
  assert(!isSubscriptionCheckRequest({}), "an empty body became a check");
  assert(!isSubscriptionCheckRequest(null), "a missing body became a check");
  assert(!isSubscriptionCheckRequest({ horizon_days: 10 }), "a normal scan became a check");
  for (const body of [{ subscription_check: false }, { subscription_check: "true" }, { subscription_check: true, horizon_days: 10 }]) {
    let rejected = false;
    try {
      isSubscriptionCheckRequest(body);
    } catch (error) {
      rejected = error instanceof RenewalRequestValidationError;
    }
    assert(rejected, `an ambiguous request was accepted: ${JSON.stringify(body)}`);
  }
});
