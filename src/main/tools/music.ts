// Music: Spotify and Apple Music, both driven by AppleScript (no account linking).
// To start a specific song on Spotify Watson uses the Spotify Web API with your own
// free developer app's client ID and secret; without them it opens Spotify's search.
import { shell } from 'electron'
import type { MusicApp, NowPlayingData } from '@shared/types'
import { getSecret } from '../settings'
import { asString, osascript } from './os'

export type MusicKind = 'track' | 'album' | 'playlist' | 'artist'
export type MusicAction = 'pause' | 'resume' | 'next' | 'previous' | 'playpause'

const APP_NAME: Record<MusicApp, string> = { spotify: 'Spotify', music: 'Music' }

let token: { value: string; expires: number } | null = null

async function spotifyToken(): Promise<string | null> {
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

async function spotifySearch(query: string, kind: MusicKind): Promise<{ uri: string; label: string } | null> {
  const t = await spotifyToken()
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

export async function play(app: MusicApp, query: string, kind: MusicKind): Promise<string> {
  if (app === 'music') {
    const field = kind === 'artist' ? 'artist' : kind === 'album' ? 'album' : 'name'
    const script =
      kind === 'playlist'
        ? `tell application "Music" to play playlist ${asString(query)}`
        : `tell application "Music"
             set hits to (every track of library playlist 1 whose ${field} contains ${asString(query)})
             if hits is {} then return "none"
             play item 1 of hits
             return (name of current track) & " by " & (artist of current track)
           end tell`
    const out = await osascript(script).catch(() => 'none')
    if (out === 'none') return `I couldn't find "${query}" in your Music library.`
    return out ? `Playing ${out}.` : `Playing ${query}.`
  }
  const hit = await spotifySearch(query, kind)
  if (!hit) {
    await shell.openExternal(`spotify:search:${encodeURIComponent(query)}`)
    return getSecret('spotifyClientId')
      ? `Nothing on Spotify matched "${query}". Opened the search instead.`
      : `Opened Spotify search for "${query}". Add a Spotify client ID and secret in Settings to have Watson start the song itself.`
  }
  await osascript('tell application "Spotify" to activate')
  await new Promise((r) => setTimeout(r, 900))
  await osascript(`tell application "Spotify" to play track ${asString(hit.uri)}`)
  return `Playing ${hit.label}.`
}

export async function control(app: MusicApp, action: MusicAction): Promise<void> {
  const cmd = { pause: 'pause', resume: 'play', next: 'next track', previous: 'previous track', playpause: 'playpause' }[action]
  await osascript(`tell application "${APP_NAME[app]}" to ${cmd}`)
}

export async function nowPlaying(app: MusicApp): Promise<NowPlayingData | null> {
  const name = APP_NAME[app]
  const art = app === 'spotify' ? '(artwork url of current track)' : '""'
  const out = await osascript(`
    if application "${name}" is not running then return "none"
    tell application "${name}"
      if player state is stopped then return "none"
      set d to "|"
      return (name of current track) & d & (artist of current track) & d & (album of current track) & d & ${art} & d & ((duration of current track) as text) & d & ((player position) as text) & d & ((player state) as text)
    end tell`)
  if (out === 'none' || !out.includes('|')) return null
  const [title, artist, album, artworkUrl, duration, position, state] = out.split('|')
  const dur = Number(duration.replace(',', '.'))
  return {
    app,
    title,
    artist,
    album,
    artworkUrl: artworkUrl || undefined,
    // Spotify reports milliseconds, Music reports seconds.
    durationSec: app === 'spotify' ? dur / 1000 : dur,
    positionSec: Number(position.replace(',', '.')),
    state: state.includes('playing') ? 'playing' : 'paused',
  }
}
