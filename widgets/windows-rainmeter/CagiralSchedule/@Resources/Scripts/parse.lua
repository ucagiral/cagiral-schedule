-- Cagiral Schedule — today, formatted for a Rainmeter String meter.
--
-- Reads the raw JSON text already fetched by the WebParser measure (see
-- CagiralSchedule.ini), decodes it with the vendored json.lua, filters to today,
-- and builds one multi-line string for the meter to display.
--
-- Deliberately simplified, same reasoning as the iOS/macOS widgets: a String meter
-- has no per-line colour without a separate meter per row, which isn't practical for
-- a list whose length changes day to day. Status is shown with a symbol prefix
-- instead (done / active / passive / reminder / overdue) rather than colour, and the
-- whole meter carries one accent colour set in the .ini.
--
-- TIMED_CAP mirrors the macOS widget's desktop cap -- a persistent panel, not a
-- hard size constraint like the iOS widget has, but still capped against a
-- pathologically packed day.
local TIMED_CAP = 12

local json = dofile(SKIN:GetVariable("@") .. "Scripts\\json.lua")

local resultText = "Loading…"

local function todayIso()
  local t = os.date("*t")
  return string.format("%04d-%02d-%02d", t.year, t.month, t.day)
end

local function timeToMin(t)
  if not t then return 0 end
  local h, m = t:match("(%d+):(%d+)")
  return (tonumber(h) or 0) * 60 + (tonumber(m) or 0)
end

local function nowMin()
  local t = os.date("*t")
  return t.hour * 60 + t.min
end

local function symbolFor(ev)
  if ev.type == "reminder" then return "\240\159\147\140" end       -- 📌
  if ev.status == "done" then return "\226\156\147" end             -- ✓
  if ev.type == "passive" then return "\226\151\139" end            -- ○
  if ev["end"] and timeToMin(ev["end"]) < nowMin() then return "\226\154\160" end -- ⚠ overdue
  return "\226\151\143"                                              -- ● (approx, filled)
end

local function buildText(events, groups)
  local today = todayIso()
  local live = {}
  for _, ev in ipairs(events) do
    if ev.date == today and ev.status ~= "cancelled" then
      table.insert(live, ev)
    end
  end

  local reminders, timed = {}, {}
  for _, ev in ipairs(live) do
    if ev.type == "reminder" then table.insert(reminders, ev)
    else table.insert(timed, ev) end
  end
  table.sort(timed, function(a, b) return (a.start or "") < (b.start or "") end)

  local lines = {}
  for _, ev in ipairs(reminders) do
    table.insert(lines, symbolFor(ev) .. "  " .. (ev.title or "(untitled)"))
  end
  if #reminders > 0 and #timed > 0 then table.insert(lines, "") end

  local shown = math.min(#timed, TIMED_CAP)
  for i = 1, shown do
    local ev = timed[i]
    table.insert(lines, (ev.start or "--:--") .. "  " .. symbolFor(ev) .. "  " .. (ev.title or "(untitled)"))
  end
  if #timed > TIMED_CAP then
    table.insert(lines, "+" .. (#timed - TIMED_CAP) .. " more today")
  end
  if #reminders == 0 and #timed == 0 then
    table.insert(lines, "Nothing scheduled")
  end

  return table.concat(lines, "\n")
end

function Initialize()
end

function Update()
  local ok, raw = pcall(function() return SKIN:GetMeasure("MeasureFetch"):GetStringValue() end)
  if not ok or not raw or raw == "" then
    resultText = "Waiting for data…"
    return 0
  end

  local okDecode, data = pcall(json.decode, raw)
  if not okDecode or type(data) ~= "table" or not data.events then
    resultText = "Couldn't parse schedule"
    return 0
  end

  local okBuild, text = pcall(buildText, data.events, data._groups or {})
  resultText = okBuild and text or "Couldn't build schedule text"
  return 0
end

function GetStringValue()
  return resultText
end
