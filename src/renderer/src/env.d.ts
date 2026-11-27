import type { WatsonAPI } from '@shared/types'

declare global {
  interface Window {
    watson: WatsonAPI
  }
}
