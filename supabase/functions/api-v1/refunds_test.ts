import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleRefundsRequest } from "./refunds.ts";

const CONTRACT_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(path: string, method: string, body?: Record<string, unknown>) {
  return new Request(`https://example.test/api-v1${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

function client() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const storageCalls: Array<{ op: string; arg: unknown }> = [];
  const fake = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({
        data: { receipt: { id: RECEIPT_ID, file_path: "assessment_contract/x/y.pdf" } },
        error: null,
      });
    },
    storage: {
      from() {
        return {
          createSignedUploadUrl(path: string) {
            storageCalls.push({ op: "upload", arg: path });
            return Promise.resolve({ data: { token: "signed-token" }, error: null });
          },
          createSignedUrl(path: string) {
            storageCalls.push({ op: "download", arg: path });
            return Promise.resolve({ data: { signedUrl: "https://x/y" }, error: null });
          },
          remove(paths: string[]) {
            storageCalls.push({ op: "remove", arg: paths });
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { fake, calls, storageCalls };
}

Deno.test("Upload URL rejects a disallowed mime type", async () => {
  const { fake, storageCalls } = client();
  const path = `/refunds/assessment_contract/${CONTRACT_ID}/receipts/upload-url`;
  const response = await handleRefundsRequest(
    request(path, "POST", { mime_type: "application/x-msdownload", size_bytes: 100 }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 400, "executable mime type was accepted");
  assert(storageCalls.length === 0, "storage was touched for an invalid type");
});

Deno.test("Upload URL rejects a file over the size limit", async () => {
  const { fake, storageCalls } = client();
  const path = `/refunds/assessment_contract/${CONTRACT_ID}/receipts/upload-url`;
  const response = await handleRefundsRequest(
    request(path, "POST", { mime_type: "application/pdf", size_bytes: 11 * 1024 * 1024 }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 400, "oversized file was accepted");
  assert(storageCalls.length === 0, "storage was touched for an oversized file");
});

Deno.test("Upload URL builds the path server-side, ignoring any client name", async () => {
  const { fake, storageCalls } = client();
  const path = `/refunds/assessment_contract/${CONTRACT_ID}/receipts/upload-url`;
  const response = await handleRefundsRequest(
    request(path, "POST", { mime_type: "application/pdf", size_bytes: 2048 }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "valid upload was refused");
  const generated = String(storageCalls[0].arg);
  assert(
    generated.startsWith(`assessment_contract/${CONTRACT_ID}/`),
    "path is not scoped to the source",
  );
  assert(generated.endsWith(".pdf"), "extension does not follow the mime type");
  assert(!generated.includes(".."), "path traversal leaked into the object key");
});

Deno.test("Registering a receipt refuses a path outside the source folder", async () => {
  const { fake, calls } = client();
  const path = `/refunds/assessment_contract/${CONTRACT_ID}/receipts`;
  const response = await handleRefundsRequest(
    request(path, "POST", {
      file_path: "assessment_contract/other/evil.pdf",
      file_name: "comprovante.pdf",
      mime_type: "application/pdf",
      size_bytes: 2048,
    }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 400, "foreign path was accepted");
  assert(calls.length === 0, "database was called for a foreign path");
});

Deno.test("Registering a valid receipt reaches the RPC with the actor", async () => {
  const { fake, calls } = client();
  const path = `/refunds/assessment_contract/${CONTRACT_ID}/receipts`;
  const response = await handleRefundsRequest(
    request(path, "POST", {
      file_path: `assessment_contract/${CONTRACT_ID}/abc.pdf`,
      file_name: "comprovante.pdf",
      mime_type: "application/pdf",
      size_bytes: 2048,
    }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "valid receipt was refused");
  assert(calls[0].name === "register_refund_receipt", "wrong RPC");
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor was not recorded");
});

Deno.test("Deleting a receipt removes the row before the stored object", async () => {
  const { fake, calls, storageCalls } = client();
  const path = `/refunds/receipts/${RECEIPT_ID}`;
  const response = await handleRefundsRequest(request(path, "DELETE"), path, fake, ACTOR_ID);
  assert(response?.status === 200, "delete failed");
  assert(calls[0].name === "delete_refund_receipt", "wrong RPC");
  assert(storageCalls[0].op === "remove", "object was not removed");
});

Deno.test("Refund list rejects an unknown status", async () => {
  const { fake } = client();
  const path = "/refunds";
  const response = await handleRefundsRequest(
    request(`${path}?status=whatever`, "GET"),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 400, "unknown status was accepted");
});

Deno.test("Unrelated paths fall through to other handlers", async () => {
  const { fake } = client();
  const path = "/returns";
  const response = await handleRefundsRequest(request(path, "GET"), path, fake, ACTOR_ID);
  assert(response === null, "refunds handler swallowed a foreign path");
});
