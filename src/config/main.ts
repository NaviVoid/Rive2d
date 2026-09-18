import { createApp } from 'vue';
import App from './App.vue';

const app = createApp(App);

app.config.errorHandler = (error) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error('Vue error:', normalized);
  const element = document.getElementById('app-error');
  if (element) {
    element.style.display = 'block';
    element.textContent = `Vue error:\n${normalized.message}\n${normalized.stack ?? ''}`;
  }
};

app.mount('#app');
