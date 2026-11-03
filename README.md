# Calendar VoiceOver test

This repository runs one test on GitHub's macOS runners. The test checks if Safari and VoiceOver read the GatherPress calendar block as a data table.

The test page has four copies of the same rendered month calendar:

- A: the markup and CSS as shipped, with no ARIA table roles.
- B: the same markup with ARIA table roles.
- C: a control. The table elements use their native display values. VoiceOver must read it as a table.
- D: a control. The table has `role="presentation"`. VoiceOver must not find it as a table.

After the month copies, the page has three copies (A, B and C, as above) of each of these views:

- Week: the week view, two weeks, with week numbers.
- Week grid: the week view with the time grid. The time gutter cells have `aria-hidden="true"`.
- Day: the day view.
- Day grid: the day view with the time grid.

Each table caption starts with its label, for example "Week grid A". The test finds each table, moves through some of its cells, and reads the row and column position.

The workflow uses [Guidepup](https://github.com/guidepup/guidepup) to control VoiceOver. It records each phrase that VoiceOver speaks in `results/voiceover-probe.json`, and uploads the results as a workflow artifact for each runner.

Related: GatherPress/gatherpress#2494 and GatherPress/gatherpress#2552.
