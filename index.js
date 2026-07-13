(() => {
    'use strict';

    const MODULE = 'YuzukiMemorySafeGuard';
    const VERSION = '0.1.2';
    const PATCHED = Symbol.for('yuzuki.memory.safe.guard.patched');
    const STARTUP_RETRY_MS = 500;
    const STARTUP_RETRY_LIMIT = 40; // 最多等待柚月加载 20 秒
    const BACKGROUND_RECHECK_MS = 60000; // 仅每分钟兜底一次

    const SETTINGS_KEYS = {
        plugin: 'yzm_memory_global_plugin_settings',
        autoSummary: 'yzm_memory_global_auto_summary_settings',
    };

    const state = {
        version: VERSION,
        startupTimer: null,
        backgroundTimer: null,
        startupAttempts: 0,
        patchCount: 0,
        blockedCalls: 0,
        lastPatchAt: null,
        started: false,
    };

    function toast(type, message) {
        try {
            if (globalThis.toastr?.[type]) {
                globalThis.toastr[type](message, '柚月记忆安全护栏');
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

    function blockedResult(reason) {
        state.blockedCalls += 1;
        console.warn(`[${MODULE}] 已阻止柚月隐藏原聊天楼层。`, {
            reason,
            blockedCalls: state.blockedCalls,
        });
        return Promise.resolve({
            success: false,
            skipped: true,
            reason,
            safeGuard: true,
        });
    }

    function forceSafeSettings() {
        const YuzukiMemory = globalThis.YuzukiMemory;
        const safePairs = [
            [SETTINGS_KEYS.plugin, 'hideFloorsEnabled'],
            [SETTINGS_KEYS.autoSummary, 'hideSummaryFloors'],
        ];

        for (const [key, field] of safePairs) {
            try {
                let settings = YuzukiMemory?.GlobalSettings?.get?.(key, {}) ?? {};
                if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
                if (settings[field] !== false) {
                    settings[field] = false;
                    YuzukiMemory?.GlobalSettings?.set?.(key, settings);
                }
            } catch (error) {
                console.warn(`[${MODULE}] 无法写入柚月全局设置 ${key}.${field}`, error);
            }

            try {
                const raw = localStorage.getItem(key);
                const local = raw ? JSON.parse(raw) : {};
                if (local && typeof local === 'object' && !Array.isArray(local) && local[field] !== false) {
                    local[field] = false;
                    localStorage.setItem(key, JSON.stringify(local));
                }
            } catch (error) {
                console.warn(`[${MODULE}] 无法写入本地设置 ${key}.${field}`, error);
            }
        }
    }

    function patchFloorHider() {
        const floorHider = globalThis.YuzukiMemory?.FloorHider;
        if (!floorHider || typeof floorHider !== 'object') return false;

        const replacements = {
            loadSettings: () => {
                const original = floorHider.loadSettings;
                return markPatched(function safeLoadSettings() {
                    let value = {};
                    try {
                        value = original?.[PATCHED] ? {} : original?.() ?? {};
                    } catch {}
                    return { ...value, hideFloorsEnabled: false };
                });
            },
            loadAutoSummarySettings: () => {
                const original = floorHider.loadAutoSummarySettings;
                return markPatched(function safeLoadAutoSummarySettings() {
                    let value = {};
                    try {
                        value = original?.[PATCHED] ? {} : original?.() ?? {};
                    } catch {}
                    return { ...value, hideSummaryFloors: false };
                });
            },
            collectIndicesToHide: () => markPatched(() => []),
            collectSummaryIndicesToHide: () => markPatched(() => []),
            applyContextLimitHiding: () => markPatched(() => blockedResult('context_floor_hiding_disabled')),
            applySummaryPointerHiding: () => markPatched(() => blockedResult('summary_floor_hiding_disabled')),
            applyConfiguredHiding: () => markPatched(() => blockedResult('all_floor_hiding_disabled')),
        };

        let changed = false;
        for (const [name, factory] of Object.entries(replacements)) {
            const current = floorHider[name];
            if (typeof current === 'function' && current[PATCHED] === true) continue;
            try {
                floorHider[name] = factory();
                changed = true;
            } catch (error) {
                console.error(`[${MODULE}] 覆盖 FloorHider.${name} 失败`, error);
            }
        }

        if (changed) {
            state.patchCount += 1;
            state.lastPatchAt = new Date().toISOString();
            console.info(`[${MODULE}] 已锁定柚月楼层隐藏功能。`);
        }
        return true;
    }

    function healthCheck() {
        forceSafeSettings();
        return patchFloorHider();
    }

    function stopStartupRetry() {
        if (state.startupTimer) clearInterval(state.startupTimer);
        state.startupTimer = null;
    }

    function beginStartupRetry() {
        stopStartupRetry();
        state.startupAttempts = 0;

        const attempt = () => {
            state.startupAttempts += 1;
            const ready = healthCheck();
            if (ready || state.startupAttempts >= STARTUP_RETRY_LIMIT) {
                stopStartupRetry();
                if (ready) {
                    toast('success', '安全护栏已启用：柚月楼层隐藏功能已被锁死。');
                } else {
                    console.warn(`[${MODULE}] 暂未检测到柚月；稍后会在回到前台时重新检查。`);
                }
            }
        };

        attempt();
        if (!globalThis.YuzukiMemory?.FloorHider) {
            state.startupTimer = setInterval(attempt, STARTUP_RETRY_MS);
        }
    }

    function startBackgroundRecheck() {
        if (state.backgroundTimer) clearInterval(state.backgroundTimer);
        state.backgroundTimer = setInterval(() => {
            if (document.visibilityState === 'visible') healthCheck();
        }, BACKGROUND_RECHECK_MS);
    }

    function start() {
        if (state.started) return;
        state.started = true;
        beginStartupRetry();
        startBackgroundRecheck();

        globalThis.addEventListener('focus', healthCheck, { passive: true });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') healthCheck();
        }, { passive: true });
    }

    function stop() {
        stopStartupRetry();
        if (state.backgroundTimer) clearInterval(state.backgroundTimer);
        state.backgroundTimer = null;
        state.started = false;
        toast('warning', '安全护栏已停止。');
    }

    globalThis[MODULE] = {
        state,
        healthCheck,
        patchFloorHider,
        start,
        stop,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
