(() => {
    'use strict';

    const MODULE = 'YuzukiMemorySafeGuard';
    const VERSION = '0.3.0';
    const PATCHED = Symbol.for('yzm.safe.guard.patched.v030');
    const BRIDGE_TTL_MS = 30 * 60 * 1000;

    const state = {
        version: VERSION,
        started: false,
        originalGetContext: null,
        bridgeActive: false,
        bridgeExpiresAt: 0,
        fullMessages: [],
        fullCount: 0,
        loadedCount: 0,
        windowStartIndex: 0,
        mode: 'unknown',
        loading: false,
        lastError: '',
        knownDialogueKeys: new Set(),
        button: null,
        backgroundTimer: null,
    };

    function clone(value) {
        try {
            return globalThis.structuredClone(value);
        } catch {
            return JSON.parse(JSON.stringify(value));
        }
    }

    function toast(type, message, timeOut = 7000) {
        try {
            if (globalThis.toastr?.[type]) {
                globalThis.toastr[type](message, '柚月记忆安全护栏', {
                    timeOut,
                    preventDuplicates: true,
                });
                return;
            }
        } catch {}
        console.log(`[${MODULE}] ${message}`);
    }

    function rawContext() {
        try {
            if (typeof state.originalGetContext === 'function') {
                return state.originalGetContext.call(globalThis.SillyTavern);
            }
            return globalThis.SillyTavern?.getContext?.() ?? null;
        } catch {
            return null;
        }
    }

    function isDialogueMessage(message) {
        if (!message || typeof message !== 'object') return false;
        if (String(message.role || '').toLowerCase() === 'system') return false;
        if (
            message.isGaigaiPrompt
            || message.isGaigaiData
            || message.isGaigaiVector
            || message.isYuzukiVector
            || message.yzmMemoryInternal
        ) return false;
        if (message.is_user === true || message.is_user === false) return true;
        const role = String(message.role || '').toLowerCase();
        return role === 'user' || role === 'assistant';
    }

    function dialogueKey(message) {
        if (!isDialogueMessage(message)) return '';
        const role = message.is_user === true || String(message.role || '').toLowerCase() === 'user'
            ? 'user'
            : 'assistant';
        return [
            role,
            String(message.send_date ?? message.sendDate ?? message.created_at ?? ''),
            String(message.name ?? ''),
            String(message.mes ?? message.content ?? ''),
        ].join('\u241f');
    }

    function rememberDialogue(messages) {
        if (!Array.isArray(messages)) return;
        for (const message of messages) {
            if (isDialogueMessage(message) && message.is_system !== true) {
                const key = dialogueKey(message);
                if (key) state.knownDialogueKeys.add(key);
            }
        }
    }

    function sanitizeRealChat(reason = '检查') {
        const context = rawContext();
        const chat = context?.chat;
        if (!Array.isArray(chat)) return 0;

        let restored = 0;
        for (const message of chat) {
            if (!isDialogueMessage(message) || message.is_system !== true) {
                if (isDialogueMessage(message)) rememberDialogue([message]);
                continue;
            }

            const key = dialogueKey(message);
            const shouldRestore = message.is_yzm_hidden_floor === true
                || (key && state.knownDialogueKeys.has(key));

            if (!shouldRestore) continue;

            message.is_system = false;
            try { delete message.is_yzm_hidden_floor; } catch {}
            restored += 1;
            rememberDialogue([message]);
        }

        if (restored > 0) {
            toast('warning', `${reason}：已恢复 ${restored} 条被错误隐藏的原聊天。`, 9000);
            console.error(`[${MODULE}] ${reason}: restored ${restored} messages`);
        }
        return restored;
    }

    function bridgeExpired() {
        return state.bridgeActive && Date.now() >= state.bridgeExpiresAt;
    }

    function deactivateBridge(silent = false) {
        state.bridgeActive = false;
        state.bridgeExpiresAt = 0;
        state.fullMessages = [];
        state.fullCount = 0;
        state.lastError = '';
        updateButton();
        if (!silent) toast('info', '全量历史桥已关闭。重新打开时可再次加载。');
    }

    function makeBridgeContext(context) {
        const safeChat = state.fullMessages;
        return new Proxy(context, {
            get(target, prop, receiver) {
                if (prop === 'chat') return safeChat;
                if (prop === 'saveChat' || prop === 'saveChatConditional') {
                    const fn = Reflect.get(target, prop, receiver);
                    if (typeof fn !== 'function') return fn;
                    return async (...args) => {
                        sanitizeRealChat(`保存前 ${String(prop)}`);
                        return await fn.apply(target, args);
                    };
                }
                return Reflect.get(target, prop, receiver);
            },
            set(target, prop, value, receiver) {
                if (prop === 'chat') {
                    console.warn(`[${MODULE}] 已阻止扩展替换原聊天数组。`);
                    return true;
                }
                return Reflect.set(target, prop, value, receiver);
            },
        });
    }

    function patchGetContext() {
        const st = globalThis.SillyTavern;
        if (!st || typeof st.getContext !== 'function') return false;
        if (st.getContext[PATCHED]) return true;

        state.originalGetContext = st.getContext.bind(st);
        const wrapped = function guardedGetContext() {
            const context = state.originalGetContext();
            if (bridgeExpired()) deactivateBridge(true);
            if (!state.bridgeActive || !context) return context;
            return makeBridgeContext(context);
        };

        try {
            Object.defineProperty(wrapped, PATCHED, { value: true });
        } catch {}
        st.getContext = wrapped;
        return true;
    }

    function patchFloorHider() {
        const floorHider = globalThis.YuzukiMemory?.FloorHider;
        if (!floorHider || typeof floorHider !== 'object') return false;

        const block = (reason) => async () => {
            sanitizeRealChat(`拦截 ${reason}`);
            return { success: false, skipped: true, reason, safeGuard: true };
        };

        const replacements = {
            collectIndicesToHide: () => [],
            collectSummaryIndicesToHide: () => [],
            applyContextLimitHiding: block('context_floor_hiding_disabled'),
            applySummaryPointerHiding: block('summary_floor_hiding_disabled'),
            applyConfiguredHiding: block('all_floor_hiding_disabled'),
        };

        for (const [name, replacement] of Object.entries(replacements)) {
            try {
                if (floorHider[name]?.[PATCHED]) continue;
                Object.defineProperty(replacement, PATCHED, { value: true });
                floorHider[name] = replacement;
            } catch (error) {
                console.warn(`[${MODULE}] 无法覆盖 FloorHider.${name}`, error);
            }
        }
        return true;
    }

    function patchSaveHooks() {
        const targets = [
            [globalThis, 'saveChat'],
            [globalThis, 'saveChatConditional'],
        ];

        const context = rawContext();
        if (context) {
            targets.push([context, 'saveChat'], [context, 'saveChatConditional']);
        }

        for (const [owner, name] of targets) {
            if (!owner || typeof owner[name] !== 'function') continue;
            const current = owner[name];
            if (current[PATCHED]) continue;

            const wrapped = async function guardedSave(...args) {
                sanitizeRealChat(`保存前 ${name}`);
                return await current.apply(this, args);
            };
            try {
                Object.defineProperty(wrapped, PATCHED, { value: true });
                owner[name] = wrapped;
            } catch {}
        }
    }

    async function waitForTauriHost() {
        const host = globalThis.__TAURITAVERN__;
        if (!host) return null;
        try {
            await (host.ready ?? globalThis.__TAURITAVERN_MAIN_READY__);
        } catch {}
        return globalThis.__TAURITAVERN__?.api?.chat ?? null;
    }

    async function readFullTauriHistory() {
        const api = await waitForTauriHost();
        if (!api?.current?.handle || !api?.current?.windowInfo) {
            throw new Error('未检测到 TauriTavern 完整历史 API。');
        }

        const info = await api.current.windowInfo();
        const handle = api.current.handle();
        if (!handle?.history?.tail || !handle?.history?.before) {
            throw new Error('当前 TauriTavern 版本没有 history API。');
        }

        const totalCount = Number(info?.totalCount || 0);
        const limit = Math.min(200, Math.max(50, totalCount || 100));
        let page = await handle.history.tail({ limit });
        const pages = [page];

        while (page?.hasMoreBefore) {
            page = await handle.history.before(page, { limit });
            pages.unshift(page);
            if (pages.length > 1000) throw new Error('历史分页数量异常，已停止。');
        }

        const indexed = [];
        for (const item of pages) {
            const start = Number(item?.startIndex || 0);
            const messages = Array.isArray(item?.messages) ? item.messages : [];
            messages.forEach((message, offset) => {
                indexed.push({ index: start + offset, message });
            });
        }

        indexed.sort((a, b) => a.index - b.index);
        const seen = new Set();
        const full = [];
        for (const entry of indexed) {
            if (seen.has(entry.index)) continue;
            seen.add(entry.index);
            full.push(clone(entry.message));
        }

        if (totalCount > 0 && full.length !== totalCount) {
            throw new Error(`完整历史读取不一致：应有 ${totalCount} 条，实际取得 ${full.length} 条。`);
        }

        return {
            messages: full,
            totalCount: totalCount || full.length,
            loadedCount: Number(info?.windowLength || rawContext()?.chat?.length || 0),
            windowStartIndex: Number(info?.windowStartIndex || 0),
            mode: String(info?.mode || 'windowed'),
        };
    }

    async function readDesktopHistory() {
        const chat = rawContext()?.chat;
        if (!Array.isArray(chat)) throw new Error('当前没有打开聊天。');
        return {
            messages: clone(chat),
            totalCount: chat.length,
            loadedCount: chat.length,
            windowStartIndex: 0,
            mode: 'off',
        };
    }

    async function activateBridge() {
        if (state.loading) return;
        state.loading = true;
        state.lastError = '';
        updateButton();

        try {
            sanitizeRealChat('启用全量桥前');
            const result = globalThis.__TAURITAVERN__
                ? await readFullTauriHistory()
                : await readDesktopHistory();

            result.messages.forEach((message) => {
                if (isDialogueMessage(message)) {
                    message.is_system = false;
                    try { delete message.is_yzm_hidden_floor; } catch {}
                }
            });

            state.fullMessages = result.messages;
            state.fullCount = result.totalCount;
            state.loadedCount = result.loadedCount;
            state.windowStartIndex = result.windowStartIndex;
            state.mode = result.mode;
            state.bridgeActive = true;
            state.bridgeExpiresAt = Date.now() + BRIDGE_TTL_MS;
            rememberDialogue(result.messages);

            toast(
                'success',
                `全量历史桥已启用：柚月将读取 ${state.fullCount} 条；页面仍只渲染 ${state.loadedCount} 条。请关闭并重新打开柚月面板。`,
                12000,
            );
        } catch (error) {
            state.bridgeActive = false;
            state.lastError = String(error?.message || error || '加载失败');
            console.error(`[${MODULE}] 全量历史桥加载失败`, error);
            toast('error', `全量历史桥加载失败：${state.lastError}`, 12000);
        } finally {
            state.loading = false;
            updateButton();
        }
    }

    async function refreshWindowInfo() {
        try {
            if (globalThis.__TAURITAVERN__?.api?.chat?.current?.windowInfo) {
                const info = await globalThis.__TAURITAVERN__.api.chat.current.windowInfo();
                state.fullCount = Number(info?.totalCount || state.fullCount || 0);
                state.loadedCount = Number(info?.windowLength || rawContext()?.chat?.length || 0);
                state.windowStartIndex = Number(info?.windowStartIndex || 0);
                state.mode = String(info?.mode || 'windowed');
            } else {
                const count = rawContext()?.chat?.length || 0;
                state.fullCount = count;
                state.loadedCount = count;
                state.mode = 'off';
            }
        } catch {}
        updateButton();
    }

    function buttonText() {
        if (state.loading) return '🧠 正在读取完整历史…';
        if (state.lastError) return '⚠️ 全量桥失败，点此重试';
        if (state.bridgeActive) return `✅ 柚月全量 ${state.fullCount} 条`;
        if (state.fullCount > state.loadedCount && state.loadedCount > 0) {
            return `🧠 柚月全量 ${state.loadedCount}/${state.fullCount}`;
        }
        return '🧠 启用柚月全量历史';
    }

    function updateButton() {
        const button = state.button;
        if (!button) return;
        button.textContent = buttonText();
        button.dataset.state = state.loading
            ? 'loading'
            : state.lastError
                ? 'error'
                : state.bridgeActive
                    ? 'active'
                    : 'idle';
        button.title = state.bridgeActive
            ? '柚月现在读取完整历史；30 分钟后自动关闭，重启应用也会恢复普通窗口模式。'
            : '总结或追溯前先点这里。不会把全部消息渲染到页面。';
    }

    function ensureButton() {
        if (state.button?.isConnected) return;
        const button = document.createElement('button');
        button.id = 'yzm-safe-full-history-button';
        button.type = 'button';
        button.addEventListener('click', () => {
            if (state.bridgeActive) {
                deactivateBridge();
            } else {
                activateBridge();
            }
        });
        document.body.appendChild(button);
        state.button = button;
        updateButton();
    }

    function isYuzukiAction(target) {
        const element = target?.closest?.('button, [role="button"], input[type="button"], input[type="submit"]');
        if (!element) return false;
        const text = String(element.textContent || element.value || '').replace(/\s+/g, '');
        return /^(静默执行.*|弹窗确认.*|开始总结.*|执行总结.*|开始追溯.*|执行追溯.*|批量执行.*|重试本批.*|继续后续批次.*)$/.test(text);
    }

    function installActionGuard() {
        if (document.__yzmFullHistoryGuardInstalled) return;
        document.__yzmFullHistoryGuardInstalled = true;

        document.addEventListener('click', (event) => {
            if (!isYuzukiAction(event.target)) return;
            if (state.bridgeActive) return;

            const total = state.fullCount;
            const loaded = state.loadedCount || rawContext()?.chat?.length || 0;
            if (!(total > loaded)) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            const message = `当前手机只加载 ${loaded}/${total} 条。请先点左下角“柚月全量”按钮，加载成功后关闭并重新打开柚月面板，再执行总结/追溯。`;
            toast('error', message, 12000);
            try { globalThis.alert?.(message); } catch {}
        }, true);
    }

    function healthCheck() {
        patchGetContext();
        patchFloorHider();
        patchSaveHooks();
        sanitizeRealChat('健康检查');
        ensureButton();
        refreshWindowInfo();
    }

    function start() {
        if (state.started) return;
        state.started = true;
        patchGetContext();
        ensureButton();
        installActionGuard();

        const boot = setInterval(() => {
            healthCheck();
            if (globalThis.YuzukiMemory && rawContext()) clearInterval(boot);
        }, 500);
        setTimeout(() => clearInterval(boot), 30000);

        state.backgroundTimer = setInterval(() => {
            if (document.visibilityState === 'visible') healthCheck();
        }, 60000);

        globalThis.addEventListener('focus', healthCheck, { passive: true });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') healthCheck();
        }, { passive: true });

        toast('success', `v${VERSION} 已启用：全量历史桥与隔离沙盒就绪。`, 8000);
    }

    globalThis[MODULE] = {
        state,
        activateBridge,
        deactivateBridge,
        refreshWindowInfo,
        sanitizeRealChat,
        healthCheck,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
