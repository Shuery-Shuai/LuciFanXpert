'use strict';
'require view';
'require rpc';
'require poll';

'require ui';
'require uci';

/* ==== BEGIN FanXpert 公共块（由 tools/sync-common.js 生成，勿手改） ==== */
/*
 * ==================== FanXpert 公共块（自动生成，勿手改） ====================
 * 单一来源：tools/common-block.js
 * 同步命令：node tools/sync-common.js     校验：node tools/sync-common.js --check
 *
 * 为什么不做成 LuCI 模块：官方模板（luci-app-example）的视图都是自包含的；
 * 跨文件模块一旦在加载器/中间层（如 CDN）出问题会导致整页加载失败，
 * 所以公共代码在构建期注入，运行期不依赖模块加载。
 * ==========================================================================
 */

var CSS_VERSION = '20260930-polish';

var PRESET_CURVES = [ 'silent', 'standard', 'performance', 'full_speed', 'fixed' ];

/* 阶梯曲线的档数（与守护进程的 STEP_LEVELS 保持一致） */
var STEP_LEVELS = 5;

/* 浅色 / 深色兜底调色板：主题没提供 LuCI 标准变量时（例如 argon）用它，保证对比度 */
var FX_PALETTE = {
	light: {
		surface: '#ffffff', surface2: '#f6f7f9', border: '#e5e9ef', borderStrong: '#d7dde5',
		text: '#202833', textDim: '#5f6b7a', textFaint: '#98a2b3', accent: '#1976d2',
		ok: '#16a34a', warn: '#b7791f', err: '#dc2626', fill: 'rgba(25,118,210,0.12)'
	},
	dark: {
		surface: '#23232f', surface2: '#1b1b26', border: '#3a3a48', borderStrong: '#4a4a5a',
		text: '#e9e9f2', textDim: '#a9a9bb', textFaint: '#7f7f92', accent: '#64b5f6',
		ok: '#81c784', warn: '#ffd54f', err: '#ef9a9a', fill: 'rgba(100,181,246,0.16)'
	}
};

var _fxDark = null;

/* 按页面实际底色的亮度判断深浅：不依赖主题是否提供变量 */
function isDarkTheme() {
	if (_fxDark !== null)
		return _fxDark;

	_fxDark = false;

	try {
		var el = document.body;

		while (el) {
			var bg = window.getComputedStyle(el).backgroundColor || '';
			var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(bg);

			if (m && (m[4] === undefined || parseFloat(m[4]) > 0.4)) {
				var lum = (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;

				_fxDark = lum < 0.5;
				return _fxDark;
			}

			el = el.parentElement;
		}

		if (window.matchMedia)
			_fxDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
	} catch (e) {}

	return _fxDark;
}

function paletteColor(key) {
	return (isDarkTheme() ? FX_PALETTE.dark : FX_PALETTE.light)[key];
}

/* 给页面根节点打上 is-dark / is-light，CSS 据此切换兜底调色板 */
function applyTheme(node) {
	var dark = isDarkTheme();

	if (node && node.classList) {
		node.classList.toggle('is-dark', dark);
		node.classList.toggle('is-light', !dark);
	}

	return dark;
}

function byId(id) {
	return document.getElementById(id);
}

function setText(id, value) {
	var el = byId(id);

	if (el)
		el.textContent = value == null || value === '' ? '--' : value;
}

function setSubText(id, value) {
	var el = byId(id);

	if (el)
		el.textContent = value == null ? '' : String(value);
}

function setNote(id, value, is_error) {
	var el = byId(id);

	if (!el)
		return;

	el.textContent = value || '';
	el.style.display = value ? '' : 'none';
	el.className = 'fanxpert-note' + (is_error ? ' is-error' : '');
}

function formatUptime(seconds) {
	var s = parseInt(seconds, 10);

	if (!isFinite(s) || s < 0)
		return null;

	if (s >= 86400)
		return _('%dd %dh').replace('%d', Math.floor(s / 86400)).replace('%d', Math.floor((s % 86400) / 3600));
	if (s >= 3600)
		return _('%dh %dm').replace('%d', Math.floor(s / 3600)).replace('%d', Math.floor((s % 3600) / 60));
	if (s >= 60)
		return _('%dm %ds').replace('%d', Math.floor(s / 60)).replace('%d', s % 60);

	return _('%ds').replace('%d', s);
}

/* 后端（ucode / shell）返回的错误文案在前端翻译；未收录的原样显示 */
var ERROR_MESSAGES = {
	'Empty response': _('Empty response'),
	'Invalid JSON response': _('Invalid JSON response'),
	'Invalid fan id': _('Invalid fan id'),
	'Invalid preset mode': _('Invalid preset mode'),
	'Invalid line count': _('Invalid line count'),
	'Invalid service action': _('Invalid service action'),
	'Fan not found': _('Fan not found'),
	'Curve not found': _('Curve not found'),
	'No fan section found': _('No fan section found'),
	'No calibration in progress': _('No calibration in progress'),
	'PWM controller not found': _('PWM controller not found'),
	'State file not found': _('State file not found'),
	'Service is running. Please stop it first.': _('Service is running. Please stop it first.'),
	'Calibration started in background': _('Calibration started in background')
};

function translateError(text) {
	if (!text)
		return text;

	if (ERROR_MESSAGES[text])
		return ERROR_MESSAGES[text];

	var m = /^Command exited with code (\d+)$/.exec(text);

	if (m)
		return _('Command exited with code %s').replace('%s', m[1]);

	return text;
}

function sectionName(section) {
	return section ? section['.name'] || section.name : null;
}

function isPresetCurve(section_id) {
	return PRESET_CURVES.indexOf(section_id) >= 0;
}

function curveDisplayName(section_id) {
	switch (section_id) {
	case 'silent':
		return _('Silent');
	case 'standard':
		return _('Standard');
	case 'performance':
		return _('Performance');
	case 'full_speed':
		return _('Full Speed');
	case 'fixed':
		return _('Fixed Speed');
	default:
		return section_id;
	}
}

function customCurveDisplayName(section_id) {
	return uci.get('fanxpert', section_id, 'label') || section_id;
}

function curveLabel(curve_id) {
	if (!curve_id)
		return null;

	return isPresetCurve(curve_id) ? curveDisplayName(curve_id) : customCurveDisplayName(curve_id);
}

function nextCustomCurveId() {
	var sections = uci.sections('fanxpert', 'curve') || [];
	var seen = {};

	for (var i = 0; i < sections.length; i++) {
		var section_id = sectionName(sections[i]);

		if (section_id)
			seen[section_id] = true;
	}

	for (var n = 1; n < 100; n++) {
		var candidate = 'custom_' + n;

		if (!seen[candidate])
			return candidate;
	}

	return 'custom_' + Date.now();
}

/* 样式表引用：版本号集中在这里，改样式时只改一处 */
function stylesheet() {
	return E('link', { 'rel': 'stylesheet', 'href': L.resource('fanxpert/fanxpert.css') + '?v=' + CSS_VERSION });
}

/* 页头：标题 + 说明，右侧可放徽标等附加节点 */
function renderHeader(title, description, extra) {
	return E('div', { 'class': 'fanxpert-header' }, [
		E('div', { 'class': 'fanxpert-header-text' }, [
			E('h2', {}, title),
			description ? E('p', { 'class': 'fanxpert-page-description' }, description) : ''
		]),
		extra || ''
	]);
}
/* ==== END FanXpert 公共块 ==== */

var FAN_ID = 'cpu_fan';
var currentFanId = FAN_ID;

var callStatus = rpc.declare({ object: 'fanxpert', method: 'status', params: [ 'fan' ], expect: { '': {} } });
var callCurveData = rpc.declare({ object: 'fanxpert', method: 'curve_data', params: [ 'fan' ], expect: { '': {} } });
var callCalibrate = rpc.declare({ object: 'fanxpert', method: 'calibrate', params: [ 'fan' ], expect: { '': {} } });
var callCalibrateProgress = rpc.declare({ object: 'fanxpert', method: 'calibrate_progress', expect: { '': {} } });
var callPreset = rpc.declare({ object: 'fanxpert', method: 'preset', params: [ 'mode' ], expect: { '': {} } });
var callStart = rpc.declare({ object: 'fanxpert', method: 'start', expect: { '': {} } });
var callStop = rpc.declare({ object: 'fanxpert', method: 'stop', expect: { '': {} } });
var callRestart = rpc.declare({ object: 'fanxpert', method: 'restart', expect: { '': {} } });
var callReload = rpc.declare({ object: 'fanxpert', method: 'reload', expect: { '': {} } });

var calibrationSession = false;
var _reloadErrorNotification = null;
var curveDataCache = null;
var liveDataPollHandle = null;
var fanxpertPollCleanupBound = false;

function cleanupLiveDataPolling() {
	if (liveDataPollHandle) {
		try {
			poll.remove(liveDataPollHandle);
		} catch (e) {}
		liveDataPollHandle = null;
	}
}

function ensureLiveDataPolling() {
	if (!fanxpertPollCleanupBound) {
		window.addEventListener('beforeunload', cleanupLiveDataPolling);
		fanxpertPollCleanupBound = true;
	}
}

function setBadge(id, text, state) {
	var el = byId(id);
	if (!el)
		return;

	el.textContent = text;
	el.className = 'fanxpert-badge' + (state ? ' is-' + state : '');
}

/* 读取 LuCI 主题变量，让画布颜色跟随浅色/深色主题 */
function themeColor(name, fallback) {
	/* 深色主题下第三方主题（如 argon）提供的变量常常不适配，直接用兜底调色板 */
	if (isDarkTheme() && fallback)
		return fallback;

	try {
		var value = window.getComputedStyle(document.documentElement).getPropertyValue(name);

		value = value ? value.trim() : '';

		return value || fallback;
	} catch (e) {
		return fallback;
	}
}

function redrawCurve() {
	if (curveDataCache)
		drawCurve(curveDataCache);
}

var _redrawScheduled = false;
var _resizeBound = false;
var _resizeObserver = null;

function scheduleCurveRedraw() {
	if (_redrawScheduled)
		return;

	_redrawScheduled = true;

	var raf = window.requestAnimationFrame || function(fn) { return window.setTimeout(fn, 16); };

	raf(function() {
		_redrawScheduled = false;
		redrawCurve();
	});
}

function bindCurveResize() {
	if (_resizeBound)
		return;

	window.addEventListener('resize', scheduleCurveRedraw);
	window.addEventListener('orientationchange', scheduleCurveRedraw);

	if (window.ResizeObserver) {
		try {
			var canvas = byId('fanxpert-curve-canvas');

			if (canvas) {
				_resizeObserver = new ResizeObserver(scheduleCurveRedraw);
				_resizeObserver.observe(canvas);
			}
		} catch (e) {}
	}

	_resizeBound = true;
}

function unbindCurveResize() {
	if (_resizeBound) {
		window.removeEventListener('resize', scheduleCurveRedraw);
		window.removeEventListener('orientationchange', scheduleCurveRedraw);
		_resizeBound = false;
	}

	if (_resizeObserver) {
		try {
			_resizeObserver.disconnect();
		} catch (e) {}
		_resizeObserver = null;
	}
}

function getCurrentFanId() {
	return currentFanId || FAN_ID;
}

function getAvailableFanIds() {
	var sections = uci.sections('fanxpert', 'fan') || [];
	var ids = [];
	var seen = {};

	for (var i = 0; i < sections.length; i++) {
		var section_id = sectionName(sections[i]);
		if (!section_id || seen[section_id])
			continue;
		seen[section_id] = true;
		ids.push(section_id);
	}

	if (!seen[FAN_ID])
		ids.unshift(FAN_ID);

	return ids;
}

function renderFanSelector() {
	var ids = getAvailableFanIds();
	var selected = getCurrentFanId();
	var options = [];

	for (var i = 0; i < ids.length; i++) {
		var fanId = ids[i];
		options.push(E('option', { 'value': fanId, 'selected': fanId === selected ? 'selected' : null }, fanId));
	}

	return E('select', {
		'id': 'fanxpert-fan-selector',
		'class': 'cbi-input-select',
		'change': function(ev) {
			currentFanId = ev.target.value || FAN_ID;
			refreshAllData();
		}
	}, options);
}

function setCalibrationProgress(progress) {
	var wrap = byId('fanxpert-calibration-progress');
	var bar = byId('fanxpert-calibration-progress-bar');
	var value = parseInt(progress, 10);

	if (!wrap || !bar)
		return;

	if (isFinite(value) && value >= 0) {
		wrap.style.display = '';
		bar.style.width = Math.min(100, Math.max(0, value)) + '%';
	} else {
		wrap.style.display = 'none';
		bar.style.width = '0';
	}
}

function renderCalibrationResult(status, data) {
	var container = byId('fanxpert-calibration-result');
	if (!container) return;

	if (!data || !data.result) {
		status = 'failed';
	}

	var typeMap = {
		'success': { cls: 'success', icon: '✓' },
		'estimated': { cls: 'estimated', icon: '⚠' },
		'failed': { cls: 'failed', icon: '✗' }
	};
	var info = typeMap[status] || typeMap['failed'];

	var title, sub, detail;
	if (status === 'success') {
		title = _('Calibration complete: start threshold %s%% (PWM: %s) [Measured]')
			.replace('%s', data.result.percent).replace('%s', data.result.pwm_value);
		sub = _('Verified with RPM feedback');
		detail = data.result.rpm ? _('Stable RPM: %s').replace('%s', data.result.rpm) : '';
	} else if (status === 'estimated') {
		title = _('Calibration complete: start threshold %s%% (PWM: %s) [Estimated]')
			.replace('%s', data.result.percent).replace('%s', data.result.pwm_value);
		sub = _('No RPM sensor detected, value is estimated. Please verify manually.');
		detail = '';
	} else {
		title = _('Calibration failed: fan not spinning (RPM sensor no response)');
		sub = (data && data.message) || _('Please check fan connection or set threshold manually.');
		detail = '';
	}

	container.className = 'fanxpert-calibration-result ' + info.cls;
	container.innerHTML = '';

	var titleEl = E('div', { 'class': 'result-title' }, info.icon + ' ' + title);
	container.appendChild(titleEl);

	if (sub) {
		container.appendChild(E('div', { 'class': 'result-sub' }, sub));
	}
	if (detail) {
		container.appendChild(E('div', { 'class': 'result-detail' }, detail));
	}
	container.style.display = '';
}

function stateFromStatus(status) {
	if (status && status.state && !status.state.error) {
		if (status.state.data) {
			return status.state.data;
		}
		return status.state;
	}
	return null;
}

function currentDevice(status) {
	var state = stateFromStatus(status);
	var fanId = getCurrentFanId();
	return state && state.devices ? state.devices[fanId] || state.devices[FAN_ID] : null;
}

function serviceRunning(status) {
	return !!(status && status.running);
}

function updateStatus(status) {
	var device = currentDevice(status);
	var state = stateFromStatus(status);
	var running = serviceRunning(status);
	var error = status && status.state && status.state.error ? status.state.error : '';
	var stats = state && state.stats ? state.stats : {};
	var daemon = state && state.daemon ? state.daemon : {};

	var rpm = device ? parseInt(device.rpm, 10) : NaN;
	var has_rpm = isFinite(rpm) && rpm > 0;

	setText('fanxpert-status-temp', device ? device.temp : null);
	setText('fanxpert-status-speed', device ? (has_rpm ? rpm : device.percent) : null);
	setText('fanxpert-status-speed-unit', has_rpm ? 'RPM' : '%');
	setText('fanxpert-status-curve', device ? (curveLabel(device.curve) || device.curve) : null);
	setText('fanxpert-status-uptime', formatUptime(daemon.uptime));

	setSubText('fanxpert-status-max-temp',
		stats.max_temp ? _('Peak: %s').replace('%s', stats.max_temp + ' °C') : '');
	setSubText('fanxpert-status-pwm', device && device.pwm != null
		? (has_rpm ? device.percent + ' % · PWM ' + device.pwm : 'PWM ' + device.pwm)
		: '');
	setSubText('fanxpert-status-fan-label', device && device.label ? device.label : '');
	setSubText('fanxpert-status-reloads',
		daemon.config_reloads != null ? _('Reloads: %s').replace('%s', daemon.config_reloads) : '');

	if (error)
		setBadge('fanxpert-service-badge', error, 'error');
	else if (running)
		setBadge('fanxpert-service-badge', _('Service running'), 'running');
	else
		setBadge('fanxpert-service-badge', _('Service stopped'), 'stopped');

	setNote('fanxpert-status-note', translateError(error), true);

	updateSensorLine(device);
	updateModeButtons(device);

	var calibrateButton = byId('fanxpert-start-calibration');
	if (calibrateButton)
		calibrateButton.disabled = running;
	setNote('fanxpert-calibration-gate-note', running ? _('Stop the service before calibration') : '');
}

function kpi(label, id, unit, sub_id, unit_id) {
	var unitAttrs = { 'class': 'fanxpert-kpi-unit' };

	if (unit_id)
		unitAttrs.id = unit_id;

	return E('div', { 'class': 'fanxpert-kpi' }, [
		E('span', { 'class': 'fanxpert-kpi-label' }, label),
		E('span', { 'class': 'fanxpert-kpi-value' }, [
			E('span', { 'id': id }, '--'),
			unit ? E('span', unitAttrs, unit) : ''
		]),
		sub_id ? E('span', { 'id': sub_id, 'class': 'fanxpert-kpi-sub' }, '') : ''
	]);
}

function renderPageHeader() {
	return renderHeader(_('FanXpert'), _('Advanced fan speed control based on temperature sensors'),
		E('span', { 'id': 'fanxpert-service-badge', 'class': 'fanxpert-badge' }, _('Loading…')));
}

function serviceButton(label, tone, call) {
	return E('button', {
		'class': 'btn cbi-button cbi-button-' + tone,
		'click': function(ev) {
			ev.preventDefault();
			call().then(refreshLiveData).catch(function(err) {
				ui.addNotification(null, E('p', err.message || String(err)), 'danger');
			});
		}
	}, label);
}

/* 四档预设模式：一键套用到所有风扇（对应 Fan Xpert 4 的预设模式） */
function applyMode(mode) {
	return callPreset(mode).then(function(res) {
		if (res && res.error) {
			ui.addNotification(null, E('p', translateError(res.error)), 'danger');
			return null;
		}

		ui.addNotification(null, E('p', _('Mode applied: %s').replace('%s', curveDisplayName(mode))), 'info');

		return refreshAllData();
	}).catch(function(err) {
		ui.addNotification(null, E('p', err.message || String(err)), 'danger');
		return null;
	});
}

/* 多测温点：显示各来源的实时温度（Fan Xpert 4 的测温点信息） */
function updateSensorLine(device) {
	var el = byId('fanxpert-status-sources');
	var list = device && device.sensors ? device.sensors : [];
	var parts = [];

	if (!el)
		return;

	for (var i = 0; i < list.length; i++) {
		var id = list[i][0];
		var temp = list[i][1];
		var label = uci.get('fanxpert', id, 'label') || id;

		parts.push(label + ' ' + temp + ' °C');
	}

	el.textContent = parts.length
		? _('Temperature sources (highest wins): ') + parts.join(' · ')
		: '';
	el.style.display = parts.length ? '' : 'none';
}

function updateModeButtons(device) {
	var curve = device ? device.curve : null;
	var active = PRESET_CURVES.indexOf(curve) >= 0 ? curve : null;

	for (var i = 0; i < PRESET_CURVES.length; i++) {
		var button = byId('fanxpert-mode-' + PRESET_CURVES[i]);

		if (button)
			button.className = 'btn cbi-button fanxpert-mode' + (active === PRESET_CURVES[i] ? ' is-active' : '');
	}

	var params = currentCurveParams();
	var fixed_mode = !!params && params.type === 'fixed';

	setText('fanxpert-curve-descr', fixed_mode
		? _('Fixed speed mode: drag the handle up or down to set the fan speed, then save to apply.')
		: _('The chart shows the curve of the current control mode; the red dot marks the live operating point. Drag the two round handles to adjust the temperature range and fan speed, then save to apply.'));

	if (!device)
		setNote('fanxpert-mode-state', '');
	else if (active)
		setNote('fanxpert-mode-state', _('Current mode: %s').replace('%s', curveDisplayName(active)));
	else
		setNote('fanxpert-mode-state', _('Custom curve in use'));
}

function renderModeRow() {
	var buttons = [];

	for (var i = 0; i < PRESET_CURVES.length; i++) {
		buttons.push(E('button', {
			'id': 'fanxpert-mode-' + PRESET_CURVES[i],
			'class': 'btn cbi-button fanxpert-mode',
			'click': (function(mode) {
				return function(ev) {
					ev.preventDefault();
					applyMode(mode);
				};
			})(PRESET_CURVES[i])
		}, curveDisplayName(PRESET_CURVES[i])));
	}

	return E('div', { 'class': 'fanxpert-modes' }, [
		E('span', { 'class': 'fanxpert-modes-label' }, _('Fan Mode')),
		E('div', { 'class': 'fanxpert-mode-buttons' }, buttons),
		E('span', { 'id': 'fanxpert-mode-state', 'class': 'fanxpert-note' })
	]);
}

function renderStatusSection() {
	return E('div', { 'class': 'cbi-section fanxpert-section' }, [
		E('h3', {}, _('Status and Control')),
		E('div', { 'class': 'cbi-section-node' }, [
			E('div', { 'class': 'fanxpert-overview' }, [
				kpi(_('Temperature'), 'fanxpert-status-temp', '°C', 'fanxpert-status-max-temp'),
				kpi(_('Fan Speed'), 'fanxpert-status-speed', '%', 'fanxpert-status-pwm', 'fanxpert-status-speed-unit'),
				kpi(_('Control Curve'), 'fanxpert-status-curve', '', 'fanxpert-status-fan-label'),
				kpi(_('Uptime'), 'fanxpert-status-uptime', '', 'fanxpert-status-reloads')
			]),
			E('div', { 'id': 'fanxpert-status-sources', 'class': 'fanxpert-sources', 'style': 'display:none' }),
			renderModeRow(),
			E('div', { 'class': 'fanxpert-toolbar' }, [
				E('span', { 'class': 'fanxpert-fan-picker' }, [
					E('label', { 'for': 'fanxpert-fan-selector' }, _('Fan')),
					renderFanSelector()
				]),
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'click': function(ev) {
						ev.preventDefault();
						refreshAllData();
					}
				}, _('Refresh Status')),
				serviceButton(_('Start Service'), 'action', callStart),
				serviceButton(_('Stop Service'), 'reset', callStop),
				serviceButton(_('Restart Service'), 'action', callRestart)
			]),
			E('div', { 'id': 'fanxpert-status-note', 'class': 'fanxpert-note', 'style': 'display:none' })
		])
	]);
}

/* 画布几何：坐标轴内边距与坐标换算共用同一组参数，避免轴与曲线错位 */
function chartMetrics(width, height) {
	var narrow = width < 460;

	return {
		width: width,
		height: height,
		narrow: narrow,
		left: narrow ? 40 : 56,
		right: narrow ? 16 : 24,
		top: 18,
		bottom: 40
	};
}

function pctY(metrics, percent) {
	var h = Math.max(1, metrics.height - metrics.top - metrics.bottom);

	return metrics.height - metrics.bottom - (percent / 100) * h;
}

function tempX(metrics, range, temp) {
	var w = Math.max(1, metrics.width - metrics.left - metrics.right);
	var span = Math.max(1, range.temp_max - range.temp_min);

	return metrics.left + ((temp - range.temp_min) / span) * w;
}

/* ============================================================
   曲线参数与拖拽编辑
   ------------------------------------------------------------
   画布上的两个锚点即曲线的起止点（temp_min/pwm_start、
   temp_max/pwm_end）。拖动时用下面的整数运算即时预览，
   公式与 fanxpert.sh 的 calculate_bezier_curve() /
   generate_curve_points() 保持一致；松手后写回表单字段，
   点“保存并应用”才真正生效。
   ============================================================ */

var MIN_TEMP_GAP = 5;
var ANCHOR_HIT_RADIUS = 14;
var curveDraft = null;
var draggingAnchor = null;
var curveDragBound = false;

function currentCurveParams() {
	var fan_id = getCurrentFanId();
	var curve_id = uci.get('fanxpert', fan_id, 'curve');

	if (!curve_id)
		return null;

	var type = uci.get('fanxpert', curve_id, 'type') || 'bezier';
	var temp_min = parseInt(uci.get('fanxpert', curve_id, 'temp_min'), 10);
	var temp_max = parseInt(uci.get('fanxpert', curve_id, 'temp_max'), 10);
	var pwm_start = parseInt(uci.get('fanxpert', curve_id, 'pwm_start'), 10);
	var pwm_end = parseInt(uci.get('fanxpert', curve_id, 'pwm_end'), 10);
	var step_levels = parseInt(uci.get('fanxpert', curve_id, 'step_levels'), 10);

	if (!isFinite(step_levels))
		step_levels = STEP_LEVELS;

	// 固定转速模式只用 pwm_start，温度区间只是画布范围
	if (type === 'fixed') {
		if (!isFinite(temp_min))
			temp_min = 0;
		if (!isFinite(temp_max))
			temp_max = 100;
		if (!isFinite(pwm_end))
			pwm_end = pwm_start;
	}

	var params = {
		curve_id: curve_id,
		type: type,
		temp_min: temp_min,
		temp_max: temp_max,
		pwm_start: pwm_start,
		pwm_end: pwm_end,
		step_levels: step_levels
	};

	if (!isFinite(params.temp_min) || !isFinite(params.temp_max) ||
	    !isFinite(params.pwm_start) || !isFinite(params.pwm_end))
		return null;

	return params;
}

function curvePwmMax() {
	var value = curveDataCache && curveDataCache.pwm_max ? parseInt(curveDataCache.pwm_max, 10) : 255;

	return isFinite(value) && value > 0 ? value : 255;
}

/* 与 fanxpert.sh 的 percent_to_pwm() / pwm_to_percent() 一致（PWM_MIN 恒为 0，整数截断） */
function percentToPwm(percent, pwm_max) {
	percent = Math.min(100, Math.max(0, percent));

	return Math.floor(pwm_max * percent / 100);
}

function pwmToPercent(pwm, pwm_max) {
	pwm = Math.min(pwm_max, Math.max(0, pwm));

	return Math.floor(pwm * 100 / pwm_max);
}

/* 与 calculate_bezier_curve() 相同：温度阈值短路、平坦曲线短路、整数贝塞尔 */
function bezierPercent(temp, temp_min, temp_max, pwm_start, pwm_end) {
	if (temp <= temp_min)
		return pwm_start;
	if (temp >= temp_max)
		return pwm_end;
	if (pwm_start === pwm_end)
		return pwm_start;

	var t = Math.floor((temp - temp_min) * 1000 / (temp_max - temp_min));
	var t2 = Math.floor(t * t / 1000);
	var t3 = Math.floor(t2 * t / 1000);
	var mt = 1000 - t;
	var mt2 = Math.floor(mt * mt / 1000);
	var mt3 = Math.floor(mt2 * mt / 1000);

	var p1 = pwm_start * mt3;
	var p2 = Math.floor((pwm_start + 10) * 3 * mt2 * t / 1000);
	var p3 = Math.floor((pwm_end - 10) * 3 * mt * t2 / 1000);
	var p4 = pwm_end * t3;

	return Math.floor((p1 + p2 + p3 + p4) / 1000);
}

/* 守护进程输出的是「百分比 → PWM → 百分比」往返后的值，这里保持一致 */
/* 线性插值（与守护进程 calculate_linear_curve 一致，除法向零截断） */
function linearPercent(temp, temp_min, temp_max, pwm_start, pwm_end) {
	if (temp <= temp_min)
		return pwm_start;
	if (temp >= temp_max)
		return pwm_end;

	return pwm_start + Math.trunc((pwm_end - pwm_start) * (temp - temp_min) / (temp_max - temp_min));
}

/* 档数钳位（与守护进程 clamp_step_levels 一致：2-20，非法值回落默认） */
function clampStepLevels(value) {
	var n = parseInt(value, 10);

	if (!isFinite(n))
		return STEP_LEVELS;

	return Math.min(20, Math.max(2, n));
}

/* 阶梯（与守护进程 calculate_step_curve 一致：温度区间等分为 N 档，N 缺省 STEP_LEVELS） */
function stepPercent(temp, temp_min, temp_max, pwm_start, pwm_end, levels) {
	if (temp <= temp_min)
		return pwm_start;
	if (temp >= temp_max)
		return pwm_end;

	levels = clampStepLevels(levels);

	var band = Math.trunc((temp - temp_min) * levels / (temp_max - temp_min)) + 1;

	return pwm_start + Math.trunc((pwm_end - pwm_start) * band / levels);
}

/* 当前曲线类型下的目标转速（%），最终经 PWM 往返取整与守护进程对齐 */
function curvePercentAt(temp, params, pwm_max) {
	var percent;

	switch (params.type) {
	case 'fixed':
		percent = params.pwm_start;
		break;
	case 'linear':
		percent = linearPercent(temp, params.temp_min, params.temp_max, params.pwm_start, params.pwm_end);
		break;
	case 'step':
		percent = stepPercent(temp, params.temp_min, params.temp_max, params.pwm_start, params.pwm_end,
			params.step_levels);
		break;
	default:
		percent = bezierPercent(temp, params.temp_min, params.temp_max, params.pwm_start, params.pwm_end);
	}

	return pwmToPercent(percentToPwm(percent, pwm_max), pwm_max);
}

/* 与 generate_curve_points() 一致：等间隔采样 */
function previewCurvePoints(params, pwm_max) {
	var step = Math.floor((params.temp_max - params.temp_min) / 20);
	var points = [];
	var t;

	if (step < 1)
		step = 1;

	for (t = params.temp_min; t <= params.temp_max; t += step)
		points.push([ t, curvePercentAt(t, params, pwm_max) ]);

	if (!points.length || points[points.length - 1][0] !== params.temp_max)
		points.push([ params.temp_max, curvePercentAt(params.temp_max, params, pwm_max) ]);

	return points;
}

function curveCanvasMetrics(canvas) {
	var width = canvas ? (canvas.clientWidth || 0) : 0;
	var height = canvas ? (canvas.clientHeight || 0) : 0;

	if (width < 80 || height < 80)
		return null;

	return chartMetrics(width, height);
}

/* 坐标轴范围以配置的温度区间为准，必要时扩展到包含当前温度 */
function curveAxisRange(data, params, current) {
	var fallback = (data && data.range) || {};

	var range = {
		temp_min: params ? params.temp_min : (fallback.temp_min != null ? fallback.temp_min : 0),
		temp_max: params ? params.temp_max : (fallback.temp_max != null ? fallback.temp_max : 100),
		pwm_min: 0,
		pwm_max: 100
	};

	if (current && current.temp > 0) {
		range.temp_min = Math.min(range.temp_min, current.temp);
		range.temp_max = Math.max(range.temp_max, current.temp);
	}

	if (range.temp_max - range.temp_min < 1)
		range.temp_max = range.temp_min + 1;

	return range;
}

function anchorPercent(value, pwm_max) {
	return pwmToPercent(percentToPwm(value, pwm_max), pwm_max);
}

function curveAnchors(metrics, range, params, pwm_max) {
	var anchors = [];

	if (!params)
		return anchors;

	if (params.type === 'fixed') {
		// 固定转速模式：单个把手，放在绘图区中间，只能上下拖动
		anchors.push({
			id: 'fixed',
			x: (metrics.left + (metrics.width - metrics.right)) / 2,
			y: pctY(metrics, anchorPercent(params.pwm_start, pwm_max))
		});

		return anchors;
	}

	anchors.push({
		id: 'start',
		x: tempX(metrics, range, params.temp_min),
		y: pctY(metrics, anchorPercent(params.pwm_start, pwm_max))
	});
	anchors.push({
		id: 'end',
		x: tempX(metrics, range, params.temp_max),
		y: pctY(metrics, anchorPercent(params.pwm_end, pwm_max))
	});

	return anchors;
}

function hitTestAnchor(metrics, range, params, x, y, radius, pwm_max) {
	var anchors = curveAnchors(metrics, range, params, pwm_max);
	var best = null;
	var best_dist = radius * radius;

	for (var i = 0; i < anchors.length; i++) {
		var dx = x - anchors[i].x;
		var dy = y - anchors[i].y;
		var dist = dx * dx + dy * dy;

		if (dist <= best_dist) {
			best_dist = dist;
			best = anchors[i].id;
		}
	}

	return best;
}

/* 温度限制在 0–100°C 且两端至少差 5°C，转速限制在 0–100% */
function clampCurveParams(params, anchor, temp, percent) {
	var next = {
		curve_id: params.curve_id,
		temp_min: params.temp_min,
		temp_max: params.temp_max,
		pwm_start: params.pwm_start,
		pwm_end: params.pwm_end
	};

	temp = Math.round(temp);
	percent = Math.round(percent);

	temp = Math.min(100, Math.max(0, temp));
	percent = Math.min(100, Math.max(0, percent));

	if (params.type === 'fixed' || anchor === 'fixed') {
		next.pwm_start = percent;
		next.pwm_end = percent;

		return next;
	}

	if (anchor === 'start') {
		next.temp_min = Math.min(temp, next.temp_max - MIN_TEMP_GAP);
		next.pwm_start = percent;
	} else {
		next.temp_max = Math.max(temp, next.temp_min + MIN_TEMP_GAP);
		next.pwm_end = percent;
	}

	if (next.temp_min < 0)
		next.temp_min = 0;
	if (next.temp_max > 100)
		next.temp_max = 100;

	return next;
}

function sameCurveParams(a, b) {
	return !!a && !!b && a.curve_id === b.curve_id &&
		a.temp_min === b.temp_min && a.temp_max === b.temp_max &&
		a.pwm_start === b.pwm_start && a.pwm_end === b.pwm_end;
}

/* 表单保存后（uci 里的值已等于草稿）就不再需要本地预览 */
function syncCurveDraft() {
	if (curveDraft && sameCurveParams(curveDraft, currentCurveParams())) {
		curveDraft = null;
		setNote('fanxpert-curve-hint', '');
	}
}

function dispatchInputChange(input) {
	try {
		if (typeof Event === 'function')
			input.dispatchEvent(new Event('change', { bubbles: true }));
	} catch (e) {}
}

/* 把拖拽结果写回表单字段，由用户点“保存并应用”生效 */
function applyCurveDraft(params) {
	if (!params || !params.curve_id)
		return 0;

	var fields = [ 'temp_min', 'temp_max', 'pwm_start', 'pwm_end' ];
	var changed = 0;

	for (var i = 0; i < fields.length; i++) {
		var input = byId('widget.cbid.fanxpert.' + params.curve_id + '.' + fields[i]);

		if (!input)
			continue;

		var value = String(params[fields[i]]);

		if (input.value !== value) {
			input.value = value;
			dispatchInputChange(input);
			changed++;
		}
	}

	setNote('fanxpert-curve-hint', changed
		? _('Curve updated in the form — click “Save & Apply” to activate it.')
		: '');

	return changed;
}

function canvasOffset(canvas, ev) {
	if (ev.offsetX != null)
		return { x: ev.offsetX, y: ev.offsetY };

	if (canvas.getBoundingClientRect) {
		var rect = canvas.getBoundingClientRect();

		return { x: (ev.clientX || 0) - rect.left, y: (ev.clientY || 0) - rect.top };
	}

	return { x: 0, y: 0 };
}

function onCurvePointerDown(ev) {
	var canvas = ev.currentTarget;
	var metrics = curveCanvasMetrics(canvas);
	var params = currentCurveParams();

	if (!metrics || !params || !curveDataCache)
		return;

	var range = curveAxisRange(curveDataCache, params, curveDataCache.current);
	var pos = canvasOffset(canvas, ev);
	var hit = hitTestAnchor(metrics, range, params, pos.x, pos.y, ANCHOR_HIT_RADIUS, curvePwmMax());

	if (!hit)
		return;

	draggingAnchor = hit;
	curveDraft = params;
	canvas.style.cursor = 'grabbing';

	if (canvas.setPointerCapture) {
		try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
	}

	if (ev.preventDefault)
		ev.preventDefault();

	drawCurve(curveDataCache);
}

function onCurvePointerMove(ev) {
	var canvas = ev.currentTarget;
	var metrics = curveCanvasMetrics(canvas);
	var params = curveDraft || currentCurveParams();

	if (!metrics || !params || !curveDataCache)
		return;

	var range = curveAxisRange(curveDataCache, params, curveDataCache.current);
	var pos = canvasOffset(canvas, ev);

	if (!draggingAnchor) {
		canvas.style.cursor = hitTestAnchor(metrics, range, params, pos.x, pos.y, ANCHOR_HIT_RADIUS, curvePwmMax())
			? 'grab' : '';

		return;
	}

	var plot_width = Math.max(1, metrics.width - metrics.left - metrics.right);
	var plot_height = Math.max(1, metrics.height - metrics.top - metrics.bottom);
	var temp = range.temp_min + (pos.x - metrics.left) / plot_width * (range.temp_max - range.temp_min);
	var percent = 100 - (pos.y - metrics.top) / plot_height * 100;

	curveDraft = clampCurveParams(params, draggingAnchor, temp, percent);

	if (ev.preventDefault)
		ev.preventDefault();

	drawCurve(curveDataCache);
}

function onCurvePointerUp(ev) {
	var canvas = ev.currentTarget;

	if (!draggingAnchor)
		return;

	var draft = curveDraft;

	draggingAnchor = null;
	canvas.style.cursor = '';

	if (canvas.releasePointerCapture) {
		try { canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
	}

	applyCurveDraft(draft);
	drawCurve(curveDataCache);
}

function bindCurveDragging() {
	if (curveDragBound)
		return;

	var canvas = byId('fanxpert-curve-canvas');

	if (!canvas || !canvas.addEventListener)
		return;

	canvas.addEventListener('pointerdown', onCurvePointerDown);
	canvas.addEventListener('pointermove', onCurvePointerMove);
	canvas.addEventListener('pointerup', onCurvePointerUp);
	canvas.addEventListener('pointercancel', onCurvePointerUp);

	curveDragBound = true;
}

function unbindCurveDragging() {
	var canvas = byId('fanxpert-curve-canvas');

	if (curveDragBound && canvas && canvas.removeEventListener) {
		canvas.removeEventListener('pointerdown', onCurvePointerDown);
		canvas.removeEventListener('pointermove', onCurvePointerMove);
		canvas.removeEventListener('pointerup', onCurvePointerUp);
		canvas.removeEventListener('pointercancel', onCurvePointerUp);
	}

	curveDragBound = false;
	draggingAnchor = null;
	curveDraft = null;
}

function drawCurveAnchors(ctx, metrics, range, params, pwm_max, colors) {
	if (!params)
		return;

	var anchors = curveAnchors(metrics, range, params, pwm_max);

	for (var i = 0; i < anchors.length; i++) {
		var point = anchors[i];
		var dragging = draggingAnchor === point.id;
		var radius = dragging ? 7.5 : 6;

		if (dragging) {
			ctx.globalAlpha = 0.25;
			ctx.fillStyle = colors.curve;
			ctx.beginPath();
			ctx.arc(point.x, point.y, radius + 5, 0, Math.PI * 2);
			ctx.fill();
			ctx.globalAlpha = 1;
		}

		ctx.beginPath();
		ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
		ctx.fillStyle = colors.surface;
		ctx.fill();
		ctx.lineWidth = 2.5;
		ctx.strokeStyle = colors.curve;
		ctx.stroke();
	}
}

function drawCurve(data) {
	var canvas = byId('fanxpert-curve-canvas');
	if (!canvas || !data || !data.curve_points || !data.range)
		return;

	var metrics = curveCanvasMetrics(canvas);

	// 页面/画布尚未布局完成（隐藏标签页、首帧）时不绘制，等 resize 或下次刷新
	if (!metrics)
		return;

	var pwm_max = curvePwmMax();
	var params = curveDraft || currentCurveParams();
	var dpr = window.devicePixelRatio || 1;
	var width = metrics.width, height = metrics.height;
	var range = curveAxisRange(data, params, data.current);
	var plotRight = width - metrics.right;
	var plotBottom = height - metrics.bottom;

	var colors = {
		grid: themeColor('--border-color-low', paletteColor('border')),
		axis: themeColor('--border-color-high', paletteColor('textFaint')),
		text: themeColor('--text-color-medium', paletteColor('textDim')),
		label: themeColor('--text-color-highest', paletteColor('text')),
		curve: themeColor('--primary-color-high', paletteColor('accent')),
		point: themeColor('--error-color-high', paletteColor('err')),
		surface: themeColor('--background-color-high', paletteColor('surface'))
	};

	canvas.width = Math.round(width * dpr);
	canvas.height = Math.round(height * dpr);

	var ctx = canvas.getContext('2d');
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, width, height);

	// 横向网格（转速刻度）
	ctx.strokeStyle = colors.grid;
	ctx.lineWidth = 1;
	ctx.setLineDash([2, 2]);
	for (var p = 0; p <= 100; p += 20) {
		var gy = pctY(metrics, p);
		ctx.beginPath();
		ctx.moveTo(metrics.left, gy);
		ctx.lineTo(plotRight, gy);
		ctx.stroke();
	}

	// 纵向网格（温度刻度）
	var step = Math.max(5, Math.ceil((range.temp_max - range.temp_min) / 5 / 5) * 5);
	ctx.beginPath();
	for (var t = range.temp_min; t <= range.temp_max; t += step) {
		var gx = tempX(metrics, range, t);
		ctx.moveTo(gx, metrics.top);
		ctx.lineTo(gx, plotBottom);
	}
	ctx.stroke();
	ctx.setLineDash([]);

	// 坐标轴
	ctx.strokeStyle = colors.axis;
	ctx.lineWidth = 1.5;
	ctx.beginPath();
	ctx.moveTo(metrics.left, metrics.top);
	ctx.lineTo(metrics.left, plotBottom);
	ctx.lineTo(plotRight, plotBottom);
	ctx.stroke();

	// 转速刻度文本与轴标题
	ctx.fillStyle = colors.text;
	ctx.font = '12px sans-serif';
	ctx.textAlign = 'right';
	ctx.textBaseline = 'middle';
	for (var q = 0; q <= 100; q += 20)
		ctx.fillText(q + '%', metrics.left - 8, pctY(metrics, q));

	ctx.save();
	if (metrics.narrow) {
		// 窄屏时纵轴标题改为横向放在轴上方，避免与刻度文字重叠
		ctx.textAlign = 'left';
		ctx.textBaseline = 'alphabetic';
		ctx.fillText(_('Fan Speed'), metrics.left, metrics.top - 6);
	} else {
		ctx.translate(14, (metrics.top + plotBottom) / 2);
		ctx.rotate(-Math.PI / 2);
		ctx.textAlign = 'center';
		ctx.fillText(_('Fan Speed'), 0, 0);
	}
	ctx.restore();

	// 温度刻度文本与轴标题
	ctx.textAlign = 'center';
	ctx.textBaseline = 'alphabetic';
	for (var t2 = range.temp_min; t2 <= range.temp_max; t2 += step)
		ctx.fillText(t2 + '°C', tempX(metrics, range, t2), plotBottom + 16);
	ctx.fillText(_('Temperature'), (metrics.left + plotRight) / 2, height - 6);

	// 曲线下方的填充
	var points = (curveDraft && params) ? previewCurvePoints(params, pwm_max) : data.curve_points;
	if (points.length > 1) {
		ctx.beginPath();
		for (var i = 0; i < points.length; i++) {
			var px = tempX(metrics, range, points[i][0]);
			var py = pctY(metrics, points[i][1]);

			if (i === 0)
				ctx.moveTo(px, py);
			else
				ctx.lineTo(px, py);
		}
		ctx.lineTo(tempX(metrics, range, points[points.length - 1][0]), plotBottom);
		ctx.lineTo(tempX(metrics, range, points[0][0]), plotBottom);
		ctx.closePath();
		ctx.globalAlpha = 0.12;
		ctx.fillStyle = colors.curve;
		ctx.fill();
		ctx.globalAlpha = 1;

		// 曲线本体
		ctx.beginPath();
		for (var j = 0; j < points.length; j++) {
			var cx0 = tempX(metrics, range, points[j][0]);
			var cy0 = pctY(metrics, points[j][1]);

			if (j === 0)
				ctx.moveTo(cx0, cy0);
			else
				ctx.lineTo(cx0, cy0);
		}
		ctx.strokeStyle = colors.curve;
		ctx.lineWidth = 2.5;
		ctx.stroke();
	}

	// 可拖拽的两个锚点（曲线起止点），当前工作点随后画在其上方
	drawCurveAnchors(ctx, metrics, range, params, pwm_max, colors);

	var current = data.current;
	if (!current || !isFinite(Number(current.temp)) || Number(current.temp) <= 0)
		return;

	var cx = tempX(metrics, range, Math.min(Math.max(current.temp, range.temp_min), range.temp_max));
	var cy = pctY(metrics, Math.min(Math.max(current.pwm_percent, range.pwm_min), range.pwm_max));

	// 当前工作点辅助线
	ctx.strokeStyle = colors.axis;
	ctx.setLineDash([5, 5]);
	ctx.beginPath();
	ctx.moveTo(cx, cy);
	ctx.lineTo(cx, plotBottom);
	ctx.moveTo(cx, cy);
	ctx.lineTo(metrics.left, cy);
	ctx.stroke();
	ctx.setLineDash([]);

	ctx.fillStyle = colors.point;
	ctx.beginPath();
	ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
	ctx.fill();

	var label = current.temp + '°C, ' + current.pwm_percent + '%';
	ctx.font = '12px sans-serif';
	var labelW = ctx.measureText(label).width + 12;
	var labelH = 22;
	var labelX = Math.min(Math.max(cx + 12, metrics.left + 8), plotRight - labelW - 8);
	var labelY = Math.min(Math.max(cy - labelH - 8, metrics.top + 8), plotBottom - labelH - 8);

	ctx.fillStyle = colors.surface;
	ctx.fillRect(labelX, labelY, labelW, labelH);
	ctx.strokeStyle = colors.point;
	ctx.lineWidth = 1;
	ctx.strokeRect(labelX, labelY, labelW, labelH);
	ctx.fillStyle = colors.label;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	ctx.fillText(label, labelX + 6, labelY + labelH / 2);
}

function renderRpmTable(data) {
	var container = byId('fanxpert-rpm-table');
	var note = byId('fanxpert-rpm-note');
	if (!container)
		return;

	var samples = {};
	var rows = data && data.rpm_table ? data.rpm_table : [];

	for (var i = 0; i < rows.length; i++) {
		var bucket = parseInt(rows[i][0], 10);
		var rpm = parseInt(rows[i][1], 10);

		if (isFinite(bucket) && isFinite(rpm) && rpm > 0)
			samples[bucket] = rpm;
	}

	container.innerHTML = '';

	if (Object.keys(samples).length === 0) {
		container.textContent = _('No RPM data (no sensor, or not sampled yet)');
		if (note)
			note.style.display = 'none';

		return;
	}

	if (note)
		note.style.display = '';

	var body = [];

	// 与 Fan Xpert 4 一致：从最高档位向下排列
	for (var p = 100; p >= 0; p -= 10) {
		body.push(E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, p + ' %'),
			E('td', { 'class': 'td fanxpert-rpm-value' }, samples[p] ? String(samples[p]) : '—')
		]));
	}

	container.appendChild(E('table', { 'class': 'table fanxpert-rpm-table' }, [
		E('thead', {}, [
			E('tr', { 'class': 'tr' }, [
				E('th', { 'class': 'th' }, _('Power')),
				E('th', { 'class': 'th fanxpert-rpm-value' }, _('Minimum RPM'))
			])
		]),
		E('tbody', {}, body)
	]));
}

function updateCurveMeta(data) {
	if (!data)
		return;

	syncCurveDraft();

	var range = data.range || {};
	var current = data.current || {};
	var curve_id = uci.get('fanxpert', getCurrentFanId(), 'curve');

	setText('fanxpert-curve-name', curveLabel(curve_id) || curve_id);
	setText('fanxpert-curve-temp-range',
		range.temp_min != null && range.temp_max != null ? range.temp_min + ' – ' + range.temp_max + ' °C' : null);
	setText('fanxpert-curve-pwm-range',
		range.pwm_min != null && range.pwm_max != null ? range.pwm_min + ' – ' + range.pwm_max + ' %' : null);
	setText('fanxpert-curve-point',
		current.temp > 0 ? current.temp + ' °C / ' + current.pwm_percent + ' %' : null);

	renderRpmTable(data);
}

function updateCurveCurrentFromStatus(status) {
	var device = currentDevice(status);

	if (!curveDataCache || !device)
		return;

	var temp = Number(device.temp);
	var percent = Number(device.percent);

	if (!isFinite(temp) || !isFinite(percent))
		return;

	curveDataCache.current = {
		temp: temp,
		pwm_percent: percent
	};

	updateCurveMeta(curveDataCache);
	drawCurve(curveDataCache);
}

function renderCurveSection() {
	return E('div', { 'class': 'cbi-section fanxpert-section' }, [
		E('h3', {}, _('Temperature / Fan Speed Curve')),
		E('div', { 'id': 'fanxpert-curve-descr', 'class': 'cbi-section-descr' },
			_('The chart shows the curve of the current control mode; the red dot marks the live operating point. Drag the two round handles to adjust the temperature range and fan speed, then save to apply.')),
		E('div', { 'class': 'cbi-section-node' }, [
			E('div', { 'class': 'fanxpert-chart-row' }, [
				E('div', { 'class': 'fanxpert-chart-main' }, [
					E('canvas', {
						'id': 'fanxpert-curve-canvas',
						'class': 'fanxpert-canvas',
						'width': '960',
						'height': '320'
					}),
					E('div', { 'class': 'fanxpert-chart-meta' }, [
						E('span', {}, [ _('Control Curve') + ': ', E('strong', { 'id': 'fanxpert-curve-name' }, '--') ]),
						E('span', {}, [ _('Temperature Range') + ': ', E('strong', { 'id': 'fanxpert-curve-temp-range' }, '--') ]),
						E('span', {}, [ _('Speed Range') + ': ', E('strong', { 'id': 'fanxpert-curve-pwm-range' }, '--') ]),
						E('span', {}, [ _('Operating Point') + ': ', E('strong', { 'id': 'fanxpert-curve-point' }, '--') ]),
						E('span', { 'id': 'fanxpert-curve-hint', 'class': 'fanxpert-note' })
					])
				]),
				E('div', { 'class': 'fanxpert-chart-side' }, [
					E('h4', { 'class': 'fanxpert-side-title' }, _('Power → Minimum RPM')),
					E('div', { 'id': 'fanxpert-rpm-table' }),
					E('p', { 'id': 'fanxpert-rpm-note', 'class': 'fanxpert-note' },
						_('Lowest RPM observed per power step since the service started.'))
				])
			])
		])
	]);
}

function renderCalibrationSection() {
	return E('div', { 'class': 'cbi-section fanxpert-section' }, [
		E('h3', {}, _('Fan Start Threshold Calibration')),
		E('div', { 'class': 'cbi-section-descr' },
			_('Detects the lowest PWM value that reliably starts the fan and stores it in the configuration. The service must be stopped.')),
		E('div', { 'class': 'cbi-section-node' }, [
			E('div', { 'class': 'fanxpert-toolbar' }, [
				E('button', {
					'id': 'fanxpert-start-calibration',
					'class': 'btn cbi-button cbi-button-action',
					'click': function(ev) {
						ev.preventDefault();
						callCalibrate(getCurrentFanId()).then(function(res) {
							ui.addNotification(null, E('p', res.error ? translateError(res.error) : (res.message || _('Calibration started'))), res.error ? 'danger' : 'info');
							if (!res.error) {
								calibrationSession = true;
								setNote('fanxpert-calibration-note', _('Calibration started') + ' (0%)');
								setCalibrationProgress(0);
								refreshAllData();
							}
						}).catch(function(err) {
							ui.addNotification(null, E('p', err.message || String(err)), 'danger');
						});
					}
				}, _('Start Calibration'))
			]),
			E('div', { 'id': 'fanxpert-calibration-gate-note', 'class': 'fanxpert-note', 'style': 'display:none' }),
			E('div', { 'id': 'fanxpert-calibration-note', 'class': 'fanxpert-note', 'style': 'display:none' }),
			E('div', { 'id': 'fanxpert-calibration-progress', 'class': 'fanxpert-progress' }, [
				E('span', { 'id': 'fanxpert-calibration-progress-bar' }, '')
			]),
			E('div', { 'id': 'fanxpert-calibration-result', 'class': 'fanxpert-calibration-result' })
		])
	]);
}

function refreshLiveData() {
	return Promise.all([
		callStatus(getCurrentFanId()).catch(function(err) { return { state: { error: err.message || String(err) } }; }),
		callCalibrateProgress().catch(function() { return null; })
	]).then(function(data) {
		updateStatus(data[0]);
		updateCurveCurrentFromStatus(data[0]);

		// 检查重载失败状态
		var lastReload = data[0].state && data[0].state.daemon && data[0].state.daemon.last_reload;
		if (lastReload && lastReload.status === 'failed') {
			if (!_reloadErrorNotification) {
				_reloadErrorNotification = ui.addNotification(
					null,
					E('p', _('Config reload failed: ') + (lastReload.error || _('unknown error')) + _(', please check system logs')),
					'danger',
					{ duration: 0 }
				);
			}
		} else {
			if (_reloadErrorNotification) {
				_reloadErrorNotification.remove();
				_reloadErrorNotification = null;
			}
		}

		if (data[1] && !data[1].error) {
			if (data[1].status === 'running') calibrationSession = true;
			if (!calibrationSession && data[1].status !== 'running' && data[1].status !== 'completed' && data[1].status !== 'failed') {
				setNote('fanxpert-calibration-note', '');
				setCalibrationProgress(null);
				return;
			}

			var note = data[1].message || data[1].stage || '';
			if (data[1].progress != null)
				note = note ? note + ' (' + data[1].progress + '%)' : data[1].progress + '%';
			setNote('fanxpert-calibration-note', note);

			// 校准完成或失败时渲染结果卡片
			if (data[1].status === 'completed') {
				var type = data[1].feedback_available ? 'success' : 'estimated';
				if (data[1].fallback) type = 'estimated';
				setCalibrationProgress(100);
				renderCalibrationResult(type, data[1]);
			} else if (data[1].status === 'failed') {
				setCalibrationProgress(100);
				renderCalibrationResult('failed', data[1]);
			} else {
				setCalibrationProgress(data[1].progress);
				var resultEl = byId('fanxpert-calibration-result');
				if (resultEl) resultEl.style.display = 'none';
			}
		}
	});
}

function refreshCurveData() {
	return callCurveData(getCurrentFanId()).then(function(data) {
		if (!data.error) {
			curveDataCache = data;
			updateCurveMeta(data);
			drawCurve(data);
		}
		return data;
	}).catch(function(err) {
		return { error: err.message || String(err) };
	});
}

function refreshAllData() {
	return Promise.all([
		refreshCurveData(),
		refreshLiveData()
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('fanxpert'),
			callStatus(getCurrentFanId()).catch(function(err) { return { state: { error: err.message || String(err) } }; }),
			callCurveData(getCurrentFanId()).catch(function(err) { return { error: err.message || String(err) }; })
		]);
	},

	render: function(data) {
		var node = E('div', { 'class': 'fanxpert-page' }, [
			stylesheet(),
			renderPageHeader(),
			renderStatusSection(),
			renderCurveSection(),
			renderCalibrationSection()
		]);

		window.setTimeout(function() {
				applyTheme(node);
				updateStatus(data[1]);
				if (!data[2].error) {
					curveDataCache = data[2];
					updateCurveMeta(data[2]);
					drawCurve(data[2]);
				}
				ensureLiveDataPolling();
				cleanupLiveDataPolling();
				liveDataPollHandle = poll.add(refreshLiveData, 3);
			bindCurveResize();
			bindCurveDragging();
			scheduleCurveRedraw();
		}, 0);

		return node;
	},

	unload: function() {
		cleanupLiveDataPolling();
		unbindCurveResize();
		unbindCurveDragging();
		if (_reloadErrorNotification) {
			try {
				_reloadErrorNotification.remove();
			} catch (e) {}
			_reloadErrorNotification = null;
		}
	}
});
