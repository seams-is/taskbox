// connect github's handler for the agent spool: the controller's connect-code (connectflow.ts).
import { CONNECT_CODE_HANDLER } from "../connectflow.ts";
import type { UnsignedHandler } from "../core/dispatch.ts";

export const handlers: { unsigned: UnsignedHandler[] } = { unsigned: [CONNECT_CODE_HANDLER] };
