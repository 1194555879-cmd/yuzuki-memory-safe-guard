(() => {
    'use strict';

    const MODULE = 'YuzukiMemorySafeGuard';
    const VERSION = '0.1.1';
    const PATCHED = Symbol.for('yuzuki.memory.safe.guard.patched');
    const SETTINGS_KEYS = {
        plugin: 'yzm_memory_global_plugin_settings',
        autoSummary: 'yzm_memory_global_auto_summary_settings',
    };

    const state = {
        version: VERSION,
        timer: null,
        patchCount: 0,
        blockedCalls: 0,
        lastPatchAt: null,
    };

    function getContext() {
        try {
            return globalThis.SillyTavern?.getContext?.() ?? null;
        } catch {
            return null;
        }
    }

    function toast(type, message) {
        try {
            if (globalThis.toastr?.[type]) {
                globalThis.toastr[type](message, '柚月记忆安全护栏');
                return;
            }
        } catch {
            // Console fallback below.
        }
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
        } catch {
            // Ignore non-critical metadata failure.
        }
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
                if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
                    settings = {};
                }
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
                const replacement = markPatched(function safeLoadSettings() {
                    let value = {};
                    try {
                        value = original?.[PATCHED] ? {} : original?.() ?? {};
                    } catch {
                        value = {};
                    }
                    return { ...value, hideFloorsEnabled: false };
                });
                return replacement;
            },
            loadAutoSummarySettings: () => {
                const original = floorHider.loadAutoSummarySettings;
                const replacement = markPatched(function safeLoadAutoSummarySettings() {
                    let value = {};
                    try {
                        value = original?.[PATCHED] ? {} : original?.() ?? {};
                    } catch {
                        value = {};
                    }
                    return { ...value, hideSummaryFloors: false };
                });
                return replacement;
            },
            collectIndicesToHide: () => markPatched(function noContextIndices() {
                return [];
            }),
            collectSummaryIndicesToHide: () => markPatched(function noSummaryIndices() {
                return [];
            }),
            applyContextLimitHiding: () => markPatched(function blockContextHiding() {
                return blockedResult('context_floor_hiding_disabled');
            }),
            applySummaryPointerHiding: () => markPatched(function blockSummaryHiding() {
                return blockedResult('summary_floor_hiding_disabled');
            }),
            applyConfiguredHiding: () => markPatched(function blockAllHiding() {
                return blockedResult('all_floor_hiding_disabled');
            }),
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
            console.info(`[${MODULE}] 已锁定柚月楼层隐藏功能。`, {
                patchCount: state.patchCount,
            });
        }

        return changed;
    }

    function inspectCurrentChat() {
        const chat = getContext()?.chat;
        if (!Array.isArray(chat)) return { taggedHidden: 0 };

        let taggedHidden = 0;
        for (const message of chat) {
            if (message?.is_system === true && message?.is_yzm_hidden_floor === true) {
                taggedHidden += 1;
            }
        }

        if (taggedHidden > 0) {
            console.error(`[${MODULE}] 检测到 ${taggedHidden} 条柚月隐藏消息。护栏不会自动改存档，请立即停用柚月并导出 JSONL。`);
        }

        return { taggedHidden };
    }

    function healthCheck() {
        forceSafeSettings();
        patchFloorHider();
        inspectCurrentChat();
    }

    function start() {
        if (state.timer) clearInterval(state.timer);
        healthCheck();
        state.timer = setInterval(healthCheck, 1000);
        toast('success', '安全护栏已启用：柚月楼层隐藏功能已被锁死。');
    }

    function stop() {
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
        toast('warning', '安全护栏已停止。');
    }

    globalThis[MODULE] = {
        state,
        healthCheck,
        patchFloorHider,
        inspectCurrentChat,
        start,
        stop,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
