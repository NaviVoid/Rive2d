<script setup>
import { ref, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

const models = ref([]);
const currentModel = ref(null);
const showBorder = ref(false);

async function refreshConfig() {
  try {
    const config = await invoke('get_config');
    models.value = config.models;
    currentModel.value = config.current_model;
    showBorder.value = config.show_border;
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

async function importModel() {
  const selected = await open({
    multiple: false,
    filters: [
      { name: 'Live2D Package', extensions: ['lpk'] },
      { name: 'Live2D Model JSON', extensions: ['json'] },
    ],
  });
  if (selected) {
    await invoke('add_model', { path: selected });
    await refreshConfig();
  }
}

async function loadModel(path) {
  await invoke('apply_model', { path });
  await refreshConfig();
}

async function removeModel(path) {
  await invoke('remove_model', { path });
  await refreshConfig();
}

async function toggleBorder() {
  showBorder.value = !showBorder.value;
  await invoke('set_setting', {
    key: 'show_border',
    value: showBorder.value ? 'true' : 'false',
  });
}

function fileName(path) {
  return path.split('/').pop();
}

function dirPath(path) {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

onMounted(refreshConfig);
</script>

<template>
  <div class="container">
    <header>
      <h1>Rive2d Settings</h1>
      <button class="import-btn" @click="importModel">+ Import Model</button>
    </header>

    <section class="model-list" v-if="models.length > 0">
      <div
        v-for="model in models"
        :key="model"
        class="model-card"
        :class="{ active: model === currentModel }"
      >
        <div class="model-info">
          <span class="model-name">{{ fileName(model) }}</span>
          <span class="model-dir">{{ dirPath(model) }}</span>
        </div>
        <div class="model-actions">
          <span v-if="model === currentModel" class="badge">Active</span>
          <button v-else class="load-btn" @click="loadModel(model)">Load</button>
          <button class="remove-btn" @click="removeModel(model)">Remove</button>
        </div>
      </div>
    </section>

    <section class="empty-state" v-else>
      <p>No models imported yet.</p>
      <p class="hint">Click "Import Model" to add a Live2D model file.</p>
    </section>

    <footer>
      <div class="setting-row" @click="toggleBorder">
        <span class="setting-label">Show debug border</span>
        <div class="toggle" :class="{ on: showBorder }">
          <div class="toggle-knob" />
        </div>
      </div>
    </footer>
  </div>
</template>

<style>
html, body {
  margin: 0;
  padding: 0;
  height: 100%;
}
</style>

<style scoped>
.container {
  font-family: system-ui, -apple-system, sans-serif;
  background: #1e1e2e;
  color: #cdd6f4;
  min-height: 100vh;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

h1 {
  font-size: 20px;
  font-weight: 600;
}

button {
  border: none;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.2s;
}

.import-btn {
  padding: 8px 16px;
  background: #89b4fa;
  color: #1e1e2e;
  font-weight: 600;
}

.import-btn:hover {
  background: #74c7ec;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  flex: 1;
}

.model-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #313244;
  border: 1px solid #45475a;
  border-radius: 8px;
  transition: border-color 0.2s;
}

.model-card.active {
  border-color: #89b4fa;
}

.model-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.model-name {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-dir {
  font-size: 11px;
  color: #6c7086;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 12px;
  flex-shrink: 0;
}

.badge {
  padding: 4px 10px;
  background: rgba(137, 180, 250, 0.13);
  color: #89b4fa;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.load-btn {
  padding: 6px 12px;
  background: #45475a;
  color: #cdd6f4;
}

.load-btn:hover {
  background: #585b70;
}

.remove-btn {
  padding: 6px 12px;
  background: transparent;
  color: #6c7086;
}

.remove-btn:hover {
  background: #45475a;
  color: #f38ba8;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #6c7086;
}

.empty-state p {
  font-size: 14px;
}

.hint {
  font-size: 12px;
  color: #585b70;
}

footer {
  border-top: 1px solid #313244;
  padding-top: 16px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  padding: 8px 0;
  user-select: none;
}

.setting-label {
  font-size: 13px;
  color: #a6adc8;
}

.toggle {
  width: 36px;
  height: 20px;
  background: #45475a;
  border-radius: 10px;
  position: relative;
  transition: background 0.2s;
}

.toggle.on {
  background: #89b4fa;
}

.toggle-knob {
  width: 16px;
  height: 16px;
  background: #cdd6f4;
  border-radius: 50%;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.2s;
}

.toggle.on .toggle-knob {
  transform: translateX(16px);
}
</style>
