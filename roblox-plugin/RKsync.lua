local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local ScriptEditorService = game:GetService("ScriptEditorService")

local PLUGIN_WIDGET_ID = "RKsyncWidget"
local DEFAULT_SERVER_URL = "http://127.0.0.1:34872"
local SYNC_ATTRIBUTE_NAME = "RKsyncId"
local LEGACY_SYNC_ATTRIBUTE_NAME = "MorgSyncId"
local PULL_INTERVAL_SECONDS = 0.5
local FLUSH_INTERVAL_SECONDS = 0.2
local SNAPSHOT_INTERVAL_SECONDS = 5
local STATUS_COLORS = {
	offline = Color3.fromRGB(190, 60, 60),
	online = Color3.fromRGB(55, 145, 75),
	idle = Color3.fromRGB(230, 180, 75),
}
local EXCLUDED_ROOTS = {
	CoreGui = true,
	CorePackages = true,
	Players = true,
}
local RESERVED_SEGMENTS = {
	CON = true,
	PRN = true,
	AUX = true,
	NUL = true,
	COM1 = true,
	COM2 = true,
	COM3 = true,
	COM4 = true,
	COM5 = true,
	COM6 = true,
	COM7 = true,
	COM8 = true,
	COM9 = true,
	LPT1 = true,
	LPT2 = true,
	LPT3 = true,
	LPT4 = true,
	LPT5 = true,
	LPT6 = true,
	LPT7 = true,
	LPT8 = true,
	LPT9 = true,
}

local function isSupportedScript(instance)
	return instance:IsA("Script") or instance:IsA("LocalScript") or instance:IsA("ModuleScript")
end

local function isSyncableScript(instance)
	if not isSupportedScript(instance) or not instance:IsDescendantOf(game) then
		return false
	end

	local current = instance
	while current and current.Parent ~= game do
		current = current.Parent
	end

	return current ~= nil and EXCLUDED_ROOTS[current.Name] ~= true
end

local function encodeNameSegment(value)
	local bytes = { string.byte(value, 1, #value) }
	local result = {}
	for _, byteValue in ipairs(bytes) do
		local isAlpha = (byteValue >= 65 and byteValue <= 90) or (byteValue >= 97 and byteValue <= 122)
		local isDigit = byteValue >= 48 and byteValue <= 57
		local isSafe = isAlpha or isDigit or byteValue == 45 or byteValue == 95
		if isSafe then
			table.insert(result, string.char(byteValue))
		else
			table.insert(result, string.format("%%%02X", byteValue))
		end
	end

	local encoded = table.concat(result)
	if encoded == "" or encoded == "." or encoded == ".." or RESERVED_SEGMENTS[string.upper(encoded)] then
		result = {}
		for _, byteValue in ipairs(bytes) do
			table.insert(result, string.format("%%%02X", byteValue))
		end
		encoded = table.concat(result)
		if encoded == "" then
			encoded = "%00"
		end
	end

	return encoded
end

local function decodeNameSegment(segment)
	if segment == "%00" then
		return ""
	end
	return (segment:gsub("%%(%x%x)", function(hex)
		return string.char(tonumber(hex, 16))
	end))
end

local function buildScriptFileName(script)
	local suffix = ".module.luau"
	if script:IsA("LocalScript") then
		suffix = ".client.luau"
	elseif script:IsA("Script") then
		suffix = ".server.luau"
	end
	return encodeNameSegment(script.Name) .. suffix
end

local function parseScriptFileName(fileName)
	local lowerName = string.lower(fileName)
	local rules = {
		{ suffix = ".server.luau", className = "Script" },
		{ suffix = ".server.lua", className = "Script" },
		{ suffix = ".client.luau", className = "LocalScript" },
		{ suffix = ".client.lua", className = "LocalScript" },
		{ suffix = ".module.luau", className = "ModuleScript" },
		{ suffix = ".module.lua", className = "ModuleScript" },
		{ suffix = ".luau", className = "ModuleScript" },
		{ suffix = ".lua", className = "ModuleScript" },
	}
	for _, rule in ipairs(rules) do
		if string.sub(lowerName, -#rule.suffix) == rule.suffix then
			local baseName = string.sub(fileName, 1, #fileName - #rule.suffix)
			if baseName == "" then
				return nil
			end
			return {
				className = rule.className,
				scriptName = decodeNameSegment(baseName),
			}
		end
	end
	return nil
end

local function splitPath(pathValue)
	local result = {}
	for segment in string.gmatch(pathValue, "[^/]+") do
		table.insert(result, segment)
	end
	return result
end

local function joinPath(segments)
	return table.concat(segments, "/")
end

local function getScriptContent(script)
	local success, result = pcall(function()
		return ScriptEditorService:GetEditorSource(script)
	end)
	if success and type(result) == "string" then
		return result
	end
	return script.Source
end

local function getSyncId(script)
	local existing = script:GetAttribute(SYNC_ATTRIBUTE_NAME)
	if type(existing) == "string" and existing ~= "" then
		return existing
	end

	local legacy = script:GetAttribute(LEGACY_SYNC_ATTRIBUTE_NAME)
	if type(legacy) == "string" and legacy ~= "" then
		script:SetAttribute(SYNC_ATTRIBUTE_NAME, legacy)
		return legacy
	end

	return nil
end

local function getOrCreateSyncId(script)
	local existing = getSyncId(script)
	if existing then
		return existing
	end
	local generated = HttpService:GenerateGUID(false)
	script:SetAttribute(SYNC_ATTRIBUTE_NAME, generated)
	return generated
end

local function buildRelativePath(script)
	local segments = {}
	local current = script
	while current and current ~= game do
		if current == script then
			table.insert(segments, 1, buildScriptFileName(script))
		else
			table.insert(segments, 1, encodeNameSegment(current.Name))
		end
		current = current.Parent
	end
	return joinPath(segments)
end

local function parseRelativePath(relativePath)
	local segments = splitPath(relativePath)
	local fileName = table.remove(segments)
	local scriptInfo = parseScriptFileName(fileName)
	if not scriptInfo then
		return nil
	end
	local decodedParents = {}
	for _, segment in ipairs(segments) do
		table.insert(decodedParents, decodeNameSegment(segment))
	end
	return {
		className = scriptInfo.className,
		scriptName = scriptInfo.scriptName,
		parentSegments = decodedParents,
	}
end

local function setStatus(elements, text, color, detail)
	elements.statusLabel.Text = text
	elements.statusLabel.TextColor3 = color
	elements.statusDot.BackgroundColor3 = color
	elements.statusDetailLabel.Text = detail or ""
end

local toolbar = plugin:CreateToolbar("RKsync")
local openPanelButton = toolbar:CreateButton("RKsync", "Open RKsync", "")
openPanelButton.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right,
	true,
	false,
	360,
	300,
	280,
	220
)
local widget = plugin:CreateDockWidgetPluginGui(PLUGIN_WIDGET_ID, widgetInfo)
widget.Title = "RKsync"

local rootFrame = Instance.new("Frame")
rootFrame.Size = UDim2.fromScale(1, 1)
rootFrame.BackgroundColor3 = Color3.fromRGB(24, 24, 28)
rootFrame.BorderSizePixel = 0
rootFrame.Parent = widget

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 12)
padding.PaddingBottom = UDim.new(0, 12)
padding.PaddingLeft = UDim.new(0, 12)
padding.PaddingRight = UDim.new(0, 12)
padding.Parent = rootFrame

local listLayout = Instance.new("UIListLayout")
listLayout.Padding = UDim.new(0, 10)
listLayout.HorizontalAlignment = Enum.HorizontalAlignment.Left
listLayout.VerticalAlignment = Enum.VerticalAlignment.Top
listLayout.FillDirection = Enum.FillDirection.Vertical
listLayout.Parent = rootFrame

local titleLabel = Instance.new("TextLabel")
titleLabel.Size = UDim2.new(1, 0, 0, 22)
titleLabel.BackgroundTransparency = 1
titleLabel.Text = "Live sync Roblox scripts with VS Code"
titleLabel.TextColor3 = Color3.fromRGB(245, 245, 245)
titleLabel.Font = Enum.Font.SourceSansSemibold
titleLabel.TextSize = 18
titleLabel.TextXAlignment = Enum.TextXAlignment.Left
titleLabel.Parent = rootFrame

local urlBox = Instance.new("TextBox")
urlBox.Size = UDim2.new(1, 0, 0, 34)
urlBox.BackgroundColor3 = Color3.fromRGB(36, 36, 44)
urlBox.BorderColor3 = Color3.fromRGB(60, 60, 70)
urlBox.ClearTextOnFocus = false
urlBox.Font = Enum.Font.Code
urlBox.TextSize = 15
urlBox.TextColor3 = Color3.fromRGB(240, 240, 240)
urlBox.PlaceholderText = DEFAULT_SERVER_URL
urlBox.TextXAlignment = Enum.TextXAlignment.Left
urlBox.Parent = rootFrame

local buttonRow = Instance.new("Frame")
buttonRow.Size = UDim2.new(1, 0, 0, 34)
buttonRow.BackgroundTransparency = 1
buttonRow.Parent = rootFrame

local rowLayout = Instance.new("UIListLayout")
rowLayout.FillDirection = Enum.FillDirection.Horizontal
rowLayout.Padding = UDim.new(0, 8)
rowLayout.Parent = buttonRow

local toggleButton = Instance.new("TextButton")
toggleButton.Size = UDim2.new(0.5, -4, 1, 0)
toggleButton.BackgroundColor3 = Color3.fromRGB(62, 100, 190)
toggleButton.BorderSizePixel = 0
toggleButton.TextColor3 = Color3.new(1, 1, 1)
toggleButton.TextSize = 15
toggleButton.Font = Enum.Font.SourceSansSemibold
toggleButton.Text = "Start Sync"
toggleButton.Parent = buttonRow

local snapshotButton = Instance.new("TextButton")
snapshotButton.Size = UDim2.new(0.5, -4, 1, 0)
snapshotButton.BackgroundColor3 = Color3.fromRGB(70, 70, 84)
snapshotButton.BorderSizePixel = 0
snapshotButton.TextColor3 = Color3.new(1, 1, 1)
snapshotButton.TextSize = 15
snapshotButton.Font = Enum.Font.SourceSansSemibold
snapshotButton.Text = "Push Snapshot"
snapshotButton.Parent = buttonRow

local pullButton = Instance.new("TextButton")
pullButton.Size = UDim2.new(1, 0, 0, 32)
pullButton.BackgroundColor3 = Color3.fromRGB(52, 82, 146)
pullButton.BorderSizePixel = 0
pullButton.TextColor3 = Color3.new(1, 1, 1)
pullButton.TextSize = 14
pullButton.Font = Enum.Font.SourceSansSemibold
pullButton.Text = "Pull Now"
pullButton.Parent = rootFrame

local pullCorner = Instance.new("UICorner")
pullCorner.CornerRadius = UDim.new(0, 6)
pullCorner.Parent = pullButton

local statusFrame = Instance.new("Frame")
statusFrame.Size = UDim2.new(1, 0, 0, 58)
statusFrame.BackgroundColor3 = Color3.fromRGB(36, 36, 44)
statusFrame.BorderColor3 = Color3.fromRGB(60, 60, 70)
statusFrame.Parent = rootFrame

local statusPadding = Instance.new("UIPadding")
statusPadding.PaddingTop = UDim.new(0, 10)
statusPadding.PaddingBottom = UDim.new(0, 10)
statusPadding.PaddingLeft = UDim.new(0, 12)
statusPadding.PaddingRight = UDim.new(0, 12)
statusPadding.Parent = statusFrame

local statusDot = Instance.new("Frame")
statusDot.Size = UDim2.fromOffset(12, 12)
statusDot.Position = UDim2.fromOffset(0, 4)
statusDot.BackgroundColor3 = STATUS_COLORS.offline
statusDot.BorderSizePixel = 0
statusDot.Parent = statusFrame

local statusDotCorner = Instance.new("UICorner")
statusDotCorner.CornerRadius = UDim.new(1, 0)
statusDotCorner.Parent = statusDot

local statusLabel = Instance.new("TextLabel")
statusLabel.Size = UDim2.new(1, -22, 0, 18)
statusLabel.Position = UDim2.fromOffset(22, 0)
statusLabel.BackgroundTransparency = 1
statusLabel.Text = "[X] Disconnected"
statusLabel.TextColor3 = STATUS_COLORS.offline
statusLabel.Font = Enum.Font.SourceSansSemibold
statusLabel.TextSize = 16
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.Parent = statusFrame

local statusDetailLabel = Instance.new("TextLabel")
statusDetailLabel.Size = UDim2.new(1, -22, 0, 18)
statusDetailLabel.Position = UDim2.fromOffset(22, 22)
statusDetailLabel.BackgroundTransparency = 1
statusDetailLabel.Text = "Waiting for local server"
statusDetailLabel.TextColor3 = Color3.fromRGB(200, 200, 210)
statusDetailLabel.Font = Enum.Font.SourceSans
statusDetailLabel.TextSize = 14
statusDetailLabel.TextXAlignment = Enum.TextXAlignment.Left
statusDetailLabel.Parent = statusFrame

local statsFrame = Instance.new("Frame")
statsFrame.Size = UDim2.new(1, 0, 0, 44)
statsFrame.BackgroundColor3 = Color3.fromRGB(30, 30, 38)
statsFrame.BorderColor3 = Color3.fromRGB(60, 60, 70)
statsFrame.Parent = rootFrame

local statsPadding = Instance.new("UIPadding")
statsPadding.PaddingTop = UDim.new(0, 8)
statsPadding.PaddingBottom = UDim.new(0, 8)
statsPadding.PaddingLeft = UDim.new(0, 12)
statsPadding.PaddingRight = UDim.new(0, 12)
statsPadding.Parent = statsFrame

local statsLabel = Instance.new("TextLabel")
statsLabel.Size = UDim2.new(1, 0, 1, 0)
statsLabel.BackgroundTransparency = 1
statsLabel.Text = "Tracked: 0 | Queue: 0\nServer: 0 | Pull: 0 | Push: 0"
statsLabel.TextColor3 = Color3.fromRGB(210, 210, 220)
statsLabel.Font = Enum.Font.SourceSans
statsLabel.TextSize = 13
statsLabel.TextWrapped = true
statsLabel.TextXAlignment = Enum.TextXAlignment.Left
statsLabel.TextYAlignment = Enum.TextYAlignment.Top
statsLabel.Parent = statsFrame

local hintLabel = Instance.new("TextLabel")
hintLabel.Size = UDim2.new(1, 0, 1, -264)
hintLabel.BackgroundTransparency = 1
hintLabel.TextWrapped = true
hintLabel.TextYAlignment = Enum.TextYAlignment.Top
hintLabel.TextXAlignment = Enum.TextXAlignment.Left
hintLabel.Text = "Requirements:\n1. Run the VS Code RKsync extension in the same workspace.\n2. Enable Allow HTTP Requests in Studio.\n3. Keep this plugin connected."
hintLabel.TextColor3 = Color3.fromRGB(190, 190, 200)
hintLabel.Font = Enum.Font.SourceSans
hintLabel.TextSize = 15
hintLabel.Parent = rootFrame

local ui = {
	statusDetailLabel = statusDetailLabel,
	statusDot = statusDot,
	statusLabel = statusLabel,
	statsLabel = statsLabel,
	pullButton = pullButton,
	urlBox = urlBox,
	toggleButton = toggleButton,
}

openPanelButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

local state = {
	serverUrl = plugin:GetSetting("serverUrl") or DEFAULT_SERVER_URL,
	enabled = plugin:GetSetting("enabled") == true,
	pullSequence = 0,
	stopToken = 0,
	queuedOps = {},
	trackedScripts = {},
	idIndex = {},
	suppressUntil = {},
	lastObserved = {},
	workspaceName = "",
	syncRootName = "",
	statusMessage = "Waiting for local server",
	statusMode = "offline",
	lastSyncAt = "",
	serverScriptCount = 0,
	serverTombstoneCount = 0,
	lastPullCount = 0,
	lastPushCount = 0,
	lastSequence = 0,
}

urlBox.Text = state.serverUrl

local function formatSyncTime()
	return os.date("%H:%M:%S")
end

local function countMapEntries(mapValue)
	local count = 0
	for _ in pairs(mapValue) do
		count += 1
	end
	return count
end

local function applyServerCounts(payload)
	local counts = payload and payload.counts
	if type(counts) == "table" then
		state.serverScriptCount = tonumber(counts.scripts) or state.serverScriptCount
		state.serverTombstoneCount = tonumber(counts.tombstones) or state.serverTombstoneCount
	end
	if payload and payload.sequence ~= nil then
		state.lastSequence = tonumber(payload.sequence) or state.lastSequence
	end
end

local function updateStats()
	local trackedCount = 0
	for script in pairs(state.trackedScripts) do
		if script and script.Parent then
			trackedCount += 1
		end
	end

	ui.statsLabel.Text = string.format(
		"Tracked: %d | Queue: %d | Server: %d | Deletes: %d\nPull: %d | Push: %d | Seq: %d",
		trackedCount,
		countMapEntries(state.queuedOps),
		state.serverScriptCount,
		state.serverTombstoneCount,
		state.lastPullCount,
		state.lastPushCount,
		state.lastSequence
	)
end

local function renderStatus()
	local title = "[X] Disconnected"
	local color = STATUS_COLORS.offline
	if state.statusMode == "online" then
		title = "[OK] Connected"
		color = STATUS_COLORS.online
	elseif state.statusMode == "paused" then
		title = "[II] Paused"
		color = STATUS_COLORS.idle
	elseif state.statusMode == "idle" then
		title = "[...] Waiting"
		color = STATUS_COLORS.idle
	end

	local detailParts = {}
	if state.statusMessage ~= "" then
		table.insert(detailParts, state.statusMessage)
	end
	if state.workspaceName ~= "" then
		table.insert(detailParts, "Workspace: " .. state.workspaceName)
	end
	if state.syncRootName ~= "" then
		table.insert(detailParts, "Root: " .. state.syncRootName)
	end
	if state.lastSyncAt ~= "" then
		table.insert(detailParts, "Last sync: " .. state.lastSyncAt)
	end

	setStatus(ui, title, color, table.concat(detailParts, " | "))
	updateStats()
end

local function logStatus(mode, message)
	state.statusMode = mode
	state.statusMessage = message or ""
	renderStatus()
end

local function noteSync(message, mode)
	state.lastSyncAt = formatSyncTime()
	state.statusMode = mode or state.statusMode
	if message then
		state.statusMessage = message
	end
	renderStatus()
end

local function isPlaySessionRunning()
	local success, running = pcall(function()
		return RunService:IsRunning()
	end)
	return success and running == true
end

local function ensureSyncCanUseNetwork()
	if not isPlaySessionRunning() then
		return true
	end

	local pausedMessage = "Play test running. RKsync pauses network sync until the session stops."
	if state.statusMode ~= "paused" or state.statusMessage ~= pausedMessage then
		logStatus("paused", pausedMessage)
	end
	return false
end

local function shouldSuppress(id)
	local untilValue = state.suppressUntil[id]
	return untilValue and untilValue > os.clock()
end

local function suppressId(id, seconds)
	state.suppressUntil[id] = os.clock() + seconds
end

local function request(method, route, payload)
	local headers = {}
	local body = nil
	if payload ~= nil then
		body = HttpService:JSONEncode(payload)
		headers["Content-Type"] = "application/json"
	end
	local response = HttpService:RequestAsync({
		Url = state.serverUrl .. route,
		Method = method,
		Headers = headers,
		Body = body,
	})
	if not response.Success then
		error(string.format("HTTP %s %s failed: %s", method, route, response.Body))
	end
	if response.Body == "" then
		return {}
	end
	return HttpService:JSONDecode(response.Body)
end

local function queueOp(op)
	local observed = state.lastObserved[op.id]
	if observed then
		if op.type == observed.type then
			if op.type == "delete" then
				return
			end
			if observed.relativePath == op.relativePath and observed.className == op.className and observed.content == op.content then
				return
			end
		end
	end
	state.queuedOps[op.id] = op
	if op.type == "delete" then
		state.lastObserved[op.id] = {
			type = "delete",
		}
	else
		state.lastObserved[op.id] = {
			type = "upsert",
			relativePath = op.relativePath,
			className = op.className,
			content = op.content,
		}
	end
	updateStats()
end

local function getScriptFromDocument(document)
	if document:IsCommandBar() then
		return nil
	end
	local success, script = pcall(function()
		return document:GetScript()
	end)
	if success then
		return script
	end
	return nil
end

local function buildUpsertOp(script)
	local syncId = getOrCreateSyncId(script)
	state.idIndex[syncId] = script
	return {
		type = "upsert",
		id = syncId,
		relativePath = buildRelativePath(script),
		className = script.ClassName,
		instancePath = script:GetFullName(),
		content = getScriptContent(script),
	}
end

local function queueScript(script)
	if not isSyncableScript(script) then
		return
	end
	local syncId = getOrCreateSyncId(script)
	if shouldSuppress(syncId) then
		return
	end
	queueOp(buildUpsertOp(script))
end

local function untrackScript(script)
	local tracked = state.trackedScripts[script]
	if tracked then
		for _, connection in ipairs(tracked.connections) do
			connection:Disconnect()
		end
	end
	state.trackedScripts[script] = nil
	local syncId = getSyncId(script)
	if syncId then
		state.idIndex[syncId] = nil
	end
	updateStats()
end

local function queueDeleteForScript(script)
	local syncId = getSyncId(script)
	if type(syncId) ~= "string" or syncId == "" then
		return
	end
	if shouldSuppress(syncId) then
		return
	end
	queueOp({
		type = "delete",
		id = syncId,
		relativePath = buildRelativePath(script),
	})
end

local function trackScript(script)
	if not isSyncableScript(script) or state.trackedScripts[script] then
		return
	end
	local syncId = getOrCreateSyncId(script)
	state.idIndex[syncId] = script

	local connections = {}
	table.insert(connections, script:GetPropertyChangedSignal("Name"):Connect(function()
		queueScript(script)
	end))
	table.insert(connections, script:GetPropertyChangedSignal("Parent"):Connect(function()
		if script:IsDescendantOf(game) then
			queueScript(script)
		end
	end))
	table.insert(connections, script:GetPropertyChangedSignal("Source"):Connect(function()
		queueScript(script)
	end))

	state.trackedScripts[script] = {
		connections = connections,
	}
	updateStats()
end

local function ensureHierarchy(parentSegments)
	if #parentSegments == 0 then
		return game
	end
	local current = game:FindFirstChild(parentSegments[1])
	if not current then
		local ok, service = pcall(function()
			return game:GetService(parentSegments[1])
		end)
		if ok then
			current = service
		end
	end
	if not current then
		error("Unknown root service: " .. parentSegments[1])
	end

	for index = 2, #parentSegments do
		local segment = parentSegments[index]
		local child = current:FindFirstChild(segment)
		if not child then
			child = Instance.new("Folder")
			child.Name = segment
			child.Parent = current
		end
		current = child
	end
	return current
end

local function replaceScript(oldScript, className)
	local replacement = Instance.new(className)
	replacement.Name = oldScript.Name
	replacement.Parent = oldScript.Parent
	replacement.Source = oldScript.Source
	local syncId = getSyncId(oldScript)
	if syncId then
		replacement:SetAttribute(SYNC_ATTRIBUTE_NAME, syncId)
	end
	oldScript:Destroy()
	return replacement
end

local function resolveScriptForOp(op)
	local existing = state.idIndex[op.id]
	if existing and existing.Parent then
		return existing
	end

	local parsed = parseRelativePath(op.relativePath)
	if not parsed then
		error("Unsupported path from server: " .. op.relativePath)
	end
	local parent = ensureHierarchy(parsed.parentSegments)
	local child = parent:FindFirstChild(parsed.scriptName)
	if child and isSupportedScript(child) then
		if child.ClassName ~= op.className then
			child = replaceScript(child, op.className)
		end
		child.Name = parsed.scriptName
		child.Parent = parent
		child:SetAttribute(SYNC_ATTRIBUTE_NAME, op.id)
		state.idIndex[op.id] = child
		return child
	end

	local created = Instance.new(op.className)
	created.Name = parsed.scriptName
	created:SetAttribute(SYNC_ATTRIBUTE_NAME, op.id)
	created.Parent = parent
	state.idIndex[op.id] = created
	trackScript(created)
	return created
end

local function applyUpsert(op)
	local parsed = parseRelativePath(op.relativePath)
	if not parsed then
		return
	end

	local className = op.className or parsed.className
	local script = resolveScriptForOp({
		id = op.id,
		relativePath = op.relativePath,
		className = className,
	})
	local targetParent = ensureHierarchy(parsed.parentSegments)
	if script.ClassName ~= className then
		script = replaceScript(script, className)
	end
	script.Name = parsed.scriptName
	script.Parent = targetParent
	script:SetAttribute(SYNC_ATTRIBUTE_NAME, op.id)
	state.idIndex[op.id] = script
	trackScript(script)

	suppressId(op.id, 2)
	ScriptEditorService:UpdateSourceAsync(script, function(oldContent)
		if oldContent == op.content then
			return nil
		end
		return op.content
	end)
	state.lastObserved[op.id] = {
		type = "upsert",
		relativePath = op.relativePath,
		className = className,
		content = op.content,
	}
	updateStats()
end

local function applyDelete(op)
	local script = state.idIndex[op.id]
	if not script then
		return
	end
	suppressId(op.id, 2)
	untrackScript(script)
	script:Destroy()
	state.lastObserved[op.id] = {
		type = "delete",
	}
	updateStats()
end

local function flushQueue()
	if not state.enabled then
		return
	end
	if not ensureSyncCanUseNetwork() then
		return
	end
	local batched = {}
	for _, op in pairs(state.queuedOps) do
		table.insert(batched, op)
	end
	if #batched == 0 then
		return
	end

	state.queuedOps = {}
	updateStats()

	local success, result = pcall(function()
		return request("POST", "/push", {
			ops = batched,
		})
	end)
	if not success then
		for _, op in ipairs(batched) do
			state.queuedOps[op.id] = op
		end
		updateStats()
		logStatus("offline", string.format("Push failed. %d change(s) queued for reconnect.", #batched))
		return
	end

	applyServerCounts(result)
	state.lastPushCount = #batched
	noteSync(string.format("Synced %d change(s)", #batched), "online")
	return result
end

local function pushFullSnapshot()
	for _, descendant in ipairs(game:GetDescendants()) do
		if isSyncableScript(descendant) then
			trackScript(descendant)
			queueScript(descendant)
		end
	end
	flushQueue()
end

local function applyPullResult(result, emptyMessage)
	if result.reset then
		state.pullSequence = 0
	end
	applyServerCounts(result)

	local opCount = #(result.ops or {})
	for _, op in ipairs(result.ops or {}) do
		if op.type == "upsert" then
			applyUpsert(op)
		elseif op.type == "delete" then
			applyDelete(op)
		end
	end

	state.pullSequence = result.sequence or state.pullSequence
	state.lastPullCount = opCount
	state.lastSequence = result.sequence or state.lastSequence

	if opCount > 0 then
		noteSync(string.format("Applied %d incoming change(s)", opCount), "online")
	else
		local connectedMessage = emptyMessage or ("Connected to " .. state.serverUrl)
		logStatus("online", string.format("%s | %d file(s) mirrored", connectedMessage, state.serverScriptCount))
	end
end

local function pullFromServer(sinceValue, emptyMessage)
	if not ensureSyncCanUseNetwork() then
		return false, "paused"
	end

	local result = request("GET", "/pull?since=" .. tostring(sinceValue))
	if not result or not result.ok then
		error("Pull request failed")
	end

	applyPullResult(result, emptyMessage)
	return true, result
end

local function pullLoop(token)
	task.spawn(function()
		while state.enabled and state.stopToken == token do
			local success, resultOrError = pcall(function()
				local _, result = pullFromServer(state.pullSequence, "Connected to " .. state.serverUrl)
				return result
			end)
			if not success and resultOrError ~= "paused" then
				logStatus("offline", "Pull failed: " .. tostring(resultOrError))
			end
			task.wait(PULL_INTERVAL_SECONDS)
		end
	end)
end

local function flushLoop(token)
	task.spawn(function()
		while state.enabled and state.stopToken == token do
			flushQueue()
			task.wait(FLUSH_INTERVAL_SECONDS)
		end
	end)
end

local function snapshotLoop(token)
	task.spawn(function()
		while state.enabled and state.stopToken == token do
			task.wait(SNAPSHOT_INTERVAL_SECONDS)
			if state.enabled and state.stopToken == token then
				if ensureSyncCanUseNetwork() then
					pushFullSnapshot()
				end
			end
		end
	end)
end

local function pullFullSnapshot()
	local success = pullFromServer(0, "Connected to " .. state.serverUrl)
	if not success then
		error("Initial pull failed")
	end
end

local function startSync()
	local normalizedUrl = string.gsub(string.gsub(urlBox.Text, "%s+$", ""), "^%s+", "")
	if normalizedUrl == "" then
		normalizedUrl = DEFAULT_SERVER_URL
	end

	state.serverUrl = normalizedUrl
	plugin:SetSetting("serverUrl", state.serverUrl)
	state.enabled = true
	state.stopToken += 1
	state.pullSequence = 0
	state.lastPullCount = 0
	state.lastPushCount = 0
	state.lastSequence = 0
	state.serverScriptCount = 0
	state.serverTombstoneCount = 0
	plugin:SetSetting("enabled", true)
	ui.toggleButton.Text = "Stop Sync"
	logStatus("idle", "Connecting to " .. state.serverUrl)

	for _, descendant in ipairs(game:GetDescendants()) do
		if isSyncableScript(descendant) then
			trackScript(descendant)
		end
	end

	if isPlaySessionRunning() then
		logStatus("paused", "Play test running. RKsync will reconnect when the session stops.")
		pullLoop(state.stopToken)
		flushLoop(state.stopToken)
		snapshotLoop(state.stopToken)
		return
	end

	local helloSuccess, helloResult = pcall(function()
		return request("GET", "/hello")
	end)
	if not helloSuccess or not helloResult or not helloResult.ok then
		state.workspaceName = ""
		state.syncRootName = ""
		state.serverScriptCount = 0
		state.serverTombstoneCount = 0
		state.enabled = false
		plugin:SetSetting("enabled", false)
		ui.toggleButton.Text = "Start Sync"
		logStatus("offline", "Connection failed: " .. tostring(helloResult))
		return
	end
	state.workspaceName = helloResult.workspaceName or ""
	state.syncRootName = helloResult.syncRoot or ""
	applyServerCounts(helloResult)

	local pullSuccess, pullResult = pcall(function()
		pullFullSnapshot()
	end)
	if not pullSuccess then
		state.enabled = false
		plugin:SetSetting("enabled", false)
		ui.toggleButton.Text = "Start Sync"
		logStatus("offline", "Initial pull failed: " .. tostring(pullResult))
		return
	end

	pushFullSnapshot()
	logStatus("online", string.format("Connected to %s (%d files ready)", state.serverUrl, state.serverScriptCount))
	pullLoop(state.stopToken)
	flushLoop(state.stopToken)
	snapshotLoop(state.stopToken)
end

local function stopSync()
	state.enabled = false
	state.stopToken += 1
	plugin:SetSetting("enabled", false)
	ui.toggleButton.Text = "Start Sync"
	logStatus("offline", "Sync stopped")
end

ui.toggleButton.MouseButton1Click:Connect(function()
	if state.enabled then
		stopSync()
	else
		startSync()
	end
end)

snapshotButton.MouseButton1Click:Connect(function()
	if not state.enabled then
		logStatus("idle", "Start sync before pushing a snapshot.")
		return
	end
	pushFullSnapshot()
	logStatus(state.enabled and "online" or "idle", "Snapshot queued")
end)

pullButton.MouseButton1Click:Connect(function()
	if not state.enabled then
		logStatus("idle", "Start sync before pulling changes.")
		return
	end

	local success, resultOrError = pcall(function()
		local _, result = pullFromServer(0, "Manual pull complete")
		return result
	end)
	if not success and resultOrError ~= "paused" then
		logStatus("offline", "Manual pull failed: " .. tostring(resultOrError))
	end
end)

urlBox.FocusLost:Connect(function(enterPressed)
	if not enterPressed then
		return
	end
	local normalizedUrl = string.gsub(string.gsub(urlBox.Text, "%s+$", ""), "^%s+", "")
	if normalizedUrl == "" then
		normalizedUrl = DEFAULT_SERVER_URL
	end
	state.serverUrl = normalizedUrl
	plugin:SetSetting("serverUrl", state.serverUrl)
	if state.enabled then
		stopSync()
		startSync()
	end
end)

for _, descendant in ipairs(game:GetDescendants()) do
	if isSyncableScript(descendant) then
		trackScript(descendant)
	end
end

game.DescendantAdded:Connect(function(descendant)
	if isSyncableScript(descendant) then
		trackScript(descendant)
		queueScript(descendant)
	end
end)

game.DescendantRemoving:Connect(function(descendant)
	if isSyncableScript(descendant) then
		queueDeleteForScript(descendant)
		untrackScript(descendant)
	end
end)

ScriptEditorService.TextDocumentDidChange:Connect(function(document)
	local script = getScriptFromDocument(document)
	if not script or not isSyncableScript(script) then
		return
	end
	queueScript(script)
end)

if state.enabled then
	ui.toggleButton.Text = "Stop Sync"
	startSync()
else
	logStatus("offline", "Waiting for local server")
end
