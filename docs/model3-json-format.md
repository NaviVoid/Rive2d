# Live2DViewerEX JSON Parsing Reference

This document describes the Live2DViewerEX JSON data that Rive2d needs to
parse for model loading and interaction. The behavioral definitions in this
document follow the official Live2DViewerEX JSON Editor documentation:

- Local reference: `docs/reference/live2d-editor/live2d-editor.html`
- Online reference: <https://live2d.pavostudio.com/doc/en-us/exstudio/live2d-editor/>

The editor documentation defines the meaning of an item. It does not promise
one stable serialization spelling for every model version. Rive2d therefore
normalizes the known spelling variants first, then evaluates the normalized
data using the rules below. A field observed in an imported model but not
defined by the official documentation must be treated as a compatibility
extension, not as a new official semantic.

## Parsing Principles

1. Preserve the original group, item, motion, and variable names.
2. Normalize case and legacy aliases only at the adapter boundary.
3. Resolve motion references only after all motion groups and names are indexed.
4. Do not infer behavior from names such as `drag`, `special`, or
   `mission_complete`.
5. Missing optional fields retain the viewer/runtime default; they do not
   acquire meaning from a nearby field.
6. Keep unknown fields available for diagnostics and future compatibility.

## Model Configuration

Most imported models use a Cubism 3-style configuration with a shape similar
to this:

```jsonc
{
  "Version": 3,
  "FileReferences": {
    "Moc": "model.moc3",
    "Textures": ["texture_00.png"],
    "Motions": {
      "Idle": [{ "File": "idle.motion3.json", "FileLoop": true }]
    },
    "Physics": "physics.json",
    "Expressions": [{ "Name": "smile", "File": "smile.exp3.json" }],
    "Pose": "pose.json"
  },
  "HitAreas": [],
  "Controllers": {},
  "Options": {},
  "Groups": []
}
```

`FileReferences`, `HitAreas`, `Controllers`, and `Options` are the important
sections for Rive2d interaction. `Moc`, texture order, and referenced files
are still required for rendering.

### Legacy aliases

Older or variant configurations may put equivalent values at the top level or
use lower-case names. The parser may normalize these aliases:

| Legacy spelling | Normalized section |
| --- | --- |
| `HitParams` | `Controllers.ParamHit.Items` |
| `LoopParams` | `Controllers.ParamLoop.Items` |
| `LipSync` | `Controllers.LipSync.Enabled` or the corresponding controller object |
| `EyeBlink` | `Controllers.EyeBlink.Enabled` or the corresponding controller object |
| `ExtraMotion` | `Controllers.ExtraMotion.Enabled` or the corresponding controller object |
| `ScaleFactor`, `TexFixed`, `AnisoLevel` | `Options` |
| `motions`, `hit_areas`, `controllers` | `Motions`, `HitAreas`, `Controllers` |

These are parser compatibility mappings. They do not change the official
meaning of the normalized item.

## Frame Execution Order

The official execution order is:

1. Restore saved parameter values and part transparency from the previous
   frame.
2. Play motion files in hierarchical/layer order.
3. Execute controllers.
4. Execute instruction code.
5. Save parameter values and part transparency for the next frame.
6. Execute physics.

The order is significant. A drag controller is evaluated after motions and
before physics. A later layer, controller, instruction, or physics step may
therefore affect the value produced by an earlier step.

## Hit Areas

Hit areas are model trigger areas that can activate motion events through mouse
interaction. The official editor properties are:

| Property | Meaning |
| --- | --- |
| `Name` | Area name. |
| `ID` / `Id` | Cubism ArtMesh ID associated with the area. |
| `Sorting` / `Order` | Overlap order. The higher order receives the event. |
| `Clickable When Invisible` | Allows a fully transparent ArtMesh to receive clicks. |
| `Click Action` | Action executed when the area is clicked. |
| `Press Action` | Action executed when the pointer is pressed in the area. |
| `Release Action` | Action executed when the pointer is released, including outside the area. |
| `Enter Action` | Action executed when the pointer enters the area. |
| `Exit Action` | Action executed when the pointer leaves the area. |
| `Enabled` | Whether the area can receive events. |

Many model files serialize the click action as `Motion`, while other files or
versions use action-specific fields. Rive2d must normalize those fields into
separate click, press, release, enter, and exit routes instead of treating a
single `Motion` value as every event type.

An ArtMesh normally needs visible content to receive an event. The
`Clickable When Invisible` option is the explicit exception. An absent or
disabled route is a no-op; it must not cause a motion to be guessed from the
area name.

### Motion references

The reference syntax is:

- `Group`: choose an eligible motion from the group, normally using the
  configured weights and conditions.
- `Group:MotionName`: choose the named motion in the group.

This syntax is used by hit-area actions, `NextMtn`, `PreMtn`, `Choices`, and
the `start_mtn` command. Names are case-sensitive after normalization unless a
specific legacy adapter says otherwise.

## Motion Groups and Motion Entries

`FileReferences.Motions` is a dictionary from group name to an array of motion
events. A motion event may contain a motion file, commands, conditions, text,
choices, or a combination of these.

### Groups and layers

The predefined groups include `Idle`, `Start`, `Tap`, area-specific tap groups,
`Shake`, `Tick`, `TickX`, and `LeaveX_Y_Z`. SDK 3 uses capitalized names; older
SDK 2 configurations may use lower-case variants.

Custom groups can use `Group#Layer` to select a motion layer. Layer 0 is named
`Group`, not `Group#0`. `Idle#1` and other layered idle groups can run together
with lower layers. Predefined groups other than `Idle` do not gain layering
just by adding `#N`; use `start_mtn` inside a motion when a layered start is
required.

### Motion execution and completion

By default, the program loops the `Idle` motion and hierarchical motions run
synchronously. When a motion reaches the end:

- `NextMtn` is the explicit next motion.
- `PostCommand` runs after the motion finishes and before the next motion is
  resolved.
- A looping motion cannot trigger end-of-motion events such as `PostCommand`
  or `NextMtn`.
- If the layer has an `Idle` motion and no explicit next motion interrupts it,
  the layer returns to that idle motion.
- If the layer has no `Idle` motion, it stops at the last frame.

Rive2d must not infer a reset, completion state, menu action, or idle target
from a motion name. A model returns to its initial idle only when the JSON
explicitly selects that idle, or when the documented layer-idle fallback
applies to the layer containing the motion.

### Motion event properties

| Property | Official meaning |
| --- | --- |
| `Name` | Name used to identify this event in a full motion reference. Without it, only the group can identify the event. |
| `Language` | Event is eligible only when the application language matches. |
| `File` | `motion3.json` file to play. It may be absent for command/menu entries. |
| `FileLoop` / end setting | Whether the motion continues from the beginning. Looping disables end events. |
| `Text`, `TextDuration`, `TextDelay` | Text and its display timing. |
| `Expression` | Expression played during the motion. |
| `Sound`, `SoundChannel`, `SoundVolume`, `SoundDelay`, `SoundLoop` | Sound playback settings. |
| `BlendMode`, `BlendWeight` | Motion blending with other layers. |
| `FadeIn`, `FadeInLoop`, `FadeOut` | Motion transition timing. |
| `Priority` | Priority 2-9; higher priorities interrupt lower ones, and 9 forcibly overrides the previous event. |
| `MotionDuration` | Custom event duration independent of motion or sound duration. |
| `Weight` | Random-selection weight, range 1-999; default 1. |
| `Speed` | Playback speed; unavailable in SDK 2. |
| `Pre-Command` | Command executed before the motion starts. Serialized variants include `Command` or `PreCommand`. |
| `PostCommand` | Command executed after the motion finishes. |
| `Previous Motion` / `PreMtn` | Current event is eligible only after the specified previous event. |
| `Next Motion` / `NextMtn` | Event selected after this event finishes. |
| `Override Facial Tracking Parameters` | Prevents facial tracking from affecting this motion. |
| `Enabled` | Whether the event can execute. |
| `Interruptible` | Same-priority events may interrupt this event when enabled; ineffective at priority 9. |
| `Ignorable` | Event may be skipped when another eligible event has a time limit. A time limit makes this option ineffective. |
| `TimeLimit` | Time condition restricting execution. |
| `Intimacy` | Minimum, maximum, equal, and reward rules for intimacy. |
| `Choices` | Selectable options displayed in the text box; each option can contain `Text` and `NextMtn`. |

## VarFloats

Floating-point variables provide official condition checks and value
operations for motion events. The serialized representation varies between
model versions, so the parser must preserve the variable name and parse its
operation tokens rather than relying on numeric type codes.

### Conditions

Supported condition operators are `greater`, `greater_equal`, `lower`,
`lower_equal`, `equal`, and `not_equal`.

### Value operations

Supported operations are `assign`, `add`, `subtract`, `multiply`, `divide`,
`init`, and `round`. `round` specifies the number of decimal places to keep.
`init` only takes effect when the variable has not been saved already.

Variables can be saved. A variable reference begins with `$`; a model
parameter reference begins with `@`, for example `@ParamAngleX`. The official
runtime also supports `rand(min, max)` and `randf(min, max)`.

All condition checks must pass before the motion event is eligible. Value
operations run after the event is triggered. Variable names such as `idle` or
`status` are model-defined state, not universal Live2DViewerEX variables.

## Controllers

Controllers are evaluated at the controller stage in the frame order. Rive2d
should preserve the controller's enabled state and item order.

### ParamHit

`ParamHit` uses mouse operations to control model parameters. It is separate
from a click action and must be evaluated continuously while the pointer is
held.

```jsonc
{
  "ParamHit": {
    "Enabled": true,
    "Items": [
      {
        "Name": "head_drag",
        "HitArea": "TouchDrag1",
        "Id": "ParamAngleX",
        "Axis": 0,
        "Factor": 0.04,
        "Type": "Drag",
        "LockParam": true,
        "Release": 300,
        "ReleaseType": 0,
        "Weight": 1,
        "BeginMtn": "Drag:start",
        "MinMtn": "Drag:min",
        "MaxMtn": "Drag:max",
        "EndMtn": "Drag:end",
        "Enabled": true
      }
    ]
  }
}
```

| Property | Official meaning |
| --- | --- |
| `Name` | Item name. |
| `HitArea` | Area that starts the parameter interaction. |
| `Id` | Parameter ID to modify. |
| `MinValue`, `MaxValue` | Optional parameter interaction limits; absent values use model limits. |
| `Type` | `Drag`, `Stroke`, or `Hold`. |
| `Axis` | Mouse X/Y axis used by the operation. |
| `Factor` | Drag/stroke change per mouse pixel, or hold change per second. |
| `LockParam` | Parameter remains at its value after release. This is persistence after release, not merely a drag-time lock. |
| `Release` | Time taken for the value to return after release. |
| `ReleaseType` | Animation curve used for the return. It does not mean keep versus restore. |
| `Weight` | Influence of the parameter-hit value on the model. |
| `MinMtn` / `MaxMtn` | Motion at the configured minimum/maximum. |
| `BeginMtn` | Motion when the left button starts the interaction. |
| `EndMtn` | Motion when the mouse is released without reaching the maximum. |
| `LowPriority` | Prevents a low-priority item from overriding physics effects. |
| `Enabled` | Whether the item is active. |

`Factor` is a pointer-input multiplier. It must not be multiplied by the
rendered model scale unless a separate, documented compatibility mode requires
that behavior. `MinValue` and `MaxValue` are parameter values, not screen
coordinates.

### Other controllers

The official editor also defines `ParamLoop`, `ParamValue`, `PartOpacity`,
`ArtmeshOpacity`, `ArtmeshColor`, `ParamTrigger`, `AreaTrigger`,
`GestureTrigger`, `MouseTracking`, `LipSync`, `Blinking`, `Auto Breathing`,
and related tracking/physics controllers. Their item properties must be
normalized from the editor fields rather than inferred from group names.

Important trigger semantics:

- `ParamTrigger` fires when a parameter crosses a configured value in the
  configured direction.
- `AreaTrigger` continuously checks target/trigger-area overlap and fires its
  enter/exit motions; this can have a measurable per-frame cost.
- `ParamLoop` changes parameters over time and can use system-time
  synchronization.
- If a controller's item list is empty, the documented default parameter list
  applies, such as `ParamAngleX` for mouse tracking or `ParamMouthOpenY` for
  lip sync.

## Command Language

Command arguments are separated by spaces. Escape spaces in IDs or paths with
backslashes. Multiple commands are separated by semicolons.

```text
parameters lock ParamAngleX 10 500;motions disable Tap:voice
```

The official command families include:

| Command | Meaning |
| --- | --- |
| `open_url` | Open a browser link. |
| `change_model` | Change model configuration. |
| `add_submodel` / `remove_submodel` | Add or remove a submodel. |
| `start_mtn` | Force a motion at priority 9. The model ID is optional. |
| `stop_mtn` | Stop motions at a layer; default layer is 0. |
| `set_exp`, `next_exp`, `clear_exp` | Set, advance, or clear expressions. |
| `replace_tex` | Replace a texture by index. |
| `stop_sound`, `stop_all_sounds`, `mute_sound`, `unmute_sound` | Control sound playback. |
| `hide_text` | Hide displayed text. |
| `parameters lock` | Persistently lock a parameter to a literal, `$variable`, or `@parameter` value. An optional duration controls fade-in. |
| `parameters set` | Assign a parameter once; unlike `lock`, it is not persistent. |
| `parameters unlock` | Unlock one parameter or all parameters. |
| `animations lock` | Lock an animation layer at a progress value. |
| `motions enable` / `motions disable` | Enable or disable a motion event/group. |
| `hit_areas enable` / `hit_areas disable` | Enable or disable a named hit area. |
| `param_hit enable` / `disable` / `lock` / `unlock` / `begin` / `end` | Control ParamHit items and drag lifecycle. |
| `physics enable` / `disable` | Toggle physics. |
| `eye_blink enable` / `disable` / `enforce` | Toggle or enforce blinking. |
| `lip_sync enable` / `disable` / `enforce` | Toggle or enforce lip sync. |

Unknown commands should produce a debug diagnostic and remain otherwise
side-effect free. A command must not be reinterpreted as a motion completion
rule merely because its text contains a state-like word.

## Rive2d Adapter Contract

The adapter may provide project-specific compatibility behavior, including:

- lower-case and legacy field aliases;
- motion-file caching and resource decryption;
- normalization of action fields into click/press/release/enter/exit routes;
- runtime logging and validation of unresolved references.

These are implementation details, not Live2DViewerEX JSON semantics. In
particular, virtual parameters, guessed drag scrubbing, name-based completion,
and automatic resets must not be documented or implemented as official model
behavior unless the model JSON explicitly declares them.
