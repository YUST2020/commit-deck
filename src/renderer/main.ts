import { createApp } from 'vue'
import { createPinia } from 'pinia'
import naive from 'naive-ui'
import App from './App.vue'
import './tokens/tokens.css'
import './styles/tailwind.css'

const app = createApp(App)
app.use(createPinia())
app.use(naive)
app.mount('#app')
