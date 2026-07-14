(() => {
  'use strict';

  const MODULE = 'YuzukiMemorySafeGuard';
  const VERSION = '0.6.0';
  const PATCHED = Symbol.for('yzm.safe.guard.patched.v060');
  const SENTINEL_FLAG = '__yzm_safe_boundary_sentinel__';

  const state = {
    version: VERSION,
    started: false,
    originalGetContext: null,
    bridgeActive: false,
    bridgeOwner: '',
    fullMessages: [],
    realFullCount: 0,
    loadedCount: 0,
    windowStartIndex: 0,
    currentChatKey: '',
    loading: false,
    lastError: '',
    button: null,
    banner: null,
    bannerTimer: null,
    panelVisible: false,
    panelLastSeenAt: 0,
    panelRoot: null,
    taskReplayGuard: false,
    taskSeenRunning: false,
    bridgeReleaseDeadline: 0,
    bridgeMonitorTimer: null,
    countRefreshTimer: null,
    panelObserver: null,
    panelScanQueued: false,
    refreshQueued: false,
    knownDialogueKeys: new Set(),
    autoGuardTimer: null,
    autoGuardUntil: 0,
    autoGuardReason: '',
  };

  function clone(value) {
    try {
      return globalThis.structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value));
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

  function ensureBanner() {
    if (state.banner?.isConnected) return state.banner;
    const banner = document.createElement('div');
    banner.id = 'yzm-performance-banner';
    banner.dataset.visible = 'false';
    banner.innerHTML = '<strong class="yzm-perf-title"></strong><span class="yzm-perf-detail"></span>';
    document.body.appendChild(banner);
    state.banner = banner;
    return banner;
  }

  function showBanner(level, title, detail = '', duration = 4200) {
    const banner = ensureBanner();
    if (state.bannerTimer) clearTimeout(state.bannerTimer);
    banner.querySelector('.yzm-perf-title').textContent = title;
    banner.querySelector('.yzm-perf-detail').textContent = detail;
    banner.dataset.level = level;
    banner.dataset.visible = 'true';
    if (duration > 0) {
      state.bannerTimer = setTimeout(() => {
        banner.dataset.visible = 'false';
      }, duration);
    }
  }

  function hideBanner() {
    if (state.bannerTimer) clearTimeout(state.bannerTimer);
    if (state.banner) state.banner.dataset.visible = 'false';
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
      message.isGaigaiPrompt ||
      message.isGaigaiData ||
      message.isGaigaiVector ||
      message.isYuzukiVector ||
      message.yzmMemoryInternal
    ) return false;
    if (message.is_user === true || message.is_user === false) return true;
    const role = String(message.role || '').toLowerCase();
    return role === 'user' || role === 'assistant';
  }

  function dialogueKey(message) {
    if (!isDialogueMessage(message)) return '';
    const role =
      message.is_user === true || String(message.role || '').toLowerCase() === 'user'
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
      if (!isDialogueMessage(message) || message.is_system === true) continue;
      const key = dialogueKey(message);
      if (key) state.knownDialogueKeys.add(key);
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
      const shouldRestore =
        message.is_yzm_hidden_floor === true ||
        (key && state.knownDialogueKeys.has(key));

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

  function buildSandbox(realMessages) {
    const safe = clone(realMessages).filter(message => !message?.[SENTINEL_FLAG]);

    for (const message of safe) {
      if (!isDialogueMessage(message)) continue;
      try { message.is_system = false; } catch {}
      try { delete message.is_yzm_hidden_floor; } catch {}
    }

    const realCount = safe.length;
    safe.push(makeBoundarySentinel(realCount));
    return { sandbox: safe, realCount };
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

    const block = reason => async () => {
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

  async function readWindowInfo() {
    const api = await waitForTauriChatApi();
    if (!api?.current?.windowInfo) return null;
    return await api.current.windowInfo();
  }

  function chatKeyFromInfo(info, fallbackCount = 0) {
    return [
      String(info?.chatId ?? info?.id ?? ''),
      String(info?.fileName ?? info?.filename ?? ''),
      String(info?.totalCount ?? fallbackCount ?? ''),
    ].join('|');
  }

  async function refreshRealCount({ patchPanel = true } = {}) {
    try {
      const info = await readWindowInfo();
      if (info) {
        const total = Number(info?.totalCount || 0);
        if (Number.isFinite(total) && total >= 0) {
          state.realFullCount = total;
          state.loadedCount = Number(info?.windowLength || rawContext()?.chat?.length || 0);
          state.windowStartIndex = Number(info?.windowStartIndex || 0);
          state.currentChatKey = chatKeyFromInfo(info, total);
        }
      } else {
        const chat = rawContext()?.chat;
        if (Array.isArray(chat)) {
          state.realFullCount = chat.length;
          state.loadedCount = chat.length;
          state.windowStartIndex = 0;
        }
      }

      updateButton();
      if (patchPanel) patchYuzukiPanelCount();
      return state.realFullCount;
    } catch (error) {
      console.warn(`[${MODULE}] 读取真实楼层数失败`, error);
      return state.realFullCount;
    }
  }

  async function readFullTauriHistoryOnce() {
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

    const afterInfo = await api.current.windowInfo();
    const afterTotal = Number(afterInfo?.totalCount || 0);
    const beforeKey = chatKeyFromInfo(info, totalCount);
    const afterKey = chatKeyFromInfo(afterInfo, afterTotal);

    if (beforeKey !== afterKey) {
      throw new Error('Cursor signature mismatch：读取期间聊天发生变化。');
    }

    if (totalCount > 0 && full.length !== totalCount) {
      throw new Error(`完整历史读取不一致：应有 ${totalCount} 条，实际取得 ${full.length} 条。`);
    }

    return {
      messages: full,
      totalCount: totalCount || full.length,
      loadedCount: Number(info?.windowLength || rawContext()?.chat?.length || 0),
      windowStartIndex: Number(info?.windowStartIndex || 0),
      chatKey: beforeKey,
    };
  }

  async function readFullTauriHistory() {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await readFullTauriHistoryOnce();
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || '');
        const retryable =
          /Cursor signature mismatch|signature|读取期间聊天发生变化|完整历史读取不一致/i.test(message);

        if (!retryable || attempt === 3) break;

        console.warn(`[${MODULE}] 完整历史读取冲突，第 ${attempt} 次重试`, error);
        await sleep(250 * attempt);
      }
    }

    throw lastError || new Error('完整历史读取失败。');
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
      chatKey: String(context?.chatId ?? context?.chatName ?? context?.characterId ?? chat.length),
    };
  }

  async function activateBridge({
    silent = false,
    force = false,
    reason = 'manual',
    owner = 'manual',
  } = {}) {
    if (state.loading) return false;

    if (state.bridgeActive && !force) {
      state.bridgeOwner = owner || state.bridgeOwner;
      touchBridgeLease();
      patchYuzukiPanelCount();
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
      state.loadedCount = result.loadedCount;
      state.windowStartIndex = result.windowStartIndex;
      state.currentChatKey = result.chatKey;
      state.bridgeActive = true;
      state.bridgeOwner = owner;
      state.taskSeenRunning = false;

      rememberDialogue(result.messages);
      touchBridgeLease(owner === 'panel' ? 10 * 60 * 1000 : 2 * 60 * 1000);
      patchYuzukiPanelCount();

      if (!silent) {
        toast(
          'success',
          `完整历史已就绪：共 ${state.realFullCount} 层。关闭柚月面板后会自动释放。`,
          6500,
        );
      }

      console.info(`[${MODULE}] bridge active`, {
        reason,
        owner,
        total: state.realFullCount,
        loaded: state.loadedCount,
      });

      return true;
    } catch (error) {
      state.bridgeActive = false;
      state.bridgeOwner = '';
      state.fullMessages = [];
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
    state.bridgeOwner = '';
    state.fullMessages = [];
    state.loadedCount = 0;
    state.windowStartIndex = 0;
    state.lastError = '';
    state.taskSeenRunning = false;
    state.bridgeReleaseDeadline = 0;
    if (reason !== 'panel-closed' || state.bridgeOwner !== 'auto') {
      state.autoGuardUntil = 0;
    }

    updateButton();

    if (hadBridge && !silent) {
      toast('info', `完整历史已释放（${reason}）。`, 3200);
    }
  }

  function touchBridgeLease(ms = 120000) {
    state.bridgeReleaseDeadline = Date.now() + ms;
  }

  function elementVisible(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect?.();
    return !!rect && rect.width > 0 && rect.height > 0;
  }

  function findYuzukiPanelRoot() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = String(node.nodeValue || '');
          return /当前末楼层|追溯分析范围|追溯指针|目标记忆/.test(text)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      },
    );

    let node = walker.nextNode();
    while (node) {
      let element = node.parentElement;
      while (element && element !== document.body) {
        if (
          element.matches?.(
            'dialog,[role="dialog"],.popup,.drawer,.modal,.panel,.side-panel,.settings-content,[class*="yuzuki"],[id*="yuzuki"]',
          ) &&
          elementVisible(element)
        ) {
          return element;
        }
        element = element.parentElement;
      }

      const parent = node.parentElement;
      if (parent && elementVisible(parent)) {
        let root = parent;
        for (let i = 0; i < 5 && root.parentElement && root.parentElement !== document.body; i += 1) {
          root = root.parentElement;
        }
        return root;
      }

      node = walker.nextNode();
    }

    return null;
  }

  function replaceCountText(root, total) {
    if (!root || !Number.isFinite(total) || total < 0) return;

    const last = Math.max(0, total - 1);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      const original = String(node.nodeValue || '');
      let next = original;

      next = next.replace(
        /当前末楼层\s*\d+\s*[·•｜|]\s*共\s*\d+\s*层/g,
        `当前末楼层 ${last} · 共 ${total} 层`,
      );

      next = next.replace(/共\s*\d+\s*层/g, match => {
        if (/当前末楼层/.test(original)) return `共 ${total} 层`;
        return match;
      });

      if (next !== original) node.nodeValue = next;
      node = walker.nextNode();
    }
  }

  function patchRangeInputs(root, total) {
    if (!root || !Number.isFinite(total) || total <= 0) return;

    const inputs = Array.from(root.querySelectorAll('input[type="number"]'));
    for (const input of inputs) {
      const wrapperText = String(
        input.closest('label,.form-group,.input-group,.row,div')?.textContent || '',
      );

      const oldMax = Number(input.max || 0);
      if (!oldMax || oldMax <= Math.max(50, state.loadedCount)) {
        input.max = String(total);
      }

      if (/结束楼层|末楼层/.test(wrapperText)) {
        const value = Number(input.value || 0);
        if (value === state.loadedCount || value === oldMax || value === 49 || value === 50) {
          input.value = String(total);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
  }

  function patchYuzukiPanelCount() {
    const root = state.panelRoot?.isConnected ? state.panelRoot : findYuzukiPanelRoot();
    if (!root) return false;

    state.panelRoot = root;
    const total = state.realFullCount;
    if (Number.isFinite(total) && total > 0) {
      replaceCountText(root, total);
      patchRangeInputs(root, total);
      try {
        root.dataset.yzmSafeRealCount = String(total);
      } catch {}
    }

    return true;
  }

  function visibleButtonTexts() {
    return Array.from(
      document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]'),
    )
      .filter(elementVisible)
      .map(el => String(el.textContent || el.value || '').replace(/\s+/g, ''));
  }

  function isYuzukiTaskRunning() {
    return visibleButtonTexts().some(text =>
      /(停止任务|取消任务|正在执行|处理中|执行中|正在总结|正在追溯)/.test(text),
    );
  }

  function isYuzukiAction(target) {
    const element = target?.closest?.(
      'button,[role="button"],input[type="button"],input[type="submit"]',
    );
    if (!element) return null;

    const text = String(element.textContent || element.value || '').replace(/\s+/g, '');
    if (!text) return null;

    return /(静默执行|弹窗确认|开始总结|执行总结|开始追溯|执行追溯|批量执行|重试本批|继续后续批次|开始填表|执行任务|开始分析并生成)/.test(text)
      ? element
      : null;
  }

  function installActionAutoBridge() {
    if (document.__yzmSafeAutoBridgeInstalledV060) return;
    document.__yzmSafeAutoBridgeInstalledV060 = true;

    document.addEventListener(
      'click',
      async event => {
        const element = isYuzukiAction(event.target);
        if (!element) return;

        if (state.taskReplayGuard) {
          state.taskSeenRunning = true;
          touchBridgeLease();
          return;
        }

        if (state.bridgeActive) {
          state.bridgeOwner = 'task';
          state.taskSeenRunning = true;
          touchBridgeLease();
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        showBanner('task', '正在准备完整历史', '准备好后会自动继续刚才的操作。', 0);

        const ok = await activateBridge({
          silent: true,
          force: true,
          reason: 'yuzuki-action',
          owner: 'task',
        });

        if (!ok) {
          hideBanner();
          const message = '完整历史未就绪，本次总结/追溯已取消，避免漏掉前文。';
          toast('error', message, 12000);
          try { globalThis.alert?.(message); } catch {}
          return;
        }

        showBanner('task', '完整历史已就绪', '正在继续执行柚月任务，请暂时不要连续点击。', 3000);

        state.taskReplayGuard = true;
        state.taskSeenRunning = true;

        try {
          await sleep(160);
          element.click();
          touchBridgeLease();
        } finally {
          setTimeout(() => {
            state.taskReplayGuard = false;
          }, 0);
        }
      },
      true,
    );
  }

  function buttonText() {
    if (state.loading) return '读取中…';
    if (state.lastError) return '⚠️ 重试';
    if (state.bridgeActive) return `✅ ${state.realFullCount}`;
    if (state.realFullCount > 0) return `🛡️ ${state.realFullCount}`;
    return '🛡️ 全量';
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
      ? `完整历史已启用，共 ${state.realFullCount} 层。`
      : state.realFullCount > 0
        ? `真实楼层 ${state.realFullCount}；柚月面板会自动加载完整历史。`
        : '点击手动读取完整历史。';
  }

  function ensureButton() {
    if (state.button?.isConnected) return;

    const button = document.createElement('button');
    button.id = 'yzm-safe-full-history-button';
    button.type = 'button';
    button.addEventListener('click', () =>
      activateBridge({
        silent: false,
        force: true,
        reason: 'manual-retry',
        owner: 'manual',
      }),
    );

    document.body.appendChild(button);
    state.button = button;
    updateButton();
  }

  async function handlePanelState() {
    const root = findYuzukiPanelRoot();
    const visible = !!root;

    state.panelVisible = visible;

    if (visible) {
      state.panelRoot = root;
      state.panelLastSeenAt = Date.now();

      await refreshRealCount({ patchPanel: true });

      if (!state.bridgeActive && !state.loading) {
        showBanner('task', '正在同步真实楼层', '柚月面板会自动切换到完整历史。', 0);

        const ok = await activateBridge({
          silent: true,
          force: true,
          reason: 'panel-open',
          owner: 'panel',
        });

        if (ok) {
          showBanner('recovered', '真实楼层已同步', `当前共 ${state.realFullCount} 层。`, 2400);
          patchYuzukiPanelCount();
        } else {
          hideBanner();
        }
      } else if (state.bridgeActive) {
        state.bridgeOwner = state.taskSeenRunning ? 'task' : 'panel';
        touchBridgeLease(10 * 60 * 1000);
        patchYuzukiPanelCount();
      }
    }
  }

  function queuePanelScan() {
    if (state.panelScanQueued) return;
    state.panelScanQueued = true;

    setTimeout(async () => {
      state.panelScanQueued = false;
      await handlePanelState();
    }, 180);
  }

  function installPanelObserver() {
    if (state.panelObserver) return;

    state.panelObserver = new MutationObserver(() => {
      queuePanelScan();
    });

    state.panelObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    document.addEventListener('click', queuePanelScan, true);
    queuePanelScan();
  }


  function parseLocalStorageJson(key, fallback = {}) {
    try {
      const raw = globalThis.localStorage?.getItem?.(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function getAutomationProtectionStatus() {
    const autoKey = 'yzm_memory_global_auto_summary_settings';
    const pluginKey = 'yzm_memory_global_plugin_settings';
    const hasAutoRecord = globalThis.localStorage?.getItem?.(autoKey) != null;
    const hasPluginRecord = globalThis.localStorage?.getItem?.(pluginKey) != null;
    const auto = parseLocalStorageJson(autoKey, {});
    const plugin = parseLocalStorageJson(pluginKey, {});

    // 柚月自身在没有保存设置时，把小总结和大总结视为开启。
    const summaryEnabled = hasAutoRecord ? auto.summaryEnabled !== false : true;
    const historyEnabled = hasAutoRecord ? auto.historyEnabled !== false : true;

    const traceEnabled = hasPluginRecord
      ? (
          plugin.enableFilling !== false &&
          plugin.fillMode === 'batch' &&
          plugin.traceBatchEnabled === true
        )
      : false;

    return {
      enabled: summaryEnabled || historyEnabled || traceEnabled,
      summaryEnabled,
      historyEnabled,
      traceEnabled,
    };
  }

  function cancelPendingYuzukiAutoTask(reason = 'guard-not-ready') {
    try {
      globalThis.YuzukiMemory?.TaskRunner?.cancelPendingAutoTask?.();
      console.warn(`[${MODULE}] 已取消柚月待执行自动任务：${reason}`);
      return true;
    } catch (error) {
      console.warn(`[${MODULE}] 取消柚月自动任务失败`, error);
      return false;
    }
  }

  function isAutoGuardLeaseActive() {
    return state.bridgeOwner === 'auto' && Date.now() < state.autoGuardUntil;
  }

  function queueAutomaticProtection(reason = 'assistant-message') {
    const status = getAutomationProtectionStatus();
    if (!status.enabled) return;

    if (state.autoGuardTimer) clearTimeout(state.autoGuardTimer);
    state.autoGuardReason = reason;

    state.autoGuardTimer = setTimeout(async () => {
      state.autoGuardTimer = null;

      const ok = await activateBridge({
        silent: true,
        force: true,
        reason: `auto-${reason}`,
        owner: 'auto',
      });

      if (!ok) {
        state.autoGuardUntil = 0;
        cancelPendingYuzukiAutoTask('full-history-load-failed');
        toast(
          'error',
          '完整历史读取失败，本轮柚月自动任务已取消，避免按 50 层残缺上下文写入。',
          12000,
        );
        return;
      }

      // 柚月会在生成结束后延迟调度，并可能因输入/请求繁忙而反复延期。
      // 保留五分钟完整历史窗口；发送下一条用户消息时会立刻释放旧快照。
      state.bridgeOwner = 'auto';
      state.autoGuardUntil = Date.now() + 5 * 60 * 1000;
      touchBridgeLease(5 * 60 * 1000);

      console.info(`[${MODULE}] 自动化保护窗口已就绪`, {
        reason,
        total: state.realFullCount,
        until: new Date(state.autoGuardUntil).toISOString(),
        status,
      });
    }, 120);
  }

  function queueBridgeRefresh(reason = 'chat-updated') {
    if (state.refreshQueued) return;
    state.refreshQueued = true;

    setTimeout(async () => {
      state.refreshQueued = false;

      await refreshRealCount({ patchPanel: true });

      if (isAutoGuardLeaseActive()) {
        // 当前完整历史由后台自动化保护窗口持有；聊天发生编辑时刷新快照。
        await activateBridge({
          silent: true,
          force: true,
          reason,
          owner: 'auto',
        });
        state.autoGuardUntil = Date.now() + 5 * 60 * 1000;
        touchBridgeLease(5 * 60 * 1000);
        return;
      }

      if (!state.panelVisible) {
        deactivateBridge({ silent: true, reason });
        return;
      }

      if (isYuzukiTaskRunning()) {
        touchBridgeLease();
        return;
      }

      await activateBridge({
        silent: true,
        force: true,
        reason,
        owner: 'panel',
      });

      patchYuzukiPanelCount();
    }, 420);
  }

  function startBridgeMonitor() {
    if (state.bridgeMonitorTimer) return;

    state.bridgeMonitorTimer = setInterval(async () => {
      const root = findYuzukiPanelRoot();
      state.panelVisible = !!root;
      if (root) {
        state.panelRoot = root;
        state.panelLastSeenAt = Date.now();
        patchYuzukiPanelCount();
      }

      if (!state.bridgeActive) return;

      if (isYuzukiTaskRunning()) {
        state.taskSeenRunning = true;
        state.bridgeOwner = 'task';
        touchBridgeLease();
        return;
      }

      const now = Date.now();

      if (state.taskSeenRunning) {
        state.taskSeenRunning = false;
        if (state.panelVisible) {
          state.bridgeOwner = 'panel';
          touchBridgeLease(10 * 60 * 1000);
          await refreshRealCount({ patchPanel: true });
        } else if (state.autoGuardUntil > now) {
          state.bridgeOwner = 'auto';
          touchBridgeLease(state.autoGuardUntil - now);
        } else {
          deactivateBridge({ silent: true, reason: 'task-finished' });
        }
        return;
      }

      if (state.bridgeOwner === 'auto') {
        if (state.autoGuardUntil > now) {
          touchBridgeLease(state.autoGuardUntil - now);
          return;
        }

        state.autoGuardUntil = 0;
        deactivateBridge({ silent: true, reason: 'auto-window-finished' });
        return;
      }

      if (!state.panelVisible && now - state.panelLastSeenAt > 8000) {
        deactivateBridge({ silent: true, reason: 'panel-closed' });
        return;
      }

      if (state.bridgeReleaseDeadline && now > state.bridgeReleaseDeadline) {
        deactivateBridge({ silent: true, reason: 'lease-timeout' });
      }
    }, 1800);
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
      'CHARACTER_MESSAGE_RENDERED',
    ];

    for (const name of eventNames) {
      const eventName = eventTypes[name];
      if (!eventName) continue;

      const marker = `__yzmSafeGuardV060_${name}`;
      if (eventSource[marker]) continue;

      try {
        eventSource.on(eventName, () => {
          sanitizeRealChat(`事件 ${name}`);
          patchFloorHider();
          patchSaveHooks();

          if (name === 'CHAT_CHANGED') {
            if (state.autoGuardTimer) clearTimeout(state.autoGuardTimer);
            state.autoGuardTimer = null;
            state.autoGuardUntil = 0;
            deactivateBridge({ silent: true, reason: 'chat-changed' });
            state.realFullCount = 0;
            state.currentChatKey = '';
            setTimeout(() => {
              refreshRealCount({ patchPanel: true });
              queuePanelScan();
            }, 350);
            return;
          }

          if (name === 'MESSAGE_SENT') {
            // 用户发出新消息后，上一轮完整历史副本已经过期。
            if (state.autoGuardTimer) clearTimeout(state.autoGuardTimer);
            state.autoGuardTimer = null;
            state.autoGuardUntil = 0;
            deactivateBridge({ silent: true, reason: 'new-user-message' });
            refreshRealCount({ patchPanel: true });
            return;
          }

          if (
            name === 'MESSAGE_RECEIVED' ||
            name === 'GENERATION_ENDED' ||
            name === 'CHARACTER_MESSAGE_RENDERED'
          ) {
            // 柚月的自动任务正是在这些事件之后延迟调度。
            queueAutomaticProtection(name.toLowerCase());
            return;
          }

          queueBridgeRefresh(`event-${name.toLowerCase()}`);
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
    ensureBanner();
    installActionAutoBridge();
    installEventHooks();
    patchYuzukiPanelCount();
  }

  async function start() {
    if (state.started) return;
    state.started = true;

    patchGetContext();
    ensureButton();
    ensureBanner();
    installActionAutoBridge();
    installPanelObserver();
    startBridgeMonitor();

    const boot = setInterval(async () => {
      healthCheck();
      await refreshRealCount({ patchPanel: true });

      if (globalThis.YuzukiMemory && rawContext()) {
        clearInterval(boot);
        toast(
          'success',
          `v${VERSION} 已启用：真实楼层常驻，面板与后台自动任务均会按需加载完整历史。`,
          8500,
        );
      }
    }, 500);

    setTimeout(() => clearInterval(boot), 30000);

    state.countRefreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshRealCount({ patchPanel: true });
      }
    }, 5000);

    setInterval(() => {
      if (document.visibilityState === 'visible') healthCheck();
    }, 60000);

    globalThis.addEventListener('focus', () => {
      healthCheck();
      refreshRealCount({ patchPanel: true });
      queuePanelScan();
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        healthCheck();
        refreshRealCount({ patchPanel: true });
        queuePanelScan();
      }
    }, { passive: true });
  }

  globalThis[MODULE] = {
    state,
    activateBridge,
    deactivateBridge,
    refreshRealCount,
    sanitizeRealChat,
    healthCheck,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
