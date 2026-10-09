export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_PATTERN = /^[A-Z]{2}$/;

export type FieldError = {
  field: string;
  code: string;
};

export type ProspectPayload = {
  requestId: string;
  fullName: string;
  whatsapp: string;
  email: string;
  cpf: string;
  planId: string;
  coachId: string;
  region: string;
  addressZip: string;
  addressStreet: string;
  addressNumber: string;
  addressComplement: string;
  addressNeighborhood: string;
  addressCity: string;
  addressState: string;
  termsAccepted: boolean;
  turnstileToken: string;
};

export function clean(value: unknown, max: number): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

export function digits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function validCpf(value: string): boolean {
  if (value.length !== 11 || /^(\d)\1+$/.test(value)) return false;
  const check = (size: number) => {
    let sum = 0;
    for (let i = 0; i < size; i++) {
      sum += Number(value[i]) * (size + 1 - i);
    }
    const rest = (sum * 10) % 11;
    return (rest === 10 ? 0 : rest) === Number(value[size]);
  };
  return check(9) && check(10);
}

export function normalizeBrazilPhone(value: unknown): string {
  const rawPhone = String(value ?? "").trim();
  const explicitInternational = rawPhone.replace(/[^\d+]/g, "");
  if (
    explicitInternational.startsWith("+") &&
    !explicitInternational.startsWith("+55")
  ) {
    return "";
  }
  let phone = digits(rawPhone);
  if ((phone.length === 12 || phone.length === 13) && phone.startsWith("55")) {
    phone = phone.slice(2);
  }
  if ((phone.length === 10 || phone.length === 11) && /^[1-9]/.test(phone)) {
    return `+55${phone}`;
  }
  return "";
}

export function validateAndNormalizeProspect(
  body: Record<string, unknown>,
): { payload: ProspectPayload; fieldErrors: FieldError[] } {
  const rawEmail = String(body.email ?? "").trim();
  const rawAddressState = clean(body.address_state, 8).toUpperCase();
  const payload: ProspectPayload = {
    requestId: clean(body.request_id, 36),
    fullName: clean(body.full_name, 160),
    whatsapp: normalizeBrazilPhone(body.whatsapp),
    email: clean(rawEmail, 180).toLowerCase(),
    cpf: digits(body.cpf),
    planId: clean(body.plan_id, 36),
    coachId: clean(body.coach_id, 36),
    region: clean(body.region, 80),
    addressZip: digits(body.address_zip),
    addressStreet: clean(body.address_street, 160),
    addressNumber: clean(body.address_number, 40),
    addressComplement: clean(body.address_complement, 120),
    addressNeighborhood: clean(body.address_neighborhood, 120),
    addressCity: clean(body.address_city, 120),
    addressState: rawAddressState,
    termsAccepted: body.terms_accepted === true,
    turnstileToken: clean(body.turnstile_token, 4096),
  };

  const fieldErrors: FieldError[] = [];
  const invalid = (field: string, code: string) => {
    fieldErrors.push({ field, code });
  };

  if (!UUID_PATTERN.test(payload.requestId)) {
    invalid("request_id", "INVALID_REQUEST_ID");
  }
  if (payload.fullName.length < 3) invalid("full_name", "INVALID_NAME");
  if (!payload.whatsapp) invalid("whatsapp", "INVALID_PHONE");
  if (
    !payload.email ||
    rawEmail.length > 180 ||
    !EMAIL_PATTERN.test(payload.email)
  ) {
    invalid("email", "INVALID_EMAIL");
  }
  if (!validCpf(payload.cpf)) invalid("cpf", "INVALID_CPF");
  if (!UUID_PATTERN.test(payload.planId)) invalid("plan_id", "INVALID_PLAN");
  if (!UUID_PATTERN.test(payload.coachId)) invalid("coach_id", "INVALID_COACH");
  if (payload.addressZip.length !== 8) invalid("address_zip", "INVALID_ZIP");
  if (!payload.addressStreet) invalid("address_street", "REQUIRED");
  if (!payload.addressNumber) invalid("address_number", "REQUIRED");
  if (!payload.addressNeighborhood) invalid("address_neighborhood", "REQUIRED");
  if (!payload.addressCity) invalid("address_city", "REQUIRED");
  if (!STATE_PATTERN.test(payload.addressState)) {
    invalid("address_state", "INVALID_STATE");
  }
  if (!payload.termsAccepted) invalid("terms_accepted", "TERMS_REQUIRED");
  if (!payload.turnstileToken) {
    invalid("turnstile_token", "TURNSTILE_REQUIRED");
  }

  return { payload, fieldErrors };
}
