import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display';

// Expose PIXI globally for pixi-live2d-display
window.PIXI = PIXI;

const canvas = document.getElementById('canvas');

// Debug overlay for showing errors visually
const debugEl = document.createElement('div');
debugEl.style.cssText =
  'position:fixed;top:0;left:0;right:0;color:#0f0;background:rgba(0,0,0,0.7);' +
  'font:11px monospace;padding:4px 8px;white-space:pre-wrap;pointer-events:none;z-index:9999;max-height:50%;overflow:auto;';
document.body.appendChild(debugEl);

function debugLog(msg) {
  console.log('[rive2d]', msg);
  debugEl.textContent += msg + '\n';
}

// Check SDK availability
debugLog('Live2D (Cubism2): ' + (typeof window.Live2D !== 'undefined' ? 'OK' : 'MISSING'));
debugLog('Live2DCubismCore (Cubism4): ' + (typeof window.Live2DCubismCore !== 'undefined' ? 'OK' : 'MISSING'));

const app = new PIXI.Application({
  view: canvas,
  backgroundAlpha: 0,
  backgroundColor: 0x000000,
  resizeTo: window,
  antialias: true,
});

let currentModel = null;

function applyBorder(show) {
  if (show) {
    canvas.style.border = '2px solid red';
    canvas.style.boxSizing = 'border-box';
  } else {
    canvas.style.border = 'none';
  }
}

async function loadModel(modelPath) {
  debugLog('loadModel: ' + modelPath);

  if (currentModel) {
    app.stage.removeChild(currentModel);
    currentModel.destroy();
    currentModel = null;
  }

  try {
    const model = await Live2DModel.from(modelPath, {
      autoInteract: true,
    });
    debugLog('Model created: ' + model.width + 'x' + model.height);

    const scaleX = app.screen.width / model.width;
    const scaleY = app.screen.height / model.height;
    const scale = Math.min(scaleX, scaleY) * 0.8;
    model.scale.set(scale);

    model.anchor.set(0.5, 0.5);
    model.x = app.screen.width / 2;
    model.y = app.screen.height / 2;

    app.stage.addChild(model);
    currentModel = model;

    model.on('hit', (hitAreaNames) => {
      if (hitAreaNames.includes('Body') || hitAreaNames.includes('body')) {
        model.motion('tap_body');
      }
      if (hitAreaNames.includes('Head') || hitAreaNames.includes('head')) {
        model.expression();
      }
    });

    debugLog('Model loaded OK');
  } catch (err) {
    debugLog('ERROR: ' + err.message);
    debugLog(err.stack || '');
  }
}

// Load initial config for border setting
window.__TAURI__.core.invoke('get_config').then((config) => {
  applyBorder(config.show_border);
}).catch(() => {});

// Listen for model loading events from backend
window.__TAURI__.event.listen('load-model', (event) => {
  debugLog('Event payload: ' + event.payload);
  // Use custom model:// protocol to bypass asset protocol scope issues
  const modelUrl = 'model://localhost/' + event.payload;
  debugLog('Model URL: ' + modelUrl);
  loadModel(modelUrl);
});

// Listen for setting changes from config window
window.__TAURI__.event.listen('setting-changed', (event) => {
  const [key, value] = event.payload;
  if (key === 'show_border') {
    applyBorder(value === 'true');
  }
});

// Handle window resize
window.addEventListener('resize', () => {
  if (currentModel) {
    currentModel.x = app.screen.width / 2;
    currentModel.y = app.screen.height / 2;
  }
});
