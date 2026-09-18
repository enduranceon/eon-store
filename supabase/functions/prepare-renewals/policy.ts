export const DEFAULT_RENEWAL_HORIZON_DAYS = 15;
export const DEFAULT_AUTO_RENEWAL_HORIZON_DAYS = 5;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RenewalRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenewalRequestValidationError";
  }
}

function normalizeDays(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(90, Math.round(parsed)));
}

export function normalizeRenewalRequest(body: unknown): {
  horizonDays: number;
  autoHorizonDays: number;
  contractIds: string[] | null;
} {
  const input = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const horizonDays = normalizeDays(
    input.horizon_days,
    DEFAULT_RENEWAL_HORIZON_DAYS,
  );
  const autoHorizonDays = normalizeDays(
    input.auto_horizon_days,
    DEFAULT_AUTO_RENEWAL_HORIZON_DAYS,
  );

  if (input.contract_ids === undefined || input.contract_ids === null) {
    return { horizonDays, autoHorizonDays, contractIds: null };
  }
  if (!Array.isArray(input.contract_ids)) {
    throw new RenewalRequestValidationError("contract_ids deve ser uma lista");
  }

  const contractIds = [...new Set(input.contract_ids.map((value) =>
    typeof value === "string" ? value.trim() : ""
  ))];
  if (contractIds.some((value) => !UUID_PATTERN.test(value))) {
    throw new RenewalRequestValidationError("contract_ids contém um ID inválido");
  }

  return {
    horizonDays,
    autoHorizonDays,
    contractIds: contractIds.length > 0 ? contractIds : null,
  };
}
