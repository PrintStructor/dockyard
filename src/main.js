import { createApp } from 'vue'
import '@fontsource/onest/latin-400.css'
import '@fontsource/onest/latin-500.css'
import '@fontsource/onest/latin-600.css'
import '@fontsource/onest/latin-700.css'
import { isTouchAppMode } from './touch/touch-config.mjs'

async function boot() {
  if (isTouchAppMode(typeof globalThis.location !== 'undefined' ? globalThis.location.search : '')) {
    const [{ default: TouchApp }] = await Promise.all([
      import('./touch/TouchApp.vue'),
      import('./touch/touch.css'),
    ])
    createApp(TouchApp).mount('#app')
    return
  }

  const [{ default: App }] = await Promise.all([
    import('./App.vue'),
    import('./style.css'),
  ])
  createApp(App).mount('#app')
}

boot()
