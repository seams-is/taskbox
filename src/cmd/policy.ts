// taskbox policy show: the tailnet policy's entries for this box, from its accounts. It prints; the
// owner applies it in the admin console. Its result is the policy itself, with the box's install ID,
// which the controller reads with policyOfAnswer and joins into one block for every box (policyBlock).
import type { CommandSpec } from "../command.ts";

const LOGIN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const SHORT = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;

export const commands: CommandSpec[] = [
  {
    path: ["policy", "show"],
    summary: "The tailnet policy's entries for this box. --whole prints a whole policy file.",
    who: ["anyone"],
    flags: ["json"],
    options: [
      { name: "--owner", value: "LOGIN", check: (v) => LOGIN.test(v) },
      { name: "--admin", value: "NAME", check: (v) => SHORT.test(v), repeat: true },
      { name: "--whole" },
    ],
    file: (c) => c.opts.whole === true,
    did: "Printed the policy. Nothing changed.",
    async run(c) {
      const { loadConfig, tagOf } = await import("../config.ts");
      const { adminsOf, adminState } = await import("../elevate.ts");
      const { named, poolOf } = await import("../access.ts");
      const { uidOf } = await import("../accounts.ts");
      const { trustedKey } = await import("../approver.ts");
      const { readPin } = await import("../pin.ts");
      const { policyAnswer, policyEntries, policyFor, policyText } = await import("../policy.ts");
      const owner = typeof c.opts.owner === "string" ? c.opts.owner : undefined;
      const extra = Array.isArray(c.opts.admin) ? c.opts.admin : [];
      const cfg = loadConfig(c.p.app, c.p.boxSettings);
      // The box's admins, always read here: --admin only adds names. Each role is also checked on its
      // own, since the group's list misses an admin through a nested group.
      const listed = await adminsOf(c.ops.sys);
      if (listed === undefined) {
        c.say("The admin group can't be read, so no policy is printed: it could accept an admin. Nothing to do: agents fix it.");
        return 1;
      }
      const admins = new Set([...listed, ...extra]);
      // The pool account only while the box trusts a key: the settings' key, pinned at the box.
      const pool = poolOf(cfg.accounts, trustedKey(cfg.approverKey, readPin(c.p.approverPin)));
      for (const name of [...named(cfg.accounts).map((n) => n.name), ...pool]) {
        if ((await uidOf(c.ops.sys, name)) === undefined) continue;
        const a = await adminState(c.ops.sys, name);
        if (a === "admin") admins.add(name);
        if (a === "unknown") {
          c.say(`taskbox can't tell whether ${name} is an admin, so no policy is printed. Nothing to do: agents fix it.`);
          return 1;
        }
      }
      let pol;
      try {
        pol = policyFor(cfg.accounts, { ...(owner !== undefined ? { owner } : {}), admins: [...admins], tag: tagOf(cfg) }, pool);
      } catch (e) {
        c.say(`${(e as Error).message}. Nothing printed.`);
        return 1;
      }
      const print = (text: string) => {
        for (const l of text.replace(/\n$/, "").split("\n")) c.say(l);
      };
      if (c.opts.whole) print(policyText(pol));
      else {
        c.say("The tailnet policy's entries for this box. Add each one to your policy file in the admin console, in the steps in docs/tailnet-policy.md. Keep what the file already has.");
        c.say("");
        print(policyEntries(pol));
      }
      if (owner === undefined) (c.opts.whole ? c.err : c.say)("Put your Tailscale login in place of OWNER, or type taskbox policy show --owner <your login>.");
      // The controller builds one block for every paired box from each box's result.
      const { readInstallId } = await import("../answers.ts");
      const installId = readInstallId(c.own.installId);
      return { exit: 0, result: policyAnswer(pol, installId) };
    },
  },
];
