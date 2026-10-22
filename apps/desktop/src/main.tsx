import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import '@livekit/components-styles'
import './styles.css'
import { App } from './App'
import { AppProvider } from './state/AppContext'

document.documentElement.dataset.platform = window.alephDesktop?.platform ?? 'web'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </HashRouter>
  </React.StrictMode>,
)
