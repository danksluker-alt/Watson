import { createRoot } from 'react-dom/client'
import { HomePage } from './Home'
import { Overlay } from './Overlay'
import { SettingsPage } from './Settings'
import { WidgetWindow } from './WidgetWindow'
import './styles.css'

const hash = location.hash.replace('#', '')
const widgetId = hash.startsWith('widget=') ? hash.slice('widget='.length) : null
const view = hash === 'settings' ? 'settings' : hash === 'home' ? 'home' : widgetId ? 'widget' : 'overlay'
document.documentElement.dataset.view = view
createRoot(document.getElementById('root')!).render(view === 'settings' ? <SettingsPage /> : view === 'home' ? <HomePage /> : widgetId ? <WidgetWindow id={widgetId} /> : <Overlay />)
