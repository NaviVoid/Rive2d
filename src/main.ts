import * as PIXI from 'pixi.js';
import { Assets } from 'pixi.js';
import { Live2DModel, Live2DPlugin, SoundManager } from 'untitled-pixi-live2d-engine';
import { AppRuntime } from './interaction/appRuntime';
import { TauriResourcePreloader } from './interaction/assetPreloader';
import { Live2DCommandRuntime } from './interaction/commandRuntime';
import { ConsoleRuntimeLogger } from './interaction/logger';
import { ModelRuntime } from './interaction/modelRuntime';
import { MotionResourceCache, type MotionResourceRoute } from './interaction/motionResourceCache';

// Expose PIXI globally for pixi-live2d-display
window.PIXI = PIXI;
PIXI.extensions.add(Live2DPlugin);

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const interactionLogger = new ConsoleRuntimeLogger('interaction');
const appRuntime = new AppRuntime(interactionLogger);
const resourcePreloader = new TauriResourcePreloader(invoke, interactionLogger);

// Forward console logs to backend log file
const logStartedAt = performance.now();
let logSequence = 0;

function formatLogValue(value) {
  if (typeof value !== 'object' || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

for (const level of ['log', 'warn', 'error']) {
  const orig = console[level];
  console[level] = (...args) => {
    const elapsed = (performance.now() - logStartedAt).toFixed(1).padStart(9, ' ');
    const stamp = `[${new Date().toISOString()} +${elapsed}ms #${String(++logSequence).padStart(5, '0')}]`;
    orig.apply(console, [stamp, ...args]);
    const msg = [stamp, ...args].map(formatLogValue).join(' ');
    invoke('js_log', { level, msg }).catch(() => {});
  };
}

function traceLog(scope, event, details = undefined) {
  const suffix = details === undefined ? '' : ` ${formatLogValue(details)}`;
  console.log(`[trace:${scope}] ${event}${suffix}`);
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
let modelRuntime = null;
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
let idleGroup = null;         // name of Idle motion group (e.g. 'Idle', 'idle')
let currentModelPath = null;
let dragging = false;
let dragMoved = false;
let dragActionActive = null;
let suppressNextTap = false;
let dragStart = { x: 0, y: 0 };
let dragOffset = { x: 0, y: 0 };
const DRAG_THRESHOLD = 4; // px — ignore micro-movements for tap detection
let interactionSequence = 0;
let dragInteractionId = null;
let lastInteractionId = null;
let motionRequestSequence = 0;
let activeLayerMotionRequests = new Map(); // { layer: requestId }
let motionCompletions = new Map(); // { requestId: completion }
let boundMotionManagers = new WeakSet();
let playingStart = false;     // true while start animation is playing
let paramHitItems = [];      // ParamHit controller items parsed from model JSON
let paramDragging = null;    // { hitArea, items: [{ item, startPos, paramIndex, startValue, currentValue }], hasMoved }
let paramReleaseAnims = [];  // parameter reset animations after drag release
let paramHitLocks = {};      // { paramIndex: { value } } — persistent ParamHit locks
let paramLoopItems = [];     // ParamLoop controller items: auto-oscillating parameters
let dragHitNames = [];       // hit area names recorded on pointerdown for drag-motion detection
let modelMotions = {};       // normalized motion groups from model metadata
let hitAreaOrder = {};       // { hitAreaName: orderValue } from HitAreas[].Order for sorting
let hitAreaActionMap = {};   // { hitAreaName: { click, press, release, enter, exit, clickableWhenInvisible } }
let pressedHitAreas = [];
let hoveredHitAreas = new Set();
let stableHitAreaBounds = {}; // Initial bounds used when an action hides its hit-area drawable
let stableModelSize = null;  // Last valid rendered model size for hidden/off-screen states
let hitAreasEnabled = true;  // Model command state, independent of drawable visibility
let positionCorrectionPending = false;

// --- Feature state ---
let motionEntryMap = {};       // { group: { index: entryObject } }
let varStore = {};             // VarFloats variable store
let lockedParams = {};         // { paramId: { paramIndex, value, startTime, duration } }
let lockedParts = {};          // { partId: { index, value } }
let disabledMotionGroups = new Set();
let disabledParamHitItems = new Set();
let commandLockedParamHitItems = new Set();
let intimacyValue = 50;
let intimacyConfig = null;     // { initValue, minValue, maxValue }
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
let motionResourceCache = null;

const live2DCommandRuntime = new Live2DCommandRuntime({
  resolveNumber(rawValue) {
    if (typeof rawValue !== 'string') return 0;
    const value = rawValue.trim();
    if (value.startsWith('$')) {
      const stored = varStore[value.substring(1)];
      return Number.isFinite(stored) ? stored : 0;
    }
    if (value.startsWith('@') && currentModel) {
      const cm = currentModel.internalModel.coreModel;
      const index = getParameterIndexById(cm, value.substring(1));
      return index >= 0 ? cm.getParameterValueByIndex(index) : 0;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  },
  lockParameter(id, value, _fadeInDuration) {
    if (!currentModel) return;
    const cm = currentModel.internalModel.coreModel;
    const index = getParameterIndexById(cm, id);
    if (index < 0 || index >= cm.getParameterCount()) return;
    // Official `parameters lock` is persistent. Its optional duration is a
    // fade-in duration, not a time-to-live for the lock.
    lockedParams[id] = { paramIndex: index, value, startTime: performance.now(), duration: 0 };
  },
  unlockParameters(ids) {
    if (ids.length === 0) {
      lockedParams = {};
      return;
    }
    for (const id of ids) delete lockedParams[id];
  },
  setParameter(id, value) {
    if (!currentModel) return;
    const cm = currentModel.internalModel.coreModel;
    const index = getParameterIndexById(cm, id);
    if (index >= 0 && index < cm.getParameterCount()) cm.setParameterValueByIndex(index, value);
  },
  startMotion(reference) {
    if (!reference) return;
    const resolved = resolveMotionRef(reference);
    const [group, index] = resolved.split(':');
    playMotion(group, index !== undefined ? parseInt(index) : undefined);
  },
  stopMotions(layer = 0) {
    if (!currentModel) return;
    if (layer <= 0) {
      currentModel.internalModel.motionManager.stopAllMotions();
      return;
    }
    currentModel.internalModel.parallelMotionManager?.[layer - 1]?.stopAllMotions();
  },
  setMouseTracking(enabled) {
    mouseTracking = enabled;
    if (!currentModel) return;
    currentModel.automator.autoFocus = enabled;
    if (!enabled) currentModel.internalModel.focusController.focus(0, 0);
  },
  setEyeBlink(enabled) {
    if (!currentModel) return;
    const internalModel = currentModel.internalModel;
    if (!enabled) {
      if (internalModel.eyeBlink && !eyeBlinkSave) {
        eyeBlinkSave = internalModel.eyeBlink;
        internalModel.eyeBlink = null;
      }
    } else if (eyeBlinkSave) {
      internalModel.eyeBlink = eyeBlinkSave;
      eyeBlinkSave = null;
    }
  },
  setPhysics(enabled) {
    if (!currentModel) return;
    const internalModel = currentModel.internalModel;
    if (!enabled) {
      if (internalModel.physics && !physicsSave) {
        physicsSave = internalModel.physics;
        internalModel.physics = null;
      }
    } else if (physicsSave) {
      internalModel.physics = physicsSave;
      physicsSave = null;
    }
  },
  setMotionGroupEnabled(group, enabled) {
    if (enabled) disabledMotionGroups.delete(group);
    else disabledMotionGroups.add(group);
  },
  setParamHitEnabled(id, enabled) {
    if (enabled) disabledParamHitItems.delete(id);
    else disabledParamHitItems.add(id);
  },
  setParamHitLocked(id, locked) {
    if (locked) commandLockedParamHitItems.add(id);
    else commandLockedParamHitItems.delete(id);
  },
  setHitAreasEnabled(enabled) {
    hitAreasEnabled = enabled;
    drawHitAreas();
  },
  setPartOpacity(id, value, locked) {
    if (!currentModel) return;
    const cm = currentModel.internalModel.coreModel;
    const index = cm.getPartIndex(id);
    if (index < 0 || index >= cm.getPartCount()) return;
    cm.setPartOpacityByIndex(index, value);
    if (locked) lockedParts[id] = { index, value };
    else delete lockedParts[id];
  },
  setSoundMuted(muted) {
    soundMuted = muted;
    SoundManager.volume = muted ? 0 : 1;
  },
}, interactionLogger);

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
    if (currentModel) updateHitAreaHover(currentModel, e.global.x, e.global.y);
    if (dragActionActive && currentModel) {
      dragMoved = true;
      return;
    }
    // ParamHit drag — control a Live2D parameter
    if (paramDragging && currentModel) {
      const now = performance.now();
      if (!paramDragging.hasMoved) {
        paramDragging.hasMoved = true;
      }
      const dx = e.global.x - dragStart.x;
      const dy = e.global.y - dragStart.y;
      if (!dragMoved && dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
        dragMoved = true;
      }
      const coreModel = currentModel.internalModel.coreModel;
      for (const state of paramDragging.items) {
        const { item, startValue, paramIndex } = state;
        const currentPos = item.axis === 0 ? e.global.x : e.global.y;
        const delta = currentPos - state.lastPos;
        state.lastPos = currentPos;
        if (item.type === 2) continue;
        const value = item.type === 1
          ? state.targetValue + Math.abs(delta) * item.factor
          : startValue + (currentPos - state.startPos) * item.factor;
        updateParamHitState(state, value, coreModel);
      }
      if (now - paramDragging.lastTraceAt >= 100) {
        traceLog('touch', 'param-move', {
          interactionId: paramDragging.interactionId,
          pointerId: paramDragging.pointerId,
          hitArea: paramDragging.hitArea,
          x: Number(e.global.x.toFixed(1)),
          y: Number(e.global.y.toFixed(1)),
          values: paramDragging.items.map(state => ({
            param: state.item.paramId,
            value: Number(state.currentValue.toFixed(3)),
            minReached: state.minReached,
            maxReached: state.maxReached,
          })),
        });
        paramDragging.lastTraceAt = now;
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
      traceLog('touch', 'model-drag-threshold', {
        interactionId: dragInteractionId,
        pointerId: e.pointerId,
        threshold: DRAG_THRESHOLD,
        distance: Number(Math.hypot(dx, dy).toFixed(1)),
      });
    }
    // lockModel only prevents position changes, not drag motions
    if (lockModel) return;
    currentModel.x = e.global.x - dragOffset.x;
    currentModel.y = e.global.y - dragOffset.y;
    clampModelPosition();
    updateBorder();
  });

  app.stage.on('pointerup', (e) => {
    if (pressedHitAreas.length > 0) {
      triggerHitAreaAction(pressedHitAreas, 'release');
      pressedHitAreas = [];
    }
    if (dragActionActive) {
      handleDragActionRelease('pointerup');
      return;
    }
    if (paramDragging && currentModel) {
      handleParamHitRelease('pointerup');
      return;
    }
    if (dragging && currentModel) {
      handleDragRelease(e, 'pointerup');
      return;
    }
  });

  app.stage.on('pointerupoutside', (e) => {
    if (pressedHitAreas.length > 0) {
      triggerHitAreaAction(pressedHitAreas, 'release');
      pressedHitAreas = [];
    }
    if (dragActionActive) {
      handleDragActionRelease('pointerupoutside');
      return;
    }
    if (paramDragging && currentModel) {
      handleParamHitRelease('pointerupoutside');
      return;
    }
    if (dragging && currentModel) {
      handleDragRelease(e, 'pointerupoutside');
      return;
    }
  });

  app.stage.on('pointercancel', () => {
    pressedHitAreas = [];
    if (dragActionActive) {
      handleDragActionRelease('pointercancel');
      return;
    }
    if (paramDragging && currentModel) {
      handleParamHitRelease('pointercancel');
      return;
    }
    if (dragging && currentModel) {
      handleDragRelease(undefined, 'pointercancel');
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
        traceLog('trigger', 'key', { keyCode: e.keyCode, motion: kt.downMtn });
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
    idleGroup = null;
    playingStart = false;
    paramHitItems = [];
    paramDragging = null;
    paramReleaseAnims = [];
    paramHitLocks = {};
    paramLoopItems = [];
    dragActionActive = null;
    suppressNextTap = false;
    dragHitNames = [];
    modelMotions = {};
    hitAreaOrder = {};
    hitAreaActionMap = {};
    pressedHitAreas = [];
    hoveredHitAreas = new Set();
    stableHitAreaBounds = {};
    stableModelSize = null;
    hitAreasEnabled = true;
    positionCorrectionPending = false;
    // Reset feature state
    motionEntryMap = {};
    varStore = {};
    lockedParams = {};
    lockedParts = {};
    disabledMotionGroups = new Set();
    disabledParamHitItems = new Set();
    commandLockedParamHitItems = new Set();
    playedMotions = new Set();
    activeLayerMotionRequests = new Map();
    motionCompletions = new Map();
    boundMotionManagers = new WeakSet();
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
  const bounds = getModelLayoutBounds();
  if (bounds.width <= 0 || bounds.height <= 0) return;
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
  if (paramIndex < 0) {
    return {
      min: Number.isFinite(item.minValue) ? item.minValue : 0,
      max: Number.isFinite(item.maxValue) ? item.maxValue : 1,
    };
  }
  const modelMin = coreModel.getParameterMinimumValue(paramIndex);
  const modelMax = coreModel.getParameterMaximumValue(paramIndex);
  return {
    min: Number.isFinite(item.minValue) ? Math.max(modelMin, item.minValue) : modelMin,
    max: Number.isFinite(item.maxValue) ? Math.min(modelMax, item.maxValue) : modelMax,
  };
}

function clampModelPosition() {
  if (!currentModel) return;
  cacheStableModelSize(currentModel);
  const bounds = getModelLayoutBounds();
  const modelWidth = stableModelSize?.width || bounds.width;
  const modelHeight = stableModelSize?.height || bounds.height;
  if (modelWidth <= 0 || modelHeight <= 0) return;
  const width = app.screen.width;
  const height = app.screen.height;
  const anchor = currentModel.anchor || { x: 0, y: 0 };
  const clampAxis = (position, size, anchorValue, screenSize) => {
    if (size >= screenSize) {
      return screenSize / 2 + size * (anchorValue - 0.5);
    }
    return Math.max(
      size * anchorValue,
      Math.min(screenSize - size * (1 - anchorValue), position),
    );
  };

  currentModel.x = clampAxis(currentModel.x, modelWidth, anchor.x, width);
  currentModel.y = clampAxis(currentModel.y, modelHeight, anchor.y, height);
}

function cacheStableModelSize(model) {
  if (!model) return;
  const bounds = model.getBounds();
  if (bounds.width > 0 && bounds.height > 0) {
    stableModelSize = { width: bounds.width, height: bounds.height };
  }
}

function getModelLayoutBounds() {
  if (!currentModel) return { x: 0, y: 0, width: 0, height: 0 };
  const bounds = currentModel.getBounds();
  if (bounds.width > 0 && bounds.height > 0) return bounds;
  if (!stableModelSize) return bounds;

  const anchor = currentModel.anchor || { x: 0, y: 0 };
  return {
    x: currentModel.x - stableModelSize.width * anchor.x,
    y: currentModel.y - stableModelSize.height * anchor.y,
    width: stableModelSize.width,
    height: stableModelSize.height,
  };
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
    traceLog('trigger', 'param-max-crossed', {
      interactionId: paramDragging?.interactionId,
      hitArea: paramDragging?.hitArea,
      param: state.item.paramId,
      previous: Number(previousValue.toFixed(3)),
      value: Number(state.currentValue.toFixed(3)),
      max: Number(max.toFixed(3)),
      motion: state.item.maxMtn,
    });
    if (item.maxMtn) triggerParamHitMotions([state], 'maxMtn', 'MaxMtn');
    state.maxReached = true;
  } else if (state.currentValue < max) {
    state.maxReached = false;
  }
  if (previousValue > min && state.currentValue <= min) {
    traceLog('trigger', 'param-min-crossed', {
      interactionId: paramDragging?.interactionId,
      hitArea: paramDragging?.hitArea,
      param: state.item.paramId,
      previous: Number(previousValue.toFixed(3)),
      value: Number(state.currentValue.toFixed(3)),
      min: Number(min.toFixed(3)),
      motion: state.item.minMtn,
    });
    if (item.minMtn) triggerParamHitMotions([state], 'minMtn', 'MinMtn');
    state.minReached = true;
  } else if (state.currentValue > min) {
    state.minReached = false;
  }
}

function applyReleaseCurve(progress, releaseType) {
  const t = Math.max(0, Math.min(1, progress));
  // The official documentation defines ReleaseType as a return curve but does
  // not publish a numeric serialization table. Do not invent curve meanings
  // for numeric values from third-party model exports.
  if (typeof releaseType === 'string' && releaseType.toLowerCase() === 'ease-in-out') {
    return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
  }
  return t;
}

// --- Border drawing ---

function updateBorder() {
  borderGfx.clear();
  if (!currentModel || !showBorder) return;
  const bounds = getModelLayoutBounds();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  borderGfx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  borderGfx.stroke({ width: 2, color: 0xff0000, alpha: 1 });
}

// --- Hit area drawing ---

const hitAreaBounds = { x: 0, y: 0, width: 0, height: 0 };

function drawHitAreas() {
  hitAreaGfx.clear();
  // Hide all labels first
  for (const label of hitAreaLabels) label.visible = false;

  if (!currentModel) return;

  // Cubism hit drawables can become invisible during an action. Keep a
  // rendered size and first-valid hit-area snapshot for layout and hit tests.
  cacheStableModelSize(currentModel);
  cacheStableHitAreaBounds(currentModel);

  if (positionCorrectionPending) {
    const beforeX = currentModel.x;
    const beforeY = currentModel.y;
    clampModelPosition();
    const bounds = getModelLayoutBounds();
    if (bounds.width > 0 && bounds.height > 0) {
      positionCorrectionPending = false;
      if (currentModel.x !== beforeX || currentModel.y !== beforeY) {
        invoke('set_setting', { key: 'model_x', value: String(currentModel.x) }).catch(() => {});
        invoke('set_setting', { key: 'model_y', value: String(currentModel.y) }).catch(() => {});
        updateInputRegion();
      }
    }
  }

  if (!showHitAreas || !hitAreasEnabled) return;

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

    const currentBounds = internalModel.getDrawableBounds(drawIndex, hitAreaBounds);
    const b = currentBounds.width > 0 && currentBounds.height > 0
      ? currentBounds
      : stableHitAreaBounds[name] || currentBounds;
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

function cacheStableHitAreaBounds(model) {
  const internalModel = model?.internalModel;
  if (!internalModel) return;
  for (const name of Object.keys(internalModel.hitAreas)) {
    const hitArea = internalModel.hitAreas[name];
    let drawIndex = hitArea.index;
    if (drawIndex < 0) {
      drawIndex = internalModel.getDrawableIndex(hitArea.id);
      if (drawIndex < 0) continue;
      hitArea.index = drawIndex;
    }
    const bounds = internalModel.getDrawableBounds(drawIndex, {});
    if (!stableHitAreaBounds[name] && bounds.width > 0 && bounds.height > 0) {
      stableHitAreaBounds[name] = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
    }
  }
}

function hitTestModel(model, x, y) {
  if (!hitAreasEnabled) return [];
  return model.hitTest(x, y);
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

function collectMotionPreloadRoutes(model, includeInteractive = false): MotionResourceRoute[] {
  const rawJson = model.internalModel.settings.json;
  const metadata = normalizeModelMetadata(rawJson);
  const groups = Object.keys(metadata.motions);
  const groupByName = new Map(groups.map(group => [group.toLowerCase(), group]));
  const routes = new Map<string, MotionResourceRoute>();
  const queue = [];

  const resolve = reference => {
    if (typeof reference !== 'string' || !reference.trim()) return null;
    const separator = reference.indexOf(':');
    const rawGroup = separator < 0 ? reference.trim() : reference.slice(0, separator).trim();
    const suffix = separator < 0 ? undefined : reference.slice(separator + 1).trim();
    const group = groupByName.get(rawGroup.toLowerCase());
    if (!group) return null;
    const entries = metadata.motions[group] || [];
    let index;
    if (suffix !== undefined && /^\d+$/.test(suffix)) {
      index = Number(suffix);
    } else if (suffix !== undefined) {
      index = entries.findIndex(entry => String(entry.Name || '').toLowerCase() === suffix.toLowerCase());
    }
    if (index === undefined) return null;
    if (!entries[index]?.File) return { group, index };
    return { group, index };
  };

  const enqueue = reference => {
    if (typeof reference === 'string' && !reference.includes(':')) {
      const group = groupByName.get(reference.trim().toLowerCase());
      if (group) {
        for (let index = 0; index < metadata.motions[group].length; index += 1) {
          if (metadata.motions[group][index]?.File) enqueue({ group, index });
        }
        return;
      }
    }
    const route = typeof reference === 'string' ? resolve(reference) : reference;
    if (!route || !Number.isInteger(route.index)) return;
    const key = `${route.group}:${route.index}`;
    if (!routes.has(key)) {
      routes.set(key, route);
      queue.push(route);
    }
  };

  const enqueueCommandRoutes = command => {
    if (typeof command !== 'string') return;
    for (const part of command.split(';')) {
      const match = part.trim().match(/^start_mtn\s+(.+)$/i);
      if (match) enqueue(match[1].trim());
    }
  };

  // Only the current Idle entry and the model init chain are on the startup
  // critical path. Other Idle variants and interaction routes can be loaded
  // through the same cache when they are actually selected.
  const defaultIdleGroup = groupByName.get('idle')
    || groups.find(group => /^idle$/i.test(group));
  if (defaultIdleGroup) {
    const entries = metadata.motions[defaultIdleGroup] || [];
    const defaultIndex = entries.findIndex(entry => (
      Array.isArray(entry.VarFloats)
      && entry.VarFloats.some(item => /\bequal\s+0\b/i.test(String(item.Code || '')))
    ));
    const index = defaultIndex >= 0 ? defaultIndex : 0;
    if (entries[index]?.File) enqueue({ group: defaultIdleGroup, index });
  }

  for (const [group, entries] of Object.entries(metadata.motions)) {
    entries.forEach((entry, index) => {
      if (String(entry.Name || '').toLowerCase() === 'init') enqueue({ group, index });
    });
  }

  if (includeInteractive) {
    // Explicit hit-area routes are the primary interactive entry points.
    for (const area of metadata.hitAreas) {
      enqueue(area.Motion);
      const name = String(area.Name || '');
      for (const candidate of [`tap_${name}`, name, `Tap${name}`, name.replace(/^Touch/i, '').toLowerCase()]) {
        if (resolve(candidate)) enqueue(candidate);
      }
    }

    // Controller fields use several names across model versions. Only fields
    // explicitly describing a motion route are included in the preload graph.
    const collectControllerRoutes = value => {
      if (Array.isArray(value)) {
        value.forEach(collectControllerRoutes);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' && /(mtn|motion)$/i.test(key)) enqueue(item);
        else collectControllerRoutes(item);
      }
    };
    collectControllerRoutes(rawJson.Controllers || rawJson.controllers);
  }

  // Follow the behavior graph so command-only options and chained actions are
  // ready before their parent interaction starts.
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const route = queue[cursor];
    const entry = metadata.motions[route.group]?.[route.index];
    if (!entry) continue;
    enqueue(entry.NextMtn);
    enqueueCommandRoutes(entry.Command);
    enqueueCommandRoutes(entry.PostCommand);
    if (Array.isArray(entry.Choices)) {
      for (const choice of entry.Choices) enqueue(choice?.NextMtn);
    }
  }

  return [...routes.values()].filter(route => Boolean(metadata.motions[route.group]?.[route.index]?.File));
}

async function preloadModelMotions(model) {
  const manager = model.internalModel.motionManager;
  motionResourceCache = new MotionResourceCache(
    (group, index) => manager.loadMotion(group, index),
    interactionLogger,
  );
  const routes = collectMotionPreloadRoutes(model);
  const result = await motionResourceCache.preload(routes, 2);
  traceLog('motion', 'critical-preload-complete', {
    ...result,
    totalDefinitions: Object.values(manager.definitions || {})
      .reduce((total, entries) => total + (Array.isArray(entries) ? entries.length : 0), 0),
  });
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

function normalizeParamHitType(value) {
  const text = String(value ?? '').toLowerCase();
  if (text === 'drag') return 0;
  if (text === 'stroke') return 1;
  if (text === 'hold') return 2;
  return finiteNumber(value, 0);
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
    Name: firstValue(hitArea, 'Name', 'name'),
    Id: firstValue(hitArea, 'ID', 'Id', 'id'),
    ClickAction: firstValue(hitArea, 'ClickAction', 'clickAction', 'click_action', 'ClickMtn', 'clickMtn', 'click_mtn', 'Motion', 'motion'),
    PressAction: firstValue(hitArea, 'PressAction', 'pressAction', 'press_action', 'PressMtn', 'pressMtn', 'press_mtn'),
    ReleaseAction: firstValue(hitArea, 'ReleaseAction', 'releaseAction', 'release_action', 'ReleaseMtn', 'releaseMtn', 'release_mtn'),
    EnterAction: firstValue(hitArea, 'EnterAction', 'enterAction', 'enter_action', 'EnterMtn', 'enterMtn', 'enter_mtn'),
    ExitAction: firstValue(hitArea, 'ExitAction', 'exitAction', 'exit_action', 'ExitMtn', 'exitMtn', 'exit_mtn'),
    ClickableWhenInvisible: firstValue(hitArea, 'ClickableWhenInvisible', 'clickableWhenInvisible', 'clickable_when_invisible'),
    Motion: firstValue(hitArea, 'ClickAction', 'clickAction', 'click_action', 'ClickMtn', 'clickMtn', 'click_mtn', 'Motion', 'motion'),
    Order: firstValue(hitArea, 'Sorting', 'sorting', 'Order', 'order'),
    Enabled: firstValue(hitArea, 'Enabled', 'enabled'),
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

// Some model exporters append a numeric suffix to utility groups (for
// example, `init#9`). The entry itself is still named `init`, and it is the
// entry that seeds the model's state before the first Idle motion.
function findModelInitEntry() {
  let best = null;
  for (const [group, entries] of Object.entries(modelMotions)) {
    if (!Array.isArray(entries)) continue;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry?.File || String(entry?.Name || '').toLowerCase() !== 'init') continue;
      const normalizedGroup = group.toLowerCase();
      const score = normalizedGroup === 'init'
        ? 100
        : /^init#\d+$/i.test(group)
          ? 90
          : normalizedGroup.startsWith('init')
            ? 50
            : 0;
      if (!best || score > best.score) best = { group, index, score };
    }
  }
  return best;
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
  hitAreaActionMap = {};
  hitAreaOrder = {};
  for (const hitArea of hitAreas) {
    if (!hitArea.Name || hitArea.Enabled === false) continue;
    const resolveAction = value => value ? resolveMotionRef(value) : null;
    const actions = {
      click: resolveAction(hitArea.ClickAction || hitArea.Motion),
      press: resolveAction(hitArea.PressAction),
      release: resolveAction(hitArea.ReleaseAction),
      enter: resolveAction(hitArea.EnterAction),
      exit: resolveAction(hitArea.ExitAction),
      clickableWhenInvisible: hitArea.ClickableWhenInvisible === true || hitArea.ClickableWhenInvisible === 1 || hitArea.ClickableWhenInvisible === 'true',
    };
    hitAreaActionMap[hitArea.Name] = actions;
    if (actions.click) hitMotionMap[hitArea.Name] = actions.click;
    if (hitArea.Order !== undefined) hitAreaOrder[hitArea.Name] = hitArea.Order;
  }
  if (customJson) {
    Object.assign(hitMotionMap, JSON.parse(customJson));
    for (const [name, route] of Object.entries(hitMotionMap)) {
      if (!hitAreaActionMap[name]) hitAreaActionMap[name] = {};
      hitAreaActionMap[name].click = route;
    }
  }
}

function triggerHitAreaAction(names, eventType) {
  for (const name of names) {
    const route = hitAreaActionMap[name]?.[eventType];
    if (!route || route === '__none__') continue;
    traceLog('trigger', `hit-${eventType}`, { hitArea: name, motion: route });
    playMotionRef(route);
    return true;
  }
  return false;
}

function updateHitAreaHover(model, x, y) {
  const current = new Set(sortHitNames(hitTestModel(model, x, y)).slice(0, 1));
  const entered = [...current].filter(name => !hoveredHitAreas.has(name));
  const exited = [...hoveredHitAreas].filter(name => !current.has(name));
  if (entered.length > 0) triggerHitAreaAction(entered, 'enter');
  if (exited.length > 0) triggerHitAreaAction(exited, 'exit');
  hoveredHitAreas = current;
}

function sortHitNames(names) {
  if (names.length <= 1) return names;
  return [...names].sort((a, b) => (hitAreaOrder[b] ?? 0) - (hitAreaOrder[a] ?? 0));
}

function isDragHitArea(name) {
  if (!name) return false;
  return paramHitItems.some(item => item.hitArea === name && isParamHitItemEnabled(item));
}

function isParamHitItemEnabled(item) {
  return !disabledParamHitItems.has(item.name) && !disabledParamHitItems.has(item.hitArea);
}

function isParamHitItemLocked(item) {
  return item.lockParam || commandLockedParamHitItems.has(item.name) || commandLockedParamHitItems.has(item.hitArea);
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
  if (!currentModel) return Promise.resolve(false);
  const model = currentModel;
  group = findMotionGroup(group);
  if (disabledMotionGroups.has(group)) {
    console.log(`[motion] playMotion ${group} — skipped (group disabled)`);
    return Promise.resolve(false);
  }
  if (index === undefined) {
    index = selectMotionIndex(group);
    if (index === undefined) {
      console.log(`[motion] playMotion ${group} — no eligible motion found`);
      return Promise.resolve(false);
    }
  } else if (!isMotionEligible(group, index, motionEntryMap[group]?.[index])) {
    console.log(`[motion] playMotion ${group}:${index} — not eligible`);
    return Promise.resolve(false);
  }
  const entry = motionEntryMap[group]?.[index];
  const deferredStateActions = getDeferredStateActions(entry);

  // Apply VarFloat actions
  if (entry?.VarFloats) applyVarFloatActions(entry, deferredStateActions);

  // Apply state changes before following command routes. Models commonly use
  // an Option entry to assign a state variable and then start an Action; the
  // following Idle selection must see the new state.
  if (entry?.Command) executeCommand(entry.Command);

  // Apply Intimacy bonus
  if (entry && intimacyConfig) applyIntimacyBonus(entry);

  // Track in playedMotions
  playedMotions.add(`${group}:${index}`);

  const nextMtn = entry?.NextMtn || motionNextMap[group]?.[index] || null;

  // Show speech bubble
  if (entry?.Text) showSpeechBubble(entry.Text, entry.TextDelay, entry.TextDuration);

  // Choices UI disabled for now
  // if (entry?.Choices && entry.Choices.length > 0) showChoicesUI(entry.Choices);

  // Reset interaction time
  lastInteractionTime = Date.now();

  // Command-only entry (no File)
  if (entry && !entry.File) {
    console.log(`[motion] playMotion ${group}:${index} — command-only (no File)`);
    applyDeferredStateActions(deferredStateActions);
    // There is no motionFinish event for command-only entries, so complete
    // their post-command phase synchronously before following NextMtn.
    if (entry.PostCommand) {
      executeCommand(entry.PostCommand);
      persistStateParameterLocks(entry, entry.PostCommand);
    }
    // Command-only entries have no motion-finish callback, so their explicit
    // NextMtn chain is resolved synchronously.
    if (nextMtn) {
      const resolved = resolveMotionRef(nextMtn);
      const [nextGroup, nextIdxStr] = resolved.split(':');
      playMotion(nextGroup, nextIdxStr !== undefined ? parseInt(nextIdxStr) : undefined);
    }
    return Promise.resolve(true);
  }

  // Use entry Priority if available
  const motionPriority = priority ?? (entry?.Priority ?? 2);
  const shouldLoop = motionShouldLoop(group, entry);
  const requestId = ++motionRequestSequence;
  const layer = motionLayer(group);
  const deferredLockState = holdDeferredStateLocks(deferredStateActions);

  console.log(`[motion] playMotion ${group}:${index} priority=${motionPriority}`);
  traceLog('motion', 'request', {
    requestId,
    group,
    index,
    name: entry?.Name,
    priority: motionPriority,
    loop: shouldLoop,
    file: entry?.File,
    source: 'runtime',
  });
  // Pass loop explicitly because the engine otherwise falls back to the
  // motion file's Meta.Loop value, which is true for many one-shot clips.
  const startMotion = () => {
    if (!currentModel) return Promise.resolve(false);
    const manager = motionManagerForLayer(model, layer);
    bindMotionFinishListener(model, manager, layer);
    return manager.startMotion(group, index, motionPriority, { loop: shouldLoop });
  };
  const resourceReady = entry?.File && index !== undefined && motionResourceCache
    ? motionResourceCache.load({ group, index })
    : Promise.resolve(true);
  const request = resourceReady.then(startMotion);
  return Promise.resolve(request).then(started => {
    traceLog('motion', 'request-result', { requestId, started });
    if (started) {
      activeLayerMotionRequests.set(layer, requestId);
      if (!shouldLoop) {
        motionCompletions.set(requestId, {
          requestId,
          group,
          index,
          entry,
          nextMtn,
          deferredStateActions,
        });
      }
    }
    if (!started) {
      restoreDeferredStateLocks(deferredLockState);
    }
    return Boolean(started);
  }).catch(error => {
    traceLog('motion', 'request-error', { requestId, error: String(error) });
    restoreDeferredStateLocks(deferredLockState);
    return false;
  });
}

function motionLayer(group) {
  const match = String(group || '').match(/#(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function motionManagerForLayer(model, layer) {
  if (layer <= 0) return model.internalModel.motionManager;
  model.internalModel.extendParallelMotionManager(layer);
  return model.internalModel.parallelMotionManager[layer - 1];
}

function bindMotionFinishListener(model, manager, layer) {
  if (!manager || boundMotionManagers.has(manager)) return;
  boundMotionManagers.add(manager);
  manager.on('motionFinish', () => {
    const requestId = activeLayerMotionRequests.get(layer);
    if (requestId === undefined) return;
    const completion = motionCompletions.get(requestId);
    if (!completion) return;
    completeMotion(model, completion);
  });
}

function idleGroupForLayer(group) {
  const layer = motionLayer(group);
  const candidate = layer === 0 ? 'Idle' : `Idle#${layer}`;
  const resolved = findMotionGroup(candidate);
  return modelMotions[resolved] ? resolved : null;
}

function completeMotion(model, completion) {
  if (currentModel !== model) return;
  const { group, index, entry, nextMtn, deferredStateActions } = completion;
  if (activeLayerMotionRequests.get(motionLayer(group)) !== completion.requestId) {
    traceLog('motion', 'finish-ignored-interrupted', { group, index, requestId: completion.requestId });
    return;
  }
  activeLayerMotionRequests.delete(motionLayer(group));
  motionCompletions.delete(completion.requestId);
  traceLog('motion', 'finish', {
    group,
    index,
    name: entry?.Name,
    file: entry?.File,
    nextMtn,
    fallbackIdle: !nextMtn && Boolean(idleGroupForLayer(group)),
  });
  playingStart = false;
  applyDeferredStateActions(deferredStateActions);
  persistStateParameterLocks(entry, entry?.Command);
  if (entry?.PostCommand) executeCommand(entry.PostCommand);
  scheduleMotionTransition(model, nextMtn, group);
}

function scheduleMotionTransition(model, nextMtn, completedGroup) {
  let attempts = 0;
  const run = () => {
    if (currentModel !== model) return;

    const manager = model.internalModel.motionManager;
    // MotionManager rejects a new request while the previous motion's sound
    // is still playing. Wait before reserving the next motion; a rejected
    // request leaves an idle reservation behind and blocks later requests.
    if (manager.currentAudio?.isPlaying) {
      if (attempts++ < 200) {
        setTimeout(run, 50);
      } else {
        manager.stopSpeaking();
        setTimeout(run, 0);
      }
      return;
    }

    // Recover from an old failed idle request left by a previous app version.
    const state = manager.state;
    if (state.currentGroup === undefined && state.reservedIdleGroup !== undefined) {
      state.setReservedIdle(undefined, undefined);
    }

    let request;
    let isIdleTransition = false;
    if (nextMtn) {
      const resolved = resolveMotionRef(nextMtn);
      const [group, idxStr] = resolved.split(':');
      traceLog('motion', 'finish-transition', { type: 'NextMtn', nextMtn: resolved });
      request = playMotion(group, idxStr !== undefined ? parseInt(idxStr) : undefined);
    } else {
      const layerIdleGroup = idleGroupForLayer(completedGroup);
      if (!layerIdleGroup) return;
      isIdleTransition = true;
      const idleIndex = selectIdleMotionIndex(layerIdleGroup);
      traceLog('motion', 'finish-transition', {
        type: 'Idle',
        group: layerIdleGroup,
        index: idleIndex,
        idleState: getStateValue('idle'),
      });
      request = idleIndex === undefined
        ? Promise.resolve(false)
        : playMotion(layerIdleGroup, idleIndex, 1);
    }

    Promise.resolve(request).then(started => {
      if (!started && currentModel === model && attempts++ < 40) {
        setTimeout(run, 50);
        return;
      }
      if (started && isIdleTransition && extraMotionEnabled && currentModel?.parallelMotion) {
        const extraMotions = [];
        for (let n = 1; modelMotions[`Idle#${n}`]; n++) {
          const idx = selectIdleMotionIndex(`Idle#${n}`) ?? 0;
          extraMotions.push({ group: `Idle#${n}`, index: idx, priority: 1 });
        }
        if (extraMotions.length > 0) {
          currentModel.parallelMotion(extraMotions).catch(() => {});
        }
      }
    });
  };
  setTimeout(run, 0);
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

function selectIdleMotionIndex(group) {
  const index = selectMotionIndex(group);
  traceLog('motion', 'idle-select', {
    group,
    index,
    idleState: getStateValue('idle'),
  });
  return index;
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

function isVarFloatCondition(vf) {
  return vf.Type === 1 || String(vf.Type || '').toLowerCase() === 'condition';
}

function isVarFloatAction(vf) {
  return vf.Type === 2 || String(vf.Type || '').toLowerCase() === 'action';
}

function resolveVarFloatValue(raw) {
  const value = String(raw ?? '').trim();
  if (value.startsWith('$')) return varStore[value.slice(1)] ?? 0;
  if (value.startsWith('@') && currentModel) {
    const coreModel = currentModel.internalModel.coreModel;
    const index = getParameterIndexById(coreModel, value.slice(1));
    return index >= 0 ? coreModel.getParameterValueByIndex(index) : 0;
  }
  const random = value.match(/^rand(f)?\(\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*\)$/i);
  if (random) {
    const min = Number(random[2]);
    const max = Number(random[3]);
    const sample = min + Math.random() * (max - min);
    return random[1] ? sample : Math.floor(sample);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function applyVarFloatOperation(current, operation, target) {
  switch (operation) {
    case 'assign': return target;
    case 'add': return current + target;
    case 'subtract': return current - target;
    case 'multiply': return current * target;
    case 'divide': return target === 0 ? current : current / target;
    case 'round': {
      const factor = 10 ** Math.max(0, Math.floor(target));
      return Math.round(current * factor) / factor;
    }
    default: return current;
  }
}

function checkVarFloatConditions(entry) {
  if (!entry.VarFloats) return true;
  for (const vf of entry.VarFloats) {
    if (!isVarFloatCondition(vf)) continue;
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
    const parts = code.trim().split(/\s+/);
    const op = parts[0]?.toLowerCase();
    const target = resolveVarFloatValue(parts.slice(1).join(' '));
    if (op === 'equal' && value !== target) return false;
    if (op === 'not_equal' && value === target) return false;
    if (op === 'greater' && value <= target) return false;
    if (op === 'lower' && value >= target) return false;
    if (op === 'greater_equal' && value < target) return false;
    if (op === 'lower_equal' && value > target) return false;
  }
  return true;
}

function getDeferredStateActions(entry) {
  if (!entry?.VarFloats || !entry?.Command) return [];
  const lockValues = new Map(entry.Command
    .split(';')
    .map(command => command.trim().split(/\s+/))
    .filter(parts => parts[0] === 'parameters' && parts[1] === 'lock' && parts[2] && parts[3])
    .flatMap(parts => parts[2].split(',').map(id => [id, parts[3]])));
  if (lockValues.size === 0) return [];

  return entry.VarFloats.filter(vf => {
    if (!isVarFloatAction(vf) || !vf.Name) return false;
    const parts = (vf.Code || '').trim().split(/\s+/);
    if (parts[0]?.toLowerCase() !== 'assign' || !Number.isFinite(parseFloat(parts[1]))) return false;
    const parameterId = vf.Name.startsWith('@') ? vf.Name.substring(1) : vf.Name;
    return lockValues.get(parameterId) === `$${vf.Name}`
      || lockValues.get(parameterId) === `$${parameterId}`;
  });
}

function holdDeferredStateLocks(actions) {
  const ids = new Set();
  const previous = new Map();
  for (const action of actions || []) {
    const id = action.Name?.startsWith('@') ? action.Name.substring(1) : action.Name;
    if (!id) continue;
    ids.add(id);
    if (!lockedParams[id]) continue;
    previous.set(id, lockedParams[id]);
    lockedParams[id] = { ...lockedParams[id], duration: 0 };
    traceLog('motion', 'deferred-state-lock', { parameter: id, value: lockedParams[id].value });
  }
  return { ids, previous };
}

function restoreDeferredStateLocks(lockState) {
  if (!lockState) return;
  for (const id of lockState.ids || []) {
    if (lockState.previous?.has(id)) lockedParams[id] = lockState.previous.get(id);
    else delete lockedParams[id];
  }
}

function applyVarFloatActions(entry, deferredActions = []) {
  if (!entry.VarFloats) return;
  const deferred = new Set(deferredActions);
  for (const vf of entry.VarFloats) {
    if (!isVarFloatAction(vf)) continue;
    if (deferred.has(vf)) continue;
    const name = vf.Name;
    const code = vf.Code || '';
    const parts = code.split(/\s+/);
    const op = parts[0]?.toLowerCase();
    const target = resolveVarFloatValue(parts.slice(1).join(' '));
    if (name && name.startsWith('@') && currentModel) {
      const paramId = name.substring(1);
      const cm = currentModel.internalModel.coreModel;
      const idx = getParameterIndexById(cm, paramId);
      const count = cm.getParameterCount();
      if (idx >= 0 && idx < count) {
        const current = cm.getParameterValueByIndex(idx);
        const next = op === 'init' ? target : applyVarFloatOperation(current, op, target);
        cm.setParameterValueByIndex(idx, next);
        syncInteractionParameter(paramId, next);
      }
    } else {
      if (!name || (op === 'init' && Object.hasOwn(varStore, name))) continue;
      const current = varStore[name] ?? 0;
      const next = op === 'init' ? target : applyVarFloatOperation(current, op, target);
      varStore[name] = next;
      syncInteractionVariable(name, next);
    }
  }
}

function applyDeferredStateActions(actions) {
  for (const action of actions || []) {
    const parts = (action.Code || '').trim().split(/\s+/);
    const target = parseFloat(parts[1]);
    if (!action.Name || parts[0]?.toLowerCase() !== 'assign' || !Number.isFinite(target)) continue;
    const parameterId = action.Name.startsWith('@') ? action.Name.substring(1) : action.Name;
    if (!action.Name.startsWith('@')) {
      varStore[action.Name] = target;
      syncInteractionVariable(action.Name, target);
    }
    if (!currentModel) continue;
    const cm = currentModel.internalModel.coreModel;
    const index = getParameterIndexById(cm, parameterId);
    if (index >= 0 && index < cm.getParameterCount()) cm.setParameterValueByIndex(index, target);
    if (action.Name.startsWith('@')) syncInteractionParameter(parameterId, target);
    traceLog('motion', 'deferred-state-commit', { parameter: parameterId, value: target });
  }
}

function syncInteractionVariable(name, value) {
  if (modelRuntime && name && Number.isFinite(value)) modelRuntime.state.setVariable(name, value);
}

function syncInteractionParameter(name, value) {
  if (modelRuntime && name && Number.isFinite(value)) modelRuntime.state.setParameter(name, value);
}

function getStateValue(name) {
  if (currentModel) {
    const cm = currentModel.internalModel.coreModel;
    const index = getParameterIndexById(cm, name);
    if (index >= 0 && index < cm.getParameterCount()) return cm.getParameterValueByIndex(index);
  }
  return varStore[name] ?? 0;
}

function persistStateParameterLocks(entry, commandString = entry?.PostCommand) {
  if (!currentModel || !entry?.VarFloats || !commandString) return;

  const stateActions = entry.VarFloats.filter((vf) => (
    vf.Type === 2
    && vf.Name
    && !vf.Name.startsWith('@')
    && /^assign\s+/i.test(vf.Code || '')
  ));
  if (stateActions.length === 0) return;

  const lockCommands = commandString
    .split(';')
    .map((command) => command.trim().split(/\s+/))
    .filter((parts) => (
      parts[0] === 'parameters'
      && parts[1] === 'lock'
      && parts[2]
      && parts[3]
    ));
  if (lockCommands.length === 0) return;

  const cm = currentModel.internalModel.coreModel;
  const paramCount = cm.getParameterCount();
  for (const action of stateActions) {
    const variable = action.Name;
    const lockCommand = lockCommands.find((parts) => (
      parts[2].split(',').includes(variable)
      && parts[3] === `$${variable}`
    ));
    if (!lockCommand) continue;

    const paramIndex = getParameterIndexById(cm, variable);
    if (paramIndex < 0 || paramIndex >= paramCount) continue;

    const value = varStore[variable] ?? 0;
    lockedParams[variable] = {
      paramIndex,
      value,
      startTime: performance.now(),
      duration: 0,
    };
    traceLog('motion', 'persistent-state-lock', {
      parameter: variable,
      value,
    });
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
  live2DCommandRuntime.execute(cmdString);
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
    if (!refs.has(ref)) refs.set(ref, undefined);
  }
  for (const [ref, priority] of refs) {
    traceLog('trigger', `param-${label.toLowerCase()}`, {
      interactionId: paramDragging?.interactionId,
      hitArea: paramDragging?.hitArea,
      property,
      motion: ref,
      priority: priority ?? 2,
      params: states.map(state => state.item.paramId),
    });
    console.log(`[motion] drag ${label}: ${ref}`);
    playMotionRef(ref, priority);
  }
}

function handleParamHitRelease(reason = 'release') {
  if (!paramDragging || !currentModel) return;
  const { hitArea, items } = paramDragging;
  traceLog('touch', 'param-release', {
    interactionId: paramDragging.interactionId,
    pointerId: paramDragging.pointerId,
    reason,
    hitArea,
  });
  const coreModel = currentModel.internalModel.coreModel;
  const endStates = [];
  for (const state of items) {
    const { item, paramIndex, currentValue, startValue } = state;
    const { min, max } = getParamHitBounds(item, coreModel, paramIndex);
    const moved = Math.abs(currentValue - startValue);
    console.log(`[touch] ParamHit release on ${hitArea}: ${item.paramId}=${currentValue.toFixed(3)}, moved=${moved.toFixed(3)}, range=[${min},${max}]`);

    // LockParam is the persistence switch. ReleaseType is only metadata for
    // the return curve and must not decide whether a return happens.
    if (isParamHitItemLocked(item)) {
      paramReleaseAnims = paramReleaseAnims.filter(anim => anim.paramIndex !== paramIndex);
      paramHitLocks[paramIndex] = { value: currentValue };
      traceLog('touch', 'param-release-lock', {
        interactionId: paramDragging.interactionId,
        param: item.paramId,
        value: Number(currentValue.toFixed(3)),
      });
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
      traceLog('touch', 'param-release-restore', {
        interactionId: paramDragging.interactionId,
        param: item.paramId,
        from: Number(currentValue.toFixed(3)),
        target: Number(startValue.toFixed(3)),
        releaseType: item.releaseType,
        duration: item.releaseDuration,
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

function handleDragActionRelease(reason = 'release') {
  if (!dragActionActive) return;
  traceLog('touch', 'drag-action-release', {
    interactionId: dragActionActive.interactionId,
    pointerId: dragActionActive.pointerId,
    reason,
    hitAreas: dragActionActive.hitAreas,
  });
  dragActionActive = null;
  dragHitNames = [];
  updateInputRegion();
}

function handleDragRelease(_event, reason = 'release') {
  traceLog('touch', 'model-drag-release', {
    interactionId: dragInteractionId,
    reason,
    moved: dragMoved,
    modelX: currentModel ? Number(currentModel.x.toFixed(1)) : null,
    modelY: currentModel ? Number(currentModel.y.toFixed(1)) : null,
  });
  dragging = false;
  dragInteractionId = null;
  dragHitNames = [];
  if (!lockModel) savePosition();
  updateInputRegion();
}

// --- Model loading ---

async function loadModel(modelPath) {
  const loadStartedAt = performance.now();
  traceLog('model-load', 'start', { modelPath });

  // Reset drag state so stale flags don't block taps on the new model
  dragging = false;
  dragMoved = false;
  playingStart = false;
  paramDragging = null;
  paramReleaseAnims = [];
  paramHitLocks = {};
  paramHitItems = [];
  paramLoopItems = [];
  dragActionActive = null;
  suppressNextTap = false;
  pressedHitAreas = [];
  hoveredHitAreas = new Set();
  hitAreaActionMap = {};
  // Reset feature state
  motionEntryMap = {};
  varStore = {};
  lockedParams = {};
  lockedParts = {};
  disabledMotionGroups = new Set();
  disabledParamHitItems = new Set();
  commandLockedParamHitItems = new Set();
  playedMotions = new Set();
  activeLayerMotionRequests = new Map();
  motionCompletions = new Map();
  boundMotionManagers = new WeakSet();
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
    appRuntime.detachModel();
    modelRuntime = null;
    motionResourceCache?.clear();
    motionResourceCache = null;
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
    // LPK assets are decrypted/extracted once before the webview starts
    // requesting textures, motions, physics and expressions.
    const prepareStartedAt = performance.now();
    await resourcePreloader.prepare(modelPath);
    traceLog('model-load', 'resources-ready', {
      elapsedMs: Math.round(performance.now() - prepareStartedAt),
    });

    const modelStartedAt = performance.now();
    const model = await Live2DModel.from(modelPath, {
      autoHitTest: false,
      autoFocus: mouseTracking,
      // The engine's default only preloads Idle and starts it in the
      // background. We explicitly await every motion below so the first
      // pointer event never competes with motion file parsing.
      motionPreload: 'NONE',
    });
    traceLog('model-load', 'engine-model-ready', {
      elapsedMs: Math.round(performance.now() - modelStartedAt),
    });

    const criticalPreloadStartedAt = performance.now();
    await preloadModelMotions(model);
    traceLog('model-load', 'startup-load-complete', {
      elapsedMs: Math.round(performance.now() - loadStartedAt),
      criticalPreloadMs: Math.round(performance.now() - criticalPreloadStartedAt),
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
    stableHitAreaBounds = {};
    stableModelSize = null;
    hitAreasEnabled = true;
    positionCorrectionPending = true;
    cacheStableHitAreaBounds(model);

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
      suppressNextTap = false;
      dragMoved = false;

      cacheStableHitAreaBounds(model);
      pressedHitAreas = sortHitNames(hitTestModel(model, e.global.x, e.global.y)).slice(0, 1);
      const pressActionConsumed = triggerHitAreaAction(pressedHitAreas, 'press');

      // Check for ParamHit drag areas first
      if (paramHitItems.length > 0) {
        const hitNames = pressedHitAreas;
        for (const name of hitNames) {
          const items = paramHitItems.filter(item =>
            item.hitArea === name && isParamHitItemEnabled(item),
          );
          if (items.length > 0) {
            console.log(`[touch] pointerdown on ParamHit area: ${name} (params: ${items.map(item => item.paramId).join(', ')})`);
            const coreModel = model.internalModel.coreModel;
            const interactionId = ++interactionSequence;
            lastInteractionId = interactionId;
            traceLog('touch', 'param-down', {
              interactionId,
              pointerId: e.pointerId,
              button: e.button,
              hitArea: name,
              x: Number(e.global.x.toFixed(1)),
              y: Number(e.global.y.toFixed(1)),
              params: items.map(item => ({
                param: item.paramId,
                axis: item.axis,
                type: item.type,
                factor: item.factor,
                weight: item.weight,
                lockParam: item.lockParam,
                minMtn: item.minMtn,
                maxMtn: item.maxMtn,
                beginMtn: item.beginMtn,
                endMtn: item.endMtn,
              })),
            });
            paramDragging = {
              interactionId,
              pointerId: e.pointerId,
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
              lastTraceAt: 0,
            };
            const indexes = new Set(items.map(item => item.paramIndex));
            paramReleaseAnims = paramReleaseAnims.filter(anim => !indexes.has(anim.paramIndex));
            dragMoved = false;
            suppressNextTap = true;
            dragStart.x = e.global.x;
            dragStart.y = e.global.y;
            setFullInputRegion();
            triggerParamHitMotions(paramDragging.items, 'beginMtn', 'BeginMtn');
            return;
          }
        }
      }

      // A declared press action owns the gesture. A click action remains a
      // pointer-tap route; names such as TouchDrag do not change that rule.
      const interactionId = ++interactionSequence;
      lastInteractionId = interactionId;
      cacheStableHitAreaBounds(model);
      dragHitNames = sortHitNames(hitTestModel(model, e.global.x, e.global.y));
      dragInteractionId = interactionId;
      dragStart.x = e.global.x;
      dragStart.y = e.global.y;
      const dragMotionConsumed = pressActionConsumed;

      traceLog('touch', 'model-down', {
        interactionId,
        pointerId: e.pointerId,
        button: e.button,
        x: Number(e.global.x.toFixed(1)),
        y: Number(e.global.y.toFixed(1)),
        hitAreas: dragHitNames,
      });
      console.log(`[touch] pointerdown — drag hit areas: [${dragHitNames.join(', ')}]`);
      if (dragMotionConsumed) {
        // TouchDrag areas own the gesture. They trigger their configured
        // action/parameter route and must not also move the whole model.
        dragging = false;
        dragMoved = true;
        suppressNextTap = true;
        dragActionActive = {
          interactionId,
          pointerId: e.pointerId,
          hitAreas: [...dragHitNames],
        };
        dragHitNames = [];
        setFullInputRegion();
        return;
      }
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
    modelRuntime = new ModelRuntime({
      id: modelPath,
      rawJson,
      logger: interactionLogger,
      // playMotion is still the compatibility adapter and owns Command,
      // PostCommand and NextMtn side effects until the native TS player lands.
      executeCommands: false,
      resolveHitRoute: name => hitMotionMap[name],
      isDragHitArea: () => false,
      dispatchMotion: (route, options) => playMotion(route.group, route.index, options?.priority),
    });
    appRuntime.attachModel(modelRuntime);
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
        if (paramIndex < 0) {
          traceLog('controller', 'param-hit-skipped-missing-parameter', {
            hitArea: item.HitArea,
            parameter: paramId,
          });
          console.warn(`[controller] ParamHit skipped: parameter not found (${paramId})`);
          continue;
        }
        paramHitItems.push({
          hitArea: item.HitArea,
          name: item.Name || item.HitArea,
          paramId,
          paramIndex,
          axis: finiteNumber(item.Axis, 0),
          factor: finiteNumber(item.Factor, 0.04),
          type: normalizeParamHitType(item.Type),
          weight: finiteNumber(item.Weight, 1),
          minValue: item.MinValue,
          maxValue: item.MaxValue,
          releaseType: finiteNumber(item.ReleaseType, 0),
          releaseDuration: finiteNumber(item.Release, 500),
          lockParam: item.LockParam ?? false,
          lowPriority: item.LowPriority === true || item.LowPriority === 1 || item.LowPriority === 'true',
          // Keep the original route. MaxMtn may point to an Option whose
          // VarFloats changes the idle state before starting an Action.
          maxMtn: item.MaxMtn ? resolveMotionRef(item.MaxMtn) : null,
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

    // The engine automatically starts a random idle motion after
    // motionFinish. That bypasses VarFloats/weights and can select a
    // different idle state than the model metadata allows. Idle transitions
    // are handled below after the engine has completed its motion state.
    const motionManager = model.internalModel.motionManager;
    const nativeIdleGroup = motionManager.groups?.idle;
    if (motionManager.groups) motionManager.groups.idle = '__rive2d_manual_idle__';
    traceLog('motion', 'native-auto-idle-disabled', { nativeIdleGroup });

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
            isParamHitItemLocked(state.item) && state.paramIndex === loop.paramIndex,
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

    model.on('pointertap', (e) => {
      lastInteractionTime = Date.now();
      traceLog('touch', 'tap', {
        interactionId: lastInteractionId,
        pointerId: e.pointerId,
        button: e.button,
        x: Number(e.global.x.toFixed(1)),
        y: Number(e.global.y.toFixed(1)),
        dragMoved,
        rightClickMotion,
        tapMotion,
      });
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
      if (suppressNextTap) {
        suppressNextTap = false;
        console.log('[touch] pointertap — skipped (drag interaction consumed)');
        return;
      }
      if (dragMoved) { console.log('[touch] pointertap — skipped (dragMoved)'); return; }
      cacheStableHitAreaBounds(model);
      const hitAreaNames = sortHitNames(hitTestModel(model, e.global.x, e.global.y));
      console.log(`[touch] pointertap — hit areas: [${hitAreaNames.join(', ')}]`);
      if (hitAreaNames.length === 0) {
        console.log('[touch] pointertap — no hit area at click position');
      }
      // The TypeScript interaction runtime owns JSON-defined routes. Keep
      // custom mappings and legacy fallbacks below for compatibility.
      const targetHitAreas = hitAreaNames.slice(0, 1);
      if (modelRuntime && modelRuntime.handleHit('tap', targetHitAreas, e.button)) {
        console.log('[touch] pointertap — handled by interaction runtime');
        return;
      }
      for (const name of targetHitAreas) {
        const mapped = hitMotionMap[name];
        // Custom override: __none__ means do nothing
        if (mapped === '__none__') { console.log(`[touch] ${name}: skipped (__none__)`); continue; }
        // Explicit mapping (from model JSON or custom override)
        if (mapped) {
          const [group, idxStr] = mapped.split(':');
          const arrayIdx = idxStr !== undefined ? parseInt(idxStr) : undefined;
          traceLog('trigger', 'tap-motion', {
            interactionId: lastInteractionId,
            pointerId: e.pointerId,
            hitArea: name,
            motion: group + (arrayIdx !== undefined ? `:${arrayIdx}` : ''),
          });
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
            traceLog('trigger', 'tap-convention-motion', {
              interactionId: lastInteractionId,
              pointerId: e.pointerId,
              hitArea: name,
              motion: group,
            });
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

    // Saved coordinates can come from a missed hit-test being interpreted as
    // a model drag. Clamp immediately when possible; drawHitAreas also retries
    // after the first valid render because Live2D bounds may be zero here.
    clampModelPosition();
    updateBorder();
    updateInputRegion();

    // Detect idle and start motion groups
    // Models may declare a command-only `init` entry that seeds VarFloats,
    // parameters, and controller locks before any Idle motion is eligible.
    const initEntry = findModelInitEntry();
    if (initEntry) {
      traceLog('motion', 'model-init', initEntry);
      playMotion(initEntry.group, initEntry.index, 1);
    }

    const idleCandidate = findMotionGroup('Idle');
    idleGroup = modelMotions[idleCandidate] ? idleCandidate : null;

    const startCandidate = findMotionGroup('Start');
    const startGroup = modelMotions[startCandidate] ? startCandidate : null;
    if (startGroup) {
      playingStart = true;
      playMotion(startGroup, 0, 1); // priority IDLE so taps can interrupt
    } else if (idleGroup) {
      const idleIndex = selectIdleMotionIndex(idleGroup);
      if (idleIndex !== undefined) playMotion(idleGroup, idleIndex, 1);
    }

    // Start Leave timer
    startLeaveTimer();
  } catch (err) {
    console.error('[rive2d] Failed to load model:', err);
  }
}
