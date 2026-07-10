# Music Mentor — DAW Integration

Three DAWs, two levels of integration. This is dictated by what each DAW's
API allows, not by ambition:

| DAW | Integration | Why |
|---|---|---|
| REAPER | **Full one-click**: render stems → upload → open mentor, automatically | ReaScript exposes the whole session (tracks, names, fader/pan/mute, programmatic render) |
| Logic Pro | Export (one menu action) + one command | No session-level API exists. Logic's only scripting surface is MIDI. |
| FL Studio | Export (one menu action) + one command | FL scripting is MIDI-controller-only; no render/track API. |

A conventional AU/VST plugin cannot do this at all: plugins are sandboxed to
one track's audio and cannot see the rest of the session. That's a plugin-spec
wall, not a missing feature.

## REAPER (full integration)

1. Copy `reaper/MusicMentor_SendSession.lua` somewhere permanent.
2. REAPER → **Actions → Show action list → New action → Load ReaScript…** → pick the file.
3. Run it (assign a keyboard shortcut for one-keystroke use).

What it does: saves the project, selects all tracks, renders every track as a
WAV stem (entire project length) to a temp folder, uploads each stem, collects
track names + fader dB + pan + mute state as metadata, then opens the Music
Mentor site with the whole session preloaded. The mentor sees your real track
names and knows fader/mute state — so "the e-piano is quiet" can be answered
with "its fader is at -9.5 dB in your session" instead of a guess.

Notes:
- WAV stems can be large; a big session takes a while to upload. Rendering
  uses your project sample rate.
- The render uses "entire project" bounds and auto-closes the render dialog
  (REAPER action 42230).

## Logic Pro

**Option A — the app (near-one-click).** `logic/MusicMentor_Logic.applescript`
automates everything except Logic's own export sheet (macOS forbids filling
that in safely). Install once in Terminal:

```bash
chmod +x ~/music-mentor-web/daw/logic-fl/mentor-send.sh
mkdir -p ~/Applications
osacompile -o "$HOME/Applications/MusicMentor for Logic.app" \
  ~/music-mentor-web/daw/logic/MusicMentor_Logic.applescript
```

First run: macOS asks for Accessibility permission (System Settings →
Privacy & Security → Accessibility → enable "MusicMentor for Logic") and to
allow controlling Logic Pro. Then the flow is: open your project → run the
app → Logic's export sheet appears → pick `MusicMentorDrop` + click Export
(Logic remembers the folder, so subsequent runs are one click) → the app
waits for the render, uploads all stems, and opens the mentor.

Tip: in Logic's export sheet, untick "Include Volume/Pan Automation" if you
want raw stems, or leave it on if you want the mentor to hear your mix moves.

**Option B — plain command.** Export manually (File → Export → All Tracks as
Audio Files… into any folder), then:

```bash
~/music-mentor-web/daw/logic-fl/mentor-send.sh ~/Desktop/MyStems "炽热 v3 session"
```

Track names come from Logic's exported filenames either way.

## FL Studio

1. **File → Export → Wave file…** → tick **Split mixer tracks** → export
   to an empty folder.
2. Same `mentor-send.sh` command as Logic.

## In-DAW chat interface

- **REAPER**: `reaper/MusicMentor_Chat.lua` — a native dockable chat panel
  inside REAPER (requires the free **ReaImGui** extension via ReaPack).
  One button sends stems + master mix + fader/pan/mute metadata; then chat,
  answer intent questions, and pull background-job results without leaving
  the DAW. The mentor can reconstruct your fader mix on demand (`mix_tracks`
  with fader gains) or analyze any subset of tracks together.
  Beta caveats: the panel freezes for a few seconds while the mentor thinks
  (synchronous HTTP), and long analyses need a "Check jobs" click.
- **Logic Pro**: impossible. Logic has no extension/panel API of any kind —
  nothing can render UI inside it. The AppleScript app + web app is the
  ceiling. Fader data is also unobtainable via API; the workaround is
  ticking "Include Volume/Pan Automation" at export so the stems themselves
  carry your mix.
- **FL Studio**: an in-FL interface would require building a compiled
  webview VST plugin (JUCE/C++, per-platform builds + signing) — a real
  but separate engineering project, not a script. Until then: export with
  "Split mixer tracks" + `mentor-send.sh`, chat in the browser. FL exposes
  no API for fader values either; FL's export bakes mixer levels into
  stems by default, which serves the same purpose.

## Limitations (honest list)

- Logic/FL: fader/pan/mute metadata is NOT captured (their exports don't
  carry it; there is no API to read it). REAPER captures everything.
- Very large sessions (30+ tracks) make long URLs for the metadata handoff;
  if the browser balks, the stems still upload — start the chat manually.
- Uploads are full-length WAVs; on slow internet consider exporting a
  region/section instead of the whole song.
- The worker keeps uploaded stems until manually cleaned (Modal volume).
