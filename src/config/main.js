import { createApp } from 'vue';
import App from './App.vue';

const app = createApp(App);

app.config.errorHandler = (err) => {
  console.error('Vue error:', err);
  const el = document.getElementById('app-error');
  if (el) {
    el.style.display = 'block';
    el.textContent = 'Vue error:\n' + err.message + '\n' + err.stack;
  }
};

app.mount('#app');
