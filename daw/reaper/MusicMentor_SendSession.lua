--[[
MusicMentor_SendSession.lua — one-click: render all tracks as stems,
upload to the Music Mentor worker, open the web app with the session
preloaded (track names + volume/pan/mute metadata included).

Install: REAPER → Actions → Show action list → New action →
         Load ReaScript… → pick this file. Optionally assign a shortcut.

Requires: macOS or Linux with `curl` (built into macOS), or Windows 10+.
]]

local WORKER = "https://tt515--music-mentor-worker-api-app.modal.run"
local SITE   = "https://music-mentor-one.vercel.app"

-- ---------------------------------------------------------------- helpers
local function urlencode(s)
  return (s:gsub("[^%w%-%.%_%~]", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end

local function shellquote(s)
  return "'" .. s:gsub("'", "'\\''") .. "'"
end

local function msg(s) reaper.ShowConsoleMsg(tostring(s) .. "\n") end

local function open_url(url)
  local os_name = reaper.GetOS()
  if os_name:match("^Win") then
    os.execute('start "" "' .. url .. '"')
  elseif os_name:match("^OSX") or os_name:match("^macOS") then
    os.execute('open ' .. shellquote(url))
  else
    os.execute('xdg-open ' .. shellquote(url))
  end
end

local function lin_to_db(lin)
  if lin <= 0 then return -150 end
  return 20 * math.log(lin, 10)
end

-- ---------------------------------------------------------------- 1. save + collect metadata
reaper.ShowConsoleMsg("") -- clear console
msg("Music Mentor: preparing session…")
reaper.Main_SaveProject(0, false)

local _, proj_path = reaper.EnumProjects(-1)
local proj_name = proj_path:match("([^/\\]+)%.RPP$") or "REAPER session"

local n_tracks = reaper.CountTracks(0)
if n_tracks == 0 then
  reaper.MB("No tracks in this project.", "Music Mentor", 0)
  return
end

local meta = {}
for i = 0, n_tracks - 1 do
  local tr = reaper.GetTrack(0, i)
  local _, name = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
  if name == "" then name = "Track " .. (i + 1) end
  local vol  = reaper.GetMediaTrackInfo_Value(tr, "D_VOL")
  local pan  = reaper.GetMediaTrackInfo_Value(tr, "D_PAN")
  local mute = reaper.GetMediaTrackInfo_Value(tr, "B_MUTE")
  meta[#meta + 1] = string.format(
    '{"track":%d,"name":"%s","volume_db":%.1f,"pan":%.2f,"muted":%s}',
    i + 1, name:gsub('"', "'"), lin_to_db(vol), pan, mute > 0.5 and "true" or "false")
  reaper.SetTrackSelected(tr, true) -- select all for stem render
end
local meta_json = '{"daw":"REAPER","project":"' .. proj_name:gsub('"', "'") ..
                  '","tracks":[' .. table.concat(meta, ",") .. "]}"

-- ---------------------------------------------------------------- 2. render stems
local render_dir = (os.getenv("TMPDIR") or os.getenv("TEMP") or "/tmp") .. "/musicmentor_stems"
os.execute('mkdir -p ' .. shellquote(render_dir))
os.execute('rm -f ' .. shellquote(render_dir) .. '/*.wav 2>/dev/null')

reaper.GetSetProjectInfo(0, "RENDER_SETTINGS", 3, true)        -- stems (selected tracks)
reaper.GetSetProjectInfo(0, "RENDER_BOUNDSFLAG", 1, true)      -- entire project
reaper.GetSetProjectInfo_String(0, "RENDER_FILE", render_dir, true)
reaper.GetSetProjectInfo_String(0, "RENDER_PATTERN", "$track", true)
-- "ZXZhdw==" is base64("evaw") → default WAV sink
reaper.GetSetProjectInfo_String(0, "RENDER_FORMAT", "ZXZhdw==", true)

msg("Rendering " .. n_tracks .. " stems (this may take a moment)…")
reaper.Main_OnCommand(42230, 0) -- render using settings above, auto-close dialog

-- ---------------------------------------------------------------- 3. upload each stem
local roster = {}
local uploaded, failed = 0, 0
for i = 0, n_tracks - 1 do
  local tr = reaper.GetTrack(0, i)
  local _, name = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
  if name == "" then name = "Track " .. (i + 1) end
  -- REAPER sanitizes illegal filename chars in $track the same way we do here
  local safe = name:gsub('[/\\:%*%?"<>|]', "_")
  local path = render_dir .. "/" .. safe .. ".wav"
  local f = io.open(path, "rb")
  if f then
    f:close()
    msg("Uploading: " .. name)
    local cmd = "curl -s -X POST " .. shellquote(WORKER .. "/upload") ..
                " -F " .. shellquote("file=@" .. path)
    local p = io.popen(cmd)
    local out = p and p:read("*a") or ""
    if p then p:close() end
    local id = out:match('"upload_id"%s*:%s*"(%w+)"')
    if id then
      roster[#roster + 1] = id .. "~" .. urlencode(name .. ".wav")
      uploaded = uploaded + 1
    else
      msg("  ! upload failed for " .. name .. " → " .. out:sub(1, 120))
      failed = failed + 1
    end
  else
    msg("  ! rendered file not found for track: " .. name .. " (skipped)")
    failed = failed + 1
  end
end

if uploaded == 0 then
  reaper.MB("No stems were uploaded. Check your internet connection and the console output.", "Music Mentor", 0)
  return
end

-- ---------------------------------------------------------------- 3b. render + upload the master mix
-- The stems tell the mentor about parts; the master mix tells it about the
-- whole (including master-bus processing). Render it in a second pass.
msg("Rendering master mix…")
reaper.GetSetProjectInfo(0, "RENDER_SETTINGS", 0, true) -- master mix
reaper.GetSetProjectInfo_String(0, "RENDER_PATTERN", "MUSICMENTOR_MASTER", true)
reaper.Main_OnCommand(42230, 0)
local master_path = render_dir .. "/MUSICMENTOR_MASTER.wav"
local mf = io.open(master_path, "rb")
if mf then
  mf:close()
  msg("Uploading: Full Mix (master)")
  local cmd = "curl -s -X POST " .. shellquote(WORKER .. "/upload") ..
              " -F " .. shellquote("file=@" .. master_path)
  local p = io.popen(cmd)
  local out = p and p:read("*a") or ""
  if p then p:close() end
  local id = out:match('"upload_id"%s*:%s*"(%w+)"')
  if id then
    table.insert(roster, 1, id .. "~" .. urlencode("Full Mix (master).wav"))
    uploaded = uploaded + 1
  else
    msg("  ! master mix upload failed → " .. out:sub(1, 120))
  end
else
  msg("  ! master mix render not found (skipped)")
end

-- ---------------------------------------------------------------- 4. upload metadata separately (no URL-length limit)
local meta_param = ""
do
  local mpath = render_dir .. "/session_meta.json"
  local mf2 = io.open(mpath, "w")
  if mf2 then
    -- wrap as {"meta": "<json-as-string>"} for the /save_meta endpoint
    mf2:write('{"meta": ' .. string.format("%q", meta_json):gsub("\\\n", "\\n") .. "}")
    mf2:close()
    local cmd = "curl -s -X POST " .. shellquote(WORKER .. "/save_meta") ..
                " -H 'content-type: application/json' --data-binary @" .. shellquote(mpath)
    local p = io.popen(cmd)
    local out = p and p:read("*a") or ""
    if p then p:close() end
    local mid = out:match('"meta_id"%s*:%s*"(%w+)"')
    if mid then
      meta_param = "&meta=" .. urlencode("mid:" .. mid)
      msg("Session metadata uploaded (faders, pans, mutes).")
    else
      msg("  ! metadata upload failed (continuing without it)")
    end
  end
end

-- ---------------------------------------------------------------- 5. open the mentor
local url = SITE .. "/?tracks=" .. table.concat(roster, ",") ..
            "&title=" .. urlencode("REAPER: " .. proj_name) .. meta_param
msg("Done: " .. uploaded .. " uploaded, " .. failed .. " failed.")
msg("Opening Music Mentor…")
open_url(url)
