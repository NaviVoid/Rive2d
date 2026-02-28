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
let pendingNextMtn = null;
let currentModelPath = null;
let dragging = false;
let dragMoved = false;
let dragStart = { x: 0, y: 0 };
let dragOffset = { x: 0, y: 0 };
const DRAG_THRESHOLD = 4; // px — ignore micro-movements for tap detection
let paramHitItems = [];      // ParamHit controller items parsed from model JSON
let paramDragging = null;    // { item, startPos, paramIndex, startValue, currentValue }
let paramReleaseAnims = [];  // parameter reset animations after drag release

// Graphics overlays (drawn on top of model)
const borderGfx = new PIXI.Graphics();
const hitAreaGfx = new PIXI.Graphics();
const hitAreaContainer = new PIXI.Container();
hitAreaContainer.addChild(hitAreaGfx);
const hitAreaLabels = []; // pool of PIXI.Text for hit area names

// init() is async; listeners registered before it so events aren't missed
const ready = app.init({
  canvas,
  backgroundAlpha: 0,
  backgroundColor: 0x000000,
  resizeTo: window,
  antialias: true,
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
      }
      const { item, startPos, startValue } = paramDragging;
      const currentPos = item.axis === 0 ? e.global.x : e.global.y;
      paramDragging.currentValue = startValue + (currentPos - startPos) * item.factor;
      return;
    }
    // Model drag — move position
    if (!dragging || !currentModel) return;
    if (!dragMoved) {
      const dx = e.global.x - dragStart.x;
      const dy = e.global.y - dragStart.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      dragMoved = true;
    }
    currentModel.x = e.global.x - dragOffset.x;
    currentModel.y = e.global.y - dragOffset.y;
    updateBorder();
  });

  app.stage.on('pointerup', () => {
    if (paramDragging && currentModel) {
      handleParamHitRelease();
      return;
    }
    if (dragging && currentModel) {
      dragging = false;
      savePosition();
      updateInputRegion();
    }
  });

  app.stage.on('pointerupoutside', () => {
    if (paramDragging && currentModel) {
      handleParamHitRelease();
      return;
    }
    if (dragging && currentModel) {
      dragging = false;
      savePosition();
      updateInputRegion();
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
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
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
  currentModel.motion(group, index ?? undefined);
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
    pendingNextMtn = null;
    paramHitItems = [];
    paramDragging = null;
    paramReleaseAnims = [];
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

// Build motionNameToIndex and motionNextMap from raw model JSON
function buildMotionMaps(rawJson) {
  const motions = rawJson.FileReferences?.Motions || rawJson.motions || {};
  motionNameToIndex = {};
  motionNextMap = {};
  for (const [group, entries] of Object.entries(motions)) {
    if (!Array.isArray(entries)) continue;
    motionNameToIndex[group] = {};
    motionNextMap[group] = {};
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].Name) motionNameToIndex[group][entries[i].Name] = i;
      if (entries[i].NextMtn) motionNextMap[group][i] = entries[i].NextMtn;
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

// Build hitMotionMap from raw hit areas + optional custom overrides JSON
function buildHitMotionMap(rawHitAreas, customJson) {
  hitMotionMap = {};
  for (const h of rawHitAreas) {
    const n = h.Name || h.name;
    if (n && h.Motion) hitMotionMap[n] = resolveMotionRef(h.Motion);
  }
  if (customJson) Object.assign(hitMotionMap, JSON.parse(customJson));
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

function handleParamHitRelease() {
  const { item, paramIndex, currentValue, startValue } = paramDragging;
  if (dragMoved) {
    if (item.maxMtn) {
      const coreModel = currentModel.internalModel.coreModel;
      const max = coreModel.getParameterMaximumValue(paramIndex);
      const min = coreModel.getParameterMinimumValue(paramIndex);
      const range = max - min;
      // Check both extremes — factor sign determines drag direction
      const atMax = currentValue >= max - range * 0.1;
      const atMin = currentValue <= min + range * 0.1;
      // Only trigger if the user actually dragged toward that extreme
      const moved = Math.abs(currentValue - startValue);
      if (range > 0 && (atMax || atMin) && moved > range * 0.3) {
        const [group, idxStr] = item.maxMtn.split(':');
        currentModel.motion(group, idxStr !== undefined ? parseInt(idxStr) : undefined);
      }
    }
    if (item.releaseType === 0) {
      const coreModel = currentModel.internalModel.coreModel;
      paramReleaseAnims.push({
        paramIndex,
        from: currentValue,
        target: coreModel.getParameterDefaultValue(paramIndex),
        t: 0,
      });
    }
  }
  paramDragging = null;
  updateInputRegion();
}

// --- Model loading ---

async function loadModel(modelPath) {
  // Reset drag state so stale flags don't block taps on the new model
  dragging = false;
  dragMoved = false;
  paramDragging = null;
  paramReleaseAnims = [];
  paramHitItems = [];

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

    // Drag start (left button only, gated by lock model toggle)
    model.on('pointerdown', (e) => {
      if (lockModel || e.button !== 0) return;

      // Check for ParamHit drag areas first
      if (paramHitItems.length > 0) {
        const hitNames = model.hitTest(e.global.x, e.global.y);
        for (const item of paramHitItems) {
          if (hitNames.includes(item.hitArea)) {
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
          }
        }
      }

      dragging = true;
      dragMoved = false;
      dragStart.x = e.global.x;
      dragStart.y = e.global.y;
      dragOffset.x = e.global.x - model.x;
      dragOffset.y = e.global.y - model.y;
      setFullInputRegion();
    });

    // Tap to trigger motions (gated by tapMotion toggle)
    // Build motion name→index and NextMtn maps from raw model JSON
    const rawJson = model.internalModel.settings.json;
    const rawHitAreas = rawJson.HitAreas || rawJson.hitAreas || rawJson.hit_areas || [];
    buildMotionMaps(rawJson);

    // Load custom motion overrides from settings
    currentModelPath = modelPath.replace('model://localhost/', '');
    let customJsonStr = null;
    try {
      customJsonStr = await invoke('get_custom_motions', { path: currentModelPath });
    } catch {}
    buildHitMotionMap(rawHitAreas, customJsonStr);
    pendingNextMtn = null;

    // Parse ParamHit controller items (drag-to-control-parameter hit areas)
    const controllers = rawJson.Controllers || rawJson.controllers || {};
    const paramHitConfig = controllers.ParamHit || controllers.paramHit || {};
    if (paramHitConfig.Enabled !== false && paramHitConfig.enabled !== false) {
      const items = paramHitConfig.Items || paramHitConfig.items || [];
      const coreModel = model.internalModel.coreModel;
      for (const item of items) {
        const paramId = item.Id || item.id;
        const paramIndex = coreModel.getParameterIndex(paramId);
        if (paramIndex < 0) continue;
        paramHitItems.push({
          hitArea: item.HitArea || item.hitArea,
          paramId,
          paramIndex,
          axis: item.Axis ?? 0,
          factor: item.Factor ?? 0.04,
          releaseType: item.ReleaseType ?? 0,
          lockParam: item.LockParam ?? false,
          maxMtn: item.MaxMtn ? resolveMaxMtn(rawJson, item.MaxMtn) : null,
        });
      }
    }

    // Override motionManager.update to apply paramHit values at the right
    // point in the update cycle (after motions, before physics/coreModel.update)
    const origMotionUpdate = model.internalModel.motionManager.update;
    model.internalModel.motionManager.update = function (...args) {
      origMotionUpdate.apply(this, args);
      const cm = model.internalModel.coreModel;
      if (paramDragging) {
        cm.setParameterValueByIndex(paramDragging.paramIndex, paramDragging.currentValue);
      }
      for (const anim of paramReleaseAnims) {
        anim.t = Math.min(1, anim.t + 0.05);
        const v = anim.from + (anim.target - anim.from) * anim.t;
        cm.setParameterValueByIndex(anim.paramIndex, v);
      }
      paramReleaseAnims = paramReleaseAnims.filter(a => a.t < 1);
    };

    // NextMtn chaining: when a motion finishes, play its NextMtn if set
    model.internalModel.motionManager.on('motionFinish', () => {
      if (pendingNextMtn) {
        const mtn = pendingNextMtn;
        pendingNextMtn = null;
        const resolved = resolveMotionRef(mtn);
        const [group, idxStr] = resolved.split(':');
        model.motion(group, idxStr !== undefined ? parseInt(idxStr) : undefined);
      }
    });

    model.on('pointertap', (e) => {
      if (!tapMotion || dragMoved) return;
      const hitAreaNames = model.hitTest(e.global.x, e.global.y);
      for (const name of hitAreaNames) {
        const mapped = hitMotionMap[name];
        // Custom override: __none__ means do nothing
        if (mapped === '__none__') continue;
        // Explicit mapping (from model JSON or custom override)
        if (mapped) {
          const [group, idxStr] = mapped.split(':');
          const arrayIdx = idxStr !== undefined ? parseInt(idxStr) : undefined;
          model.motion(group, arrayIdx);
          // Queue NextMtn if this motion has one
          pendingNextMtn = (arrayIdx !== undefined && motionNextMap[group]?.[arrayIdx]) || null;
          continue;
        }
        // Convention fallbacks (only when no explicit mapping)
        pendingNextMtn = null;
        // Cubism 2: hit area "body" → motion "tap_body"
        model.motion('tap_' + name);
        // Direct: name as motion group
        model.motion(name);
        // Cubism 3/4: hit area "摸头" → motion "Tap摸头"
        model.motion('Tap' + name);
        // Strip "Touch" prefix: "TouchBody" → "body"
        const stripped = name.replace(/^Touch/i, '');
        if (stripped !== name) {
          model.motion(stripped.toLowerCase());
        }
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

    // Play start motion if the model has one
    const motions = rawJson.FileReferences?.Motions || rawJson.motions || {};
    const startGroup = motions['Start'] ? 'Start' : motions['start'] ? 'start' : null;
    if (startGroup) {
      model.motion(startGroup, 0, 1); // priority IDLE so taps can interrupt
    }
  } catch (err) {
    console.error('[rive2d] Failed to load model:', err);
  }
}
