# Chef Station

A Claude Code mod that puts a chef station tray directly above your prompt, so you can keep an eye on the kitchen without leaving the session. The repository is called `claude-chef`, but the plugin is named `chef-station` because Claude Code reserves plugin names that begin with `claude-`.

## Stations

The tray has four stations. Press the button for a station, or focus the tray with `ctrl+x tab` and press its number. You can also type `/chef <station>`, or just `/chef` to cycle to the next one. The tray remembers the station you picked across sessions.

1. **Usage** shows your plan's rate-limit windows (the five-hour session and the week) with their reset countdowns, what today has cost in API value along with the token count and the share served from cache, and a "Now" row for the current session: the project, the model, the tokens written, the session cost, how long it has been running, and how full the context window is.
2. **Trend** draws today's spend hour by hour.
3. **Breakdown** ranks today's spend by model and by project.
4. **Activity** draws a thirteen-week heat map of tokens per day, with the total, the number of active days, the busiest day and your current streak.

## Where the numbers come from

The rate-limit windows, the session cost and the context fill come straight from Claude Code (`$.session.usage()`), so they match the status line and `/cost`. Rate-limit windows only appear on a subscription and only after the first reply of a session.

Today's spend, the trend, the breakdown and the activity grid are built up by the mod itself. Each time a turn completes, in the main conversation or in a subagent, the mod records the session cost added since the previous turn, along with the tokens the turn reported, the model that answered and the project, into a ledger kept in the plugin's store. Every session with the mod installed writes to the same ledger, and the tray picks up other sessions' spending once a minute. The ledger keeps thirteen weeks of days and starts empty, so the history fills in from the day you install the mod. The cost attributed to each model is an approximation: when a subagent runs, the parent's requests made before the subagent finished are counted against the subagent's model.

Claude Code does not tell plugins which plan you are on, so the plan badge is a setting. Set it in `/config` under the `chef-station` rows, for example to `Max 5×`, or leave it empty to hide the badge.

## Install

At the prompt of a Claude Code terminal session, run:

```
/plugin install chef-station --marketplace schalkneethling/claude-chef
```

Answer `y` to add the marketplace, then pick a scope. The user scope makes the tray appear in every session.

## Develop locally

Load the mod straight from your clone for a single session:

```sh
claude --plugin-dir /path/to/claude-chef
```

Claude Code watches the folder in an interactive session, so saving a file reloads the mod. The ledger and the selected station survive a reload. Run with `claude --debug` to see why a hook was skipped or a drawing was refused.

To test the marketplace install flow against your working copy instead of GitHub, add the folder as a marketplace and install from it. Edits are then picked up with `/reload-plugins`:

```sh
claude plugin marketplace add /path/to/claude-chef
claude plugin install chef-station@chef-station
```

## Check and test

```sh
claude plugin validate .
claude plugin test .
```

`validate` reads the manifest, the marketplace file and the hooks module the way Claude Code will. `test` runs the `tests/*.test.ts` files against the engine: `format.test.ts` and `ledger.test.ts` cover the pure formatting and bookkeeping, and `register.test.ts` mounts the tray on the terminal and desktop surfaces with a stubbed session, clock and store.

Once Claude Code has loaded the mod from your folder it writes its type declarations to `.claude-plugin/types/`, and `npx tsc -p .` type-checks the mod against them.
