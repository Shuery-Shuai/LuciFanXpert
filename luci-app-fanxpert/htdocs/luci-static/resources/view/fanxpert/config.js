'use strict';
'require view';
'require form';
'require rpc';
'require uci';
'require ui';

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


/*
 * FanXpert 配置页面
 * ---------------------------------------------------------------------------
 * 全局设置、风扇设备（含测温点 / 极致静音 / 自动停转 / 升降速）、预设曲线与
 * 自定义曲线。保存后通过 fanxpert.reload 让守护进程热重载配置。
 */

var FAN_ID = 'cpu_fan';

var callReload = rpc.declare({ object: 'fanxpert', method: 'reload', expect: { '': {} } });

function addCurveOptions(section) {
	var o;
	o = section.option(form.ListValue, 'type', _('Curve Type'));
	o.value('bezier', _('Bezier (Smooth)'));
	o.value('linear', _('Linear'));
	o.value('step', _('Stepped (%d levels)').replace('%d', '5'));
	o.value('fixed', _('Fixed Speed'));
	o.default = 'bezier';
	o.description = _('Bezier/Linear/Stepped use the temperature range below; Fixed Speed ignores temperature and just holds the start speed.');

	o = section.option(form.ListValue, 'step_levels', _('Step Levels'));
	o.value('3', _('3 levels'));
	o.value('4', _('4 levels'));
	o.value('5', _('5 levels (default)'));
	o.value('6', _('6 levels'));
	o.value('8', _('8 levels'));
	o.value('10', _('10 levels'));
	o.value('12', _('12 levels'));
	o.default = '5';
	o.description = _('Only used by the stepped curve: the temperature range is split into this many steps.');

	o = section.option(form.Value, 'temp_min', _('Min Temp (°C)'));
	o.datatype = 'range(0,100)';
	o.placeholder = '35';

	o = section.option(form.Value, 'temp_max', _('Max Temp (°C)'));
	o.datatype = 'range(0,100)';
	o.placeholder = '75';

	o = section.option(form.Value, 'pwm_start', _('Start Speed (%)'));
	o.datatype = 'range(0,100)';
	o.placeholder = '30';

	o = section.option(form.Value, 'pwm_end', _('Max Speed (%)'));
	o.datatype = 'range(0,100)';
	o.placeholder = '100';
}

function addPresetCurveName(section) {
	var o = section.option(form.DummyValue, '_curve_name', _('Curve'));
	o.rawhtml = false;
	o.cfgvalue = function(section_id) {
		return curveDisplayName(section_id);
	};
}

function addCurveChoices(option) {
	var seen = {};

	for (var i = 0; i < PRESET_CURVES.length; i++) {
		option.value(PRESET_CURVES[i], curveDisplayName(PRESET_CURVES[i]));
		seen[PRESET_CURVES[i]] = true;
	}

	var sections = uci.sections('fanxpert', 'curve') || [];
	for (var j = 0; j < sections.length; j++) {
		var section_id = sectionName(sections[j]);
		if (!section_id || seen[section_id] || isPresetCurve(section_id))
			continue;

		option.value(section_id, customCurveDisplayName(section_id));
		seen[section_id] = true;
	}

	var selected = uci.get('fanxpert', FAN_ID, 'curve');
	if (selected && !seen[selected])
		option.value(selected, selected);
}

function addCustomCurveMeta(section) {
	/* 温度来源已移到风扇级（fan.sensors，支持最多 3 个测温点取最高） */
	var o = section.option(form.Value, 'label', _('Name'));
	o.placeholder = _('Custom Curve');
}

return view.extend({
	load: function() {
		return uci.load('fanxpert');
	},

	render: function() {
		var m, s, o;

		m = new form.Map('fanxpert');
		m.on_after_commit = function() {
			/* 配置页没有实时面板，保存后只需让守护进程热重载并提示用户 */
			return callReload().then(function() {
				ui.addNotification(null, E('p', _('Configuration saved; the daemon reloaded it.')), 'info');
			}).catch(function() {});
		};

		s = m.section(form.NamedSection, 'settings', 'global', _('Global Settings'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Enable FanXpert'));
		o.rmempty = false;
		o.default = '0';

		o = s.option(form.ListValue, 'log_level', _('Log Level'));
		o.value('err', _('Error'));
		o.value('warn', _('Warning'));
		o.value('notice', _('Notice'));
		o.value('info', _('Info'));
		o.value('debug', _('Debug'));
		o.default = 'info';

		s = m.section(form.NamedSection, FAN_ID, 'fan', _('Fan Devices'));
		s.addremove = false;
		s.tab('basic', _('Basic'));
		s.tab('hardware', _('Hardware'));

		o = s.taboption('basic', form.Flag, 'enabled', _('Enabled'));
		o.rmempty = false;

		o = s.taboption('basic', form.Value, 'label', _('Label'));
		o.placeholder = 'CPU Fan';

		o = s.taboption('basic', form.ListValue, 'curve', _('Control Mode'));
		addCurveChoices(o);
		o.default = 'standard';

		o = s.taboption('hardware', form.Value, 'pwm_min_start', _('Fan Start Threshold (%)'));
		o.datatype = 'range(0,100)';
		o.placeholder = '10';
		o.description = _('Minimum PWM percentage to start the fan (0-100%)');

		o = s.taboption('hardware', form.DummyValue, 'pwm_min_start_source', _('Calibration Source'));
		o.rawhtml = true;
		o.cfgvalue = function(section_id) {
			var src = uci.get('fanxpert', section_id, 'pwm_min_start_source');
			if (src === 'measured') return _('Measured (verified)');
			if (src === 'estimated') return _('Estimated (no RPM sensor)');
			return _('Unknown / Manual');
		};

		o = s.taboption('hardware', form.DummyValue, 'pwm_min_start_timestamp', _('Calibration Time'));
		o.cfgvalue = function(section_id) {
			var ts = parseInt(uci.get('fanxpert', section_id, 'pwm_min_start_timestamp') || '0');
			if (ts > 0) {
				return new Date(ts * 1000).toLocaleString();
			}
			return '--';
		};

		/* 校准是「极致静音」的前置条件，自动停转又需要极致静音（与 Fan Xpert 4 一致）。
		 * 未满足条件时置为只读并在说明里写明原因。 */
		var fan_min_start = parseInt(uci.get('fanxpert', FAN_ID, 'pwm_min_start') || '0', 10);
		var fan_min_source = uci.get('fanxpert', FAN_ID, 'pwm_min_start_source') || 'unknown';
		var fan_calibrated = isFinite(fan_min_start) && fan_min_start > 0 &&
			(fan_min_source === 'measured' || fan_min_source === 'estimated');
		var fan_quiet_on = uci.get('fanxpert', FAN_ID, 'quiet_mode') === '1';

		o = s.taboption('hardware', form.Flag, 'quiet_mode', _('Extreme Quiet'));
		o.rmempty = false;
		o.default = '0';
		o.description = fan_calibrated
			? _('Lowers fan speed by 15% to reduce noise, never below the calibrated start threshold.')
			: _('Requires a completed fan calibration first.');
		if (!fan_calibrated)
			o.readonly = true;

		o = s.taboption('hardware', form.Flag, 'auto_stop', _('Auto Fan Stop'));
		o.rmempty = false;
		o.default = '0';
		o.description = (fan_calibrated && fan_quiet_on)
			? _('Stops the fan when the target speed falls below the calibrated start threshold.')
			: _('Requires Extreme Quiet and a completed calibration.');
		if (!fan_calibrated || !fan_quiet_on)
			o.readonly = true;

		o = s.taboption('hardware', form.Value, 'ramp_up_time', _('Ramp Up Time (s)'));
		o.datatype = 'range(0,300)';
		o.placeholder = '30';
		o.description = _('Shortest time to go from minimum to maximum speed; 0 disables the limit.');

		o = s.taboption('hardware', form.Value, 'ramp_down_time', _('Ramp Down Time (s)'));
		o.datatype = 'range(0,300)';
		o.placeholder = '120';
		o.description = _('Shortest time to go from maximum to minimum speed; 0 disables the limit.');

		o = s.taboption('hardware', form.MultiValue, 'sensors', _('Temperature Sources'));
		var sensor_sections = uci.sections('fanxpert', 'sensor') || [];
		for (var si = 0; si < sensor_sections.length; si++) {
			var sensor_id = sectionName(sensor_sections[si]);
			if (sensor_id)
				o.value(sensor_id, uci.get('fanxpert', sensor_id, 'label') || sensor_id);
		}
		o.description = _('Up to 3 sources; the highest reading drives the fan.');

		o = s.taboption('hardware', form.ListValue, 'pwm_path', _('PWM Controller'));
		o.value('auto', _('Auto Detect'));
		o.default = 'auto';
		o.description = _('Leave as auto for automatic detection');

		s = m.section(form.TableSection, 'curve', _('Preset Curves'));
		s.anonymous = true;
		s.addremove = false;
		s.filter = function(section_id) {
			return isPresetCurve(section_id);
		};
		addPresetCurveName(s);
		addCurveOptions(s);

		s = m.section(form.TableSection, 'curve', _('Custom Curves'));
		s.anonymous = true;
		s.addremove = true;
		s.addbtntitle = _('Add Custom Curve');
		s.filter = function(section_id) {
			return !isPresetCurve(section_id);
		};
		s.create = function() {
			var section_id = nextCustomCurveId();

			uci.add('fanxpert', 'curve', section_id);
			uci.set('fanxpert', section_id, 'label', _('Custom Curve'));
			uci.set('fanxpert', section_id, 'type', 'bezier');
			uci.set('fanxpert', section_id, 'step_levels', '5');
			uci.set('fanxpert', section_id, 'sensor', 'cpu_temp');
			uci.set('fanxpert', section_id, 'temp_min', '35');
			uci.set('fanxpert', section_id, 'temp_max', '75');
			uci.set('fanxpert', section_id, 'pwm_start', '30');
			uci.set('fanxpert', section_id, 'pwm_end', '100');

			return section_id;
		};
		addCustomCurveMeta(s);
		addCurveOptions(s);
		return m.render().then(function(formNode) {
			var node = E('div', { 'class': 'fanxpert-page' }, [
				stylesheet(),
				renderHeader(_('Configuration'), _('Fan curve, temperature sources and advanced fan options.')),
				formNode
			]);

			/* 挂载后再按页面实际底色决定深浅兜底调色板 */
			window.setTimeout(function() { applyTheme(node); }, 0);

			return node;
		});
	}
});
