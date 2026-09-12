# Model Interaction Inventory

This document records the interaction patterns found in the imported model library and the execution contract used by Rive2d.

Scan date: 2026-09-12

## Authoritative JSON Editor Semantics

Reference documentation:

`https://live2d.pavostudio.com/doc/en-us/exstudio/live2d-editor/`

The following meanings are taken from the Live2D Editor JSON Editor
documentation. These definitions take priority over field names, naming
conventions, or behavior inferred from a motion group name.

### Runtime execution order

The documented per-frame order is:

1. Restore saved parameter values and part transparency from the previous frame.
2. Play motion files in hierarchical/layer order.
3. Execute controllers.
4. Execute instruction code.
5. Save parameter values and part transparency for the next frame.
6. Execute physics.

This order matters for `ParamHit`: the held pointer value must be applied at
the controller stage, after motion evaluation and before physics. A later
motion or controller may still override a value depending on layer, priority,
weight, and lock settings.

### ParamHit

`Controllers.ParamHit.Items` describes a hit area that changes one or more
Cubism parameters while the pointer is held and moved. It is not an ordinary
click mapping and it is not, by itself, a request to play a motion file.

| Field | Meaning |
| --- | --- |
| `Name` | Editor/display name of the parameter-hit rule. |
| `Id` | Cubism parameter ID to modify. |
| `HitArea` | Hit area that starts the parameter interaction. |
| `Axis` | Pointer axis used to calculate the change. |
| `Factor` | Parameter change per pointer movement. |
| `MinValue` / `MaxValue` | Optional interaction limits. If absent, use the parameter limits from the model. |
| `Type` | `Drag` changes the parameter while the left button is held and moved; `Stroke` responds to back-and-forth movement while held; `Hold` changes the parameter based on how long the left button is held. Missing values use the editor/runtime default; do not infer a different type from the name. |
| `Weight` | Contribution/strength of the parameter-hit rule where present. |
| `LockParam` | Whether the parameter remains at its dragged value after release. This controls persistence, not the release curve. |
| `Release` | Duration used when the parameter is released and configured to return. |
| `ReleaseType` | Release/interpolation curve selection. It does not mean “restore” versus “keep”. |
| `BeginMtn` | Motion/action associated with beginning the parameter interaction, when present. |
| `MaxMtn` / `MinMtn` | Motion/action route associated with reaching the configured maximum/minimum. The route may be an `Option` that changes state with `VarFloats` before starting an `Action`. |
| `EndMtn` | Motion/action associated with releasing the interaction without reaching the parameter's maximum value. |

The release decision must therefore be interpreted in this order:

```text
pointerdown
  -> identify every enabled ParamHit rule for the hit area
  -> capture each parameter's starting value
pointermove
  -> update the parameter continuously using Axis and Factor
  -> apply MinValue/MaxValue or the model parameter limits
  -> evaluate Type-specific interaction behavior
  -> evaluate boundary crossings for MinMtn/MaxMtn
pointerup / pointerupoutside
  -> execute EndMtn when the documented release condition is met
  -> execute a boundary motion when the configured limit is reached
  -> keep the current value when LockParam is enabled
  -> otherwise return toward the captured value using Release and ReleaseType
```

`ReleaseType` must never be used as a replacement for `LockParam`. In
particular, `ReleaseType: 0` does not imply that a parameter should always
return to its pointerdown value.

### Distinguishing parameter limits from screen limits

`MinValue` and `MaxValue` limit a Cubism parameter. They are not screen
coordinates and do not constrain the model's position on the desktop. A
parameter can deform the model while the pointer is held, but its clamped
value cannot directly move the model window outside the screen.

The model position is a separate runtime concern. `currentModel.x` and
`currentModel.y` need an explicit viewport-boundary policy if the entire model
must remain visible.

### Local model coverage

The full local model directory scan on 2026-09-12 found:

- 114 model JSON files.
- 63 models containing `ParamHit`.
- 251 `ParamHit` items.
- 24 items with explicit `Type`.
- 20 items with `Weight`.
- 16 items with explicit `MinValue` or `MaxValue`.
- 117 items with `LockParam: true`.
- 34 items with `MaxMtn`, 2 with `MinMtn`, 5 with `BeginMtn`, and 57 with `EndMtn`.

The current Agir model contains four `TouchDrag` parameter rules. They have
`Factor` values of `0.04`, `ReleaseType: 0`, and `LockParam: true`, but no
explicit `MinValue` or `MaxValue`. Their limits must therefore come from the
Cubism parameter definitions in the MOC3, which matches the observed runtime
range `[0, 8]` for `touch_drag1`.

The current model's `TouchDrag1` through `TouchDrag4` do not define `Type`,
`Weight`, `BeginMtn`, `EndMtn`, `MinMtn`, or `MaxMtn`. They are therefore pure
parameter interactions in the JSON configuration; their visible animation is
the model deformation produced by the changing parameter and any controllers
or physics that respond to it.

`Factor` is applied directly to screen-space pointer movement. Runtime model
scale must not multiply it again, otherwise shrinking a model also makes the
drag distance required to reach `MinValue`/`MaxValue` unnecessarily larger.

## Scope

The scan covered the 66 model paths registered in the local Rive2d database.

- 54 models use the Cubism 3 style with `Version` and `FileReferences`.
- 12 models use older or variant metadata with lower-case fields such as `motions`, `hit_areas`, and `controllers`.
- 1,063 motion groups and 3,722 motion entries were found.
- 1,301 raw hit-area records were found; 1,300 have a name.
- 118 `ParamHit` rules, 12 `ParamLoop` rules, 1 `ParamTrigger` rule, and 25 `KeyTrigger` rules were found.

The parser must normalize field names before interpreting behavior. Do not assume that a model is Cubism 3 just because it has a `.model.json` extension.

## Motion Entry Types

### File motion

An entry with `File` or legacy `file` loads and plays a motion file.

```json
{
  "File": "tap_body.motion3.json"
}
```

The motion file is not authoritative for looping. Many imported Cubism 3 motion files declare `Meta.Loop=true`, including one-shot motions. The per-entry model metadata is authoritative:

- `FileLoop: true` means loop.
- `WrapMode: 1` means loop.
- Legacy `loop: true` or `file_loop: true` means loop.
- `Idle` and `Idle#N` groups loop by category when no entry-level flag is present.
- Otherwise the motion must be treated as one-shot.

The scan found 2,562 readable Cubism 3 motion JSON files, all with `Meta.Loop=true`. This is the reason a raw motion-file loop flag must not be used by itself. The resolved loop policy must be passed explicitly to the motion engine because it otherwise falls back to that file-level flag.

### Command-only entry

An entry without `File` but with `Command`, `VarFloats`, text, or choices is a command/menu action.

```json
{
  "Command": "parameters set touch_drag2 0"
}
```

Execution:

1. Apply `VarFloats` actions.
2. Execute `Command`.
3. Apply text/intimacy effects.
4. Apply `PostCommand` immediately because there is no motion-finish event.
5. Follow `NextMtn` immediately if present.
6. Do not submit a motion to the Live2D motion manager.

Command arguments may reference a `VarFloats` variable with `$name`; the
runtime resolves that value before applying parameter locks or assignments.

The library contains 952 command-only entries.

### Chained entry

`NextMtn` or legacy `next_mtn` is executed after a file motion finishes. `PostCommand` or legacy `post_command` is executed at finish before `NextMtn`; for command-only entries it is executed immediately.

The scan found:

- 94 entries with `NextMtn`.
- 437 entries with `PostCommand`.

### Conditional entry

`VarFloats`, `Intimacy`, and `PreMtn`/`pre_mtn` determine whether an entry is eligible. An ineligible entry must not be played or have its side effects applied.

The scan found 2,151 entries with variable rules and 149 entries with intimacy rules.

The imported library uses these `VarFloats` condition operators:

| Operator | Meaning |
| --- | --- |
| `equal` | value equals target |
| `not_equal` | value differs from target |
| `greater` / `upper` | value is greater than target |
| `less` / `lower` | value is less than target |
| `greater_equal` / `upper_equal` | value is at least target |
| `less_equal` / `lower_equal` | value is at most target |

These conditions are state gates, not errors. For example, a model may let a
`TouchIdle1` action assign `idle = 1`, then intentionally reject `Tap` entries
whose condition is `idle equal 0` until the state changes back.

State-switching drag routes must preserve the complete reference chain. For
example, `TouchIdle1.MaxMtn: "Option:touch_idle1"` applies
`status = 1`, then starts `Action:touch_idle1`; after that action finishes,
the eligible `Idle` entry is `Idle:1`. `TouchIdle.MaxMtn` performs the
corresponding transition back to `status = 0` and `Idle:0`.

## Click and Pointer Event Categories

### 1. Explicit ordinary tap

Source:

```json
{
  "Name": "摸头",
  "Motion": "Tap摸头"
}
```

There are 821 named hit-area records classified as ordinary explicit tap routes.

Execution:

```text
pointertap
  -> tap_motion enabled
  -> right-click policy, if button is 2
  -> hit-test and hit-area ordering
  -> resolve HitArea.Motion
  -> playMotion()
```

The motion gateway then handles conditions, commands, text, intimacy, looping, and chaining.

### 2. Legacy convention tap

Some older models have hit areas without an explicit `Motion`. Their motion groups follow naming conventions such as:

```text
tap_HEAD
tap_BODY
Tap摸头
```

There are 92 named hit-area records that can be resolved this way. Resolution is limited to known motion groups; arbitrary guessed motion calls must not be sent directly to the engine.

### 3. Drag-area action/state route

Example:

```json
{
  "Name": "TouchDrag1",
  "Motion": "touchidle:1"
}
```

There are 256 named drag-area records with an explicit action route and no matching `ParamHit` rule.

Execution:

```text
pointerdown inside the area
  -> play HitArea.Motion once
  -> keep the stage input region active
  -> pointertap does not replay the same action
  -> pointerup or pointerupoutside completes the interaction
```

`HitArea.Motion` is an action/state route. It is not an instruction to scrub a motion according to mouse distance.

### 4. ParamHit parameter drag

Example:

```json
{
  "HitArea": "TouchDrag2",
  "Id": "touch_drag2",
  "Axis": 1,
  "Factor": 0.01,
  "ReleaseType": 2,
  "EndMtn": "drag2"
}
```

`ParamHit` is the only metadata category that defines parameter dragging. It may coexist with a drag-named hit area. Multiple rules on one hit area must be updated together.

Execution:

```text
pointerdown
  -> collect every enabled ParamHit rule for the hit area
  -> save each parameter's starting value
pointermove
  -> convert the pointer axis using Factor
  -> clamp each value to ParamHit MinValue/MaxValue when present
  -> trigger each distinct BeginMtn once on the first movement
pointerup / pointerupoutside
  -> execute the configured release action
  -> honor LockParam before deciding whether to restore
  -> use Release and ReleaseType only for the restore interpolation
```

Release behavior:

| Field | Behavior |
| --- | --- |
| `LockParam: true` | Keep the current parameter value after release |
| `LockParam: false` or absent | The parameter may return to its captured value according to the model's release configuration |
| `Release` | Return duration |
| `ReleaseType` | Return/interpolation curve |

The scan found `ReleaseType` values `0` (200), `1` (4), `2` (17), `3` (25),
and 5 items without the field. These numeric values must be preserved as
curve selections; they must not be converted into keep/restore behavior.

`EndMtn`, `MaxMtn`, and `MinMtn` are explicit model instructions and may set
or lock parameters. They must be executed according to the model's configured
event rather than replaced with a generic release heuristic.

The documented `ParamHit` event meanings are:

- `BeginMtn`: left-button press in the hit area.
- `MinMtn`: parameter reaches its configured minimum.
- `MaxMtn`: parameter reaches its configured maximum.
- `EndMtn`: left-button release before reaching the parameter maximum; the
  release may be reported outside the original hit area.

For a drag-capable hit area, the pointer distance threshold is not used to
decide whether the interaction is a drag. Parameter updates and `BeginMtn`
start during the held gesture. `MinValue`/`MaxValue` (or the core parameter
limits when absent) decide when a boundary action becomes eligible. A
drag-capable hit area must not fall through to ordinary
`pointertap`, even when released close to its starting point.

### 5. Unmapped hit area

If a hit area has no explicit mapping, no recognized convention, and no `ParamHit` rule, it must not trigger a guessed motion. The model can still be used for normal window dragging when the hit area does not claim an interaction.

## Non-click Triggers

These are motion triggers but are not pointer clicks:

- `Start`: play once when the model loads.
- `Idle` / `idle`: background motion; normally explicitly looped.
- `Idle#N`: optional layered idle motion when ExtraMotion is enabled.
- `LeaveNN_NN_NN`: idle timer trigger.
- `KeyTrigger`: keyboard input to motion reference.
- `ParamTrigger`: parameter threshold crossing to motion reference.
- `ParamLoop`: automatic parameter oscillation.
- `Choices`: menu entries that continue through `NextMtn`.

The current automatic `Choices` display path is not enabled in `playMotion()`. Choice metadata is parsed, but a model entry will not display a choice menu unless the UI path is explicitly invoked.

## Pointer Priority

For a pointer down inside a model, use this order:

1. Enabled `ParamHit` rules for the hit area.
2. Explicit drag-area action/state route for non-`ParamHit` drag areas.
3. Normal model/window dragging.

For a pointer tap, use this order:

1. Reject disabled right-click motion when the global option is off.
2. Ignore taps consumed by a drag or `ParamHit` interaction.
3. Use explicit `HitArea.Motion`.
4. Use a recognized legacy naming convention.
5. Do nothing when no route exists.

The pointer capture region must remain active until release so dragging outside the original hit area still reaches `pointerupoutside` and applies the model's release rules.

Only names identified as drag areas, or areas referenced by `ParamHit`, may use
the pointer-down drag route. A normal mapped area such as `TouchBody`,
`TouchHead`, `TouchSpecial`, or `TouchIdle1` must not execute its `Motion` on
pointerdown; it executes once from `pointertap` instead.

## Implementation Rules

- Keep model metadata normalization separate from interaction execution.
- Resolve motion references by group and entry name/index before calling the engine.
- Route command-only entries through the same motion gateway as file entries.
- Never infer animation scrubbing from a group name containing `drag`.
- Never force all motion files to loop because their embedded metadata says `Loop=true`.
- Never update only the first `ParamHit` rule when multiple rules share a hit area.
- Preserve `Type`, `Weight`, `LowPriority`, `LockParam`, `EndMtn`, `NextMtn`,
  `PostCommand`, `ReleaseType`, and condition checks from the model.
- Treat missing or invalid routes as no-op plus a diagnostic log, not as a fallback direct engine call.

## Known Runtime Gaps

The runtime now applies `LowPriority` to ParamHit action motions and clamps
ordinary model dragging to the viewport. `MinValue`/`MaxValue` remain model
parameter limits, not screen coordinates.
