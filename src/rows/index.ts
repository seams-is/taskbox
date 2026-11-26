// Every check row, from every package that has rows (core/rows.ts). A package with rows adds a file
// here that exports its Row[], and one line below. The list is built on first use, since the modules
// that hold rows import each other.
//
// Places, by number: away's own rows from 100, the pre-start rows from 1000, the rest of check from
// 2000, rows only `taskbox check` shows from 8000, the install's preflight from 1000 in its own place.
import { AWAY_ONLY } from "../away.ts";
import { CHECK_EXTRA, INSTALL_PREFLIGHT, PRESTART } from "../checks.ts";
import { loadRepoOf } from "../config.ts";
import { type Place, type Row, type RowFn, numbered, rowsFor, rowsProblem } from "../core/rows.ts";
import { TEST_REPO_ROW, testRepoRow } from "../loadcmd.ts";
import { SECOND_KEY_ROW, secondKeyRow } from "../queue.ts";
import { GUARD_ROWS } from "./guard.ts";
import { OP_ROWS } from "./ops.ts";
import { CLOCK_ROWS } from "./clock.ts";
import { BEAT_ROWS } from "./away.ts";
import { SIZE_ROWS } from "./sizes.ts";

function v2Rows(): Row[] {
  return [
    ...numbered(AWAY_ONLY, 100, ["away"]),
    ...numbered(PRESTART, 1000, ["prestart", "check", "away"]),
    ...numbered(CHECK_EXTRA, 2000, ["check", "away"]),
    { name: SECOND_KEY_ROW, fn: secondKeyRow as RowFn, order: 8000, in: ["check"] },
    { name: TEST_REPO_ROW, fn: testRepoRow as RowFn, order: 8010, in: ["check"], when: (c) => !!loadRepoOf(c.cfg) },
    ...numbered(INSTALL_PREFLIGHT, 1000, ["preflight"]),
  ];
}

let built: Row[] | undefined;
export function allRows(): Row[] {
  if (built) return built;
  const rows = [...v2Rows(), ...GUARD_ROWS, ...OP_ROWS, ...CLOCK_ROWS, ...BEAT_ROWS, ...SIZE_ROWS];
  const why = rowsProblem(rows);
  if (why) throw new Error(`the check rows can't be used: ${why}`);
  return (built = rows);
}

export const rows = (place: Place, c?: Parameters<NonNullable<Row["when"]>>[0]) => rowsFor(allRows(), place, c);
