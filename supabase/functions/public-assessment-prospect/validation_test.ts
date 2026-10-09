import {
  normalizeBrazilPhone,
  validateAndNormalizeProspect,
  validCpf,
} from "./validation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "11111111-1111-4111-8111-111111111111",
    full_name: "Pessoa de Teste",
    whatsapp: "+55 (48) 99117-8688",
    email: "teste@example.com",
    cpf: "529.982.247-25",
    plan_id: "22222222-2222-4222-8222-222222222222",
    coach_id: "33333333-3333-4333-8333-333333333333",
    region: "Florianópolis",
    address_zip: "88095-122",
    address_street: "Rua de Teste",
    address_number: "123",
    address_complement: "Sala 2",
    address_neighborhood: "Centro",
    address_city: "Florianópolis",
    address_state: "sc",
    terms_accepted: true,
    turnstile_token: "test-token",
    ...overrides,
  };
}

Deno.test("normalizes a valid public prospect without losing +55 phone numbers", () => {
  const { payload, fieldErrors } = validateAndNormalizeProspect(validBody());

  assert(fieldErrors.length === 0, "valid payload was rejected");
  assert(payload.whatsapp === "+5548991178688", "phone was not normalized");
  assert(payload.cpf === "52998224725", "CPF was not normalized");
  assert(payload.addressState === "SC", "state was not normalized");
});

Deno.test("accepts local and +55 Brazilian phone formats only", () => {
  assert(
    normalizeBrazilPhone("(48) 99117-8688") === "+5548991178688",
    "local phone failed",
  );
  assert(
    normalizeBrazilPhone("+55 48 99117-8688") === "+5548991178688",
    "+55 phone failed",
  );
  assert(
    normalizeBrazilPhone("+1 212 555 0199") === "",
    "foreign phone passed",
  );
});

Deno.test("returns field-specific errors for invalid CPF and address", () => {
  const { fieldErrors } = validateAndNormalizeProspect(validBody({
    cpf: "111.111.111-11",
    address_city: "",
    address_state: "S",
  }));
  const codes = new Map(fieldErrors.map((item) => [item.field, item.code]));

  assert(codes.get("cpf") === "INVALID_CPF", "CPF error is not specific");
  assert(codes.get("address_city") === "REQUIRED", "city error is missing");
  assert(
    codes.get("address_state") === "INVALID_STATE",
    "state error is missing",
  );
});

Deno.test("rejects missing email and does not truncate an invalid state", () => {
  const { fieldErrors } = validateAndNormalizeProspect(validBody({
    email: "",
    address_state: "SC1",
  }));
  const codes = new Map(fieldErrors.map((item) => [item.field, item.code]));

  assert(codes.get("email") === "INVALID_EMAIL", "missing email was accepted");
  assert(
    codes.get("address_state") === "INVALID_STATE",
    "long state was silently truncated",
  );
});

Deno.test("rejects a syntactically long email instead of silently truncating it", () => {
  const email = `${"a".repeat(170)}@example.com`;
  const { fieldErrors } = validateAndNormalizeProspect(validBody({ email }));

  assert(
    fieldErrors.some((item) =>
      item.field === "email" && item.code === "INVALID_EMAIL"
    ),
    "long email was accepted",
  );
});

Deno.test("CPF validation checks both verifier digits", () => {
  assert(validCpf("52998224725"), "known valid CPF was rejected");
  assert(!validCpf("52998224724"), "invalid verifier digit was accepted");
  assert(!validCpf("00000000000"), "repeated CPF was accepted");
});
