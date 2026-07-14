(() => {
    'use strict';

    const MODULE = 'YuzukiMemorySafeGuard';
    const VERSION = '0.4.0';
    const PATCHED = Symbol.for('yzm.safe.guard.patched.v040');
    const SENTINEL_FLAG = '__yzm_safe_boundary_sentinel__';
    const REFRESH_DEBOUNCE_MS = 650;

    const state = {
        version: VERSION,
        started: false,
        originalGetContext: null,
        bridgeActive: false,
        fullMessages: [],
        realFullCount: 0,
        sandboxCount: 0,
        loadedCount: 0,
        windowStartIndex: 0,
        mode: 'unknown',
        loading: false,
        lastError: '',
        currentChatKey: '',
        refreshTimer: null,
        backgroundTimer: null,
        button: null,
        knownDialogueKeys: new Set(),
        taskReplayGuard: false,
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
        if (message[SENTINEL_FLAG]) return false;
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
        const chat = rawContext()?.chat;
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

            try { message.is_system = false; } catch {}
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

    function makeBoundarySentinel(realCount) {
        return {
            role: 'system',
            is_system: true,
            is_user: false,
            name: '柚月安全护栏',
            mes: '',
            content: '',
            send_date: Date.now(),
            yzmMemoryInternal: true,
            [SENTINEL_FLAG]: true,
            extra: {
                type: 'boundary_sentinel',
                realCount,
                note: '沙盒边界占位，不属于真实聊天，不参与总结。',
            },
        };
    }

    function stripSentinels(messages) {
        return Array.isArray(messages)
            ? messages.filter((message) => !message?.[SENTINEL_FLAG])
            : [];
    }

    function makeBridgeContext(context) {
        return new Proxy(context, {
            get(target, prop, receiver) {
                if (prop === 'chat') return state.fullMessages;

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
                    console.warn(`[${MODULE}] 已阻止扩展替换真实聊天数组。`);
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
            if (!state.bridgeActive || !context) return context;
            return makeBridgeContext(context);
        };

        try { Object.defineProperty(wrapped, PATCHED, { value: true }); } catch {}
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

    async function waitForTauriChatApi() {
        const host = globalThis.__TAURITAVERN__;
        if (!host) return null;
        try {
            await (host.ready ?? globalThis.__TAURITAVERN_MAIN_READY__);
        } catch {}
        return globalThis.__TAURITAVERN__?.api?.chat ?? null;
    }

    async function readFullTauriHistory() {
        const api = await waitForTauriChatApi();
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
            if (pages.length > 1000) {
                throw new Error('历史分页数量异常，已停止。');
            }
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

        const key = [
            String(info?.chatId ?? info?.id ?? ''),
            String(info?.fileName ?? info?.filename ?? ''),
            String(totalCount || full.length),
        ].join('|');

        return {
            messages: full,
            totalCount: totalCount || full.length,
            loadedCount: Number(info?.windowLength || rawContext()?.chat?.length || 0),
            windowStartIndex: Number(info?.windowStartIndex || 0),
            mode: String(info?.mode || 'windowed'),
            chatKey: key,
        };
    }

    async function readDesktopHistory() {
        const context = rawContext();
        const chat = context?.chat;
        if (!Array.isArray(chat)) throw new Error('当前没有打开聊天。');

        return {
            messages: clone(chat),
            totalCount: chat.length,
            loadedCount: chat.length,
            windowStartIndex: 0,
            mode: 'off',
            chatKey: String(context?.chatId ?? context?.chatName ?? context?.characterId ?? chat.length),
        };
    }

    function buildSandbox(realMessages) {
        const safe = stripSentinels(clone(realMessages));

        for (const message of safe) {
            if (isDialogueMessage(message)) {
                try { message.is_system = false; } catch {}
                try { delete message.is_yzm_hidden_floor; } catch {}
            }
        }

        const realCount = safe.length;
        safe.push(makeBoundarySentinel(realCount));
        return {
            sandbox: safe,
            realCount,
            sandboxCount: safe.length,
        };
    }

    async function activateBridge({ silent = false, force = false } = {}) {
        if (state.loading) return false;
        if (state.bridgeActive && !force) return true;

        state.loading = true;
        state.lastError = '';
        updateButton();

        try {
            sanitizeRealChat('启用全量桥前');

            const result = globalThis.__TAURITAVERN__
                ? await readFullTauriHistory()
                : await readDesktopHistory();

            const built = buildSandbox(result.messages);

            state.fullMessages = built.sandbox;
            state.realFullCount = built.realCount;
            state.sandboxCount = built.sandboxCount;
            state.loadedCount = result.loadedCount;
            state.windowStartIndex = result.windowStartIndex;
            state.mode = result.mode;
            state.currentChatKey = result.chatKey;
            state.bridgeActive = true;
            rememberDialogue(result.messages);

            if (!silent) {
                toast(
                    'success',
                    `全量历史桥已启用：真实 ${state.realFullCount} 条，已添加 1 条沙盒边界用于覆盖最后一楼。`,
                    10000,
                );
            }

            return true;
        } catch (error) {
            state.bridgeActive = false;
            state.lastError = String(error?.message || error || '加载失败');
            console.error(`[${MODULE}] 全量历史桥加载失败`, error);
            toast('error', `全量历史桥加载失败：${state.lastError}`, 12000);
            return false;
        } finally {
            state.loading = false;
            updateButton();
        }
    }

    function deactivateBridge({ silent = false } = {}) {
        state.bridgeActive = false;
        state.fullMessages = [];
        state.realFullCount = 0;
        state.sandboxCount = 0;
        state.loadedCount = 0;
        state.windowStartIndex = 0;
        state.currentChatKey = '';
        state.lastError = '';
        updateButton();
        if (!silent) toast('info', '全量历史桥已关闭。');
    }

    function scheduleBridgeRefresh(reason = '聊天变更') {
        if (state.refreshTimer) clearTimeout(state.refreshTimer);
        state.refreshTimer = setTimeout(async () => {
            console.info(`[${MODULE}] ${reason}，刷新全量历史桥。`);
            await activateBridge({ silent: true, force: true });
        }, REFRESH_DEBOUNCE_MS);
    }

    function isYuzukiAction(target) {
        const element = target?.closest?.('button, [role="button"], input[type="button"], input[type="submit"]');
        if (!element) return null;
        const text = String(element.textContent || element.value || '').replace(/\s+/g, '');
        if (!text) return null;

        const matches = /(静默执行|弹窗确认|开始总结|执行总结|开始追溯|执行追溯|批量执行|重试本批|继续后续批次|开始填表|执行任务)/.test(text);
        return matches ? element : null;
    }

    function installActionAutoBridge() {
        if (document.__yzmSafeAutoBridgeInstalled) return;
        document.__yzmSafeAutoBridgeInstalled = true;

        document.addEventListener('click', async (event) => {
            const element = isYuzukiAction(event.target);
            if (!element) return;
            if (state.taskReplayGuard) return;

            if (state.bridgeActive) return;

            event.preventDefault();
            event.stopImmediatePropagation();

            const ok = await activateBridge({ silent: false, force: true });
            if (!ok) {
                const message = '完整历史桥未就绪，本次总结/追溯已取消，避免漏掉前文。';
                toast('error', message, 12000);
                try { globalThis.alert?.(message); } catch {}
                return;
            }

            state.taskReplayGuard = true;
            try {
                // 让柚月在同一面板内重新读取桥接后的 context.chat。
                await new Promise((resolve) => setTimeout(resolve, 120));
                element.click();
            } finally {
                setTimeout(() => { state.taskReplayGuard = false; }, 0);
            }
        }, true);
    }

    function buttonText() {
        if (state.loading) return '🧠 读取中…';
        if (state.lastError) return '⚠️ 全量桥失败';
        if (state.bridgeActive) return `✅ ${state.realFullCount}+1`;
        if (state.realFullCount > 0 && state.loadedCount > 0) {
            return `🧠 ${state.loadedCount}/${state.realFullCount}`;
        }
        return '🧠 全量';
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
            ? `已自动启用：真实 ${state.realFullCount} 条＋1 条沙盒边界。按钮已自动隐藏。`
            : '自动启用失败时可点此重试。';
    }

    function ensureButton() {
        if (state.button?.isConnected) return;

        const button = document.createElement('button');
        button.id = 'yzm-safe-full-history-button';
        button.type = 'button';
        button.addEventListener('click', () => {
            if (state.bridgeActive) {
                activateBridge({ silent: false, force: true });
            } else {
                activateBridge({ silent: false, force: true });
            }
        });

        document.body.appendChild(button);
        state.button = button;
        updateButton();
    }

    function installEventHooks() {
        const context = rawContext();
        const eventSource = context?.eventSource;
        const eventTypes = context?.event_types || globalThis.event_types || {};
        if (!eventSource?.on) return;

        const refreshEvents = [
            'CHAT_CHANGED',
            'MESSAGE_SENT',
            'MESSAGE_RECEIVED',
            'MESSAGE_EDITED',
            'MESSAGE_DELETED',
            'GENERATION_ENDED',
        ];

        for (const name of refreshEvents) {
            const eventName = eventTypes[name];
            if (!eventName) continue;

            const marker = `__yzmSafeGuardV040_${name}`;
            if (eventSource[marker]) continue;

            try {
                eventSource.on(eventName, () => {
                    sanitizeRealChat(`事件 ${name}`);
                    patchFloorHider();
                    patchSaveHooks();

                    if (name === 'CHAT_CHANGED') {
                        deactivateBridge({ silent: true });
                    }
                    scheduleBridgeRefresh(name);
                });
                eventSource[marker] = true;
            } catch {}
        }
    }

    function healthCheck() {
        patchGetContext();
        patchFloorHider();
        patchSaveHooks();
        sanitizeRealChat('健康检查');
        ensureButton();
        installActionAutoBridge();
        installEventHooks();
    }

    async function start() {
        if (state.started) return;
        state.started = true;

        patchGetContext();
        ensureButton();
        installActionAutoBridge();

        const boot = setInterval(async () => {
            healthCheck();
            if (globalThis.YuzukiMemory && rawContext()) {
                clearInterval(boot);
                await activateBridge({ silent: true, force: true });
                toast(
                    'success',
                    `v${VERSION} 已启用：自动全量桥、最后一楼边界与隔离沙盒已就绪。`,
                    9000,
                );
            }
        }, 500);

        setTimeout(() => clearInterval(boot), 30000);

        state.backgroundTimer = setInterval(() => {
            if (document.visibilityState === 'visible') healthCheck();
        }, 60000);

        globalThis.addEventListener('focus', () => {
            healthCheck();
            scheduleBridgeRefresh('回到前台');
        }, { passive: true });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                healthCheck();
                scheduleBridgeRefresh('页面重新可见');
            }
        }, { passive: true });
    }

    globalThis[MODULE] = {
        state,
        activateBridge,
        deactivateBridge,
        sanitizeRealChat,
        healthCheck,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
