// taskbox workspace connect ID --screen on the controller: the box says which account a ready Whole
// runs as (its own workspace connect --screen), and this controller opens macOS's Screen Sharing to
// that account at the box's Tailscale address. Screen Sharing asks the account's password itself, and
// offers to keep it in this Mac's keychain; taskbox never sees it.
import { EXIT } from "../command.ts";
import { boxResult, type LoadDeps, sel } from "./load.ts";
import { chooseBoxes, configOrStop, isStop, peerOrStop, tailnetOrStop } from "./reach.ts";
import { footer } from "./screens.ts";

export const OPEN = "/usr/bin/open";
// A macOS short name, as the box gives it: box text is untrusted here.
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
// A Tailscale address: IPv4 in 100.64.0.0/10, or IPv6 in fd7a:115c:a1e0::/48.
const TS_ADDRESS = /^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|fd7a:115c:a1e0(:[0-9a-f]{0,4}){1,5})$/i;

export function screenUrl(account: string, address: string): string | undefined {
  if (!ACCOUNT.test(account) || !TS_ADDRESS.test(address)) return undefined;
  return `vnc://${account}@${address.includes(":") ? `[${address}]` : address}`;
}

export async function connectScreen(d: LoadDeps, id: string, box: string | undefined, out: (l: string) => void): Promise<number> {
  const stop = (line: string, next: string) => {
    for (const l of [line, ...footer("Nothing opened.", "Nothing changed.", next)]) out(l);
    return EXIT.failed;
  };
  const r = await boxResult(d, ["workspace", "connect", id, "--screen", ...sel(box)]);
  if (isStop(r)) return stop(r.stop, r.next);
  if (r.screen !== true || typeof r.account !== "string") return stop("The box gave no account for Screen Sharing.", "Update taskbox on the box and this controller.");
  const c = configOrStop(d);
  if (isStop(c)) return stop(c.stop, c.next);
  const chosen = chooseBoxes(c.config, box, false);
  if (isStop(chosen)) return stop(chosen.stop, chosen.next);
  const ts = await tailnetOrStop(d);
  if (isStop(ts)) return stop(ts.stop, ts.next);
  const p = peerOrStop(chosen[0]!, ts.state);
  if (isStop(p)) return stop(p.stop, p.next);
  const url = screenUrl(r.account, p.address);
  if (!url) return stop("The box's answer or its Tailscale address isn't one taskbox opens.", "Type taskbox workspace status ID.");
  const o = await d.run([OPEN, url], { limitMs: 20_000, maxBytes: 4_000 });
  if (o.code !== 0) return stop("Screen Sharing didn't open.", "Open Screen Sharing yourself, and connect to the box by its Tailscale name.");
  for (const l of [`Opened Screen Sharing to ${r.account} on ${chosen[0]!.name}. It asks that account's password, and can keep it in your keychain.`, ...footer(`${id} is ready.`, "Opened Screen Sharing.", `taskbox workspace end ${id} when you are done.`)]) out(l);
  return EXIT.ok;
}
