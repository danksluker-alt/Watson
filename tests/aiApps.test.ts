import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addAppAgent, agentName, isAiApp } from '../src/shared/aiApps.ts'
import type { AgentTarget } from '../src/shared/types.ts'

const presets: AgentTarget[] = [
  { id: 'claude', name: 'Claude', kind: 'app', bundleId: 'com.anthropic.claudefordesktop', enabled: true },
  { id: 'grok', name: 'Grok', kind: 'web', url: 'https://grok.com/', enabled: true },
]

test('recognizes AI apps by bundle id or name', () => {
  assert.equal(isAiApp({ name: 'Grok Bot', bundleId: 'com.anysphere.sand' }), true)
  assert.equal(isAiApp({ name: 'Codex', bundleId: 'com.openai.codex' }), true)
  assert.equal(isAiApp({ name: 'Some LM Studio', bundleId: 'x.y' }), true)
  assert.equal(isAiApp({ name: 'Calculator', bundleId: 'com.apple.calculator' }), false)
  assert.equal(agentName({ name: 'Grok Bot', bundleId: 'com.anysphere.sand' }), 'Grok')
  assert.equal(agentName({ name: 'Notion AI Desktop', bundleId: 'x' }), 'Notion AI')
})

test('an app takes over the name of a website agent, which is switched off', () => {
  const out = addAppAgent(presets, { name: 'Grok Bot', bundleId: 'com.anysphere.sand' })
  const app = out.find((a) => a.bundleId === 'com.anysphere.sand')!
  const web = out.find((a) => a.kind === 'web')!
  assert.equal(app.id, 'grok')
  assert.equal(app.name, 'Grok')
  assert.equal(app.enabled, true)
  assert.equal(web.id, 'grok-web')
  assert.equal(web.name, 'Grok (web)')
  assert.equal(web.enabled, false)
})

test('adding the same app twice changes nothing; known apps get their chat menu', () => {
  const once = addAppAgent([], { name: 'Claude', bundleId: 'com.anthropic.claudefordesktop' })
  assert.deepEqual(once[0].chatMenu, ['Go', 'Claude'])
  assert.equal(addAppAgent(once, { name: 'Claude', bundleId: 'com.anthropic.claudefordesktop' }).length, 1)
})
