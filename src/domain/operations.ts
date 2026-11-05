import type { ToolContext, ToolResult } from "../tools/common";
import { fail, failFromService } from "../tools/common";
import { newId } from "./ids";
export async function operation(
  ctx: ToolContext,
  key: string,
  work: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const db = ctx.env.DB,
    owner = newId("lock");
  await db
    .prepare("INSERT OR IGNORE INTO operation_locks(operation_key) VALUES (?1)")
    .bind(key)
    .run();
  const acquired = await db
    .prepare(
      "UPDATE operation_locks SET owner=?1,expires_at=?2 WHERE operation_key=?3 AND expires_at<?4",
    )
    .bind(owner, Date.now() + 120000, key, Date.now())
    .run();
  if (!acquired.meta.changes)
    return fail(
      "operation_in_progress",
      "This operation is already running. Retry shortly.",
    );
  try {
    return await work();
  } catch (e) {
    return failFromService(e, "Payment service operation");
  } finally {
    await db
      .prepare(
        "UPDATE operation_locks SET owner=NULL,expires_at=0 WHERE operation_key=?1 AND owner=?2",
      )
      .bind(key, owner)
      .run();
  }
}
export async function localCode(
  ctx: ToolContext,
  purpose: string,
  tripId: string,
  target: string,
  expires = Math.floor(Date.now() / 60000) * 60000 + 1800000,
) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(ctx.env.DEMO_TOKEN_PEPPER),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(
        JSON.stringify([purpose, ctx.userId, tripId, target, expires]),
      ),
    ),
  );
  return (
    expires +
    "." +
    [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("")
  );
}
export async function validCode(
  ctx: ToolContext,
  code: string | undefined,
  purpose: string,
  tripId: string,
  target: string,
) {
  if (!code) return false;
  const [date] = code.split(".");
  const expires = Number(date);
  if (
    !Number.isSafeInteger(expires) ||
    expires <= Date.now() ||
    expires > Date.now() + 1860000
  )
    return false;
  const expected = await localCode(ctx, purpose, tripId, target, expires);
  if (code.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < code.length; i++)
    diff |= code.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
