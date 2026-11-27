import { createRoot } from 'react-dom/client'
import { Overlay } from './Overlay'
import { SettingsPage } from './Settings'
import './styles.css'

const isSettings = location.hash.replace('#', '') === 'settings'
document.documentElement.dataset.view = isSettings ? 'settings' : 'overlay'
createRoot(document.getElementById('root')!).render(isSettings ? <SettingsPage /> : <Overlay />)
