--[[
MusicMentor_Chat.lua — Music Mentor chat panel INSIDE REAPER (beta).

A dockable native window: send the session (stems + master + fader
metadata) with one button, then chat with the mentor without leaving
REAPER. Intent questions render as clickable option buttons.

Requires:
  * ReaImGui extension — install via ReaPack (Extensions → ReaPack →
    Browse packages → search "ReaImGui") or https://reapack.com
  * macOS/Linux (uses /bin/sh + curl). Windows: use the web app for now.

Install: Actions → Show action list → New action → Load ReaScript…

Known v1 limits (deliberate):
  * The UI briefly freezes while the mentor thinks (synchronous HTTP).
  * Long analyses (structure/stems) run in the background on the server;
    click "Check jobs" to pull results when the badge shows.
]]

local SITE   = "https://music-mentor-one.vercel.app"
local WORKER = "https://tt515--music-mentor-worker-api-app.modal.run"

-- ================================================================ guards
if not reaper.ImGui_CreateContext then
  reaper.MB("This panel needs the ReaImGui extension.\n\nInstall: Extensions → ReaPack → Browse packages → search \"ReaImGui\" → install, then restart REAPER.\n\n(No ReaPack? Get it at reapack.com)", "Music Mentor", 0)
  return
end
if reaper.GetOS():match("^Win") then
  reaper.MB("The in-REAPER chat currently supports macOS/Linux only.\nUse MusicMentor_SendSession.lua + the web app on Windows.", "Music Mentor", 0)
  return
end

-- ================================================================ tiny JSON
local json = {}
do
  local function esc(c)
    local m = { ['"']='\\"', ['\\']='\\\\', ['\b']='\\b', ['\f']='\\f',
                ['\n']='\\n', ['\r']='\\r', ['\t']='\\t' }
    return m[c] or string.format("\\u%04x", c:byte())
  end
  local function is_array(t)
    local n = 0
    for k in pairs(t) do
      if type(k) ~= "number" then return false end
      n = n + 1
    end
    return n == #t
  end
  function json.encode(v)
    local tv = type(v)
    if v == nil then return "null"
    elseif tv == "boolean" or tv == "number" then return tostring(v)
    elseif tv == "string" then return '"' .. v:gsub('[%c"\\]', esc) .. '"'
    elseif tv == "table" then
      if next(v) == nil then return "{}" end
      local parts = {}
      if is_array(v) then
        for _, x in ipairs(v) do parts[#parts + 1] = json.encode(x) end
        return "[" .. table.concat(parts, ",") .. "]"
      end
      for k, x in pairs(v) do
        parts[#parts + 1] = json.encode(tostring(k)) .. ":" .. json.encode(x)
      end
      return "{" .. table.concat(parts, ",") .. "}"
    end
    return "null"
  end

  local pos, str
  local function skip() pos = str:find("[^ \t\r\n]", pos) or #str + 1 end
  local decode_value
  local function decode_string()
    local out, i = {}, pos + 1
    while i <= #str do
      local c = str:sub(i, i)
      if c == '"' then pos = i + 1; return table.concat(out) end
      if c == "\\" then
        local d = str:sub(i + 1, i + 1)
        local m = { ['"']='"', ['\\']='\\', ['/']='/', b='\b', f='\f',
                    n='\n', r='\r', t='\t' }
        if m[d] then out[#out + 1] = m[d]; i = i + 2
        elseif d == "u" then
          local hex = tonumber(str:sub(i + 2, i + 5), 16) or 63
          if hex < 128 then out[#out + 1] = string.char(hex)
          elseif hex < 2048 then
            out[#out + 1] = string.char(192 + math.floor(hex / 64), 128 + hex % 64)
          else
            out[#out + 1] = string.char(224 + math.floor(hex / 4096),
              128 + math.floor(hex / 64) % 64, 128 + hex % 64)
          end
          i = i + 6
        else out[#out + 1] = d; i = i + 2 end
      else out[#out + 1] = c; i = i + 1 end
    end
    error("unterminated string")
  end
  function decode_value()
    skip()
    local c = str:sub(pos, pos)
    if c == '"' then return decode_string()
    elseif c == "{" then
      local obj = {}
      pos = pos + 1; skip()
      if str:sub(pos, pos) == "}" then pos = pos + 1; return obj end
      while true do
        skip()
        local k = decode_string()
        skip(); pos = pos + 1 -- ':'
        obj[k] = decode_value()
        skip()
        local d = str:sub(pos, pos); pos = pos + 1
        if d == "}" then return obj end
      end
    elseif c == "[" then
      local arr = {}
      pos = pos + 1; skip()
      if str:sub(pos, pos) == "]" then pos = pos + 1; return arr end
      while true do
        arr[#arr + 1] = decode_value()
        skip()
        local d = str:sub(pos, pos); pos = pos + 1
        if d == "]" then return arr end
      end
    elseif c == "t" then pos = pos + 4; return true
    elseif c == "f" then pos = pos + 5; return false
    elseif c == "n" then pos = pos + 4; return nil
    else
      local num = str:match("^[-%d%.eE+]+", pos)
      pos = pos + #num
      return tonumber(num)
    end
  end
  function json.decode(s)
    str, pos = s, 1
    local ok, v = pcall(decode_value)
    if ok then return v end
    return nil, v
  end
end

-- ================================================================ http
local function tmpbase()
  return (os.getenv("TMPDIR") or "/tmp") .. "/mm_" .. tostring(math.random(2 ^ 30))
end

local function http_post_json(url, payload_table, timeout_ms)
  local base = tmpbase()
  local pf, sf = base .. ".json", base .. ".sh"
  local f = io.open(pf, "w"); f:write(json.encode(payload_table)); f:close()
  f = io.open(sf, "w")
  f:write("#!/bin/sh\ncurl -s --max-time " .. math.floor((timeout_ms or 120000) / 1000) ..
          " -X POST '" .. url .. "' -H 'content-type: application/json' --data-binary @'" .. pf .. "'\n")
  f:close()
  local ret = reaper.ExecProcess("/bin/sh " .. sf, timeout_ms or 120000)
  os.remove(pf); os.remove(sf)
  if not ret then return nil, "request failed/timed out" end
  local body = ret:match("^%d+\n(.*)$") or ret
  local decoded, err = json.decode(body)
  if not decoded then return nil, "bad response: " .. tostring(body):sub(1, 160) end
  return decoded
end

local function http_upload(path)
  local base = tmpbase()
  local sf = base .. ".sh"
  local f = io.open(sf, "w")
  f:write("#!/bin/sh\ncurl -s --max-time 600 -X POST '" .. WORKER .. "/upload' -F 'file=@" .. path:gsub("'", "'\\''") .. "'\n")
  f:close()
  local ret = reaper.ExecProcess("/bin/sh " .. sf, 600000)
  os.remove(sf)
  if not ret then return nil end
  local body = ret:match("^%d+\n(.*)$") or ret
  return body:match('"upload_id"%s*:%s*"(%w+)"')
end

-- ================================================================ state
local ctx = reaper.ImGui_CreateContext("Music Mentor")
local messages = {}     -- full anthropic-format history (tables)
local display = {}      -- {kind, text} simplified render list
local roster = {}       -- {{upload_id=, filename=}, ...}
local meta_json = ""    -- fader/pan/mute JSON string
local ask = nil         -- pending intent question(s)
local pending_jobs = {} -- job_id -> true
local input_text = ""
local status = ""
local busy = false

local function push(kind, text) display[#display + 1] = { kind = kind, text = text } end

-- ================================================================ agent round trip
local TOOL_LABELS = {
  quick_features = "Measuring tempo, key & loudness…",
  analyze_structure = "Mapping song structure (1–3 min, background)…",
  separate_stems = "Splitting into stems (1–2 min, background)…",
  section_features = "Measuring sections…",
  mix_tracks = "Mixing tracks together…",
  get_job = "Collecting results…",
}

local function handle_response(resp)
  if not resp then push("err", "No response from the mentor (network?)"); return end
  if resp.error then push("err", tostring(resp.error)); return end
  for _, m in ipairs(resp.newMessages or {}) do
    messages[#messages + 1] = m
    if type(m.content) == "table" then
      for _, b in ipairs(m.content) do
        if b.type == "text" then
          push(m.role == "assistant" and "mentor" or "user", b.text)
        elseif b.type == "tool_use" and b.name ~= "ask_user" then
          push("tool", TOOL_LABELS[b.name] or b.name)
        elseif b.type == "tool_result" then
          local out = json.decode(b.content or "")
          if out and out.job_id and out.status == "running" then
            pending_jobs[out.job_id] = true
            push("tool", "Background job started — click 'Check jobs' in a minute or two.")
          end
        end
      end
    end
  end
  if resp.askUser then ask = resp.askUser; ask.picks = {}; ask.others = {} end
end

local function send(text, blocks)
  busy = true
  status = "The mentor is thinking…"
  local user_msg
  if blocks then user_msg = { role = "user", content = blocks }
  else
    user_msg = { role = "user", content = text }
    if not text:match("^%[system%]") then push("you", text) end
  end
  messages[#messages + 1] = user_msg
  local payload = { messages = messages, tracks = roster }
  if meta_json ~= "" then payload.meta = meta_json end
  local resp, err = http_post_json(SITE .. "/api/chat", payload, 180000)
  if err then push("err", err) else handle_response(resp) end
  busy = false
  status = ""
end

local function check_jobs()
  for job_id in pairs(pending_jobs) do
    local resp = http_post_json(WORKER .. "/job", { job_id = job_id }, 30000)
    if resp and (resp.status == "done" or resp.status == "failed") then
      pending_jobs[job_id] = nil
      send("[system] Job " .. job_id .. " is " .. resp.status .. ". Fetch it with get_job and continue.")
    end
  end
end

-- ================================================================ send session (stems + master + faders)
local function collect_session()
  busy = true
  status = "Rendering stems…"
  reaper.Main_SaveProject(0, false)
  local n = reaper.CountTracks(0)
  if n == 0 then push("err", "No tracks in project."); busy = false; return end

  local meta = {}
  for i = 0, n - 1 do
    local tr = reaper.GetTrack(0, i)
    local _, nm = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
    if nm == "" then nm = "Track " .. (i + 1) end
    local vol = reaper.GetMediaTrackInfo_Value(tr, "D_VOL")
    local voldb = vol > 0 and (20 * math.log(vol, 10)) or -150
    meta[#meta + 1] = string.format(
      '{"track":%d,"name":"%s","volume_db":%.1f,"pan":%.2f,"muted":%s}',
      i + 1, nm:gsub('"', "'"), voldb,
      reaper.GetMediaTrackInfo_Value(tr, "D_PAN"),
      reaper.GetMediaTrackInfo_Value(tr, "B_MUTE") > 0.5 and "true" or "false")
    reaper.SetTrackSelected(tr, true)
  end
  meta_json = '{"daw":"REAPER","tracks":[' .. table.concat(meta, ",") .. "]}"

  local dir = (os.getenv("TMPDIR") or "/tmp") .. "/musicmentor_stems"
  os.execute("mkdir -p '" .. dir .. "' && rm -f '" .. dir .. "'/*.wav 2>/dev/null")
  reaper.GetSetProjectInfo(0, "RENDER_SETTINGS", 3, true)
  reaper.GetSetProjectInfo(0, "RENDER_BOUNDSFLAG", 1, true)
  reaper.GetSetProjectInfo_String(0, "RENDER_FILE", dir, true)
  reaper.GetSetProjectInfo_String(0, "RENDER_PATTERN", "$track", true)
  reaper.GetSetProjectInfo_String(0, "RENDER_FORMAT", "ZXZhdw==", true)
  reaper.Main_OnCommand(42230, 0)

  status = "Rendering master mix…"
  reaper.GetSetProjectInfo(0, "RENDER_SETTINGS", 0, true)
  reaper.GetSetProjectInfo_String(0, "RENDER_PATTERN", "MUSICMENTOR_MASTER", true)
  reaper.Main_OnCommand(42230, 0)

  roster = {}
  local master = dir .. "/MUSICMENTOR_MASTER.wav"
  local mfile = io.open(master, "rb")
  if mfile then
    mfile:close()
    status = "Uploading master mix…"
    local id = http_upload(master)
    if id then roster[#roster + 1] = { upload_id = id, filename = "Full Mix (master).wav" } end
  end
  for i = 0, n - 1 do
    local tr = reaper.GetTrack(0, i)
    local _, nm = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
    if nm == "" then nm = "Track " .. (i + 1) end
    local safe = nm:gsub('[/\\:%*%?"<>|]', "_")
    local path = dir .. "/" .. safe .. ".wav"
    local f = io.open(path, "rb")
    if f then
      f:close()
      status = "Uploading: " .. nm
      local id = http_upload(path)
      if id then roster[#roster + 1] = { upload_id = id, filename = nm .. ".wav" } end
    end
  end
  push("tool", "Session sent: " .. #roster .. " tracks (incl. master) + fader metadata. Ask away.")
  busy = false
  status = ""
end

-- ================================================================ UI
local FLT_MIN = 1.17549e-38
local function frame()
  reaper.ImGui_SetNextWindowSize(ctx, 460, 620, reaper.ImGui_Cond_FirstUseEver())
  local visible, open = reaper.ImGui_Begin(ctx, "Music Mentor", true)
  if visible then
    if busy then
      reaper.ImGui_TextDisabled(ctx, status ~= "" and status or "Working…")
    else
      if reaper.ImGui_Button(ctx, #roster == 0 and "Send session to mentor" or "Re-send session") then
        collect_session()
      end
      local n_jobs = 0
      for _ in pairs(pending_jobs) do n_jobs = n_jobs + 1 end
      if n_jobs > 0 then
        reaper.ImGui_SameLine(ctx)
        if reaper.ImGui_Button(ctx, "Check jobs (" .. n_jobs .. " running)") then check_jobs() end
      end
      if #roster > 0 then
        reaper.ImGui_SameLine(ctx)
        reaper.ImGui_TextDisabled(ctx, #roster .. " tracks loaded")
      end
    end
    reaper.ImGui_Separator(ctx)

    -- transcript
    if reaper.ImGui_BeginChild(ctx, "log", 0, -60) then
      for _, d in ipairs(display) do
        if d.kind == "you" then
          reaper.ImGui_TextColored(ctx, 0x4EA1FFFF, "You:")
          reaper.ImGui_TextWrapped(ctx, d.text)
        elseif d.kind == "mentor" then
          reaper.ImGui_TextColored(ctx, 0x3FBF7FFF, "Mentor:")
          reaper.ImGui_TextWrapped(ctx, d.text)
        elseif d.kind == "tool" then
          reaper.ImGui_TextDisabled(ctx, "· " .. d.text)
        elseif d.kind == "err" then
          reaper.ImGui_TextColored(ctx, 0xFF6060FF, "! " .. d.text)
        elseif d.kind == "card" then
          reaper.ImGui_TextColored(ctx, 0xD0A030FF, d.text)
        end
        reaper.ImGui_Spacing(ctx)
      end

      -- intent question card
      if ask then
        reaper.ImGui_Separator(ctx)
        reaper.ImGui_TextColored(ctx, 0xD0A030FF, "The mentor wants to understand your intent:")
        for qi, q in ipairs(ask.questions or {}) do
          reaper.ImGui_Spacing(ctx)
          reaper.ImGui_TextWrapped(ctx, q.question or "")
          for oi, o in ipairs(q.options or {}) do
            local key = qi .. "_" .. oi
            local sel = ask.picks[key] or false
            local rv, nv = reaper.ImGui_Checkbox(ctx, (o.label or "?") .. "##" .. key, sel)
            if rv then
              if nv and not q.multiSelect then
                for oj = 1, #q.options do ask.picks[qi .. "_" .. oj] = false end
              end
              ask.picks[key] = nv
            end
            if o.description and o.description ~= "" then
              reaper.ImGui_SameLine(ctx)
              reaper.ImGui_TextDisabled(ctx, "(?)")
              if reaper.ImGui_IsItemHovered(ctx) then
                reaper.ImGui_SetTooltip(ctx, o.description)
              end
            end
          end
          local rv2, nv2 = reaper.ImGui_InputText(ctx, "Something else##" .. qi, ask.others[qi] or "")
          if rv2 then ask.others[qi] = nv2 end
        end
        reaper.ImGui_Spacing(ctx)
        if not busy and reaper.ImGui_Button(ctx, "Send answers") then
          local payload = {}
          for qi, q in ipairs(ask.questions or {}) do
            local picks = {}
            for oi, o in ipairs(q.options or {}) do
              if ask.picks[qi .. "_" .. oi] then picks[#picks + 1] = o.label end
            end
            if ask.others[qi] and ask.others[qi] ~= "" then
              picks[#picks + 1] = "Something else: " .. ask.others[qi]
            end
            payload[#payload + 1] = { question = q.question,
                                      answer = #picks > 0 and table.concat(picks, "; ") or "(no answer)" }
            push("card", "Q: " .. (q.question or "") .. "\nA: " ..
                 (#picks > 0 and table.concat(picks, "; ") or "(no answer)"))
          end
          local block = { { type = "tool_result", tool_use_id = ask.toolUseId,
                            content = json.encode(payload) } }
          ask = nil
          send("", block)
        end
      end
      reaper.ImGui_EndChild(ctx)
    end

    -- composer
    reaper.ImGui_SetNextItemWidth(ctx, -70)
    local flags = reaper.ImGui_InputTextFlags_EnterReturnsTrue()
    local rv, nv = reaper.ImGui_InputText(ctx, "##msg", input_text, flags)
    input_text = nv or input_text
    reaper.ImGui_SameLine(ctx)
    local do_send = (rv or reaper.ImGui_Button(ctx, "Send")) and not busy and not ask
    if do_send and input_text ~= "" then
      local t = input_text
      input_text = ""
      send(t)
    end

    reaper.ImGui_End(ctx)
  end
  if open then reaper.defer(frame) end
end

push("tool", "Welcome. Click 'Send session to mentor' to upload your stems + master + fader data, then ask anything.")
reaper.defer(frame)
