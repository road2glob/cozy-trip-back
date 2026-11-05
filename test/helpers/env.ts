import type { Env } from "../../src/env";
import type { ToolContext } from "../../src/tools/common";
import { createTestD1 } from "./d1";

export const PRODUCT_TOKEN = "test-product-token";

export function testEnv(overrides: Partial<Env> = {}) {
  const d1 = createTestD1();
  const env = {
    DB: d1.db,
    TASKPASS: undefined as unknown as Fetcher,
    TASKPASS_TRANSPORT: "stub",
    TASKPASS_PRODUCT_TOKEN: PRODUCT_TOKEN,
    PUBLIC_RETURN_ORIGIN: "http://localhost:8788",
    DEMO_TOKEN_PEPPER: "test-pepper",
    ...overrides,
  } as Env;
  return { env, raw: d1.raw };
}

export function toolCtx(env: Env, userId = "usr_test"): ToolContext {
  return { env, userId, tokenId: "tok_test", requestId: "req_test" };
}
