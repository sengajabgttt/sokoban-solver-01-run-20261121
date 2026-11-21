# Sokoban solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/sengajabgttt/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/sengajabgttt/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver: one program answers all 5 instances of a set
in a single run, writing `/output/<id>/solution.txt` for each.

## How it works

A level is a hallway with one to four rooms off it, each room holding 3 or 4
boxes on as many goals, and no box can ever leave its room (a box pushed out
of a door into the hallway is lost). So the level splits into independent
rooms, and the level's push-optimal count is the sum of its rooms' optima.

The program finds each room by cutting the player's row (the hallway) out of
the floor, solves every room push-optimally on its own, and joins the rooms'
moves with walks through the hallway.

Each room is searched over pushes, not steps: a state is the boxes' squares
plus the player's reachable region (named by its lowest square), so two states
that differ only in where the player stands inside one region are one state.
The search is A* whose estimate is the cheapest matching of boxes to goals
over walking distances, which never overestimates the pushes still needed, so
the first solved state it pops is push-optimal. It prunes two dead ends a box
can never leave: a dead square (no pull path back to a goal) and a frozen
2 x 2 block of walls and boxes with a box off its goal. When A* gives up on
a room, a plain push BFS tries, then a greedy best-first search for any
solution at all, so a hard room still earns what it can instead of nothing.

Budgets are counted in state expansions, never the wall clock, so two runs
write the same bytes. No randomness, no clock reads.

## Run

```sh
node main.ts
```

It reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt`
(overridden by `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR`). Node 22.

## Verification

On the kit's practice set the solver is push-optimal on all 5 instances
(13, 16, 29, 47, 60 pushes = the keys' optima): score 1,000,000, against
200,000 for the house baseline plain-astar. On 5 freshly drawn sets from the
kit's generator (25 further instances) it is likewise push-optimal on every
instance, 1,000,000 each, while the baseline scores 280,000–400,000. It runs
in under a second per set and writes byte-identical output on repeat runs.

## License

MIT, see LICENSE.
