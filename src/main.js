import * as PIXI from 'pixi.js';
import { Live2DModel } from 'untitled-pixi-live2d-engine';

// Expose PIXI globally for pixi-live2d-display
window.PIXI = PIXI;

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

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
let dragging = false;
let dragOffset = { x: 0, y: 0 };

// Border graphics overlay (drawn on top of model)
const borderGfx = new PIXI.Graphics();

// init() is async; listeners registered before it so events aren't missed
const ready = app.init({
  canvas,
  backgroundAlpha: 0,
  backgroundColor: 0x000000,
  resizeTo: window,
  antialias: true,
  preference: 'webgl',   // WebKitGTK has no WebGPU
}).then(() => {
  app.stage.addChild(borderGfx);

  // Make stage interactive for drag move/up events
  app.stage.eventMode = 'static';
  app.stage.hitArea = new PIXI.Rectangle(0, 0, app.screen.width, app.screen.height);

  // --- Drag: move & end (on stage to capture events outside model) ---

  app.stage.on('pointermove', (e) => {
    if (!dragging || !currentModel) return;
    currentModel.x = e.global.x - dragOffset.x;
    currentModel.y = e.global.y - dragOffset.y;
    updateBorder();
  });

  app.stage.on('pointerup', () => {
    if (dragging && currentModel) {
      dragging = false;
      savePosition();
      updateInputRegion();
    }
  });

  app.stage.on('pointerupoutside', () => {
    if (dragging && currentModel) {
      dragging = false;
      savePosition();
      updateInputRegion();
    }
  });

  // --- Scroll wheel resize ---

  app.canvas.addEventListener('wheel', (e) => {
    if (!currentModel) return;
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
}).catch(() => {});

listen('load-model', async (event) => {
  await ready;
  const modelUrl = 'model://localhost/' + event.payload;
  loadModel(modelUrl);
});

listen('reset-position', async () => {
  await ready;
  if (!currentModel) return;
  // Get unscaled dimensions (width/height are affected by current scale)
  const origW = currentModel.width / currentModel.scale.x;
  const origH = currentModel.height / currentModel.scale.y;
  const scaleX = app.screen.width / origW;
  const scaleY = app.screen.height / origH;
  currentModel.scale.set(Math.min(scaleX, scaleY) * 0.3);
  currentModel.x = app.screen.width / 2;
  currentModel.y = app.screen.height / 2;
  updateBorder();
  updateInputRegion();
});

listen('setting-changed', (event) => {
  const [key, value] = event.payload;
  if (key === 'show_border') {
    showBorder = value === 'true';
    updateBorder();
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

// --- Model loading ---

async function loadModel(modelPath) {
  if (currentModel) {
    app.stage.removeChild(currentModel);
    currentModel.destroy();
    currentModel = null;
  }

  try {
    const model = await Live2DModel.from(modelPath, {
      autoHitTest: true,
      autoFocus: true,
    });

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

    // Drag start
    model.on('pointerdown', (e) => {
      dragging = true;
      dragOffset.x = e.global.x - model.x;
      dragOffset.y = e.global.y - model.y;
      setFullInputRegion();
    });

    // Hit areas for animations
    model.on('hit', (hitAreaNames) => {
      if (hitAreaNames.includes('Body') || hitAreaNames.includes('body')) {
        model.motion('tap_body');
      }
      if (hitAreaNames.includes('Head') || hitAreaNames.includes('head')) {
        model.expression();
      }
    });

    app.stage.addChild(model);

    // Keep border graphics on top
    app.stage.removeChild(borderGfx);
    app.stage.addChild(borderGfx);

    currentModel = model;
    showBorder = config.show_border;

    updateBorder();
    updateInputRegion();
  } catch (err) {
    console.error('[rive2d] Failed to load model:', err);
  }
}
