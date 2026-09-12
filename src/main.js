import * as PIXI from 'pixi.js';
import { Assets } from 'pixi.js';
import { Live2DModel, Live2DPlugin, SoundManager } from 'untitled-pixi-live2d-engine';

// Expose PIXI globally for pixi-live2d-display
window.PIXI = PIXI;
PIXI.extensions.add(Live2DPlugin);

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Forward console logs to backend log file
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level];
  console[level] = (...args) => {
    orig.apply(console, args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    invoke('js_log', { level, msg }).catch(() => {});
  };
}
window.addEventListener('error', (e) => {
  invoke('js_log', { level: 'error', msg: `${e.message} at ${e.filename}:${e.lineno}:${e.colno}` }).catch(() => {});
});
window.addEventListener('unhandledrejection', (e) => {
  invoke('js_log', { level: 'error', msg: `Unhandled rejection: ${e.reason}` }).catch(() => {});
});

// Disable PixiJS Worker texture loading — Workers have their own fetch() that
// can't access Tauri's model:// custom protocol.  Keep createImageBitmap enabled
// so PixiJS uses the main-thread fetch→blob→createImageBitmap path.
PIXI.loadTextures.config.preferWorkers = false;

// Override fetch() so model:// URLs are loaded via XHR (which WebKitGTK routes
// through Tauri's custom protocol handler).  Returns a proper Response object
// so PixiJS's loadImageBitmap pipeline works unchanged.
const _origFetch = window.fetch;
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : input?.url;
  if (url && url.startsWith('model://')) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => {
        const ct = xhr.getResponseHeader('Content-Type') || 'application/octet-stream';
        const blob = new Blob([xhr.response], { type: ct });
        resolve(new Response(blob, { status: 200, statusText: 'OK' }));
      };
      xhr.onerror = () => reject(new TypeError('Network request failed'));
      xhr.send();
    });
  }
  return _origFetch.apply(this, arguments);
};

const canvas = document.getElementById('canvas');

const app = new PIXI.Application();

let currentModel = null;
let showBorder = false;
let tapMotion = true;
let rightClickMotion = false;
let showHitAreas = false;
let lockModel = false;
let mouseTracking = true;
let hitMotionMap = {};
let motionNameToIndex = {};  // { group: { name: arrayIndex } }
let motionNextMap = {};      // { group: { arrayIndex: nextMtnString } }
let fileLoopMap = {};        // { group: { arrayIndex: true } } — motions with FileLoop
let pendingNextMtn = null;
let idleGroup = null;         // name of Idle motion group (e.g. 'Idle', 'idle')
let currentModelPath = null;
let dragging = false;
let dragMoved = false;
let dragStart = { x: 0, y: 0 };
let dragOffset = { x: 0, y: 0 };
const DRAG_THRESHOLD = 4; // px — ignore micro-movements for tap detection
let playingStart = false;     // true while start animation is playing
let paramHitItems = [];      // ParamHit controller items parsed from model JSON
let paramDragging = null;    // { hitArea, items: [{ item, startPos, paramIndex, startValue, currentValue }], hasMoved }
let paramReleaseAnims = [];  // parameter reset animations after drag release
let paramHitLocks = {};      // { paramIndex: { value } } — persistent ParamHit locks
let paramLoopItems = [];     // ParamLoop controller items: auto-oscillating parameters
let dragHitNames = [];       // hit area names recorded on pointerdown for drag-motion detection
let modelMotions = {};       // normalized motion groups from model metadata
let hitAreaOrder = {};       // { hitAreaName: orderValue } from HitAreas[].Order for sorting

// --- Feature state ---
let motionEntryMap = {};       // { group: { index: entryObject } }
let varStore = {};             // VarFloats variable store
let lockedParams = {};         // { paramId: { paramIndex, value, startTime, duration } }
let lockedParts = {};          // { partId: { index, value } }
let disabledMotionGroups = new Set();
let disabledParamHitItems = new Set();
let intimacyValue = 50;
let intimacyConfig = null;     // { initValue, minValue, maxValue }
let currentMotionInfo = null;  // { group, index, entry }
let playedMotions = new Set(); // for PreMtn tracking
let leaveGroups = [];          // { group, interval, minDuration, maxDuration }
let lastInteractionTime = 0;
let leaveTimeout = null;
let leaveActive = false;
let keyTriggerItems = [];      // { keyCode, downMtn }
let paramTriggerItems = [];    // { paramId, paramIndex, triggers[] }
let paramTriggerLastValues = {};
let speechBubbleTimeout = null;
let extraMotionEnabled = false;
let eyeBlinkSave = null;       // saved eyeBlink reference for enable/disable
let physicsSave = null;        // saved physics reference for enable/disable
let soundMuted = false;

// Graphics overlays (drawn on top of model)
const borderGfx = new PIXI.Graphics();
const hitAreaGfx = new PIXI.Graphics();
const hitAreaContainer = new PIXI.Container();
hitAreaContainer.addChild(hitAreaGfx);
const hitAreaLabels = []; // pool of PIXI.Text for hit area names

// Speech bubble element
const speechBubble = document.createElement('div');
speechBubble.className = 'speech-bubble';
speechBubble.style.display = 'none';
document.body.appendChild(speechBubble);

// Choices UI element
const choicesContainer = document.createElement('div');
choicesContainer.className = 'choices-menu';
choicesContainer.style.display = 'none';
document.body.appendChild(choicesContainer);

// init() is async; listeners registered before it so events aren't missed
const ready = app.init({
  canvas,
  backgroundAlpha: 0,
  backgroundColor: 0x000000,
  resizeTo: window,
  antialias: true,
  resolution: window.devicePixelRatio || 1,
  autoDensity: true,
  preference: 'webgl',   // WebKitGTK has no WebGPU
}).then(() => {
  app.stage.addChild(hitAreaContainer);
  app.stage.addChild(borderGfx);

  // Make stage interactive for drag move/up events
  app.stage.eventMode = 'static';
  app.stage.hitArea = new PIXI.Rectangle(0, 0, app.screen.width, app.screen.height);

  // --- Drag: move & end (on stage to capture events outside model) ---

  app.stage.on('pointermove', (e) => {
    // ParamHit drag — control a Live2D parameter
    if (paramDragging && currentModel) {
      if (!paramDragging.hasMoved) {
        paramDragging.hasMoved = true;
      }
      const dx = e.global.x - dragStart.x;
      const dy = e.global.y - dragStart.y;
      if (!dragMoved && dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
        dragMoved = true;
      }
      const scale = currentModel?.scale.x || 1;
      const coreModel = currentModel.internalModel.coreModel;
      for (const state of paramDragging.items) {
        const { item, startValue, paramIndex } = state;
        const currentPos = item.axis === 0 ? e.global.x : e.global.y;
        const delta = currentPos - state.lastPos;
        state.lastPos = currentPos;
        if (item.type === 2) continue;
        const value = item.type === 1
          ? state.targetValue + Math.abs(delta) * item.factor * scale
          : startValue + (currentPos - state.startPos) * item.factor * scale;
        updateParamHitState(state, value, coreModel);
      }
      return;
    }
    // Model drag — move position + trigger drag motions
    if (!dragging || !currentModel) return;
    if (!dragMoved) {
      const dx = e.global.x - dragStart.x;
      const dy = e.global.y - dragStart.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      dragMoved = true;
    }
    // lockModel only prevents position changes, not drag motions
    if (lockModel) return;
    currentModel.x = e.global.x - dragOffset.x;
    currentModel.y = e.global.y - dragOffset.y;
    clampModelPosition();
    updateBorder();
  });

  app.stage.on('pointerup', (e) => {
    if (paramDragging && currentModel) {
      handleParamHitRelease();
      return;
    }
    if (dragging && currentModel) {
      handleDragRelease(e);
      return;
    }
  });

  app.stage.on('pointerupoutside', (e) => {
    if (paramDragging && currentModel) {
      handleParamHitRelease();
      return;
    }
    if (dragging && currentModel) {
      handleDragRelease(e);
      return;
    }
  });

  app.stage.on('pointercancel', () => {
    if (paramDragging && currentModel) {
      handleParamHitRelease();
      return;
    }
    if (dragging && currentModel) {
      handleDragRelease();
    }
  });

  // --- Right-click debug menu ---
  app.canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
  });

  // Close menu on left-click outside or Escape
  document.addEventListener('pointerdown', (e) => {
    if (ctxMenu.style.display !== 'none' && !ctxMenu.contains(e.target)) {
      closeContextMenu();
    }
    // Reset interaction time for Leave timer
    lastInteractionTime = Date.now();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
    // KeyTrigger: dispatch key press to motion
    for (const kt of keyTriggerItems) {
      if (e.keyCode === kt.keyCode && kt.downMtn) {
        const [g, idxStr] = kt.downMtn.split(':');
        console.log(`[key] KeyTrigger ${e.keyCode} → ${kt.downMtn}`);
        playMotion(g, idxStr !== undefined ? parseInt(idxStr) : undefined);
        break;
      }
    }
    lastInteractionTime = Date.now();
  });

  // --- Scroll wheel resize ---

  app.canvas.addEventListener('wheel', (e) => {
    if (!currentModel || lockModel) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.95 : 1.05;
    const newScale = Math.max(0.05, Math.min(2.0, currentModel.scale.x * factor));
    currentModel.scale.set(newScale);
    updateBorder();
    updateInputRegion();
    debouncedSaveScale(newScale);
  }, { passive: false });

  // --- Window resize: update stage hit area ---

  window.addEventListener('resize', () => {
    app.stage.hitArea = new PIXI.Rectangle(0, 0, app.screen.width, app.screen.height);
    if (currentModel) {
      clampModelPosition();
      updateInputRegion();
    }
  });
});

// --- Register event listeners synchronously so we never miss backend events ---

invoke('get_config').then((config) => {
  showBorder = config.show_border;
  tapMotion = config.tap_motion;
  rightClickMotion = config.right_click_motion;
  showHitAreas = config.show_hit_areas;
  lockModel = config.lock_model;
  mouseTracking = config.mouse_tracking;
}).catch(() => {});

listen('load-model', async (event) => {
  await ready;
  const modelUrl = 'model://localhost/' + event.payload;
  loadModel(modelUrl);
});

listen('reset-position', async () => {
  await ready;
  resetModelPosition();
});

listen('motions-changed', async (event) => {
  const changedPath = event.payload;
  if (!currentModel || changedPath !== currentModelPath) return;
  const rawJson = currentModel.internalModel.settings.json;
  let customJsonStr = null;
  try {
    customJsonStr = await invoke('get_custom_motions', { path: changedPath });
  } catch {}
  buildHitMotionMap(normalizeModelMetadata(rawJson).hitAreas, customJsonStr);
});

listen('trigger-motion', async (event) => {
  await ready;
  if (!currentModel) return;
  const [group, index] = event.payload;
  console.log(`[motion] trigger from settings: ${group}` + (index != null ? `:${index}` : ''));
  playMotion(group, index ?? undefined);
});

listen('unload-model', async () => {
  await ready;
  if (currentModel) {
    app.ticker.remove(drawHitAreas);
    hitAreaGfx.clear();
    for (const label of hitAreaLabels) label.visible = false;
    borderGfx.clear();
    app.stage.removeChild(currentModel);
    const modelKeys = [...Assets.cache._cache.keys()].filter(k => k.startsWith('model://'));
    for (const key of modelKeys) Assets.cache.remove(key);
    currentModel.destroy();
    currentModel = null;
    currentModelPath = null;
    hitMotionMap = {};
    motionNameToIndex = {};
    motionNextMap = {};
    fileLoopMap = {};
    pendingNextMtn = null;
    idleGroup = null;
    playingStart = false;
    paramHitItems = [];
    paramDragging = null;
    paramReleaseAnims = [];
    paramHitLocks = {};
    paramLoopItems = [];
    dragHitNames = [];
    modelMotions = {};
    hitAreaOrder = {};
    // Reset feature state
    motionEntryMap = {};
    varStore = {};
    lockedParams = {};
    lockedParts = {};
    disabledMotionGroups = new Set();
    disabledParamHitItems = new Set();
    currentMotionInfo = null;
    playedMotions = new Set();
    leaveGroups = [];
    if (leaveTimeout) { clearInterval(leaveTimeout); leaveTimeout = null; }
    leaveActive = false;
    keyTriggerItems = [];
    paramTriggerItems = [];
    paramTriggerLastValues = {};
    clearTimeout(speechBubbleTimeout);
    speechBubble.style.display = 'none';
    choicesContainer.style.display = 'none';
    extraMotionEnabled = false;
    eyeBlinkSave = null;
    physicsSave = null;
    soundMuted = false;
    intimacyConfig = null;
    intimacyValue = 50;
    // Clear input region so clicks pass through
    invoke('update_input_region', { x: 0, y: 0, width: 0, height: 0 }).catch(() => {});
  }
});

listen('setting-changed', (event) => {
  const [key, value] = event.payload;
  if (key === 'show_border') {
    showBorder = value === 'true';
    updateBorder();
  }
  if (key === 'tap_motion') {
    tapMotion = value === 'true';
  }
  if (key === 'right_click_motion') {
    rightClickMotion = value === 'true';
  }
  if (key === 'show_hit_areas') {
    showHitAreas = value === 'true';
    drawHitAreas();
  }
  if (key === 'lock_model') {
    lockModel = value === 'true';
  }
  if (key === 'mouse_tracking') {
    mouseTracking = value === 'true';
    if (currentModel) {
      currentModel.automator.autoFocus = mouseTracking;
      if (!mouseTracking) {
        currentModel.internalModel.focusController.focus(0, 0);
      }
    }
  }
});

// --- Input region helpers ---

function updateInputRegion() {
  if (!currentModel) return;
  const bounds = currentModel.getBounds();
  const pad = 20;
  invoke('update_input_region', {
    x: Math.max(0, Math.floor(bounds.x - pad)),
    y: Math.max(0, Math.floor(bounds.y - pad)),
    width: Math.ceil(bounds.width + pad * 2),
    height: Math.ceil(bounds.height + pad * 2),
  }).catch(() => {});
}

function setFullInputRegion() {
  invoke('update_input_region', {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  }).catch(() => {});
}

function getParamHitBounds(item, coreModel, paramIndex) {
  const modelMin = coreModel.getParameterMinimumValue(paramIndex);
  const modelMax = coreModel.getParameterMaximumValue(paramIndex);
  return {
    min: Number.isFinite(item.minValue) ? Math.max(modelMin, item.minValue) : modelMin,
    max: Number.isFinite(item.maxValue) ? Math.min(modelMax, item.maxValue) : modelMax,
  };
}

function clampModelPosition() {
  if (!currentModel) return;
  const bounds = currentModel.getBounds();
  const width = app.screen.width;
  const height = app.screen.height;
  let dx = 0;
  let dy = 0;

  if (bounds.width >= width) {
    dx = width / 2 - (bounds.x + bounds.width / 2);
  } else if (bounds.x < 0) {
    dx = -bounds.x;
  } else if (bounds.x + bounds.width > width) {
    dx = width - (bounds.x + bounds.width);
  }

  if (bounds.height >= height) {
    dy = height / 2 - (bounds.y + bounds.height / 2);
  } else if (bounds.y < 0) {
    dy = -bounds.y;
  } else if (bounds.y + bounds.height > height) {
    dy = height - (bounds.y + bounds.height);
  }

  currentModel.x += dx;
  currentModel.y += dy;
}

function updateParamHitState(state, value, coreModel) {
  const { item, startValue, paramIndex } = state;
  const { min, max } = getParamHitBounds(item, coreModel, paramIndex);
  const previousValue = state.currentValue;
  state.targetValue = Math.max(min, Math.min(max, value));
  state.currentValue = Math.max(
    min,
    Math.min(max, startValue + (state.targetValue - startValue) * item.weight),
  );

  // Boundary actions fire when the value reaches a limit, not when the
  // pointer is released. Reset the latch after moving away so a later
  // crossing can fire again during the same interaction.
  if (previousValue < max && state.currentValue >= max) {
    if (item.maxMtn) triggerParamHitMotions([state], 'maxMtn', 'MaxMtn');
    state.maxReached = true;
  } else if (state.currentValue < max) {
    state.maxReached = false;
  }
  if (previousValue > min && state.currentValue <= min) {
    if (item.minMtn) triggerParamHitMotions([state], 'minMtn', 'MinMtn');
    state.minReached = true;
  } else if (state.currentValue > min) {
    state.minReached = false;
  }
}

function applyReleaseCurve(progress, releaseType) {
  const t = Math.max(0, Math.min(1, progress));
  switch (Number(releaseType)) {
    case 1: // Slow Out
      return 1 - (1 - t) ** 2;
    case 2: // Fast Out
      return t ** 2;
    case 3: // Ease In Out
      return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    default: // Linear
      return t;
  }
}

// --- Border drawing ---

function updateBorder() {
  borderGfx.clear();
  if (!currentModel || !showBorder) return;
  const bounds = currentModel.getBounds();
  borderGfx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  borderGfx.stroke({ width: 2, color: 0xff0000, alpha: 1 });
}

// --- Hit area drawing ---

const hitAreaBounds = { x: 0, y: 0, width: 0, height: 0 };

function drawHitAreas() {
  hitAreaGfx.clear();
  // Hide all labels first
  for (const label of hitAreaLabels) label.visible = false;

  if (!currentModel || !showHitAreas) return;

  const internalModel = currentModel.internalModel;
  const hitAreas = internalModel.hitAreas;
  const transform = internalModel.localTransform;
  const wt = currentModel.worldTransform;

  let labelIdx = 0;
  for (const name of Object.keys(hitAreas)) {
    const hitArea = hitAreas[name];
    let drawIndex = hitArea.index;
    if (drawIndex < 0) {
      drawIndex = internalModel.getDrawableIndex(hitArea.id);
      if (drawIndex < 0) continue;
      hitArea.index = drawIndex;
    }

    const b = internalModel.getDrawableBounds(drawIndex, hitAreaBounds);
    // Transform from model canvas space → model local space
    const lx = b.x * transform.a + transform.tx;
    const ly = b.y * transform.d + transform.ty;
    const lw = b.width * transform.a;
    const lh = b.height * transform.d;
    // Transform from model local space → screen space
    const sx = lx * wt.a + ly * wt.c + wt.tx;
    const sy = lx * wt.b + ly * wt.d + wt.ty;
    const sw = lw * wt.a;
    const sh = lh * wt.d;

    hitAreaGfx.rect(sx, sy, sw, sh);
    hitAreaGfx.stroke({ width: 2, color: 0xff0000, alpha: 0.8 });

    // Show name label at top-left of the hit area rect
    if (labelIdx >= hitAreaLabels.length) {
      const label = new PIXI.Text({ text: '', style: {
        fontSize: 12,
        fill: 0xff0000,
        fontFamily: 'system-ui, sans-serif',
      }});
      hitAreaLabels.push(label);
      hitAreaContainer.addChild(label);
    }
    const label = hitAreaLabels[labelIdx];
    label.text = name;
    label.x = sx + 3;
    label.y = sy + 2;
    label.visible = true;
    labelIdx++;
  }
}

// --- Right-click context menu ---

const ctxMenu = document.createElement('div');
ctxMenu.className = 'ctx-menu';
document.body.appendChild(ctxMenu);

function createMenuItem(label, opts = {}) {
  const el = document.createElement('div');
  el.className = 'ctx-item';
  if (opts.toggle !== undefined) {
    const check = document.createElement('span');
    check.className = 'ctx-check';
    check.textContent = opts.toggle ? '\u2713' : '';
    el.appendChild(check);
  }
  const text = document.createElement('span');
  text.textContent = label;
  el.appendChild(text);
  el.addEventListener('click', () => { opts.action(); closeContextMenu(); });
  return el;
}

function createSeparator() {
  const el = document.createElement('div');
  el.className = 'ctx-sep';
  return el;
}

function showContextMenu(x, y) {
  ctxMenu.innerHTML = '';
  ctxMenu.appendChild(createMenuItem('Tap Motions', {
    toggle: tapMotion,
    action: () => invoke('set_setting', { key: 'tap_motion', value: String(!tapMotion) }),
  }));
  ctxMenu.appendChild(createMenuItem('Right-click Motions', {
    toggle: rightClickMotion,
    action: () => invoke('set_setting', {
      key: 'right_click_motion',
      value: String(!rightClickMotion),
    }),
  }));
  ctxMenu.appendChild(createMenuItem('Show Hit Areas', {
    toggle: showHitAreas,
    action: () => invoke('set_setting', { key: 'show_hit_areas', value: String(!showHitAreas) }),
  }));
  ctxMenu.appendChild(createMenuItem('Mouse Tracking', {
    toggle: mouseTracking,
    action: () => invoke('set_setting', { key: 'mouse_tracking', value: String(!mouseTracking) }),
  }));
  ctxMenu.appendChild(createMenuItem('Lock Model', {
    toggle: lockModel,
    action: () => invoke('set_setting', { key: 'lock_model', value: String(!lockModel) }),
  }));
  ctxMenu.appendChild(createMenuItem('Debug Border', {
    toggle: showBorder,
    action: () => invoke('set_setting', { key: 'show_border', value: String(!showBorder) }),
  }));
  ctxMenu.appendChild(createSeparator());
  ctxMenu.appendChild(createMenuItem('Reset Position', {
    action: resetModelPosition,
  }));
  if (currentModelPath) {
    ctxMenu.appendChild(createMenuItem('Model Settings', {
      action: () => invoke('open_settings', { view: 'model_detail:' + currentModelPath }),
    }));
  }
  ctxMenu.appendChild(createMenuItem('Settings', {
    action: () => invoke('open_settings', { view: null }),
  }));

  ctxMenu.style.display = 'block';
  // Clamp to window bounds
  const menuW = ctxMenu.offsetWidth;
  const menuH = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(x, window.innerWidth - menuW) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - menuH) + 'px';
  setFullInputRegion();
}

function closeContextMenu() {
  if (ctxMenu.style.display === 'none') return;
  ctxMenu.style.display = 'none';
  updateInputRegion();
}

function resetModelPosition() {
  if (!currentModel) return;
  const origW = currentModel.width / currentModel.scale.x;
  const origH = currentModel.height / currentModel.scale.y;
  const scaleX = app.screen.width / origW;
  const scaleY = app.screen.height / origH;
  currentModel.scale.set(Math.min(scaleX, scaleY) * 0.3);
  currentModel.x = app.screen.width / 2;
  currentModel.y = app.screen.height / 2;
  clampModelPosition();
  updateBorder();
  updateInputRegion();
}

// --- Save helpers ---

let scaleSaveTimeout = null;
function debouncedSaveScale(scale) {
  clearTimeout(scaleSaveTimeout);
  scaleSaveTimeout = setTimeout(() => {
    invoke('set_setting', { key: 'model_scale', value: String(scale) });
  }, 300);
}

function savePosition() {
  if (!currentModel) return;
  invoke('set_setting', { key: 'model_x', value: String(currentModel.x) });
  invoke('set_setting', { key: 'model_y', value: String(currentModel.y) });
}

// --- Model metadata normalization ---

function firstValue(object, ...keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined) return object[key];
  }
  return undefined;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizedControllerName(name) {
  const compact = name.toLowerCase().replaceAll('_', '');
  const names = {
    paramhit: 'ParamHit',
    paramloop: 'ParamLoop',
    paramtrigger: 'ParamTrigger',
    keytrigger: 'KeyTrigger',
    partopacity: 'PartOpacity',
    paramvalue: 'ParamValue',
    extramotion: 'ExtraMotion',
    intimacysystem: 'IntimacySystem',
  };
  return names[compact] || name;
}

function normalizeControllerItem(item) {
  const normalized = { ...item };
  const fields = {
    Name: ['Name', 'name'], Id: ['Id', 'id'], Ids: ['Ids', 'ids'],
    HitArea: ['HitArea', 'hitArea', 'hit_area'], Axis: ['Axis', 'axis'],
    Factor: ['Factor', 'factor'], MinValue: ['MinValue', 'minValue', 'min_value'],
    MaxValue: ['MaxValue', 'maxValue', 'max_value'], Release: ['Release', 'release'],
    ReleaseType: ['ReleaseType', 'releaseType', 'release_type'],
    LockParam: ['LockParam', 'lockParam', 'lock_param'],
    MaxMtn: ['MaxMtn', 'maxMtn', 'max_mtn'], MinMtn: ['MinMtn', 'minMtn', 'min_mtn'],
    BeginMtn: ['BeginMtn', 'beginMtn', 'begin_mtn'], EndMtn: ['EndMtn', 'endMtn', 'end_mtn'],
    Input: ['Input', 'input'], DownMtn: ['DownMtn', 'downMtn', 'down_mtn'],
    Motion: ['Motion', 'motion'], Direction: ['Direction', 'direction'],
    Value: ['Value', 'value'], Duration: ['Duration', 'duration'], Type: ['Type', 'type'],
    Weight: ['Weight', 'weight'], LowPriority: ['LowPriority', 'lowPriority', 'low_priority'],
    BlendMode: ['BlendMode', 'blendMode', 'blend_mode'], Lock: ['Lock', 'lock'],
    Enabled: ['Enabled', 'enabled'],
  };
  for (const [name, aliases] of Object.entries(fields)) {
    const value = firstValue(item, ...aliases);
    if (value !== undefined) normalized[name] = value;
  }
  const children = firstValue(item, 'Items', 'items');
  if (Array.isArray(children)) normalized.Items = children.map(normalizeControllerItem);
  return normalized;
}

function normalizeMotionEntry(entry) {
  const varFloats = firstValue(entry, 'VarFloats', 'var_floats');
  const intimacy = firstValue(entry, 'Intimacy', 'intimacy');
  return {
    ...entry,
    Name: firstValue(entry, 'Name', 'name'), File: firstValue(entry, 'File', 'file'),
    Command: firstValue(entry, 'Command', 'command'),
    PostCommand: firstValue(entry, 'PostCommand', 'post_command'),
    NextMtn: firstValue(entry, 'NextMtn', 'next_mtn'),
    PreMtn: firstValue(entry, 'PreMtn', 'pre_mtn'), Priority: firstValue(entry, 'Priority', 'priority'),
    Weight: firstValue(entry, 'Weight', 'weight'), Enabled: firstValue(entry, 'Enabled', 'enabled'),
    FileLoop: firstValue(entry, 'FileLoop', 'file_loop', 'Loop', 'loop'),
    WrapMode: firstValue(entry, 'WrapMode', 'wrap_mode'),
    FadeIn: firstValue(entry, 'FadeIn', 'fade_in'), FadeOut: firstValue(entry, 'FadeOut', 'fade_out'),
    Text: firstValue(entry, 'Text', 'text'), TextDelay: firstValue(entry, 'TextDelay', 'text_delay'),
    TextDuration: firstValue(entry, 'TextDuration', 'text_duration'),
    Choices: firstValue(entry, 'Choices', 'choices'),
    VarFloats: Array.isArray(varFloats) ? varFloats.map(value => ({
      ...value,
      Name: firstValue(value, 'Name', 'name'), Type: firstValue(value, 'Type', 'type'),
      Code: firstValue(value, 'Code', 'code'),
    })) : undefined,
    Intimacy: intimacy ? {
      ...intimacy,
      Min: firstValue(intimacy, 'Min', 'min'), Max: firstValue(intimacy, 'Max', 'max'),
      Equal: firstValue(intimacy, 'Equal', 'equal'), Bonus: firstValue(intimacy, 'Bonus', 'bonus'),
    } : undefined,
  };
}

function normalizeModelMetadata(rawJson) {
  const motions = {};
  for (const [group, entries] of Object.entries(rawJson.FileReferences?.Motions || rawJson.motions || {})) {
    motions[group] = Array.isArray(entries) ? entries.map(normalizeMotionEntry) : [];
  }
  const hitAreas = (rawJson.HitAreas || rawJson.hitAreas || rawJson.hit_areas || []).map(hitArea => ({
    ...hitArea,
    Name: firstValue(hitArea, 'Name', 'name'), Motion: firstValue(hitArea, 'Motion', 'motion'),
    Order: firstValue(hitArea, 'Order', 'order'), Enabled: firstValue(hitArea, 'Enabled', 'enabled'),
  }));
  const controllers = {};
  for (const [name, config] of Object.entries(rawJson.Controllers || rawJson.controllers || {})) {
    const items = firstValue(config, 'Items', 'items');
    controllers[normalizedControllerName(name)] = {
      ...config,
      Enabled: firstValue(config, 'Enabled', 'enabled'),
      Items: Array.isArray(items) ? items.map(normalizeControllerItem) : [],
    };
  }
  return {
    motions,
    hitAreas,
    controllers,
    hitParams: (rawJson.HitParams || rawJson.hit_params || []).map(normalizeControllerItem),
    loopParams: (rawJson.LoopParams || rawJson.loop_params || []).map(normalizeControllerItem),
    extraMotion: rawJson.ExtraMotion ?? rawJson.extra_motion,
    intimacyParam: rawJson.IntimacyParam || rawJson.intimacy_param || {},
  };
}

// Build motionNameToIndex, motionNextMap, fileLoopMap, and motionEntryMap.
function buildMotionMaps(motions) {
  motionNameToIndex = {};
  motionNextMap = {};
  fileLoopMap = {};
  motionEntryMap = {};
  for (const [group, entries] of Object.entries(motions)) {
    if (!Array.isArray(entries)) continue;
    motionNameToIndex[group] = {};
    motionNextMap[group] = {};
    motionEntryMap[group] = {};
    for (let i = 0; i < entries.length; i++) {
      motionEntryMap[group][i] = entries[i];
      if (entries[i].Name) motionNameToIndex[group][entries[i].Name] = i;
      if (entries[i].NextMtn) motionNextMap[group][i] = entries[i].NextMtn;
      if (entries[i].FileLoop || entries[i].WrapMode === 1) {
        if (!fileLoopMap[group]) fileLoopMap[group] = {};
        fileLoopMap[group][i] = true;
      }
    }
  }
}

function findMotionGroup(group) {
  if (modelMotions[group]) return group;
  const normalized = group.toLowerCase();
  return Object.keys(modelMotions).find(name => name.toLowerCase() === normalized) || group;
}

// Resolve a "group:Name" reference to "group:arrayIndex".
function resolveMotionRef(ref) {
  const [rawGroup, name] = ref.split(':');
  const group = findMotionGroup(rawGroup);
  if (name !== undefined && motionNameToIndex[group]?.[name] !== undefined) {
    return group + ':' + motionNameToIndex[group][name];
  }
  return group + (name !== undefined ? ':' + name : '');
}

function playMotionRef(ref, priority) {
  if (!ref) return;
  const resolved = resolveMotionRef(ref);
  const [group, idxStr] = resolved.split(':');
  playMotion(group, idxStr !== undefined ? parseInt(idxStr) : undefined, priority);
}

function buildHitMotionMap(hitAreas, customJson) {
  hitMotionMap = {};
  hitAreaOrder = {};
  for (const hitArea of hitAreas) {
    if (!hitArea.Name || hitArea.Enabled === false) continue;
    if (hitArea.Motion) hitMotionMap[hitArea.Name] = resolveMotionRef(hitArea.Motion);
    if (hitArea.Order !== undefined) hitAreaOrder[hitArea.Name] = hitArea.Order;
  }
  if (customJson) Object.assign(hitMotionMap, JSON.parse(customJson));
}

function sortHitNames(names) {
  if (names.length <= 1) return names;
  return [...names].sort((a, b) => (hitAreaOrder[b] ?? 0) - (hitAreaOrder[a] ?? 0));
}

function isDragHitArea(name) {
  if (!name) return false;
  return /drag/i.test(name) || paramHitItems.some(item => item.hitArea === name);
}

// HitArea.Motion is an action/state route, not a progress-scrubbing instruction.
function triggerDragMotions() {
  for (const name of dragHitNames) {
    if (!isDragHitArea(name)) continue;
    if (paramHitItems.some(item => item.hitArea === name)) continue;
    const mapped = hitMotionMap[name];
    if (mapped && mapped !== '__none__') {
      console.log(`[motion] drag area action on ${name}: ${mapped}`);
      playMotionRef(mapped);
      return;
    }
  }
}

function resolveMaxMtn(ref, depth = 0) {
  if (depth > 5) return ref;
  const resolved = resolveMotionRef(ref);
  const [group, idxStr] = resolved.split(':');
  const entries = modelMotions[group];
  if (!entries) return resolved;
  const idx = idxStr !== undefined ? parseInt(idxStr) : 0;
  const entry = entries[idx];
  if (!entry) return resolved;
  if (entry.Command && entry.Command.startsWith('start_mtn ')) {
    return resolveMaxMtn(entry.Command.substring('start_mtn '.length).trim(), depth + 1);
  }
  return resolved;
}

function motionShouldLoop(group, entry) {
  if (entry?.FileLoop !== undefined) return Boolean(entry.FileLoop);
  if (entry?.WrapMode !== undefined) return Number(entry.WrapMode) === 1;
  // Idle groups are the only implicit looping category. Other groups must
  // remain one-shot unless the model explicitly marks the entry as looping.
  return /^idle(?:#\d+)?$/i.test(group);
}

// --- Central motion gateway ---

function playMotion(group, index, priority) {
  if (!currentModel) return;
  group = findMotionGroup(group);
  if (disabledMotionGroups.has(group)) {
    console.log(`[motion] playMotion ${group} — skipped (group disabled)`);
    return;
  }
  if (index === undefined) {
    index = selectMotionIndex(group);
    if (index === undefined) {
      console.log(`[motion] playMotion ${group} — no eligible motion found`);
      return;
    }
  } else if (!isMotionEligible(group, index, motionEntryMap[group]?.[index])) {
    console.log(`[motion] playMotion ${group}:${index} — not eligible`);
    return;
  }
  const entry = motionEntryMap[group]?.[index];

  // Execute Command
  if (entry?.Command) executeCommand(entry.Command);

  // Apply VarFloat actions
  if (entry?.VarFloats) applyVarFloatActions(entry);

  // Apply Intimacy bonus
  if (entry && intimacyConfig) applyIntimacyBonus(entry);

  // Track in playedMotions
  playedMotions.add(`${group}:${index}`);

  // Queue NextMtn
  pendingNextMtn = entry?.NextMtn || motionNextMap[group]?.[index] || null;

  // Show speech bubble
  if (entry?.Text) showSpeechBubble(entry.Text, entry.TextDelay, entry.TextDuration);

  // Choices UI disabled for now
  // if (entry?.Choices && entry.Choices.length > 0) showChoicesUI(entry.Choices);

  // Reset interaction time
  lastInteractionTime = Date.now();

  // Command-only entry (no File)
  if (entry && !entry.File) {
    console.log(`[motion] playMotion ${group}:${index} — command-only (no File)`);
    // There is no motionFinish event for command-only entries, so complete
    // their post-command phase synchronously before following NextMtn.
    if (entry.PostCommand) executeCommand(entry.PostCommand);
    // Follow NextMtn chain immediately for command-only entries
    if (pendingNextMtn) {
      const nextMtn = pendingNextMtn;
      pendingNextMtn = null;
      const resolved = resolveMotionRef(nextMtn);
      const [nextGroup, nextIdxStr] = resolved.split(':');
      playMotion(nextGroup, nextIdxStr !== undefined ? parseInt(nextIdxStr) : undefined);
    }
    return;
  }

  // Use entry Priority if available
  const motionPriority = priority ?? (entry?.Priority ?? 2);
  const shouldLoop = motionShouldLoop(group, entry);

  console.log(`[motion] playMotion ${group}:${index} priority=${motionPriority}`);
  // Pass loop explicitly because the engine otherwise falls back to the
  // motion file's Meta.Loop value, which is true for many one-shot clips.
  currentModel.motion(group, index, motionPriority, { loop: shouldLoop });
}

// Weighted random selection with VarFloat/Intimacy/PreMtn filtering
function selectMotionIndex(group) {
  const entries = modelMotions[group];
  if (!entries || !Array.isArray(entries)) return undefined;
  const eligible = [];
  const weights = [];
  for (let i = 0; i < entries.length; i++) {
    if (!isMotionEligible(group, i, entries[i])) continue;
    eligible.push(i);
    weights.push(entries[i].Weight ?? 1);
  }
  if (eligible.length === 0) return undefined;
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < eligible.length; i++) {
    r -= weights[i];
    if (r <= 0) return eligible[i];
  }
  return eligible[eligible.length - 1];
}

function isMotionEligible(group, index, entry) {
  if (!entry) return true;
  if (entry.Enabled === false) return false;
  if (entry.VarFloats && !checkVarFloatConditions(entry)) return false;
  if (intimacyConfig && !checkIntimacyConditions(entry)) return false;
  if (entry.PreMtn) {
    const preRef = resolveMotionRef(entry.PreMtn);
    if (!playedMotions.has(preRef)) return false;
  }
  return true;
}

// Cubism's getParameterIndex expects a CubismId handle, not a JavaScript
// string. Resolve against the model's registered IDs to avoid creating a
// synthetic missing parameter for every controller lookup.
function getParameterIndexById(coreModel, parameterId) {
  if (!coreModel || !parameterId || typeof coreModel.getParameterId !== 'function') return -1;
  const count = coreModel.getParameterCount();
  for (let index = 0; index < count; index++) {
    const id = coreModel.getParameterId(index);
    const value = id?.getString?.();
    const text = typeof value === 'string' ? value : value?.s;
    if (text === parameterId) return index;
  }
  return -1;
}

// --- VarFloats system ---

function checkVarFloatConditions(entry) {
  if (!entry.VarFloats) return true;
  for (const vf of entry.VarFloats) {
    if (vf.Type !== 1) continue; // Type 1 = condition
    const name = vf.Name;
    const code = vf.Code || '';
    let value;
    if (name && name.startsWith('@') && currentModel) {
      const paramId = name.substring(1);
      const cm = currentModel.internalModel.coreModel;
      const idx = getParameterIndexById(cm, paramId);
      const count = cm.getParameterCount();
      value = idx >= 0 && idx < count ? cm.getParameterValueByIndex(idx) : 0;
    } else {
      value = varStore[name] ?? 0;
    }
    const parts = code.split(/\s+/);
    const op = parts[0].toLowerCase();
    const target = parseFloat(parts[1]) || 0;
    if (op === 'equal' && value !== target) return false;
    if (op === 'not_equal' && value === target) return false;
    if ((op === 'greater' || op === 'upper') && value <= target) return false;
    if ((op === 'less' || op === 'lower') && value >= target) return false;
    if ((op === 'greater_equal' || op === 'upper_equal') && value < target) return false;
    if ((op === 'less_equal' || op === 'lower_equal') && value > target) return false;
  }
  return true;
}

function applyVarFloatActions(entry) {
  if (!entry.VarFloats) return;
  for (const vf of entry.VarFloats) {
    if (vf.Type !== 2) continue; // Type 2 = action
    const name = vf.Name;
    const code = vf.Code || '';
    const parts = code.split(/\s+/);
    const op = parts[0];
    const target = parseFloat(parts[1]) || 0;
    if (name && name.startsWith('@') && currentModel) {
      const paramId = name.substring(1);
      const cm = currentModel.internalModel.coreModel;
      const idx = getParameterIndexById(cm, paramId);
      const count = cm.getParameterCount();
      if (idx >= 0 && idx < count) {
        if (op === 'assign') cm.setParameterValueByIndex(idx, target);
        else if (op === 'add') cm.setParameterValueByIndex(idx, cm.getParameterValueByIndex(idx) + target);
      }
    } else {
      if (op === 'assign') varStore[name] = target;
      else if (op === 'add') varStore[name] = (varStore[name] ?? 0) + target;
    }
  }
}

// --- Intimacy system ---

function checkIntimacyConditions(entry) {
  const intim = entry.Intimacy;
  if (!intim || typeof intim !== 'object') return true;
  if (intim.Min !== undefined && intimacyValue < intim.Min) return false;
  if (intim.Max !== undefined && intimacyValue > intim.Max) return false;
  if (intim.Equal !== undefined && intimacyValue !== intim.Equal) return false;
  return true;
}

function applyIntimacyBonus(entry) {
  if (!intimacyConfig) return;
  const intim = entry.Intimacy;
  const bonus = intim?.Bonus ?? 0;
  if (bonus === 0) return;
  intimacyValue = Math.max(intimacyConfig.minValue, Math.min(intimacyConfig.maxValue, intimacyValue + bonus));
  invoke('set_setting', { key: `intimacy:${currentModelPath}`, value: String(intimacyValue) }).catch(() => {});
  console.log(`[intimacy] ${bonus > 0 ? '+' : ''}${bonus} → ${intimacyValue}`);
}

// --- Command system ---

function executeCommand(cmdString) {
  if (!cmdString) return;
  const commands = cmdString.split(';');
  for (const cmd of commands) {
    const trimmed = cmd.trim();
    if (trimmed) executeOneCommand(trimmed);
  }
}

function resolveCommandNumber(rawValue) {
  if (typeof rawValue !== 'string') {
    return Number.isFinite(rawValue) ? rawValue : 0;
  }
  const value = rawValue.trim();
  if (value.startsWith('$')) {
    const stored = varStore[value.substring(1)];
    return Number.isFinite(stored) ? stored : 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function executeOneCommand(cmd) {
  if (!currentModel) return;
  const parts = cmd.split(/\s+/);
  const verb = parts[0];
  console.log(`[cmd] ${cmd}`);

  switch (verb) {
    case 'parameters': {
      const action = parts[1];
      const id = parts[2];
      const cm = currentModel.internalModel.coreModel;
      const paramCount = cm.getParameterCount();
      if (action === 'lock' && id) {
        const value = resolveCommandNumber(parts[3]);
        const duration = parts[4] ? resolveCommandNumber(parts[4]) : 0;
        const idx = getParameterIndexById(cm, id);
        if (idx >= 0 && idx < paramCount) {
          lockedParams[id] = { paramIndex: idx, value, startTime: performance.now(), duration };
        }
      } else if (action === 'unlock' && id) {
        for (const pid of id.split(',')) delete lockedParams[pid.trim()];
      } else if (action === 'set' && id) {
        const value = resolveCommandNumber(parts[3]);
        const idx = getParameterIndexById(cm, id);
        if (idx >= 0 && idx < paramCount) cm.setParameterValueByIndex(idx, value);
      }
      break;
    }
    case 'start_mtn': {
      const ref = parts.slice(1).join(' ').trim();
      if (ref) {
        const resolved = resolveMotionRef(ref);
        const [g, idxStr] = resolved.split(':');
        playMotion(g, idxStr !== undefined ? parseInt(idxStr) : undefined);
      }
      break;
    }
    case 'stop_mtn': {
      currentModel.internalModel.motionManager.stopAllMotions();
      break;
    }
    case 'mouse_tracking': {
      const enable = parts[1] !== 'disable';
      mouseTracking = enable;
      currentModel.automator.autoFocus = enable;
      if (!enable) currentModel.internalModel.focusController.focus(0, 0);
      break;
    }
    case 'eye_blink': {
      const enable = parts[1] !== 'disable';
      const im = currentModel.internalModel;
      if (!enable) {
        if (im.eyeBlink && !eyeBlinkSave) {
          eyeBlinkSave = im.eyeBlink;
          im.eyeBlink = null;
        }
      } else if (eyeBlinkSave) {
        im.eyeBlink = eyeBlinkSave;
        eyeBlinkSave = null;
      }
      break;
    }
    case 'physics': {
      const enable = parts[1] !== 'disable';
      const im = currentModel.internalModel;
      if (!enable) {
        if (im.physics && !physicsSave) {
          physicsSave = im.physics;
          im.physics = null;
        }
      } else if (physicsSave) {
        im.physics = physicsSave;
        physicsSave = null;
      }
      break;
    }
    case 'motions': {
      const action = parts[1];
      const group = parts[2];
      if (group) {
        if (action === 'disable') disabledMotionGroups.add(group);
        else if (action === 'enable') disabledMotionGroups.delete(group);
      }
      break;
    }
    case 'param_hit': {
      const action = parts[1];
      const ids = parts.slice(2).join(' ').split(',').map(s => s.trim());
      for (const id of ids) {
        if (action === 'disable') disabledParamHitItems.add(id);
        else if (action === 'enable') disabledParamHitItems.delete(id);
      }
      break;
    }
    case 'parts': {
      const action = parts[1];
      const partId = parts[2];
      const value = parseFloat(parts[3]);
      if (!partId || isNaN(value)) break;
      const cm = currentModel.internalModel.coreModel;
      const partCount = cm.getPartCount();
      const idx = cm.getPartIndex(partId);
      if (idx < partCount) {
        cm.setPartOpacityByIndex(idx, value);
        if (action === 'lock') lockedParts[partId] = { index: idx, value };
        else if (action === 'unlock') delete lockedParts[partId];
      }
      break;
    }
    case 'artmesh_opacities': {
      console.log(`[cmd] artmesh_opacities deferred: ${parts.slice(1).join(' ')}`);
      break;
    }
    case 'mute_sound': {
      soundMuted = parts[1] === '1';
      SoundManager.volume = soundMuted ? 0 : 1;
      break;
    }
    case 'stop_sound': {
      console.log(`[cmd] stop_sound: ${parts.slice(1).join(' ')}`);
      break;
    }
    case 'open_url': {
      console.log(`[cmd] open_url ignored (security): ${parts.slice(1).join(' ')}`);
      break;
    }
    case 'replace_tex': {
      console.log(`[cmd] replace_tex deferred: ${parts.slice(1).join(' ')}`);
      break;
    }
    default:
      console.log(`[cmd] unknown command: ${cmd}`);
  }
}

// --- Speech bubble ---

function showSpeechBubble(text, delay, duration) {
  clearTimeout(speechBubbleTimeout);
  const show = () => {
    speechBubble.textContent = text;
    speechBubble.style.display = 'block';
    if (currentModel) {
      const bounds = currentModel.getBounds();
      speechBubble.style.left = (bounds.x + bounds.width / 2) + 'px';
      speechBubble.style.bottom = (window.innerHeight - bounds.y + 16) + 'px';
    }
    speechBubbleTimeout = setTimeout(() => {
      speechBubble.style.display = 'none';
    }, duration || 5000);
  };
  if (delay && delay > 0) {
    speechBubbleTimeout = setTimeout(show, delay);
  } else {
    show();
  }
}

// --- Choices UI ---

function showChoicesUI(choices) {
  choicesContainer.innerHTML = '';
  setFullInputRegion();
  for (const choice of choices) {
    const item = document.createElement('div');
    item.className = 'choices-item';
    item.textContent = choice.Text || '';
    item.addEventListener('click', () => {
      choicesContainer.style.display = 'none';
      updateInputRegion();
      if (choice.NextMtn) {
        const resolved = resolveMotionRef(choice.NextMtn);
        const [g, idxStr] = resolved.split(':');
        playMotion(g, idxStr !== undefined ? parseInt(idxStr) : undefined);
      }
    });
    choicesContainer.appendChild(item);
  }
  // Position near model center
  if (currentModel) {
    const bounds = currentModel.getBounds();
    choicesContainer.style.left = (bounds.x + bounds.width / 2) + 'px';
    choicesContainer.style.top = (bounds.y + bounds.height / 2) + 'px';
  }
  choicesContainer.style.display = 'block';
}

// --- Leave groups (timed idle) ---

function parseLeaveGroups(motions) {
  leaveGroups = [];
  for (const groupName of Object.keys(motions)) {
    const match = groupName.match(/^Leave(\d+)_(\d+)_(\d+)$/);
    if (match) {
      leaveGroups.push({
        group: groupName,
        interval: parseInt(match[1]),
        minDuration: parseInt(match[2]),
        maxDuration: parseInt(match[3]),
      });
    }
  }
}

function startLeaveTimer() {
  if (leaveTimeout) clearInterval(leaveTimeout);
  lastInteractionTime = Date.now();
  if (leaveGroups.length === 0) return;
  leaveTimeout = setInterval(checkLeaveTimers, 5000);
}

function checkLeaveTimers() {
  if (!currentModel || leaveActive) return;
  const idle = (Date.now() - lastInteractionTime) / 1000;
  for (const lg of leaveGroups) {
    if (idle >= lg.interval) {
      console.log(`[motion] Leave timer fired: ${lg.group} (idle ${idle.toFixed(0)}s >= ${lg.interval}s)`);
      leaveActive = true;
      playMotion(lg.group, undefined, 1);
      const dur = lg.minDuration + Math.random() * (lg.maxDuration - lg.minDuration);
      setTimeout(() => { leaveActive = false; }, dur * 1000);
      break;
    }
  }
}

// --- Drag release handlers ---

function triggerParamHitMotions(states, property, label) {
  const refs = new Map();
  for (const state of states) {
    const ref = state.item?.[property] || state[property];
    if (!ref) continue;
    const priority = state.item?.lowPriority ? 1 : undefined;
    if (!refs.has(ref) || priority === 1) refs.set(ref, priority);
  }
  for (const [ref, priority] of refs) {
    console.log(`[motion] drag ${label}: ${ref}`);
    playMotionRef(ref, priority);
  }
}

function handleParamHitRelease() {
  if (!paramDragging || !currentModel) return;
  const { hitArea, items } = paramDragging;
  const coreModel = currentModel.internalModel.coreModel;
  const endStates = [];
  for (const state of items) {
    const { item, paramIndex, currentValue, startValue } = state;
    const { min, max } = getParamHitBounds(item, coreModel, paramIndex);
    const moved = Math.abs(currentValue - startValue);
    console.log(`[touch] ParamHit release on ${hitArea}: ${item.paramId}=${currentValue.toFixed(3)}, moved=${moved.toFixed(3)}, range=[${min},${max}]`);

    // LockParam is the persistence switch. ReleaseType is only metadata for
    // the return curve and must not decide whether a return happens.
    if (item.lockParam) {
      paramReleaseAnims = paramReleaseAnims.filter(anim => anim.paramIndex !== paramIndex);
      paramHitLocks[paramIndex] = { value: currentValue };
    } else {
      delete paramHitLocks[paramIndex];
      const speed = item.releaseDuration > 0 ? 1 / (item.releaseDuration / 16.67) : 0.05;
      paramReleaseAnims.push({
        paramIndex,
        from: currentValue,
        target: startValue,
        releaseType: item.releaseType,
        speed,
        t: 0,
      });
    }

    // EndMtn is the non-boundary release action. A MaxMtn crossing already
    // consumed the interaction and must not also run EndMtn.
    if (!state.maxReached && !state.minReached && item.endMtn) endStates.push(state);
  }
  triggerParamHitMotions(endStates, 'endMtn', 'EndMtn');
  paramDragging = null;
  updateInputRegion();
}

function handleDragRelease() {
  dragging = false;
  dragHitNames = [];
  if (!lockModel) savePosition();
  updateInputRegion();
}

// --- Model loading ---

async function loadModel(modelPath) {
  // Reset drag state so stale flags don't block taps on the new model
  dragging = false;
  dragMoved = false;
  playingStart = false;
  paramDragging = null;
  paramReleaseAnims = [];
  paramHitLocks = {};
  paramHitItems = [];
  paramLoopItems = [];
  // Reset feature state
  motionEntryMap = {};
  varStore = {};
  lockedParams = {};
  lockedParts = {};
  disabledMotionGroups = new Set();
  disabledParamHitItems = new Set();
  currentMotionInfo = null;
  playedMotions = new Set();
  leaveGroups = [];
  if (leaveTimeout) { clearInterval(leaveTimeout); leaveTimeout = null; }
  leaveActive = false;
  keyTriggerItems = [];
  paramTriggerItems = [];
  paramTriggerLastValues = {};
  clearTimeout(speechBubbleTimeout);
  speechBubble.style.display = 'none';
  choicesContainer.style.display = 'none';
  extraMotionEnabled = false;
  eyeBlinkSave = null;
  physicsSave = null;
  soundMuted = false;
  intimacyConfig = null;
  intimacyValue = 50;

  if (currentModel) {
    app.ticker.remove(drawHitAreas);
    hitAreaGfx.clear();
    for (const label of hitAreaLabels) label.visible = false;
    app.stage.removeChild(currentModel);
    // Evict textures from PixiJS asset cache before destroying, otherwise
    // Assets.load() returns stale destroyed textures for the same URLs.
    const modelKeys = [...Assets.cache._cache.keys()].filter(k => k.startsWith('model://'));
    for (const key of modelKeys) {
      Assets.cache.remove(key);
    }
    currentModel.destroy();
    currentModel = null;
  }

  try {
    const model = await Live2DModel.from(modelPath, {
      autoHitTest: false,
      autoFocus: mouseTracking,
    });

    // Guard against textures with destroyed/missing source — the library
    // accesses texture.source._gpuData without null-checking, which crashes
    // if a texture source was garbage-collected or never fully loaded.
    model.textures = model.textures.filter(t => t?.source);
    const origRender = model.renderLive2D;
    model.renderLive2D = (renderer) => {
      for (const tex of model.textures) {
        if (!tex?.source) return;
      }
      origRender(renderer);
    };

    // Load saved position/scale from config
    const config = await invoke('get_config');

    if (config.model_scale != null) {
      model.scale.set(config.model_scale);
    } else {
      // Default: fit model to ~30% of screen
      const scaleX = app.screen.width / model.width;
      const scaleY = app.screen.height / model.height;
      model.scale.set(Math.min(scaleX, scaleY) * 0.3);
    }

    model.anchor.set(0.5, 0.5);

    if (config.model_x != null && config.model_y != null) {
      model.x = config.model_x;
      model.y = config.model_y;
    } else {
      model.x = app.screen.width / 2;
      model.y = app.screen.height / 2;
    }
    currentModel = model;
    clampModelPosition();

    // Enable interaction for drag
    model.eventMode = 'static';
    model.cursor = 'pointer';

    // Drag start (left button only)
    model.on('pointerdown', (e) => {
      if (e.button !== 0) return;
      lastInteractionTime = Date.now();

      // Check for ParamHit drag areas first
      if (paramHitItems.length > 0) {
        const hitNames = sortHitNames(model.hitTest(e.global.x, e.global.y));
        for (const name of hitNames) {
          const items = paramHitItems.filter(item =>
            item.hitArea === name && item.paramIndex >= 0 && !disabledParamHitItems.has(item.hitArea),
          );
          if (items.length > 0) {
            console.log(`[touch] pointerdown on ParamHit area: ${name} (params: ${items.map(item => item.paramId).join(', ')})`);
            const coreModel = model.internalModel.coreModel;
            paramDragging = {
              hitArea: name,
              items: items.map(item => {
                const startValue = coreModel.getParameterValueByIndex(item.paramIndex);
                delete paramHitLocks[item.paramIndex];
                return {
                  item,
                  startPos: item.axis === 0 ? e.global.x : e.global.y,
                  lastPos: item.axis === 0 ? e.global.x : e.global.y,
                  paramIndex: item.paramIndex,
                  startValue,
                  currentValue: startValue,
                  targetValue: startValue,
                  pressStartTime: performance.now(),
                  lastUpdateTime: performance.now(),
                  maxReached: false,
                  minReached: false,
                };
              }),
              hasMoved: false,
            };
            const indexes = new Set(items.map(item => item.paramIndex));
            paramReleaseAnims = paramReleaseAnims.filter(anim => !indexes.has(anim.paramIndex));
            dragMoved = false;
            dragStart.x = e.global.x;
            dragStart.y = e.global.y;
            setFullInputRegion();
            triggerParamHitMotions(paramDragging.items, 'beginMtn', 'BeginMtn');
            return;
          }
        }
      }

      // Start an explicit action/state route for non-ParamHit drag areas.
      dragHitNames = sortHitNames(model.hitTest(e.global.x, e.global.y));
      dragStart.x = e.global.x;
      dragStart.y = e.global.y;
      triggerDragMotions();

      console.log(`[touch] pointerdown — drag hit areas: [${dragHitNames.join(', ')}]`);
      dragging = true;
      dragMoved = false;
      dragOffset.x = e.global.x - model.x;
      dragOffset.y = e.global.y - model.y;
      setFullInputRegion();
    });

    // Normalize both Cubism 3 and legacy model metadata before routing input.
    const rawJson = model.internalModel.settings.json;
    const metadata = normalizeModelMetadata(rawJson);
    modelMotions = metadata.motions;
    buildMotionMaps(modelMotions);

    // Load custom motion overrides from settings
    currentModelPath = modelPath.replace('model://localhost/', '');
    let customJsonStr = null;
    try {
      customJsonStr = await invoke('get_custom_motions', { path: currentModelPath });
    } catch {}
    buildHitMotionMap(metadata.hitAreas, customJsonStr);
    pendingNextMtn = null;

    // Parse controllers
    const controllers = metadata.controllers;

    // Parse ParamHit controller items (drag-to-control-parameter hit areas)
    // Falls back to legacy top-level HitParams when Controllers.ParamHit is absent
    const paramHitConfig = controllers.ParamHit || {};
    const paramHitEnabled = paramHitConfig.Enabled !== false;
    const paramHitRawItems = paramHitEnabled
      ? paramHitConfig.Items
      : [];
    // Legacy fallback: top-level HitParams (older model format)
    const hitParamItems = paramHitRawItems.length > 0
      ? paramHitRawItems
      : metadata.hitParams;
    {
      const coreModel = model.internalModel.coreModel;
      const paramCount = coreModel.getParameterCount();
      for (const item of hitParamItems) {
        if (item.Enabled === false) continue;
        const paramId = item.Id;
        const rawIdx = getParameterIndexById(coreModel, paramId);
        const paramIndex = rawIdx >= 0 && rawIdx < paramCount ? rawIdx : -1;
        paramHitItems.push({
          hitArea: item.HitArea,
          paramId,
          paramIndex, // -1 if parameter doesn't exist in moc3
          axis: finiteNumber(item.Axis, 0),
          factor: finiteNumber(item.Factor, 0.04),
          type: finiteNumber(item.Type, 0),
          weight: finiteNumber(item.Weight, 1),
          minValue: item.MinValue,
          maxValue: item.MaxValue,
          releaseType: finiteNumber(item.ReleaseType, 0),
          releaseDuration: finiteNumber(item.Release, 500),
          lockParam: item.LockParam ?? false,
          lowPriority: item.LowPriority === true || item.LowPriority === 1 || item.LowPriority === 'true',
          maxMtn: item.MaxMtn ? resolveMaxMtn(item.MaxMtn) : null,
          minMtn: item.MinMtn ? resolveMotionRef(item.MinMtn) : null,
          beginMtn: item.BeginMtn ? resolveMotionRef(item.BeginMtn) : null,
          endMtn: item.EndMtn ? resolveMotionRef(item.EndMtn) : null,
        });
      }
    }

    // Parse ParamLoop controller items (auto-oscillating parameters)
    // Falls back to legacy top-level LoopParams when Controllers.ParamLoop is absent
    const paramLoopConfig = controllers.ParamLoop || {};
    const paramLoopEnabled = paramLoopConfig.Enabled !== false;
    const paramLoopRawItems = paramLoopEnabled
      ? paramLoopConfig.Items
      : [];
    const loopParamItems = paramLoopRawItems.length > 0
      ? paramLoopRawItems
      : metadata.loopParams;
    {
      const coreModel = model.internalModel.coreModel;
      const loopParamCount = coreModel.getParameterCount();
      for (const item of loopParamItems) {
        if (item.Enabled === false) continue;
        // Support both Id (single) and Ids (array) formats
        const ids = item.Ids || (item.Id ? [item.Id] : []);
        for (const paramId of ids) {
          if (!paramId) continue;
          const rawLoopIdx = getParameterIndexById(coreModel, paramId);
          const paramIndex = rawLoopIdx >= 0 && rawLoopIdx < loopParamCount ? rawLoopIdx : -1;
          if (paramIndex < 0) continue;
          paramLoopItems.push({
            paramIndex,
            duration: item.Duration || 3000, // oscillation period in ms
            type: item.Type ?? 0,            // 0 = sine, 1 = sawtooth
            blendMode: item.BlendMode ?? 0,  // 0 = overwrite, 1 = additive
            startTime: performance.now(),
          });
        }
      }
    }

    // Parse KeyTrigger controller
    const keyTriggerConfig = controllers.KeyTrigger || {};
    if (keyTriggerConfig.Enabled !== false) {
      const items = keyTriggerConfig.Items || [];
      for (const item of items) {
        if (item.Enabled === false) continue;
        keyTriggerItems.push({
          keyCode: item.Input,
          downMtn: item.DownMtn ? resolveMotionRef(item.DownMtn) : null,
        });
      }
    }

    // Parse ParamTrigger controller
    const paramTriggerConfig = controllers.ParamTrigger || {};
    if (paramTriggerConfig.Enabled !== false) {
      const ptItems = paramTriggerConfig.Items || [];
      const coreModel = model.internalModel.coreModel;
      const paramCount = coreModel.getParameterCount();
      for (const item of ptItems) {
        if (item.Enabled === false) continue;
        const paramId = item.Id;
        if (!paramId) continue;
        const rawIdx = getParameterIndexById(coreModel, paramId);
        const paramIndex = rawIdx >= 0 && rawIdx < paramCount ? rawIdx : -1;
        if (paramIndex < 0) continue;
        paramTriggerItems.push({
          paramId,
          paramIndex,
          triggers: (item.Items || []).map(t => ({
            value: t.Value ?? 0,
            motion: t.Motion ? resolveMotionRef(t.Motion) : null,
            direction: t.Direction ?? 0,
          })),
        });
        paramTriggerLastValues[paramId] = coreModel.getParameterValueByIndex(paramIndex);
      }
    }

    // Parse PartOpacity controller
    const partOpacityConfig = controllers.PartOpacity || {};
    if (partOpacityConfig.Enabled !== false) {
      const poItems = partOpacityConfig.Items || [];
      const coreModel = model.internalModel.coreModel;
      const partCount = coreModel.getPartCount();
      for (const item of poItems) {
        if (item.Enabled === false) continue;
        const value = item.Value ?? 1;
        const ids = item.Ids || (item.Id ? [item.Id] : []);
        for (const partId of ids) {
          if (!partId) continue;
          const idx = coreModel.getPartIndex(partId);
          if (idx < partCount) {
            coreModel.setPartOpacityByIndex(idx, value);
            if (item.Lock) lockedParts[partId] = { index: idx, value };
          }
        }
      }
    }

    // Parse ParamValue controller
    const paramValueConfig = controllers.ParamValue || {};
    if (paramValueConfig.Enabled !== false) {
      const pvItems = paramValueConfig.Items || [];
      const coreModel = model.internalModel.coreModel;
      const paramCount = coreModel.getParameterCount();
      for (const item of pvItems) {
        if (item.Enabled === false) continue;
        const value = item.Value ?? 0;
        const ids = item.Ids || (item.Id ? [item.Id] : []);
        for (const paramId of ids) {
          if (!paramId) continue;
          const rawIdx = getParameterIndexById(coreModel, paramId);
          if (rawIdx >= 0 && rawIdx < paramCount) {
            coreModel.setParameterValueByIndex(rawIdx, value);
            lockedParams[paramId] = { paramIndex: rawIdx, value, startTime: performance.now(), duration: 0 };
          }
        }
      }
    }

    // Parse ExtraMotion controller
    const extraMotionConfig = controllers.ExtraMotion || {};
    extraMotionEnabled = extraMotionConfig.Enabled === true || metadata.extraMotion === true;

    // Parse IntimacySystem controller
    const intimacySystem = controllers.IntimacySystem || metadata.intimacyParam;
    if (intimacySystem.MaxValue !== undefined || intimacySystem.maxValue !== undefined) {
      intimacyConfig = {
        initValue: intimacySystem.InitValue ?? intimacySystem.initValue ?? 50,
        minValue: intimacySystem.MinValue ?? intimacySystem.minValue ?? 0,
        maxValue: intimacySystem.MaxValue ?? intimacySystem.maxValue ?? 100,
      };
      // Try to load persisted intimacy value
      try {
        const saved = await invoke('get_setting', { key: `intimacy:${currentModelPath}` });
        if (saved !== null && saved !== undefined) intimacyValue = parseFloat(saved);
        else intimacyValue = intimacyConfig.initValue;
      } catch {
        intimacyValue = intimacyConfig.initValue;
      }
    }

    // Parse Leave groups for timed idle
    parseLeaveGroups(modelMotions);

    // Override motionManager.update to apply paramHit values at the right
    // point in the update cycle (after motions, before physics/coreModel.update)
    const origMotionUpdate = model.internalModel.motionManager.update;
    model.internalModel.motionManager.update = function (...args) {
      origMotionUpdate.apply(this, args);
      const cm = model.internalModel.coreModel;
      if (paramDragging) {
        const now = performance.now();
        for (const state of paramDragging.items) {
          if (state.item.type === 2) {
            const elapsed = Math.max(0, now - state.lastUpdateTime) / 1000;
            state.lastUpdateTime = now;
            if (elapsed > 0) {
              paramDragging.hasMoved = true;
              updateParamHitState(
                state,
                state.targetValue + state.item.factor * elapsed,
                cm,
              );
            }
          }
          cm.setParameterValueByIndex(state.paramIndex, state.currentValue);
        }
      }
      for (const anim of paramReleaseAnims) {
        anim.t = Math.min(1, anim.t + (anim.speed || 0.05));
        const v = anim.from + (anim.target - anim.from) * applyReleaseCurve(anim.t, anim.releaseType);
        cm.setParameterValueByIndex(anim.paramIndex, v);
      }
      paramReleaseAnims = paramReleaseAnims.filter(a => a.t < 1);

      // ParamHit LockParam persists after pointer release and must win over
      // idle motions, physics inputs, and other controller writes.
      for (const [paramIndex, lock] of Object.entries(paramHitLocks)) {
        cm.setParameterValueByIndex(Number(paramIndex), lock.value);
      }

      // Enforce locked params (from commands + ParamValue controller)
      const nowMs = performance.now();
      for (const [id, lock] of Object.entries(lockedParams)) {
        if (lock.duration > 0 && nowMs - lock.startTime > lock.duration) {
          delete lockedParams[id];
          continue;
        }
        cm.setParameterValueByIndex(lock.paramIndex, lock.value);
      }

      // Enforce locked parts
      for (const [, lock] of Object.entries(lockedParts)) {
        cm.setPartOpacityByIndex(lock.index, lock.value);
      }

      // ParamTrigger: detect threshold crossings
      for (const pt of paramTriggerItems) {
        const curVal = cm.getParameterValueByIndex(pt.paramIndex);
        const prevVal = paramTriggerLastValues[pt.paramId] ?? curVal;
        for (const trigger of pt.triggers) {
          const increasing = prevVal < trigger.value && curVal >= trigger.value;
          const decreasing = prevVal > trigger.value && curVal <= trigger.value;
          const crossed = (trigger.direction === 0 && (increasing || decreasing)) ||
                          (trigger.direction === 1 && increasing) ||
                          (trigger.direction === 2 && decreasing);
          if (crossed && trigger.motion) {
            const [g, idxStr] = trigger.motion.split(':');
            console.log(`[trigger] ParamTrigger ${pt.paramId} crossed ${trigger.value}: ${trigger.motion}`);
            playMotion(g, idxStr !== undefined ? parseInt(idxStr) : undefined);
          }
        }
        paramTriggerLastValues[pt.paramId] = curVal;
      }

      // ParamLoop: auto-oscillate parameters between min and max
      if (paramLoopItems.length > 0) {
        const now = performance.now();
        for (const loop of paramLoopItems) {
          // Skip if this param is being dragged with LockParam
          if (paramDragging?.items.some(state =>
            state.item.lockParam && state.paramIndex === loop.paramIndex,
          )) continue;
          const elapsed = now - loop.startTime;
          const phase = (elapsed % loop.duration) / loop.duration; // 0..1
          const min = cm.getParameterMinimumValue(loop.paramIndex);
          const max = cm.getParameterMaximumValue(loop.paramIndex);
          const mid = (min + max) / 2;
          const amp = (max - min) / 2;
          let value;
          if (loop.type === 1) {
            // Sawtooth: linear ramp min→max→min
            value = phase < 0.5
              ? min + (max - min) * (phase * 2)
              : max - (max - min) * ((phase - 0.5) * 2);
          } else {
            // Sine wave (type 0): smooth oscillation
            value = mid + amp * Math.sin(phase * Math.PI * 2);
          }
          if (loop.blendMode === 1) {
            // Additive: add to current value
            const cur = cm.getParameterValueByIndex(loop.paramIndex);
            cm.setParameterValueByIndex(loop.paramIndex, cur + (value - mid));
          } else {
            cm.setParameterValueByIndex(loop.paramIndex, value);
          }
        }
      }
    };

    // Set loop flag and FadeIn/FadeOut on motions
    model.internalModel.motionManager.on('motionLoaded', (group, index, motion) => {
      const entry = motionEntryMap[group]?.[index];
      const shouldLoop = motionShouldLoop(group, entry);
      if (typeof motion.setLoop === 'function') {
        // Converted model files often declare Meta.Loop=true for every clip.
        // The model metadata is the authoritative per-action loop policy.
        motion.setLoop(shouldLoop);
      }
      if (shouldLoop && typeof motion.setLoopFadeIn === 'function') {
        motion.setLoopFadeIn(false);
      }
      if (entry?.FadeIn !== undefined) motion.setFadeInTime(entry.FadeIn / 1000);
      if (entry?.FadeOut !== undefined) motion.setFadeOutTime(entry.FadeOut / 1000);
    });

    // Track current motion via motionStart event
    model.internalModel.motionManager.on('motionStart', (group, index) => {
      const entry = motionEntryMap[group]?.[index];
      currentMotionInfo = { group, index, entry };
    });

    // NextMtn chaining + PostCommand: when a motion finishes
    model.internalModel.motionManager.on('motionFinish', () => {
      playingStart = false;

      // Execute PostCommand from the finished motion
      if (currentMotionInfo?.entry?.PostCommand) {
        executeCommand(currentMotionInfo.entry.PostCommand);
      }
      currentMotionInfo = null;

      if (pendingNextMtn) {
        const mtn = pendingNextMtn;
        pendingNextMtn = null;
        const resolved = resolveMotionRef(mtn);
        const [group, idxStr] = resolved.split(':');
        playMotion(group, idxStr !== undefined ? parseInt(idxStr) : undefined);
      } else if (idleGroup) {
        playMotion(idleGroup, undefined, 1);
        // ExtraMotion: play layered idles
        if (extraMotionEnabled && currentModel?.parallelMotion) {
          const extraMotions = [];
          for (let n = 1; modelMotions[`Idle#${n}`]; n++) {
            const idx = selectMotionIndex(`Idle#${n}`) ?? 0;
            extraMotions.push({ group: `Idle#${n}`, index: idx, priority: 1 });
          }
          if (extraMotions.length > 0) {
            currentModel.parallelMotion(extraMotions).catch(() => {});
          }
        }
      }
    });

    model.on('pointertap', (e) => {
      lastInteractionTime = Date.now();
      if (e.button === 2 && !rightClickMotion) {
        console.log('[touch] pointertap — skipped (right-click motions disabled)');
        return;
      }
      if (playingStart) {
        console.log('[touch] pointertap — skipped (start animation playing)');
        playingStart = false;
        model.internalModel.motionManager.stopAllMotions();
        return;
      }
      if (!tapMotion) { console.log('[touch] pointertap — skipped (tapMotion disabled)'); return; }
      if (dragMoved) { console.log('[touch] pointertap — skipped (dragMoved)'); return; }
      const hitAreaNames = sortHitNames(model.hitTest(e.global.x, e.global.y));
      console.log(`[touch] pointertap — hit areas: [${hitAreaNames.join(', ')}]`);
      if (hitAreaNames.length === 0) {
        console.log('[touch] pointertap — no hit area at click position');
      }
      const dragHitName = hitAreaNames.find(name => isDragHitArea(name));
      if (dragHitName) {
        console.log(`[touch] ${dragHitName}: skipped (drag hit area consumed tap)`);
        return;
      }
      for (const name of hitAreaNames) {
        const mapped = hitMotionMap[name];
        // Custom override: __none__ means do nothing
        if (mapped === '__none__') { console.log(`[touch] ${name}: skipped (__none__)`); continue; }
        // Explicit mapping (from model JSON or custom override)
        if (mapped) {
          const [group, idxStr] = mapped.split(':');
          const arrayIdx = idxStr !== undefined ? parseInt(idxStr) : undefined;
          console.log(`[touch] ${name}: triggering mapped motion ${group}` + (arrayIdx !== undefined ? `:${arrayIdx}` : ''));
          playMotion(group, arrayIdx);
          return; // stop — don't trigger overlapping hit areas
        }
        // Convention fallbacks (only when no explicit mapping)
        console.log(`[touch] ${name}: no mapping, trying conventions (tap_${name}, ${name}, Tap${name})`);
        const conventions = ['tap_' + name, name, 'Tap' + name];
        const stripped = name.replace(/^Touch/i, '');
        if (stripped !== name) conventions.push(stripped.toLowerCase());
        let found = false;
        for (const g of conventions) {
          const group = findMotionGroup(g);
          if (modelMotions[group]) {
            playMotion(group);
            found = true;
            break;
          }
        }
        if (found) return;
        console.log(`[touch] ${name}: no matching motion group`);
        return; // stop — don't trigger overlapping hit areas
      }
    });

    app.stage.addChild(model);

    // Keep overlays on top
    app.stage.removeChild(hitAreaContainer);
    app.stage.addChild(hitAreaContainer);
    app.stage.removeChild(borderGfx);
    app.stage.addChild(borderGfx);

    // Redraw hit areas on each frame (drawables move with animations)
    app.ticker.add(drawHitAreas);

    showBorder = config.show_border;
    rightClickMotion = config.right_click_motion;
    showHitAreas = config.show_hit_areas;
    lockModel = config.lock_model;
    mouseTracking = config.mouse_tracking;
    model.automator.autoFocus = mouseTracking;

    updateBorder();
    updateInputRegion();

    // Detect idle and start motion groups
    const idleCandidate = findMotionGroup('Idle');
    idleGroup = modelMotions[idleCandidate] ? idleCandidate : null;

    const startCandidate = findMotionGroup('Start');
    const startGroup = modelMotions[startCandidate] ? startCandidate : null;
    if (startGroup) {
      playingStart = true;
      playMotion(startGroup, 0, 1); // priority IDLE so taps can interrupt
    } else if (idleGroup) {
      playMotion(idleGroup, undefined, 1);
    }

    // Start Leave timer
    startLeaveTimer();
  } catch (err) {
    console.error('[rive2d] Failed to load model:', err);
  }
}
