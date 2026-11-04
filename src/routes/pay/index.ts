import { Hono } from "hono";
import type { Env } from "../../env";

// /pay/return and /pay/cancel: the three page states and their copy follow section 5.3 of the handoff.
export const payRoutes = new Hono<{ Bindings: Env }>();
