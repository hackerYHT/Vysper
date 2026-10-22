document.addEventListener('DOMContentLoaded', () => {    
    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const azureKeyInput = document.getElementById('azureKey');
    const azureRegionInput = document.getElementById('azureRegion');
    const geminiKeyInput = document.getElementById('geminiKey');
    const windowGapInput = document.getElementById('windowGap');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const dshEnabledInput = document.getElementById('dshEnabled');
    const workspacePathLabel = document.getElementById('workspacePathLabel');
    const pickWorkspaceBtn = document.getElementById('pickWorkspaceBtn');
    const clearWorkspaceBtn = document.getElementById('clearWorkspaceBtn');
    const dshHarnessDirInput = document.getElementById('dshHarnessDir');
    const newSessionBtn = document.getElementById('newSessionBtn');
    const iconGrid = document.getElementById('iconGrid');
    let workspacePath = '';

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                
                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }
                
                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);
                
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        if (settings.azureKey && azureKeyInput) azureKeyInput.value = settings.azureKey;
        if (settings.azureRegion && azureRegionInput) azureRegionInput.value = settings.azureRegion;
        if (settings.geminiKey && geminiKeyInput) geminiKeyInput.value = settings.geminiKey;
        if (settings.windowGap && windowGapInput) windowGapInput.value = settings.windowGap;
        if (settings.codingLanguage && codingLanguageSelect) codingLanguageSelect.value = settings.codingLanguage;
        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;
        if (dshEnabledInput) dshEnabledInput.checked = !!settings.dshEnabled;
        workspacePath = settings.workspacePath || '';
        if (workspacePathLabel) {
            workspacePathLabel.textContent = workspacePath || '未选择';
        }
        if (dshHarnessDirInput) dshHarnessDirInput.value = settings.dshHarnessDir || '';
        
        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            requestCurrentSettings();
        });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (azureKeyInput) settings.azureKey = azureKeyInput.value;
        if (azureRegionInput) settings.azureRegion = azureRegionInput.value;
        if (geminiKeyInput) settings.geminiKey = geminiKeyInput.value;
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;
        if (dshEnabledInput) settings.dshEnabled = dshEnabledInput.checked;
        settings.workspacePath = workspacePath || '';
        if (dshHarnessDirInput) settings.dshHarnessDir = dshHarnessDirInput.value.trim();
        
        if (window.electronAPI && window.electronAPI.saveSettings) {
            window.electronAPI.saveSettings(settings);
        } else {
            window.api.send('save-settings', settings);
        }
    };

    if (dshEnabledInput) {
        dshEnabledInput.addEventListener('change', saveSettings);
    }
    if (dshHarnessDirInput) {
        dshHarnessDirInput.addEventListener('change', saveSettings);
        dshHarnessDirInput.addEventListener('blur', saveSettings);
    }
    if (pickWorkspaceBtn) {
        pickWorkspaceBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!window.electronAPI || !window.electronAPI.pickWorkspaceDirectory) {
                console.error('pickWorkspaceDirectory API unavailable');
                if (workspacePathLabel) {
                    workspacePathLabel.textContent = '选择目录 API 不可用，请重启应用';
                }
                return;
            }
            try {
                pickWorkspaceBtn.disabled = true;
                pickWorkspaceBtn.textContent = '选择中…';
                const result = await window.electronAPI.pickWorkspaceDirectory();
                if (result && result.path) {
                    workspacePath = result.path;
                    if (workspacePathLabel) workspacePathLabel.textContent = workspacePath;
                    if (dshEnabledInput && !dshEnabledInput.checked) {
                        dshEnabledInput.checked = true;
                    }
                    saveSettings();
                }
            } catch (error) {
                console.error('Failed to pick workspace:', error);
                if (workspacePathLabel) {
                    workspacePathLabel.textContent = `选择失败: ${error.message || error}`;
                }
            } finally {
                pickWorkspaceBtn.disabled = false;
                pickWorkspaceBtn.textContent = '选择目录';
            }
        });
    }
    if (clearWorkspaceBtn) {
        clearWorkspaceBtn.addEventListener('click', () => {
            workspacePath = '';
            if (workspacePathLabel) workspacePathLabel.textContent = '未选择';
            saveSettings();
        });
    }
    if (newSessionBtn) {
        newSessionBtn.addEventListener('click', async () => {
            try {
                newSessionBtn.disabled = true;
                newSessionBtn.textContent = '处理中…';
                const api = window.electronAPI;
                const result = api?.newSession
                    ? await api.newSession()
                    : await api?.clearSessionMemory?.();
                newSessionBtn.textContent = result?.success === false ? '失败' : '已新建';
                setTimeout(() => {
                    newSessionBtn.disabled = false;
                    newSessionBtn.textContent = '新建会话';
                }, 1200);
            } catch (error) {
                console.error('Failed to create new session:', error);
                newSessionBtn.disabled = false;
                newSessionBtn.textContent = '新建会话';
            }
        });
    }

    // Add event listeners for all inputs
    const inputs = [
        azureKeyInput,
        azureRegionInput,
        geminiKeyInput,
        windowGapInput
    ];

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            saveSettings();
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assests/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assests/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('div');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                
                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });
}); 