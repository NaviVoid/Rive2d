<script setup>
import { ref, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

const activeTab = ref('models');
const models = ref([]);
const currentModel = ref(null);
const showBorder = ref(false);
const tapMotion = ref(true);
const showHitAreas = ref(false);
const lockModel = ref(false);
const mouseTracking = ref(true);
const previews = ref({});

// Detail view state
const detailModel = ref(null);   // path being edited, null = list view
const modelInfo = ref(null);     // from get_model_info
const editName = ref('');
const editMotions = ref({});     // { hitAreaName: motionGroup }
const customNames = ref({});     // { path: name } for all models

async function loadPreviews(modelPaths) {
  for (const path of modelPaths) {
    if (previews.value[path]) continue;
    try {
      const texturePath = await invoke('get_model_preview', { path });
      if (texturePath) {
        previews.value[path] = 'model://localhost/' + texturePath;
      }
    } catch {}
  }
}

async function loadCustomNames(modelPaths) {
  try {
    const names = await invoke('get_model_names', { paths: modelPaths });
    customNames.value = names;
  } catch {}
}

function displayName(path) {
  return customNames.value[path] || fileName(path);
}

async function openDetail(path) {
  try {
    const info = await invoke('get_model_info', { path });
    modelInfo.value = info;
    editName.value = info.custom_name || '';
    // Build motions edit state from saved custom mappings
    const saved = info.custom_motions ? JSON.parse(info.custom_motions) : {};
    editMotions.value = {};
    for (const ha of info.hit_areas) {
      editMotions.value[ha.name] = saved[ha.name] || '';
    }
    detailModel.value = path;
  } catch (err) {
    console.error('Failed to load model info:', err);
  }
}

async function saveDetail() {
  const path = detailModel.value;
  if (!path) return;

  // Save custom name
  await invoke('set_model_name', { path, name: editName.value.trim() });
  if (editName.value.trim()) {
    customNames.value[path] = editName.value.trim();
  } else {
    delete customNames.value[path];
  }

  // Save motion mappings (only non-empty overrides)
  const overrides = {};
  for (const [name, group] of Object.entries(editMotions.value)) {
    if (group) overrides[name] = group;
  }
  await invoke('set_model_motions', { path, mappings: JSON.stringify(overrides) });

  closeDetail();
}

function closeDetail() {
  detailModel.value = null;
  modelInfo.value = null;
}

async function refreshConfig() {
  try {
    const config = await invoke('get_config');
    models.value = config.models;
    currentModel.value = config.current_model;
    showBorder.value = config.show_border;
    tapMotion.value = config.tap_motion;
    showHitAreas.value = config.show_hit_areas;
    lockModel.value = config.lock_model;
    mouseTracking.value = config.mouse_tracking;
    loadPreviews(config.models);
    loadCustomNames(config.models);
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

const importing = ref(false);
const importProgress = ref({ current: 0, total: 0, name: '' });

async function importModel() {
  const selected = await open({
    multiple: false,
    filters: [
      { name: 'Live2D Package', extensions: ['lpk'] },
      { name: 'Live2D Model JSON', extensions: ['json'] },
    ],
  });
  if (!selected) return;
  importing.value = true;
  importProgress.value = { current: 0, total: 1, name: selected.split('/').pop() };
  try {
    await invoke('add_model', { path: selected });
    await refreshConfig();
  } catch (err) {
    console.error('Import failed:', err);
  } finally {
    importing.value = false;
  }
}

async function importFolder() {
  const selected = await open({ directory: true });
  if (!selected) return;
  importing.value = true;
  importProgress.value = { current: 0, total: 0, name: 'Scanning...' };
  const unlisten = await listen('import-progress', (event) => {
    importProgress.value = event.payload;
  });
  try {
    const result = await invoke('add_models_from_dir', { path: selected });
    if (result.errors.length > 0) {
      console.warn('Some imports failed:', result.errors);
    }
    await refreshConfig();
  } catch (err) {
    console.error('Folder import failed:', err);
  } finally {
    unlisten();
    importing.value = false;
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

async function uploadPreview(modelPath) {
  const selected = await open({
    multiple: false,
    filters: [
      { name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
    ],
  });
  if (selected) {
    await invoke('set_model_preview', { modelPath, imagePath: selected });
    previews.value[modelPath] = 'model://localhost/' + selected;
  }
}

async function toggleTapMotion() {
  tapMotion.value = !tapMotion.value;
  await invoke('set_setting', {
    key: 'tap_motion',
    value: tapMotion.value ? 'true' : 'false',
  });
}

async function toggleHitAreas() {
  showHitAreas.value = !showHitAreas.value;
  await invoke('set_setting', {
    key: 'show_hit_areas',
    value: showHitAreas.value ? 'true' : 'false',
  });
}

async function toggleLockPosition() {
  lockModel.value = !lockModel.value;
  await invoke('set_setting', {
    key: 'lock_model',
    value: lockModel.value ? 'true' : 'false',
  });
}

async function toggleMouseTracking() {
  mouseTracking.value = !mouseTracking.value;
  await invoke('set_setting', {
    key: 'mouse_tracking',
    value: mouseTracking.value ? 'true' : 'false',
  });
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

onMounted(refreshConfig);
</script>

<template>
  <div class="container">
    <header>
      <div class="tab-bar">
        <button class="tab" :class="{ active: activeTab === 'models' }" @click="activeTab = 'models'">Models</button>
        <button class="tab" :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">Settings</button>
      </div>
      <div v-if="activeTab === 'models' && !detailModel" class="import-group">
        <button class="import-btn" @click="importModel" :disabled="importing">+ Import</button>
        <button class="import-btn" @click="importFolder" :disabled="importing">+ Folder</button>
      </div>
    </header>

    <div v-if="importing" class="import-progress">
      <div class="progress-info">
        <span class="progress-text">{{ importProgress.name }}</span>
        <span v-if="importProgress.total > 0" class="progress-count">{{ importProgress.current }} / {{ importProgress.total }}</span>
      </div>
      <div class="progress-track">
        <div class="progress-bar" :class="{ indeterminate: importProgress.total <= 1 }" :style="importProgress.total > 1 ? { width: (importProgress.current / importProgress.total * 100) + '%' } : {}"></div>
      </div>
    </div>

    <template v-if="activeTab === 'models'">
      <!-- Detail/Edit View -->
      <section v-if="detailModel" class="detail-view">
        <button class="back-btn" @click="closeDetail">&larr; Back</button>

        <div class="detail-header">
          <div class="detail-preview" @click="uploadPreview(detailModel)" title="Click to change preview">
            <img v-if="previews[detailModel]" :src="previews[detailModel]" alt="preview" />
            <div v-else class="no-preview">+</div>
          </div>
          <div class="detail-name-section">
            <label class="field-label">Display Name</label>
            <input
              v-model="editName"
              class="name-input"
              type="text"
              :placeholder="fileName(detailModel)"
            />
          </div>
        </div>

        <div v-if="modelInfo && modelInfo.hit_areas.length > 0" class="motions-section">
          <h3 class="section-title">Hit Area Motions</h3>
          <div class="motion-table">
            <div v-for="ha in modelInfo.hit_areas" :key="ha.name" class="motion-row">
              <span class="motion-label">{{ ha.name }}</span>
              <select v-model="editMotions[ha.name]" class="motion-select">
                <option value="">(default)</option>
                <option :value="'__none__'">(none)</option>
                <option
                  v-for="group in modelInfo.motion_groups"
                  :key="group"
                  :value="group"
                >{{ group }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="detail-actions">
          <button class="save-btn" @click="saveDetail">Save</button>
          <button class="cancel-btn" @click="closeDetail">Cancel</button>
        </div>
      </section>

      <!-- Model List -->
      <section class="model-list" v-else-if="models.length > 0">
        <div
          v-for="model in models"
          :key="model"
          class="model-card"
          :class="{ active: model === currentModel }"
        >
          <div class="model-preview" @click="uploadPreview(model)" title="Click to set preview image">
            <img v-if="previews[model]" :src="previews[model]" alt="preview" />
            <div v-else class="no-preview">+</div>
          </div>
          <div class="model-info" @click="openDetail(model)" style="cursor: pointer">
            <span class="model-name">{{ displayName(model) }}</span>
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
        <p class="hint">Click "+ Import" to add a Live2D model.</p>
      </section>
    </template>

    <section v-if="activeTab === 'settings'" class="settings-panel">
      <div class="setting-row" @click="toggleMouseTracking">
        <span class="setting-label">Mouse tracking</span>
        <div class="toggle" :class="{ on: mouseTracking }">
          <div class="toggle-knob" />
        </div>
      </div>
      <div class="setting-row" @click="toggleTapMotion">
        <span class="setting-label">Enable tap motions</span>
        <div class="toggle" :class="{ on: tapMotion }">
          <div class="toggle-knob" />
        </div>
      </div>
      <div class="setting-row" @click="toggleHitAreas">
        <span class="setting-label">Show hit areas</span>
        <div class="toggle" :class="{ on: showHitAreas }">
          <div class="toggle-knob" />
        </div>
      </div>
      <div class="setting-row" @click="toggleLockPosition">
        <span class="setting-label">Lock model</span>
        <div class="toggle" :class="{ on: lockModel }">
          <div class="toggle-knob" />
        </div>
      </div>
      <div class="setting-row" @click="toggleBorder">
        <span class="setting-label">Show debug border</span>
        <div class="toggle" :class="{ on: showBorder }">
          <div class="toggle-knob" />
        </div>
      </div>
    </section>
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

.tab-bar {
  display: flex;
  gap: 4px;
}

.tab {
  padding: 8px 16px;
  background: transparent;
  color: #6c7086;
  font-size: 14px;
  font-weight: 500;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  transition: color 0.2s, border-color 0.2s;
}

.tab:hover {
  color: #a6adc8;
}

.tab.active {
  color: #89b4fa;
  border-bottom-color: #89b4fa;
}

button {
  border: none;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.2s;
}

.import-group {
  display: flex;
  gap: 6px;
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

.import-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.import-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.progress-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.progress-text {
  font-size: 12px;
  color: #a6adc8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.progress-count {
  font-size: 12px;
  color: #6c7086;
  flex-shrink: 0;
  margin-left: 8px;
}

.progress-track {
  height: 4px;
  background: #313244;
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: #89b4fa;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.progress-bar.indeterminate {
  width: 40% !important;
  animation: indeterminate 1.2s ease-in-out infinite;
}

@keyframes indeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
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
  padding: 14px 16px;
  background: #313244;
  border: 1px solid #45475a;
  border-radius: 10px;
  transition: border-color 0.2s;
  gap: 16px;
}

.model-preview {
  width: 120px;
  height: 120px;
  border-radius: 8px;
  overflow: hidden;
  background: #1e1e2e;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity 0.2s;
}

.model-preview:hover {
  opacity: 0.8;
}

.model-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.no-preview {
  color: #585b70;
  font-size: 32px;
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
  font-size: 16px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
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

.settings-panel {
  flex: 1;
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

/* Detail view */
.detail-view {
  display: flex;
  flex-direction: column;
  gap: 20px;
  flex: 1;
}

.back-btn {
  align-self: flex-start;
  padding: 6px 12px;
  background: transparent;
  color: #89b4fa;
  font-size: 14px;
}

.back-btn:hover {
  background: #313244;
}

.detail-header {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.detail-preview {
  width: 140px;
  height: 140px;
  border-radius: 10px;
  overflow: hidden;
  background: #313244;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: opacity 0.2s;
}

.detail-preview:hover {
  opacity: 0.8;
}

.detail-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.detail-name-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.field-label {
  font-size: 12px;
  color: #6c7086;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.name-input {
  padding: 8px 12px;
  background: #313244;
  border: 1px solid #45475a;
  border-radius: 6px;
  color: #cdd6f4;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}

.name-input:focus {
  border-color: #89b4fa;
}

.motions-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-title {
  font-size: 14px;
  font-weight: 500;
  color: #a6adc8;
  margin: 0;
}

.motion-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.motion-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #313244;
  border-radius: 6px;
}

.motion-label {
  font-size: 13px;
  color: #cdd6f4;
}

.motion-select {
  padding: 5px 8px;
  background: #45475a;
  border: 1px solid #585b70;
  border-radius: 4px;
  color: #cdd6f4;
  font-size: 13px;
  outline: none;
  min-width: 160px;
}

.motion-select:focus {
  border-color: #89b4fa;
}

.detail-actions {
  display: flex;
  gap: 8px;
  margin-top: auto;
}

.save-btn {
  padding: 8px 20px;
  background: #89b4fa;
  color: #1e1e2e;
  font-weight: 600;
}

.save-btn:hover {
  background: #74c7ec;
}

.cancel-btn {
  padding: 8px 20px;
  background: #45475a;
  color: #cdd6f4;
}

.cancel-btn:hover {
  background: #585b70;
}

</style>
