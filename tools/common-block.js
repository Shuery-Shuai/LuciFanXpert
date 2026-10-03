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
