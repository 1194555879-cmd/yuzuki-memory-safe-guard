(() => {
    'use strict';

    const MODULE = 'YuzukiMemorySafeGuard';
    const VERSION = '0.2.0';
    const PATCHED = Symbol.for('yzm.safe.guard.patched');
    const GUARDED = Symbol.for('yzm.safe.guard.message');
    const STARTUP_INTERVAL = 400;
    const STARTUP_LIMIT = 75;       // 最多等待柚月 / 酒馆 30 秒
    const BACKGROUND_INTERVAL = 60000;

    const SETTINGS_KEYS = {
        plugin: 'yzm_memory_global_plugin_settings',
        autoSummary: 'yzm_memory_global_auto_summary_settings',
    };

    const state = {
        version: VERSION,
        started: false,
        startupTimer: null,
        backgroundTimer: null,
        startupAttempts: 0,
        floorHiderPatched: false,
        saveHooksPatched: 0,
        messageGuardsInstalled: 0,
        blockedAssignments: 0,
        restoredBeforeSave: 0,
        blockedIncompleteTasks: 0,
        lastHealthAt: null,
    };

    const knownSafeDialogueKeys = new Set();

    function getContext() {
        try {
            return globalThis.SillyTavern?.getContext?.() ?? null;
        } catch {
            return null;
        }
    }

    function toast(type, message, options = {}) {
        try {
            if (globalThis.toastr?.[type]) {
                globalThis.toastr[type](message, '柚月记忆安全护栏', {
                    timeOut: options.timeOut ?? 6000,
                    preventDuplicates: true,
                });
                return;
            }
        } catch {}
        console.log(`[${MODULE}] ${message}`);
    }

    function markPatched(fn) {
        try {
            Object.defineProperty(fn, PATCHED, {
                value: true,
                configurable: false,
                enumerable: false,
                writable: false,
            });
        } catch {}
        return fn;
    }

    function isPluginOrSystemMessage(message) {
        if (!message || typeof message !== 'object') return true;
        const role = String(message.role || '').toLowerCase();
        if (role === 'system') return true;
        return Boolean(
            message.isGaigaiPrompt
            || message.isGaigaiData
            || message.isGaigaiVector
            || message.isYuzukiVector
            || message.yzmMemoryInternal
            || message.isPhoneMessage
        );
    }

    function isDialogueMessage(message) {
        if (!message || typeof message !== 'object') return false;
        if (isPluginOrSystemMessage(message)) return false;
        if (message.is_user === true || message.is_user === false) return true;
        const role = String(message.role || '').toLowerCase();
        return role === 'user' || role === 'assistant';
    }

    function messageKey(message) {
        if (!isDialogueMessage(message)) return '';
        const who = message.is_user === true || String(message.role || '').toLowerCase() === 'user'
            ? 'u'
            : 'a';
        const date = String(message.send_date ?? message.sendDate ?? message.created_at ?? '');
        const name = String(message.name ?? '');
        const text = String(message.mes ?? message.content ?? '');
        return `${who}\u241f${date}\u241f${name}\u241f${text}`;
    }

    function rememberSafeDialogue(message) {
        if (!isDialogueMessage(message)) return;
        if (message.is_system !== true) {
            const key = messageKey(message);
            if (key) knownSafeDialogueKeys.add(key);
        }
    }

    function shouldRestoreHidden(message) {
        if (!isDialogueMessage(message) || message.is_system !== true) return false;
        if (message.is_yzm_hidden_floor === true) return true;
        const key = messageKey(message);
        return Boolean(key && knownSafeDialogueKeys.has(key));
    }

    function updateDomVisibility(index, visible) {
        try {
            const selector = `#chat .mes[mesid="${index}"], #chat .mes[data-mesid="${index}"]`;
            document.querySelectorAll(selector).forEach((node) => {
                if (visible) {
                    node.setAttribute('is_system', 'false');
                    node.removeAttribute('is_yzm_hidden_floor');
                }
            });
        } catch {}
    }

    function sanitizeChat(reason = 'manual') {
        const chat = getContext()?.chat;
        if (!Array.isArray(chat)) return 0;

        let restored = 0;
        chat.forEach((message, index) => {
            if (!message || typeof message !== 'object') return;

            if (shouldRestoreHidden(message)) {
                try {
                    message.is_system = false;
                } catch {}
                try {
                    delete message.is_yzm_hidden_floor;
                } catch {}
                updateDomVisibility(index, true);
                restored += 1;
            }

            rememberSafeDialogue(message);
            installMessageGuard(message);
        });

        if (restored > 0) {
            state.restoredBeforeSave += restored;
            console.error(`[${MODULE}] ${reason}：恢复 ${restored} 条被错误隐藏的普通对话。`);
            toast('warning', `已拦截并恢复 ${restored} 条被隐藏的原聊天。`, { timeOut: 8000 });
        }
        return restored;
    }

    function installMessageGuard(message) {
        if (!isDialogueMessage(message) || message[GUARDED]) return false;

        // 对于安装护栏时已经是 true 的旧坏档，不贸然自动判定；
        // 只有带柚月标签，或之前曾以正常状态见过的消息，才会被 sanitizeChat 恢复。
        let backingValue = message.is_system === true;
        const originalDescriptor = Object.getOwnPropertyDescriptor(message, 'is_system');
        if (originalDescriptor && originalDescriptor.configurable === false) {
            rememberSafeDialogue(message);
            return false;
        }

        try {
            Object.defineProperty(message, 'is_system', {
                configurable: true,
                enumerable: true,
                get() {
                    return backingValue;
                },
                set(nextValue) {
                    const wantsHidden = nextValue === true;
                    if (wantsHidden && isDialogueMessage(message)) {
                        state.blockedAssignments += 1;
                        backingValue = false;
                        try {
                            delete message.is_yzm_hidden_floor;
                        } catch {}
                        console.warn(`[${MODULE}] 已阻止普通对话被写成 is_system=true。`, {
                            blockedAssignments: state.blockedAssignments,
                        });
                        return;
                    }
                    backingValue = Boolean(nextValue);
                },
            });
            Object.defineProperty(message, GUARDED, {
                value: true,
                configurable: true,
                enumerable: false,
                writable: false,
            });
            state.messageGuardsInstalled += 1;
            rememberSafeDialogue(message);
            return true;
        } catch (error) {
            console.warn(`[${MODULE}] 无法为消息安装属性护栏。`, error);
            return false;
        }
    }

    function forceSafeSettings() {
        const pairs = [
            [SETTINGS_KEYS.plugin, 'hideFloorsEnabled'],
            [SETTINGS_KEYS.autoSummary, 'hideSummaryFloors'],
        ];
        const yzm = globalThis.YuzukiMemory;

        for (const [key, field] of pairs) {
            try {
                let settings = yzm?.GlobalSettings?.get?.(key, {}) ?? {};
                if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
                if (settings[field] !== false) {
                    settings[field] = false;
                    yzm?.GlobalSettings?.set?.(key, settings);
                }
            } catch (error) {
                console.warn(`[${MODULE}] 无法写入柚月安全设置 ${key}.${field}`, error);
            }

            try {
                const raw = localStorage.getItem(key);
                const local = raw ? JSON.parse(raw) : {};
                if (local && typeof local === 'object' && !Array.isArray(local) && local[field] !== false) {
                    local[field] = false;
                    localStorage.setItem(key, JSON.stringify(local));
                }
            } catch {}
        }
    }

    function blockedFloorResult(reason) {
        console.warn(`[${MODULE}] 已阻止柚月楼层隐藏调用。`, { reason });
        sanitizeChat(`拦截 ${reason}`);
        return Promise.resolve({
            success: false,
            skipped: true,
            reason,
            safeGuard: true,
        });
    }

    function patchFloorHider() {
        const floorHider = globalThis.YuzukiMemory?.FloorHider;
        if (!floorHider || typeof floorHider !== 'object') return false;

        const replacements = {
            loadSettings: () => {
                const original = floorHider.loadSettings;
                return markPatched(function safeLoadSettings(...args) {
                    let value = {};
                    try {
                        value = original?.[PATCHED] ? {} : original?.apply(this, args) ?? {};
                    } catch {}
                    return { ...value, hideFloorsEnabled: false };
                });
            },
            loadAutoSummarySettings: () => {
                const original = floorHider.loadAutoSummarySettings;
                return markPatched(function safeLoadAutoSummarySettings(...args) {
                    let value = {};
                    try {
                        value = original?.[PATCHED] ? {} : original?.apply(this, args) ?? {};
                    } catch {}
                    return { ...value, hideSummaryFloors: false };
                });
            },
            collectIndicesToHide: () => markPatched(() => []),
            collectSummaryIndicesToHide: () => markPatched(() => []),
            applyContextLimitHiding: () => markPatched(() => blockedFloorResult('context_floor_hiding_disabled')),
            applySummaryPointerHiding: () => markPatched(() => blockedFloorResult('summary_floor_hiding_disabled')),
            applyConfiguredHiding: () => markPatched(() => blockedFloorResult('all_floor_hiding_disabled')),
        };

        let changed = false;
        for (const [name, factory] of Object.entries(replacements)) {
            const current = floorHider[name];
            if (typeof current === 'function' && current[PATCHED]) continue;
            try {
                floorHider[name] = factory();
                changed = true;
            } catch (error) {
                console.error(`[${MODULE}] 覆盖 FloorHider.${name} 失败`, error);
            }
        }

        if (changed) console.info(`[${MODULE}] 已锁死 FloorHider。`);
        state.floorHiderPatched = true;
        return true;
    }

    function wrapSaveFunction(owner, name) {
        if (!owner || typeof owner[name] !== 'function') return false;
        const current = owner[name];
        if (current[PATCHED]) return true;

        const wrapped = markPatched(async function guardedSave(...args) {
            sanitizeChat(`保存前 ${name}`);
            return await current.apply(this, args);
        });

        try {
            owner[name] = wrapped;
            state.saveHooksPatched += 1;
            return true;
        } catch (error) {
            console.warn(`[${MODULE}] 无法包装保存函数 ${name}`, error);
            return false;
        }
    }

    function patchSaveHooks() {
        wrapSaveFunction(globalThis, 'saveChatConditional');
        wrapSaveFunction(globalThis, 'saveChat');

        const context = getContext();
        if (context) {
            wrapSaveFunction(context, 'saveChat');
            wrapSaveFunction(context, 'saveChatConditional');
        }
    }

    function looksLikeTauri() {
        return Boolean(
            globalThis.__TAURI_INTERNALS__
            || globalThis.__TAURI__
            || /TauriTavern/i.test(document.documentElement?.innerText || '')
        );
    }

    function hasVisibleShowMore() {
        const nodes = [...document.querySelectorAll('button, a, .menu_button, .mes_load_more, [role="button"]')];
        return nodes.some((node) => {
            const text = String(node.textContent || '').trim().toLowerCase();
            if (!/show\s+more\s+messages|显示更多消息|加载更多消息/.test(text)) return false;
            const style = globalThis.getComputedStyle?.(node);
            return !style || (style.display !== 'none' && style.visibility !== 'hidden');
        });
    }

    function metadataExpectedTotal(context) {
        const candidates = [
            context?.chatMetadata?.message_count,
            context?.chatMetadata?.messages_count,
            context?.chatMetadata?.total_messages,
            context?.chatMetadata?.total_count,
            context?.chatMetadata?.chat_length,
            context?.chatMetadata?.floor_count,
        ];
        return candidates
            .map(Number)
            .filter((value) => Number.isFinite(value) && value >= 0)
            .sort((a, b) => b - a)[0] || 0;
    }

    function incompleteHistoryReason() {
        const context = getContext();
        const loaded = Array.isArray(context?.chat) ? context.chat.length : 0;
        const expected = metadataExpectedTotal(context);

        if (hasVisibleShowMore()) {
            return '聊天顶部仍有“Show more messages / 加载更多消息”，历史尚未完整加载。';
        }
        if (expected > loaded) {
            return `完整聊天预计 ${expected} 条，但当前插件只读取到 ${loaded} 条。`;
        }
        return '';
    }

    function isYuzukiTaskClick(target) {
        const element = target?.closest?.('button, [role="button"], a, input[type="button"], input[type="submit"]');
        if (!element) return false;
        const text = String(element.textContent || element.value || '').replace(/\s+/g, '');
        if (!text) return false;
        const insideYuzuki = Boolean(
            element.closest?.('[class*="yzm"], [id*="yzm"], [class*="yuzuki"], [id*="yuzuki"]')
            || /柚月|Yuzuki/i.test(document.body?.innerText || '')
        );
        return insideYuzuki && /(总结|追溯|批量填表|手动总结|开始执行|执行任务)/.test(text);
    }

    function installTaskSafetyLock() {
        if (document[PATCHED]) return;
        document.addEventListener('click', (event) => {
            if (!isYuzukiTaskClick(event.target)) return;
            const reason = incompleteHistoryReason();
            if (!reason) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            state.blockedIncompleteTasks += 1;
            const detail = `${reason}\n为避免漏掉前文，安全护栏已阻止本次总结/追溯。请改到电脑全量聊天中执行。`;
            toast('error', detail, { timeOut: 12000 });
            try {
                globalThis.alert?.(detail);
            } catch {}
            console.error(`[${MODULE}] 已阻止不完整历史任务。`, { reason });
        }, true);

        try {
            Object.defineProperty(document, PATCHED, {
                value: true,
                configurable: false,
                enumerable: false,
                writable: false,
            });
        } catch {}
    }

    function installEventHooks() {
        const context = getContext();
        const eventSource = context?.eventSource;
        const eventTypes = context?.event_types || globalThis.event_types || {};
        if (!eventSource?.on) return;

        const names = [
            'CHAT_CHANGED',
            'MESSAGE_SENT',
            'MESSAGE_RECEIVED',
            'MESSAGE_EDITED',
            'MESSAGE_DELETED',
            'GENERATION_ENDED',
            'GENERATION_STOPPED',
        ];

        for (const name of names) {
            const eventName = eventTypes[name];
            if (!eventName) continue;
            const marker = `__yzmSafeGuard_${name}`;
            if (eventSource[marker]) continue;
            try {
                eventSource.on(eventName, () => {
                    sanitizeChat(`事件 ${name}`);
                    patchSaveHooks();
                    patchFloorHider();
                });
                eventSource[marker] = true;
            } catch {}
        }
    }

    function healthCheck() {
        state.lastHealthAt = new Date().toISOString();
        forceSafeSettings();
        patchFloorHider();
        patchSaveHooks();
        sanitizeChat('健康检查');
        installEventHooks();
        installTaskSafetyLock();
        return Boolean(globalThis.YuzukiMemory?.FloorHider && getContext());
    }

    function stopStartupTimer() {
        if (state.startupTimer) clearInterval(state.startupTimer);
        state.startupTimer = null;
    }

    function beginStartup() {
        stopStartupTimer();
        state.startupAttempts = 0;

        const attempt = () => {
            state.startupAttempts += 1;
            const ready = healthCheck();
            if (ready || state.startupAttempts >= STARTUP_LIMIT) {
                stopStartupTimer();
                if (ready) {
                    toast('success', `v${VERSION} 已启用：存档级硬锁生效。`);
                } else {
                    toast('warning', `v${VERSION} 已加载，但尚未检测到柚月或聊天上下文。`);
                }
            }
        };

        attempt();
        if (!globalThis.YuzukiMemory?.FloorHider || !getContext()) {
            state.startupTimer = setInterval(attempt, STARTUP_INTERVAL);
        }
    }

    function start() {
        if (state.started) return;
        state.started = true;
        beginStartup();

        if (state.backgroundTimer) clearInterval(state.backgroundTimer);
        state.backgroundTimer = setInterval(() => {
            if (document.visibilityState === 'visible') healthCheck();
        }, BACKGROUND_INTERVAL);

        globalThis.addEventListener('focus', healthCheck, { passive: true });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') healthCheck();
        }, { passive: true });
    }

    function stop() {
        stopStartupTimer();
        if (state.backgroundTimer) clearInterval(state.backgroundTimer);
        state.backgroundTimer = null;
        state.started = false;
        toast('warning', '安全护栏已停止。');
    }

    globalThis[MODULE] = {
        state,
        healthCheck,
        sanitizeChat,
        patchFloorHider,
        patchSaveHooks,
        incompleteHistoryReason,
        start,
        stop,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
