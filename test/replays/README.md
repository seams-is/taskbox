# Saved days, for calibrating the simulator

Each `*.json` here is one day of a box's jobs, with `vmKind`, `className`, `jobAt`, `endedAt` and `phases` and no job names. `test/acceptance.test.ts` replays each with that day's boot times: the simulator's waits must match the box's within 3 min. A day that doesn't is a fix to the simulator first.
