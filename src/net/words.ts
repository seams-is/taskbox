// The evaluator's verdict in the words a person reads: which of taskbox's rules blocks an address,
// or what kind of address Softnet drops by itself.
import type { NetPolicy } from "../vm.ts";
import type { Verdict } from "./rules.ts";

// The tailnet's range, as loop.ts netFor blocks it by name.
const TAILNET = "100.64.0.0/10";

export function verdictWords(net: Pick<NetPolicy, "block">): (v: Verdict) => string {
  const pubs = new Set(net.block.filter((b) => b.endsWith("/32")));
  return (v) => {
    if (v.allowed) return v.by === "host" || v.rule?.includes("@host") ? "allowed (DNS at the box)" : "allowed";
    if (v.by === "fallback") return v.range ?? "not globally routable";
    if (v.rule === "@host") return "the box itself";
    if (v.rule === TAILNET) return "the tailnet's range";
    if (v.rule && pubs.has(v.rule)) return "the box's public address";
    if (v.rule === "0.0.0.0/0") return "everything, for this VM";
    return `taskbox's rule ${v.rule ?? ""}`.trim();
  };
}
