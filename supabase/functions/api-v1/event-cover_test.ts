import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleEventCoverRequest, isEventCoverPath } from "./event-cover.ts";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_EVENT = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333.jpg";
const OLD_FILE = "44444444-4444-4444-8444-444444444444.png";

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

function client(
  { eventExists = true, listed = [FILE], previous = null as string | null } = {},
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const storageCalls: Array<{ op: string; arg: unknown }> = [];
  const fake = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          return Promise.resolve({ data: eventExists ? { id: EVENT_ID } : null, error: null });
        },
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({
        data: { cover_image_path: args.p_path, previous_path: previous },
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
          list(folder: string, options: { search: string }) {
            storageCalls.push({ op: "list", arg: { folder, search: options.search } });
            return Promise.resolve({
              data: listed.map((name) => ({ name })),
              error: null,
            });
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

Deno.test("Cover paths stay inside the event folder", () => {
  assert(isEventCoverPath(EVENT_ID, `${EVENT_ID}/${FILE}`), "a valid path was refused");
  assert(!isEventCoverPath(EVENT_ID, `${OTHER_EVENT}/${FILE}`), "another event's folder was accepted");
  assert(!isEventCoverPath(EVENT_ID, `${EVENT_ID}/../${FILE}`), "path traversal was accepted");
  assert(!isEventCoverPath(EVENT_ID, `${EVENT_ID}/capa.gif`), "a free file name was accepted");
});

Deno.test("Upload URL refuses a non-image or a file over 5 MB", async () => {
  const path = `/events/${EVENT_ID}/cover/upload-url`;
  for (const body of [
    { mime_type: "application/pdf", size_bytes: 100 },
    { mime_type: "image/jpeg", size_bytes: 6 * 1024 * 1024 },
  ]) {
    const { fake, storageCalls } = client();
    const response = await handleEventCoverRequest(request(path, "POST", body), path, fake);
    assert(response?.status === 400, `invalid upload was accepted: ${JSON.stringify(body)}`);
    assert(storageCalls.length === 0, "storage was touched for an invalid upload");
  }
});

Deno.test("Upload URL builds the path in the event folder from the mime type", async () => {
  const { fake, storageCalls } = client();
  const path = `/events/${EVENT_ID}/cover/upload-url`;
  const response = await handleEventCoverRequest(
    request(path, "POST", { mime_type: "image/webp", size_bytes: 400_000 }),
    path,
    fake,
  );
  assert(response?.status === 200, "valid upload was refused");
  const generated = String(storageCalls[0].arg);
  assert(isEventCoverPath(EVENT_ID, generated), `unexpected object key ${generated}`);
  assert(generated.endsWith(".webp"), "extension does not follow the mime type");
});

Deno.test("Upload URL needs an existing event", async () => {
  const { fake, storageCalls } = client({ eventExists: false });
  const path = `/events/${EVENT_ID}/cover/upload-url`;
  const response = await handleEventCoverRequest(
    request(path, "POST", { mime_type: "image/jpeg", size_bytes: 1000 }),
    path,
    fake,
  );
  assert(response?.status === 404, "missing event was accepted");
  assert(storageCalls.length === 0, "storage was touched for a missing event");
});

Deno.test("Saving refuses a file that never reached the bucket", async () => {
  const { fake, calls } = client({ listed: [] });
  const path = `/events/${EVENT_ID}/cover`;
  const response = await handleEventCoverRequest(
    request(path, "PUT", { path: `${EVENT_ID}/${FILE}` }),
    path,
    fake,
  );
  assert(response?.status === 400, "missing file was saved");
  assert(calls.length === 0, "database was called for a missing file");
});

Deno.test("Saving refuses a path from another event", async () => {
  const { fake, calls, storageCalls } = client();
  const path = `/events/${EVENT_ID}/cover`;
  const response = await handleEventCoverRequest(
    request(path, "PUT", { path: `${OTHER_EVENT}/${FILE}` }),
    path,
    fake,
  );
  assert(response?.status === 400, "foreign path was saved");
  assert(calls.length === 0 && storageCalls.length === 0, "a foreign path reached storage or database");
});

Deno.test("A new cover is saved and the old file is removed", async () => {
  const { fake, calls, storageCalls } = client({ previous: `${EVENT_ID}/${OLD_FILE}` });
  const path = `/events/${EVENT_ID}/cover`;
  const response = await handleEventCoverRequest(
    request(path, "PUT", { path: `${EVENT_ID}/${FILE}` }),
    path,
    fake,
  );
  assert(response?.status === 200, "valid cover was refused");
  assert(calls[0]?.name === "set_event_cover_image", "cover RPC was not called");
  assert(calls[0].args.p_path === `${EVENT_ID}/${FILE}`, "wrong path saved");
  const removed = storageCalls.find((call) => call.op === "remove");
  assert(
    JSON.stringify(removed?.arg) === JSON.stringify([`${EVENT_ID}/${OLD_FILE}`]),
    "old cover was not removed",
  );
});

Deno.test("Removing the cover clears it and deletes the file", async () => {
  const { fake, calls, storageCalls } = client({ previous: `${EVENT_ID}/${OLD_FILE}` });
  const path = `/events/${EVENT_ID}/cover`;
  const response = await handleEventCoverRequest(request(path, "PUT", { path: null }), path, fake);
  assert(response?.status === 200, "removal was refused");
  assert(calls[0].args.p_path === null, "cover was not cleared");
  assert(!storageCalls.some((call) => call.op === "list"), "removal looked up a file");
  assert(storageCalls.some((call) => call.op === "remove"), "old file was kept");
});
