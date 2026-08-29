// dsh-mobile-remote — DSH 移动端远程控制插件（client 侧）。
//
// 在 Web UI 的「设置」中注册一个「远程控制」section，提供：
//   1. 局域网开关（写入 / 移除 profile patch，经 HMR 热重载生效）+ 二维码 + 设备数；
//   2. 「外网访问」：通过中转服务器（dsh-update-server）启动 frpc 隧道，让外网设备
//      访问本机 DSH。含绑定码 / 中转服务地址输入、开启/关闭开关、外网链接 + 二维码 +
//      在线状态反馈（online / connecting / stopped / error）。
//
// 打包格式：浏览器 module loader（window.__ModuleLoader__.load）标准 bundle，
// 与官方 client 插件一致。纯 React.createElement，无 JSX 构建依赖。
//
// 注意：__ModuleLoader__.load 的 id 必须是完整的 npm 包名（含 scope）。client-modules
// 按 loader entry 的包名（@feiyang666/dsh-mobile-remote）校验注册，若写成裸包名会报
// "loaded without registering ..." 导致客户端插件加载失败。

window.__ModuleLoader__.load({
  id: '@feiyang666/dsh-mobile-remote',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var el = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;
    var useRef = React.useRef;

    /* ------------------------------------------------------------------ */
    /* 内联样式（跟随宿主主题 token，深色/浅色自动适配）                      */
    /* ------------------------------------------------------------------ */

    var st = {
      root: {
        display: 'flex', flexDirection: 'column', gap: 16,
        width: '100%', maxWidth: 560, minWidth: 0, boxSizing: 'border-box',
        padding: '8px 0',
      },
      card: {
        display: 'flex', flexDirection: 'column', gap: 12,
        padding: '16px 18px', borderRadius: 12,
        background: 'var(--dsw-alias-bg-overlay, #f6f6f7)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
        boxSizing: 'border-box',
      },
      // flexWrap: 窄屏下内容放不下时允许换行（如外网隧道详情行的长文本），桌面端无感知
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      title: { fontSize: 15, fontWeight: 600, margin: 0, lineHeight: 1.4 },
      sub: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #767676)', lineHeight: 1.6, margin: 0 },
      hint: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #767676)', lineHeight: 1.6, margin: 0 },
      badge: {
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 13, fontWeight: 600, padding: '2px 10px', borderRadius: 999,
        whiteSpace: 'nowrap',
      },
      badgeOn: { color: '#0d7a3f', background: 'rgba(18,150,78,.14)' },
      badgeOff: { color: '#8a8a8a', background: 'rgba(127,127,127,.12)' },
      badgeBusy: { color: '#9a6a00', background: 'rgba(200,140,0,.14)' },
      badgeErr: { color: '#c0272b', background: 'rgba(200,40,40,.13)' },
      switch: {
        position: 'relative', width: 46, height: 26, flex: 'none',
        borderRadius: 999, border: 'none', cursor: 'pointer',
        transition: 'background .18s ease', padding: 0,
        background: 'var(--dsw-alias-state-disabled-bg, #d1d1d1)',
      },
      switchOn: { background: 'var(--dsw-alias-state-business-primary, #2a7de1)' },
      knob: {
        position: 'absolute', top: 3, left: 3, width: 20, height: 20,
        borderRadius: 999, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.25)',
        transition: 'transform .18s ease',
      },
      knobOn: { transform: 'translateX(20px)' },
      qrBox: {
        display: 'flex', justifyContent: 'center', alignItems: 'center',
        padding: 12, borderRadius: 10,
        background: '#fff',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
      },
      qrImg: { width: 180, height: 180, display: 'block' },
      qrFallback: {
        fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #767676)',
        textAlign: 'center', lineHeight: 1.6, wordBreak: 'break-all', padding: 8,
      },
      grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
      stat: {
        display: 'flex', flexDirection: 'column', gap: 4,
        padding: '12px 14px', borderRadius: 10,
        background: 'var(--dsw-alias-bg-overlay, #f6f6f7)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
        boxSizing: 'border-box',
      },
      statValue: { fontSize: 20, fontWeight: 700, lineHeight: 1.2 },
      statLabel: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #767676)' },
      link: {
        fontSize: 13, color: 'var(--dsw-alias-state-business-primary, #2a7de1)',
        wordBreak: 'break-all', textDecoration: 'none', lineHeight: 1.6,
      },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12, padding: '8px 10px', borderRadius: 8,
        background: 'var(--dsw-alias-bg-base, #f0f0f1)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
        overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary, #1f1f1f)',
      },
      input: {
        padding: '8px 10px', borderRadius: 8, fontSize: 13,
        background: 'var(--dsw-alias-bg-base, #f0f0f1)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
        color: 'var(--dsw-alias-label-primary, #1f1f1f)',
        outline: 'none',
      },
      divider: { height: 1, background: 'var(--dsw-alias-border-l2, rgba(127,127,127,.18))', border: 'none' },
      disabled: { opacity: 0.55 },
      deviceList: { display: 'flex', flexDirection: 'column', gap: 8 },
      deviceRow: {
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderRadius: 8,
        background: 'var(--dsw-alias-bg-base, #f0f0f1)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
        boxSizing: 'border-box', minWidth: 0,
      },
      dotOn: { width: 8, height: 8, borderRadius: 999, flex: 'none', background: '#18a058' },
      deviceName: { fontSize: 13, fontWeight: 600, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // minWidth + overflowWrap：窄屏下长文本（设备详情、外网状态行）不溢出卡片
      meta: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #767676)', lineHeight: 1.5, minWidth: 0, overflowWrap: 'break-word' },
      dotOff: { width: 8, height: 8, borderRadius: 999, flex: 'none', background: 'rgba(127,127,127,.38)' },
      chevron: {
        fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #767676)', flex: 'none',
        transition: 'transform .15s ease', lineHeight: 1,
      },
      chevronOpen: {
        fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #767676)', flex: 'none',
        transform: 'rotate(180deg)', transition: 'transform .15s ease', lineHeight: 1,
      },
      deviceCard: {
        display: 'flex', flexDirection: 'column', minWidth: 0,
        borderRadius: 8, overflow: 'hidden',
        background: 'var(--dsw-alias-bg-base, #f0f0f1)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
        boxSizing: 'border-box',
      },
      deviceHead: {
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', cursor: 'pointer', width: '100%',
        boxSizing: 'border-box', textAlign: 'left',
        background: 'transparent', border: 'none', fontFamily: 'inherit', color: 'inherit',
      },
      deviceDetail: {
        display: 'flex', flexDirection: 'column', gap: 4,
        padding: '8px 12px 10px',
        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
      },
      detailRow: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, lineHeight: 1.6 },
      detailLabel: { flex: 'none', width: 92, color: 'var(--dsw-alias-label-tertiary, #767676)' },
      detailValue: { flex: 1, minWidth: 0, wordBreak: 'break-all', overflowWrap: 'break-word' },
      btn: {
        padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
        color: 'var(--dsw-alias-state-business-primary, #2a7de1)',
        background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
        cursor: 'pointer', whiteSpace: 'nowrap',
      },
    };

    /* ------------------------------------------------------------------ */
    /* 远程控制面板                                                        */
    /* ------------------------------------------------------------------ */

    var STATUS_URL = '/__dsh_remote/status';
    var TOGGLE_URL = '/__dsh_remote/toggle';
    var EXT_START_URL = '/__dsh_remote/external/start';
    var EXT_STOP_URL = '/__dsh_remote/external/stop';
    var EXT_LOG_URL = '/__dsh_remote/external/log';
    var SET_PASSWORD_URL = '/__dsh_remote/set-password';
    var AUTH_STATUS_URL = '/__dsh_remote/auth-status';

    // fetch 带超时：避免后端长时间无响应（如中转服务重启/网络慢）时，
    // 开关按钮一直卡在"连接中"转圈。超时后走 catch 显示友好提示。
    function fetchWithTimeout(url, opts, ms) {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var t = null;
      if (ctrl) {
        t = setTimeout(function () { ctrl.abort(); }, ms || 25000);
        opts = opts || {};
        opts.signal = ctrl.signal;
      }
      var p = fetch(url, opts);
      if (t) p = p.then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); throw e; });
      return p;
    }

    // 把 abort 超时错误转成用户可读文案
    function fmtFetchError(e, fallback) {
      var err = e && e.name === 'AbortError' ? null : (e && e.message) || e;
      return err ? String(err) : fallback || '请求超时，请稍后重试';
    }

    function fmtUrl(url) {
      return url || '未检测到局域网地址';
    }

    function fmtAgo(ts) {
      if (!ts) return '—';
      var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (s < 10) return '刚刚';
      if (s < 60) return s + ' 秒前';
      var m = Math.floor(s / 60);
      if (m < 60) return m + ' 分钟前';
      var h = Math.floor(m / 60);
      if (h < 24) return h + ' 小时前';
      return Math.floor(h / 24) + ' 天前';
    }

    function fmtDuration(s) {
      if (s === null || s === undefined) return '—';
      var sec = Math.max(0, Math.floor(s));
      var d = Math.floor(sec / 86400);
      var h = Math.floor((sec % 86400) / 3600);
      var m = Math.floor((sec % 3600) / 60);
      var ss = sec % 60;
      if (d > 0) return d + ' 天 ' + h + ' 小时';
      if (h > 0) return h + ' 小时 ' + m + ' 分';
      if (m > 0) return m + ' 分 ' + ss + ' 秒';
      return ss + ' 秒';
    }

    // 实时时长组件：基于「一次采样的秒数 + 采集时刻」在浏览器本地每秒累加刷新，
    // 让"运行时长 / 开机时长 / 隧道已运行"等秒级数字每秒跳动（秒表效果），
    // 不再依赖 5s 的 /status HTTP 轮询（那会导致数字每 5s 才跳一次，且跳幅不连续）。
    // 只要 host 在采集时带上 at 时间戳，两次 /status 之间也能精确走到下一秒。
    function LiveDuration(props) {
      var _n = useState(Date.now());
      var now = _n[0];
      var setNow = _n[1];
      useEffect(function () {
        var t = setInterval(function () { setNow(Date.now()); }, 1000);
        return function () { clearInterval(t); };
      }, []);
      var at = props.at || now;
      var sec = props.baseSec + Math.max(0, Math.floor((now - at) / 1000));
      return fmtDuration(sec);
    }

    function fmtBytes(b) {
      if (b === null || b === undefined) return '—';
      var n = Number(b);
      if (!isFinite(n)) return '—';
      if (n < 1024) return n + ' B';
      var units = ['KB', 'MB', 'GB', 'TB'];
      var i = -1;
      do { n /= 1024; i += 1; } while (n >= 1024 && i < units.length - 1);
      return n.toFixed(n >= 100 ? 0 : 1) + ' ' + units[i];
    }

    function fmtDateTime(ts) {
      if (!ts) return '—';
      try {
        var d = new Date(ts);
        if (isNaN(d.getTime())) return String(ts);
        return d.toLocaleString('zh-CN', { hour12: false });
      } catch (e) { return String(ts); }
    }

    // 生成一组「标签: 值」行（key-value 行列表），供详情区渲染
    function kvList(items) {
      return items.map(function (it, idx) {
        return el('div', { style: st.detailRow, key: idx },
          el('span', { style: st.detailLabel }, it[0]),
          el('span', { style: st.detailValue }, it[1] || '—'));
      });
    }

    function RemoteControlPanel() {
      var _s = useState(null);
      var status = _s[0];
      var setStatus = _s[1];
      var _t = useState(false);
      var busy = _t[0];
      var setBusy = _t[1];
      var _e = useState(null);
      var error = _e[0];
      var setError = _e[1];
      var _exp = useState({});
      var expandedMap = _exp[0];
      var setExpanded = _exp[1];
      function toggleExpanded(id) {
        setExpanded(function (m) {
          var n = Object.assign({}, m);
          n[id] = !n[id];
          return n;
        });
      }
      var _dshOpen = useState(false);
      var dshOpen = _dshOpen[0];
      var setDshOpen = _dshOpen[1];

      var refresh = useCallback(function () {
        fetch(STATUS_URL)
          .then(function (r) { return r.json(); })
          .then(function (data) { setStatus(data); setError(null); })
          .catch(function (e) { setError(String(e && e.message || e)); });
      }, []);

      useEffect(function () {
        refresh();
        var t = setInterval(refresh, 5000);
        return function () { clearInterval(t); };
      }, [refresh]);

      var toggle = useCallback(function () {
        if (busy || !status) return;
        setBusy(true);
        setError(null);
        fetch(TOGGLE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !status.remoteEnabled }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data.ok) throw new Error(data.error || 'toggle failed');
            setBusy(false);
            setTimeout(refresh, 1500); // 等待 HMR 重载后再刷新
          })
          .catch(function (e) {
            setBusy(false);
            setError(String(e && e.message || e));
          });
      }, [busy, status, refresh]);

      // 局域网状态徽标
      var on = !!(status && status.remoteEnabled);
      var badge = el('span', { style: Object.assign({}, st.badge, on ? st.badgeOn : st.badgeOff) },
        on ? '已开启' : '未开启');

      // 局域网开关
      var sw = el('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': String(on),
        'aria-label': on ? '关闭远程控制' : '开启远程控制',
        onClick: toggle,
        disabled: busy || !status,
        style: Object.assign({}, st.switch, on ? st.switchOn : null),
      }, el('span', { style: Object.assign({}, st.knob, on ? st.knobOn : null) }));

      // 局域网二维码
      var qrEl;
      if (on && status && status.url) {
        var qrSrc = '/__dsh_remote/qr?url=' + encodeURIComponent(status.url);
        qrEl = el('div', { style: st.qrBox },
          el('img', { src: qrSrc, alt: '连接二维码', style: st.qrImg }));
      } else if (status) {
        qrEl = el('div', { style: st.qrFallback },
          on
            ? '开启中…请稍候刷新'
            : '开启远程控制后，这里会显示手机扫码连接二维码');
      } else {
        qrEl = el('div', { style: st.qrFallback }, '加载中…');
      }

      // 设备数
      var count = status ? status.deviceCount : 0;

      // ---- 外网访问状态 + 操作 ----
      var _bc = useState('');
      var bindCode = _bc[0];
      var setBindCode = _bc[1];
      var _sb = useState('');
      var serverBase = _sb[0];
      var setServerBase = _sb[1];
      var _xbusy = useState(false);
      var extBusy = _xbusy[0];
      var setExtBusy = _xbusy[1];
      var _xerr = useState(null);
      var extErr = _xerr[0];
      var setExtErr = _xerr[1];
      var _xlog = useState(null);
      var extLog = _xlog[0];
      var setExtLog = _xlog[1];
      var _frpclog = useState(null);
      var frpcLog = _frpclog[0];
      var setFrpcLog = _frpclog[1];
      function viewFrpcLog() {
        if (frpcLog) { setFrpcLog(null); return; }
        fetchWithTimeout(EXT_LOG_URL, null, 10000)
          .then(function (r) {
            var ct = String(r.headers.get('content-type') || '').toLowerCase();
            return r.text().then(function (text) {
              if (ct.indexOf('application/json') >= 0) {
                try { return JSON.parse(text); } catch (e) { throw new Error('接口返回异常'); }
              }
              // 服务端返回 HTML（例如旧版 host 没有该路由，落到 SPA 回退页）
              throw new Error('服务端未提供该接口（可能是 dsh 服务未重启）。请重启 dsh 服务后再试。');
            });
          })
          .then(function (d) { setFrpcLog(d && d.log ? d.log : '(日志为空)'); })
          .catch(function (err) { setFrpcLog('读取失败：' + String(err && err.message || err)); });
      }

      // 用户是否已手动编辑过绑定码 / 中转地址。一旦编辑过就停止自动回填，
      // 否则 status 每 5 秒轮询刷新时会用持久化旧值覆盖用户刚清空的输入框。
      var editedRef = useRef(false);
      function markEdited() { editedRef.current = true; }

      // 回填已持久化的绑定信息（dsh 重启后免重新输入验证码 / 中转地址）
      useEffect(function () {
        if (!status || !status.external || !status.external.persisted) return;
        if (editedRef.current) return;
        var p = status.external.persisted;
        if (p.bindCode && bindCode === '') setBindCode(p.bindCode);
        if (p.serverBase && serverBase === '') setServerBase(p.serverBase);
      }, [status, bindCode, serverBase]);

      // 外网状态：online / connecting / stopped / idle / error
      var extSt = status && status.external ? status.external.status : 'idle';
      var extUrl = status && status.external ? status.external.url : null;
      var extStarted = extSt === 'online';
      var extConnecting = extSt === 'connecting';
      var extError = extSt === 'error';
      // 后端探测到的错误（如鉴权失败 / token 不匹配），优先于请求时的临时错误
      var extErrText = extErr || (extError && status && status.external && status.external.error ? status.external.error : null);

      // ---- WS 状态推送通道（host 连接中转服务器的数据通道）----
      // 让用户明确看到当前外网状态数据是经 WS 长连接实时推送，还是退让为 HTTP 低频轮询。
      var wsInfo = status && status.external && status.external.ws ? status.external.ws : null;
      var wsBadge = null;
      var wsHint = null;
      if (extStarted && wsInfo) {
        if (wsInfo.connected && wsInfo.source === 'ws') {
          wsBadge = el('span', { style: Object.assign({}, st.badge, st.badgeOn) }, 'WS 实时推送');
          wsHint = '隧道状态经 WebSocket 长连接实时更新（零 HTTP 轮询）';
        } else if (wsInfo.available === false) {
          // 退让版本：ws 依赖缺失（如离线安装），WS 客户端 no-op，走 HTTP 低频兜底
          wsBadge = el('span', { style: Object.assign({}, st.badge, st.badgeBusy) }, 'HTTP 兜底（退让模式）');
          wsHint = '未安装 ws 依赖，已自动退让为 HTTP 低频查询（60s 节流），功能不受影响';
        } else if (wsInfo.connected) {
          wsBadge = el('span', { style: Object.assign({}, st.badge, st.badgeBusy) }, 'WS 已连接，等待推送');
          wsHint = 'WS 长连接已建立，收到首条推送后自动切换为实时模式';
        } else if (wsInfo.source === 'ws') {
          wsBadge = el('span', { style: Object.assign({}, st.badge, st.badgeBusy) }, 'WS 已断开');
          wsHint = 'WS 长连接已断开，正在自动重连；当前显示最近一次推送的缓存数据' +
            (wsInfo.lastPushAt ? '（最后推送 ' + fmtAgo(wsInfo.lastPushAt) + '）' : '');
        } else {
          wsBadge = el('span', { style: Object.assign({}, st.badge, st.badgeBusy) }, 'WS 未连接');
          wsHint = 'WS 长连接尚未建立（连接中 / 自动重连），期间数据走 HTTP 兜底';
        }
      }

      function externalStart() {
        if (extBusy || extConnecting) return;
        if (!bindCode || !bindCode.trim()) {
          setExtErr('请先填写绑定码（留空无法开启外网访问）');
          return;
        }
        setExtBusy(true);
        setExtErr(null);
        setExtLog(null);
        fetchWithTimeout(EXT_START_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bindCode: bindCode, serverBase: serverBase || undefined }),
        }, 30000)
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data.ok) {
              setExtLog(data.log || null); // 展示 frpc 真实日志，便于定位根因
              throw new Error(data.message || data.error || 'start failed');
            }
            setExtLog(null);
            setTimeout(refresh, 1400);
          })
          .catch(function (e) {
            setExtErr(fmtFetchError(e, '开启外网访问超时（后端响应过慢），请稍后重试或查看下方 frpc 日志'));
            setTimeout(refresh, 600); // 立即刷新，让开关从"连接中"恢复可操作
          })
          .finally(function () { setExtBusy(false); });
      }

      function externalStop() {
        if (extBusy) return;
        setExtBusy(true);
        setExtErr(null);
        setExtLog(null);
        fetchWithTimeout(EXT_STOP_URL, { method: 'POST' }, 10000)
          .then(function () { setTimeout(refresh, 800); })
          .catch(function (e) { setExtErr(fmtFetchError(e, '关闭超时，请稍后重试')); })
          .finally(function () { setExtBusy(false); });
      }

      // 外网开关：offline / connecting / online / error 均可操作，连接中点击即取消
      var extSwitch = el('button', {
        type: 'button', role: 'switch',
        'aria-checked': String(extStarted),
        'aria-label': extStarted ? '关闭外网访问' : (extConnecting ? '取消连接' : '开启外网访问'),
        onClick: (extStarted || extConnecting) ? externalStop : externalStart,
        disabled: extBusy,
        style: Object.assign({}, st.switch, (extStarted || extConnecting) ? st.switchOn : null),
      }, el('span', { style: Object.assign({}, st.knob, (extStarted || extConnecting) ? st.knobOn : null) }));

      var extBadge = el('span', {
        style: Object.assign({}, st.badge,
          extStarted ? st.badgeOn : (extConnecting ? st.badgeBusy : (extError ? st.badgeErr : st.badgeOff))),
      }, extStarted ? '在线' : (extConnecting ? '连接中' : (extError ? '出错' : '未开启')));

      // 外网二维码
      var extQr;
      if (extStarted && extUrl) {
        extQr = el('div', { style: st.qrBox },
          el('img', { src: '/__dsh_remote/qr?url=' + encodeURIComponent(extUrl), alt: '外网二维码', style: st.qrImg }));
      } else {
        extQr = el('div', { style: st.qrFallback },
          extConnecting ? '正在连接中转服务器…'
            : (extError ? '外网隧道异常，请查看上方错误信息' : '开启外网访问后，这里显示外网二维码'));
      }

      // 命令行提示（未开启时展示 CLI 启动方式）
      var cliHint = null;
      if (status && !status.remoteEnabled) {
        cliHint = el('div', { style: st.card },
          el('p', { style: st.title }, '命令行启动方式'),
          el('p', { style: st.sub },
            '开启开关后，本插件会把 webserver.host 写入当前 profile 的 cordis.patch.yml，' +
            '由 dsh 的 HMR 热重载生效。如果你希望手动启动（无需桌面端），可预先创建 overlay：'),
          el('pre', { style: st.code },
            '# remote-control.patch.yml\n' +
            '- id: webserver\n' +
            '  config:\n' +
            "    host: '0.0.0.0'\n"),
          el('p', { style: st.hint },
            '然后以 dsh --profile web --patch remote-control.patch.yml 启动。'),
        );
      }

      // ---- 远程访问密码管理 ----
      var authOn = !!(status && status.auth && status.auth.enabled);
      var authRequiredHere = !!(status && status.auth && status.auth.requiredHere);
      var _p1 = useState('');
      var pwd1 = _p1[0];
      var setPwd1 = _p1[1];
      var _p2 = useState('');
      var pwd2 = _p2[0];
      var setPwd2 = _p2[1];
      // 当前密码：已设置密码后，修改 / 清除都必须先验证当前密码，防止误改或未授权篡改
      var _cp = useState('');
      var currentPwd = _cp[0];
      var setCurrentPwd = _cp[1];
      var _msgbusy = useState(false);
      var msgBusy = _msgbusy[0];
      var setMsgBusy = _msgbusy[1];
      var _msg = useState(null);
      var msg = _msg[0];
      var setMsg = _msg[1];

      function savePassword() {
        if (msgBusy) return;
        if (pwd1 !== pwd2) {
          setMsg({ type: 'err', text: '两次输入的密码不一致' });
          return;
        }
        if (pwd1 && pwd1.length < 4) {
          setMsg({ type: 'err', text: '密码至少 4 位' });
          return;
        }
        // 已设置过密码时，修改必须验证当前密码
        if (authOn && !currentPwd) {
          setMsg({ type: 'err', text: '请输入当前密码以确认修改' });
          return;
        }
        setMsgBusy(true);
        setMsg(null);
        fetch(SET_PASSWORD_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd1, currentPassword: authOn ? currentPwd : undefined }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data.ok) throw new Error(data.message || data.error || '保存失败');
            setMsg({ type: 'ok', text: data.enabled ? '已设置远程访问密码。' : '已清除远程访问密码。' });
            setPwd1('');
            setPwd2('');
            setCurrentPwd('');
            setTimeout(refresh, 300);
          })
          .catch(function (e) { setMsg({ type: 'err', text: String(e && e.message || e) }); })
          .finally(function () { setMsgBusy(false); });
      }

      var passwordCard = el('div', { style: st.card },
        el('div', { style: st.row },
          el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            el('p', { style: st.title }, '远程访问密码'),
            el('p', { style: st.sub },
              authOn
                ? '已启用：远程访问需要输入密码'
                : '未设置：远程访问无需密码')),
          el('span', {
            style: Object.assign({}, st.badge, authOn ? st.badgeOn : st.badgeOff),
          }, authOn ? '已设置' : '未设置')),

        el('p', { style: st.hint },
          authRequiredHere
            ? '当前设备通过远程访问进入，需输入密码。你在本机设置/修改即可。'
            : '设置后，通过外网隧道（远程）访问本机 DSH 时，需先输入该密码才能进入页面；本机/内网访问不受影响。'),

        el('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          authOn
            ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                el('label', { style: st.hint }, '当前密码（修改 / 清除需验证）'),
                el('input', {
                  type: 'password', value: currentPwd, placeholder: '输入当前密码',
                  onChange: function (e) { setCurrentPwd(e.target.value); },
                  autoComplete: 'current-password', style: st.input,
                }))
            : null,
          el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            el('label', { style: st.hint }, authOn ? '新密码' : '设置远程访问密码'),
            el('input', {
              type: 'password', value: pwd1, placeholder: '至少 4 位',
              onChange: function (e) { setPwd1(e.target.value); },
              autoComplete: 'new-password', style: st.input,
            })),
          el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            el('label', { style: st.hint }, '确认密码'),
            el('input', {
              type: 'password', value: pwd2,
              onChange: function (e) { setPwd2(e.target.value); },
              autoComplete: 'new-password', style: st.input,
            }))),

        el('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          el('button', {
            type: 'button',
            onClick: savePassword,
            disabled: msgBusy,
            style: {
              padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              color: '#fff', background: 'var(--dsw-alias-state-business-primary, #2a7de1)',
              border: 'none', cursor: 'pointer',
            },
          }, authOn ? '修改密码' : '设置密码'),
          authOn
            ? el('button', {
                type: 'button',
                onClick: function () {
                  // 清除门禁必须先验证当前密码（host 侧同样校验，前端只是引导）
                  if (!currentPwd) {
                    setMsg({ type: 'err', text: '请输入当前密码以确认清除' });
                    return;
                  }
                  if (!window.confirm('确定清除远程访问密码吗？此后远程访问将不再要求输入密码。')) return;
                  setMsgBusy(true);
                  setMsg(null);
                  fetch(SET_PASSWORD_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: '', currentPassword: currentPwd }),
                  })
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                      if (!data.ok) throw new Error(data.message || data.error || '清除失败');
                      setMsg({ type: 'ok', text: '已清除远程访问密码。' });
                      setPwd1(''); setPwd2(''); setCurrentPwd('');
                      setTimeout(refresh, 300);
                    })
                    .catch(function (e) { setMsg({ type: 'err', text: String(e && e.message || e) }); })
                    .finally(function () { setMsgBusy(false); });
                },
                disabled: msgBusy,
                style: {
                  padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  color: '#c0272b', background: 'transparent',
                  border: '1px solid rgba(192,39,43,.4)', cursor: 'pointer',
                },
              }, '清除')
            : null),

        msg
          ? el('p', { style: Object.assign({}, st.hint, { color: msg.type === 'ok' ? '#0d7a3f' : '#c0272b' }) }, msg.text)
          : null);

      return el('div', { style: st.root },
        // 远程访问密码门禁（第一个卡片，最醒目）
        passwordCard,
        // 状态行
        el('div', { style: st.row },
          el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            el('p', { style: st.title }, '远程控制'),
            el('p', { style: st.sub }, '允许手机通过局域网访问并操控本电脑上的 DeepSeek Harness')),
          el('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            badge, sw)),

        // 局域网二维码卡片
        el('div', { style: st.card },
          el('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            el('p', { style: st.title }, '手机连接'),
            el('p', { style: st.sub }, '手机与电脑连接同一 Wi-Fi，用相机或浏览器扫码访问')),
          qrEl,
          status && status.url
            ? el('a', { href: status.url, style: st.link, target: '_blank', rel: 'noreferrer' }, status.url)
            : el('p', { style: st.hint }, fmtUrl(status && status.url))),

        // 统计
        el('div', { style: st.grid },
          el('div', { style: st.stat },
            el('span', { style: st.statValue }, String(count)),
            el('span', { style: st.statLabel }, '当前连接设备')),
          el('div', { style: st.stat },
            el('span', { style: st.statValue }, String(status ? (status.totalDevicesEver || 0) : 0)),
            el('span', { style: st.statLabel }, '累计设备')),
          el('div', { style: st.stat },
            el('span', { style: st.statValue }, String(status ? (status.totalHeartbeats || 0) : 0)),
            el('span', { style: st.statLabel }, '累计心跳')),
          el('div', { style: st.stat },
            el('span', { style: st.statValue }, on ? String(status ? status.lanAddresses.length : 0) : '—'),
            el('span', { style: st.statLabel }, '局域网地址'))),

        // 已连接设备列表（host 从心跳请求采集 IP / UA / 屏幕 / 网络等详情，可点击展开）
        status && status.devices && status.devices.length
          ? el('div', { style: st.card },
              el('div', { style: st.row },
                el('p', { style: st.title }, '已连接设备'),
                el('span', { style: Object.assign({}, st.badge, st.badgeOn) },
                  String(status.devices.length) + ' 台在线')),
              el('p', { style: st.hint }, '点击设备行可查看详细上报信息（屏幕 / 网络 / 页面等）'),
              el('div', { style: st.deviceList },
                status.devices.map(function (d) {
                  var open = !!expandedMap[d.id];
                  var connTxt = d.connection
                    ? ((d.connection.effectiveType || '') +
                       (d.connection.downlink ? ' · ' + d.connection.downlink + ' Mbps' : '') +
                       (d.connection.rtt !== null && d.connection.rtt !== undefined ? ' · ' + d.connection.rtt + 'ms' : ''))
                    : '';
                  return el('div', { style: st.deviceCard, key: d.id },
                    el('button', {
                      type: 'button',
                      onClick: function () { toggleExpanded(d.id); },
                      style: st.deviceHead,
                    },
                      el('span', { style: d.online ? st.dotOn : st.dotOff }),
                      el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
                        el('span', { style: st.deviceName }, d.name || '未知设备'),
                        el('span', { style: st.meta },
                          (d.ip || '未知 IP') +
                          (d.os && d.os !== '未知系统' ? ' · ' + d.os : '') +
                          (d.browser ? ' · ' + d.browser : '') +
                          (d.mobile ? ' · 移动端' : '') +
                          (connTxt ? ' · ' + connTxt : '') +
                          ' · 活跃于 ' + fmtAgo(d.lastSeen))),
                      el('span', { style: open ? st.chevronOpen : st.chevron }, '▼')),
                    open
                      ? el('div', { style: st.deviceDetail }, kvList([
                          ['IP 地址', d.ip || '未知'],
                          ['系统 / 浏览器', (d.os || '—') + ' / ' + (d.browser || '—')],
                          ['移动端标记', d.mobile ? '是' : '否'],
                          ['屏幕', d.screen || '—'],
                          ['视口', d.viewport || '—'],
                          ['像素密度', d.dpr ? d.dpr + 'x' : '—'],
                          ['触屏设备', d.touch ? '是' : '否'],
                          ['网络连接', connTxt || '—'],
                          ['设备内存', d.deviceMemory ? String(d.deviceMemory) + ' GB' : '—'],
                          ['CPU 核数', d.hardwareConcurrency ? String(d.hardwareConcurrency) : '—'],
                          ['电池', d.battery
                            ? (String(d.battery.level || 0) + '%' + (d.battery.charging ? '（充电中）' : ''))
                            : '—'],
                          ['在线状态', d.online ? '在线' : '离线'],
                          ['语言 / 平台', [d.lang, d.platform].filter(Boolean).join(' / ') || '—'],
                          ['当前页面', d.title ? (d.title + (d.path ? ' ' + d.path : '')) : (d.path || '—')],
                          ['首次连接', fmtDateTime(d.firstSeen)],
                          ['最后活跃', fmtDateTime(d.lastSeen)],
                          ['心跳次数', String(d.beatCount || 0)],
                        ]))
                      : null);
                })))
          : null,

        status && status.lanAddresses.length
          ? el('div', { style: st.card },
              el('p', { style: st.title }, '手机访问地址'),
              el('pre', { style: st.code },
                status.lanAddresses.map(function (ip) { return 'http://' + ip + ':' + status.port; }).join('\n')))
          : null,

        status && status.patchFile
          ? el('div', { style: st.card },
              el('p', { style: st.title }, '配置位置'),
              el('pre', { style: st.code }, status.patchFile))
          : null,

        // 运行时信息（进程 / 系统 / CPU / 内存，诊断用）
        status && status.runtime
          ? el('div', { style: st.card },
              el('div', { style: st.row },
                el('p', { style: st.title }, '运行时信息'),
                el('span', { style: Object.assign({}, st.badge, st.badgeOff) },
                  'PID ' + status.runtime.pid)),
              el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, kvList([
                ['运行时长', el(LiveDuration, { baseSec: status.runtime.uptime || 0, at: status.runtime.at })],
                ['开机时长', el(LiveDuration, { baseSec: status.runtime.sysUptime || 0, at: status.runtime.at })],
                ['Node.js', status.runtime.nodeVersion],
                ['主机名', status.runtime.hostname],
                ['系统', (status.runtime.platform || '—') + ' ' + (status.runtime.release || '') + ' (' + (status.runtime.arch || '—') + ')'],
                ['CPU 型号', status.runtime.cpuModel || '—'],
                ['CPU', String(status.runtime.cpus) + ' 核' + (status.runtime.cpuSpeed ? ' @ ' + status.runtime.cpuSpeed + ' MHz' : '')],
                ['系统负载', status.runtime.loadavg
                  ? ('1m ' + status.runtime.loadavg[0] + ' · 5m ' + status.runtime.loadavg[1] + ' · 15m ' + status.runtime.loadavg[2])
                  : '—'],
                ['内存', fmtBytes(status.runtime.freemem) + ' 可用 / ' + fmtBytes(status.runtime.totalmem) + ' 总计' +
                  (status.runtime.memPct !== null && status.runtime.memPct !== undefined
                    ? '（已用 ' + status.runtime.memPct + '%）'
                    : '')],
                ['RSS', fmtBytes(status.runtime.rss)],
                ['堆内存', fmtBytes(status.runtime.heapUsed) + ' / ' + fmtBytes(status.runtime.heapTotal)],
                ['Profile', status.runtime.profile],
                ['DSH 数据目录', status.runtime.dshHome],
              ])))
          : null,

        // DSH 应用层状态（版本 / 会话 / 工作区 / 插件 / 模型；后台缓存，服务不可用时不显示）
        // 默认折叠，仅展示摘要行；点击标题展开 / 收起详情。
        status && status.dsh
          ? el('div', { style: st.card },
              el('button', {
                type: 'button',
                onClick: function () { setDshOpen(!dshOpen); },
                style: Object.assign({}, st.deviceHead, { padding: '4px 0' }),
              },
                el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
                  el('div', { style: st.row },
                    el('p', { style: st.title }, 'DSH 状态'),
                    el('span', { style: Object.assign({}, st.badge, st.badgeOff) },
                      status.dsh.version ? ('v' + status.dsh.version) : '版本未知')),
                  el('span', { style: st.meta },
                    '会话 ' + (status.dsh.sessions !== null && status.dsh.sessions !== undefined ? status.dsh.sessions : '—') +
                    ' · 工作区 ' + (status.dsh.workspaces ? status.dsh.workspaces.length : '—') +
                    ' · 插件 ' + (status.dsh.plugins ? status.dsh.plugins.length : '—') +
                    ' · 模型 ' + (status.dsh.llm ? status.dsh.llm.length : '—'))),
                el('span', { style: dshOpen ? st.chevronOpen : st.chevron }, '▼')),
              dshOpen
                ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 } },
                    kvList([
                      ['版本号', status.dsh.version || '—'],
                      ['会话总数', status.dsh.sessions !== null && status.dsh.sessions !== undefined ? String(status.dsh.sessions) : '—'],
                      ['工作区数', status.dsh.workspaces ? String(status.dsh.workspaces.length) : '—'],
                      ['已装插件', status.dsh.plugins ? String(status.dsh.plugins.length) : '—'],
                      ['模型提供方', status.dsh.llm
                        ? String(status.dsh.llm.length) + '（' + status.dsh.llm.map(function (p) { return p.name || p.id; }).join('、') + '）'
                        : '—'],
                    ]),
                    status.dsh.workspaces && status.dsh.workspaces.length
                      ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 } },
                          el('span', { style: st.hint }, '工作区'),
                          status.dsh.workspaces.map(function (w, idx) {
                            return el('div', { style: st.deviceRow, key: 'ws' + idx },
                              el('span', { style: st.dotOn }),
                              el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
                                el('span', { style: st.deviceName }, w.title || w.path),
                                el('span', { style: st.meta }, w.path + ' · ' + String(w.sessionCount || 0) + ' 会话')));
                          }))
                      : null,
                    status.dsh.plugins && status.dsh.plugins.length
                      ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 } },
                          el('span', { style: st.hint }, '已安装插件'),
                          status.dsh.plugins.map(function (p, idx) {
                            return el('div', { style: st.deviceRow, key: 'pl' + idx },
                              el('span', { style: p.enabled ? st.dotOn : st.dotOff }),
                              el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
                                el('span', { style: st.deviceName }, p.name),
                                el('span', { style: st.meta }, (p.enabled ? '已启用' : '已停用') + (p.phase ? ' · ' + p.phase : ''))));
                          }))
                      : null)
                : null)
          : null,

        // 网络接口详情（网卡名 / 地址 / 掩码 / MAC）
        status && status.lanInterfaces && status.lanInterfaces.length
          ? el('div', { style: st.card },
              el('div', { style: st.row },
                el('p', { style: st.title }, '网络接口'),
                el('span', { style: Object.assign({}, st.badge, st.badgeOff) },
                  String(status.lanInterfaces.length) + ' 个 IPv4')),
              el('div', { style: st.deviceList },
                status.lanInterfaces.map(function (it) {
                  return el('div', { style: st.deviceRow, key: it.name + ':' + it.address },
                    el('span', { style: it.internal ? st.dotOff : st.dotOn }),
                    el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
                      el('span', { style: st.deviceName }, it.name + (it.internal ? '（回环）' : '')),
                      el('span', { style: st.meta },
                        it.address + (it.cidr ? ' / ' + it.cidr : '') +
                        ' · 掩码 ' + (it.netmask || '—') +
                        (it.mac ? ' · ' + it.mac : ''))));
                })))
          : null,

        // 外网访问卡片
        el('div', { style: st.card },
          el('div', { style: st.row },
            el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              el('p', { style: st.title }, '外网访问'),
              el('p', { style: st.sub }, '通过中转服务器，让外网设备访问本电脑的 DSH')),
            el('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              extBadge, extSwitch)),

          extStarted && extUrl
            ? el('a', { href: extUrl, style: st.link, target: '_blank', rel: 'noreferrer' }, extUrl)
            : null,

          // 外网隧道详细状态（域名 / 端口 / frpc 版本 / 中转服务器信息）
          extStarted && status.external
            ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 10, background: 'var(--dsw-alias-bg-base, #f0f0f1)', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))' } },
                el('div', { style: st.row },
                  el('span', { style: st.meta },
                    '域名：' + (status.external.domain || (status.external.server && status.external.server.externalDomain) || '—')),
                  el('span', { style: Object.assign({}, st.badge, st.badgeOn) }, '在线')),
                el('div', { style: st.row },
                  el('span', { style: st.meta },
                    '隧道端口：' + (status.external.tunnelPort || (status.external.server && status.external.server.tunnelPort) || '—')),
                  status.external.frpcVersion
                    ? el('span', { style: st.meta }, 'frpc v' + status.external.frpcVersion)
                    : null),
                el('div', { style: st.row },
                  el('span', { style: st.meta },
                    'frpc 进程：' + (status.external.pid ? 'PID ' + status.external.pid : '—')),
                  status.external.startedAt
                    ? el('span', { style: st.meta }, '已运行 ',
                        el(LiveDuration, { baseSec: 0, at: status.external.startedAt }))
                    : null),
                wsBadge
                  ? el('div', { style: st.row },
                      el('span', { style: st.meta }, '数据通道'),
                      el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 } },
                        wsBadge,
                        wsHint ? el('span', { style: st.hint }, wsHint) : null))
                  : null,
                el('div', { style: st.row },
                  el('span', { style: st.meta },
                    '绑定码：' + (status.external.bindCodeShort || '—')),
                  null),
                status.external.server && status.external.server.proxy
                  ? el('div', { style: st.row },
                      el('span', { style: st.meta },
                        '今日流量：↓' + fmtBytes(status.external.server.proxy.todayTrafficIn) +
                        ' · ↑' + fmtBytes(status.external.server.proxy.todayTrafficOut)),
                      el('span', { style: st.meta },
                        '当前连接：' + String(status.external.server.proxy.curConns || 0)))
                  : null,
                status.external.server && status.external.server.proxy && status.external.server.proxy.localPort
                  ? el('div', { style: st.row },
                      el('span', { style: st.meta },
                        '本地转发：127.0.0.1:' + status.external.server.proxy.localPort +
                        (status.external.server.proxy.lastStartTime ? ' · 启动 ' + status.external.server.proxy.lastStartTime : '')),
                      null)
                  : null,
                el('div', { style: st.row },
                  el('span', { style: st.meta },
                    '中转成员：' + (status.external.server ? (status.external.server.name || '—') : '—')),
                  status.external.server && status.external.server.last_seen
                    ? el('span', { style: st.meta }, '最后心跳：' + status.external.server.last_seen)
                    : null),
                status.external.server && status.external.server.status
                  ? el('div', { style: st.row },
                      el('span', { style: st.meta },
                        '服务器状态：' + (status.external.server.status === 'online'
                          ? '在线'
                          : (status.external.server.status === 'offline' ? '离线' : '未知'))),
                      status.external.server.serverTime
                        ? el('span', { style: st.meta }, '服务器时间：' + status.external.server.serverTime)
                        : null)
                  : null,
                el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 } },
                  el('button', { type: 'button', onClick: viewFrpcLog, style: st.btn }, frpcLog ? '收起日志' : '查看 frpc 日志'),
                  el('button', { type: 'button', onClick: refresh, style: st.btn }, '刷新状态')))
            : null,

          // frpc 运行日志（可点击查看）
          frpcLog
            ? el('pre', { style: Object.assign({}, st.code, { marginTop: 8, maxHeight: 220, overflowY: 'auto' }) }, frpcLog)
            : null,

          // 服务端 FRP_TOKEN 仍是占位符 → 隧道必然 502，醒目提示（后端 /status /stats 返回）
          status && status.external && status.external.server && status.external.server.frpTokenWarning
            ? el('div', { style: Object.assign({}, st.card, { borderColor: 'rgba(200,150,0,.4)' }) },
                el('p', { style: Object.assign({}, st.hint, { color: '#9a6a00' }) },
                  '⚠ ' + status.external.server.frpTokenWarning))
            : null,

          el('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              el('label', { style: st.hint }, '绑定码'),
              el('input', {
                type: 'text', value: bindCode,
                placeholder: '从中转平台获取的绑定码',
                onChange: function (e) { markEdited(); setBindCode(e.target.value); },
                style: st.input,
              })),
            el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              el('label', { style: st.hint }, '中转服务地址（可选，默认使用内置地址）'),
              el('input', {
                type: 'text', value: serverBase,
                placeholder: (status && status.external && status.external.defaultServerBase)
                  ? status.external.defaultServerBase
                  : '如 https://api.deepseekharness.desktop.cwj666.top',
                onChange: function (e) { markEdited(); setServerBase(e.target.value); },
                style: st.input,
              }))),

          extQr,

          extErrText
            ? el('div', { style: Object.assign({}, st.card, { borderColor: 'rgba(200,40,40,.35)' }) },
                el('p', { style: Object.assign({}, st.hint, { color: '#c0272b' }) }, '外网访问失败：' + extErrText),
                extLog
                  ? el('pre', { style: Object.assign({}, st.code, { marginTop: 8, maxHeight: 180, overflowY: 'auto' }) }, extLog)
                  : null,
                el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 } },
                  el('button', { type: 'button', onClick: viewFrpcLog, style: st.btn }, frpcLog ? '收起日志' : '查看 frpc 日志'),
                  el('button', { type: 'button', onClick: refresh, style: st.btn }, '刷新状态')))
            : null),

        cliHint,

        error
          ? el('div', { style: Object.assign({}, st.card, { borderColor: 'rgba(200,40,40,.35)' }) },
              el('p', { style: Object.assign({}, st.hint, { color: '#c0272b' }) }, '操作失败：' + error))
          : null);
    }

    /* ------------------------------------------------------------------ */
    /* 注册到设置页                                                        */
    /* ------------------------------------------------------------------ */

    var inject = ['slots'];

    function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots === undefined) return;

      slots.inject('settings.section', function () {
        return slots.register(
          {
            name: 'settings.section',
            id: 'remote-control',
            order: 40,
            label: '远程控制',
          },
          function () { return el(RemoteControlPanel, null); }
        );
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
