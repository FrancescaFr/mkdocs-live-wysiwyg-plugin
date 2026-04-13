import { preprocessYaml } from './config-generator';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  ensureEnvironment,
  upgradeEnvironment,
  uninstallEnvironment,
  addPlugins,
} from './environment';
import {
  startServer,
  stopServer,
  stopAllServers,
  disposeAllServers,
  isRunningForDir,
  getAllServers,
  ServerInfo,
} from './server-manager';
import { buildSite } from './build-manager';
import { initDocs } from './init-manager';
import { generateAutoDocs, restoreEditedDocs, detectAssets } from './auto-docs';
import { createStatusBar } from './status-bar';
import { SidebarProvider } from './sidebar-provider';
import { openPreviewPanel, closeAllPreviewPanels, watchServerState, setPreviewOutputChannel } from './preview-panel';

let outputChannel: vscode.OutputChannel;

function getWorkspaceDir(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Derive the working directory from a right-clicked resource URI.
 * For mkdocs.yml: use its parent directory.
 * For .md files: use its parent directory.
 * Falls back to the first workspace folder.
 */
function resolveWorkspaceDir(resourceUri?: vscode.Uri): string | undefined {
  if (resourceUri) {
    return path.dirname(resourceUri.fsPath);
  }
  return getWorkspaceDir();
}

async function withProgress<T>(
  title: string,
  task: (progress: vscode.Progress<{ message?: string }>) => Promise<T>
): Promise<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    task
  );
}

async function handleServe(resourceUri?: vscode.Uri): Promise<void> {
  let workspaceDir = resolveWorkspaceDir(resourceUri);
  if (!workspaceDir) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  if (isRunningForDir(workspaceDir)) {
    vscode.window.showWarningMessage(`Server already running for ${path.basename(workspaceDir)}`);
    return;
  }

const extensionPath = getExtensionPath();

async function handleServe(resourceUri?: vscode.Uri): Promise<void> {
  // 1. workspaceDir is defined right here
  let workspaceDir = resolveWorkspaceDir(resourceUri);

  if (!workspaceDir) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  if (isRunningForDir(workspaceDir)) {
    vscode.window.showWarningMessage(`Server already running for ${path.basename(workspaceDir)}`);
    return;
  }

  const extensionPath = getExtensionPath();

  // Fetch the user's preference from VS Code settings (if you implemented the Setting)
  const configVS = vscode.workspace.getConfiguration('mkdocs-wysiwyg');
  const preserveTheme = configVS.get<boolean>('useUserTheme', true);
  outputChannel.show(true);

  await withProgress('MkDocs WYSIWYG', async (progress) => {
    progress.report({ message: 'Setting up environment...' });
    await ensureEnvironment(extensionPath, outputChannel, progress);

    // --- NEW THEME REQUIREMENTS AUTO-INSTALL ---
    progress.report({ message: 'Checking for theme dependencies...' });
    // workspaceDir is now safely recognized!
    const mkdocsConfigPath = path.join(workspaceDir!, 'mkdocs.yml');

    if (fs.existsSync(mkdocsConfigPath)) {
      try {
        // Use our bulletproof preprocessor instead of getCleanYaml
        const rawContent = fs.readFileSync(mkdocsConfigPath, 'utf8');
        const content = preprocessYaml(rawContent);
        const config = yaml.load(content) as any;
        let targetReqPath = '';

        // 1. Check child custom_dir
        if (config?.theme?.custom_dir) {
          const localReq = path.join(workspaceDir!, config.theme.custom_dir, 'requirements.txt');
          if (fs.existsSync(localReq)) targetReqPath = localReq;
        }

        // 2. Trace INHERIT chain if no local requirements found
        if (!targetReqPath && config?.INHERIT) {
          outputChannel.appendLine(`[Auto-Install] Tracing inheritance: ${config.INHERIT}`);
          const inheritedYmlPath = path.resolve(workspaceDir!, config.INHERIT);

          if (fs.existsSync(inheritedYmlPath)) {
            const inheritedDir = path.dirname(inheritedYmlPath);
            const siblingReq = path.join(inheritedDir, 'requirements.txt');

            if (fs.existsSync(siblingReq)) {
              targetReqPath = siblingReq;
            } else {
              // Read and preprocess the inherited file too!
              const inheritedRaw = fs.readFileSync(inheritedYmlPath, 'utf8');
              const inheritedContent = preprocessYaml(inheritedRaw);
              const inheritedConfig = yaml.load(inheritedContent) as any;

              if (inheritedConfig?.theme?.custom_dir) {
                const inheritedCustomReq = path.join(inheritedDir, inheritedConfig.theme.custom_dir, 'requirements.txt');
                if (fs.existsSync(inheritedCustomReq)) targetReqPath = inheritedCustomReq;
              }
            }
          }
        }

        // 3. Final Execution: Install if found
        if (targetReqPath) {
          outputChannel.appendLine(`[Auto-Install] SUCCESS: Found requirements.txt at ${targetReqPath}`);
          progress.report({ message: 'Installing dependencies...' });
          await addPlugins(['-r', targetReqPath], outputChannel);
          outputChannel.appendLine(`[Auto-Install] Pip installation finished.`);
        } else {
          outputChannel.appendLine(`[Auto-Install] SKIPPED: No requirements.txt found in hierarchy.`);
        }
      } catch (err) {
        outputChannel.appendLine(`[Auto-Install] ERROR: Parsing failed: ${err}`);
      }
    }
    // --- END THEME REQUIREMENTS AUTO-INSTALL ---
  });

  let autoGenerated = false;
  let tmpDocResult: { tmpDir: string; docsDir: string } | undefined;

  if (resourceUri && resourceUri.fsPath.endsWith('.md')) {
    const mdDir = path.dirname(resourceUri.fsPath);
    const assets = detectAssets(resourceUri.fsPath);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdocs-wysiwyg-autodocs-'));
    const result = generateAutoDocs(mdDir, tmpDir, assets);
    if (result.autoGeneratedMkdocsYml) {
      workspaceDir = tmpDir;
      autoGenerated = true;
      tmpDocResult = { tmpDir, docsDir: result.docsDir };
    }
  }

  outputChannel.show(true);

  try {
    await startServer(workspaceDir, outputChannel, {
      useUserTheme: preserveTheme, // Or true, if using the hardcoded approach
      autoGenerated,
    });

    const servers = getAllServers();
    const thisServer = servers.find((s) => s.workspaceDir === workspaceDir);
    if (thisServer?.ports) {
      await openPreviewPanel(thisServer, extensionContext.extensionUri);
    }
  } catch (err) {
    if (tmpDocResult) {
      restoreEditedDocs(tmpDocResult.docsDir, false);
    }
    vscode.window.showErrorMessage(`Failed to start server: ${err}`);
  }
}

  let autoGenerated = false;
  let tmpDocResult: { tmpDir: string; docsDir: string } | undefined;

  if (resourceUri && resourceUri.fsPath.endsWith('.md')) {
    const mdDir = path.dirname(resourceUri.fsPath);
    const assets = detectAssets(resourceUri.fsPath);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdocs-wysiwyg-autodocs-'));
    const result = generateAutoDocs(mdDir, tmpDir, assets);
    if (result.autoGeneratedMkdocsYml) {
      workspaceDir = tmpDir;
      autoGenerated = true;
      tmpDocResult = { tmpDir, docsDir: result.docsDir };
    }
  }

  outputChannel.show(true);

  // Fetch the user's preference from VS Code settings
  const config = vscode.workspace.getConfiguration('mkdocs-wysiwyg');
  const preserveTheme = config.get<boolean>('useUserTheme', false);

  try {
    await startServer(workspaceDir, outputChannel, {
      useUserTheme: preserveTheme,
      autoGenerated,
    });

    const servers = getAllServers();
    const thisServer = servers.find((s) => s.workspaceDir === workspaceDir);
    if (thisServer?.ports) {
      await openPreviewPanel(thisServer, extensionContext.extensionUri);
    }
  } catch (err) {
    if (tmpDocResult) {
      restoreEditedDocs(tmpDocResult.docsDir, false);
    }
    vscode.window.showErrorMessage(`Failed to start server: ${err}`);
  }
}

async function handleStop(): Promise<void> {
  const servers = getAllServers().filter(
    (s) => s.state === 'running' || s.state === 'starting'
  );

  if (servers.length === 0) {
    vscode.window.showInformationMessage('No servers running.');
    return;
  }

  if (servers.length === 1) {
    stopServer(servers[0].workspaceDir, outputChannel);
    return;
  }

  const items = servers.map((s) => ({
    label: path.basename(s.workspaceDir),
    description: s.ports ? `:${s.ports.httpPort}` : '',
    dir: s.workspaceDir,
  }));
  items.push({ label: 'Stop All Servers', description: '', dir: '__all__' });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select server to stop',
  });

  if (!picked) { return; }
  if (picked.dir === '__all__') {
    stopAllServers(outputChannel);
  } else {
    stopServer(picked.dir, outputChannel);
  }
}

async function handleBuild(): Promise<void> {
  const workspaceDir = getWorkspaceDir();
  if (!workspaceDir) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  const extensionPath = getExtensionPath();

  outputChannel.show(true);

await withProgress('MkDocs WYSIWYG', async (progress) => {
    progress.report({ message: 'Setting up environment...' });
    await ensureEnvironment(extensionPath, outputChannel, progress);

    // --- DYNAMIC INHERITANCE & AUTO-INSTALL ---
    outputChannel.appendLine('[Auto-Install] Starting dependency check...');
    const mkdocsConfigPath = path.join(workspaceDir!, 'mkdocs.yml');

    if (fs.existsSync(mkdocsConfigPath)) {
      try {
        // Use the official preprocessor instead of the old getCleanYaml regex
        const rawContent = fs.readFileSync(mkdocsConfigPath, 'utf8');
        const content = preprocessYaml(rawContent);
        const config = yaml.load(content) as any;
        let targetReqPath = '';

        // 1. Check child custom_dir
        if (config?.theme?.custom_dir) {
          const localReq = path.join(workspaceDir!, config.theme.custom_dir, 'requirements.txt');
          if (fs.existsSync(localReq)) targetReqPath = localReq;
        }

        // 2. Trace INHERIT chain if no local requirements found
        if (!targetReqPath && config?.INHERIT) {
          outputChannel.appendLine(`[Auto-Install] Tracing inheritance: ${config.INHERIT}`);
          const inheritedYmlPath = path.resolve(workspaceDir!, config.INHERIT);

          if (fs.existsSync(inheritedYmlPath)) {
            const inheritedDir = path.dirname(inheritedYmlPath);
            const siblingReq = path.join(inheritedDir, 'requirements.txt');

            if (fs.existsSync(siblingReq)) {
              // Sibling of the base.yml
              targetReqPath = siblingReq;
            } else {
              // Read and preprocess the inherited file too!
              const inheritedRaw = fs.readFileSync(inheritedYmlPath, 'utf8');
              const inheritedContent = preprocessYaml(inheritedRaw);
              const inheritedConfig = yaml.load(inheritedContent) as any;

              if (inheritedConfig?.theme?.custom_dir) {
                const inheritedCustomReq = path.join(inheritedDir, inheritedConfig.theme.custom_dir, 'requirements.txt');
                if (fs.existsSync(inheritedCustomReq)) targetReqPath = inheritedCustomReq;
              }
            }
          }
        }

        // 3. Final Execution: Install if found
        if (targetReqPath) {
          outputChannel.appendLine(`[Auto-Install] SUCCESS: Found requirements.txt at ${targetReqPath}`);
          progress.report({ message: 'Installing dependencies...' });
          await addPlugins(['-r', targetReqPath], outputChannel);
          outputChannel.appendLine(`[Auto-Install] Pip installation finished.`);
        } else {
          outputChannel.appendLine(`[Auto-Install] SKIPPED: No requirements.txt found in hierarchy.`);
        }
      } catch (err) {
        outputChannel.appendLine(`[Auto-Install] ERROR: Parsing failed: ${err}`);
      }
    }
  });

  outputChannel.show(true);
  try {
    await buildSite(workspaceDir, outputChannel);
    vscode.window.showInformationMessage('MkDocs site built successfully.');
  } catch (err) {
    vscode.window.showErrorMessage(`Build failed: ${err}`);
  }
}

async function handleInit(resourceUri?: vscode.Uri): Promise<void> {
  let targetDir: string | undefined;

  if (resourceUri) {
    const stat = await vscode.workspace.fs.stat(resourceUri);
    if (stat.type & vscode.FileType.Directory) {
      targetDir = resourceUri.fsPath;
    } else {
      targetDir = path.dirname(resourceUri.fsPath);
    }
  } else {
    targetDir = getWorkspaceDir();
  }

  if (!targetDir) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }
  outputChannel.show(true);
  await initDocs(getExtensionPath(), targetDir, outputChannel);
}

async function handleAddPlugins(): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: 'Enter PyPI package names separated by spaces',
    placeHolder: 'mkdocs-material mkdocs-minify-plugin',
  });
  if (!input) { return; }

  const packages = input.trim().split(/\s+/);
  if (packages.length === 0) { return; }

  outputChannel.show(true);
  try {
    await addPlugins(packages, outputChannel);
    vscode.window.showInformationMessage('Plugins installed.');
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to install plugins: ${err}`);
  }
}

async function handleUpgrade(): Promise<void> {
  const extensionPath = getExtensionPath();

  await withProgress('MkDocs WYSIWYG: Upgrading', async (progress) => {
    await upgradeEnvironment(extensionPath, outputChannel, progress);
  });

  vscode.window.showInformationMessage('MkDocs WYSIWYG environment upgraded.');
}

async function handleUninstall(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'This will remove the entire ~/.techdocs environment. Continue?',
    'Yes',
    'No'
  );
  if (confirm !== 'Yes') { return; }

  if (getAllServers().length > 0) {
    stopAllServers(outputChannel);
  }

  uninstallEnvironment(outputChannel);
  vscode.window.showInformationMessage('MkDocs WYSIWYG environment removed.');
}

async function handleStatusBarAction(): Promise<void> {
  const servers = getAllServers().filter((s) => s.state === 'running');

  if (servers.length === 0) { return; }

  if (servers.length === 1) {
    await showServerQuickPick(servers[0]);
    return;
  }

  const items = servers.map((s) => ({
    label: path.basename(s.workspaceDir),
    description: s.ports ? `:${s.ports.httpPort}` : '',
    server: s,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select server',
  });

  if (picked) {
    await showServerQuickPick(picked.server);
  }
}

async function showServerQuickPick(server: ServerInfo): Promise<void> {
  if (!server.ports) { return; }

  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(open-preview) Open Preview', action: 'preview' },
      { label: '$(globe) Open in External Browser', action: 'external' },
      { label: '$(output) View Logs', action: 'logs' },
      { label: '$(debug-stop) Stop Server', action: 'stop' },
    ],
    { placeHolder: `${path.basename(server.workspaceDir)} on :${server.ports.httpPort}` }
  );

  switch (choice?.action) {
    case 'preview':
      await openPreviewPanel(server, extensionContext.extensionUri);
      break;
    case 'external': {
      const url = `http://${server.ports.host}:${server.ports.httpPort}`;
      vscode.env.openExternal(vscode.Uri.parse(url));
      break;
    }
    case 'logs':
      outputChannel.show(true);
      break;
    case 'stop':
      stopServer(server.workspaceDir, outputChannel);
      break;
  }
}

async function handleOpenPreview(): Promise<void> {
  const servers = getAllServers().filter((s) => s.state === 'running');
  if (servers.length === 0) { return; }

  if (servers.length === 1 && servers[0].ports) {
    await openPreviewPanel(servers[0], extensionContext.extensionUri);
  } else if (servers.length > 1) {
    await handleStatusBarAction();
  }
}

let extensionContext: vscode.ExtensionContext;

function getExtensionPath(): string {
  return extensionContext.extensionPath;
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('MkDocs WYSIWYG');
  setPreviewOutputChannel(outputChannel);

  context.subscriptions.push(outputChannel);
  context.subscriptions.push(createStatusBar());

  const sidebarProvider = new SidebarProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('mkdocs-wysiwyg.serverStatus', sidebarProvider)
  );
  context.subscriptions.push(sidebarProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('mkdocs-wysiwyg.serve', (uri?: vscode.Uri) => handleServe(uri)),
    vscode.commands.registerCommand('mkdocs-wysiwyg.stop', handleStop),
    vscode.commands.registerCommand('mkdocs-wysiwyg.build', handleBuild),
    vscode.commands.registerCommand('mkdocs-wysiwyg.init', (uri?: vscode.Uri) => handleInit(uri)),
    vscode.commands.registerCommand('mkdocs-wysiwyg.addPlugins', handleAddPlugins),
    vscode.commands.registerCommand('mkdocs-wysiwyg.upgrade', handleUpgrade),
    vscode.commands.registerCommand('mkdocs-wysiwyg.uninstall', handleUninstall),
    vscode.commands.registerCommand('mkdocs-wysiwyg.statusBarAction', handleStatusBarAction),
    vscode.commands.registerCommand('mkdocs-wysiwyg.openPreview', handleOpenPreview),
  );

  context.subscriptions.push(watchServerState());
}

export function deactivate(): void {
  closeAllPreviewPanels();
  if (outputChannel) {
    disposeAllServers(outputChannel);
  }
}
