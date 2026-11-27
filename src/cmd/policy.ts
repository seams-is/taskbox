// taskbox policy show: the tailnet policy's entries for this box, from its accounts. It prints; the
// owner applies it in the admin console. Its result is the policy itself, with the box's install ID,
// which the controller reads with policyOfAnswer and joins into one block for every box (policyBlock).
import { TAILNET_LOGIN as LOGIN } from "../access.ts";
import type { CommandSpec } from "../command.ts";

const SHORT = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;

export const commands: CommandSpec[] = [
  {
    path: ["policy", "show"],
    summary: "The tailnet policy's entries for this box. --whole prints a whole policy file.",
    who: ["anyone"],
    flags: ["json"],
    options: [
      { name: "--login", value: "LOGIN", check: (v) => LOGIN.test(v) },
      { name: "--admin", value: "NAME", check: (v) => SHORT.test(v), repeat: true },
      { name: "--whole" },
    ],
    file: (c) => c.opts.whole === true,
    // The controller reads --json, and its answer must name the real owner, never a placeholder.
    check: ({ opts, flags }) => (flags.json !== undefined && typeof opts.login !== "string" ? "policy show --json needs --login with your Tailscale login, which the controller passes." : undefined),
    did: "Printed the policy. Nothing changed.",
    async run(c) {
      const { loadConfig, tagOf } = await import("../config.ts");
      const { adminsOf, adminState } = await import("../elevate.ts");
      const { named, poolOf } = await import("../access.ts");
      const { ownAccess, readRecord, uidOf } = await import("../accounts.ts");
      const { trustedKey } = await import("../approver.ts");
      const { readPin, readPoolRecord } = await import("../pin.ts");
      const { policyAnswer, policyEntries, policyFor, policyText } = await import("../policy.ts");
      const owner = typeof c.opts.login === "string" ? c.opts.login : undefined;
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
      const named0 = poolOf(cfg.accounts, trustedKey(cfg.approverKey, readPin(c.p.approverPin)));
      // Only the accounts taskbox made get SSH accept: a settings name alone gives nothing.
      const own = await ownAccess(c.ops.sys, cfg.accounts.agent, named0, readRecord(c.p.accountsRecord), readPoolRecord(c.p.poolRecord));
      if ("refuse" in own) {
        c.say(`${own.refuse}. Nothing printed. As your admin user, type taskbox update, and check what it says about that account.`);
        return 1;
      }
      const pool = own.pool;
      const accounts = { ...cfg.accounts };
      if (own.agent === undefined) delete accounts.agent;
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
        const { openWindow } = await import("../settings/adminssh.ts");
        const temp = openWindow(cfg.adminSsh, c.ops.sys.now());
        pol = policyFor(accounts, { ...(owner !== undefined ? { owner } : {}), admins: [...admins], tag: tagOf(cfg), ...(temp ? { adminSsh: temp } : {}) }, pool);
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
      if (own.notYet.length) (c.opts.whole ? c.err : c.say)(`${own.notYet.join(" and ")} ${own.notYet.length === 1 ? "isn't" : "aren't"} made yet, so the policy leaves ${own.notYet.length === 1 ? "it" : "them"} out. Type this again after taskbox update.`);
      if (owner === undefined) (c.opts.whole ? c.err : c.say)("Put your Tailscale login in place of YOUR_LOGIN, or type taskbox policy show --login <your login>.");
      // The controller builds one block for every paired box from each box's result.
      const { readInstallId } = await import("../answers.ts");
      const installId = readInstallId(c.own.installId);
      if (!c.flags.json) return 0;
      try {
        return { exit: 0, result: policyAnswer(pol, installId) };
      } catch (e) {
        c.say(`${(e as Error).message}. Nothing printed.`);
        return 1;
      }
    },
  },
];
