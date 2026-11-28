// key rotate, signed from the controller (keyops.ts), and the two unsigned asks the rotations take
// through the agent spool: a new App's code (keyrotate.ts) and a controller's offered approver key
// (approverkeys.ts). The signed one names the box as its subject, and its actor is the key that signed.
import { OFFER_HANDLER, newKeyProblem, raiseApproverAdd, raiseApproverRotate } from "../approverkeys.ts";
import type { SignedHandler } from "../core/dispatch.ts";
import { rotateArgsProblem, startAppRotation, startTsRotation } from "../keyops.ts";
import { KEY_CODE_HANDLER } from "../keyrotate.ts";

const rotate: SignedHandler = {
  action: "key.rotate",
  subject: () => "box",
  check: (a) => rotateArgsProblem(a) ?? (Array.isArray(a.words) && a.words[0] === "approver" ? newKeyProblem(a.new) : undefined),
  async apply(c, r) {
    const a = r.statement.args;
    const which = (a.words as string[])[0];
    if (which === "approver") return raiseApproverRotate(c, a.new as string, r.by.actor);
    if (which === "tailscale") return startTsRotation(c, a.seal as string, r.by.actor);
    return startAppRotation(c, which === "runner" ? "runner" : "source", a.state as string, r.by.actor);
  },
};

const add: SignedHandler = {
  action: "key.add",
  subject: () => "box",
  check: (a) => (Object.keys(a).sort().join(",") !== "new,words" || !Array.isArray(a.words) || a.words.length !== 1 || a.words[0] !== "approver" ? "key add takes approver and --new" : newKeyProblem(a.new)),
  apply: (c, r) => raiseApproverAdd(c, r.statement.args.new as string, r.by.actor),
};

export const handlers = { signed: [rotate, add], unsigned: [KEY_CODE_HANDLER, OFFER_HANDLER] };
