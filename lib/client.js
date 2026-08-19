// dsh-mobile-remote — DSH 移动端远程控制插件（client 侧）。
//
// 在 Web UI 的「设置」中注册一个「远程控制」section，提供：
//   1. 开启 / 关闭开关（写入 / 移除 profile patch，经 HMR 热重载生效）；
//   2. 连接二维码（通过 host 的 /__dsh_remote/qr 接口返回 SVG）；
//   3. 当前连接的设备数量（host 侧心跳统计）。
//
// 打包格式：浏览器 module loader（window.__ModuleLoader__.load）标准 bundle，
// 与官方 client 插件一致。纯 React.createElement，无 JSX 构建依赖。

window.__ModuleLoader__.load({
  id: 'dsh-mobile-remote',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var el = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;

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
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
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
      button: {
        alignSelf: 'flex-start', padding: '8px 16px', borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
        background: 'transparent', color: 'var(--dsw-alias-label-primary, #1f1f1f)',
        fontSize: 13, fontWeight: 500, cursor: 'pointer',
      },
      divider: { height: 1, background: 'var(--dsw-alias-border-l2, rgba(127,127,127,.18))', border: 'none' },
      disabled: { opacity: 0.55 },
    };

    /* ------------------------------------------------------------------ */
    /* 远程控制面板                                                        */
    /* ------------------------------------------------------------------ */

    var STATUS_URL = '/__dsh_remote/status';
    var TOGGLE_URL = '/__dsh_remote/toggle';

    function fmtUrl(url) {
      return url || '未检测到局域网地址';
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

      // 状态徽标
      var on = !!(status && status.remoteEnabled);
      var badge = el('span', { style: Object.assign({}, st.badge, on ? st.badgeOn : st.badgeOff) },
        on ? '已开启' : '未开启');

      // 开关
      var sw = el('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': String(on),
        'aria-label': on ? '关闭远程控制' : '开启远程控制',
        onClick: toggle,
        disabled: busy || !status,
        style: Object.assign({}, st.switch, on ? st.switchOn : null),
      }, el('span', { style: Object.assign({}, st.knob, on ? st.knobOn : null) }));

      // 二维码
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

      // 命令提示（未开启时展示 CLI 启动方式）
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

      return el('div', { style: st.root },
        // 状态行
        el('div', { style: st.row },
          el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            el('p', { style: st.title }, '远程控制'),
            el('p', { style: st.sub }, '允许手机通过局域网访问并操控本电脑上的 DeepSeek Harness')),
          el('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            badge, sw)),

        // 二维码卡片
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
            el('span', { style: st.statValue }, on ? String(status ? status.lanAddresses.length : 0) : '—'),
            el('span', { style: st.statLabel }, '局域网地址'))),

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
