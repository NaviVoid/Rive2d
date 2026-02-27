import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';
import { open } from '@tauri-apps/plugin-dialog';

// Expose PIXI globally for pixi-live2d-display
window.PIXI = PIXI;

const app = new PIXI.Application({
  view: document.getElementById('canvas'),
  backgroundAlpha: 0,
  backgroundColor: 0x000000,
  resizeTo: window,
  antialias: true,
});

let currentModel = null;

async function loadModel(modelPath) {
  if (currentModel) {
    app.stage.removeChild(currentModel);
    currentModel.destroy();
    currentModel = null;
  }

  try {
    const model = await Live2DModel.from(modelPath, {
      autoInteract: true,
    });

    // Scale model to fit canvas
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

    console.log('Model loaded:', modelPath);
  } catch (err) {
    console.error('Failed to load model:', err);
  }
}

// File picker for loading custom models
async function pickAndLoadModel() {
  const { convertFileSrc } = window.__TAURI__.core;

  const selected = await open({
    multiple: false,
    filters: [{
      name: 'Live2D Model',
      extensions: ['json']
    }]
  });

  if (selected) {
    const modelUrl = convertFileSrc(selected);
    loadModel(modelUrl);
  }
}

// Double-click canvas to open file picker
document.getElementById('canvas').addEventListener('dblclick', () => {
  pickAndLoadModel();
});

// Listen for model loading events from backend
window.__TAURI__.event.listen('load-model', (event) => {
  const { convertFileSrc } = window.__TAURI__.core;
  const modelUrl = convertFileSrc(event.payload);
  loadModel(modelUrl);
});

// Handle window resize
window.addEventListener('resize', () => {
  if (currentModel) {
    currentModel.x = app.screen.width / 2;
    currentModel.y = app.screen.height / 2;
  }
});
