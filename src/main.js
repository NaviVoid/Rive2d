import * as PIXI from 'pixi.js';
import { Assets } from 'pixi.js';
import { Live2DModel } from 'untitled-pixi-live2d-engine';

// Expose PIXI globally for pixi-live2d-display
window.PIXI = PIXI;

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
let paramDragging = null;    // { item, startPos, paramIndex, startValue, currentValue }
let paramReleaseAnims = [];  // parameter reset animations after drag release
let paramLoopItems = [];     // ParamLoop controller items: auto-oscillating parameters
let dragHitNames = [];       // hit area names recorded on pointerdown for drag-motion detection
let dragMotionTriggered = false; // true once a drag motion has been triggered during current drag
let modelMotions = {};       // motion groups from raw model JSON (for drag convention lookup)
let hitAreaOrder = {};       // { hitAreaName: orderValue } from HitAreas[].Order for sorting
let dragScrubState = null;   // { motion, entry, duration, progress, hitArea } — drag motion scrubbing
const DRAG_SCRUB_DISTANCE = 200; // pixels of drag for full animation progress (0→1)

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
      if (!dragMoved) {
        const dx = e.global.x - dragStart.x;
        const dy = e.global.y - dragStart.y;
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
        dragMoved = true;
        // Trigger BeginMtn on first real drag movement
        if (paramDragging.item.beginMtn) {
          const [g, idx] = paramDragging.item.beginMtn.split(':');
          console.log(`[motion] drag BeginMtn on ${paramDragging.item.hitArea}: ${g}` + (idx !== undefined ? `:${idx}` : ''));
          currentModel.motion(g, idx !== undefined ? parseInt(idx) : undefined);
        }
      }
      const { item, startPos, startValue } = paramDragging;
      const currentPos = item.axis === 0 ? e.global.x : e.global.y;
      const scale = currentModel?.scale.x || 1;
      paramDragging.currentValue = startValue + (currentPos - startPos) * item.factor * scale;
      return;
    }
    // Model drag — move position + trigger drag motions
    if (!dragging || !currentModel) return;
    // Drag scrubbing: control animation progress based on drag distance
    if (dragScrubState) {
      const item = dragScrubState.item;
      if (item) {
        // ParamHit-driven scrub: axis/factor determine drag curve
        // BeginMtn: trigger on first drag movement past threshold
        if (!dragScrubState.beginFired && item.beginMtn) {
          const dx = e.global.x - dragStart.x;
          const dy = e.global.y - dragStart.y;
          if (dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
            dragScrubState.beginFired = true;
            const [g, idx] = item.beginMtn.split(':');
            console.log(`[motion] drag scrub BeginMtn on ${item.hitArea}: ${g}` + (idx !== undefined ? `:${idx}` : ''));
            currentModel.motion(g, idx !== undefined ? parseInt(idx) : undefined);
          }
        }
        const delta = item.axis === 0 ? (e.global.x - dragStart.x) : (e.global.y - dragStart.y);
        const scale = currentModel?.scale.x || 1;
        const value = delta * item.factor * scale;
        dragScrubState.progress = Math.max(0, Math.min(1, value));
      } else {
        // Convention-based drag scrub: Euclidean distance
        const dx = e.global.x - dragStart.x;
        const dy = e.global.y - dragStart.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        dragScrubState.progress = Math.min(1, dist / DRAG_SCRUB_DISTANCE);
      }
      return;
    }
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
      updateInputRegion();
    }
  });
});

// --- Register event listeners synchronously so we never miss backend events ---

invoke('get_config').then((config) => {
  showBorder = config.show_border;
  tapMotion = config.tap_motion;
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
  const rawHitAreas = rawJson.HitAreas || rawJson.hitAreas || rawJson.hit_areas || [];
  let customJsonStr = null;
  try {
    customJsonStr = await invoke('get_custom_motions', { path: changedPath });
  } catch {}
  buildHitMotionMap(rawHitAreas, customJsonStr);
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
    paramLoopItems = [];
    dragScrubState = null;
    dragHitNames = [];
    dragMotionTriggered = false;
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

// --- Motion map helpers ---

// Build motionNameToIndex, motionNextMap, fileLoopMap, and motionEntryMap from raw model JSON
function buildMotionMaps(rawJson) {
  const motions = rawJson.FileReferences?.Motions || rawJson.motions || {};
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

// Resolve a "group:Name" reference to "group:arrayIndex"
function resolveMotionRef(ref) {
  const [group, name] = ref.split(':');
  if (name !== undefined && motionNameToIndex[group]?.[name] !== undefined) {
    return group + ':' + motionNameToIndex[group][name];
  }
  return ref;
}

// Build hitMotionMap and hitAreaOrder from raw hit areas + optional custom overrides JSON
function buildHitMotionMap(rawHitAreas, customJson) {
  hitMotionMap = {};
  hitAreaOrder = {};
  for (const h of rawHitAreas) {
    const n = h.Name || h.name;
    if (!n) continue;
    if (h.Enabled === false) continue;
    if (h.Motion) hitMotionMap[n] = resolveMotionRef(h.Motion);
    if (h.Order !== undefined) hitAreaOrder[n] = h.Order;
  }
  if (customJson) Object.assign(hitMotionMap, JSON.parse(customJson));
}

// Sort hit area names by Order (higher = first), for overlapping hit area priority
function sortHitNames(names) {
  if (names.length <= 1) return names;
  return [...names].sort((a, b) => (hitAreaOrder[b] ?? 0) - (hitAreaOrder[a] ?? 0));
}

// Check if a mapped motion is a drag-type motion (by motion group name only)
function isDragMotion(mapped) {
  if (!mapped || mapped === '__none__') return false;
  const group = mapped.split(':')[0];
  return /drag/i.test(group);
}

// Trigger drag motions for hit areas recorded during pointerdown
function triggerDragMotions() {
  if (!currentModel) return;
  function startDragScrub(name, group, arrayIdx) {
    console.log(`[motion] drag scrub on ${name}: ${group}` + (arrayIdx !== undefined ? `:${arrayIdx}` : ''));
    dragScrubState = { entry: null, duration: 0, progress: 0, hitArea: name, ready: false, beginFired: false };
    currentModel.motion(group, arrayIdx).then(() => {
      if (dragScrubState) dragScrubState.ready = true;
    });
    pendingNextMtn = (arrayIdx !== undefined && motionNextMap[group]?.[arrayIdx]) || null;
  }
  for (const name of dragHitNames) {
    // 1. Explicit mapping whose motion group contains "drag" (e.g. Drag*, TouchDrag*)
    const mapped = hitMotionMap[name];
    if (mapped && mapped !== '__none__' && isDragMotion(mapped)) {
      const [group, idxStr] = mapped.split(':');
      const arrayIdx = idxStr !== undefined ? parseInt(idxStr) : undefined;
      startDragScrub(name, group, arrayIdx);
      return;
    }
    // 2. Convention fallbacks: Drag + hitAreaName, drag_ + hitAreaName
    if (modelMotions['Drag' + name]) {
      startDragScrub(name, 'Drag' + name, undefined);
      return;
    }
    if (modelMotions['drag_' + name]) {
      startDragScrub(name, 'drag_' + name, undefined);
      return;
    }
  }
}

// Follow Command "start_mtn" redirects to find the actual motion
function resolveMaxMtn(rawJson, ref, depth = 0) {
  if (depth > 5) return ref;
  const resolved = resolveMotionRef(ref);
  const [group, idxStr] = resolved.split(':');
  const motions = rawJson.FileReferences?.Motions || rawJson.motions || {};
  const entries = motions[group];
  if (!entries) return resolved;
  const idx = idxStr !== undefined ? parseInt(idxStr) : 0;
  const entry = entries[idx];
  if (!entry) return resolved;
  if (entry.Command && entry.Command.startsWith('start_mtn ')) {
    return resolveMaxMtn(rawJson, entry.Command.substring('start_mtn '.length).trim(), depth + 1);
  }
  return resolved;
}

// --- Central motion gateway ---

function playMotion(group, index, priority) {
  if (!currentModel) return;
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

  console.log(`[motion] playMotion ${group}:${index} priority=${motionPriority}`);
  currentModel.motion(group, index, motionPriority);
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
      const idx = cm.getParameterIndex(paramId);
      const count = cm.getParameterCount();
      value = idx < count ? cm.getParameterValueByIndex(idx) : 0;
    } else {
      value = varStore[name] ?? 0;
    }
    const parts = code.split(/\s+/);
    const op = parts[0];
    const target = parseFloat(parts[1]) || 0;
    if (op === 'equal' && value !== target) return false;
    if (op === 'not_equal' && value === target) return false;
    if (op === 'greater' && value <= target) return false;
    if (op === 'less' && value >= target) return false;
    if (op === 'greater_equal' && value < target) return false;
    if (op === 'less_equal' && value > target) return false;
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
      const idx = cm.getParameterIndex(paramId);
      const count = cm.getParameterCount();
      if (idx < count) {
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
        const value = parseFloat(parts[3]) || 0;
        const duration = parts[4] ? parseFloat(parts[4]) : 0;
        const idx = cm.getParameterIndex(id);
        if (idx < paramCount) {
          lockedParams[id] = { paramIndex: idx, value, startTime: performance.now(), duration };
        }
      } else if (action === 'unlock' && id) {
        for (const pid of id.split(',')) delete lockedParams[pid.trim()];
      } else if (action === 'set' && id) {
        const value = parseFloat(parts[3]) || 0;
        const idx = cm.getParameterIndex(id);
        if (idx < paramCount) cm.setParameterValueByIndex(idx, value);
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
      import('untitled-pixi-live2d-engine').then(mod => {
        if (mod.SoundManager) mod.SoundManager.volume = soundMuted ? 0 : 1;
      }).catch(() => {});
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

function handleParamHitRelease() {
  const { item, paramIndex, currentValue, startValue } = paramDragging;
  if (dragMoved) {
    if (item.maxMtn || item.minMtn) {
      const coreModel = currentModel.internalModel.coreModel;
      const max = paramIndex >= 0 ? coreModel.getParameterMaximumValue(paramIndex) : 1;
      const min = paramIndex >= 0 ? coreModel.getParameterMinimumValue(paramIndex) : -1;
      const range = max - min;
      const atMax = currentValue >= max - range * 0.1;
      const atMin = currentValue <= min + range * 0.1;
      const moved = Math.abs(currentValue - startValue);
      console.log(`[touch] ParamHit release on ${item.hitArea}: value=${currentValue.toFixed(3)}, moved=${moved.toFixed(3)}, range=[${min},${max}], atMax=${atMax}, atMin=${atMin}, threshold=${(range * 0.3).toFixed(3)}`);
      if (range > 0 && moved > range * 0.3) {
        // MaxMtn: triggered when parameter reaches max
        if (item.maxMtn && atMax) {
          const [group, idxStr] = item.maxMtn.split(':');
          console.log(`[motion] drag MaxMtn on ${item.hitArea}: ${group}` + (idxStr !== undefined ? `:${idxStr}` : ''));
          currentModel.motion(group, idxStr !== undefined ? parseInt(idxStr) : undefined);
        }
        // MinMtn: triggered when parameter reaches min (legacy format)
        if (item.minMtn && atMin) {
          const [group, idxStr] = item.minMtn.split(':');
          console.log(`[motion] drag MinMtn on ${item.hitArea}: ${group}` + (idxStr !== undefined ? `:${idxStr}` : ''));
          currentModel.motion(group, idxStr !== undefined ? parseInt(idxStr) : undefined);
        }
      }
    }
    // EndMtn: triggered when drag ends (regardless of extremes)
    if (item.endMtn) {
      const [group, idxStr] = item.endMtn.split(':');
      console.log(`[motion] drag EndMtn on ${item.hitArea}: ${group}` + (idxStr !== undefined ? `:${idxStr}` : ''));
      currentModel.motion(group, idxStr !== undefined ? parseInt(idxStr) : undefined);
    }
    // ReleaseType 0 and 1: spring back to default value
    // ReleaseType 2 and 3: stay at current value (sticky/persistent)
    if ((item.releaseType === 0 || item.releaseType === 1) && paramIndex >= 0) {
      const coreModel = currentModel.internalModel.coreModel;
      // Speed: 1 / (duration_ms / frame_ms) where frame_ms ≈ 16.67 at 60fps
      const speed = item.releaseDuration > 0 ? 1 / (item.releaseDuration / 16.67) : 0.05;
      paramReleaseAnims.push({
        paramIndex,
        from: currentValue,
        target: coreModel.getParameterDefaultValue(paramIndex),
        speed,
        t: 0,
      });
    }
  }
  paramDragging = null;
  updateInputRegion();
}

function handleDragRelease(e) {
  if (dragScrubState) {
    if (dragScrubState.entry) {
      // Check if pointer is outside the original hit area → complete; inside → revert
      const hitNames = e ? currentModel.hitTest(e.global.x, e.global.y) : [];
      const insideHitArea = hitNames.includes(dragScrubState.hitArea);
      const progress = dragScrubState.progress;
      const item = dragScrubState.item;
      const releaseType = item?.releaseType ?? 0;
      if (!insideHitArea && progress > 0) {
        // Released outside hit area — let motion play to completion
        console.log(`[motion] drag scrub complete: progress=${progress.toFixed(2)}, released outside ${dragScrubState.hitArea}`);
        if (dragScrubState.duration > 0) {
          const entry = dragScrubState.entry;
          entry.setEndTime(entry.getStartTime() + dragScrubState.duration);
        }
      } else if (releaseType === 2 || releaseType === 3) {
        // Stay/sticky: let motion continue from current position
        console.log(`[motion] drag scrub stay: progress=${progress.toFixed(2)}, releaseType=${releaseType}`);
        if (dragScrubState.duration > 0) {
          const entry = dragScrubState.entry;
          entry.setEndTime(entry.getStartTime() + dragScrubState.duration);
        }
      } else {
        // Spring back (type 0/1): revert (stop the motion)
        console.log(`[motion] drag scrub reverted: progress=${progress.toFixed(2)}, released inside ${dragScrubState.hitArea}`);
        dragScrubState.entry.setIsFinished(true);
        pendingNextMtn = null;
      }
    } else {
      console.log('[motion] drag scrub cancelled (motion not loaded)');
    }
    // EndMtn: triggered when drag scrub ends
    if (dragScrubState.item?.endMtn) {
      const [group, idxStr] = dragScrubState.item.endMtn.split(':');
      console.log(`[motion] drag scrub EndMtn on ${dragScrubState.hitArea}: ${group}` + (idxStr !== undefined ? `:${idxStr}` : ''));
      currentModel.motion(group, idxStr !== undefined ? parseInt(idxStr) : undefined);
    }
    dragScrubState = null;
    dragging = false;
    // keep dragMoved = true to suppress pointertap after scrub
    updateInputRegion();
    return;
  }
  dragging = false;
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
  paramHitItems = [];
  paramLoopItems = [];
  dragScrubState = null;
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
          const item = paramHitItems.find(i => i.hitArea === name);
          if (!item) continue;
          if (disabledParamHitItems.has(item.hitArea)) continue;
          if (item.paramIndex >= 0) {
            // Real parameter: drag to control parameter value
            console.log(`[touch] pointerdown on ParamHit area: ${item.hitArea} (param: ${item.paramId})`);
            const coreModel = model.internalModel.coreModel;
            const startValue = coreModel.getParameterValueByIndex(item.paramIndex);
            paramDragging = {
              item,
              startPos: item.axis === 0 ? e.global.x : e.global.y,
              paramIndex: item.paramIndex,
              startValue,
              currentValue: startValue,
            };
            // Cancel any running release animation for this parameter
            paramReleaseAnims = paramReleaseAnims.filter(a => a.paramIndex !== item.paramIndex);
            dragMoved = false;
            dragStart.x = e.global.x;
            dragStart.y = e.global.y;
            setFullInputRegion();
            return;
          } else if (item.maxMtn) {
            // Virtual parameter: drag scrub MaxMtn animation
            console.log(`[touch] pointerdown on ParamHit area: ${item.hitArea} (virtual param, scrub ${item.maxMtn})`);
            const [group, idxStr] = item.maxMtn.split(':');
            const arrayIdx = idxStr !== undefined ? parseInt(idxStr) : undefined;
            dragScrubState = { entry: null, duration: 0, progress: 0, hitArea: item.hitArea, ready: false, item, beginFired: false };
            model.motion(group, arrayIdx).then(() => {
              if (dragScrubState) dragScrubState.ready = true;
            });
            pendingNextMtn = (arrayIdx !== undefined && motionNextMap[group]?.[arrayIdx]) || null;
            dragging = true;
            dragMoved = true; // suppress pointertap
            dragStart.x = e.global.x;
            dragStart.y = e.global.y;
            setFullInputRegion();
            return;
          }
        }
      }

      // Record hit areas for drag-motion detection
      dragHitNames = sortHitNames(model.hitTest(e.global.x, e.global.y));
      dragMotionTriggered = false;
      dragStart.x = e.global.x;
      dragStart.y = e.global.y;

      // Trigger convention-based drag motions (hitMotionMap drag groups)
      if (tapMotion) {
        triggerDragMotions();
      }
      if (dragScrubState) {
        console.log(`[touch] pointerdown — drag scrub started on [${dragHitNames.join(', ')}]`);
        dragging = true;
        dragMoved = true; // suppress pointertap
        setFullInputRegion();
        return;
      }

      console.log(`[touch] pointerdown — drag hit areas: [${dragHitNames.join(', ')}]`);
      dragging = true;
      dragMoved = false;
      dragOffset.x = e.global.x - model.x;
      dragOffset.y = e.global.y - model.y;
      setFullInputRegion();
    });

    // Tap to trigger motions (gated by tapMotion toggle)
    // Build motion name→index and NextMtn maps from raw model JSON
    const rawJson = model.internalModel.settings.json;
    const rawHitAreas = rawJson.HitAreas || rawJson.hitAreas || rawJson.hit_areas || [];
    buildMotionMaps(rawJson);
    modelMotions = rawJson.FileReferences?.Motions || rawJson.motions || {};

    // Load custom motion overrides from settings
    currentModelPath = modelPath.replace('model://localhost/', '');
    let customJsonStr = null;
    try {
      customJsonStr = await invoke('get_custom_motions', { path: currentModelPath });
    } catch {}
    buildHitMotionMap(rawHitAreas, customJsonStr);
    pendingNextMtn = null;

    // Parse controllers
    const controllers = rawJson.Controllers || rawJson.controllers || {};

    // Parse ParamHit controller items (drag-to-control-parameter hit areas)
    // Falls back to legacy top-level HitParams when Controllers.ParamHit is absent
    const paramHitConfig = controllers.ParamHit || controllers.paramHit || {};
    const paramHitEnabled = paramHitConfig.Enabled !== false && paramHitConfig.enabled !== false;
    const paramHitRawItems = paramHitEnabled
      ? (paramHitConfig.Items || paramHitConfig.items || [])
      : [];
    // Legacy fallback: top-level HitParams (older model format)
    const hitParamItems = paramHitRawItems.length > 0
      ? paramHitRawItems
      : (rawJson.HitParams || []);
    {
      const coreModel = model.internalModel.coreModel;
      const paramCount = coreModel.getParameterCount();
      for (const item of hitParamItems) {
        if (item.Enabled === false) continue;
        const paramId = item.Id || item.id;
        const rawIdx = coreModel.getParameterIndex(paramId);
        const paramIndex = rawIdx < paramCount ? rawIdx : -1;
        paramHitItems.push({
          hitArea: item.HitArea || item.hitArea,
          paramId,
          paramIndex, // -1 if parameter doesn't exist in moc3
          axis: item.Axis ?? 0,
          factor: item.Factor ?? 0.04,
          releaseType: item.ReleaseType ?? 0,
          releaseDuration: item.Release ?? 500, // ms, used for spring-back animation speed
          lockParam: item.LockParam ?? false,
          maxMtn: item.MaxMtn ? resolveMaxMtn(rawJson, item.MaxMtn) : null,
          minMtn: item.MinMtn ? resolveMotionRef(item.MinMtn) : null,
          beginMtn: item.BeginMtn ? resolveMotionRef(item.BeginMtn) : null,
          endMtn: item.EndMtn ? resolveMotionRef(item.EndMtn) : null,
        });
      }
    }

    // Parse ParamLoop controller items (auto-oscillating parameters)
    // Falls back to legacy top-level LoopParams when Controllers.ParamLoop is absent
    const paramLoopConfig = controllers.ParamLoop || controllers.paramLoop || {};
    const paramLoopEnabled = paramLoopConfig.Enabled !== false && paramLoopConfig.enabled !== false;
    const paramLoopRawItems = paramLoopEnabled
      ? (paramLoopConfig.Items || paramLoopConfig.items || [])
      : [];
    const loopParamItems = paramLoopRawItems.length > 0
      ? paramLoopRawItems
      : (rawJson.LoopParams || []);
    {
      const coreModel = model.internalModel.coreModel;
      const loopParamCount = coreModel.getParameterCount();
      for (const item of loopParamItems) {
        if (item.Enabled === false) continue;
        // Support both Id (single) and Ids (array) formats
        const ids = item.Ids || (item.Id ? [item.Id] : []);
        for (const paramId of ids) {
          if (!paramId) continue;
          const rawLoopIdx = coreModel.getParameterIndex(paramId);
          const paramIndex = rawLoopIdx < loopParamCount ? rawLoopIdx : -1;
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
        const rawIdx = coreModel.getParameterIndex(paramId);
        const paramIndex = rawIdx < paramCount ? rawIdx : -1;
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
          const rawIdx = coreModel.getParameterIndex(paramId);
          if (rawIdx < paramCount) {
            coreModel.setParameterValueByIndex(rawIdx, value);
            lockedParams[paramId] = { paramIndex: rawIdx, value, startTime: performance.now(), duration: 0 };
          }
        }
      }
    }

    // Parse ExtraMotion controller
    const extraMotionConfig = controllers.ExtraMotion || {};
    extraMotionEnabled = extraMotionConfig.Enabled === true || rawJson.ExtraMotion === true;

    // Parse IntimacySystem controller
    const intimacySystem = controllers.IntimacySystem || rawJson.IntimacyParam || {};
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
      // Drag motion scrubbing: find queue entry once model.motion() Promise resolved
      if (dragScrubState && !dragScrubState.entry && dragScrubState.ready) {
        const entries = model.internalModel.motionManager.queueManager.getCubismMotionQueueEntries();
        for (let i = 0; i < entries.getSize(); i++) {
          const entry = entries.at(i);
          if (entry && entry._motion && !entry.isFinished()) {
            dragScrubState.entry = entry;
            const dur = entry._motion.getDuration();
            dragScrubState.duration = dur > 0 ? dur : entry._motion.getLoopDuration();
            entry.setEndTime(-1);
            console.log(`[motion] drag scrub entry found: duration=${dragScrubState.duration.toFixed(3)}s`);
            break;
          }
        }
      }
      // Drag motion scrubbing: freeze motion at desired progress before update
      if (dragScrubState && dragScrubState.entry && !dragScrubState.entry.isFinished()) {
        const now = args[1]; // time in seconds (converted by CubismInternalModel)
        const targetTime = dragScrubState.progress * dragScrubState.duration;
        dragScrubState.entry.setStartTime(now - targetTime);
        dragScrubState.entry.setEndTime(-1); // prevent auto-finish every frame
      }
      origMotionUpdate.apply(this, args);
      const cm = model.internalModel.coreModel;
      if (paramDragging && paramDragging.paramIndex >= 0) {
        cm.setParameterValueByIndex(paramDragging.paramIndex, paramDragging.currentValue);
      }
      for (const anim of paramReleaseAnims) {
        anim.t = Math.min(1, anim.t + (anim.speed || 0.05));
        const v = anim.from + (anim.target - anim.from) * anim.t;
        cm.setParameterValueByIndex(anim.paramIndex, v);
      }
      paramReleaseAnims = paramReleaseAnims.filter(a => a.t < 1);

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
          if (paramDragging?.item?.lockParam && loop.paramIndex === paramDragging.paramIndex) continue;
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
      if (fileLoopMap[group]?.[index]) {
        motion.setLoop(true);
        motion.setLoopFadeIn(false);
      }
      const entry = motionEntryMap[group]?.[index];
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
      for (const name of hitAreaNames) {
        const mapped = hitMotionMap[name];
        // Custom override: __none__ means do nothing
        if (mapped === '__none__') { console.log(`[touch] ${name}: skipped (__none__)`); continue; }
        // Skip drag-type motions — they trigger on drag, not tap
        if (isDragMotion(mapped)) { console.log(`[touch] ${name}: skipped (drag motion: ${mapped})`); continue; }
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
          if (modelMotions[g]) {
            playMotion(g);
            found = true;
            break;
          }
        }
        if (found) return;
        // If no convention matched, still try direct calls as fallback
        pendingNextMtn = null;
        currentModel.motion('tap_' + name);
        currentModel.motion(name);
        currentModel.motion('Tap' + name);
        if (stripped !== name) currentModel.motion(stripped.toLowerCase());
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

    currentModel = model;
    showBorder = config.show_border;
    showHitAreas = config.show_hit_areas;
    lockModel = config.lock_model;
    mouseTracking = config.mouse_tracking;
    model.automator.autoFocus = mouseTracking;

    updateBorder();
    updateInputRegion();

    // Detect idle and start motion groups
    const motions = rawJson.FileReferences?.Motions || rawJson.motions || {};
    idleGroup = motions['Idle'] ? 'Idle' : motions['idle'] ? 'idle' : null;

    const startGroup = motions['Start'] ? 'Start' : motions['start'] ? 'start' : null;
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
