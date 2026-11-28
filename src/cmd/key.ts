// taskbox key list, key rotate, key trust approver and key reset approver (keycmd.ts). key rotate
// comes signed from the controller, or runs at the box as an admin through sudo.
import type { CommandSpec } from "../command.ts";

const WHICH = (v: string) => v === "runner" || v === "source" || v === "approver" || v === "tailscale";

export const commands: CommandSpec[] = [
  {
    path: ["key", "list"],
    summary: "Each key: fingerprint, App, age, and a rotation in progress.",
    who: ["anyone"],
    flags: ["json"],
    shell: true,
    run: async (c) => (await import("../keycmd.ts")).keyList(c),
  },
  {
    path: ["key", "rotate"],
    summary: "Rotates runner, source, approver or tailscale: the old key works until the new one is proved.",
    who: ["owner", "admin"],
    flags: ["json", "timeout", "detach", "signed"],
    args: { name: "WHICH", min: 1, max: 1, check: WHICH },
    // The controller's: the hash of the state its new App's code carries, the key that seals the
    // Tailscale link, and the new approver key's base64.
    options: [
      { name: "--state", value: "HASH", check: (v) => /^[0-9a-f]{64}$/.test(v) },
      { name: "--seal", value: "KEY", check: (v) => /^[A-Za-z0-9_-]{43}$/.test(v) },
      { name: "--new", value: "KEY", check: (v) => /^[A-Za-z0-9+/]{100,400}={0,2}$/.test(v) },
    ],
    shell: true,
    run: async (c) => (await import("../keycmd.ts")).keyRotate(c),
  },
  {
    // A second controller's key, approved from a paired controller: the box's offer, signed in.
    path: ["key", "add"],
    summary: "Approves the approver key a new controller offered this box. Each box then shows it at taskbox confirm.",
    who: ["owner"],
    flags: ["json", "signed"],
    args: { name: "WHICH", min: 1, max: 1, check: (v) => v === "approver" },
    options: [{ name: "--new", value: "KEY", check: (v) => /^[A-Za-z0-9+/]{100,400}={0,2}$/.test(v) }],
    shell: true,
    run: async (c) => (await import("../keycmd.ts")).keyAddHere(c),
  },
  {
    // A controller's box add leaves its approver key here, for key trust approver or key add.
    path: ["key", "offer"],
    summary: "Offers this controller's approver key to the box, for key trust approver at the box.",
    who: ["anyone"],
    flags: ["json"],
    args: { name: "WHICH", min: 1, max: 1, check: (v) => v === "approver" },
    options: [{ name: "--key", value: "KEY", check: (v) => /^[A-Za-z0-9+/]{100,400}={0,2}$/.test(v) }],
    shell: true,
    internal: true,
    run: async (c) => (await import("../keycmd.ts")).keyOffer(c),
  },
  {
    // The new App's code, sent by the controller for its signed key rotate runner or source.
    path: ["key", "code"],
    summary: "Gives the box the code GitHub sent the controller for a rotation's new App.",
    who: ["anyone"],
    flags: ["json"],
    args: { name: "OP", min: 1, max: 1, check: (v) => /^op_[0-9A-HJKMNP-TV-Z]{26}$/.test(v) },
    options: [
      { name: "--state", value: "STATE", check: (v) => /^[0-9a-f]{64}$/.test(v) },
      { name: "--code", value: "CODE", check: (v) => /^[A-Za-z0-9_-]{1,100}$/.test(v) },
    ],
    shell: true,
    internal: true,
    run: async (c) => (await import("../keycmd.ts")).keyCode(c),
  },
  {
    path: ["key", "trust", "approver"],
    summary: "Pins the first approver key a controller offered, after showing its fingerprint here. At the box only.",
    who: ["admin"],
    flags: ["json", "yes"],
    root: true,
    typed: true,
    run: async (c) => (await import("../keycmd.ts")).keyTrust(c),
  },
  {
    path: ["key", "trust", "release"],
    summary: "Pins the release keys in a file the owner checked, when every pinned release key is lost. At the box only.",
    who: ["admin"],
    flags: ["json", "yes"],
    args: { name: "FILE", min: 1, max: 1, check: (v) => /^\/[\x21-\x7e]{1,255}$/.test(v) && !v.includes("..") },
    root: true,
    typed: true,
    run: async (c) => (await import("../keycmd.ts")).keyTrustRelease(c),
  },
  {
    path: ["key", "reset", "approver"],
    summary: "Clears every approver key this box trusts, for a lost controller. At the box only.",
    who: ["admin"],
    flags: ["json", "yes"],
    root: true,
    typed: true,
    run: async (c) => (await import("../keycmd.ts")).keyReset(c),
  },
];
