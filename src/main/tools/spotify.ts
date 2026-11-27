// Spotify: the desktop app is controlled with AppleScript (no account linking),
// and searching for a song uses the Spotify Web API with your own free developer
// app's client ID and secret (stored encrypted). Without those keys Watson opens
// Spotify's search page for the song instead.
import { shell } from 'electron'
import type { NowPlayingData } from '@shared/types'
import { getSecret } from '../settings'
import { asString, osascript } from './osascript'

export type SpotifyKind = 'track' | 'album' | 'playlist' | 'artist'

let token: { value: string; expires: number } | null = null

async function apiToken(): Promise<string | null> {
  const id = getSecret('spotifyClientId')
  const secret = getSecret('spotifyClientSecret')
  if (!id || !secret) return null
  if (token && token.expires > Date.now() + 30_000) return token.value
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error('Spotify rejected the client ID or secret.')
  const j = (await res.json()) as { access_token: string; expires_in: number }
  token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 }
  return token.value
}

async function search(query: string, kind: SpotifyKind): Promise<{ uri: string; label: string } | null> {
  const t = await apiToken()
  if (!t) return null
  const res = await fetch(`https://api.spotify.com/v1/search?type=${kind}&limit=1&q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${t}` },
  })
  if (!res.ok) throw new Error(`Spotify search failed (${res.status}).`)
  const j = (await res.json()) as Record<string, { items: { uri: string; name: string; artists?: { name: string }[]; owner?: { display_name?: string } }[] }>
  const item = j[`${kind}s`]?.items?.[0]
  if (!item) return null
  const by = item.artists?.map((a) => a.name).join(', ') ?? item.owner?.display_name
  return { uri: item.uri, label: by ? `${item.name} by ${by}` : item.name }
}

async function ensureRunning() {
  await osascript('tell application "Spotify" to activate')
  await new Promise((r) => setTimeout(r, 900))
}

export async function play(query: string, kind: SpotifyKind): Promise<string> {
  const hit = await search(query, kind)
  if (!hit) {
    await shell.openExternal(`spotify:search:${encodeURIComponent(query)}`)
    return getSecret('spotifyClientId')
      ? `Nothing on Spotify matched "${query}". Opened the search instead.`
      : `Opened Spotify search for "${query}". Add a Spotify client ID and secret in Settings to have Watson start the song itself.`
  }
  await ensureRunning()
  await osascript(`tell application "Spotify" to play track ${asString(hit.uri)}`)
  return `Playing ${hit.label}.`
}

export async function control(action: 'pause' | 'resume' | 'next' | 'previous' | 'playpause'): Promise<void> {
  const cmd = { pause: 'pause', resume: 'play', next: 'next track', previous: 'previous track', playpause: 'playpause' }[action]
  await osascript(`tell application "Spotify" to ${cmd}`)
}

export async function nowPlaying(): Promise<NowPlayingData | null> {
  const out = await osascript(`
    if application "Spotify" is not running then return "none"
    tell application "Spotify"
      if player state is stopped then return "none"
      set d to "|"
      return (name of current track) & d & (artist of current track) & d & (album of current track) & d & (artwork url of current track) & d & ((duration of current track) as text) & d & ((player position) as text) & d & ((player state) as text)
    end tell`)
  if (out === 'none' || !out.includes('|')) return null
  const [title, artist, album, artworkUrl, duration, position, state] = out.split('|')
  return {
    title,
    artist,
    album,
    artworkUrl: artworkUrl || undefined,
    durationSec: Number(duration.replace(',', '.')) / 1000,
    positionSec: Number(position.replace(',', '.')),
    state: state.includes('playing') ? 'playing' : 'paused',
  }
}
