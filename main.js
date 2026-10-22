require("dotenv").config();

const { app, BrowserWindow, globalShortcut, session, ipcMain, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");

// Services
const ocrService = require("./src/services/ocr.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");
const dshService = require("./src/services/dsh-headless.service");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.activeSkill = "normal";
    this.codingLanguage = "javascript";
    this.appIcon = "terminal";
    this.dshEnabled = !!config.get("dsh.enabled");
    this.workspacePath = "";
    this.dshHarnessDir = config.get("dsh.harnessDir") || "";
    this.settingsPath = path.join(config.get("app.dataDir"), "settings.json");
    this.isGenerating = false;

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "Vysper" },
      chat: { title: "Chat" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    this.loadPersistedSettings();
    this.setupStealth();
    this.setupEventHandlers();
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    app.setName("Terminal "); // Default to Terminal stealth mode
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  async onAppReady() {
    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      this.setupPermissions();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      await windowManager.initializeWindows();
      this.setupGlobalShortcuts();

      // Initialize default stealth mode with terminal icon
      this.updateAppIcon("terminal");

      this.isReady = true;

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");
    } catch (error) {
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  setupPermissions() {
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        const allowedPermissions = ["microphone", "camera", "display-capture"];
        const granted = allowedPermissions.includes(permission);

        logger.debug("Permission request", { permission, granted });
        callback(granted);
      }
    );
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+S": () => this.triggerScreenshotOCR(),
      "CommandOrControl+Shift+V": () => windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+C": () => windowManager.switchToWindow("chat"),
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "CommandOrControl+,": () => windowManager.showSettings(),
      "Alt+A": () => windowManager.toggleInteraction(),
      // ⌥R: open UI in interactive mode (not click-through), do not record
      "Alt+R": () => this.openAppInteractive(),
      // ⌥Z: start / stop voice input
      "Alt+Z": () => this.toggleSpeechRecognition(),
      "CommandOrControl+Shift+T": () => windowManager.forceAlwaysOnTopForAllWindows(),
      "CommandOrControl+Shift+Alt+T": () => {
        const results = windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
      // Context-sensitive shortcuts based on interaction mode
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      logger.debug("Global shortcut registered", { accelerator, success });
    });
  }

  setupServiceEventHandlers() {
    speechService.on("recording-started", () => {
      windowManager.handleRecordingStarted();
      this.registerEscapeHandler();
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-started");
      });
    });

    speechService.on("recording-stopped", () => {
      windowManager.handleRecordingStopped();
      // Keep Esc if AI is still generating; otherwise release it
      if (this.isGenerating) {
        this.registerEscapeHandler();
      } else {
        this.unregisterEscapeHandler();
      }
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-stopped");
      });
    });

    speechService.on("transcription", (text) => {      
      // Add transcription to session memory
      sessionManager.addUserInput(text, 'speech');
      
      const windows = BrowserWindow.getAllWindows();
      
      windows.forEach((window) => {
        window.webContents.send("transcription-received", { text });
      });
      
      // Automatically process transcription with LLM for intelligent response
      setTimeout(async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processTranscriptionWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process transcription with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      }, 500);
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status });
      });
    });

    speechService.on("error", (error) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error });
      });
    });
  }

  setupIPCHandlers() {
    ipcMain.handle("take-screenshot", () => this.triggerScreenshotOCR());

    ipcMain.handle("start-speech-recognition", () => {
      speechService.startRecording();
      return speechService.getStatus();
    });

    ipcMain.handle("stop-speech-recognition", () => {
      speechService.stopRecording();
      return speechService.getStatus();
    });

    // Also handle direct send events for fallback
    ipcMain.on("start-speech-recognition", () => {
      speechService.startRecording();
    });

    ipcMain.on("stop-speech-recognition", () => {
      speechService.stopRecording();
    });

    ipcMain.on("chat-window-ready", () => {
      // Send a test message to confirm communication
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "Test message from main process - chat window communication is working!",
        });
      }, 1000);
    });

    ipcMain.on("test-chat-window", () => {
      windowManager.broadcastToAllWindows("transcription-received", {
        text: "🧪 IMMEDIATE TEST: Chat window IPC communication test successful!",
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        mainWindow.setSize(width, height);
        logger.debug("Main window resized", { width, height });
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + deltaX;
        const newY = currentY + deltaY;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX,
          deltaY,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    ipcMain.handle("clear-session-memory", () => {
      return this.newSession({ source: "ipc-clear" });
    });

    ipcMain.handle("new-session", () => {
      return this.newSession({ source: "ipc-new" });
    });

    ipcMain.handle("cancel-generation", () => {
      return this.cancelGeneration("ipc");
    });

    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    ipcMain.handle("test-always-on-top", () => {
      const results = windowManager.testAlwaysOnTopForAllWindows();
      return { success: true, results };
    });

    ipcMain.handle("send-chat-message", async (event, text) => {
      // Add chat message to session memory
      sessionManager.addUserInput(text, 'chat');
      logger.debug('Chat message added to session memory', { textLength: text.length });
      
      // Process typed message with LLM in the same way as transcribed text
      setTimeout(async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processTranscriptionWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      }, 500);
      
      return { success: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    ipcMain.handle("set-gemini-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      return llmService.getStats();
    });

    ipcMain.handle("get-gemini-status", () => {
      return llmService.getStats();
    });

    // Window binding IPC handlers
    ipcMain.handle("set-window-binding", (event, enabled) => {
      return windowManager.setWindowBinding(enabled);
    });

    ipcMain.handle("toggle-window-binding", () => {
      return windowManager.toggleWindowBinding();
    });

    ipcMain.handle("get-window-binding-status", () => {
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    ipcMain.handle("set-window-gap", (event, gap) => {
      return windowManager.setWindowGap(gap);
    });

    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("test-gemini-connection", async () => {
      return await llmService.testConnection();
    });

    ipcMain.handle("run-gemini-diagnostics", async () => {
      try {
        const connectivity = await llmService.checkNetworkConnectivity();
        const apiTest = await llmService.testConnection();
        
        return {
          success: true,
          connectivity,
          apiTest,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    });

    // Settings handlers
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", () => {
      return this.getSettings();
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("pick-workspace-directory", async () => {
      const settingsWindow = windowManager.getWindow("settings");
      // macOS panel + alwaysOnTop windows swallow native dialogs unless we
      // briefly drop always-on-top and pass the parent BrowserWindow.
      const wasOnTop = !!(settingsWindow && !settingsWindow.isDestroyed());
      try {
        if (wasOnTop) {
          settingsWindow.setAlwaysOnTop(false);
        }
        const opts = {
          title: "选择工作区目录（dsh 将基于此回答）",
          properties: ["openDirectory", "createDirectory"],
          defaultPath: this.workspacePath || undefined,
        };
        const result = settingsWindow && !settingsWindow.isDestroyed()
          ? await dialog.showOpenDialog(settingsWindow, opts)
          : await dialog.showOpenDialog(opts);
        if (result.canceled || !result.filePaths?.[0]) {
          return { canceled: true };
        }
        return { path: result.filePaths[0] };
      } finally {
        if (wasOnTop && settingsWindow && !settingsWindow.isDestroyed()) {
          if (process.platform === "darwin" && typeof settingsWindow.setAlwaysOnTop === "function") {
            settingsWindow.setAlwaysOnTop(true, "floating");
          } else {
            settingsWindow.setAlwaysOnTop(true);
          }
          settingsWindow.focus();
        }
      }
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-changed", { skill });
      return { success: true };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      const window = windowManager.windows.forEach((win, type) => {
        if (win.webContents === webContents) {
          win.hide();
          return true;
        }
      });
      return { success: true };
    });

    // LLM window specific handlers
    ipcMain.handle("expand-llm-window", (event, contentMetrics) => {
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("resize-llm-window-for-content", (event, contentMetrics) => {
      // Use the same expansion logic for now, can be enhanced later
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested via IPC");
      try {
        // Force quit the application
        const { app } = require("electron");

        // Close all windows first
        windowManager.destroyAllWindows();

        // Unregister shortcuts
        globalShortcut.unregisterAll();

        // Force quit
        app.quit();

        // If the above doesn't work, force exit
        setTimeout(() => {
          process.exit(0);
        }, 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    // Handle close settings
    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Handle save settings (synchronous)
    ipcMain.on("save-settings", (event, settings) => {
      this.saveSettings(settings);
    });

    // Handle update skill
    ipcMain.on("update-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-updated", { skill });
    });

    // Handle quit app (alternative method)
    ipcMain.on("quit-app", () => {
      logger.info("Quit app requested via IPC (on method)");
      try {
        const { app } = require("electron");
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        logger.error("Error during quit (on method):", error);
        process.exit(1);
      }
    });
  }

  /**
   * ⌥R — show app windows and disable click-through (interactive).
   * Does not start recording.
   */
  openAppInteractive() {
    try {
      if (!windowManager.isVisible) {
        windowManager.showAllWindows();
      } else {
        // Ensure main/chat are visible on current desktop
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow && !mainWindow.isDestroyed()) {
          windowManager.showOnCurrentDesktop(mainWindow, { force: false });
        }
        windowManager.showChatWindow();
      }
      windowManager.setInteractive(true);
      logger.info("App opened in interactive mode via ⌥R");
    } catch (error) {
      logger.error("Failed to open app interactively", { error: error.message });
    }
  }

  /**
   * ⌥Z — toggle voice input. Esc also stops while recording.
   */
  toggleSpeechRecognition() {
    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      this.stopVoiceInput("shortcut-alt-z");
    } else {
      this.startVoiceInput("shortcut-alt-z");
    }
  }

  startVoiceInput(source = "unknown") {
    try {
      if (!windowManager.isVisible) {
        windowManager.showAllWindows();
      }
      windowManager.showChatWindow();
      speechService.startRecording();
      this.registerEscapeHandler();
      logger.info("Voice input started", { source });
    } catch (error) {
      logger.error("Error starting voice input", { error: error.message, source });
      this.unregisterEscapeHandler();
    }
  }

  stopVoiceInput(source = "unknown") {
    try {
      const status = speechService.getStatus();
      if (status.isRecording) {
        speechService.stopRecording();
      }
      // Keep chat open so the answer can stream in
      if (!this.isGenerating) {
        this.unregisterEscapeHandler();
      }
      logger.info("Voice input stopped", { source });
    } catch (error) {
      logger.error("Error stopping voice input", { error: error.message, source });
      if (!this.isGenerating) {
        this.unregisterEscapeHandler();
      }
    }
  }

  /**
   * Esc: stop voice if recording, else cancel in-flight AI answer.
   */
  handleEscape() {
    const recording = speechService.getStatus()?.isRecording;
    if (recording) {
      this.stopVoiceInput("escape");
      return { action: "stop-voice" };
    }
    if (this.isGenerating) {
      return this.cancelGeneration("escape");
    }
    return { action: "none" };
  }

  registerEscapeHandler() {
    try {
      globalShortcut.unregister("Escape");
      const ok = globalShortcut.register("Escape", () => {
        this.handleEscape();
      });
      logger.debug("Escape handler registered", { success: ok });
    } catch (error) {
      logger.warn("Failed to register Escape handler", { error: error.message });
    }
  }

  unregisterEscapeHandler() {
    try {
      globalShortcut.unregister("Escape");
    } catch (_) { /* ignore */ }
  }

  beginGeneration() {
    this.isGenerating = true;
    this.registerEscapeHandler();
    windowManager.broadcastToAllWindows("generation-started");
  }

  endGeneration() {
    this.isGenerating = false;
    const recording = speechService.getStatus()?.isRecording;
    if (!recording) {
      this.unregisterEscapeHandler();
    }
    windowManager.broadcastToAllWindows("generation-ended");
  }

  cancelGeneration(source = "unknown") {
    if (!this.isGenerating) {
      return { success: false, reason: "not-generating" };
    }
    try {
      if (typeof llmService.cancel === "function") {
        llmService.cancel();
      }
      dshService.cancel();
      logger.info("AI generation cancel requested", { source });
      return { success: true, source };
    } catch (error) {
      logger.error("Failed to cancel generation", { error: error.message, source });
      return { success: false, error: error.message };
    }
  }

  clearSessionMemory() {
    this.newSession({ source: "shortcut" });
  }

  /**
   * Start a fresh conversation: clear Vysper memory + dsh session continuity.
   */
  newSession({ source = "unknown" } = {}) {
    try {
      if (this.isGenerating) {
        this.cancelGeneration(`new-session:${source}`);
      }
      dshService.cancel();
      dshService.clearSession();
      sessionManager.clear();
      this.endGeneration();

      const payload = {
        reason: "new-session",
        source,
        timestamp: new Date().toISOString(),
        workspacePath: this.workspacePath || null,
        dshEnabled: this.shouldUseDsh(),
      };

      windowManager.broadcastToAllWindows("session-cleared", payload);
      logger.info("New session started", payload);
      return { success: true, ...payload };
    } catch (error) {
      logger.error("Failed to start new session", { error: error.message, source });
      return { success: false, error: error.message };
    }
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const availableSkills = [
      "normal",
      "programming",
      "dsa",
      "system-design",
      "behavioral",
      "data-science",
      "sales",
      "presentation",
      "negotiation",
      "devops",
    ];

    const currentIndex = availableSkills.indexOf(this.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.activeSkill,
        availableSkills,
      });
      return;
    }

    // Calculate new index with wrapping
    let newIndex = currentIndex + direction;
    if (newIndex >= availableSkills.length) {
      newIndex = 0; // Wrap to beginning
    } else if (newIndex < 0) {
      newIndex = availableSkills.length - 1; // Wrap to end
    }

    const newSkill = availableSkills[newIndex];
    this.activeSkill = newSkill;

    // Update session manager with the new skill
    sessionManager.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    // Broadcast the skill change to all windows
    windowManager.broadcastToAllWindows("skill-updated", { skill: newSkill });
  }

  async triggerScreenshotOCR() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();

    try {
      windowManager.showLLMLoading();

      const ocrResult = await ocrService.captureAndProcess();

      if (!ocrResult.text || ocrResult.text.trim().length === 0) {
        windowManager.hideLLMResponse();
        this.broadcastOCRError("No text found in screenshot");
        return;
      }

      // Add OCR extracted text to session memory
      sessionManager.addOCREvent(ocrResult.text, {
        processingTime: ocrResult.metadata?.processingTime,
        source: 'screenshot'
      });

      this.broadcastOCRSuccess(ocrResult);

      const sessionHistory = sessionManager.getOptimizedHistory();
      await this.processWithLLM(ocrResult.text, sessionHistory);
    } catch (error) {
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      windowManager.hideLLMResponse();
      this.broadcastOCRError(error.message);
      
      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  shouldUseDsh() {
    return !!(this.dshEnabled && this.workspacePath && fs.existsSync(this.workspacePath));
  }

  async processWithDsh(text, { isTranscriptionResponse = false } = {}) {
    const started = Date.now();
    const streamMeta = {
      skill: this.activeSkill,
      provider: "dsh-headless",
      workspacePath: this.workspacePath,
      isTranscriptionResponse,
    };

    this.beginGeneration();
    try {
      if (!isTranscriptionResponse) {
        windowManager.showLLMLoading();
      }
      windowManager.beginLLMResponseStream(streamMeta);
      windowManager.updateLLMResponseStream(
        `正在用 dsh 分析工作区…\n${this.workspacePath}`,
        streamMeta
      );

      let lastFlush = 0;
      let latestAnswer = "";
      const llmResult = await dshService.ask(text, {
        workspacePath: this.workspacePath,
        harnessDir: this.dshHarnessDir || undefined,
        timeoutMs: config.get("dsh.timeoutMs"),
        onStatus: (msg) => {
          if (latestAnswer) return; // don't overwrite streamed answer
          const now = Date.now();
          if (now - lastFlush < 120) return;
          lastFlush = now;
          windowManager.updateLLMResponseStream(
            `⏳ ${msg}\n${this.workspacePath}`,
            streamMeta
          );
        },
        onProgress: (fullText) => {
          latestAnswer = fullText;
          const now = Date.now();
          if (now - lastFlush < 40) return;
          lastFlush = now;
          windowManager.updateLLMResponseStream(fullText, streamMeta);
        },
      });

      llmResult.metadata = {
        ...llmResult.metadata,
        processingTime: Date.now() - started,
        skill: this.activeSkill,
        isTranscriptionResponse,
      };

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        provider: "dsh-headless",
        workspacePath: this.workspacePath,
        isTranscriptionResponse,
      });

      windowManager.endLLMResponseStream(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: false,
        provider: "dsh-headless",
        cancelled: !!llmResult.metadata.cancelled,
        isTranscriptionResponse,
      });

      return llmResult;
    } finally {
      this.endGeneration();
    }
  }

  async processWithLLM(text, sessionHistory) {
    try {
      // Add user input to session memory
      sessionManager.addUserInput(text, 'llm_input');

      if (this.shouldUseDsh()) {
        await this.processWithDsh(text, { isTranscriptionResponse: false });
        return;
      }

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['programming', 'dsa', 'devops', 'system-design', 'data-science'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      const streamMeta = { skill: this.activeSkill };
      windowManager.showLLMLoading();
      windowManager.beginLLMResponseStream(streamMeta);
      this.beginGeneration();

      let lastFlush = 0;
      let llmResult;
      try {
        llmResult = await llmService.processTextWithSkill(
        text,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        {
          onDelta: (_delta, fullText) => {
            const now = Date.now();
            if (now - lastFlush < 40) return;
            lastFlush = now;
            windowManager.updateLLMResponseStream(fullText, streamMeta);
          }
        }
      );
      } finally {
        this.endGeneration();
      }

      logger.info("LLM processing completed, showing response", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
        responsePreview: llmResult.response.substring(0, 200) + "...",
      });

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      windowManager.endLLMResponseStream(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      // Avoid duplicate chat messages when stream already delivered the answer
      if (!llmResult.metadata?.streamed) {
        this.broadcastLLMSuccess(llmResult);
      }
    } catch (error) {
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      windowManager.hideLLMResponse();
      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      logger.info("Processing transcription with intelligent LLM response", {
        skill: this.activeSkill,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "...",
        useDsh: this.shouldUseDsh(),
        workspacePath: this.workspacePath || null
      });

      if (this.shouldUseDsh()) {
        const llmResult = await this.processWithDsh(cleanText, {
          isTranscriptionResponse: true
        });
        logger.info("Transcription dsh response completed", {
          responseLength: llmResult.response.length,
          processingTime: llmResult.metadata.processingTime,
          workspacePath: this.workspacePath
        });
        return;
      }

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['programming', 'dsa', 'devops', 'system-design', 'data-science'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      const streamMeta = {
        skill: this.activeSkill,
        isTranscriptionResponse: true
      };
      windowManager.beginLLMResponseStream(streamMeta);
      this.beginGeneration();

      let lastFlush = 0;
      let llmResult;
      try {
        llmResult = await llmService.processTranscriptionWithIntelligentResponse(
          cleanText,
          this.activeSkill,
          sessionHistory.recent,
          needsProgrammingLanguage ? this.codingLanguage : null,
          {
            onDelta: (_delta, fullText) => {
              const now = Date.now();
              if (now - lastFlush < 40) return;
              lastFlush = now;
              windowManager.updateLLMResponseStream(fullText, streamMeta);
            }
          }
        );
      } finally {
        this.endGeneration();
      }

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      windowManager.endLLMResponseStream(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        cancelled: !!llmResult.metadata.cancelled,
        isTranscriptionResponse: true
      });

      // Avoid duplicate chat messages when stream already delivered the answer
      if (!llmResult.metadata?.streamed) {
        this.broadcastTranscriptionLLMResponse(llmResult);
      }

      logger.info("Transcription LLM response completed", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime
      });

    } catch (error) {
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      windowManager.updateLLMResponseStream(
        `❌ ${error.message}`,
        { skill: this.activeSkill, isTranscriptionResponse: true }
      );

      // Try to provide a fallback response
      try {
        if (typeof llmService.generateIntelligentFallbackResponse !== 'function') {
          throw error;
        }
        const fallbackResult = llmService.generateIntelligentFallbackResponse(text, this.activeSkill);
        
        sessionManager.addModelResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.broadcastTranscriptionLLMResponse(fallbackResult);
        
        logger.info("Used fallback response for transcription", {
          skill: this.activeSkill,
          fallbackResponse: fallbackResult.response
        });
        
      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady) {
      this.onAppReady();
    } else {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    windowManager.destroyAllWindows();

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getSettings() {
    return {
      codingLanguage: this.codingLanguage || "javascript",
      activeSkill: this.activeSkill || "normal",
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      dshEnabled: !!this.dshEnabled,
      workspacePath: this.workspacePath || "",
      dshHarnessDir: this.dshHarnessDir || "",
    };
  }

  saveSettings(settings) {
    try {
      // Update application settings
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        // Broadcast skill change to all windows
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: settings.activeSkill,
        });
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
      }

      // Handle icon change specifically
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        // Immediately update the app icon
        this.updateAppIcon(settings.selectedIcon);
      }

      if (Object.prototype.hasOwnProperty.call(settings, "dshEnabled")) {
        this.dshEnabled = !!settings.dshEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(settings, "workspacePath")) {
        const nextPath = settings.workspacePath || "";
        if (nextPath !== this.workspacePath) {
          dshService.clearSession();
        }
        this.workspacePath = nextPath;
      }
      if (Object.prototype.hasOwnProperty.call(settings, "dshHarnessDir")) {
        this.dshHarnessDir = settings.dshHarnessDir || "";
      }

      // Persist settings to file or config
      this.persistSettings(settings);

      logger.info("Settings saved successfully", {
        ...settings,
        dshEnabled: this.dshEnabled,
        workspacePath: this.workspacePath,
      });
      return { success: true };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  loadPersistedSettings() {
    try {
      if (!fs.existsSync(this.settingsPath)) return;
      const raw = fs.readFileSync(this.settingsPath, "utf8");
      const saved = JSON.parse(raw);
      if (saved.codingLanguage) this.codingLanguage = saved.codingLanguage;
      if (saved.activeSkill) this.activeSkill = saved.activeSkill;
      if (saved.appIcon || saved.selectedIcon) {
        this.appIcon = saved.selectedIcon || saved.appIcon;
      }
      if (Object.prototype.hasOwnProperty.call(saved, "dshEnabled")) {
        this.dshEnabled = !!saved.dshEnabled;
      }
      if (saved.workspacePath) this.workspacePath = saved.workspacePath;
      if (saved.dshHarnessDir) this.dshHarnessDir = saved.dshHarnessDir;
      logger.info("Loaded persisted settings", {
        activeSkill: this.activeSkill,
        dshEnabled: this.dshEnabled,
        workspacePath: this.workspacePath || null,
      });
    } catch (error) {
      logger.warn("Failed to load persisted settings", { error: error.message });
    }
  }

  persistSettings(settings) {
    try {
      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const merged = {
        ...this.getSettings(),
        ...settings,
        dshEnabled: this.dshEnabled,
        workspacePath: this.workspacePath,
        dshHarnessDir: this.dshHarnessDir,
      };
      fs.writeFileSync(this.settingsPath, JSON.stringify(merged, null, 2), "utf8");
      logger.debug("Settings persisted", { path: this.settingsPath });
    } catch (error) {
      logger.warn("Failed to persist settings", { error: error.message });
    }
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon
        app.dock.setIcon(fullIconPath);

        // Force dock refresh with multiple attempts
        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 100);

        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 500);
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Force update the bundle name for macOS stealth
        const { execSync } = require("child_process");
        try {
          // Update the app's Info.plist CFBundleName in memory
          if (process.mainModule && process.mainModule.filename) {
            const appPath = process.mainModule.filename;
            // Force set the bundle name directly
            process.env.CFBundleName = appName.trim();
          }
        } catch (e) {
          // Silently fail if we can't modify bundle info
        }

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(`assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping
      app.setAppUserModelId(`${appName.trim()}-${iconKey}`);

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

new ApplicationController();
