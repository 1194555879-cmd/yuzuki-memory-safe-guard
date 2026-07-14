(() => {
    'use strict';

    const MODULE = 'YuzukiMemorySafeGuard';
    const VERSION = '0.5.1';
    const PATCHED = Symbol.for('yzm.safe.guard.patched.v051');
    const SENTINEL_FLAG = '__yzm_safe_boundary_sentinel__';

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
        backgroundTimer: null,
        button: null,
        knownDialogueKeys: new Set(),
        taskReplayGuard: false,
        taskSeenRunning: false,
        taskLastActivityAt: 0,
        bridgeReleaseDeadline: 0,
        bridgeMonitorTimer: null,
        perf: {
            enabled: true,
            level: 'smooth',
            candidate: 'smooth',
            candidateCount: 0,
            fps: 60,
            lagMs: 0,
            longTaskMs: 0,
            domNodes: 0,
            iframes: 0,
            liteMode: false,
            lastShownLevel: '',
            banner: null,
            hideTimer: null,
            rafFrames: 0,
            rafLastAt: performance.now(),
            intervalExpectedAt: performance.now() + 1000,
            recentLongTasks: [],
        },
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

    async function activateBridge({ silent = false, force = false, reason = 'manual' } = {}) {
        if (state.loading) return false;
        if (state.bridgeActive && !force) {
            touchBridgeLease();
            return true;
        }

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
            state.taskSeenRunning = false;
            rememberDialogue(result.messages);
            touchBridgeLease();

            if (!silent) {
                toast(
                    'success',
                    `临时全量桥已启用：真实 ${state.realFullCount} 条，任务结束后会自动释放。`,
                    7000,
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

    function deactivateBridge({ silent = true, reason = 'released' } = {}) {
        const hadBridge = state.bridgeActive;
        state.bridgeActive = false;
        state.fullMessages = [];
        state.realFullCount = 0;
        state.sandboxCount = 0;
        state.loadedCount = 0;
        state.windowStartIndex = 0;
        state.currentChatKey = '';
        state.lastError = '';
        state.taskSeenRunning = false;
        state.bridgeReleaseDeadline = 0;
        updateButton();
        if (hadBridge && !silent) toast('info', `临时全量桥已释放（${reason}）。`, 3500);
    }

    function touchBridgeLease(ms = 120000) {
        state.taskLastActivityAt = Date.now();
        state.bridgeReleaseDeadline = Date.now() + ms;
    }

    function visibleButtonTexts() {
        return Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
            .filter((el) => {
                const rect = el.getBoundingClientRect?.();
                return rect && rect.width > 0 && rect.height > 0;
            })
            .map((el) => String(el.textContent || el.value || '').replace(/\s+/g, ''));
    }

    function isYuzukiTaskRunning() {
        return visibleButtonTexts().some((text) =>
            /(停止任务|取消任务|正在执行|处理中|执行中|正在总结|正在追溯)/.test(text)
        );
    }

    function startBridgeMonitor() {
        if (state.bridgeMonitorTimer) return;
        state.bridgeMonitorTimer = setInterval(() => {
            if (!state.bridgeActive) return;
            if (isYuzukiTaskRunning()) {
                state.taskSeenRunning = true;
                touchBridgeLease(120000);
                return;
            }
            const now = Date.now();
            if (state.taskSeenRunning && now - state.taskLastActivityAt > 5000) {
                deactivateBridge({ silent: true, reason: 'task-finished' });
                return;
            }
            if (state.bridgeReleaseDeadline && now > state.bridgeReleaseDeadline) {
                deactivateBridge({ silent: true, reason: 'lease-timeout' });
            }
        }, 1800);
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
        if (document.__yzmSafeAutoBridgeInstalledV051) return;
        document.__yzmSafeAutoBridgeInstalledV051 = true;

        document.addEventListener('click', async (event) => {
            const element = isYuzukiAction(event.target);
            if (!element) return;
            if (state.taskReplayGuard) {
                touchBridgeLease();
                return;
            }
            if (state.bridgeActive) {
                touchBridgeLease();
                return;
            }

            event.preventDefault();
            event.stopImmediatePropagation();
            showPerformanceBanner('task', '🧠 正在准备完整历史', '准备好后会自动继续刚才的操作。', 0);

            const ok = await activateBridge({ silent: true, force: true, reason: 'yuzuki-action' });
            if (!ok) {
                hidePerformanceBanner();
                const message = '完整历史桥未就绪，本次总结/追溯已取消，避免漏掉前文。';
                toast('error', message, 12000);
                try { globalThis.alert?.(message); } catch {}
                return;
            }

            showPerformanceBanner('task', '🧠 完整历史已就绪', '正在继续执行柚月任务，请暂时不要连续点击。', 3500);
            state.taskReplayGuard = true;
            try {
                await new Promise((resolve) => setTimeout(resolve, 140));
                element.click();
                touchBridgeLease();
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
        button.addEventListener('click', () => activateBridge({
            silent: false,
            force: true,
            reason: 'manual-retry',
        }));

        document.body.appendChild(button);
        state.button = button;
        updateButton();
    }

    function ensurePerformanceBanner() {
        if (state.perf.banner?.isConnected) return;
        const banner = document.createElement('div');
        banner.id = 'yzm-performance-banner';
        banner.dataset.visible = 'false';
        banner.innerHTML = '<span class="yzm-perf-title"></span><span class="yzm-perf-detail"></span>';
        banner.addEventListener('click', () => {
            const p = state.perf;
            banner.querySelector('.yzm-perf-title').textContent = '📊 当前性能状态';
            banner.querySelector('.yzm-perf-detail').textContent =
                `FPS≈${Math.round(p.fps)}｜延迟≈${Math.round(p.lagMs)}ms｜DOM ${p.domNodes}｜iframe ${p.iframes}`;
        });
        document.body.appendChild(banner);
        state.perf.banner = banner;
    }

    function showPerformanceBanner(level, title, detail, duration = 4500) {
        ensurePerformanceBanner();
        const banner = state.perf.banner;
        if (!banner) return;
        if (state.perf.hideTimer) clearTimeout(state.perf.hideTimer);
        banner.querySelector('.yzm-perf-title').textContent = title;
        banner.querySelector('.yzm-perf-detail').textContent = detail || '';
        banner.dataset.level = level;
        banner.dataset.visible = 'true';
        if (duration > 0) {
            state.perf.hideTimer = setTimeout(() => { banner.dataset.visible = 'false'; }, duration);
        }
    }

    function hidePerformanceBanner() {
        if (state.perf.hideTimer) clearTimeout(state.perf.hideTimer);
        if (state.perf.banner) state.perf.banner.dataset.visible = 'false';
    }

    function setLiteMode(enabled, reason = '') {
        const p = state.perf;
        if (p.liteMode === enabled) return;
        p.liteMode = enabled;
        document.body.classList.toggle('yzm-performance-lite', enabled);
        if (enabled) {
            showPerformanceBanner(
                'severe',
                '🐢 卡顿较明显，已启用轻量模式',
                reason || '已暂时关闭高开销动画、模糊和阴影；聊天数据不会被修改。',
                0,
            );
        } else {
            showPerformanceBanner(
                'recovered',
                '✅ 页面已恢复，可以继续操作',
                '轻量模式已自动关闭，原来的视觉效果已经恢复。',
                4200,
            );
        }
    }

    function classifyPerformance() {
        const p = state.perf;
        if (p.lagMs > 700 || p.fps < 18 || p.longTaskMs > 900) return 'severe';
        if (p.lagMs > 250 || p.fps < 35 || p.longTaskMs > 300 || p.domNodes > 12000) return 'slow';
        return 'smooth';
    }

    function commitPerformanceLevel(level) {
        const p = state.perf;
        if (p.level === level) return;
        const previous = p.level;
        p.level = level;
        if (level === 'slow') {
            showPerformanceBanner(
                'slow',
                '⚠️ 当前有点卡，正在观察',
                `FPS≈${Math.round(p.fps)}，操作延迟≈${Math.round(p.lagMs)}ms。先别连续点按钮。`,
                4800,
            );
        } else if (level === 'severe') {
            setLiteMode(true, `FPS≈${Math.round(p.fps)}，操作延迟≈${Math.round(p.lagMs)}ms。`);
        } else if (level === 'smooth') {
            if (p.liteMode) setLiteMode(false);
            else if (previous !== 'smooth') {
                showPerformanceBanner('recovered', '✅ 页面已经顺畅了', '现在可以继续操作。', 3200);
            }
        }
        p.lastShownLevel = level;
    }

    function evaluatePerformance() {
        if (document.visibilityState !== 'visible' || !state.perf.enabled) return;
        const p = state.perf;
        const now = performance.now();
        p.recentLongTasks = p.recentLongTasks.filter((x) => now - x.at <= 10000);
        p.longTaskMs = p.recentLongTasks.reduce((sum, x) => sum + x.duration, 0);
        const candidate = classifyPerformance();
        if (candidate === p.candidate) p.candidateCount += 1;
        else {
            p.candidate = candidate;
            p.candidateCount = 1;
        }
        const threshold = candidate === 'severe' ? 2 : candidate === 'slow' ? 3 : 5;
        if (p.candidateCount >= threshold) commitPerformanceLevel(candidate);
    }

    function startPerformanceGuardian() {
        ensurePerformanceBanner();
        if ('PerformanceObserver' in globalThis) {
            try {
                const observer = new PerformanceObserver((list) => {
                    const at = performance.now();
                    for (const entry of list.getEntries()) {
                        state.perf.recentLongTasks.push({ at, duration: Number(entry.duration || 0) });
                    }
                });
                observer.observe({ entryTypes: ['longtask'] });
            } catch {}
        }

        const rafLoop = (now) => {
            const p = state.perf;
            p.rafFrames += 1;
            const elapsed = now - p.rafLastAt;
            if (elapsed >= 2000) {
                p.fps = Math.max(0, Math.min(60, (p.rafFrames * 1000) / elapsed));
                p.rafFrames = 0;
                p.rafLastAt = now;
            }
            requestAnimationFrame(rafLoop);
        };
        requestAnimationFrame(rafLoop);

        setInterval(() => {
            const p = state.perf;
            const now = performance.now();
            p.lagMs = Math.max(0, now - p.intervalExpectedAt);
            p.intervalExpectedAt = now + 1000;
        }, 1000);

        setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            state.perf.domNodes = document.getElementsByTagName('*').length;
            state.perf.iframes = document.getElementsByTagName('iframe').length;
            evaluatePerformance();
        }, 2500);
    }

    function installEventHooks() {
        const context = rawContext();
        const eventSource = context?.eventSource;
        const eventTypes = context?.event_types || globalThis.event_types || {};
        if (!eventSource?.on) return;

        const eventNames = [
            'CHAT_CHANGED',
            'MESSAGE_SENT',
            'MESSAGE_RECEIVED',
            'MESSAGE_EDITED',
            'MESSAGE_DELETED',
            'GENERATION_ENDED',
        ];

        for (const name of eventNames) {
            const eventName = eventTypes[name];
            if (!eventName) continue;
            const marker = `__yzmSafeGuardV050_${name}`;
            if (eventSource[marker]) continue;
            try {
                eventSource.on(eventName, () => {
                    sanitizeRealChat(`事件 ${name}`);
                    patchFloorHider();
                    patchSaveHooks();
                    if (name === 'CHAT_CHANGED') {
                        deactivateBridge({ silent: true, reason: 'chat-changed' });
                    } else if (!isYuzukiTaskRunning()) {
                        deactivateBridge({ silent: true, reason: 'normal-chat' });
                    }
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
        ensurePerformanceBanner();
        installActionAutoBridge();
        installEventHooks();
    }

    async function start() {
        if (state.started) return;
        state.started = true;

        patchGetContext();
        ensureButton();
        ensurePerformanceBanner();
        installActionAutoBridge();
        startBridgeMonitor();
        startPerformanceGuardian();

        const boot = setInterval(() => {
            healthCheck();
            if (globalThis.YuzukiMemory && rawContext()) {
                clearInterval(boot);
                toast(
                    'success',
                    `v${VERSION} 已启用：全量桥改为按需加载，性能守护正在后台观察。`,
                    8500,
                );
            }
        }, 500);

        setTimeout(() => clearInterval(boot), 30000);

        state.backgroundTimer = setInterval(() => {
            if (document.visibilityState === 'visible') healthCheck();
        }, 60000);

        globalThis.addEventListener('focus', () => healthCheck(), { passive: true });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') healthCheck();
        }, { passive: true });
    }

    globalThis[MODULE] = {
        state,
        activateBridge,
        deactivateBridge,
        sanitizeRealChat,
        healthCheck,
        performance: {
            get snapshot() {
                return {
                    level: state.perf.level,
                    fps: state.perf.fps,
                    lagMs: state.perf.lagMs,
                    longTaskMs: state.perf.longTaskMs,
                    domNodes: state.perf.domNodes,
                    iframes: state.perf.iframes,
                    liteMode: state.perf.liteMode,
                };
            },
            setLiteMode,
            show: () => showPerformanceBanner(
                'task',
                '📊 当前性能状态',
                `FPS≈${Math.round(state.perf.fps)}｜延迟≈${Math.round(state.perf.lagMs)}ms｜DOM ${state.perf.domNodes}`,
                6000,
            ),
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
