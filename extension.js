'use strict';

const packageJson = require('./package.json');
const vscode = require('vscode');
const fs = require('fs/promises');
const fssync = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { IgnoreMatcher } = require('./lib/ignoreMatcher');
const {
  getRobloxPluginInstallInfo,
  installRobloxPluginFiles
} = require('./lib/pluginInstall');
const {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  describeProtocolMismatch,
  getProtocolVersionFromHeaders,
  isProtocolVersionCompatible
} = require('./lib/protocol');
const {
  DEFAULT_PORT,
  DEFAULT_SYNC_ROOT,
  LEGACY_STATE_DIR_NAME,
  STATE_DIR_NAME,
  STATE_FILE_NAME,
  WORKSPACE_CONFIG_FILE_NAME,
  canonicalizeRelativePath,
  hashContent,
  isSupportedScriptFile,
  normalizeRelativePath,
  parseConfiguredPort,
  parseConfiguredSyncRoot,
  parseRelativeScriptPath,
  relativePathToInstancePath,
  toPosixPath
} = require('./lib/syncCore');

const JOURNAL_LIMIT = 1000;
const TOMBSTONE_LIMIT = 500;
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const MUTE_TTL_MS = 4000;
const FILE_EVENT_DEBOUNCE_MS = 120;
const CONNECTED_GRACE_MS = 3000;
const SIDEBAR_REFRESH_MS = 1000;
const TOMBSTONE_REUSE_WINDOW_MS = 15000;
const RECONCILE_STALE_MS = 2500;
const RECENT_ACTIVITY_LIMIT = 40;
const RUNTIME_RELOAD_DEBOUNCE_MS = 300;
const EXTENSION_VERSION = packageJson.version;

function now() {
  return Date.now();
}

function createInitialState(syncRoot) {
  return {
    version: 1,
    config: {
      syncRoot
    },
    scripts: {},
    tombstones: {}
  };
}

function pickConfiguredValueInfo(primaryConfig, legacyConfig, key, defaultValue) {
  const inspected = primaryConfig.inspect(key);
  const explicitValue = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  if (explicitValue !== undefined) {
    return {
      value: explicitValue,
      source: 'VS Code settings'
    };
  }

  const legacyInspected = legacyConfig.inspect?.(key);
  const legacyValue =
    legacyInspected?.workspaceFolderValue ?? legacyInspected?.workspaceValue ?? legacyInspected?.globalValue;
  if (legacyValue !== undefined) {
    return {
      value: legacyValue,
      source: 'Legacy VS Code settings'
    };
  }

  return {
    value: defaultValue,
    source: 'Defaults'
  };
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return 'Never';
  }
  return new Date(timestamp).toLocaleTimeString();
}

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return 'never';
  }

  const deltaMs = Math.max(0, now() - timestamp);
  if (deltaMs < 2000) {
    return 'just now';
  }

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function describeServerStartError(error, port) {
  if (error?.code === 'EADDRINUSE') {
    return `Port ${port} is already in use. Stop the other process or change RKsync port in ${WORKSPACE_CONFIG_FILE_NAME} or VS Code settings.`;
  }
  if (error?.code === 'EACCES') {
    return `RKsync could not listen on port ${port} because access was denied. Choose a different port.`;
  }
  return error?.message || `RKsync could not start its localhost server on port ${port}.`;
}

function createTreeItem(label, description, iconId, colorId, command) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  if (description) {
    item.description = description;
  }
  item.iconPath = colorId
    ? new vscode.ThemeIcon(iconId, new vscode.ThemeColor(colorId))
    : new vscode.ThemeIcon(iconId);
  if (command) {
    item.command = command;
  }
  return item;
}

function createTreeNode({
  label,
  description,
  iconId,
  colorId,
  command,
  tooltip,
  collapsibleState = vscode.TreeItemCollapsibleState.None,
  children = []
}) {
  const item = createTreeItem(label, description, iconId, colorId, command);
  item.collapsibleState = collapsibleState;
  if (tooltip) {
    item.tooltip = tooltip;
  }
  return {
    item,
    children
  };
}

function getActivityLabel(event) {
  if (event.action === 'conflict' && event.relativePath) {
    return `Conflict: ${event.relativePath.split('/').pop()}`;
  }
  if (event.relativePath) {
    return event.relativePath.split('/').pop();
  }
  return event.detail || 'RKsync activity';
}

function getActivityDescription(event) {
  const parts = [];
  if (event.action === 'conflict') {
    parts.push('Studio conflict');
  } else if (event.source === 'local') {
    parts.push(event.action === 'delete' ? 'VS Code delete' : 'VS Code change');
  } else if (event.source === 'studio') {
    parts.push(event.action === 'delete' ? 'Studio delete' : 'Studio change');
  } else {
    parts.push('RKsync');
  }

  if (event.relativePath) {
    parts.push(event.relativePath);
  } else if (event.detail) {
    parts.push(event.detail);
  }
  parts.push(formatRelativeTime(event.timestamp));
  return parts.join(' | ');
}

function getActivityTooltip(event) {
  const lines = [
    `Time: ${formatTimestamp(event.timestamp)}`,
    `Source: ${event.source}`,
    `Action: ${event.action}`
  ];
  if (event.relativePath) {
    lines.push(`Path: ${event.relativePath}`);
  }
  if (event.detail) {
    lines.push(`Detail: ${event.detail}`);
  }
  return lines.join('\n');
}

function getActivityIcon(event) {
  if (event.action === 'conflict') {
    return {
      iconId: 'warning',
      colorId: 'testing.iconFailed'
    };
  }
  if (event.source === 'local') {
    return {
      iconId: event.action === 'delete' ? 'trash' : 'arrow-up',
      colorId: event.action === 'delete' ? 'problemsErrorIcon.foreground' : 'testing.iconQueued'
    };
  }
  if (event.source === 'studio') {
    return {
      iconId: event.action === 'delete' ? 'trash' : 'arrow-down',
      colorId: event.action === 'delete' ? 'problemsErrorIcon.foreground' : 'testing.iconPassed'
    };
  }
  return {
    iconId: 'history',
    colorId: undefined
  };
}

function getFileIcon(className, status) {
  if (status?.state === 'pending') {
    return {
      iconId: 'clock',
      colorId: 'testing.iconQueued'
    };
  }
  if (status?.source === 'local') {
    return {
      iconId: 'arrow-up',
      colorId: 'testing.iconPassed'
    };
  }
  if (status?.source === 'studio') {
    return {
      iconId: 'arrow-down',
      colorId: 'testing.iconPassed'
    };
  }
  if (className === 'Script') {
    return {
      iconId: 'symbol-method',
      colorId: undefined
    };
  }
  if (className === 'LocalScript') {
    return {
      iconId: 'device-mobile',
      colorId: undefined
    };
  }
  return {
    iconId: 'package',
    colorId: undefined
  };
}

class RKsyncTreeProvider {
  constructor(controller) {
    this.controller = controller;
    this.view = null;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  attachView(view) {
    this.view = view;
    this.refresh();
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(item) {
    return item.item;
  }

  getChildren(item) {
    if (item) {
      return item.children ?? [];
    }
    return this.buildRootItems();
  }

  buildRootItems() {
    return [];
  }
}

class RKsyncStatusProvider extends RKsyncTreeProvider {
  refresh() {
    super.refresh();
    if (!this.view) {
      return;
    }

    const info = this.controller.buildInfo();
    this.view.description = info.connected ? 'Connected' : 'Disconnected';
    this.view.message = info.connectionSummary;
    this.view.badge = info.connected
      ? undefined
      : {
          value: 1,
          tooltip: info.connectionSummary
        };
  }

  buildRootItems() {
    const info = this.controller.buildInfo();
    const items = [];

    const statusItem = createTreeNode({
      label: info.connected ? 'Studio Connected' : 'Studio Not Connected',
      description: info.statusDetail,
      iconId: info.connected ? 'pass-filled' : 'error',
      colorId: info.connected ? 'testing.iconPassed' : 'testing.iconFailed',
      command: {
        command: 'rksync.showStatus',
        title: 'Show Status'
      },
      tooltip: info.statusTooltip
    });
    items.push(statusItem);

    items.push(
      createTreeNode({
        label: 'Workspace',
        description: info.workspace,
        iconId: 'folder',
        tooltip: `Current workspace: ${info.workspace}`
      })
    );

    items.push(
      createTreeNode({
        label: 'Sync Folder',
        description: info.syncRoot,
        iconId: 'folder-opened',
        command: {
          command: 'rksync.openSyncFolder',
          title: 'Open Sync Folder'
        },
        tooltip: info.syncRootPath || 'No workspace folder is open.'
      })
    );

    items.push(
      createTreeNode({
        label: info.pluginInstalled ? 'Reinstall Roblox Plugin' : 'Install Roblox Plugin',
        description: info.pluginInstalled ? 'Installed for Studio' : 'One-click setup',
        iconId: info.pluginInstalled ? 'check' : 'cloud-download',
        colorId: info.pluginInstalled ? 'testing.iconPassed' : 'testing.iconQueued',
        command: {
          command: 'rksync.installPlugin',
          title: 'Install Roblox Plugin'
        },
        tooltip: info.pluginInstallTooltip
      })
    );

    items.push(
      createTreeNode({
        label: 'Configuration',
        description: info.configSource,
        iconId: 'settings-gear',
        tooltip: info.configTooltip
      })
    );

    items.push(
      createTreeNode({
        label: 'Tracked Files',
        description: `${info.fileCount} file(s)`,
        iconId: 'files',
        tooltip: [
          `${info.fileCount} tracked script file(s)`,
          `${info.tombstoneCount} remembered delete tombstone(s)`,
          `${info.journalDepth} queued local operation(s)`
        ].join('\n')
      })
    );

    if (info.workspaceMode !== 'Single workspace folder') {
      items.push(
        createTreeNode({
          label: 'Workspace Mode',
          description: info.workspaceMode,
          iconId: 'info',
          colorId: 'problemsWarningIcon.foreground',
          tooltip: info.workspaceMode
        })
      );
    }

    items.push(
      createTreeNode({
        label: 'Last Studio Heartbeat',
        description: info.lastStudioSeenLabel,
        iconId: 'history',
        tooltip: info.lastStudioSeenTooltip
      })
    );

    items.push(
      createTreeNode({
        label: 'Last Local Scan',
        description: info.lastReconcileLabel,
        iconId: 'search',
        tooltip: info.lastReconcileTooltip
      })
    );

    if (info.configWarning) {
      items.push(
        createTreeNode({
          label: 'Config Warning',
          description: 'Fallback active',
          iconId: 'warning',
          colorId: 'problemsWarningIcon.foreground',
          tooltip: info.configWarning
        })
      );
    }

    items.push(
      createTreeNode({
        label: 'Rebuild Sync State',
        description: 'Scan the local sync folder again',
        iconId: 'refresh',
        command: {
          command: 'rksync.rebuildState',
          title: 'Rebuild Sync State'
        },
        tooltip: 'Re-scan local files and refresh the sync state.'
      })
    );

    items.push(
      createTreeNode({
        label: 'Reload RKsync',
        description: 'Apply workspace or settings changes',
        iconId: 'debug-restart',
        command: {
          command: 'rksync.reloadConfiguration',
          title: 'Reload RKsync'
        },
        tooltip: 'Restart the RKsync runtime and reload configuration.'
      })
    );

    items.push(
      createTreeNode({
        label: 'Open Output',
        description: 'Inspect sync logs',
        iconId: 'output',
        command: {
          command: 'rksync.showOutput',
          title: 'Show Output'
        },
        tooltip: 'Open the RKsync output channel.'
      })
    );

    if (info.lastError) {
      items.push(
        createTreeNode({
          label: 'Last Error',
          description: info.lastError,
          iconId: 'warning',
          colorId: 'problemsErrorIcon.foreground',
          tooltip: info.lastError
        })
      );
    }

    return items;
  }
}

class RKsyncActivityProvider extends RKsyncTreeProvider {
  refresh() {
    super.refresh();
    if (!this.view) {
      return;
    }

    const count = this.controller.recentActivity.length;
    this.view.description = count > 0 ? `${count} recent` : 'Idle';
    this.view.message = count > 0 ? undefined : 'Recent sync activity will show up here.';
  }

  buildRootItems() {
    const events = this.controller.recentActivity;
    if (events.length === 0) {
      return [
        createTreeNode({
          label: 'No sync activity yet',
          description: 'Edit a synced file or reconnect Studio',
          iconId: 'history',
          tooltip: 'Recent sync activity will appear here.'
        })
      ];
    }

    return events.map((event) => {
      const icon = getActivityIcon(event);
      return createTreeNode({
        label: getActivityLabel(event),
        description: getActivityDescription(event),
        iconId: icon.iconId,
        colorId: icon.colorId,
        tooltip: getActivityTooltip(event)
      });
    });
  }
}

class RKsyncFilesProvider extends RKsyncTreeProvider {
  refresh() {
    super.refresh();
    if (!this.view) {
      return;
    }

    const count = Object.keys(this.controller.state.scripts).length;
    this.view.description = count > 0 ? `${count} tracked` : 'Empty';
    this.view.message = count > 0 ? undefined : 'Synced files will appear here.';
  }

  buildRootItems() {
    const entries = Object.values(this.controller.state.scripts).sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    );

    if (entries.length === 0) {
      return [
        createTreeNode({
          label: 'No synced files yet',
          description: 'Connect Studio or add a script under the sync folder',
          iconId: 'files',
          tooltip: 'RKsync will list tracked Roblox script files here.'
        })
      ];
    }

    const root = {
      folders: new Map(),
      files: []
    };

    for (const entry of entries) {
      const parsed = parseRelativeScriptPath(entry.relativePath);
      let current = root;
      for (const segment of parsed.parentSegments) {
        if (!current.folders.has(segment)) {
          current.folders.set(segment, {
            name: segment,
            folders: new Map(),
            files: []
          });
        }
        current = current.folders.get(segment);
      }
      current.files.push(entry);
    }

    const buildFolderNodes = (folder) => {
      const folderNodes = Array.from(folder.folders.values())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((childFolder) =>
          createTreeNode({
            label: childFolder.name,
            description: undefined,
            iconId: 'folder',
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            children: buildFolderNodes(childFolder)
          })
        );

      const fileNodes = folder.files
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
        .map((entry) => {
          const status = this.controller.fileStatuses.get(entry.relativePath);
          const icon = getFileIcon(entry.className, status);
          const absPath = this.controller.resolveSyncPath(entry.relativePath);
          const description = this.controller.describeFileStatus(entry.relativePath, entry.className);
          const tooltip = [
            `Relative path: ${entry.relativePath}`,
            `Roblox path: ${entry.instancePath}`,
            `Type: ${entry.className}`,
            `Last update: ${description}`
          ].join('\n');
          return createTreeNode({
            label: entry.relativePath.split('/').pop(),
            description,
            iconId: icon.iconId,
            colorId: icon.colorId,
            tooltip,
            command: {
              command: 'vscode.open',
              title: 'Open Synced File',
              arguments: [vscode.Uri.file(absPath)]
            }
          });
        });

      return [...folderNodes, ...fileNodes];
    };

    return buildFolderNodes(root);
  }
}

class RKsyncController {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('RKsync');
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.server = null;
    this.serverPort = null;
    this.serverRunning = false;
    this.watchers = [];
    this.workspaceFolder = null;
    this.workspacePath = null;
    this.workspaceConfigPath = null;
    this.workspaceModeMessage = '';
    this.syncRootName = DEFAULT_SYNC_ROOT;
    this.syncRootPath = null;
    this.stateDirPath = null;
    this.stateFilePath = null;
    this.legacyStateDirPath = null;
    this.legacyStateFilePath = null;
    this.state = createInitialState(DEFAULT_SYNC_ROOT);
    this.pathToId = new Map();
    this.mutedWrites = new Map();
    this.pendingFileEvents = new Map();
    this.pendingJournal = [];
    this.sequence = 0;
    this.lastStudioSeenAt = 0;
    this.lastStudioAction = '';
    this.lastReconcileAt = 0;
    this.lastErrorMessage = '';
    this.configurationSourceLabel = 'Defaults';
    this.configurationWarningMessage = '';
    this.statusProvider = new RKsyncStatusProvider(this);
    this.activityProvider = new RKsyncActivityProvider(this);
    this.filesProvider = new RKsyncFilesProvider(this);
    this.statusTreeView = null;
    this.activityTreeView = null;
    this.filesTreeView = null;
    this.fileStatuses = new Map();
    this.recentActivity = [];
    this.ignoreMatcher = null;
    this.reconcilePromise = null;
    this.refreshTimer = null;
    this.pluginInstallPromptShown = false;
    this.runtimeReloadTimer = null;
    this.runtimeReloadPromise = null;
    this.pendingReloadRequest = null;
  }

  log(message) {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  setLastError(message) {
    this.lastErrorMessage = message;
    this.refreshVisualState(true);
  }

  clearLastError() {
    if (!this.lastErrorMessage) {
      return;
    }
    this.lastErrorMessage = '';
    this.refreshVisualState(true);
  }

  markStudioSeen(action) {
    this.lastStudioSeenAt = now();
    this.lastStudioAction = action;
    this.lastErrorMessage = '';
    this.refreshVisualState(true);
  }

  isStudioConnected() {
    return (
      this.serverRunning &&
      Boolean(this.lastStudioSeenAt) &&
      now() - this.lastStudioSeenAt <= CONNECTED_GRACE_MS
    );
  }

  describeFileStatus(relativePath, className) {
    const status = this.fileStatuses.get(relativePath);
    if (!status) {
      return className;
    }

    const when = formatRelativeTime(status.timestamp);
    if (status.source === 'local') {
      if (status.state === 'pending') {
        return this.isStudioConnected()
          ? `${className} | waiting for Studio (${when})`
          : `${className} | pending reconnect (${when})`;
      }
      return `${className} | sent to Studio (${when})`;
    }
    if (status.source === 'studio') {
      return `${className} | synced from Studio (${when})`;
    }
    return `${className} | ${status.detail || when}`;
  }

  markFileStatus(relativePath, status) {
    if (!relativePath) {
      return;
    }
    this.fileStatuses.set(relativePath, {
      ...status,
      timestamp: status.timestamp ?? now()
    });
  }

  clearFileStatus(relativePath) {
    if (!relativePath) {
      return;
    }
    this.fileStatuses.delete(relativePath);
  }

  recordActivity(event) {
    this.recentActivity.unshift({
      ...event,
      timestamp: event.timestamp ?? now()
    });
    if (this.recentActivity.length > RECENT_ACTIVITY_LIMIT) {
      this.recentActivity = this.recentActivity.slice(0, RECENT_ACTIVITY_LIMIT);
    }
  }

  async readWorkspaceConfigFile(warnings) {
    if (!this.workspaceConfigPath || !fssync.existsSync(this.workspaceConfigPath)) {
      return {};
    }

    try {
      const raw = await fs.readFile(this.workspaceConfigPath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error(`${WORKSPACE_CONFIG_FILE_NAME} must contain a JSON object.`);
      }
      return parsed;
    } catch (error) {
      warnings.push(`Ignoring ${WORKSPACE_CONFIG_FILE_NAME}: ${error.message}`);
      return {};
    }
  }

  async getConfiguration() {
    const warnings = [];
    const config = vscode.workspace.getConfiguration('rksync', this.workspaceFolder?.uri);
    const legacyConfig = vscode.workspace.getConfiguration('morgSync', this.workspaceFolder?.uri);
    const portInfo = pickConfiguredValueInfo(config, legacyConfig, 'port', DEFAULT_PORT);
    const syncRootInfo = pickConfiguredValueInfo(config, legacyConfig, 'syncRoot', DEFAULT_SYNC_ROOT);
    const workspaceConfig = await this.readWorkspaceConfigFile(warnings);

    let port = DEFAULT_PORT;
    let syncRoot = DEFAULT_SYNC_ROOT;
    let portSource = portInfo.source;
    let syncRootSource = syncRootInfo.source;

    try {
      port = parseConfiguredPort(portInfo.value, DEFAULT_PORT);
    } catch (error) {
      warnings.push(`Invalid VS Code port setting. Using ${DEFAULT_PORT}. ${error.message}`);
      port = DEFAULT_PORT;
      portSource = 'Defaults';
    }

    try {
      syncRoot = parseConfiguredSyncRoot(syncRootInfo.value, DEFAULT_SYNC_ROOT);
    } catch (error) {
      warnings.push(`Invalid VS Code sync root setting. Using ${DEFAULT_SYNC_ROOT}. ${error.message}`);
      syncRoot = DEFAULT_SYNC_ROOT;
      syncRootSource = 'Defaults';
    }

    if (Object.prototype.hasOwnProperty.call(workspaceConfig, 'port')) {
      try {
        port = parseConfiguredPort(workspaceConfig.port, port);
        portSource = WORKSPACE_CONFIG_FILE_NAME;
      } catch (error) {
        warnings.push(`Invalid ${WORKSPACE_CONFIG_FILE_NAME} port. Using ${port}. ${error.message}`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(workspaceConfig, 'syncRoot')) {
      try {
        syncRoot = parseConfiguredSyncRoot(workspaceConfig.syncRoot, syncRoot);
        syncRootSource = WORKSPACE_CONFIG_FILE_NAME;
      } catch (error) {
        warnings.push(`Invalid ${WORKSPACE_CONFIG_FILE_NAME} syncRoot. Using ${syncRoot}. ${error.message}`);
      }
    }

    this.configurationSourceLabel = `Port: ${portSource} | Sync root: ${syncRootSource}`;
    this.configurationWarningMessage = warnings.join(' | ');

    for (const warning of warnings) {
      this.log(warning);
    }

    if (warnings.length > 0) {
      vscode.window.showWarningMessage(`RKsync configuration fallback active. ${warnings[0]}`);
    }

    return {
      port,
      syncRoot
    };
  }

  buildInfo() {
    const pluginInstallInfo = this.getPluginInstallInfo();
    const hasWorkspace = Boolean(this.workspaceFolder);
    const connected = this.isStudioConnected();
    const workspaceMode = hasWorkspace
      ? this.workspaceModeMessage || 'Single workspace folder'
      : 'No workspace folder open';

    let connectionSummary = 'Open a folder to start the RKsync localhost server.';
    if (hasWorkspace && !this.serverRunning) {
      connectionSummary = this.lastErrorMessage
        ? `Server not running: ${this.lastErrorMessage}`
        : 'Server not running yet.';
    } else if (this.serverRunning && connected) {
      connectionSummary = `Roblox Studio is connected. Last heartbeat ${formatRelativeTime(this.lastStudioSeenAt)}.`;
    } else if (this.serverRunning && this.lastStudioSeenAt) {
      connectionSummary = `Roblox Studio is not connected right now. Last heartbeat ${formatRelativeTime(this.lastStudioSeenAt)}.`;
    } else if (this.serverRunning) {
      connectionSummary =
        'Server is ready on localhost. In Studio, keep the localhost URL, use Test Connection, then click Start Sync.';
    }

    const statusDetail = this.serverRunning
      ? connected
        ? `Port ${this.serverPort} | ${formatRelativeTime(this.lastStudioSeenAt)}`
        : this.lastStudioSeenAt
          ? `Port ${this.serverPort} | last seen ${formatRelativeTime(this.lastStudioSeenAt)}`
          : `Port ${this.serverPort} | waiting for Studio`
      : hasWorkspace
        ? 'Server unavailable'
        : 'No workspace';

    const statusTooltip = [
      `Workspace: ${this.workspaceFolder?.name ?? '(none)'}`,
      `Workspace mode: ${workspaceMode}`,
      `Workspace config: ${this.workspaceConfigPath ?? '(none)'}`,
      `Configuration source: ${this.configurationSourceLabel}`,
      `Sync root: ${this.syncRootName}`,
      `Server: ${this.serverRunning ? `127.0.0.1:${this.serverPort}` : 'offline'}`,
      `Studio: ${connected ? 'connected' : 'not connected'}`,
      `Last heartbeat: ${formatTimestamp(this.lastStudioSeenAt)}${this.lastStudioAction ? ` (${this.lastStudioAction})` : ''}`,
      `Last local scan: ${formatTimestamp(this.lastReconcileAt)}`,
      `Tracked files: ${Object.keys(this.state.scripts).length}`,
      `Journal depth: ${this.pendingJournal.length}`,
      this.configurationWarningMessage
        ? `Config warning: ${this.configurationWarningMessage}`
        : 'Config warning: none',
      this.lastErrorMessage ? `Last error: ${this.lastErrorMessage}` : 'Last error: none'
    ].join('\n');

    return {
      connected,
      workspace: this.workspaceFolder?.name ?? '(none)',
      workspaceMode,
      syncRoot: this.syncRootName,
      syncRootPath: this.syncRootPath,
      pluginInstalled: pluginInstallInfo.installed,
      pluginInstallTooltip: pluginInstallInfo.error
        ? pluginInstallInfo.error
        : [
            `Destination: ${pluginInstallInfo.destination}`,
            pluginInstallInfo.installed
              ? 'Roblox Studio plugin is installed.'
              : 'Roblox Studio plugin is not installed yet.',
            pluginInstallInfo.legacyInstalled ? 'Legacy MorgSync plugin is still present.' : 'Legacy MorgSync plugin not found.'
          ].join('\n'),
      configSource: this.configurationSourceLabel,
      configWarning: this.configurationWarningMessage,
      configTooltip: [
        `Workspace config file: ${this.workspaceConfigPath ?? '(none)'}`,
        `Configuration source: ${this.configurationSourceLabel}`,
        this.configurationWarningMessage
          ? `Fallback: ${this.configurationWarningMessage}`
          : 'Fallback: none'
      ].join('\n'),
      fileCount: Object.keys(this.state.scripts).length,
      tombstoneCount: Object.keys(this.state.tombstones).length,
      journalDepth: this.pendingJournal.length,
      sequence: this.sequence,
      serverRunning: this.serverRunning,
      serverPort: this.serverPort,
      connectionSummary,
      statusDetail,
      statusTooltip,
      lastStudioSeenAt: this.lastStudioSeenAt,
      lastStudioSeenLabel: this.lastStudioSeenAt ? formatRelativeTime(this.lastStudioSeenAt) : 'Never',
      lastStudioSeenTooltip: this.lastStudioSeenAt
        ? `${formatTimestamp(this.lastStudioSeenAt)}${this.lastStudioAction ? ` via ${this.lastStudioAction}` : ''}`
        : 'No heartbeat received from the Roblox Studio plugin yet.',
      lastReconcileAt: this.lastReconcileAt,
      lastReconcileLabel: this.lastReconcileAt ? formatRelativeTime(this.lastReconcileAt) : 'Never',
      lastReconcileTooltip: this.lastReconcileAt
        ? `Last local disk scan completed at ${formatTimestamp(this.lastReconcileAt)}`
        : 'No local disk scan has completed yet.',
      lastError: this.lastErrorMessage
    };
  }

  refreshVisualState(refreshDataViews = true) {
    const info = this.buildInfo();
    this.statusItem.text = !this.workspaceFolder
      ? '$(folder-opened) RKsync Open Folder'
      : info.connected
        ? '$(pass-filled) RKsync Connected'
        : '$(error) RKsync Disconnected';
    this.statusItem.color = !this.workspaceFolder
      ? new vscode.ThemeColor('testing.iconQueued')
      : new vscode.ThemeColor(info.connected ? 'testing.iconPassed' : 'testing.iconFailed');
    this.statusItem.tooltip = info.statusTooltip;
    this.statusItem.command = 'rksync.showStatus';
    this.statusItem.show();
    this.statusProvider.refresh();
    if (refreshDataViews) {
      this.activityProvider.refresh();
      this.filesProvider.refresh();
    }
  }

  async activate() {
    this.statusTreeView = vscode.window.createTreeView('rksync.status', {
      treeDataProvider: this.statusProvider,
      showCollapseAll: false
    });
    this.activityTreeView = vscode.window.createTreeView('rksync.activity', {
      treeDataProvider: this.activityProvider,
      showCollapseAll: false
    });
    this.filesTreeView = vscode.window.createTreeView('rksync.files', {
      treeDataProvider: this.filesProvider,
      showCollapseAll: true
    });
    this.statusProvider.attachView(this.statusTreeView);
    this.activityProvider.attachView(this.activityTreeView);
    this.filesProvider.attachView(this.filesTreeView);

    this.context.subscriptions.push(
      this.output,
      this.statusItem,
      this.statusTreeView,
      this.activityTreeView,
      this.filesTreeView,
      vscode.commands.registerCommand('rksync.showStatus', () => this.showStatus()),
      vscode.commands.registerCommand('rksync.installPlugin', () => this.installPlugin()),
      vscode.commands.registerCommand('rksync.reloadConfiguration', () =>
        this.reloadRuntime('manual reload', { notifyUser: true })
      ),
      vscode.commands.registerCommand('rksync.openSyncFolder', () => this.openSyncFolder()),
      vscode.commands.registerCommand('rksync.rebuildState', () => this.rebuildState()),
      vscode.commands.registerCommand('rksync.showOutput', () => this.output.show(true)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.scheduleRuntimeReload('workspace folders changed');
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        const target = this.workspaceFolder?.uri;
        if (
          event.affectsConfiguration('rksync', target) ||
          event.affectsConfiguration('morgSync', target)
        ) {
          this.scheduleRuntimeReload('VS Code settings changed');
        }
      })
    );

    this.refreshTimer = setInterval(() => this.refreshVisualState(false), SIDEBAR_REFRESH_MS);
    this.context.subscriptions.push({
      dispose: () => {
        if (this.refreshTimer) {
          clearInterval(this.refreshTimer);
          this.refreshTimer = null;
        }
      }
    });

    await this.reloadRuntime('extension startup');
    void this.maybePromptPluginInstall();
  }

  selectWorkspaceFolder() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.workspaceFolder = null;
      this.workspacePath = null;
      this.workspaceConfigPath = null;
      this.workspaceModeMessage = 'Open a folder to start RKsync.';
      return false;
    }

    this.workspaceFolder = folders[0];
    this.workspacePath = this.workspaceFolder.uri.fsPath;
    this.workspaceConfigPath = path.join(this.workspacePath, WORKSPACE_CONFIG_FILE_NAME);
    if (folders.length > 1) {
      this.workspaceModeMessage = `Multiple workspace folders are open. RKsync is using only the first folder: ${this.workspaceFolder.name}`;
      this.log(this.workspaceModeMessage);
    } else {
      this.workspaceModeMessage = 'Single workspace folder';
    }
    return true;
  }

  resetRuntimeState() {
    this.server = null;
    this.serverPort = null;
    this.serverRunning = false;
    this.watchers = [];
    this.syncRootName = DEFAULT_SYNC_ROOT;
    this.syncRootPath = null;
    this.stateDirPath = null;
    this.stateFilePath = null;
    this.legacyStateDirPath = null;
    this.legacyStateFilePath = null;
    this.state = createInitialState(DEFAULT_SYNC_ROOT);
    this.pathToId.clear();
    this.mutedWrites.clear();
    this.pendingJournal = [];
    this.sequence = 0;
    this.lastStudioSeenAt = 0;
    this.lastStudioAction = '';
    this.lastReconcileAt = 0;
    this.configurationSourceLabel = 'Defaults';
    this.configurationWarningMessage = '';
    this.fileStatuses.clear();
    this.ignoreMatcher = null;
  }

  disposeWatchers() {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
  }

  clearPendingFileEvents() {
    for (const pending of this.pendingFileEvents.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingFileEvents.clear();
  }

  async stopRuntime() {
    this.disposeWatchers();
    this.clearPendingFileEvents();

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }

    this.resetRuntimeState();
    this.refreshVisualState(true);
  }

  async prepareWorkspaceRuntime(reason) {
    const configuration = await this.getConfiguration();
    const port = configuration.port;
    this.syncRootName = configuration.syncRoot;
    this.syncRootPath = path.join(this.workspacePath, this.syncRootName);
    this.stateDirPath = path.join(this.workspacePath, STATE_DIR_NAME);
    this.stateFilePath = path.join(this.stateDirPath, STATE_FILE_NAME);
    this.legacyStateDirPath = path.join(this.workspacePath, LEGACY_STATE_DIR_NAME);
    this.legacyStateFilePath = path.join(this.legacyStateDirPath, STATE_FILE_NAME);

    await this.migrateLegacyStateIfNeeded();
    await fs.mkdir(this.syncRootPath, { recursive: true });
    await fs.mkdir(this.stateDirPath, { recursive: true });
    await this.loadState();
    this.ignoreMatcher = new IgnoreMatcher(this.syncRootPath);
    await this.canonicalizeTrackedPaths();
    await this.reconcileLocalDisk({ emitOps: true, reason });
    this.startWatchers();
    this.serverPort = port;
    await this.startServer(port);
  }

  scheduleRuntimeReload(reason, { notifyUser = false } = {}) {
    if (this.runtimeReloadTimer) {
      clearTimeout(this.runtimeReloadTimer);
    }

    this.pendingReloadRequest = {
      reason,
      notifyUser: notifyUser || this.pendingReloadRequest?.notifyUser === true
    };

    this.runtimeReloadTimer = setTimeout(() => {
      this.runtimeReloadTimer = null;
      const pending = this.pendingReloadRequest;
      this.pendingReloadRequest = null;
      void this.reloadRuntime(pending?.reason || reason, {
        notifyUser: pending?.notifyUser === true
      }).catch((error) => {
        this.log(`Runtime reload failed: ${error.stack || error.message}`);
        this.setLastError(error.message);
      });
    }, RUNTIME_RELOAD_DEBOUNCE_MS);
  }

  async reloadRuntime(reason, { notifyUser = false } = {}) {
    if (this.runtimeReloadPromise) {
      this.pendingReloadRequest = {
        reason,
        notifyUser: notifyUser || this.pendingReloadRequest?.notifyUser === true
      };
      return this.runtimeReloadPromise;
    }

    this.runtimeReloadPromise = (async () => {
      await this.stopRuntime();

      if (!this.selectWorkspaceFolder()) {
        this.log('RKsync is waiting for a workspace folder. Open a folder and the localhost server will start automatically.');
        this.refreshVisualState(true);
        return false;
      }

      try {
        await this.prepareWorkspaceRuntime(reason);
      } catch (error) {
        const message =
          error?.code === 'EADDRINUSE' || error?.code === 'EACCES'
            ? describeServerStartError(error, this.serverPort ?? DEFAULT_PORT)
            : error.message;
        await this.stopRuntime();
        this.setLastError(message);
        this.log(`Failed to initialize RKsync for workspace ${this.workspaceFolder.name}: ${error.stack || error.message}`);
        vscode.window.showErrorMessage(`RKsync could not prepare the workspace: ${message}`);
        return false;
      }

      this.clearLastError();
      if (reason !== 'extension startup') {
        this.recordActivity({
          source: 'system',
          action: 'reload',
          detail: reason
        });
        this.log(`Reloaded RKsync runtime (${reason}).`);
      }
      this.refreshVisualState(true);
      if (notifyUser) {
        vscode.window.showInformationMessage(`RKsync reloaded successfully (${reason}).`);
      }
      return true;
    })();

    try {
      return await this.runtimeReloadPromise;
    } finally {
      this.runtimeReloadPromise = null;
      if (this.pendingReloadRequest) {
        const pending = this.pendingReloadRequest;
        this.pendingReloadRequest = null;
        this.scheduleRuntimeReload(pending.reason, {
          notifyUser: pending.notifyUser
        });
      }
    }
  }

  getPluginInstallInfo() {
    try {
      return getRobloxPluginInstallInfo(this.context.extensionPath);
    } catch (error) {
      return {
        destination: '',
        error: error.message,
        installed: false,
        legacyInstalled: false
      };
    }
  }

  async installPlugin() {
    try {
      const installInfo = await installRobloxPluginFiles(this.context.extensionPath);
      this.log(`Installed Roblox Studio plugin to ${installInfo.destination}`);
      this.refreshVisualState(true);
      const choice = await vscode.window.showInformationMessage(
        'RKsync installed the Roblox Studio plugin successfully.',
        'Reveal Plugin File'
      );
      if (choice === 'Reveal Plugin File') {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(installInfo.destination));
      }
    } catch (error) {
      this.log(`Failed to install Roblox Studio plugin: ${error.stack || error.message}`);
      vscode.window.showErrorMessage(`RKsync could not install the Roblox Studio plugin: ${error.message}`);
    }
  }

  async maybePromptPluginInstall() {
    if (this.pluginInstallPromptShown) {
      return;
    }
    if (!this.workspaceFolder) {
      return;
    }

    const installInfo = this.getPluginInstallInfo();
    if (installInfo.installed) {
      return;
    }

    this.pluginInstallPromptShown = true;
    const choice = await vscode.window.showInformationMessage(
      'RKsync can install the Roblox Studio plugin for you.',
      'Install Plugin'
    );
    if (choice === 'Install Plugin') {
      await this.installPlugin();
    }
  }

  async deactivate() {
    if (this.runtimeReloadTimer) {
      clearTimeout(this.runtimeReloadTimer);
      this.runtimeReloadTimer = null;
    }

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    await this.stopRuntime();
  }

  async migrateLegacyStateIfNeeded() {
    if (!this.legacyStateDirPath || !this.legacyStateFilePath) {
      return;
    }

    if (!fssync.existsSync(this.legacyStateFilePath) || fssync.existsSync(this.stateFilePath)) {
      return;
    }

    if (!fssync.existsSync(this.stateDirPath) && fssync.existsSync(this.legacyStateDirPath)) {
      await fs.rename(this.legacyStateDirPath, this.stateDirPath);
      this.log('Migrated legacy .morg-sync state directory to .rksync.');
      return;
    }

    await fs.mkdir(this.stateDirPath, { recursive: true });
    await fs.copyFile(this.legacyStateFilePath, this.stateFilePath);
    this.log('Copied legacy .morg-sync state.json into .rksync.');
  }

  async loadState() {
    if (!fssync.existsSync(this.stateFilePath)) {
      this.state = createInitialState(this.syncRootName);
      await this.saveState();
      this.rebuildIndices();
      return;
    }

    const raw = await fs.readFile(this.stateFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    this.state = {
      version: 1,
      config: {
        syncRoot: this.syncRootName
      },
      scripts: parsed.scripts ?? {},
      tombstones: parsed.tombstones ?? {}
    };
    this.rebuildIndices();
  }

  async canonicalizeTrackedPaths() {
    let changed = false;

    for (const entry of Object.values(this.state.scripts)) {
      const canonicalPath = canonicalizeRelativePath(entry.relativePath, entry.className);
      if (canonicalPath === entry.relativePath) {
        continue;
      }

      const oldAbsPath = this.resolveSyncPath(entry.relativePath);
      const newAbsPath = this.resolveSyncPath(canonicalPath);

      if (fssync.existsSync(oldAbsPath)) {
        await fs.mkdir(path.dirname(newAbsPath), { recursive: true });
        if (!fssync.existsSync(newAbsPath)) {
          await fs.rename(oldAbsPath, newAbsPath);
          await this.removeEmptyAncestorDirs(oldAbsPath);
        } else if (oldAbsPath !== newAbsPath) {
          await fs.rm(oldAbsPath, { force: true });
          await this.removeEmptyAncestorDirs(oldAbsPath);
        }
      }

      entry.relativePath = canonicalPath;
      entry.instancePath = relativePathToInstancePath(canonicalPath);
      changed = true;
    }

    if (!changed) {
      this.rebuildIndices();
      return;
    }

    for (const tombstone of Object.values(this.state.tombstones)) {
      if (!tombstone.className) {
        continue;
      }
      tombstone.relativePath = canonicalizeRelativePath(tombstone.relativePath, tombstone.className);
    }

    this.rebuildIndices();
    await this.saveState();
    this.log('Canonicalized tracked script paths to match their script classes.');
  }

  async saveState() {
    this.state.config.syncRoot = this.syncRootName;
    await fs.writeFile(this.stateFilePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  rebuildIndices() {
    this.pathToId.clear();
    for (const [id, entry] of Object.entries(this.state.scripts)) {
      if (entry?.relativePath) {
        this.pathToId.set(entry.relativePath, id);
      }
    }
  }

  async removeEmptyAncestorDirs(absPath) {
    if (!this.syncRootPath) {
      return;
    }

    const base = path.resolve(this.syncRootPath);
    let current = path.dirname(absPath);
    while (current.startsWith(base) && current !== base) {
      let entries = [];
      try {
        entries = await fs.readdir(current);
      } catch {
        break;
      }

      if (entries.length > 0) {
        break;
      }

      await fs.rmdir(current);
      current = path.dirname(current);
    }
  }

  async ensureFreshLocalState({ force = false, reason = 'Studio reconnect' } = {}) {
    if (!this.workspaceFolder) {
      return {
        changed: false,
        scannedFiles: 0,
        upserts: 0,
        deletes: 0
      };
    }

    if (this.reconcilePromise) {
      return this.reconcilePromise;
    }

    if (!force && this.lastReconcileAt && now() - this.lastReconcileAt < RECONCILE_STALE_MS) {
      return {
        changed: false,
        scannedFiles: Object.keys(this.state.scripts).length,
        upserts: 0,
        deletes: 0
      };
    }

    this.reconcilePromise = this.reconcileLocalDisk({
      emitOps: true,
      reason
    });

    try {
      return await this.reconcilePromise;
    } finally {
      this.reconcilePromise = null;
    }
  }

  buildStudioConflictPath(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const segments = normalized.split('/');
    const fileName = segments.pop();
    const conflictName = fileName.replace(/(\.luau|\.lua)$/iu, '.studio$1');
    return path.join(this.stateDirPath, 'conflicts', ...segments, conflictName === fileName ? `${fileName}.studio` : conflictName);
  }

  showStatus() {
    const info = this.buildInfo();
    const lines = [
      `Connection: ${info.connected ? 'connected' : 'disconnected'}`,
      `Workspace: ${info.workspace}`,
      `Workspace mode: ${info.workspaceMode}`,
      `Configuration: ${info.configSource}`,
      `Sync root: ${info.syncRoot}`,
      `Server: ${info.serverRunning ? `127.0.0.1:${info.serverPort}` : 'offline'}`,
      `Last Studio heartbeat: ${info.lastStudioSeenLabel}`,
      `Last local scan: ${info.lastReconcileLabel}`,
      `Files tracked: ${info.fileCount}`,
      `Pending tombstones: ${info.tombstoneCount}`,
      `Journal depth: ${info.journalDepth}`,
      `Sequence: ${info.sequence}`,
      `Config warning: ${info.configWarning || 'none'}`,
      `Last error: ${info.lastError || 'none'}`
    ];
    vscode.window.showInformationMessage(lines.join(' | '), { modal: false });
  }

  async openSyncFolder() {
    if (!this.syncRootPath) {
      vscode.window.showWarningMessage('Open a workspace folder before opening the sync folder.');
      return;
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.syncRootPath));
  }

  async rebuildState() {
    if (!this.workspaceFolder) {
      vscode.window.showWarningMessage('Open a workspace folder before rebuilding sync state.');
      return;
    }
    await this.ensureFreshLocalState({ force: true, reason: 'manual rebuild' });
    this.refreshVisualState(true);
    vscode.window.showInformationMessage('RKsync state rebuilt from local files.');
  }

  startWatchers() {
    const patterns = [
      new vscode.RelativePattern(this.workspaceFolder, `${this.syncRootName}/**/*.lua`),
      new vscode.RelativePattern(this.workspaceFolder, `${this.syncRootName}/**/*.luau`),
      new vscode.RelativePattern(this.workspaceFolder, `${this.syncRootName}/.rksyncignore`)
    ];

    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate((uri) => this.onLocalFileEvent(uri.fsPath, 'create'));
      watcher.onDidChange((uri) => this.onLocalFileEvent(uri.fsPath, 'change'));
      watcher.onDidDelete((uri) => this.onLocalFileEvent(uri.fsPath, 'delete'));
      this.watchers.push(watcher);
      this.context.subscriptions.push(watcher);
    }

    const configWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceFolder, WORKSPACE_CONFIG_FILE_NAME)
    );
    const handleConfigChange = () => {
      this.scheduleRuntimeReload(`${WORKSPACE_CONFIG_FILE_NAME} changed`);
    };
    configWatcher.onDidCreate(handleConfigChange);
    configWatcher.onDidChange(handleConfigChange);
    configWatcher.onDidDelete(handleConfigChange);
    this.watchers.push(configWatcher);
    this.context.subscriptions.push(configWatcher);
  }

  onLocalFileEvent(absPath, kind) {
    const normalizedPath = path.normalize(absPath);
    const existing = this.pendingFileEvents.get(normalizedPath);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.pendingFileEvents.delete(normalizedPath);
      void this.processLocalFileEvent(normalizedPath, kind).catch((error) => {
        this.log(`Local file event failed for ${normalizedPath}: ${error.message}`);
        this.setLastError(error.message);
      });
    }, FILE_EVENT_DEBOUNCE_MS);
    this.pendingFileEvents.set(normalizedPath, { kind, timer });
  }

  async processLocalFileEvent(absPath, kind) {
    if (path.basename(absPath) === '.rksyncignore') {
      if (this.ignoreMatcher) {
        this.ignoreMatcher.loadPatterns();
      }
      await this.reconcileLocalDisk({ emitOps: true, reason: 'ignore rules changed' });
      this.log('Reloaded .rksyncignore patterns.');
      return;
    }

    const muted = await this.isMuted(absPath);
    if (muted) {
      return;
    }

    let relativePath = null;
    try {
      relativePath = normalizeRelativePath(toPosixPath(path.relative(this.syncRootPath, absPath)));
    } catch {
      relativePath = null;
    }

    if (relativePath && this.ignoreMatcher?.isIgnored(relativePath)) {
      return;
    }

    if (kind === 'delete' || !fssync.existsSync(absPath)) {
      await this.handleLocalDelete(absPath);
      return;
    }

    const fileName = path.basename(absPath);
    if (!isSupportedScriptFile(fileName)) {
      return;
    }

    await this.handleLocalUpsert(absPath);
  }

  markMuted(absPath, options) {
    this.mutedWrites.set(path.normalize(absPath), {
      expiresAt: now() + MUTE_TTL_MS,
      ...options
    });
  }

  async isMuted(absPath) {
    const key = path.normalize(absPath);
    const muted = this.mutedWrites.get(key);
    if (!muted) {
      return false;
    }
    if (muted.expiresAt < now()) {
      this.mutedWrites.delete(key);
      return false;
    }
    if (muted.deleted === true) {
      return !fssync.existsSync(key);
    }
    if (!fssync.existsSync(key)) {
      return false;
    }
    const content = await fs.readFile(key, 'utf8');
    return hashContent(content) === muted.hash;
  }

  makeStateEntry(id, relativePath, className, content) {
    return {
      id,
      relativePath,
      className,
      instancePath: relativePathToInstancePath(relativePath),
      hash: hashContent(content),
      updatedAt: now()
    };
  }

  enqueueLocalOp(op) {
    this.sequence += 1;
    const queued = {
      ...op,
      seq: this.sequence
    };
    this.pendingJournal.push(queued);
    if (this.pendingJournal.length > JOURNAL_LIMIT) {
      this.pendingJournal = this.pendingJournal.slice(-JOURNAL_LIMIT);
    }
  }

  setScriptEntry(entry) {
    this.state.scripts[entry.id] = entry;
    this.pathToId.set(entry.relativePath, entry.id);
    delete this.state.tombstones[entry.id];
  }

  removeScriptEntry(id) {
    const current = this.state.scripts[id];
    if (!current) {
      return null;
    }
    delete this.state.scripts[id];
    this.pathToId.delete(current.relativePath);
    return current;
  }

  rememberTombstone(entry) {
    this.state.tombstones[entry.id] = {
      id: entry.id,
      relativePath: entry.relativePath,
      className: entry.className,
      hash: entry.hash,
      updatedAt: entry.updatedAt,
      deletedAt: now()
    };

    const tombstones = Object.values(this.state.tombstones)
      .sort((left, right) => left.deletedAt - right.deletedAt)
      .slice(-TOMBSTONE_LIMIT);

    this.state.tombstones = Object.fromEntries(tombstones.map((item) => [item.id, item]));
  }

  takeReusableTombstone(hash, className, relativePath = null) {
    const cutoff = now() - TOMBSTONE_REUSE_WINDOW_MS;
    let reusable = null;

    if (relativePath) {
      try {
        const parsedCandidate = parseRelativeScriptPath(relativePath);
        reusable = Object.values(this.state.tombstones)
          .filter((entry) => entry.hash === hash && entry.className === className && entry.deletedAt >= cutoff)
          .find((entry) => {
            try {
              return parseRelativeScriptPath(entry.relativePath).scriptName === parsedCandidate.scriptName;
            } catch {
              return false;
            }
          });
      } catch {
        reusable = null;
      }
    }

    if (!reusable) {
      reusable = Object.values(this.state.tombstones)
        .filter((entry) => entry.hash === hash && entry.className === className && entry.deletedAt >= cutoff)
        .sort((left, right) => right.deletedAt - left.deletedAt)[0];
    }

    if (!reusable) {
      return null;
    }

    delete this.state.tombstones[reusable.id];
    return reusable;
  }

  async handleLocalUpsert(absPath) {
    const relativePath = normalizeRelativePath(toPosixPath(path.relative(this.syncRootPath, absPath)));
    const parsed = parseRelativeScriptPath(relativePath);
    const content = await fs.readFile(absPath, 'utf8');
    const hash = hashContent(content);
    const existingId = this.pathToId.get(relativePath);
    const reusableTombstone = existingId
      ? null
      : this.takeReusableTombstone(hash, parsed.className, relativePath);
    const id = existingId ?? reusableTombstone?.id ?? crypto.randomUUID();
    const current = this.state.scripts[id];

    if (
      current &&
      current.hash === hash &&
      current.relativePath === relativePath &&
      current.className === parsed.className
    ) {
      return;
    }

    const entry = this.makeStateEntry(id, relativePath, parsed.className, content);
    this.setScriptEntry(entry);
    await this.saveState();

    this.enqueueLocalOp({
      type: 'upsert',
      id,
      relativePath,
      className: parsed.className,
      instancePath: entry.instancePath,
      content
    });

    this.log(
      reusableTombstone
        ? `Queued local upsert with preserved id ${id}: ${relativePath}`
        : `Queued local upsert: ${relativePath}`
    );
    this.markFileStatus(relativePath, {
      source: 'local',
      action: 'upsert',
      state: 'pending',
      className: parsed.className
    });
    this.recordActivity({
      source: 'local',
      action: 'upsert',
      relativePath,
      detail: reusableTombstone ? `Preserved sync id ${id}` : 'Queued local change'
    });
    this.refreshVisualState(true);
  }

  async handleLocalDelete(absPath) {
    let relativePath;
    try {
      relativePath = normalizeRelativePath(toPosixPath(path.relative(this.syncRootPath, absPath)));
    } catch {
      return;
    }
    const id = this.pathToId.get(relativePath);
    if (!id) {
      return;
    }

    const entry = this.removeScriptEntry(id);
    if (!entry) {
      return;
    }
    this.rememberTombstone(entry);
    await this.saveState();

    this.enqueueLocalOp({
      type: 'delete',
      id,
      relativePath
    });

    this.log(`Queued local delete: ${relativePath}`);
    this.clearFileStatus(relativePath);
    this.recordActivity({
      source: 'local',
      action: 'delete',
      relativePath,
      detail: 'Queued local delete'
    });
    this.refreshVisualState(true);
  }

  async listLocalScriptFiles(rootDir = this.syncRootPath) {
    const found = [];
    if (!fssync.existsSync(rootDir)) {
      return found;
    }
    const queue = [rootDir];
    while (queue.length > 0) {
      const current = queue.pop();
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const absPath = path.join(current, entry.name);
        let relativePath = null;
        try {
          relativePath = normalizeRelativePath(toPosixPath(path.relative(this.syncRootPath, absPath)));
        } catch {
          relativePath = null;
        }

        if (relativePath && this.ignoreMatcher?.isIgnored(relativePath)) {
          continue;
        }

        if (entry.isDirectory()) {
          queue.push(absPath);
          continue;
        }
        if (entry.isFile() && isSupportedScriptFile(entry.name)) {
          found.push(absPath);
        }
      }
    }
    return found.sort();
  }

  async reconcileLocalDisk({ emitOps, reason = 'local scan' }) {
    const files = await this.listLocalScriptFiles();
    const seenPaths = new Set();
    let upserts = 0;
    let deletes = 0;

    for (const absPath of files) {
      const relativePath = normalizeRelativePath(toPosixPath(path.relative(this.syncRootPath, absPath)));
      if (this.ignoreMatcher?.isIgnored(relativePath)) {
        continue;
      }
      seenPaths.add(relativePath);
      const parsed = parseRelativeScriptPath(relativePath);
      const content = await fs.readFile(absPath, 'utf8');
      const hash = hashContent(content);
      const existingId = this.pathToId.get(relativePath);

      if (existingId) {
        const existing = this.state.scripts[existingId];
        if (existing && existing.hash === hash && existing.className === parsed.className) {
          continue;
        }

        const entry = this.makeStateEntry(existingId, relativePath, parsed.className, content);
        this.setScriptEntry(entry);
        upserts += 1;
        if (emitOps) {
          this.enqueueLocalOp({
            type: 'upsert',
            id: existingId,
            relativePath,
            className: parsed.className,
            instancePath: entry.instancePath,
            content
          });
        }
        this.markFileStatus(relativePath, {
          source: 'local',
          action: 'upsert',
          state: 'pending',
          className: parsed.className
        });
        this.recordActivity({
          source: 'local',
          action: 'upsert',
          relativePath,
          detail: `Detected during ${reason}`
        });
        continue;
      }

      const reusableTombstone = this.takeReusableTombstone(hash, parsed.className, relativePath);
      const newId = reusableTombstone?.id ?? crypto.randomUUID();
      const entry = this.makeStateEntry(newId, relativePath, parsed.className, content);
      this.setScriptEntry(entry);
      upserts += 1;
      if (emitOps) {
        this.enqueueLocalOp({
          type: 'upsert',
          id: newId,
          relativePath,
          className: parsed.className,
          instancePath: entry.instancePath,
            content
          });
        }
      this.markFileStatus(relativePath, {
        source: 'local',
        action: 'upsert',
        state: 'pending',
        className: parsed.className
      });
      this.recordActivity({
        source: 'local',
        action: 'upsert',
        relativePath,
        detail: `Added during ${reason}`
      });
    }

    for (const [id, entry] of Object.entries(this.state.scripts)) {
      if (seenPaths.has(entry.relativePath)) {
        continue;
      }
      this.removeScriptEntry(id);
      this.rememberTombstone(entry);
      deletes += 1;
      if (emitOps) {
        this.enqueueLocalOp({
          type: 'delete',
          id,
          relativePath: entry.relativePath
        });
      }
      this.clearFileStatus(entry.relativePath);
      this.recordActivity({
        source: 'local',
        action: 'delete',
        relativePath: entry.relativePath,
        detail: `Removed during ${reason}`
      });
    }

    await this.saveState();
    this.lastReconcileAt = now();
    if (upserts > 0 || deletes > 0 || reason === 'manual rebuild') {
      this.recordActivity({
        source: 'system',
        action: 'reconcile',
        detail: `${reason}: ${upserts} change(s), ${deletes} delete(s)`
      });
    }
    this.log(
      `Reconciled local sync folder against persisted state (${reason}, ${upserts} change(s), ${deletes} delete(s)).`
    );
    this.refreshVisualState(true);
    return {
      changed: upserts > 0 || deletes > 0,
      scannedFiles: files.length,
      upserts,
      deletes
    };
  }

  buildFullSnapshotOps() {
    const upserts = Object.values(this.state.scripts)
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map((entry) => {
        const canonicalPath = canonicalizeRelativePath(entry.relativePath, entry.className);
        const absPath = fssync.existsSync(this.resolveSyncPath(canonicalPath))
          ? this.resolveSyncPath(canonicalPath)
          : this.resolveSyncPath(entry.relativePath);
        const content = fssync.existsSync(absPath) ? fssync.readFileSync(absPath, 'utf8') : '';
        return {
          type: 'upsert',
          id: entry.id,
          relativePath: canonicalPath,
          className: entry.className,
          instancePath: relativePathToInstancePath(canonicalPath),
          content
        };
      });

    const deletes = Object.values(this.state.tombstones).map((entry) => ({
      type: 'delete',
      id: entry.id,
      relativePath: entry.relativePath
    }));

    return [...upserts, ...deletes];
  }

  noteOpsServedToStudio(ops, detail) {
    if (!Array.isArray(ops) || ops.length === 0) {
      return;
    }

    for (const op of ops) {
      if (op.type === 'upsert' && op.relativePath) {
        this.markFileStatus(op.relativePath, {
          source: 'local',
          action: 'upsert',
          state: 'sent',
          className: op.className
        });
        continue;
      }
      if (op.type === 'delete' && op.relativePath) {
        this.clearFileStatus(op.relativePath);
      }
    }

    this.recordActivity({
      source: 'system',
      action: 'pull',
      detail
    });
    this.refreshVisualState(true);
  }

  resolveSyncPath(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const resolved = path.resolve(this.syncRootPath, ...normalized.split('/'));
    const base = path.resolve(this.syncRootPath);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
      throw new Error(`Refusing to access path outside sync root: ${relativePath}`);
    }
    return resolved;
  }

  async applyStudioOps(ops) {
    if (!Array.isArray(ops)) {
      throw new Error('Expected ops array');
    }
    let changed = false;
    let appliedOps = 0;
    let caughtError = null;

    try {
      for (const op of ops) {
        if (!op || typeof op !== 'object') {
          continue;
        }
        if (op.type === 'upsert') {
          const applied = await this.applyStudioUpsert(op, { save: false });
          changed = applied || changed;
          appliedOps += applied ? 1 : 0;
          continue;
        }
        if (op.type === 'delete') {
          const applied = await this.applyStudioDelete(op, { save: false });
          changed = applied || changed;
          appliedOps += applied ? 1 : 0;
        }
      }
    } catch (error) {
      caughtError = error;
    }

    if (changed) {
      await this.saveState();
    }

    if (caughtError) {
      throw caughtError;
    }

    if (appliedOps > 0) {
      this.recordActivity({
        source: 'system',
        action: 'push',
        detail: `Studio pushed ${appliedOps} applied change(s)`
      });
    }
    this.refreshVisualState(true);
  }

  async applyStudioUpsert(op, { save = true } = {}) {
    if (!op.id || !op.relativePath || typeof op.content !== 'string') {
      throw new Error('Invalid upsert op');
    }

    const parsed = parseRelativeScriptPath(op.relativePath);
    const className = op.className || parsed.className;
    const normalized = canonicalizeRelativePath(op.relativePath, className);
    if (this.ignoreMatcher?.isIgnored(normalized)) {
      this.log(`Ignored Studio upsert due to .rksyncignore: ${normalized}`);
      return false;
    }

    const absPath = this.resolveSyncPath(normalized);
    const incomingHash = hashContent(op.content);
    const current = this.state.scripts[op.id];

    if (current && fssync.existsSync(absPath)) {
      const localContent = await fs.readFile(absPath, 'utf8');
      const localHash = hashContent(localContent);
      const hasUnsyncedLocalEdit = localHash !== current.hash;
      const isDifferentIncoming = incomingHash !== localHash;
      if (hasUnsyncedLocalEdit && isDifferentIncoming) {
        const conflictAbsPath = this.buildStudioConflictPath(normalized);
        await fs.mkdir(path.dirname(conflictAbsPath), { recursive: true });
        this.markMuted(conflictAbsPath, { hash: incomingHash });
        await fs.writeFile(conflictAbsPath, op.content, 'utf8');
        this.recordActivity({
          source: 'system',
          action: 'conflict',
          relativePath: normalized,
          detail: `Saved Studio version to ${path.relative(this.workspacePath, conflictAbsPath)}`
        });
        vscode.window.showWarningMessage(
          `RKsync conflict on ${normalized}. Studio changes were saved under .rksync/conflicts.`
        );
        this.log(`Conflict detected for ${normalized}; Studio version saved to ${conflictAbsPath}.`);
        return false;
      }
    }

    await fs.mkdir(path.dirname(absPath), { recursive: true });
    this.markMuted(absPath, { hash: incomingHash });
    await fs.writeFile(absPath, op.content, 'utf8');

    if (current && current.relativePath !== normalized) {
      const oldAbsPath = this.resolveSyncPath(current.relativePath);
      this.markMuted(oldAbsPath, { deleted: true });
      if (fssync.existsSync(oldAbsPath)) {
        await fs.rm(oldAbsPath, { force: true });
        await this.removeEmptyAncestorDirs(oldAbsPath);
      }
      this.pathToId.delete(current.relativePath);
      this.clearFileStatus(current.relativePath);
    }

    const entry = this.makeStateEntry(op.id, normalized, className, op.content);
    entry.instancePath = op.instancePath || relativePathToInstancePath(normalized);
    this.setScriptEntry(entry);
    if (save) {
      await this.saveState();
    }
    this.markFileStatus(normalized, {
      source: 'studio',
      action: 'upsert',
      state: 'synced',
      className
    });
    this.recordActivity({
      source: 'studio',
      action: 'upsert',
      relativePath: normalized,
      detail: 'Applied Studio change to disk'
    });
    this.log(`Applied Studio upsert: ${normalized}`);
    return true;
  }

  async applyStudioDelete(op, { save = true } = {}) {
    if (!op.id && !op.relativePath) {
      throw new Error('Invalid delete op');
    }

    let entry = null;
    if (op.id && this.state.scripts[op.id]) {
      entry = this.removeScriptEntry(op.id);
    } else if (op.relativePath) {
      const normalized = normalizeRelativePath(op.relativePath);
      const id = this.pathToId.get(normalized);
      if (id) {
        entry = this.removeScriptEntry(id);
      } else {
        const matchingId = Object.keys(this.state.scripts).find((candidateId) => {
          const candidate = this.state.scripts[candidateId];
          return canonicalizeRelativePath(candidate.relativePath, candidate.className) === normalized;
        });
        if (matchingId) {
          entry = this.removeScriptEntry(matchingId);
        }
      }
    }

    if (!entry) {
      return false;
    }

    const absPath = this.resolveSyncPath(entry.relativePath);
    this.markMuted(absPath, { deleted: true });
    await fs.rm(absPath, { force: true });
    await this.removeEmptyAncestorDirs(absPath);
    this.rememberTombstone(entry);
    if (save) {
      await this.saveState();
    }
    this.clearFileStatus(entry.relativePath);
    this.recordActivity({
      source: 'studio',
      action: 'delete',
      relativePath: entry.relativePath,
      detail: 'Applied Studio delete to disk'
    });
    this.log(`Applied Studio delete: ${entry.relativePath}`);
    return true;
  }

  assertProtocolCompatible(req) {
    const protocolVersion = getProtocolVersionFromHeaders(req.headers);
    if (isProtocolVersionCompatible(protocolVersion)) {
      return;
    }

    const error = new Error(describeProtocolMismatch(protocolVersion));
    error.statusCode = 409;
    throw error;
  }

  async startServer(port) {
    this.server = http.createServer(async (req, res) => {
      try {
        await this.routeRequest(req, res);
      } catch (error) {
        const message = error.stack || error.message;
        this.log(`Request failure: ${message}`);
        this.setLastError(error.message);
        this.writeJson(res, error.statusCode ?? 500, {
          ok: false,
          error: error.message,
          extensionVersion: EXTENSION_VERSION,
          protocolVersion: PROTOCOL_VERSION
        });
      }
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });

    this.serverRunning = true;
    this.serverPort = port;
    this.clearLastError();
    this.log(`HTTP server listening on http://127.0.0.1:${port}`);
  }

  async routeRequest(req, res) {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const method = req.method?.toUpperCase();
    this.assertProtocolCompatible(req);

    if (method === 'GET' && requestUrl.pathname === '/hello') {
      await this.ensureFreshLocalState({
        force: true,
        reason: 'Studio reconnect'
      });
      this.markStudioSeen('hello');
      this.writeJson(res, 200, {
        ok: true,
        extensionVersion: EXTENSION_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        workspaceName: this.workspaceFolder?.name ?? '',
        syncRoot: this.syncRootName,
        sequence: this.sequence,
        counts: {
          scripts: Object.keys(this.state.scripts).length,
          tombstones: Object.keys(this.state.tombstones).length
        }
      });
      return;
    }

    if (method === 'GET' && requestUrl.pathname === '/pull') {
      const sinceValue = requestUrl.searchParams.get('since') ?? '0';
      const since = Number.parseInt(sinceValue, 10);
      if (!Number.isFinite(since)) {
        this.writeJson(res, 400, { ok: false, error: 'Invalid since query value.' });
        return;
      }

      this.markStudioSeen('pull');

      if (since <= 0) {
        await this.ensureFreshLocalState({
          force: false,
          reason: 'full snapshot request'
        });
        const ops = this.buildFullSnapshotOps();
        this.log(`Studio requested a full snapshot. Serving ${ops.length} operation(s).`);
        this.noteOpsServedToStudio(ops, `Sent full snapshot (${ops.length} change(s))`);
        this.writeJson(res, 200, {
          ok: true,
          reset: false,
          extensionVersion: EXTENSION_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          sequence: this.sequence,
          counts: {
            scripts: Object.keys(this.state.scripts).length,
            tombstones: Object.keys(this.state.tombstones).length
          },
          ops
        });
        return;
      }

      if (since > this.sequence) {
        await this.ensureFreshLocalState({
          force: false,
          reason: 'sequence reset'
        });
        const ops = this.buildFullSnapshotOps();
        this.log(
          `Studio requested sequence ${since}, but server is at ${this.sequence}. Sending reset snapshot with ${ops.length} operation(s).`
        );
        this.noteOpsServedToStudio(ops, `Reset Studio snapshot (${ops.length} change(s))`);
        this.writeJson(res, 200, {
          ok: true,
          reset: true,
          extensionVersion: EXTENSION_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          sequence: this.sequence,
          counts: {
            scripts: Object.keys(this.state.scripts).length,
            tombstones: Object.keys(this.state.tombstones).length
          },
          ops
        });
        return;
      }

      const ops = this.pendingJournal.filter((entry) => entry.seq > since);
      this.noteOpsServedToStudio(ops, `Sent incremental sync (${ops.length} change(s))`);
      this.writeJson(res, 200, {
        ok: true,
        reset: false,
        extensionVersion: EXTENSION_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        sequence: this.sequence,
        counts: {
          scripts: Object.keys(this.state.scripts).length,
          tombstones: Object.keys(this.state.tombstones).length
        },
        ops
      });
      return;
    }

    if (method === 'POST' && requestUrl.pathname === '/push') {
      const body = await this.readJsonBody(req);
      this.markStudioSeen('push');
      await this.applyStudioOps(body.ops);
      this.writeJson(res, 200, {
        ok: true,
        extensionVersion: EXTENSION_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        sequence: this.sequence,
        counts: {
          scripts: Object.keys(this.state.scripts).length,
          tombstones: Object.keys(this.state.tombstones).length
        }
      });
      return;
    }

    this.writeJson(res, 404, {
      ok: false,
      error: 'Route not found.'
    });
  }

  async readJsonBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        throw new Error('Request body is too large.');
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) {
      return {};
    }
    return JSON.parse(raw);
  }

  writeJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(PROTOCOL_VERSION_HEADER, `${PROTOCOL_VERSION}`);
    res.end(JSON.stringify(payload));
  }
}

let controller = null;

async function activate(context) {
  controller = new RKsyncController(context);
  await controller.activate();
}

async function deactivate() {
  if (controller) {
    await controller.deactivate();
    controller = null;
  }
}

module.exports = {
  activate,
  deactivate
};
