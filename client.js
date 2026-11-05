// ============================================================================
// 正式版：聊天 / 工作双模式插件（Chat / Work）
//
// 聊天模式：在常驻 overlay 层里用租约 webview 内嵌 DeepSeek 官方网页版
//   （默认 https://chat.deepseek.com/，可在设置页改地址）。聊天模式下本插件
//   **没有任何 API 调用**、不触发 Agent 循环、不做后台请求；页面浏览由官方网页
//   自己完成。工作模式就是 DSH 原生 Agent 界面，只有它调用 API、消耗 token。
//
// 本文件实现：
//   - 标题栏「聊天 / 工作」分段切换（工作模式警示色 + title 提示）
//   - 聊天层常驻保活：只切 display，不卸载 DOM、不重载页面
//   - 聊天模式下遮住 DSH 标题栏左上角「收起侧栏」按钮（被聊天层盖住、点了没效果）
//   - 设置页：默认启动模式、网页版地址（https 校验）、记住上次模式、登录恢复开关、
//     「带入工作」模板
//   - 「带入工作模式」一键：读网页当前选中的文字（只读 getSelection().toString()）→
//     切到工作模式 → 模板 + 选中文字用 captureInsertion + insertText 在光标处插入
//     （不覆盖已有草稿、不发送）；没有选中文字 / 脚本失败时回退到原来的粘贴对话框；
//     没有可用会话时暂存为「待带入草稿」（纯内存、最多 10 分钟），
//     工作模式顶部提示条供用户选择「填入当前会话」或「取消」
//   - 登录恢复（默认开启，可关闭）：自动保存 localStorage.userToken 一项，明文存插件
//     localStorage；恢复失败自动清除；详细方案见 research/formal-plan.md §7
//
// 明确不做：
//   - 不读 document.cookie / IndexedDB / 页面 DOM（只执行下面两类固定脚本：
//     登录恢复只读写 userToken；「带入工作」只读 window.getSelection().toString()）
//   - 不分析、不保存用户输入内容；读到的选中文字只放内存、用完即清，不写任何存储
//   - 除上述固定脚本外不调用 executeJavaScript；不保存、不上报任何数据；
//     token / 选中文字不发送到任何地方；无后台轮询或定时请求
// ============================================================================

window.__ModuleLoader__.load({
  id: '@local/dsh-chat-mode-ko',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ------------------------------------------------------------------
    // 常量（全部公开可审计；网页地址由设置在运行期给出）
    // ------------------------------------------------------------------
    const PREF_KEY = 'dsh-chat-mode:prefs:v1'; // 设置（默认模式/网页地址/记住开关等）
    const LEASE_WORKSPACE = 'dsh-chat-mode'; // 租约的 workspace 键（普通字符串）
    const DEFAULT_WEB_URL = 'https://chat.deepseek.com/'; // 设置页的默认网页地址
    const DEFAULT_MODE = 'chat'; // 默认启动模式：聊天（避免无意消耗 token）

    // 标题栏切换控件的左偏移「兜底值」（px，从窗口左边缘算起）。
    // 正常运行时不再依赖它：控件会实时测量 preload 注入的原生菜单宿主
    // [data-windows-menu] 的右边界，再留出 TITLEBAR_MENU_GAP 的间距。
    // 参考（兜底依据）：菜单栏从 48px 开始，[应用]≈48px + 2px 间隙 + [编辑]≈48px ≈ 146px。
    // 只在量不到菜单宿主时（非 Windows 标题栏 / preload 未注入）才用这个值。
    const TITLEBAR_LEFT_OFFSET = 154;

    // 原生 Windows 菜单宿主选择器（由 preload 的 installWindowsMenu() 注入）。
    // 它的 :host 是 fixed 定位，left 跟随 --dsh-windows-menu-start（展开 48px、收起 84px）。
    const WINDOWS_MENU_SELECTOR = '[data-windows-menu]';

    // 插件控件与原生菜单右边界之间保留的间距（px）。
    const TITLEBAR_MENU_GAP = 8;

    // 聊天模式下把原生菜单左移到这个位置（px），让菜单回到隐藏按钮原来的左边缘，
    // 消除标题栏左侧空白。只覆盖 DSH 的 CSS 变量 --dsh-windows-menu-start，
    // 且只在受控期间生效（html[data-chat-mode-hide-toggle="1"]）；撤销属性后自动恢复
    // DSH 原值（展开 48px、收起 84px）。依赖 DSH 的变量名，改版失效时只是空白回来。
    const CHAT_MODE_MENU_START = 12;

    // 标题栏高度兜底（px）。html 上的 --dsh-windows-titlebar-height 由 preload 设为 40px。
    const TITLEBAR_HEIGHT_FALLBACK = 40;

    // 聊天层顶部下移量（px）：让聊天层不盖住标题栏，并使两个模式的 logo 对齐。
    // 初始值 34 来自用户按截图估算（聊天页 logo y≈30，工作模式 logo y≈64，差 34px）；
    // 不依赖 --dsh-frame-top-clearance，微调时只改这一个常量。
    const CHAT_LAYER_TOP = 34;

    // ------------------------------------------------------------------
    // 聊天模式下隐藏 DSH 标题栏左上角按钮（受控样式，只作用于下列按钮）
    // 展开状态：侧栏开关，aria-label 为「收起侧边栏 / Collapse sidebar」；
    // 收起状态：同一个开关变为「打开侧边栏 / Open sidebar」，标题栏还多一个「新建会话 / New session」图标。
    // 这些按钮没有稳定的 data-* 属性，class 是构建时自动生成的，因此只能按 aria-label 精确匹配；
    // 收起态的新会话图标用 [data-sidebar-collapsed="true"] 限定，避免误隐藏展开态侧栏里的同名按钮。
    // ------------------------------------------------------------------
    // 常量开关：false 时完全不注入样式/属性，按钮保持原样。
    const HIDE_DSH_SIDEBAR_BUTTON = true;
    // 挂在 <html> 上的属性名；聊天层可见时设为 "1"，撤销时移除。
    const DSH_SIDEBAR_HIDE_ATTR = 'data-chat-mode-hide-toggle';
    // 注入 <head> 的受控样式：只隐藏这些按钮（仍占位，不影响标题栏布局），并把标题栏原生菜单左移，
    // 消除隐藏按钮左侧的空白。两条规则挂在同一个 <style> 里，随受控属性一起撤销。
    // 菜单左移只覆盖 --dsh-windows-menu-start（DSH 用它给 preload 菜单宿主设 left），
    // 切换条仍按「菜单右边界 + 8px」动态测量，所以两者会一起移动、不会重叠。
    const DSH_SIDEBAR_HIDE_CSS =
      [
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] button[aria-label="收起侧边栏"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] button[aria-label="Collapse sidebar"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] button[aria-label="打开侧边栏"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] button[aria-label="Open sidebar"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] [data-sidebar-collapsed="true"] button[aria-label="新建会话"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] [data-sidebar-collapsed="true"] button[aria-label="New session"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] button[aria-label="사이드바 접기"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] button[aria-label="사이드바 열기"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] [data-sidebar-collapsed="true"] button[aria-label="새 세션"]',
      ].join(', ') +
      ' { visibility: hidden !important; pointer-events: none !important; }' +
      '\nhtml[' + DSH_SIDEBAR_HIDE_ATTR + '="1"][data-windows-titlebar] { --dsh-windows-menu-start: ' +
      CHAT_MODE_MENU_START + 'px !important; }';

    // ------------------------------------------------------------------
    // 「带入工作」一键带入（读取网页中选中的文字）
    // ------------------------------------------------------------------
    const BRING_SELECTION_MAX_CHARS = 20000; // 选中文字上限（超出截断并在界面提示）
    const DEFAULT_BRING_TEMPLATE = '아래는 웹 채팅에서 정리한 요점입니다. 정리해서 기억해 주세요:\n\n';
    // 待带入草稿的内存保留时长：超过 10 分钟自动清除（一次性定时器，不写存储）。
    const PENDING_BRING_TTL_MS = 10 * 60 * 1000;
    // 提示条「填入当前会话」在无可用会话 / startSession 不可用时显示的固定文案（不拼接任何内容）。
    const BRING_NO_TARGET_TEXT = 'DSH 의 “새 세션”을 누르거나 세션을 선택하세요. 선택하면 자동으로 채워집니다';

    // ------------------------------------------------------------------
    // 登录恢复（正式功能，可选，仅限 userToken 一项）
    // ------------------------------------------------------------------
    // 保存位置：插件自己的 localStorage 键（dsh-app://app/ 源）。明文 JSON：
    //   { v: 1, token: "<不透明字符串>", savedAt: <毫秒时间戳> }
    const LOGIN_KEY = 'dsh-chat-mode:login:v1';
    // 只允许在官方聊天站点 origin 下读写 localStorage.userToken。
    const CHAT_ORIGIN = 'https://chat.deepseek.com';

    // 所有 executeJavaScript 的脚本都是写死的字符串常量；token 值只作为「数据」传入
    // （JSON.stringify 后写进模板的数据位），不拼接成可执行代码。
    // 只读 userToken：
    const SCRIPT_READ_USER_TOKEN =
      '(() => { try { const value = localStorage.getItem("userToken"); ' +
      'return typeof value === "string" ? value : ""; } catch (error) { return ""; } })()';
    // 写回 userToken：前缀 + JSON.stringify(token) + 后缀；脚本结构固定、token 只是数据。
    const SCRIPT_WRITE_USER_TOKEN_PREFIX = '(() => { try { const token = ';
    const SCRIPT_WRITE_USER_TOKEN_SUFFIX =
      '; if (typeof token !== "string" || token.length === 0) return false; ' +
      'localStorage.setItem("userToken", token); return true; } catch (error) { return false; } })()';
    // 只读 location.pathname（判断恢复后是否仍在登录页）：
    const SCRIPT_READ_PATHNAME =
      '(() => { try { return location.pathname || ""; } catch (error) { return ""; } })()';
    // 只读用户当前选中的文字（window.getSelection().toString()）：不读 DOM 其他内容、
    // 不读输入框/聊天记录；只在用户点击「带入工作」且页面 origin 完全等于官方站点时执行。
    const SCRIPT_READ_SELECTION =
      '(() => { try { const selection = window.getSelection(); ' +
      'return String(selection ? selection.toString() : ""); } catch (error) { return ""; } })()';

    // 只用已确认存在的主题变量（getComputedStyle 检查结果显示在诊断面板），并带同色系兜底，
    // 避免深字配深底：bg-base 与 label-primary 是成对的中性色，border 用于区分边界。
    const BORDER_COLOR = 'var(--dsw-alias-border, rgba(128,128,128,.45))';
    const LABEL_COLOR = 'var(--dsw-alias-label-primary, #111)';

    // ------------------------------------------------------------------
    // 设置（localStorage 持久化；读不出/损坏时逐字段回落默认值）
    // ------------------------------------------------------------------
    const prefs = {
      defaultMode: DEFAULT_MODE, // 'chat' | 'work'：不记住上次模式时的启动模式
      webUrl: DEFAULT_WEB_URL, // 网页版地址（https + 无凭据校验后保存）
      webUrlConfirmedHost: null, // 非 deepseek.com 域名：用户二次确认过的 hostname（否则不放行）
      rememberLast: false, // 是否记住上次使用的模式
      rememberLogin: true, // 是否自动记住登录（默认开；只处理 userToken）
      lastMode: 'chat', // 内部值：上次模式（rememberLast 开启时使用）
      diagOpen: false, // 诊断面板是否展开（仅本地界面偏好）
      bringTemplate: DEFAULT_BRING_TEMPLATE, // 「带入工作」一键带入时加在选中文字前的模板
    };

    function normalizeWebUrl(value) {
      if (typeof value !== 'string') return null;
      const text = value.trim();
      if (!text) return null;
      try {
        const url = new URL(text);
        if (url.protocol !== 'https:' || !url.hostname) return null;
        // 拒绝带用户名/密码的地址（https://user:pass@host/ 形式）
        if (url.username || url.password) return null;
        return url.toString();
      } catch {
        return null;
      }
    }

    // 默认只放行 deepseek.com 及其子域名；其他域名需要用户在设置页二次确认
    function isDeepseekHost(hostname) {
      return (
        typeof hostname === 'string' &&
        (hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com'))
      );
    }

    // loadURL 之前的运行时二次校验（存储值可能被其他脚本改过）：
    // 必须是 https、无凭据；非 deepseek 域名必须在设置页被用户二次确认过。
    // 任一条件不满足就回退默认地址，绝不加载未确认的地址。
    function effectiveChatUrl() {
      const normalized = normalizeWebUrl(prefs.webUrl);
      if (!normalized) return DEFAULT_WEB_URL;
      try {
        const host = new URL(normalized).hostname;
        if (isDeepseekHost(host)) return normalized;
        if (prefs.webUrlConfirmedHost === host) return normalized;
      } catch {
        return DEFAULT_WEB_URL;
      }
      return DEFAULT_WEB_URL;
    }

    function loadPrefs() {
      let raw = null;
      try {
        raw = globalThis.localStorage?.getItem(PREF_KEY);
      } catch {
        raw = null;
      }
      if (!raw) return;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.defaultMode === 'chat' || parsed.defaultMode === 'work') {
        prefs.defaultMode = parsed.defaultMode;
      }
      const webUrl = normalizeWebUrl(parsed.webUrl);
      if (webUrl) prefs.webUrl = webUrl;
      const confirmedHost = parsed.webUrlConfirmedHost;
      prefs.webUrlConfirmedHost =
        typeof confirmedHost === 'string' && /^[a-z0-9.-]{1,253}$/.test(confirmedHost)
          ? confirmedHost
          : null;
      prefs.rememberLast = parsed.rememberLast === true;
      if (typeof parsed.rememberLogin === 'boolean') prefs.rememberLogin = parsed.rememberLogin;
      prefs.lastMode = parsed.lastMode === 'work' ? 'work' : 'chat';
      prefs.diagOpen = parsed.diagOpen === true;
      if (typeof parsed.bringTemplate === 'string') {
        // 模板只做长度上限保护（不解释内容）；空字符串是合法值（= 不加前缀）
        prefs.bringTemplate = parsed.bringTemplate.slice(0, 4000);
      }
    }

    function savePrefs(patch) {
      if (patch && typeof patch === 'object') Object.assign(prefs, patch);
      try {
        globalThis.localStorage?.setItem(PREF_KEY, JSON.stringify(prefs));
      } catch {
        // 偏好保存失败不影响功能
      }
    }

    // 启动模式：不记住上次模式 → 默认启动模式；记住 → 上次模式（兜底 chat）
    function resolveStartMode() {
      if (prefs.rememberLast) return prefs.lastMode === 'work' ? 'work' : 'chat';
      return prefs.defaultMode === 'work' ? 'work' : 'chat';
    }

    loadPrefs();

    // ------------------------------------------------------------------
    // 模块级状态（插件卸载即销毁；持久化只发生在 prefs / LOGIN_KEY）
    // ------------------------------------------------------------------
    let version = 0;
    const listeners = new Set();
    const state = {
      mode: resolveStartMode(), // 'chat' | 'work'
      bridge: 'unknown', // unknown | ok | missing
      phase: 'idle', // idle | acquiring | created | loading | ready | failed | no-bridge
      lease: '-',
      partition: '-',
      error: '',
      inspecting: false,
      diagOpen: prefs.diagOpen, // 诊断面板默认隐藏
      geometry: null,
      counters: { domReady: 0, start: 0, stop: 0, navigate: 0, navigateInPage: 0, fail: 0, gone: 0 },
      // 加载遮罩：消除登录恢复时的登录页闪烁；首个页面稳定/恢复结束后撤掉
      mask: true,
      // 「带入工作模式」对话框
      bring: {
        open: false,
        text: '',
        busy: false,
        error: '',
        notice: '',
        toast: '', // 一键带入的短暂提示（例如"已截断到 20000 字"），只显示固定文字
        pending: null, // 待带入草稿的展示信息 { chars, truncated }；正文只在内存变量里
        filling: false, // 提示条「填入当前会话」正在等待无会话路径的自动填入（只临时禁用按钮，不代表没有会话）
      },
      // 登录恢复状态（只用于显示状态与长度，绝不保存/显示 token 值本身）
      login: {
        saved: false, // 插件自己的 localStorage 里是否存在已保存副本
        savedLength: 0, // 已保存 token 的长度（仅用于显示"已保存（长度 N）"）
        savedAt: 0, // 保存时间（毫秒），仅用于显示日期
        status: 'idle', // idle | saved | cleared | restoring | restored | still-login | error
        error: '', // 只放通用描述，不放任何数据/异常原文
      },
      events: [],
    };

    let element = null; // <webview> 元素；插件卸载前一直保留
    let lease = null; // { lease, partition }
    let bridge = null; // window.dshDesktop.browser
    let loadIssued = false;
    let inspectTimer = null;
    let hostContainer = null;
    let maskTimer = null; // 加载遮罩兜底定时器（8 秒）
    let toastTimer = null; // 「带入工作」简短提示的自动清除定时器

    // ------------------------------------------------------------------
    // 登录恢复的存储（token 只在内存里；持久化只在 LOGIN_KEY，明文、单键）
    // ------------------------------------------------------------------
    let savedUserToken = null; // 从插件 localStorage 读出的 userToken（不透明字符串）
    let savedTokenAt = 0; // 保存时间（毫秒）
    let restoreAttempted = false; // 本次 webview 生命周期内是否已尝试恢复
    let restoreReloaded = false; // 是否已为恢复写回并触发过一次 reload
    let loggedOutThisRun = false; // 本次运行内检测到用户主动退出后，不再自动恢复
    // 退出检测的启用条件：本次运行内已确认登录（恢复成功，或自动 / 手动保存成功）。
    // 启动时仅从存储载入副本不算确认登录，因此登录页先闪一下的那次导航不会误清副本。
    let loginConfirmedThisRun = false;

    function readLoginStore() {
      let raw = null;
      try {
        raw = globalThis.localStorage?.getItem(LOGIN_KEY);
      } catch {
        return null;
      }
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
        return { token: parsed.token, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0 };
      } catch {
        return null;
      }
    }

    function writeLoginStore(token) {
      try {
        const savedAt = Date.now();
        globalThis.localStorage?.setItem(
          LOGIN_KEY,
          JSON.stringify({ v: 1, token, savedAt }),
        );
        return savedAt;
      } catch {
        return 0;
      }
    }

    function clearLoginStore() {
      try {
        globalThis.localStorage?.removeItem(LOGIN_KEY);
      } catch {
        // 删除失败也继续清空内存状态
      }
    }

    function readStoredToken() {
      const entry = readLoginStore();
      return entry ? entry.token : null;
    }

    // 启动时只把"是否存在/长度/时间"同步到界面状态；值本身留在内存变量里。
    // 注意：这里不改变 state.login.status（启动后仍为初始值 idle），
    // 退出检测也不依赖 status，而是依赖 loginConfirmedThisRun（见下）。
    function refreshLoginState() {
      const entry = readLoginStore();
      savedUserToken = entry ? entry.token : null;
      savedTokenAt = entry ? entry.savedAt : 0;
      state.login.saved = savedUserToken !== null;
      state.login.savedLength = savedUserToken ? savedUserToken.length : 0;
      state.login.savedAt = savedTokenAt;
    }

    function isChatOrigin(url) {
      try {
        return new URL(url).origin === CHAT_ORIGIN;
      } catch {
        return false;
      }
    }

    function isSignInPathname(url) {
      try {
        return new URL(url).pathname.indexOf('/sign_in') === 0;
      } catch {
        return false;
      }
    }

    // ------------------------------------------------------------------
    // 출처 링크 열기
    // ------------------------------------------------------------------
    // 채팅 모드는 DeepSeek 공식 웹 채팅을 <webview> 에 띄운다. 웹뷰에는 팝업 창이
    // 없어서 페이지가 window.open(또는 target="_blank") 으로 여는 링크(답변의
    // 출처/인용 링크)가 그냥 사라진다. 그래서 두 갈래로 받아 시스템 기본
    // 브라우저로 넘긴다.
    //   1) 메인 프로세스 브리지가 알려 주는 "새 창 열기 요청"(가능한 경우)
    //   2) 웹뷰가 외부 사이트로 이동하려는 경우(같은 페이지 안에서 이동하는 링크)
    // DeepSeek 공식 사이트(*.deepseek.com) 안에서의 이동은 그대로 둔다. 로그인과
    // OAuth 흐름이 그 안에서 일어나기 때문이다. 링크 본문은 읽지 않고 URL 만 넘긴다.
    function isOpenableExternalUrl(value) {
      if (typeof value !== 'string') return false;
      const text = value.trim();
      if (!text || text.length > 2048) return false;
      if (/\s/.test(text)) return false;
      return /^https?:\/\//i.test(text);
    }

    function isDeepseekNavigationTarget(url) {
      try {
        const host = new URL(url).hostname;
        return host === 'deepseek.com' || host.endsWith('.deepseek.com');
      } catch {
        return false;
      }
    }

    function requestOpenExternal(url) {
      if (!isOpenableExternalUrl(url)) return;
      try {
        Promise.resolve(
          fetch('/chat-mode-ko/open', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: url.trim() }),
          }),
        ).catch(() => {});
      } catch {
        // fetch 가 막힌 환경에서는 조용히 무시한다(채팅 자체는 계속 동작).
      }
    }

    let detachOpenRequests = null;

    function watchOpenRequests(view, leaseId) {
      const disposers = [];
      try {
        const carrier = globalThis.dshDesktop;
        const bridgeApi = carrier ? carrier.browser : null;
        if (bridgeApi && typeof bridgeApi.onOpenRequested === 'function' && typeof leaseId === 'string') {
          const off = bridgeApi.onOpenRequested(leaseId, (url) => requestOpenExternal(url));
          if (typeof off === 'function') disposers.push(off);
        }
      } catch {
        // 이 브리지가 콜백을 지원하지 않으면 아래 will-navigate 경로만 쓴다.
      }
      const onWillNavigate = (event) => {
        const target = event && typeof event.url === 'string' ? event.url : '';
        if (!target) return;
        if (isChatOrigin(target) || isDeepseekNavigationTarget(target)) return;
        try {
          event.preventDefault();
        } catch {
          // 취소할 수 없는 이벤트면 그냥 통과시킨다.
        }
        requestOpenExternal(target);
      };
      try {
        view.addEventListener('will-navigate', onWillNavigate);
        disposers.push(() => view.removeEventListener('will-navigate', onWillNavigate));
      } catch {
        // 이벤트를 걸 수 없는 환경이면 브리지 경로만 남는다.
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // 정리 실패는 무시한다.
          }
        }
      };
    }

    // 退出检测：只用导航事件自带的 URL（不执行页面脚本、不读页面存储）。
    // 仅当本次运行内已确认登录后才启用，避免恢复流程/首次加载的登录页被误判为"主动退出"。
    function handleSignInNavigation(url) {
      if (!loginConfirmedThisRun) return false;
      if (restoreReloaded) return false; // 恢复写回触发的 reload 过程不算主动退出
      if (!isChatOrigin(url) || !isSignInPathname(url)) return false;
      loggedOutThisRun = true;
      loginConfirmedThisRun = false;
      dropSavedLogin('로그아웃을 감지했습니다');
      return true;
    }

    // 当前有效的聊天地址：运行时再校验一次（https/无凭据/deepseek 或已确认域名），否则回落默认地址
    function currentChatUrl() {
      return effectiveChatUrl();
    }

    // 登录恢复只对官方 chat.deepseek.com 生效（换自定义地址时不碰登录令牌）
    function isOfficialChatSite() {
      try {
        return new URL(currentChatUrl()).origin === CHAT_ORIGIN;
      } catch {
        return false;
      }
    }

    // 开关关闭时不保留副本（满足"开关关闭时清除已保存的副本"）
    if (!prefs.rememberLogin) clearLoginStore();
    refreshLoginState();

    // 清理第一段 spike 插件遗留的两个自有键（只删键、不读值、不碰其他键；
    // 其中 userToken 是明文登录副本，删除有安全收益）。
    try {
      globalThis.localStorage?.removeItem('dsh-webview-spike:mode:v1');
      globalThis.localStorage?.removeItem('dsh-webview-spike:userToken:v1');
    } catch {
      // 清理失败不影响功能
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------
    // 只有「记住上次模式」开启时 lastMode 才参与启动决策；始终记录以便开关切换
    function saveMode(mode) {
      savePrefs({ lastMode: mode === 'work' ? 'work' : 'chat' });
    }

    function now() {
      try {
        return new Date().toLocaleTimeString('ko-KR', { hour12: false });
      } catch {
        return '--:--:--';
      }
    }

    function firstLine(error) {
      const text = error && typeof error.message === 'string' ? error.message : String(error);
      return text.split('\n')[0].slice(0, 180);
    }

    function notify() {
      version += 1;
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // 单个订阅者异常不影响其他订阅者
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function useSpike() {
      return React.useSyncExternalStore(subscribe, () => version);
    }

    function record(name, detail) {
      const label = detail ? name + ' (' + detail + ')' : name;
      state.events = [{ at: now(), label }, ...state.events].slice(0, 8);
      notify();
    }

    function switchMode(mode) {
      if (mode !== 'chat' && mode !== 'work') return;
      if (state.mode === mode) return;
      state.mode = mode;
      // 切回聊天模式时丢弃内存中的待带入草稿（不跨模式保留，也不写任何存储）
      if (mode === 'chat') clearPendingBring();
      saveMode(mode);
      record(mode === 'chat' ? '전환 → 채팅 모드' : '전환 → 작업 모드');
      notify();
    }

    function toggleDiag() {
      state.diagOpen = !state.diagOpen;
      savePrefs({ diagOpen: state.diagOpen });
      notify();
    }

    function resetCounters() {
      state.counters = { domReady: 0, start: 0, stop: 0, navigate: 0, navigateInPage: 0, fail: 0, gone: 0 };
      state.events = [];
      record('카운터를 초기화했습니다');
    }

    // ------------------------------------------------------------------
    // 「带入工作模式」：只填入、不发送（发送由用户自己决定）
    // ------------------------------------------------------------------
    // composer 桥：注册在 conversation.input.left（session 作用域，hero/composer 两种输入条都会渲染）
    // 的无 UI 组件，会通过标准 prop 收到 inputActions 与 sessionId（见 live Slot 目录 standardProps）。
    // mounted=true 表示当前真的挂着一个可用的会话输入框；只有 mounted 时才拿 actions，
    // 不再用「最近一次上报的 sessionId」这种可能过期的值判断当前状态。
    let composerBridge = { mounted: false, sessionId: null, actions: null };
    // apply 时保存的 Client root Context：点击「填入当前会话」时用它惰性取 ctx.get('uiWorkspace')。
    let appCtx = null;

    // 待带入草稿：每次带入都先放在内存里，由提示条让用户选择目标会话：
    //   - 带入时已有会话（originSessionId 非空）：只有切到另一个/新建会话才自动填入；
    //   - 带入时在新会话窗口（originSessionId 为 null）：之后在任意会话桥接挂载即算「选定」，自动填入。
    // 结构 { id, composed, chars, truncated, originSessionId }；不写任何存储，新的覆盖旧的，正文用完即清除。
    let pendingBring = null;
    let pendingBringSeq = 0;
    let pendingBringTimer = null;
    // 已被自动填入尝试过的 pendingBring.id：模块级记录，桥接组件重挂载（hero→composer、模式切换）也不会重复自动填入。
    let pendingAutoAttemptedId = 0;
    // 「填入当前会话」在无挂载会话时调用 uiWorkspace.startSession 后的兜底定时器（防止按钮一直等待）。
    let pendingFillTimer = null;

    function openBringDialog(notice) {
      state.bring.open = true;
      state.bring.busy = false;
      state.bring.error = '';
      state.bring.notice = typeof notice === 'string' ? notice : '';
      // 对话框默认空文本框；剪贴板只在用户点击「读取剪贴板」时读取一次
      state.bring.text = '';
      notify();
    }

    // 仅在用户点击「读取剪贴板」按钮时调用；读到的内容只放进可编辑文本框，不自动填入、不发送。
    function readClipboardIntoDialog() {
      let clipboard = null;
      try {
        clipboard = globalThis.navigator && globalThis.navigator.clipboard;
      } catch {
        clipboard = null;
      }
      if (!clipboard || typeof clipboard.readText !== 'function') {
        state.bring.notice = '현재 환경에서는 클립보드를 읽을 수 없습니다. 아래 입력란에 직접 붙여넣어 주세요';
        notify();
        return;
      }
      Promise.resolve(clipboard.readText())
        .then((text) => {
          if (typeof text === 'string' && text.length > 0) {
            state.bring.text = text.slice(0, 8000);
            state.bring.notice = '클립보드를 읽었습니다. 확인하거나 고친 뒤 “가져오기 확인(전송 안 함)”을 눌러 주세요';
          } else {
            state.bring.notice = '클립보드가 비어 있습니다. 직접 입력하거나 붙여넣어 주세요';
          }
          notify();
        })
        .catch(() => {
          state.bring.notice = '클립보드를 읽을 수 없습니다. 아래 입력란에 직접 붙여넣어 주세요';
          notify();
        });
    }

    function closeBringDialog() {
      state.bring.open = false;
      state.bring.busy = false;
      state.bring.error = '';
      state.bring.notice = '';
      notify();
    }

    // 只插入草稿、不发送：用 captureInsertion + insertText 在光标处插入，
    // 避免 setDraft 整段替换覆盖用户已有内容。
    // 依据（research/extract/conversation-client.js）：
    //   - setDraft 会 root.clear() 后重写整段草稿（:14667-14688，注释 "Replace the whole draft"）；
    //   - insertText 带草稿版本守卫：span.draftRev 与当前 rev 不一致、或输入框正在提交/裁定/已销毁时
    //     返回 false（:14912-14921），因此用户改动过草稿时不会强行插入。
    // 返回 'ok' | 'no-session'（桥/会话不可用）| 'failed'（插入被拒绝）。
    function fillWorkDraft(text) {
      const actions = composerBridge.mounted ? composerBridge.actions : null;
      if (!actions || typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') {
        return 'no-session';
      }
      try {
        const span = actions.captureInsertion();
        if (!span) return 'failed';
        const applied = actions.insertText(text, span);
        return applied === false ? 'failed' : 'ok';
      } catch {
        return 'failed';
      }
    }

    // 待带入草稿：只更新 UI 展示信息（字数/是否截断），正文仍在内存变量里。
    function refreshPendingBringState() {
      state.bring.pending = pendingBring
        ? { chars: pendingBring.chars, truncated: pendingBring.truncated }
        : null;
      notify();
    }

    // 清除待带入草稿（填入成功 / 取消 / 切回聊天模式 / 超时共用）；幂等，不写存储。
    function clearPendingBring() {
      if (pendingBringTimer) {
        clearTimeout(pendingBringTimer);
        pendingBringTimer = null;
      }
      if (pendingFillTimer) {
        clearTimeout(pendingFillTimer);
        pendingFillTimer = null;
      }
      state.bring.filling = false;
      if (!pendingBring) return;
      pendingBring = null;
      refreshPendingBringState();
    }

    // 暂存待带入草稿（新的覆盖旧的）；10 分钟后一次性定时器自动清除。
    // originSessionId 是点击「带入工作」时的当前会话（拿不到时为 null，表示带入时尚无会话）。
    function setPendingBring(composed, chars, truncated, originSessionId) {
      pendingBringSeq += 1;
      if (pendingFillTimer) {
        clearTimeout(pendingFillTimer);
        pendingFillTimer = null;
      }
      state.bring.filling = false;
      pendingBring = {
        id: pendingBringSeq,
        composed,
        chars,
        truncated,
        originSessionId: typeof originSessionId === 'string' && originSessionId ? originSessionId : null,
      };
      if (pendingBringTimer) {
        clearTimeout(pendingBringTimer);
        pendingBringTimer = null;
      }
      pendingBringTimer = setTimeout(() => {
        pendingBringTimer = null;
        if (!pendingBring) return;
        pendingBring = null;
        state.bring.pending = null;
        record('가져온 초안이 만료되어 지웠습니다'); // 只记录固定文字，不记录正文
      }, PENDING_BRING_TTL_MS);
      refreshPendingBringState();
    }

    // 提示条按钮「填入当前会话」：任何状态都可点（不再按「有没有会话」置灰）。
    //   - 桥接组件当前已挂载（有可用的会话输入框）：在光标处插入，不新建会话；
    //   - 桥接组件未挂载（新会话窗口 / 空白窗口）：调用 ctx.uiWorkspace.startSession(undefined)
    //     新建并打开一个空白会话，然后由 ComposerBridge 在新会话挂载后按自动填入规则填入一次。
    //     点击后按钮临时禁用（filling）直到填入完成或失败，防止连点。
    //   - startSession 不可用、同步抛错或 5 秒内没有等到会话：显示固定文案并保留草稿。
    // 只传无参数 startSession：不使用 prompt/其它 options，不会发送消息、不会启动 Agent。
    // 依据：research/extract/current/workspace-client.js:1500-1528（options 为空时 initializeDraft=false；
    // target 取「当前工作区 → 最近工作区」，没有工作区时 clearMain 回到新会话窗口）、
    // :1477-1491 openWorkspaceSession 只做 connectBlank + replaceMain（不发送、不启动 Agent）。
    function fillPendingFromBar() {
      if (!pendingBring || state.bring.filling) return;
      const pending = pendingBring;
      if (composerBridge.mounted && composerBridge.actions) {
        const result = fillWorkDraft(pending.composed);
        if (result === 'ok') {
          clearPendingBring();
          record('가져온 초안을 채웠습니다(' + pending.chars + '자, 전송 안 함)');
          showBringToast('채웠습니다(' + pending.chars + '자, 전송 안 함)');
          return;
        }
        if (result === 'failed') {
          showBringToast('채우지 못했습니다. 입력창이 준비된 뒤 다시 눌러 주세요(기존 초안은 덮지 않습니다)');
          return;
        }
        // 'no-session'：挂载状态刚好失效，改走新建空白会话路径
      }
      startSessionForPendingBring();
    }

    // 无挂载会话时：让 DSH 新建并打开一个空白会话（不传任何 options、不用 prompt），
    // 随后由 ComposerBridge 判定「来源是新会话窗口」时自动填入一次。
    // 服务通过 ctx.get('uiWorkspace') 惰性获取（该服务由官方 ui-workspace 包提供，
    // 第三方插件同样可用；参考 dsh-better-sidebar lib/client.js:18264-18265 的用法）。
    function startSessionForPendingBring() {
      let uiWorkspace = null;
      try {
        uiWorkspace = appCtx ? appCtx.get('uiWorkspace') : null;
      } catch {
        uiWorkspace = null;
      }
      if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
        showBringToast(BRING_NO_TARGET_TEXT);
        return;
      }
      state.bring.filling = true;
      notify();
      try {
        uiWorkspace.startSession(); // undefined：不传 options，不用 prompt，不发送消息
      } catch {
        state.bring.filling = false;
        notify();
        showBringToast(BRING_NO_TARGET_TEXT);
        return;
      }
      if (pendingFillTimer) clearTimeout(pendingFillTimer);
      pendingFillTimer = setTimeout(() => {
        pendingFillTimer = null;
        if (!state.bring.filling) return;
        state.bring.filling = false;
        notify();
        if (pendingBring) showBringToast(BRING_NO_TARGET_TEXT);
      }, 5000);
    }

    // 提示条按钮「取消」：立即丢弃内存中的待带入草稿。
    function cancelPendingBring() {
      if (!pendingBring) return;
      clearPendingBring();
      record('가져온 초안을 취소했습니다');
    }

    function submitBring() {
      if (state.bring.busy) return;
      const text = typeof state.bring.text === 'string' ? state.bring.text.trim() : '';
      if (!text) {
        state.bring.error = '내용이 비어 있습니다. 먼저 입력하거나, 채팅 페이지에서 텍스트를 선택해 복사한 뒤 붙여넣으세요';
        notify();
        return;
      }
      state.bring.busy = true;
      state.bring.error = '';
      notify();
      // 先切到工作模式，让输入框可见（切换只是 display 变化，不会重载任何页面）
      if (state.mode !== 'work') switchMode('work');
      // 给 React 一次提交/挂载的时机，再尝试填入
      setTimeout(() => {
        const result = fillWorkDraft(text);
        state.bring.busy = false;
        if (result === 'ok') {
          record('작업 모드 입력창에 내용을 채웠습니다(전송 안 함)');
          closeBringDialog();
          return;
        }
        state.bring.error =
          result === 'no-session'
            ? '작업 모드에 열린 세션이 없습니다. “작업”에서 세션을 새로 만들거나 연 뒤 “작업으로 가져오기”를 다시 눌러 주세요.'
            : '채우지 못했습니다. 입력창을 잠시 쓸 수 없습니다. 다시 시도하거나 직접 붙여넣어 주세요.';
        notify();
      }, 120);
    }

    // 一键带入的短暂提示（只显示固定文字；6 秒后自动消失）
    function showBringToast(text) {
      if (toastTimer) clearTimeout(toastTimer);
      state.bring.toast = typeof text === 'string' ? text : '';
      notify();
      toastTimer = setTimeout(() => {
        toastTimer = null;
        state.bring.toast = '';
        notify();
      }, 6000);
    }

    // 一键带入：用户点击「带入工作」时调用。
    // 只在官方 origin（完全相等）的 webview 上、由用户点击触发执行固定脚本；
    // 读到的选中文字只放内存，填入后立即丢弃，不写存储、不打印内容。
    function startBringFromSelection() {
      if (state.bring.busy) return;
      const view = element;
      let currentUrl = '';
      try {
        currentUrl = view && typeof view.getURL === 'function' ? view.getURL() : '';
      } catch {
        currentUrl = '';
      }
      if (!view || typeof view.executeJavaScript !== 'function' || !isChatOrigin(currentUrl)) {
        openBringDialog(
          '지금 사용할 수 있는 공식 채팅 페이지가 없습니다(또는 webview 가 아직 없습니다). 선택한 텍스트를 읽지 않았으니 아래 입력란에 직접 붙여넣어 주세요.',
        );
        return;
      }
      state.bring.busy = true;
      notify();
      Promise.resolve()
        .then(() => view.executeJavaScript(SCRIPT_READ_SELECTION))
        .then((raw) => {
          state.bring.busy = false;
          const selection = typeof raw === 'string' ? raw : '';
          if (!selection.trim()) {
            openBringDialog(
              '선택한 텍스트를 읽지 못했습니다. 웹페이지에서 텍스트를 먼저 선택한 뒤 “작업으로 가져오기”를 눌러 주세요. 아래 입력란에 직접 붙여넣어도 됩니다.',
            );
            return;
          }
          let text = selection;
          let truncated = false;
          if (text.length > BRING_SELECTION_MAX_CHARS) {
            text = text.slice(0, BRING_SELECTION_MAX_CHARS);
            truncated = true;
          }
          const template =
            typeof prefs.bringTemplate === 'string' ? prefs.bringTemplate : DEFAULT_BRING_TEMPLATE;
          deliverBringText(template + text, text.length, truncated);
        })
        .catch(() => {
          state.bring.busy = false;
          openBringDialog('선택한 텍스트를 읽지 못했습니다. 아래 입력란에 직접 붙여넣어 주세요.');
        });
    }

    // 每次「带入工作」都只把「模板 + 选中文字」放入内存待带入草稿，并切到工作模式显示提示条；
    // 不再立即插入当前会话。正文只在内存里，日志只记录固定文字与字数。
    function deliverBringText(composed, chars, truncated) {
      // 带入时的来源会话：只看桥接组件当前是否真的挂载（不要用可能过期的「最近一次会话」）。
      // mounted=true 表示带入发生在已有会话里；mounted=false 表示发生在「新会话窗口」，
      // 此时 originSessionId 记 null，之后在任意会话桥接挂载都算「选定」，允许自动填入。
      const originSessionId =
        composerBridge.mounted && composerBridge.sessionId ? composerBridge.sessionId : null;
      if (state.mode !== 'work') switchMode('work');
      setPendingBring(composed, chars, truncated, originSessionId);
      state.bring.busy = false;
      record('선택한 텍스트를 가져왔습니다(' + chars + '자, 세션 선택 대기)');
      if (state.bring.open) closeBringDialog();
      if (truncated) {
        showBringToast(
          '선택한 텍스트가 ' +
            BRING_SELECTION_MAX_CHARS +
            '자를 넘어 ' +
            BRING_SELECTION_MAX_CHARS +
            '자로 잘렸습니다',
        );
      }
      notify();
    }

    // conversation.input.left 的桥接组件（session 作用域；hero 与 composer 两种输入条都会渲染，
    // 因此空白会话的新会话窗口也能挂上桥、拿到 inputActions + sessionId）。
    // 把「当前是否挂载」「当前会话 id」「inputActions」存到模块变量；绝不调用 submit。
    // 待带入草稿的自动填入规则：
    //   - 带入时已有会话（originSessionId 非空）：只有切到另一个/新建会话才自动填入一次；
    //   - 带入时在新会话窗口（originSessionId 为 null）：之后在任意会话挂载都算「选定」，自动填入一次；
    //   - 每个 pending 只自动尝试一次（模块级 pendingAutoAttemptedId，模式来回切换/重新挂载都不会重复）；
    //   - 失败不清除草稿，留给提示条手动重试；正文始终只在内存里。
    function ComposerBridge(props) {
      const actions = (props && props.inputActions) || null;
      const sessionId = (props && props.sessionId) || null;
      React.useEffect(() => {
        composerBridge = { mounted: true, sessionId, actions };
        notify();
        const pending = pendingBring;
        if (pending && sessionId && actions && pendingAutoAttemptedId !== pending.id) {
          const fromNewSessionWindow = pending.originSessionId === null;
          const switchedToAnotherSession =
            pending.originSessionId !== null && sessionId !== pending.originSessionId;
          if (fromNewSessionWindow || switchedToAnotherSession) {
            pendingAutoAttemptedId = pending.id; // 每个 pending 只自动尝试一次
            const result = fillWorkDraft(pending.composed);
            if (result === 'ok') {
              clearPendingBring();
              record('가져온 초안을 자동으로 채웠습니다(' + pending.chars + '자, 전송 안 함)');
              showBringToast('채웠습니다(' + pending.chars + '자, 전송 안 함)');
            } else {
              record('가져온 초안 자동 입력이 끝나지 않았습니다. 직접 다시 시도해 주세요');
            }
          }
        }
        return () => {
          if (composerBridge.mounted && composerBridge.sessionId === sessionId) {
            composerBridge = { mounted: false, sessionId: null, actions: null };
          }
        };
      }, [actions, sessionId]);
      return null;
    }

    function refreshGeometry() {
      const layer = hostContainer
        ? hostContainer.closest('[data-chat-layer]')
        : null;
      const rect = layer ? layer.getBoundingClientRect() : null;
      let clearance = '';
      try {
        clearance = getComputedStyle(document.documentElement)
          .getPropertyValue('--dsh-frame-top-clearance')
          .trim();
      } catch {
        clearance = '';
      }
      state.geometry = {
        layer: rect
          ? {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            }
          : null,
        viewport: { w: globalThis.innerWidth, h: globalThis.innerHeight },
        clearance: clearance || '(정의되지 않음)',
        chatVisible: state.mode === 'chat',
        chatWidth: element ? Math.round(element.getBoundingClientRect().width) : 0,
        chatHeight: element ? Math.round(element.getBoundingClientRect().height) : 0,
      };
      notify();
    }

    function startInspect() {
      if (state.mode !== 'chat') return;
      if (inspectTimer) clearTimeout(inspectTimer);
      state.inspecting = true;
      refreshGeometry();
      record('겹침 확인: 채팅 레이어를 3초 동안 반투명');
      inspectTimer = setTimeout(() => {
        inspectTimer = null;
        state.inspecting = false;
        notify();
      }, 3000);
    }

    // ------------------------------------------------------------------
    // webview 生命周期：acquire → 创建元素 → 挂事件 → 首次 dom-ready 后 loadURL
    // ------------------------------------------------------------------
    function releaseWebview() {
      if (inspectTimer) {
        clearTimeout(inspectTimer);
        inspectTimer = null;
      }
      if (detachOpenRequests) {
        detachOpenRequests();
        detachOpenRequests = null;
      }
      if (element) {
        try {
          if (element.parentNode) element.parentNode.removeChild(element);
        } catch {
          // 忽略清理异常
        }
        element = null;
      }
      if (bridge && lease) {
        try {
          Promise.resolve(bridge.release(lease.lease)).catch(() => {});
        } catch {
          // 忽略释放异常
        }
      }
      lease = null;
      bridge = null;
      loadIssued = false;
      // 新 webview 生命周期：允许再次尝试一次登录恢复（savedUserToken 保留在插件 localStorage）
      restoreAttempted = false;
      restoreReloaded = false;
      // 下一轮加载前先盖住，避免重建过程中露出登录页/空白页
      state.mask = true;
      if (maskTimer) {
        clearTimeout(maskTimer);
        maskTimer = null;
      }
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      state.bring.toast = '';
    }

    function retryWebview() {
      if (element) return;
      releaseWebview();
      state.phase = 'idle';
      state.bridge = 'unknown';
      state.error = '';
      state.lease = '-';
      state.partition = '-';
      notify();
      if (hostContainer) ensureWebview(hostContainer);
    }

    // ------------------------------------------------------------------
    // 登录恢复（自动保存，仅限 userToken 一项；默认开启，可关闭）
    // ------------------------------------------------------------------
    // 说明：token 视为不透明字符串，不打印、不记录、不上报；只写进插件自己的
    // localStorage 键 LOGIN_KEY（明文，设置页有风险提示），只写回官方站点页面的
    // localStorage.userToken，不读 cookie / IndexedDB / 页面 DOM。
    // 脚本结构固定，token 只经 JSON.stringify 写进数据位（不是可执行代码拼接）。
    function writeTokenScript(token) {
      return (
        SCRIPT_WRITE_USER_TOKEN_PREFIX + JSON.stringify(token) + SCRIPT_WRITE_USER_TOKEN_SUFFIX
      );
    }

    function clearMask() {
      if (maskTimer) {
        clearTimeout(maskTimer);
        maskTimer = null;
      }
      if (state.mask) {
        state.mask = false;
        notify();
      }
    }

    // 清除已保存副本（token 无效/用户主动退出时调用），静默、不显示 token 值。
    function dropSavedLogin(reason) {
      clearLoginStore();
      savedUserToken = null;
      savedTokenAt = 0;
      state.login.saved = false;
      state.login.savedLength = 0;
      state.login.savedAt = 0;
      state.login.status = 'still-login';
      state.login.error = '';
      loginConfirmedThisRun = false;
      clearMask();
      record('저장된 로그인 사본을 삭제했습니다' + (reason ? '(' + reason + ')' : ''));
      notify();
    }

    // 仅在「webview 首次加载到聊天站点」后尝试一次恢复，不重试、不循环。
    function maybeRestoreLogin(view) {
      if (!view || restoreAttempted) return;
      if (!prefs.rememberLogin) return; // 开关关闭：不恢复
      if (loggedOutThisRun) return; // 本次运行已检测到主动退出：不再自动恢复
      if (!isOfficialChatSite()) return; // 自定义地址：不碰官方站点的登录令牌
      if (typeof view.executeJavaScript !== 'function') return;
      if (!savedUserToken) return;
      const currentUrl = typeof view.getURL === 'function' ? view.getURL() : '';
      if (!isChatOrigin(currentUrl)) return;
      restoreAttempted = true;
      state.login.status = 'restoring';
      state.mask = true; // 恢复期间保持遮罩，消除登录页闪烁
      record('로그인 복원: 저장된 token 을 찾아 되돌려 쓰기를 시도합니다');
      notify();
      Promise.resolve()
        .then(() => view.executeJavaScript(writeTokenScript(savedUserToken)))
        .then((ok) => {
          if (ok !== true) {
            dropSavedLogin('되돌려 쓰기가 적용되지 않음');
            return;
          }
          restoreReloaded = true;
          record('로그인 복원: 되돌려 쓰기 완료, 한 번 다시 로드');
          try {
            view.reload();
          } catch {
            restoreReloaded = false;
            dropSavedLogin('다시 로드 실패');
          }
        })
        .catch(() => {
          // 静默：不显示错误细节、不影响其它功能
          dropSavedLogin('실행 실패');
        });
    }

    // 开关开启时，在页面加载完成、主框架站内跳转和开启开关时自动保存。
    // 只读官方聊天页的 userToken；令牌未变化时不重复写入，不轮询。
    function autoSaveLogin(view) {
      if (!prefs.rememberLogin || !view || state.login.status === 'restoring') return;
      if (!isOfficialChatSite() || typeof view.executeJavaScript !== 'function') return;
      const currentUrl = typeof view.getURL === 'function' ? view.getURL() : '';
      if (!isChatOrigin(currentUrl) || isSignInPathname(currentUrl)) return;
      Promise.resolve()
        .then(() => view.executeJavaScript(SCRIPT_READ_USER_TOKEN))
        .then((token) => {
          // 读取可能等待页面加载：期间关闭开关或退出登录后，不再保存。
          if (!prefs.rememberLogin) return;
          const url = typeof view.getURL === 'function' ? view.getURL() : '';
          if (!isChatOrigin(url) || isSignInPathname(url)) return;
          if (typeof token !== 'string' || token.length === 0) return;
          loginConfirmedThisRun = true;
          loggedOutThisRun = false;
          restoreAttempted = true; // 本次已经登录，后续导航不再注入旧副本或重载。
          if (token === savedUserToken) return;
          const savedAt = writeLoginStore(token);
          if (savedAt <= 0) return;
          savedUserToken = token;
          savedTokenAt = savedAt;
          state.login.saved = true;
          state.login.savedLength = token.length;
          state.login.savedAt = savedAt;
          if (state.login.status !== 'restored') state.login.status = 'saved';
          state.login.error = '';
          record('로그인 정보를 자동 저장했습니다(길이 ' + token.length + ')');
          notify();
        })
        .catch(() => {
          // 自动保存失败保持静默，保留已有副本，后续正常导航时再检查。
        });
    }

    // 恢复写回并 reload 后，只读 location.pathname 判断是否仍在登录页。
    function checkLoginPageResult(view) {
      if (!view) return;
      if (!restoreReloaded) {
        // 恢复进行中（写回还没完成）：保持遮罩，不做判断
        if (state.login.status === 'restoring') return;
        // 非恢复流程的普通加载完成：撤掉遮罩
        clearMask();
        return;
      }
      restoreReloaded = false;
      if (typeof view.executeJavaScript !== 'function') {
        dropSavedLogin('페이지 사용 불가');
        return;
      }
      Promise.resolve()
        .then(() => view.executeJavaScript(SCRIPT_READ_PATHNAME))
        .then((pathname) => {
          const stillLogin = typeof pathname === 'string' && pathname.indexOf('/sign_in') === 0;
          if (stillLogin) {
            state.login.status = 'still-login';
            dropSavedLogin('복원 후에도 로그인 화면');
            return;
          }
          state.login.status = 'restored';
          loginConfirmedThisRun = true; // 本次运行内确认已登录 → 之后才启用退出检测
          clearMask();
          record('로그인 복원: 완료');
          notify();
          // 恢复成功后刷新已保存副本（token 可能被站点轮换）
          autoSaveLogin(view);
        })
        .catch(() => {
          dropSavedLogin('경로 확인 실패');
        });
    }

    // 「保存登录」：只在用户点击时执行；只读 localStorage.userToken 一项。
    function saveLogin() {
      if (!prefs.rememberLogin) {
        state.login.status = 'error';
        state.login.error = '먼저 “설정 → 채팅 모드”에서 “로그인 기억”을 켜 주세요';
        record('로그인 저장: 설정이 꺼져 있어 거부');
        notify();
        return;
      }
      if (!element || typeof element.executeJavaScript !== 'function') {
        state.login.status = 'error';
        state.login.error = 'webview 가 아직 없거나 사용할 수 없습니다';
        record('로그인 저장: webview 사용 불가');
        notify();
        return;
      }
      const currentUrl = typeof element.getURL === 'function' ? element.getURL() : '';
      if (!isChatOrigin(currentUrl)) {
        state.login.status = 'error';
        state.login.error = '현재 chat.deepseek.com 이 아니므로 저장을 거부했습니다';
        record('로그인 저장: origin 불일치로 거부');
        notify();
        return;
      }
      record('로그인 저장: userToken 읽기(한 항목만)');
      Promise.resolve()
        .then(() => element.executeJavaScript(SCRIPT_READ_USER_TOKEN))
        .then((token) => {
          if (!prefs.rememberLogin) return;
          if (typeof token !== 'string' || token.length === 0) {
            state.login.status = 'error';
            state.login.error = '페이지에서 읽을 수 있는 userToken 이 없습니다(아직 로그인하지 않았을 수 있습니다)';
            record('로그인 저장: userToken 을 찾지 못함');
            notify();
            return;
          }
          const savedAt = writeLoginStore(token);
          if (savedAt <= 0) {
            state.login.status = 'error';
            state.login.error = '로컬 저장 실패';
            record('로그인 저장: 로컬 저장 실패');
            notify();
            return;
          }
          savedUserToken = token;
          savedTokenAt = savedAt;
          state.login.saved = true;
          state.login.savedLength = token.length;
          state.login.savedAt = savedAt;
          state.login.status = 'saved';
          state.login.error = '';
          loginConfirmedThisRun = true;
          loggedOutThisRun = false;
          restoreAttempted = true;
          record('로그인 정보를 저장했습니다(길이 ' + token.length + ')');
          notify();
        })
        .catch(() => {
          state.login.status = 'error';
          state.login.error = '읽기 실패(세부 내용은 기록하지 않음)';
          record('로그인 저장: 읽기 실패(조용히 처리)');
          notify();
        });
    }

    // 清除时同时关闭自动保存，避免仍登录的页面在下一次导航时把副本存回。
    function clearSavedLogin() {
      savePrefs({ rememberLogin: false });
      clearLoginStore();
      loginConfirmedThisRun = false;
      loggedOutThisRun = true;
      savedUserToken = null;
      savedTokenAt = 0;
      restoreAttempted = false;
      restoreReloaded = false;
      state.login.saved = false;
      state.login.savedLength = 0;
      state.login.savedAt = 0;
      state.login.status = 'cleared';
      state.login.error = '';
      record('저장된 로그인 정보를 삭제했습니다');
      notify();
    }

    function ensureWebview(container) {
      if (!container) return;
      hostContainer = container;
      if (element) {
        if (element.parentNode !== container) container.appendChild(element);
        return;
      }
      if (state.phase !== 'idle') return;

      const carrier = globalThis.dshDesktop;
      const browser =
        carrier && carrier.protocolVersion === 1 && carrier.browser
          ? carrier.browser
          : undefined;
      if (!browser) {
        state.bridge = 'missing';
        state.phase = 'no-bridge';
        state.error = '현재 환경에 dshDesktop.browser 가 없습니다(데스크톱 메인 창이 아님). webview 를 만들 수 없습니다.';
        notify();
        return;
      }

      state.bridge = 'ok';
      state.phase = 'acquiring';
      notify();

      Promise.resolve()
        .then(() => browser.acquire(LEASE_WORKSPACE))
        .then((reservation) => {
          if (
            !reservation ||
            typeof reservation.lease !== 'string' ||
            typeof reservation.partition !== 'string'
          ) {
            throw new Error('acquire 반환값이 올바르지 않습니다');
          }
          lease = { lease: reservation.lease, partition: reservation.partition };
          state.lease = reservation.lease;
          state.partition = reservation.partition;
          state.phase = 'created';
          record('acquire 성공');

          const view = document.createElement('webview');
          // about:blank#<lease> 是主进程 will-attach-webview 放行的握手条件
          view.setAttribute('name', reservation.lease);
          view.setAttribute('partition', reservation.partition);
          view.setAttribute('src', 'about:blank#' + reservation.lease);
          view.setAttribute('data-sidebar-browser-frame', 'webview');
          view.className = 'dsh-chat-mode-frame';
          view.setAttribute(
            'style',
            'display:flex;width:100%;height:100%;border:0;' +
              'background:var(--dsw-alias-bg-base,#fff);',
          );

          // —— 只监听事件与计数；不读页面内容、不注入脚本（登录恢复除外） ——
          view.addEventListener('did-start-loading', () => {
            state.counters.start += 1;
            record('did-start-loading');
          });
          view.addEventListener('did-stop-loading', () => {
            state.counters.stop += 1;
            if (loadIssued && state.phase !== 'failed') state.phase = 'ready';
            record('did-stop-loading');
            // 恢复写回后 reload 完成时只读 pathname 判断结果；恢复进行中继续保持遮罩
            checkLoginPageResult(view);
            autoSaveLogin(view);
          });
          view.addEventListener('did-navigate', (event) => {
            state.counters.navigate += 1;
            // webview 的 did-navigate 只代表主框架导航，不再区分子框架
            record('did-navigate(이동)');
            const target = event && typeof event.url === 'string' ? event.url : '';
            // 运行中检测到用户主动退出（进入 /sign_in）：清除已保存副本，本次运行不再自动恢复。
            // 仅当本次运行已确认登录后才生效（见 handleSignInNavigation），避免登录页先闪一下时误清副本。
            if (handleSignInNavigation(target)) return;
            // 首次导航到聊天站点后，若存在已保存 token 且开关开启则尝试恢复一次。
            // 注意：这里是登录恢复的触发点（spike 时期在另一处，后改为 did-navigate）；
            // 若恢复没有发生，这是第一个排查点（确认 did-navigate 是否到达、url 是否已是 chat 域）。
            maybeRestoreLogin(view);
          });
          // SPA 登录 / 退出不会触发 did-navigate；主框架跳转时检测退出或自动保存。
          view.addEventListener('did-navigate-in-page', (event) => {
            if (!event || event.isMainFrame !== true) return;
            state.counters.navigateInPage += 1;
            record('did-navigate-in-page(페이지 내부 이동)');
            if (!handleSignInNavigation(typeof event.url === 'string' ? event.url : '')) {
              autoSaveLogin(view);
            }
          });
          view.addEventListener('did-fail-load', (event) => {
            const code = event && typeof event.errorCode === 'number' ? event.errorCode : 0;
            if (code === -3) return; // ERR_ABORTED：用户主动中断，不算失败
            state.counters.fail += 1;
            state.phase = 'failed';
            state.error = 'did-fail-load errorCode=' + code;
            record('did-fail-load', 'errorCode=' + code);
            clearMask();
          });
          view.addEventListener('dom-ready', () => {
            state.counters.domReady += 1;
            if (!loadIssued) {
              loadIssued = true;
              state.phase = 'loading';
              record('dom-ready → loadURL 시작');
              try {
                Promise.resolve(view.loadURL(currentChatUrl())).catch((error) => {
                  state.phase = 'failed';
                  state.error = firstLine(error);
                  record('loadURL 실패');
                  clearMask();
                });
              } catch (error) {
                state.phase = 'failed';
                state.error = firstLine(error);
                record('loadURL 예외 발생');
                clearMask();
              }
            } else {
              // webview 的 dom-ready 事件在每次新 document 就绪时触发；
              // 正常情况下首次加载完成后不应再出现第二次（出现即说明发生了重载）。
              record('dom-ready(두 번째 이후)');
            }
          });
          view.addEventListener('render-process-gone', () => {
            state.counters.gone += 1;
            record('render-process-gone');
          });
          view.addEventListener('destroyed', () => {
            record('webview destroyed');
          });

          element = view;
          container.appendChild(view);
          // 출처 링크: 새 창 열기 요청 + 외부 사이트로의 이동을 시스템 브라우저로 넘긴다.
          if (detachOpenRequests) detachOpenRequests();
          detachOpenRequests = watchOpenRequests(view, reservation.lease);
          record('webview 연결됨');
          // 遮罩兜底：8 秒还没撤掉就强制撤掉，避免一直挡住界面
          if (maskTimer) clearTimeout(maskTimer);
          maskTimer = setTimeout(() => {
            maskTimer = null;
            if (state.mask) {
              state.mask = false;
              record('가림막 대기 시간이 지나 걷어냈습니다');
              notify();
            }
          }, 8000);
          notify();
        })
        .catch((error) => {
          state.phase = 'failed';
          state.bridge = state.bridge === 'unknown' ? 'missing' : state.bridge;
          state.error = firstLine(error);
          record('acquire / 생성 실패');
        });
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------
    function button(label, onClick, options) {
      const opts = options || {};
      const active = opts.active === true;
      const warn = opts.tone === 'warn';
      const disabled = opts.disabled === true;
      return h(
        'button',
        {
          type: 'button',
          title: opts.title || label,
          disabled,
          onClick: disabled ? undefined : onClick,
          style: {
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            padding: '3px 10px',
            borderRadius: 6,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            border: '1px solid ' + (active ? 'transparent' : BORDER_COLOR),
            background: active
              ? warn
                ? 'var(--dsw-alias-state-warning-strong, #d97706)'
                : 'var(--dsw-alias-brand-primary, #4d6bfe)'
              : 'transparent',
            color: active ? '#fff' : LABEL_COLOR,
            whiteSpace: 'nowrap',
          },
        },
        label,
      );
    }

    function checkbox(label, checked, onChange) {
      return h(
        'label',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            cursor: 'pointer',
            userSelect: 'none',
          },
        },
        h('input', {
          type: 'checkbox',
          checked,
          onChange: (event) => onChange(event.target.checked),
        }),
        label,
      );
    }

    // -webkit-app-region 不是标准 CSSStyleDeclaration 属性，用 ref 直接 setProperty 最稳。
    function noDrag(node) {
      if (!node) return;
      try {
        node.style.setProperty('-webkit-app-region', 'no-drag');
      } catch {
        // 老环境忽略
      }
    }

    function segmentButton(label, active, warn, title, onClick) {
      return h(
        'button',
        {
          type: 'button',
          title,
          onClick,
          ref: noDrag,
          style: {
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            height: 22,
            padding: '0 9px',
            borderRadius: 4,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            border: '1px solid ' + (active && !warn ? BORDER_COLOR : 'transparent'),
            background: active
              ? warn
                ? 'var(--dsw-alias-state-warning-strong, #d97706)'
                : 'var(--dsw-alias-bg-base, #fff)'
              : 'transparent',
            color: active && warn ? '#fff' : LABEL_COLOR,
            fontWeight: active ? 600 : 400,
            opacity: active ? 1 : 0.66,
          },
        },
        label,
      );
    }

    // 标题栏控件的动态左偏移：测量原生菜单宿主 [data-windows-menu] 的右边界，
    // 让整组控件跟随菜单移动（收起侧栏时菜单从 48px 移到 84px，「新建聊天」按钮出现）。
    // 不轮询：只在窗口尺寸变化、菜单自身尺寸变化、侧栏折叠状态变化时重新测量。
    // 测不到菜单（Web 环境 / preload 未注入）时回退到 TITLEBAR_LEFT_OFFSET。
    function useTitlebarLeftOffset() {
      const [left, setLeft] = React.useState(TITLEBAR_LEFT_OFFSET);
      React.useEffect(() => {
        let disposed = false;
        const timers = [];
        let menuNode = null;
        let menuObserver = null;
        let layoutObserver = null;
        let attributeObserver = null;

        const measure = () => {
          if (disposed) return;
          let next = TITLEBAR_LEFT_OFFSET;
          try {
            const menu = document.querySelector(WINDOWS_MENU_SELECTOR);
            if (menu) {
              const rect = menu.getBoundingClientRect();
              // width 为 0 说明菜单还没布局完成（或已隐藏），保留兜底值，等下一次测量。
              if (rect.width > 0 && rect.right > 0) next = Math.round(rect.right) + TITLEBAR_MENU_GAP;
            }
          } catch {
            // 保持兜底值
          }
          setLeft((current) => (current === next ? current : next));
        };

        // 直接同步测量：窗口被遮挡时浏览器会节流 requestAnimationFrame，
        // 而侧栏折叠会立刻改变菜单右边界，必须当场跟随，否则会出现短暂重叠。
        const schedule = () => {
          if (disposed) return;
          measure();
        };

        // 菜单宿主可能因窗口重建而更换节点；尺寸变化（菜单文字/语言）时重新测量右边界。
        const watchMenu = () => {
          const menu = document.querySelector(WINDOWS_MENU_SELECTOR);
          if (menu === menuNode) return;
          if (menuObserver) menuObserver.disconnect();
          menuObserver = null;
          menuNode = menu;
          if (!menu || typeof ResizeObserver !== 'function') return;
          menuObserver = new ResizeObserver(schedule);
          try {
            menuObserver.observe(menu);
          } catch {
            menuObserver = null;
          }
        };

        // 首次挂载时菜单可能还没注入：做几次有界补偿测量（首屏布局稳定后即可量到）。
        const settleTimers = [0, 120, 500].map((delay) =>
          setTimeout(() => {
            watchMenu();
            schedule();
          }, delay),
        );
        timers.push(...settleTimers);

        // 窗口尺寸变化（含最大化/还原、显示缩放变化）。
        window.addEventListener('resize', schedule);

        // 侧栏折叠状态变化时，原生菜单左边界会变（CSS :has 改 --dsh-windows-menu-start），
        // 而菜单自身宽度可能完全不变（ResizeObserver 捕获不到纯位置平移），所以必须监听属性。
        // 同理，受控隐藏开关（data-chat-mode-hide-toggle）会把菜单左移 12px，
        // 这里也监听它，保证属性切换后立刻重新测量、不会沿用旧位置。
        if (typeof MutationObserver === 'function') {
          attributeObserver = new MutationObserver(() => {
            watchMenu();
            schedule();
          });
          try {
            attributeObserver.observe(document.documentElement, {
              attributes: true,
              subtree: true,
              attributeFilter: ['data-sidebar-collapsed', DSH_SIDEBAR_HIDE_ATTR, 'data-windows-titlebar'],
            });
          } catch {
            attributeObserver = null;
          }
        }

        // 标题栏区域尺寸变化（布局列宽变化等）。
        if (typeof ResizeObserver === 'function' && document.documentElement) {
          layoutObserver = new ResizeObserver(schedule);
          try {
            layoutObserver.observe(document.documentElement);
          } catch {
            layoutObserver = null;
          }
        }

        watchMenu();
        schedule();

        return () => {
          disposed = true;
          for (const timer of timers) clearTimeout(timer);
          window.removeEventListener('resize', schedule);
          if (menuObserver) menuObserver.disconnect();
          if (attributeObserver) attributeObserver.disconnect();
          if (layoutObserver) layoutObserver.disconnect();
        };
      }, []);
      return left;
    }

    // ------------------------------------------------------------------
    // 受控隐藏 DSH 标题栏按钮（用属性开关 + 一条样式规则，仍占位、布局不变）
    // ------------------------------------------------------------------
    // 为什么不用遮罩：该按钮 z-index:30，在 overlay 层（z-index:20）之上，遮罩盖不住也挡不到点击；
    // 这里改为在聊天层可见时隐藏它。
    // 选择器只认 aria-label（中英）与 data-sidebar-collapsed，不使用自动生成的 class，不修改其它元素。
    let sidebarHideStyle = null;

    function applySidebarToggleHiding() {
      try {
        if (!HIDE_DSH_SIDEBAR_BUTTON) return;
        if (typeof document === 'undefined' || !document.documentElement) return;
        // 只在聊天模式、聊天层可见（webview 桥可用）时隐藏
        if (state.mode !== 'chat' || state.bridge !== 'ok') return;
        // 规则本身只匹配上述按钮，没有匹配对象时无副作用，因此不需要先 querySelector 探测。
        if (!sidebarHideStyle) {
          const style = document.createElement('style');
          style.setAttribute('data-chat-mode-style', 'hide-dsh-sidebar-toggle');
          style.textContent = DSH_SIDEBAR_HIDE_CSS;
          (document.head || document.documentElement).appendChild(style);
          sidebarHideStyle = style;
        }
        document.documentElement.setAttribute(DSH_SIDEBAR_HIDE_ATTR, '1');
      } catch {
        // 任何异常都按"撤销"处理，不影响插件其它功能
        clearSidebarToggleHiding();
      }
    }

    // 统一清理函数：移除 <html> 上的属性 + 删除注入的 <style>；幂等，可在任何时机调用。
    function clearSidebarToggleHiding() {
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          document.documentElement.removeAttribute(DSH_SIDEBAR_HIDE_ATTR);
        }
      } catch {
        // 忽略
      }
      try {
        if (sidebarHideStyle && sidebarHideStyle.parentNode) {
          sidebarHideStyle.parentNode.removeChild(sidebarHideStyle);
        }
      } catch {
        // 忽略
      }
      sidebarHideStyle = null;
    }

    // 无 UI 的同步组件：按「模式 / webview 桥 / 开关」启用或撤销受控隐藏。
    // 条件不满足（工作模式、聊天层不可见、开关关闭）时立即撤销；组件卸载时也撤销。
    // 插件被整体卸载时的兜底清理在 apply 的 ctx.effect 里。
    function SidebarToggleHider() {
      useSpike();
      const active = HIDE_DSH_SIDEBAR_BUTTON && state.mode === 'chat' && state.bridge === 'ok';
      React.useEffect(() => {
        if (active) applySidebarToggleHiding();
        else clearSidebarToggleHiding();
        return () => clearSidebarToggleHiding();
      }, [active]);
      return null;
    }

    // 标题栏控件：紧凑分段切换（聊天/工作）+ 很小的「诊断」开关。
    // 位置：动态跟随标题栏「编辑」菜单右侧（保留小间距），垂直居中；两种模式下都可见。
    function TitlebarControls() {
      useSpike();
      const menuLeft = useTitlebarLeftOffset();
      const chat = state.mode === 'chat';
      return h(
        'div',
        {
          ref: noDrag,
          style: {
            position: 'fixed',
            top: 'calc((var(--dsh-windows-titlebar-height, ' + TITLEBAR_HEIGHT_FALLBACK + 'px) - 26px) / 2)',
            left: menuLeft,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            zIndex: 45,
            pointerEvents: 'auto',
            fontFamily: 'inherit',
          },
        },
        h(
          'div',
          {
            ref: noDrag,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              height: 26,
              boxSizing: 'border-box',
              padding: 2,
              borderRadius: 6,
              border: '1px solid ' + BORDER_COLOR,
              background: 'transparent',
            },
          },
          segmentButton('채팅', chat, false, '채팅 모드', () => switchMode('chat')),
          segmentButton('작업', !chat, true, '작업 모드는 토큰을 사용합니다', () => switchMode('work')),
        ),
        h(
          'button',
          {
            type: 'button',
            ref: noDrag,
            title: state.diagOpen ? '진단 패널 숨기기' : '진단 패널 표시',
            onClick: toggleDiag,
            style: {
              font: 'inherit',
              fontSize: 11,
              lineHeight: '16px',
              height: 22,
              padding: '0 7px',
              borderRadius: 4,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              border: '1px solid ' + BORDER_COLOR,
              background: 'transparent',
              color: LABEL_COLOR,
              opacity: state.diagOpen ? 1 : 0.72,
            },
          },
          '진단',
        ),
        // 「带入工作模式」：只在聊天模式显示（把剪贴板/选中文字经确认后填入工作输入框）
        chat
          ? h(
              'button',
              {
                type: 'button',
                ref: noDrag,
                title: '웹페이지에서 선택한 텍스트(템플릿 추가)를 작업 모드 입력창에 넣습니다(입력만, 자동 전송 안 함)',
                onClick: startBringFromSelection,
                style: {
                  font: 'inherit',
                  fontSize: 11,
                  lineHeight: '16px',
                  height: 22,
                  padding: '0 7px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  border: '1px solid ' + BORDER_COLOR,
                  background: 'transparent',
                  color: LABEL_COLOR,
                  opacity: 0.85,
                },
              },
              '작업으로 가져오기',
            )
          : null,
      );
    }

    function DiagnosticsPanel() {
      useSpike();
      const panelRef = React.useRef(null);
      const [probeText, setProbeText] = React.useState('(패널을 열면 읽습니다)');
      const probeNames = [
        '--dsw-alias-bg-base',
        '--dsw-alias-bg-raised',
        '--dsw-alias-label-primary',
        '--dsw-alias-border',
        '--dsw-alias-state-warning-strong',
      ];
      // 主题变量探测：读取**插件自己容器元素**的 getComputedStyle（只用于显示，不做样式判断）。
      React.useEffect(() => {
        if (!state.diagOpen || !panelRef.current) return;
        try {
          const computed = getComputedStyle(panelRef.current);
          setProbeText(
            probeNames
              .map((name) => name + '=' + (computed.getPropertyValue(name).trim() || '(비어 있음)'))
              .join('  '),
          );
        } catch {
          setProbeText('(읽기 실패)');
        }
      }, [state.diagOpen]);
      // 默认隐藏：只由标题栏「诊断」开关切换显示/隐藏
      if (!state.diagOpen) return null;
      const rows = [];

      rows.push('테마 변수(패널 컨테이너 getComputedStyle): ' + probeText);

      rows.push('모드: ' + (state.mode === 'chat' ? '채팅(API 호출 안 함)' : '작업(토큰 사용)'));
      rows.push(
        '브리지: ' +
          (state.bridge === 'ok'
            ? '사용 가능 (protocolVersion=1)'
            : state.bridge === 'missing'
              ? '사용 불가(dshDesktop.browser 없음)'
              : '미검사'),
      );
      rows.push(
        '단계: ' +
          state.phase +
          (state.error ? '  오류: ' + state.error : ''),
      );
      rows.push('lease: ' + state.lease + '   partition: ' + state.partition);
      rows.push('대상 주소: ' + currentChatUrl() + '(최초 dom-ready 이후 loadURL 한 번만)');
      rows.push(
        '설정: 기본=' +
          prefs.defaultMode +
          ' | 마지막 기억=' +
          (prefs.rememberLast ? '켬' : '끔') +
          ' | 로그인 기억=' +
          (prefs.rememberLogin ? '켬' : '끔') +
          ' | 마지막=' +
          prefs.lastMode,
      );
      rows.push(
        '카운터: dom-ready ' +
          state.counters.domReady +
          ' | start ' +
          state.counters.start +
          ' | stop ' +
          state.counters.stop +
          ' | 이동 ' +
          state.counters.navigate +
          ' | 실패 ' +
          state.counters.fail +
          ' | 크래시 ' +
          state.counters.gone,
      );
      // 登录恢复状态：只显示"是否保存/长度/结果"，不显示 token 值本身
      {
        const statusLabels = {
          idle: state.login.saved ? '저장됨(길이 ' + state.login.savedLength + ')' : '저장 안 됨',
          saved: '저장됨(길이 ' + state.login.savedLength + ')',
          cleared: '삭제됨',
          restoring: '복원 중',
          restored: '복원됨',
          'still-login': '아직 로그인 화면',
          error: '작업 미완료' + (state.login.error ? ': ' + state.login.error : ''),
        };
        rows.push('로그인 복원: ' + (statusLabels[state.login.status] || state.login.status));
      }
      rows.push(
        '최근 이벤트:\n' +
          (state.events.length
            ? state.events.map((item) => '  ' + item.at + '  ' + item.label).join('\n')
            : '  (없음)'),
      );
      if (state.geometry) {
        const g = state.geometry;
        rows.push(
          '레이아웃: layer=' +
            (g.layer
              ? g.layer.x + ',' + g.layer.y + ' ' + g.layer.w + 'x' + g.layer.h
              : 'n/a') +
            ' | viewport=' +
            g.viewport.w +
            'x' +
            g.viewport.h +
            ' | --dsh-frame-top-clearance=' +
            g.clearance +
            ' | chat=' +
            g.chatWidth +
            'x' +
            g.chatHeight,
        );
      }

      return h(
        'div',
        {
          ref: panelRef,
          style: {
            position: 'fixed',
            top: 'calc(var(--dsh-windows-titlebar-height, ' + TITLEBAR_HEIGHT_FALLBACK + 'px) + 8px)',
            right: 16,
            zIndex: 40,
            pointerEvents: 'auto',
            // 宽度自适应视口，避免窄窗口被横向裁切
            width: 'min(560px, calc(100vw - 32px))',
            boxSizing: 'border-box',
            maxHeight: '60vh',
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '8px 10px',
            borderRadius: 10,
            // 颜色用深浅主题都读得清的备用色；变量存在时会覆盖（仅视觉，不参与逻辑）
            background: 'var(--dsw-alias-bg-base, #fff)',
            border: '1px solid ' + BORDER_COLOR,
            boxShadow: '0 8px 24px rgba(0,0,0,.18)',
            color: LABEL_COLOR,
            fontFamily: 'ui-monospace, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.55,
            userSelect: 'text',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 6,
              rowGap: 6,
              marginBottom: 6,
            },
          },
          h('strong', { style: { fontSize: 12, marginRight: 4 } }, '진단'),
          button('겹침 확인(3초)', startInspect),
          button('레이아웃 새로고침', refreshGeometry),
          button('카운터 초기화', resetCounters),
          state.phase === 'failed' ? button('다시 생성', retryWebview) : null,
          button('채팅으로 초기화', () => switchMode('chat')),
        ),
        // 登录恢复：自动保存之外，仍提供立即保存与关闭并清除入口。
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 6,
              rowGap: 6,
              marginBottom: 6,
            },
          },
          h('span', { style: { opacity: 0.8 } }, '로그인 복원: '),
          button('지금 로그인 저장', saveLogin),
          state.login.saved ? button('로그인 끄고 삭제', clearSavedLogin) : null,
        ),
        h(
          'div',
          null,
          h(
            'pre',
            {
              style: {
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'inherit',
              },
            },
            rows.join('\n'),
          ),
          h(
            'div',
            {
              style: {
                marginTop: 6,
                opacity: 0.85,
                borderTop: '1px dashed ' + BORDER_COLOR,
                paddingTop: 6,
              },
            },
            '유지 판단: “작업”으로 전환했다가 “채팅”으로 돌아온 뒤 최초 로딩이 끝나도 카운터가 그대로여야 합니다(보통 2: about:blank 자리 + 대상 페이지). start 카운터는 늘지 않습니다.' +
              '페이지에 입력해 둔 텍스트는 그대로 있어야 합니다(눈으로 확인하세요. 이 플러그인은 페이지 내용을 읽지 않습니다).\n' +
              '겹침 판단: “겹침 확인(3초)”를 누르면 채팅 레이어가 반투명해집니다. 사이드바/제목 표시줄/입력창이 보이면 덮이지 않은 것입니다.' +
              '보이지 않으면 덮인 것이며, 이것이 채팅 모드가 원하는 결과입니다.\n' +
              '네트워크 선언: 이 플러그인 코드에는 fetch / XHR / WebSocket / sendBeacon / window.open 이 없습니다.' +
              'executeJavaScript 는 로그인 복원(고정 스크립트, token 은 데이터로만 전달)과 “작업으로 가져오기”' +
              'window.getSelection().toString() 만 읽습니다(사용자가 클릭했고 origin 이 공식 사이트와 완전히 같을 때 고정 스크립트로 실행).\n' +
              '저장 선언: 플러그인 자신의 localStorage 두 키에만 씁니다 — dsh-chat-mode:prefs:v1(설정/모드 기본값/' +
              '가져오기 템플릿)과 dsh-chat-mode:login:v1(userToken 한 항목만, 평문, 기본 켬, 끌 수 있음);' +
              'document.cookie, 다른 localStorage 항목, IndexedDB, 페이지 내용은 읽지 않습니다.' +
              '읽은 선택 텍스트는 메모리에만 두고 쓰고 나면 바로 지우며, 어디에도 저장하지 않습니다.\n' +
              '작업으로 가져오기: inputActions.captureInsertion + insertText 로 커서 위치에 삽입할 뿐이며' +
              '(템플릿 + 선택한 텍스트)으로 쓰이며, 입력창에 이미 있는 내용을 덮지 않고 절대 자동 전송하지 않습니다. 사용할 수 있는 세션이 없으면' +
              '메모리에 임시 초안으로 보관합니다(최대 10분). 작업 모드 상단 안내 띠에서 자동 또는 수동으로 채웁니다.' +
              '채팅 기록이나 입력창의 기존 내용은 읽지 않습니다. 내용은 저장되거나 전송되지 않습니다.\n' +
              '로그인 복원: 기본으로 켜져 있으며 공식 채팅 페이지 로딩 완료 또는 메인 프레임 내부 이동 시 userToken 을 자동 저장합니다. 수동 버튼으로 즉시 저장할 수도 있습니다.' +
              '끄거나 삭제하면 저장이 멈춥니다.' +
              '복원은 최초 로딩 후 한 번만 시도하고, 실패하면 사본을 지우고 조용히 일반 로그인 화면으로 돌아갑니다. 오류 창은 띄우지 않습니다.' +
              '사용자가 직접 로그아웃하면 이번 실행에서는 자동 복원을 하지 않습니다.',
          ),
        ),
      );
    }

    // 工作模式顶部「待带入草稿」提示条：
    // 每次带入都显示，让用户选择目标会话；按钮任何时候都可点（不再按有无会话置灰）。
    // 位置固定在标题栏下方居中（zIndex 35，低于诊断面板 40、高于聊天层），不遮挡标题栏控件。
    function PendingBringBar() {
      useSpike();
      const pending = state.bring.pending;
      if (state.mode !== 'work' || !pending) return null;
      // 当前是否已有挂载的会话输入框：只影响提示文案，不再影响按钮可用性。
      const bridgeMounted = !!(composerBridge && composerBridge.mounted && composerBridge.sessionId);
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            top:
              'calc(var(--dsh-windows-titlebar-height, ' +
              TITLEBAR_HEIGHT_FALLBACK +
              'px) + 8px)',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 35,
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            maxWidth: 'min(640px, calc(100vw - 32px))',
            boxSizing: 'border-box',
            padding: '7px 12px',
            borderRadius: 8,
            background: 'var(--dsw-alias-bg-base, #fff)',
            border: '1px solid ' + BORDER_COLOR,
            color: LABEL_COLOR,
            fontSize: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,.18)',
          },
        },
        h(
          'span',
          { style: { whiteSpace: 'normal' } },
          bridgeMounted
            ? '가져온 텍스트 ' + pending.chars + '자. 세션을 선택하거나 새로 만드세요. 선택하면 자동으로 채워지며, “현재 세션에 채우기”를 눌러도 됩니다.'
            : '가져온 텍스트 ' + pending.chars + '자. “현재 세션에 채우기”를 누르면 빈 세션이 새로 만들어지고 그곳에 채워집니다. 기존 세션을 선택해도 됩니다.',
        ),
        button('현재 세션에 채우기', fillPendingFromBar, {
          disabled: state.bring.filling === true,
          title: state.bring.filling ? '새 세션을 만드는 중입니다. 자동 입력을 기다립니다…' : '현재 세션에 채우기',
        }),
        button('취소', cancelPendingBring),
      );
    }

    // 「带入工作模式」确认对话框（悬浮在聊天层之上；只填入、不发送）
    function BringDialog() {
      useSpike();
      if (!state.bring.open) return null;
      return h(
        'div',
        {
          style: {
            position: 'absolute',
            top: 'var(--dsh-frame-overlay-top, 52px)',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'min(640px, calc(100vw - 32px))',
            zIndex: 60,
            pointerEvents: 'auto',
            boxSizing: 'border-box',
            padding: '12px 14px',
            borderRadius: 10,
            background: 'var(--dsw-alias-bg-base, #fff)',
            border: '1px solid ' + BORDER_COLOR,
            boxShadow: '0 12px 32px rgba(0,0,0,.28)',
            color: LABEL_COLOR,
            fontSize: 13,
            lineHeight: 1.6,
          },
        },
        h(
          'div',
          { style: { fontWeight: 600, fontSize: 14, marginBottom: 4 } },
          '작업 모드로 가져오기(입력만, 전송 안 함)',
        ),
        h(
          'div',
          { style: { fontSize: 12, opacity: 0.8, marginBottom: 8 } },
          '아래 내용을 확인하거나 고친 뒤 확인하면 작업 모드 입력창에 들어갑니다. 전송은 직접 결정하세요. 플러그인은 자동 전송하지 않습니다.',
        ),
        h('textarea', {
          value: state.bring.text,
          rows: 7,
          spellCheck: false,
          onChange: (event) => {
            state.bring.text = event.target.value;
            notify();
          },
          style: {
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            minHeight: 120,
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1.6,
            padding: '8px',
            borderRadius: 6,
            border: '1px solid ' + BORDER_COLOR,
            background: 'transparent',
            color: 'inherit',
          },
        }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 8 } },
          button('클립보드 읽기', readClipboardIntoDialog),
        ),
        state.bring.notice
          ? h('div', { style: { fontSize: 12, opacity: 0.78, marginTop: 6 } }, state.bring.notice)
          : null,
        state.bring.error
          ? h('div', { style: { fontSize: 12, color: '#c2410c', marginTop: 6 } }, state.bring.error)
          : null,
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 } },
          button('취소', closeBringDialog),
          button(state.bring.busy ? '입력 중…' : '가져오기 확인(전송 안 함)', submitBring, { active: true }),
        ),
      );
    }

    // 设置页（注册到 settings.section）：启动行为、网页地址、登录恢复。
    function ChatSettingsPage() {
      useSpike();
      const [urlDraft, setUrlDraft] = React.useState(prefs.webUrl);
      const [urlError, setUrlError] = React.useState('');
      const [urlNotice, setUrlNotice] = React.useState('');
      const [urlWarning, setUrlWarning] = React.useState('');
      const [urlConfirmHost, setUrlConfirmHost] = React.useState('');
      const [templateDraft, setTemplateDraft] = React.useState(prefs.bringTemplate);
      const [templateNotice, setTemplateNotice] = React.useState('');
      const sectionStyle = { marginBottom: 14 };
      const titleStyle = { fontWeight: 600, fontSize: 13, marginBottom: 6 };
      const hintStyle = { fontSize: 12, opacity: 0.78, marginTop: 4, lineHeight: 1.6 };
      const rowStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };

      function updatePrefs(patch) {
        savePrefs(patch);
        notify();
      }

      function applyUrlValue(value, host) {
        updatePrefs({ webUrl: value, webUrlConfirmedHost: host });
        setUrlDraft(value);
        setUrlError('');
        setUrlWarning('');
        setUrlConfirmHost('');
        setUrlNotice('저장했습니다. 이미 열린 채팅 페이지는 현재 주소를 계속 쓰고, WebView 를 다시 만들면 새 주소가 적용됩니다.');
      }

      function applyUrl() {
        const next = normalizeWebUrl(urlDraft);
        if (!next) {
          setUrlError('주소가 올바르지 않습니다(사용자 이름/비밀번호가 없는 https 주소만 허용). 기본 주소로 되돌렸습니다.');
          setUrlWarning('');
          setUrlConfirmHost('');
          setUrlDraft(DEFAULT_WEB_URL);
          updatePrefs({ webUrl: DEFAULT_WEB_URL, webUrlConfirmedHost: null });
          return;
        }
        const host = new URL(next).hostname.toLowerCase();
        if (isDeepseekHost(host)) {
          applyUrlValue(next, host);
          return;
        }
        // 非 DeepSeek 官方域名：显示黄色警告，需要再点一次「确认使用该地址」才保存
        if (urlConfirmHost !== host) {
          setUrlError('');
          setUrlNotice('');
          setUrlWarning('이 주소는 DeepSeek 공식 도메인이 아닙니다(' + host + '). 이 주소를 쓰려면 “이 주소 사용 확인”을 한 번 더 눌러 주세요.');
          setUrlConfirmHost(host);
          return;
        }
        applyUrlValue(next, host);
      }

      function confirmUrl() {
        const next = normalizeWebUrl(urlDraft);
        if (!next) {
          applyUrl();
          return;
        }
        const host = new URL(next).hostname.toLowerCase();
        if (!urlConfirmHost || host !== urlConfirmHost) {
          applyUrl();
          return;
        }
        applyUrlValue(next, host);
      }

      function resetUrl() {
        setUrlDraft(DEFAULT_WEB_URL);
        setUrlError('');
        setUrlWarning('');
        setUrlConfirmHost('');
        updatePrefs({ webUrl: DEFAULT_WEB_URL, webUrlConfirmedHost: null });
        setUrlNotice('기본 주소로 되돌렸습니다.');
      }

      const loginLabel = (() => {
        const labels = {
          idle: state.login.saved ? '저장됨(길이 ' + state.login.savedLength + ')' : '저장 안 됨',
          saved: '저장됨(길이 ' + state.login.savedLength + ')',
          cleared: '삭제됨',
          restoring: '복원 중',
          restored: '복원됨',
          'still-login': '복원 안 됨(아직 로그인 화면)',
          error: state.login.error ? '작업 미완료: ' + state.login.error : '작업 미완료',
        };
        return labels[state.login.status] || state.login.status;
      })();

      return h(
        'div',
        { style: { padding: '4px 0 8px', color: LABEL_COLOR, fontSize: 13, lineHeight: 1.65 } },
        h('div', { style: titleStyle }, '채팅 모드'),
        h(
          'div',
          { style: { ...hintStyle, marginBottom: 10 } },
          '채팅 모드는 DeepSeek 공식 웹 채팅을 내장해 API 토큰을 쓰지 않습니다. 작업 모드는 DSH 기본 에이전트 UI 로 토큰을 사용합니다.',
        ),
        h(
          'div',
          { style: sectionStyle },
          h('div', { style: titleStyle }, '시작 동작'),
          h(
            'div',
            { style: rowStyle },
            h('span', null, '기본 시작 모드: '),
            segmentButton('채팅', prefs.defaultMode === 'chat', false, '기본으로 채팅 모드에서 시작(토큰 미사용)', () =>
              updatePrefs({ defaultMode: 'chat' }),
            ),
            segmentButton('작업', prefs.defaultMode === 'work', true, '기본으로 작업 모드에서 시작(토큰 사용)', () =>
              updatePrefs({ defaultMode: 'work' }),
            ),
          ),
          h(
            'div',
            { style: { ...rowStyle, marginTop: 8 } },
            checkbox('마지막 사용 모드 기억', prefs.rememberLast, (checked) =>
              updatePrefs({ rememberLast: checked }),
            ),
          ),
          h(
            'div',
            { style: hintStyle },
            '“마지막 모드 기억”이 꺼져 있으면 시작할 때마다 기본 모드로 들어가고, 켜져 있으면 마지막에 쓰던 모드로 들어갑니다.',
          ),
        ),
        h(
          'div',
          { style: sectionStyle },
          h('div', { style: titleStyle }, '웹 주소'),
          h(
            'div',
            { style: rowStyle },
            h('input', {
              type: 'text',
              value: urlDraft,
              spellCheck: false,
              onChange: (event) => {
                setUrlDraft(event.target.value);
                setUrlError('');
                setUrlWarning('');
                setUrlConfirmHost('');
              },
              style: {
                flex: '1 1 260px',
                minWidth: 180,
                font: 'inherit',
                fontSize: 13,
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid ' + BORDER_COLOR,
                background: 'transparent',
                color: 'inherit',
              },
            }),
            button('저장', applyUrl, { active: true }),
            urlWarning ? button('이 주소 사용 확인', confirmUrl, { active: true }) : null,
            button('기본값 복원', resetUrl),
          ),
          urlError ? h('div', { style: { ...hintStyle, color: '#c2410c' } }, urlError) : null,
          urlWarning ? h('div', { style: { ...hintStyle, color: '#b45309' } }, urlWarning) : null,
          urlNotice ? h('div', { style: hintStyle }, urlNotice) : null,
          h(
            'div',
            { style: hintStyle },
            'https 주소만 허용합니다. deepseek.com 과 그 하위 도메인은 바로 저장되고, 다른 도메인은 한 번 더 확인해야 합니다. 사용자 이름/비밀번호가 포함된 주소는 거부됩니다. 기본값은 https://chat.deepseek.com/ 입니다.',
          ),
        ),
        h(
          'div',
          { style: { ...sectionStyle, borderTop: '1px solid ' + BORDER_COLOR, paddingTop: 12 } },
          h('div', { style: titleStyle }, '작업으로 가져오기'),
          h(
            'div',
            { style: { ...hintStyle, marginBottom: 6 } },
            '채팅 웹페이지에서 텍스트를 선택한 뒤 제목 표시줄의 “작업으로 가져오기”를 누르면 아래 템플릿 + 선택한 텍스트가 작업 모드 입력창에 들어갑니다(입력만 하고 자동 전송은 하지 않습니다). 선택한 텍스트가 없으면 기존 붙여넣기 대화상자가 열립니다.',
          ),
          h('textarea', {
            value: templateDraft,
            rows: 3,
            spellCheck: false,
            onChange: (event) => {
              setTemplateDraft(event.target.value);
              setTemplateNotice('');
            },
            style: {
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              minHeight: 64,
              font: 'inherit',
              fontSize: 12,
              lineHeight: 1.6,
              padding: '8px',
              borderRadius: 6,
              border: '1px solid ' + BORDER_COLOR,
              background: 'transparent',
              color: 'inherit',
            },
          }),
          h(
            'div',
            { style: { ...rowStyle, marginTop: 8 } },
            button(
              '템플릿 저장',
              () => {
                updatePrefs({ bringTemplate: String(templateDraft || '').slice(0, 4000) });
                setTemplateDraft(prefs.bringTemplate);
                setTemplateNotice('저장했습니다. 다음에 “작업으로 가져오기”를 누를 때 적용됩니다.');
              },
              { active: true },
            ),
            button('기본 템플릿 복원', () => {
              updatePrefs({ bringTemplate: DEFAULT_BRING_TEMPLATE });
              setTemplateDraft(DEFAULT_BRING_TEMPLATE);
              setTemplateNotice('기본 템플릿으로 되돌렸습니다.');
            }),
          ),
          templateNotice ? h('div', { style: hintStyle }, templateNotice) : null,
          h(
            'div',
            { style: hintStyle },
            '템플릿은 이 페이지의 다른 설정과 함께 플러그인 localStorage 키에 저장되며 업로드되지 않습니다. 선택한 텍스트가 ' +
              BRING_SELECTION_MAX_CHARS +
              '자를 넘으면 잘라서 알려 줍니다. 읽은 선택 텍스트는 메모리에만 두고 저장하지 않으며, 채운 뒤 자동 전송하지 않습니다.',
          ),
        ),
        h(
          'div',
          { style: { ...sectionStyle, borderTop: '1px solid ' + BORDER_COLOR, paddingTop: 12 } },
          h('div', { style: titleStyle }, '로그인 복원(선택)'),
          h(
            'div',
            { style: rowStyle },
            checkbox('로그인 자동 기억(userToken 한 항목만 저장)', prefs.rememberLogin, (checked) => {
              if (checked) {
                updatePrefs({ rememberLogin: true });
                autoSaveLogin(element);
              } else {
                clearSavedLogin();
              }
            }),
          ),
          h(
            'div',
            { style: { ...rowStyle, marginTop: 8 } },
            h('span', null, '상태: ' + loginLabel),
            button('지금 로그인 저장', saveLogin),
            state.login.saved ? button('로그인 끄고 삭제', clearSavedLogin) : null,
          ),
          h(
            'div',
            { style: { ...hintStyle, marginTop: 8 } },
            '설명: 기본으로 켜져 있고 로그인에 성공하면 자동 저장되므로 직접 저장할 필요가 없습니다. 이미 끈 설정은 유지됩니다. 공식 chat.deepseek.com 에서만 동작합니다.' +
              '이 기기의 플러그인 localStorage 에 저장합니다(평문, 같은 origin 스크립트는 이론적으로 읽을 수 있음). 끄거나 삭제하면 자동 저장이 멈추고 사본이 지워집니다.' +
              '복원에 실패하면 사본이 자동으로 지워집니다. 웹에서 직접 로그아웃하면 이번 실행에서는 다시 자동 로그인하지 않습니다. token 유효 기간은 아직 검증되지 않았습니다.',
          ),
        ),
      );
    }

    function SpikeRoot() {
      useSpike();
      const containerRef = React.useRef(null);

      React.useEffect(() => {
        if (state.mode === 'chat' && containerRef.current) {
          ensureWebview(containerRef.current);
        }
      });

      const chatVisible = state.mode === 'chat';
      const showChat = chatVisible && state.bridge === 'ok';

      return h(
        'div',
        {
          style: {
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 30,
          },
        },
        // 聊天层：始终存在于 DOM 中，只切换 display，保证 webview 不被卸载/重载
        // 顶部从 CHAT_LAYER_TOP 开始，避免盖住标题栏（标题栏里的切换按钮仍在聊天层之上）
        h(
          'div',
          {
            'data-chat-layer': 'chat',
            style: {
              position: 'absolute',
              top: CHAT_LAYER_TOP,
              right: 0,
              bottom: 0,
              left: 0,
              display: showChat ? 'block' : 'none',
              background: 'var(--dsw-alias-bg-base, #fff)',
              opacity: state.inspecting ? 0.45 : 1,
              outline: state.inspecting ? '3px dashed rgba(255,64,64,.95)' : 'none',
              transition: 'opacity 120ms linear',
              pointerEvents: showChat ? 'auto' : 'none',
              zIndex: 1,
            },
          },
          h('div', {
            ref: containerRef,
            style: { position: 'absolute', inset: 0 },
          }),
          // 加载遮罩：首次加载 / 登录恢复期间盖住聊天区域，消除登录页闪烁（8 秒兜底自动撤掉）
          state.mask
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    inset: 0,
                    zIndex: 2,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--dsw-alias-bg-base, #fff)',
                    color: LABEL_COLOR,
                    fontSize: 13,
                    pointerEvents: 'auto',
                  },
                },
                '채팅 페이지를 불러오는 중…',
              )
            : null,
        ),
        // 没有桌面桥时的提示（Web 环境），此时不覆盖应用
        chatVisible && state.bridge === 'missing'
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: 'var(--dsh-frame-overlay-top, 52px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 25,
                  pointerEvents: 'auto',
                  maxWidth: 560,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'var(--dsw-alias-bg-base, #fff)',
                  border: '1px solid ' + BORDER_COLOR,
                  color: LABEL_COLOR,
                  fontSize: 12,
                  lineHeight: 1.6,
                },
              },
              '데스크톱 webview 브리지(dshDesktop.browser)를 찾지 못했습니다. 현재 환경에서는 웹페이지를 띄울 수 없어' +
                '따라서 채팅 모드가 앱을 덮지 않습니다. DSH 데스크톱 메인 창에서 실행 중인지 확인하세요.',
            )
          : null,
        // 聊天层可见时隐藏 DSH 标题栏「收起侧栏」按钮（受控样式，无 UI）
        h(SidebarToggleHider),
        h(TitlebarControls),
        h(PendingBringBar),
        h(DiagnosticsPanel),
        h(BringDialog),
        // 一键带入的短暂提示（固定文字，不显示选中文字正文）
        state.bring.toast
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  top: 'calc(var(--dsh-windows-titlebar-height, ' +
                    TITLEBAR_HEIGHT_FALLBACK +
                    'px) + 8px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 62,
                  pointerEvents: 'none',
                  padding: '6px 12px',
                  borderRadius: 8,
                  background: 'var(--dsw-alias-bg-base, #fff)',
                  border: '1px solid ' + BORDER_COLOR,
                  color: LABEL_COLOR,
                  fontSize: 12,
                  boxShadow: '0 8px 24px rgba(0,0,0,.18)',
                },
              },
              state.bring.toast,
            )
          : null,
      );
    }

    function apply(ctx) {
      appCtx = ctx;

      try {
        // 插件卸载 / apply 失败时的统一清理：撤销受控隐藏（属性 + <style>）+ 释放 webview 租约。
        // ctx.effect 的返回值即清理函数，插件卸载时由 Cordis 调用。
        ctx.effect(
          () => () => {
            appCtx = null;
            clearPendingBring();
            clearSidebarToggleHiding();
            releaseWebview();
          },
          'dsh-chat-mode:cleanup',
        );
        // 常驻 overlay：聊天层 + 标题栏切换控件 + 诊断面板 + 带入工作对话框
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'chat-mode-ko', order: 60 },
            SpikeRoot,
          ),
        );
        // 设置页：默认启动模式、网页版地址、记住上次模式、登录恢复
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'chat-mode-ko', order: 80, label: '채팅 모드' },
            ChatSettingsPage,
          ),
        );
        // 无 UI 桥接组件：挂到 session 作用域的 conversation.input.left。
        // 该位置在 hero 与 composer 两种输入条里都会渲染（空白会话的新会话窗口也能挂上桥），
        // 并通过标准 prop 提供 inputActions + sessionId，供「带入工作模式」在光标处插入草稿。
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'chat-mode-ko-input-bridge', order: 50 },
            ComposerBridge,
          ),
        );
      } catch (error) {
        // apply 出错：确保不留下受控隐藏的属性和样式
        clearSidebarToggleHiding();
        try {
          console.error('[chat-mode-ko] apply 실패:', firstLine(error));
        } catch {
          // 忽略
        }
      }
    }

    return { inject: ['slots'], apply };
  },
});
