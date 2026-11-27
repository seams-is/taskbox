// The key rotations: one op type per box key, each with its own phases and its own point of
// no return. The owner (from the controller, signed) or an admin at the box starts each.
// - runner and source: a new App by manifest. Cancelled before switching, the new App is dropped
//   as connect's cancel drops one (connectflow.ts cancelPending), and the old App stays in use.
// - tailscale: a re-auth. Cancelled before reconnecting, the op ends; Tailscale keeps its old key
//   until a sign-in is approved.
// - approver: a lasting change waiting for confirm. Cancelled before confirm, the wait is dropped.
import type { OpDecl } from "./decl.ts";

export const ROTATE = { runner: "key-rotate-runner", source: "key-rotate-source", approver: "key-rotate-approver", tailscale: "key-rotate-tailscale" } as const;
export type Which = keyof typeof ROTATE;
export const WHICH = Object.keys(ROTATE) as Which[];
export const APP_PHASES = ["making", "installing", "proving", "switching", "retiring"];
export const TAILSCALE_PHASES = ["drafting", "authorising", "reconnecting", "checking"];
export const APPROVER_PHASES = ["waiting", "pinning"];

const endIt: OpDecl["cancel"] = async (c, op, actor) => (await import("../opcancel.ts")).endAsCancelled(c, op, actor);

const app = (which: "runner" | "source"): OpDecl => ({
  type: ROTATE[which],
  phases: APP_PHASES,
  pointOfNoReturn: "switching",
  // The switch restarts the loop on the new App, so it never runs beside an update or a stop.
  exclusive: true,
  // A restart fails it; the next rotation finds its new App pending and finishes it.
  onBoot: () => "fail",
  who: ["owner", "admin"],
  wayBack: "It is switching to the new App already: taskbox key list shows it once it ends.",
  async cancel(c, op, actor) {
    const ended = await endIt!(c, op, actor);
    if (!ended.ok) return ended;
    const { cancelPending } = await import("../connectflow.ts");
    const lines = await cancelPending(c, op.id).catch(() => [] as string[]);
    return { ...ended, said: [ended.said, "The old App stays in use.", ...lines].join(" ").slice(0, 400) };
  },
});

export const optypes: OpDecl[] = [
  app("runner"),
  app("source"),
  {
    type: ROTATE.tailscale,
    phases: TAILSCALE_PHASES,
    pointOfNoReturn: "reconnecting",
    exclusive: true,
    onBoot: () => "fail",
    who: ["owner", "admin"],
    wayBack: "The box is signing in with its new key: the Tailscale row in taskbox check says when it is back.",
    cancel: endIt,
  },
  {
    type: ROTATE.approver,
    phases: APPROVER_PHASES,
    pointOfNoReturn: "pinning",
    // A pending change doesn't outlive a restart (core/pending.ts), so neither does its op.
    onBoot: () => "fail",
    who: ["owner"],
    wayBack: "The new key is pinned already: taskbox key list shows it.",
    // The wait goes first, under pending.json's lock, so a confirm at the same moment either took it
    // (and the op is pinning, past its point of no return) or finds it gone.
    async cancel(c, op, actor) {
      const { dropApproverWait } = await import("../approverkeys.ts");
      const n = await dropApproverWait(c, op.id).catch(() => 0);
      const { readOp } = await import("../core/ops.ts");
      const now = readOp({ dir: c.state.ops, owner: c.rootUid }, op.id);
      if (!n && now.kind === "ok" && now.value.phase === "pinning") return { ok: false, code: "failed", said: "The rotation was confirmed at the box already, so it can't be cancelled. The new key is pinned." };
      const ended = await endIt!(c, op, actor);
      return ended.ok ? { ...ended, said: `${ended.said} ${n ? "The wait for confirm is dropped; the box keeps the old key." : "Nothing waited for confirm."}` } : ended;
    },
  },
];
