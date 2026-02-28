# Live2DViewerEX model3.json Format Reference

This documents the `.model3.json` format used by [Live2DViewerEX](https://store.steampowered.com/app/616720/Live2DViewerEX/) models. Rive2d parses this format to load and interact with Live2D models.

## Top-Level Structure

```jsonc
{
  "Version": 3,
  "Type": 0,                    // optional, always 0
  "FileReferences": { ... },    // paths to model assets + motions
  "HitAreas": [ ... ],          // interactive regions
  "Controllers": { ... },       // behavior controllers
  "Options": { ... },           // display/rendering options
  "Groups": [ ... ],            // Cubism SDK parameter groups (standard format)
  "Bounds": {                   // optional, model canvas bounds
    "Width": 30.28,
    "Height": 23.72,
    "CenterX": 0.0,
    "CenterY": 0.0
  },
  "Bubble": null                // placeholder for speech bubble config
}
```

### Legacy Top-Level Fields

Older models may have these at the top level instead of inside `Controllers`/`Options`:

| Field                | Moved To                          |
| -------------------- | --------------------------------- |
| `HitParams`          | `Controllers.ParamHit.Items`      |
| `LoopParams`         | `Controllers.ParamLoop.Items`     |
| `IntimacyParam`      | `Controllers.IntimacySystem`      |
| `LipSync` (bool)     | `Controllers.LipSync.Enabled`     |
| `EyeBlink` (bool)    | `Controllers.EyeBlink.Enabled`    |
| `ExtraMotion` (bool) | `Controllers.ExtraMotion.Enabled` |
| `ScaleFactor`        | `Options.ScaleFactor`             |
| `TexFixed`           | `Options.TexFixed`                |
| `LipScale`           | `Controllers.LipSync.Gain`        |
| `AnisoLevel`         | `Options.AnisoLevel`              |

---

## FileReferences

```jsonc
{
  "Moc": "model.moc3",                       // compiled model binary
  "Textures": ["texture_00.png"],             // texture images (1-6 per model)
  "Motions": { ... },                         // motion groups (see below)
  "Physics": "physics.json",                  // physics settings
  "PhysicsV2": {                              // optional enhanced physics
    "File": "physics.json",
    "MaxWeight": 0.999                        // max physics weight (0-1)
  },
  "Expressions": [                            // optional facial expression presets
    { "Name": "blush", "File": "exp_blush.json" }
  ],
  "Pose": "pose.json"                         // optional pose definition
}
```

---

## Motions

`FileReferences.Motions` is a dictionary mapping **group names** to **arrays of motion entries**.

```jsonc
{
  "Idle": [{ "File": "idle.motion3.json", "FileLoop": true }],
  "Start": [{ "File": "start.motion3.json", "Name": "login" }],
  "Tap身体": [{ "File": "tap_body.motion3.json", "Sound": "voice.wav" }],
}
```

### Motion Group Naming Conventions

| Pattern                     | Purpose                                             |
| --------------------------- | --------------------------------------------------- |
| `Idle`, `Idle#1`, `Idle#2`  | Idle animations (loop). `#N` suffix = layer/variant |
| `Start`                     | Startup animation on model load                     |
| `Tap`, `Tap身体`, `Tap摸头` | Tap interaction motions                             |
| `TouchDrag1`, `drag1`       | Drag interaction motions                            |
| `TouchIdle1`                | Idle touch state animations                         |
| `Leave60_40_60`             | Timed idle: triggers after 60s idle, lasts 40-60s   |

The `#N` suffix indicates a **layer variant** that can play simultaneously with the base group. `Idle#1` plays on top of `Idle`.

### Motion Entry Fields

Each entry in a motion group array can have these fields:

#### Core Fields

| Field      | Type   | Description                                                                                            |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `File`     | string | Path to `.motion3.json` file. **Optional** — entries without `File` are command-only or menu entries   |
| `Name`     | string | Identifier within the group. Used by `NextMtn` references (`"Group:Name"`)                             |
| `Priority` | int    | Playback priority. Higher overrides lower. Common values: 2 (idle), 3 (normal), 4 (force), 9 (highest) |
| `Weight`   | int    | Random selection weight within the group. Higher = more likely to be picked. Default: 1                |
| `Enabled`  | bool   | Set to `false` to disable without removing                                                             |

#### Animation Control

| Field            | Type      | Description                                                 |
| ---------------- | --------- | ----------------------------------------------------------- |
| `FileLoop`       | bool      | Loop the motion file continuously                           |
| `WrapMode`       | int       | `1` = loop (equivalent to `FileLoop: true`)                 |
| `FadeIn`         | int       | Fade-in duration in milliseconds                            |
| `FadeOut`        | int       | Fade-out duration in milliseconds                           |
| `Speed`          | float     | Playback speed multiplier (e.g., `0.5` = half speed)        |
| `MotionDuration` | int       | Motion duration in milliseconds                             |
| `Duration`       | int       | Override duration in ms (used in timed groups like `Leave`) |
| `Interruptable`  | bool      | Whether another motion can interrupt this one               |
| `Ignorable`      | bool      | Whether this motion can be skipped                          |
| `TimeLimit`      | int\|null | Time limit in ms (placeholder, usually null)                |

#### Sound

| Field          | Type   | Description                      |
| -------------- | ------ | -------------------------------- |
| `Sound`        | string | Path to `.wav`/`.mp3` sound file |
| `SoundDelay`   | int    | Delay before playing sound (ms)  |
| `SoundVolume`  | float  | Volume (0.0 - 1.0)               |
| `SoundChannel` | int    | Audio channel (1 or 2)           |
| `SoundLoop`    | bool   | Loop the sound                   |

#### Text / Dialogue

| Field          | Type   | Description                                             |
| -------------- | ------ | ------------------------------------------------------- |
| `Text`         | string | Dialogue text displayed in speech bubble                |
| `TextDelay`    | int    | Delay before showing text (ms)                          |
| `TextDuration` | int    | How long text is displayed (ms)                         |
| `Language`     | string | Language code for multi-language support (e.g., `"en"`) |

#### Chaining

| Field         | Type         | Description                                                                       |
| ------------- | ------------ | --------------------------------------------------------------------------------- |
| `NextMtn`     | string       | Motion to play after this one finishes. Format: `"Group"` or `"Group:Name"`       |
| `PreMtn`      | string\|null | Prerequisite motion that must have played first. Format: `"Group:Name"`           |
| `Command`     | string       | Command(s) executed when motion starts. See [Command Language](#command-language) |
| `PostCommand` | string       | Command(s) executed after motion finishes                                         |

#### Choices (Interactive Menus)

```jsonc
{
  "Choices": [
    { "Text": "Enable mouse tracking", "NextMtn": "开启鼠标追踪" },
    { "Text": "View details", "NextMtn": "查看详情" },
    { "Text": "Exit menu" }, // no NextMtn = closes menu
  ],
}
```

| Field               | Type   | Description                                              |
| ------------------- | ------ | -------------------------------------------------------- |
| `Choices`           | array  | Interactive choice menu displayed to the user            |
| `Choices[].Text`    | string | Display text for the option                              |
| `Choices[].NextMtn` | string | Motion group to play when selected. Absent = exit/cancel |

#### VarFloats (Conditions & Actions)

A variable-based state machine that gates which motions can play and modifies state.

```jsonc
{
  "VarFloats": [
    { "Name": "var_voice", "Type": 1, "Code": "equal 1" }, // condition: only if var_voice == 1
    { "Name": "id", "Type": 2, "Code": "assign 3" }, // action: set id = 3
  ],
}
```

| Field  | Type   | Description                                                                              |
| ------ | ------ | ---------------------------------------------------------------------------------------- |
| `Name` | string | Variable name. `@`-prefixed names reference Live2D parameters directly                   |
| `Type` | int    | `1` = condition (checked before motion plays), `2` = action (executed when motion plays) |
| `Code` | string | Operation: `"equal N"`, `"not_equal N"`, or `"assign N"`                                 |

**Condition evaluation**: All Type 1 entries must pass for the motion to be eligible. If any condition fails, the entry is skipped during random selection.

**Common variables**:

| Variable      | Purpose                                |
| ------------- | -------------------------------------- |
| `var_voice`   | Idle voice toggle (0=off, 1=on)        |
| `var_start`   | Login animation toggle (0=on, 1=off)   |
| `Tmo`         | Timer/timeout state flag               |
| `id`          | Motion variant selector for cycling    |
| `@param_name` | Direct reference to a Live2D parameter |

#### Intimacy

```jsonc
{
  "Intimacy": { "Min": 50, "Max": 100, "Bonus": 5 },
}
```

| Field   | Type | Description                                   |
| ------- | ---- | --------------------------------------------- |
| `Min`   | int  | Minimum intimacy required to play             |
| `Max`   | int  | Maximum intimacy allowed to play              |
| `Equal` | int  | Exact intimacy value required                 |
| `Bonus` | int  | Intimacy change when played (can be negative) |

---

## HitAreas

Interactive regions mapped to drawables in the model.

```jsonc
[
  { "Name": "TouchHead", "Id": "TouchHead", "Motion": "触摸:摸头", "Order": 5 },
  { "Name": "背景", "Id": "ArtMesh47", "Motion": "Tap背景", "Order": -1 },
  { "Name": "TouchDrag1", "Id": "TouchDrag1", "Motion": "选项:选项" },
]
```

| Field     | Type   | Description                                                                                                                                         |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Name`    | string | Display name of the hit area                                                                                                                        |
| `Id`      | string | Drawable/mesh ID in the Cubism model. Standard IDs: `TouchHead`, `TouchBody`, `TouchSpecial`, `TouchDrag1`-`TouchDrag10`, `TouchIdle1`-`TouchIdle7` |
| `Motion`  | string | Motion group triggered on interaction. Format: `"Group"` (random entry) or `"Group:EntryName"` (specific entry)                                     |
| `Order`   | int    | Z-priority for overlapping hit areas. **Higher = checked first**. Range: -1 to 10                                                                   |
| `Enabled` | bool   | Set to `false` to disable the hit area                                                                                                              |

Entries without `Id` are non-geometry triggers (UI buttons, menu items) that the viewer maps to soft controls rather than model mesh regions.

### Motion Reference Format

Used in `HitArea.Motion`, `NextMtn`, `PreMtn`, `Choices[].NextMtn`, `MaxMtn`, `EndMtn`, `BeginMtn`, and `start_mtn` commands:

- **`"GroupName"`** — play a random entry from the group (respecting Weight and VarFloats conditions)
- **`"GroupName:EntryName"`** — play the specific entry whose `Name` field matches

---

## Controllers

Behavior controllers that automate model interactions.

### ParamHit

Drag-to-parameter mapping: dragging on a hit area changes a Live2D parameter value.

```jsonc
{
  "ParamHit": {
    "Enabled": true,
    "Items": [
      {
        "Name": "underwear_drag",
        "Id": "touch_drag1", // Live2D parameter ID to control
        "HitArea": "TouchDrag1", // which hit area triggers this
        "Axis": 0, // 0 = horizontal, 1 = vertical
        "Factor": -0.03, // drag sensitivity (negative = inverted)
        "ReleaseType": 0, // 0 = spring back, 1 = spring back (timed), 2 = stay, 3 = sticky/persistent
        "Release": 100, // spring-back duration (ms)
        "LockParam": false, // lock parameter during drag
        "MaxMtn": "扯内裤", // motion when param reaches max
        "EndMtn": "drag_end", // motion when drag ends
        "BeginMtn": "drag_start", // motion when drag begins
        "LowPriority": false, // lower priority for this handler
        "Weight": 0.5, // drag weight/damping
        "Type": 2, // drag type
        "Enabled": true,
      },
    ],
  },
}
```

| Field         | Type   | Description                                                                                         |
| ------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `Id`          | string | Live2D parameter ID to control. May not exist in the .moc3 — see **Virtual Parameters** below       |
| `HitArea`     | string | Hit area Name that activates this drag                                                              |
| `Axis`        | int    | `0` = horizontal (X: right=increase, left=decrease), `1` = vertical (Y: down=increase, up=decrease) |
| `Factor`      | float  | Parameter value change per pixel. Effective change = `Factor × modelScale`. Negative inverts direction |
| `ReleaseType` | int    | `0` = spring back to default, `1` = spring back (timed), `2` = stay at value, `3` = sticky/persistent |
| `Release`     | int    | Spring-back animation duration in ms                                                                |
| `LockParam`   | bool   | Lock the parameter (prevent other controllers from changing it) during drag                         |
| `MaxMtn`      | string | Motion triggered when parameter reaches its maximum value                                           |
| `MinMtn`      | string | Motion triggered when parameter reaches its minimum value (legacy format)                           |
| `EndMtn`      | string | Motion triggered when drag ends                                                                     |
| `BeginMtn`    | string | Motion triggered when drag begins (first drag movement)                                             |
| `LowPriority` | bool   | Lower priority for this drag handler                                                                |
| `Weight`      | float  | Drag weight/damping factor                                                                          |

#### Virtual Parameters (Non-Existent Id)

When `Id` references a parameter that doesn't exist in the .moc3 file, ParamHit operates in **drag scrub mode**:

- A virtual parameter value is tracked internally (not applied to the model)
- `MaxMtn` animation starts immediately on pointerdown and is **scrubbed** based on drag distance
- `Axis` and `Factor` define the drag-to-progress curve (how many pixels of drag = full animation progress)
- On release **outside** the hit area: animation plays to completion
- On release **inside** the hit area: behavior depends on `ReleaseType`:
  - Type 0/1 (spring back): animation reverts (cancelled)
  - Type 2/3 (stay/sticky): animation continues from current position

This is the mechanism used by TouchDrag hit areas to scrub animations forward/backward based on drag distance from the initial click point.

### ParamLoop

Automatic looping parameter animations (e.g., swaying, floating effects).

```jsonc
{
  "ParamLoop": {
    "Enabled": true,
    "Items": [{ "Ids": ["Param4"], "Type": 0, "Duration": 6000 }],
  },
}
```

| Field       | Type  | Description                                         |
| ----------- | ----- | --------------------------------------------------- |
| `Id`        | string | Single parameter ID (legacy format)                |
| `Ids`       | array | Parameter IDs to animate                            |
| `Type`      | int   | Waveform: `0` = sine, `1` = triangle/sawtooth       |
| `Duration`  | int   | Loop period in ms                                   |
| `BlendMode` | int   | `0` = overwrite parameter, `1` = additive blending  |

### KeyTrigger

Keyboard key to motion mapping.

```jsonc
{
  "KeyTrigger": {
    "Enabled": true,
    "Items": [{ "Input": 72, "DownMtn": "menu" }],
  },
}
```

| Field     | Type   | Description                         |
| --------- | ------ | ----------------------------------- |
| `Input`   | int    | JavaScript keyCode                  |
| `DownMtn` | string | Motion group triggered on key press |

### EyeBlink

```jsonc
{
  "EyeBlink": {
    "Enabled": true,
    "MinInterval": 500, // min time between blinks (ms)
    "MaxInterval": 6000, // max time between blinks (ms)
    "Items": [
      // optional custom parameter mappings
      {
        "Id": "ParamEyeLOpen",
        "Min": 0.0,
        "Max": 1.0,
        "BlendMode": 2,
        "Input": 0,
      },
    ],
  },
}
```

If `Items` is absent, uses standard Cubism EyeBlink parameters from `Groups`.

### LipSync

```jsonc
{
  "LipSync": {
    "Enabled": true,
    "Gain": 10.0, // audio amplification
    "SmoothTime": 0.075, // smoothing factor
    "Items": [{ "Id": "ParamMouthOpenY", "Min": 0.0, "Max": 1.0, "Input": 0 }],
  },
}
```

### MouseTracking

```jsonc
{
  "MouseTracking": {
    "Enabled": true,
    "SmoothTime": 0.15,
    "Items": [
      {
        "Id": "ParamAngleX",
        "Min": -30.0,
        "Max": 30.0,
        "Axis": 0, // 0 = X, 1 = Y
        "BlendMode": 1, // 1 = additive
        "Input": 0,
        "DefaultValue": 0.0,
        "Inverted": false,
      },
    ],
  },
}
```

### ParamValue

Static parameter presets (toggleable accessories, states).

```jsonc
{
  "ParamValue": {
    "Enabled": true,
    "Items": [
      {
        "Name": "Ring",
        "Ids": ["Paramring"],
        "Value": 1.0,
        "KeyValues": [
          { "Key": "Show", "Value": 1.0 },
          { "Key": "Hide", "Value": 0.0 },
        ],
        "Hidden": false,
      },
    ],
  },
}
```

### ParamTrigger

Triggers motions when a parameter crosses a threshold.

```jsonc
{
  "ParamTrigger": {
    "Enabled": true,
    "Items": [
      {
        "Name": "Sword",
        "Id": "Paramtouch_idle1",
        "Items": [{ "Value": 1.5, "Direction": 0, "Motion": "transform" }],
      },
    ],
  },
}
```

| Field               | Type   | Description             |
| ------------------- | ------ | ----------------------- |
| `Id`                | string | Parameter ID to watch   |
| `Items[].Value`     | float  | Threshold value         |
| `Items[].Direction` | int    | `0` = any direction     |
| `Items[].Motion`    | string | Motion group to trigger |

### PartOpacity

Controls visibility of model parts.

```jsonc
{
  "PartOpacity": {
    "Enabled": true,
    "Items": [
      { "Name": "Background", "Ids": ["Part3", "Part88"], "Value": 1.0 },
    ],
  },
}
```

### ArtmeshOpacity

Controls visibility of individual art meshes (finer-grained than PartOpacity).

```jsonc
{
  "ArtmeshOpacity": {
    "Enabled": true,
    "Items": [
      {
        "Name": "Lighting",
        "Ids": ["ArtMesh172"],
        "Value": 1.0,
        "Hidden": true,
      },
    ],
  },
}
```

### Simple Toggle Controllers

These controllers only have an `Enabled` field:

| Controller      | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `AutoBreath`    | Automatic breathing animation via `ParamBreath`              |
| `ExtraMotion`   | Layer additional idle motions from `Idle#1`, `Idle#2` groups |
| `Accelerometer` | Device tilt input (mobile only)                              |
| `FaceTracking`  | Face tracking via camera                                     |

### Placeholder Controllers

These exist in the JSON but are always empty objects (reserved for future/platform-specific use):

`Microphone`, `Transform`, `AreaTrigger`, `HandTrigger`, `HandTracking`, `ArtmeshColor`, `ArtmeshCulling`

### IntimacySystem

Global affection tracking.

```jsonc
{
  "IntimacySystem": {
    "Enabled": true,
    "InitValue": 50,
    "MinValue": 0,
    "MaxValue": 100,
    "BonusActive": 5, // intimacy gained per active period
    "BonusInactive": -1, // intimacy change when inactive
    "BonusLimit": 0,
  },
}
```

Works with the `Intimacy` field on individual motion entries to gate which motions can play based on current intimacy level.

---

## Options

```jsonc
{
  "Options": {
    "ScaleFactor": 0.1, // default model scale
    "PositionX": 0.0, // default X position offset
    "PositionY": 0.0, // default Y position offset
    "TexFixed": true, // prevent dynamic texture replacement
    "TexType": 0, // texture filtering type
    "AnisoLevel": 4, // anisotropic filtering level
    "MaskBufferSize": 4096, // mask buffer size for rendering
    "AllowMod": false, // allow user modifications
    "Name": "model_name", // display name override
  },
}
```

---

## Groups (Cubism Standard)

Standard Cubism SDK parameter groupings. Used as fallback when `Controllers.EyeBlink.Items` or `Controllers.LipSync.Items` are not defined.

```jsonc
[
  {
    "Target": "Parameter",
    "Name": "EyeBlink",
    "Ids": ["ParamEyeLOpen", "ParamEyeROpen"],
  },
  {
    "Target": "Parameter",
    "Name": "LipSync",
    "Ids": ["ParamMouthOpenY"],
    "Axes": ["X"],
    "Factors": [0.0],
  },
]
```

| Field     | Type   | Description                                          |
| --------- | ------ | ---------------------------------------------------- |
| `Target`  | string | `"Parameter"` or `"ArtmeshOpacity"`                  |
| `Name`    | string | Group purpose: `"EyeBlink"`, `"LipSync"`, `"LookAt"` |
| `Ids`     | array  | Parameter/artmesh IDs in this group                  |
| `Axes`    | array  | Axis mapping per ID                                  |
| `Factors` | array  | Scale factors per ID                                 |
| `Value`   | float  | Default value                                        |

---

## Command Language

The `Command` and `PostCommand` fields on motion entries use a mini command language. Multiple commands are chained with `;`.

```
mouse_tracking disable;parameters lock Paramring 0
stop_mtn;physics disable;eye_blink disable
```

### Commands

| Command                    | Syntax                                       | Description                       |
| -------------------------- | -------------------------------------------- | --------------------------------- |
| **Parameter Control**      |                                              |                                   |
| `parameters lock`          | `parameters lock <id> <value> [duration_ms]` | Lock parameter to value           |
| `parameters lock`          | `parameters lock <id1>,<id2> <value>`        | Lock multiple parameters          |
| `parameters lock`          | `parameters lock <id> $<var> [duration]`     | Lock parameter to variable value  |
| `parameters unlock`        | `parameters unlock <id1>[,<id2>,...]`        | Unlock parameter(s)               |
| `parameters set`           | `parameters set <id> <value>`                | Set parameter value (one-time)    |
| **Motion Control**         |                                              |                                   |
| `start_mtn`                | `start_mtn <group>[:<name>]`                 | Start a motion                    |
| `stop_mtn`                 | `stop_mtn`                                   | Stop current motion               |
| `motions enable`           | `motions enable <group>`                     | Enable a motion group             |
| `motions disable`          | `motions disable <group>`                    | Disable a motion group            |
| **Controller Toggles**     |                                              |                                   |
| `mouse_tracking`           | `mouse_tracking <enable\|disable>`           | Toggle mouse tracking             |
| `physics`                  | `physics <enable\|disable>`                  | Toggle physics                    |
| `eye_blink`                | `eye_blink <enable\|disable\|enforce>`       | Toggle eye blink                  |
| `lip_sync`                 | `lip_sync <enable\|enforce>`                 | Toggle lip sync                   |
| **ParamHit Control**       |                                              |                                   |
| `param_hit enable`         | `param_hit enable <id1>[,<id2>,...]`         | Enable param hit items            |
| `param_hit disable`        | `param_hit disable <id1>[,<id2>,...]`        | Disable param hit items           |
| `param_hit lock`           | `param_hit lock <ids>`                       | Lock param hit items              |
| `param_hit unlock`         | `param_hit unlock <ids>`                     | Unlock param hit items            |
| `hit_areas disable`        | `hit_areas disable`                          | Disable all hit areas             |
| **Visual Control**         |                                              |                                   |
| `replace_tex`              | `replace_tex <index> <file.png>`             | Replace texture at index          |
| `parts set`                | `parts set <partId> <value>`                 | Set part opacity                  |
| `parts lock`               | `parts lock <partId> <value>`                | Lock part opacity                 |
| `artmesh_opacities lock`   | `artmesh_opacities lock <id> <value>`        | Lock artmesh opacity              |
| `artmesh_opacities unlock` | `artmesh_opacities unlock <id>`              | Unlock artmesh opacity            |
| `artmesh_opacities set`    | `artmesh_opacities set <id1>,<id2> <value>`  | Set artmesh opacity               |
| `artmeshes lock`           | `artmeshes lock <id> <value>`                | Lock artmesh                      |
| **Audio**                  |                                              |                                   |
| `mute_sound`               | `mute_sound <0\|1>`                          | Mute (1) / unmute (0) sound       |
| `stop_sound`               | `stop_sound <channel>`                       | Stop sound on channel             |
| **Other**                  |                                              |                                   |
| `open_url`                 | `open_url <url>`                             | Open URL in browser               |
| `change_cos`               | `change_cos <model3.json>`                   | Switch to different costume/model |

---

## Appendix: Leave Group Naming

`Leave{Interval}_{MinDuration}_{MaxDuration}` — all values in seconds.

| Example         | Triggers After | Lasts       |
| --------------- | -------------- | ----------- |
| `Leave30_30_30` | 30s idle       | exactly 30s |
| `Leave60_40_60` | 60s idle       | 40-60s      |
| `Leave600_1_1`  | 10min idle     | 1s          |

After the user is idle for `Interval` seconds, a random motion from the group plays. `MinDuration`/`MaxDuration` control how long the timed idle state persists before returning to normal idle.
