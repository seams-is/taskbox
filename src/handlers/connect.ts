// connect github's handlers: the controller's signed connect begin (connectbegin.ts), and the
// agent spool's connect-code, which carries the code GitHub sent the controller's browser.
import { beginArgsProblem, startControllerConnect } from "../connectbegin.ts";
import { CONNECT_CODE_HANDLER } from "../connectflow.ts";
import type { SignedHandler, UnsignedHandler } from "../core/dispatch.ts";

const begin: SignedHandler = {
  action: "connect.begin",
  subject: () => "box",
  check: beginArgsProblem,
  apply: (c, r) => startControllerConnect(c, r.statement.args, r.by.actor),
};

export const handlers: { signed: SignedHandler[]; unsigned: UnsignedHandler[] } = { signed: [begin], unsigned: [CONNECT_CODE_HANDLER] };
