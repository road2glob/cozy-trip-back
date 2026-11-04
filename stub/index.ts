// Deterministic fake of the payment & verification service contract.
// Called in-process by paymentService only when TASKPASS_TRANSPORT=stub.
// Behaviour follows section 5 of the handoff; until then every path returns 501 rather than guessed fields.
import type { Env } from "../src/env";

export async function stubFetch(request: Request, _env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return Response.json({ error: { code: "unauthorized", message: "Missing product credential" } }, { status: 401 });
  }
  const { pathname } = new URL(request.url);
  return Response.json(
    { error: { code: "stub-not-implemented", message: `stub: ${request.method} ${pathname} is not implemented yet` } },
    { status: 501 },
  );
}
