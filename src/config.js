import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

let selectedPath = null;

const pathInput = document.getElementById('model-path');
const browseBtn = document.getElementById('browse-btn');
const applyBtn = document.getElementById('apply-btn');
const recentList = document.getElementById('recent-list');

async function loadConfig() {
  const config = await invoke('get_config');

  if (config.current_model) {
    pathInput.value = config.current_model;
    selectedPath = config.current_model;
    applyBtn.disabled = false;
  }

  recentList.innerHTML = '';
  for (const model of config.recent_models) {
    const li = document.createElement('li');
    li.textContent = model;
    li.addEventListener('click', () => selectModel(model));
    recentList.appendChild(li);
  }
}

function selectModel(path) {
  selectedPath = path;
  pathInput.value = path;
  applyBtn.disabled = false;

  // Highlight selected in recent list
  for (const li of recentList.children) {
    li.classList.toggle('selected', li.textContent === path);
  }
}

browseBtn.addEventListener('click', async () => {
  const selected = await open({
    multiple: false,
    filters: [{
      name: 'Live2D Model',
      extensions: ['json']
    }]
  });

  if (selected) {
    selectModel(selected);
  }
});

applyBtn.addEventListener('click', async () => {
  if (selectedPath) {
    await invoke('apply_model', { path: selectedPath });
  }
});

loadConfig();
