#!/usr/bin/env node
/*
 * FanXpert 视图自检 / 预览生成
 * ---------------------------------------------------------------------------
 * 用最小化的 LuCI 桩（form / rpc / poll / ui / uci / E / _ / document）加载
 * luci-static/resources/view/fanxpert.js，然后：
 *
 *   1. 结构自检（默认行为）：验证页头、状态徽标、KPI、曲线区、校准区等节点齐全，
 *      并用桩数据驱动一次实时刷新，检查文案与状态类名是否正确。
 *   2. 生成静态预览：--html <路径> 时把真实渲染出的标记（markup）写成 HTML，
 *      内联真实的 fanxpert.css，并用真实的 drawCurve() 绘制曲线图。
 *
 * 用法：
 *   node tools/view-check.js
 *   node tools/view-check.js --html tmp/fanxpert-preview.html
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VIEW = path.join(ROOT, 'luci-app-fanxpert/htdocs/luci-static/resources/view/fanxpert/overview.js');
const LOG_VIEW = path.join(ROOT, 'luci-app-fanxpert/htdocs/luci-static/resources/view/fanxpert/logs.js');
const VIEW_DIR = path.join(ROOT, 'luci-app-fanxpert/htdocs/luci-static/resources/view/fanxpert');
const CONFIG_VIEW = path.join(ROOT, 'luci-app-fanxpert/htdocs/luci-static/resources/view/fanxpert/config.js');
const CSS = path.join(ROOT, 'luci-app-fanxpert/htdocs/luci-static/resources/fanxpert/fanxpert.css');

const argv = process.argv.slice(2);
const htmlIndex = argv.indexOf('--html');
const htmlOut = htmlIndex >= 0 ? path.resolve(process.cwd(), argv[htmlIndex + 1] || 'fanxpert-preview.html') : null;
const curveIndex = argv.indexOf('--curve');
const previewCurve = curveIndex >= 0 ? argv[curveIndex + 1] : 'standard';
const previewFixed = previewCurve === 'fixed';
const viewIndex = argv.indexOf('--view');
const previewView = viewIndex >= 0 ? argv[viewIndex + 1] : 'main';
const noBanner = argv.includes('--no-banner');
const themeIndex = argv.indexOf('--theme-css');
const themeCss = themeIndex >= 0
	? (argv[themeIndex + 1] || '').split(',').filter(Boolean)
		.map(function (f) { return fs.readFileSync(path.resolve(process.cwd(), f), 'utf8'); }).join('\n')
	: '';

/* ============================================================
   1. 最小 LuCI / DOM 桩
   ============================================================ */

const els = {};

function stubContext2d() {
	const ctx = {
		_arcs: [], _lines: [], _texts: [],
		strokeStyle: '', fillStyle: '', lineWidth: 1, globalAlpha: 1, font: '',
		textAlign: '', textBaseline: '',
		setTransform: function () {}, clearRect: function () {}, beginPath: function () {},
		closePath: function () {}, stroke: function () {}, fill: function () {},
		save: function () {}, restore: function () {}, translate: function () {}, rotate: function () {},
		setLineDash: function () {}, fillRect: function () {}, strokeRect: function () {},
		fillText: function (t) { ctx._texts.push(String(t)) },
		measureText: function (t) { return { width: 6 * String(t).length } },
		moveTo: function (x, y) { ctx._lines.push([ x, y ]) },
		lineTo: function (x, y) { ctx._lines.push([ x, y ]) },
		arc: function (x, y, r) { ctx._arcs.push({ x: x, y: y, r: r }) }
	};

	return ctx;
}

function stubElement(id) {
	if (!els[id]) {
		const listeners = {};
		const el = {
			id: id, textContent: '', className: '', disabled: false, value: '',
			style: {}, width: 0, height: 0, clientWidth: 0, clientHeight: 0,
			childNodes: [], dispatched: [], context2d: stubContext2d(),
			appendChild: function (child) { this.childNodes.push(child); return child; },
			getContext: function () { return el.context2d; },
			getBoundingClientRect: function () { return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight } },
			setPointerCapture: function () {}, releasePointerCapture: function () {},
			addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn) },
			removeEventListener: function (type, fn) {
				listeners[type] = (listeners[type] || []).filter(function (f) { return f !== fn });
			},
			dispatchEvent: function (ev) { el.dispatched.push(ev && ev.type); return true },
			fire: function (type, ev) {
				(listeners[type] || []).forEach(function (fn) { fn(ev) });
			},
			listenerCount: function (type) { return (listeners[type] || []).length }
		};

		/* 与真实 DOM 一致：innerHTML 置空会移除子节点 */
		Object.defineProperty(el, 'innerHTML', {
			get: function () { return el._html || ''; },
			set: function (value) {
				el._html = value;
				if (!value)
					el.childNodes.length = 0;
			}
		});

		els[id] = el;
	}

	return els[id];
}

function resetElements() {
	Object.keys(els).forEach(function (key) { delete els[key]; });
}

function flatten(children, out) {
	if (children == null || children === false)
		return;

	if (Array.isArray(children)) {
		children.forEach(function (child) { flatten(child, out); });
		return;
	}

	out.push(children);
}

function E(tag, attrs, children) {
	const kids = [];
	flatten(children, kids);

	/* 返回类 DOM 节点：便于断言，也支持像 LuCI 的 E() 那样继续 appendChild */
	return {
		tag: tag,
		attrs: attrs || {},
		children: kids,
		childNodes: kids,
		appendChild: function (child) { kids.push(child); return child; }
	};
}

function walk(node, fn) {
	if (node == null || typeof node === 'string')
		return;

	fn(node);
	(node.children || []).forEach(function (child) { walk(child, fn); });
}

const documentStub = {
	getElementById: stubElement,
	documentElement: {},
	addEventListener: function () {},
	removeEventListener: function () {}
};

const windowStub = {
	addEventListener: function () {},
	removeEventListener: function () {},
	setTimeout: function (fn) { fn(); return 0; },
	requestAnimationFrame: function (fn) { fn(); return 0; },
	getComputedStyle: function () { return { getPropertyValue: function () { return ''; } }; },
	devicePixelRatio: 1
};

const localization = function (s) { return s; };
const L = {
	resource: function (p) { return '/luci-static/resources/' + p; },
	/* 模块用 L.Class.extend() 导出（LuCI 官方共享模块的写法） */
	Class: { extend: function (props) { return BaseClassStub.extend(props); } }
};

let pollCallback = null;
let pollRemovals = 0;
const poll = {
	add: function (fn) { pollCallback = fn; return 'handle'; },
	remove: function () { pollRemovals++; }
};

const rpcState = { status: {}, curve: {}, progress: {} };
const rpcCalls = [];
const rpc = {
	declare: function (def) {
		return function () {
			rpcCalls.push({ method: def.method, args: Array.prototype.slice.call(arguments) });

			if (def.method === 'status') return Promise.resolve(rpcState.status);
			if (def.method === 'curve_data') return Promise.resolve(rpcState.curve);
			if (def.method === 'calibrate_progress') return Promise.resolve(rpcState.progress);
			if (def.method === 'logs') return Promise.resolve(rpcState.logs);
			return Promise.resolve({ ok: true });
		};
	}
};

const uciValues = {
	fanxpert: {
		cpu_fan: {
			curve: 'standard', label: 'CPU Fan', quiet_mode: '1',
			pwm_min_start: '25', pwm_min_start_source: 'measured'
		},
		standard: { temp_min: '35', temp_max: '75', pwm_start: '30', pwm_end: '100' },
		custom_1: { label: 'Quiet Case', temp_min: '40', temp_max: '70', pwm_start: '20', pwm_end: '80' },
		cpu_temp: { label: 'CPU Temperature', type: 'hwmon', platform: 'auto' },
		wifi_temp: { label: 'WiFi', type: 'hwmon', platform: 'auto' }
	}
};
const uci = {
	load: function () { return Promise.resolve(); },
	sections: function (pkg, type) {
		if (type === 'sensor')
			return [{ '.name': 'cpu_temp' }, { '.name': 'wifi_temp' }];
		if (type === 'curve')
			return [{ '.name': 'standard' }, { '.name': 'custom_1' }];
		return [{ '.name': 'cpu_fan' }];
	},
	get: function (pkg, section, option) {
		return uciValues[pkg] && uciValues[pkg][section] ? uciValues[pkg][section][option] : null;
	},
	add: function () {}, set: function () {}, save: function () {}, apply: function () {}
};

function OptionStub() { this.values = []; }
OptionStub.prototype.value = function (v, label) { this.values.push([ v, label ]); return this; };
OptionStub.prototype.cfgvalue = function () { return ''; };

function MultiValueStub() { this.values = []; }
MultiValueStub.prototype.value = function (v, label) { this.values.push([ v, label ]); return this; };
MultiValueStub.prototype.cfgvalue = function () { return ''; };

/* 记录表单里注册过的选项，便于断言“哪个控件出现在哪个选项卡” */
const formOptions = [];

function sectionStub() {
	return {
		addremove: false, anonymous: false, addbtntitle: '', description: '', filter: null, create: null,
		tab: function () {},
		taboption: function (tab, type, name, title) {
			const option = new OptionStub();
			formOptions.push({ tab: tab, type: type, name: name, title: title, instance: option });
			return option;
		},
		option: function (type, name, title) {
			const option = new OptionStub();
			formOptions.push({ tab: null, type: type, name: name, title: title, instance: option });
			return option;
		}
	};
}

const formMaps = [];

function MapStub(name) { this.name = name; this.on_after_commit = null; formMaps.push(this); }
MapStub.prototype.section = function () { return sectionStub(); };
MapStub.prototype.render = function () {
	return Promise.resolve(E('div', { 'class': 'cbi-map' }, [E('h3', {}, 'Form placeholder')]));
};

const form = {
	Map: MapStub,
	NamedSection: sectionStub,
	TableSection: sectionStub,
	Flag: OptionStub, Value: OptionStub, ListValue: OptionStub, DummyValue: OptionStub,
	MultiValue: MultiValueStub
};

const notifications = [];
const ui = {
	addNotification: function (a, b, level) { notifications.push(level); return { remove: function () {} }; }
};

/* 模拟 LuCI 的 'require fanxpert.common as common' */
/* 模拟 LuCI 的 Class：extend() 返回构造器，属性挂在原型上 */
function BaseClassStub() {}
BaseClassStub.extend = function (props) {
	function Cls() {}
	Cls.prototype = Object.create(BaseClassStub.prototype);

	Object.keys(props).forEach(function (key) { Cls.prototype[key] = props[key]; });

	return Cls;
};
BaseClassStub.isSubclass = function (cls) {
	return typeof cls === 'function' && cls.prototype instanceof BaseClassStub;
};

/* 与 LuCI 的 L.require() 一致：工厂必须返回构造器，再 new 出实例 */
/* 模块名 → 测试替身 */
function moduleStub(name) {
	switch (name) {
	case 'view': return { extend: BaseClassStub.extend };
	case 'form': return form;
	case 'rpc': return rpc;
	case 'poll': return poll;
	case 'ui': return ui;
	case 'uci': return uci;
	case 'fs': return { read: function () { return Promise.resolve(''); }, list: function () { return Promise.resolve([]); } };
	case 'network': return {};
	default: return {};
	}
}

/*
 * 忠实复刻 luci.js 的加载方式：工厂只拿到 (window, document, L) + **源码里声明过的**依赖，
 * 其余标识符一概不可见（在独立 realm 里求值）。这样漏写 'require xxx' 会在本地直接
 * 报 "xxx is not defined"，而不是等到真机上才发现。
 */
function loadView(view_path) {
	const source = fs.readFileSync(view_path || VIEW, 'utf8');
	const declared = (source.match(/'require ([^']+)'/g) || [])
		.map(function (d) { return /'require ([^']+)'/.exec(d)[1]; });

	const sandbox = {
		window: windowStub,
		document: documentStub,
		L: L,
		E: E,
		_: localization,
		Promise: Promise,
		setTimeout: setTimeout,
		clearTimeout: clearTimeout,
		console: console,
		/* 浏览器自带全局（LuCI 页面里始终存在，不属于 'require' 的范畴） */
		Event: function EventStub(type) { this.type = type; },
		CustomEvent: function CustomEventStub(type) { this.type = type; },
		navigator: { clipboard: null, userAgent: 'view-check' },
		location: { href: 'https://example.invalid/' },
		devicePixelRatio: 1,
		requestAnimationFrame: function (fn) { return setTimeout(fn, 0); },
		cancelAnimationFrame: function (id) { clearTimeout(id); },
		getComputedStyle: function () { return { getPropertyValue: function () { return ''; } }; },
		ResizeObserver: function () { this.observe = function () {}; this.disconnect = function () {}; }
	};

	const params = [ 'window', 'document', 'L' ].concat(declared);
	const context = vm.createContext(sandbox);
	const factory = vm.runInNewContext(
		'(function(' + params.join(', ') + ') {\n' + source + '\n;return view; })',
		context, { filename: view_path || VIEW });

	const view_factory = factory.apply(null, [ windowStub, documentStub, L ]
		.concat(declared.map(function (d) { return moduleStub(d); })));

	if (!BaseClassStub.isSubclass(view_factory))
		throw new TypeError('视图工厂未返回构造器（LuCI 会报 factory yields invalid constructor）');

	return new view_factory();
}

/* ============================================================
   2. 桩数据
   ============================================================ */

function statusPayload(uptime, running, rpm, sensors) {
	const device = {
		label: 'CPU Fan', temp: 45, pwm: 128, percent: 50, curve: 'standard',
		sensors: sensors === undefined ? [['cpu_temp', 45], ['wifi_temp', 52]] : sensors
	};

	if (rpm !== undefined)
		device.rpm = rpm;

	return {
		ok: running, running: running,
		state: {
			devices: { cpu_fan: device },
			daemon: { uptime: uptime, config_reloads: 3, last_reload: { status: 'success' } },
			stats: { max_temp: 61 }
		}
	};
}

const curvePayload = {
	curve_points: [[35, 30], [40, 36], [45, 50], [50, 58], [55, 70], [65, 88], [75, 100]],
	current: { temp: 45, pwm_percent: 50 },
	range: { temp_min: 35, temp_max: 75, pwm_min: 0, pwm_max: 100 },
	pwm_max: 255,
	rpm_table: [[30, 850], [40, 1020], [50, 1180], [60, 1320], [70, 1450], [80, 1560], [90, 1680], [100, 1800]]
};

const fixedCurvePayload = {
	curve_points: [[0, 49], [100, 49]],
	current: { temp: 45, pwm_percent: 49 },
	range: { temp_min: 0, temp_max: 100, pwm_min: 0, pwm_max: 100 },
	pwm_max: 255,
	rpm_table: curvePayload.rpm_table
};

const previewText = {
	'fanxpert-status-temp': '45',
	'fanxpert-status-max-temp': 'Peak: 61 °C',
	'fanxpert-status-speed': '900',
	'fanxpert-status-speed-unit': 'RPM',
	'fanxpert-status-pwm': '50 % · PWM 128',
	'fanxpert-status-curve': 'Standard',
	'fanxpert-status-fan-label': 'CPU Fan',
	'fanxpert-status-uptime': '1h 2m',
	'fanxpert-status-reloads': 'Reloads: 3',
	'fanxpert-curve-name': 'Standard',
	'fanxpert-curve-temp-range': '35 – 75 °C',
	'fanxpert-curve-pwm-range': '0 – 100 %',
	'fanxpert-curve-point': '45 °C / 50 %',
	'fanxpert-calibration-note': 'coarse (40%)',
	'fanxpert-mode-state': 'Current mode: Standard',
	'fanxpert-status-sources': 'Temperature sources (highest wins): CPU Temperature 45 °C · WiFi 52 °C',
	'fanxpert-mode-state': previewFixed ? 'Current mode: Fixed Speed' : 'Current mode: Standard',
	'fanxpert-curve-name': previewFixed ? 'Fixed Speed' : 'Standard',
	'fanxpert-curve-temp-range': previewFixed ? '0 – 100 °C' : '35 – 75 °C',
	'fanxpert-curve-point': previewFixed ? '45 °C / 49 %' : '45 °C / 50 %'
};

/* ============================================================
   3. 纯函数（曲线数学 / 拖拽几何）—— 直接从视图源码抽取，
      避免测试与被测实现脱节
   ============================================================ */

function extractFunction(source, name) {
	const start = source.indexOf('function ' + name + '(');
	if (start < 0)
		throw new Error('未找到函数: ' + name);

	let depth = 0;
	for (let i = source.indexOf('{', start); i < source.length; i++) {
		if (source[i] === '{')
			depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0)
				return source.slice(start, i + 1);
		}
	}

	throw new Error('函数体不完整: ' + name);
}

function loadCurveHelpers() {
	const source = fs.readFileSync(VIEW, 'utf8');
	const names = ['percentToPwm', 'pwmToPercent', 'bezierPercent', 'linearPercent', 'stepPercent',
		'clampStepLevels', 'curvePercentAt', 'previewCurvePoints',
		'chartMetrics', 'pctY', 'tempX', 'curveAxisRange', 'anchorPercent', 'curveAnchors',
		'hitTestAnchor', 'clampCurveParams',
		/* 阶段3 补充：命令/状态/命名等纯函数 */
		'curveDisplayName', 'isPresetCurve', 'sameCurveParams', 'serviceRunning', 'stateFromStatus',
		'formatUptime', 'paletteColor', 'isDarkTheme'];
	const gap = /var MIN_TEMP_GAP = (\d+);/.exec(source);

	/* 公共块整体注入：常量（PRESET_CURVES/STEP_LEVELS/FX_PALETTE/_fxDark）与辅助函数都在里面，
	 * 逐行提取 var 会破坏 FX_PALETTE 这类多行字面量，所以整份给进去。 */
	const block = fs.readFileSync(path.join(__dirname, 'common-block.js'), 'utf8');

	const code = 'var MIN_TEMP_GAP = ' + (gap ? gap[1] : '5') + ';\n' + block + '\n' +
		names.map(function (name) { return extractFunction(source, name); }).join('\n\n') +
		'\n;return { ' + names.join(', ') + ' };';

	/* 被测函数会用到视图里的运行时依赖（翻译、DOM 构造器、L、uci、window/document），
	 * 这里按 LuCI 的真实全局环境注入，保证抽出来的是"真函数"而不是被裁剪过的空壳。 */
	return new Function('_', 'E', 'L', 'uci', 'window', 'document', code)(
		localization, E, L, uci, windowStub, documentStub);
}

/* ============================================================
   4. 结构自检
   ============================================================ */

const failures = [];
let checkCount = 0;

function check(name, condition, detail) {
	checkCount++;
	if (!condition)
		failures.push(name + (detail !== undefined ? ' → ' + detail : ''));
}

function collect(node) {
	const classes = {};
	const ids = {};
	const titles = [];

	walk(node, function (n) {
		if (n.attrs && n.attrs.class) {
			String(n.attrs.class).split(/\s+/).forEach(function (c) { if (c) classes[c] = true; });
		}
		if (n.attrs && n.attrs.id)
			ids[n.attrs.id] = true;
		if (n.tag === 'h3' && n.children.length)
			titles.push(n.children[0]);
	});

	return { classes: classes, ids: ids, titles: titles };
}

function runChecks(node) {
	const seen = collect(node);

	check('页头容器', seen.classes['fanxpert-header']);
	check('状态徽标', seen.ids['fanxpert-service-badge']);
	check('基准样式表已引用',
		(function () {
			let ok = false;
			walk(node, function (n) {
				if (n.tag === 'link' && /\?v=/.test(n.attrs.href || ''))
					ok = true;
			});
			return ok;
		})());

	['fanxpert-status-temp', 'fanxpert-status-speed', 'fanxpert-status-speed-unit',
	 'fanxpert-status-curve', 'fanxpert-status-uptime', 'fanxpert-rpm-table', 'fanxpert-rpm-note',
	 'fanxpert-mode-silent', 'fanxpert-mode-standard', 'fanxpert-mode-performance',
	 'fanxpert-mode-full_speed', 'fanxpert-mode-fixed', 'fanxpert-mode-state',
	 'fanxpert-status-max-temp', 'fanxpert-status-pwm', 'fanxpert-status-fan-label', 'fanxpert-status-reloads',
	 'fanxpert-curve-canvas', 'fanxpert-curve-name', 'fanxpert-curve-temp-range', 'fanxpert-curve-pwm-range',
	 'fanxpert-curve-point', 'fanxpert-start-calibration', 'fanxpert-calibration-gate-note',
	 'fanxpert-calibration-note', 'fanxpert-calibration-progress-bar', 'fanxpert-calibration-result',
	 'fanxpert-fan-selector'
	].forEach(function (id) { check('节点 ' + id, seen.ids[id]); });

	['Status and Control', 'Temperature / Fan Speed Curve', 'Fan Start Threshold Calibration']
		.forEach(function (title) { check('区块标题 ' + title, seen.titles.indexOf(title) >= 0, JSON.stringify(seen.titles)); });
}

function runLiveChecks() {
	check('温度 KPI', els['fanxpert-status-temp'].textContent === 45, els['fanxpert-status-temp'].textContent);
	check('转速 KPI 优先显示 RPM', els['fanxpert-status-speed'].textContent === 900, els['fanxpert-status-speed'].textContent);
	check('转速单位切到 RPM', els['fanxpert-status-speed-unit'].textContent === 'RPM', els['fanxpert-status-speed-unit'].textContent);
	check('曲线 KPI', els['fanxpert-status-curve'].textContent === 'Standard', els['fanxpert-status-curve'].textContent);
	check('运行时长格式', els['fanxpert-status-uptime'].textContent === '1h 2m', els['fanxpert-status-uptime'].textContent);
	check('峰值温度副标题', els['fanxpert-status-max-temp'].textContent === 'Peak: 61 °C', els['fanxpert-status-max-temp'].textContent);
	check('副标题同时给出百分比与 PWM', els['fanxpert-status-pwm'].textContent === '50 % · PWM 128', els['fanxpert-status-pwm'].textContent);
	check('曲线区间摘要', els['fanxpert-curve-temp-range'].textContent === '35 – 75 °C', els['fanxpert-curve-temp-range'].textContent);
	check('工作点摘要', els['fanxpert-curve-point'].textContent === '45 °C / 50 %', els['fanxpert-curve-point'].textContent);
	check('运行中徽标', els['fanxpert-service-badge'].className === 'fanxpert-badge is-running', els['fanxpert-service-badge'].className);
	check('运行中校准按钮禁用', els['fanxpert-start-calibration'].disabled === true);
	check('运行中显示门控提示',
		els['fanxpert-calibration-gate-note'].style.display === '' &&
		/Stop the service/.test(els['fanxpert-calibration-gate-note'].textContent),
		els['fanxpert-calibration-gate-note'].textContent);
	check('校准进度条', els['fanxpert-calibration-progress-bar'].style.width === '40%', els['fanxpert-calibration-progress-bar'].style.width);
}

function cellText(node) {
	if (typeof node === 'string')
		return node;
	if (node == null || typeof node !== 'object')
		return '';

	return (node.children || []).map(cellText).join('');
}

function rpmTableRows() {
	const rows = [];

	walk({ children: els['fanxpert-rpm-table'].childNodes }, function (node) {
		if (node.tag !== 'tr')
			return;

		const cells = [];
		(node.children || []).forEach(function (cell) {
			if (cell && cell.tag === 'td')
				cells.push(cellText(cell));
		});
		if (cells.length)
			rows.push(cells);
	});

	return rows;
}

function findById(node, id) {
	let found = null;

	walk(node, function (n) {
		if (!found && n.attrs && n.attrs.id === id)
			found = n;
	});

	return found;
}

function runCurveDragChecks() {
	const canvas = els['fanxpert-curve-canvas'];

	canvas.clientWidth = 900;
	canvas.clientHeight = 320;

	check('画布已绑定拖拽事件',
		canvas.listenerCount('pointerdown') === 1 && canvas.listenerCount('pointermove') === 1 &&
		canvas.listenerCount('pointerup') === 1,
		[ canvas.listenerCount('pointerdown'), canvas.listenerCount('pointermove'), canvas.listenerCount('pointerup') ].join('/'));

	const metrics = { width: 900, height: 320, narrow: false, left: 56, right: 24, top: 18, bottom: 40 };
	const pctY = function (p) { return metrics.height - metrics.bottom - (p / 100) * (metrics.height - metrics.top - metrics.bottom) };
	const plotW = metrics.width - metrics.left - metrics.right;

	// 标准曲线：35°C/30% → 75°C/100%
	const endX = metrics.left + plotW;
	const endY = pctY(100);
	const target = { x: metrics.left + plotW / 2, y: metrics.height - metrics.bottom - 0.6 * (metrics.height - metrics.top - metrics.bottom) };

	canvas.context2d._arcs.length = 0;
	canvas.fire('pointerdown', { currentTarget: canvas, pointerId: 1, offsetX: endX, offsetY: endY, preventDefault: function () {} });
	canvas.fire('pointermove', { currentTarget: canvas, pointerId: 1, offsetX: target.x, offsetY: target.y, preventDefault: function () {} });
	check('拖拽时绘制锚点', canvas.context2d._arcs.filter(function (a) { return a.r >= 6; }).length >= 2,
		JSON.stringify(canvas.context2d._arcs));

	canvas.fire('pointerup', { currentTarget: canvas, pointerId: 1, offsetX: target.x, offsetY: target.y, preventDefault: function () {} });

	check('拖拽结果写回表单：temp_max', els['widget.cbid.fanxpert.standard.temp_max'].value === '55',
		els['widget.cbid.fanxpert.standard.temp_max'].value);
	check('拖拽结果写回表单：pwm_end', els['widget.cbid.fanxpert.standard.pwm_end'].value === '60',
		els['widget.cbid.fanxpert.standard.pwm_end'].value);
	check('写入后触发 change 事件（表单可保存）',
		els['widget.cbid.fanxpert.standard.pwm_end'].dispatched.indexOf('change') >= 0,
		JSON.stringify(els['widget.cbid.fanxpert.standard.pwm_end'].dispatched));
	check('提示用户保存生效', /Save & Apply/.test(els['fanxpert-curve-hint'].textContent), els['fanxpert-curve-hint'].textContent);
	check('未拖动的锚点保持原值', els['widget.cbid.fanxpert.standard.temp_min'].value === '' ||
		els['widget.cbid.fanxpert.standard.temp_min'].value === '35', els['widget.cbid.fanxpert.standard.temp_min'].value);
}

function runQuietGateChecks(calibrated) {
	const quiet = formOptions.filter(function (o) { return o.name === 'quiet_mode'; })[0];
	const stop = formOptions.filter(function (o) { return o.name === 'auto_stop'; })[0];

	check('提供极致静音与自动停转控件',
		!!quiet && !!stop && quiet.type === form.Flag && stop.type === form.Flag && quiet.tab === 'hardware',
		JSON.stringify([ quiet && quiet.name, stop && stop.name, quiet && quiet.tab ]));
	check('不再提供旧的 never_stop 开关',
		!formOptions.some(function (o) { return o.name === 'never_stop'; }),
		JSON.stringify(formOptions.map(function (o) { return o.name; })));

	if (calibrated) {
		check('已校准：极致静音可编辑', !quiet.instance.readonly, String(quiet.instance.readonly));
		check('已校准且已开启极致静音：自动停转可编辑', !stop.instance.readonly, String(stop.instance.readonly));
	} else {
		check('未校准：极致静音只读（校准前置）', quiet.instance.readonly === true, String(quiet.instance.readonly));
		check('未校准：自动停转只读', stop.instance.readonly === true, String(stop.instance.readonly));
	}
}

/* ============================================================
   4.1 翻译覆盖与错误文案接线
   ============================================================ */

function collectSourceStrings(dir) {
	const strings = [];

	fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
		const full = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			strings.push.apply(strings, collectSourceStrings(full));
		} else if (entry.name.endsWith('.js')) {
			const source = fs.readFileSync(full, 'utf8');
			const re = /_\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
			let m;

			while ((m = re.exec(source)) !== null) {
				const text = m[1].replace("\\'", "'");

				if (strings.indexOf(text) < 0)
					strings.push(text);
			}
		}
	});

	return strings;
}

/* 从视图源码里抽出 ERROR_MESSAGES + translateError，用带标记的 _ 验证映射行为 */
function extractTranslateError(view_path, translator) {
	const source = fs.readFileSync(view_path, 'utf8');
	const map_start = source.indexOf('var ERROR_MESSAGES');
	const fn_start = source.indexOf('function translateError');
	const fn_end = source.indexOf('\n}\n', fn_start) + 3;
	const code = source.slice(map_start, fn_start) + source.slice(fn_start, fn_end);

	return new Function('_', code + '\n;return translateError;')(translator);
}

function runI18nChecks() {
	const potPath = path.join(ROOT, 'luci-app-fanxpert/po/templates/fanxpert.pot');
	const pot = fs.readFileSync(potPath, 'utf8');
	const ids = (pot.match(/^msgid "(.*)"$/gm) || [])
		.map(function (line) { return line.slice(7, -1); })
		.filter(Boolean);

	const sources = collectSourceStrings(path.join(ROOT, 'luci-app-fanxpert/htdocs'));
	const missing = sources.filter(function (s) { return ids.indexOf(s) < 0; });

	check('界面字符串全部进入翻译模板', missing.length === 0, missing.slice(0, 5).join(' | '));

	/* 架构护栏 1：视图必须自包含，不依赖跨文件模块（官方模板的写法） */
	const CORE_REQUIRES = [ 'view', 'form', 'rpc', 'poll', 'ui', 'uci', 'fs', 'network' ];
	const stray = [];

	[ 'overview.js', 'config.js', 'logs.js' ].forEach(function (name) {
		const source = fs.readFileSync(path.join(VIEW_DIR, name), 'utf8');
		const re = /_\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
		let m;
		const requires = [];

		while ((m = /'require ([^']+)'/.exec(source.slice(source.indexOf(m ? m.index : 0) || 0))) !== null) break;

		(source.match(/'require ([^']+)'/g) || []).forEach(function (decl) {
			const dep = /'require ([^']+)'/.exec(decl)[1];

			if (CORE_REQUIRES.indexOf(dep) < 0)
				stray.push(name + ' → ' + dep);
		});
	});

	check('视图不依赖跨文件模块（只需 LuCI 核心模块）', stray.length === 0, stray.join(', '));

	/* 架构护栏 1.5：用到的 LuCI 模块必须声明 'require'，且公共块必须排在所有 require 之后
	 *（luci.js 遇到第一个非 require 字符串就停止扫描依赖） */
	const used_but_undeclared = [];
	const block_order_bad = [];

	[ 'overview.js', 'config.js', 'logs.js' ].forEach(function (name) {
		const source = fs.readFileSync(path.join(VIEW_DIR, name), 'utf8');
		const declared = (source.match(/'require ([^']+)'/g) || [])
			.map(function (d) { return /'require ([^']+)'/.exec(d)[1]; });

		[ 'view', 'form', 'rpc', 'poll', 'ui', 'uci', 'fs', 'network' ].forEach(function (mod) {
			const used = new RegExp('(^|[^\\w.$])' + mod + '\\.').test(source);

			if (used && declared.indexOf(mod) < 0)
				used_but_undeclared.push(name + ' → ' + mod);
		});

		const lines = source.split('\n');
		const block_line = lines.findIndex(function (l) { return l.indexOf('==== BEGIN FanXpert 公共块') >= 0; });
		const last_require = lines.reduce(function (acc, l, i) {
			return /^'require [^']+';$/.test(l.trim()) ? i : acc;
		}, -1);

		if (last_require > block_line)
			block_order_bad.push(name + '（require 在第 ' + (last_require + 1) + ' 行，块在第 ' + (block_line + 1) + ' 行）');
	});

	check('用到的 LuCI 模块都已声明 require', used_but_undeclared.length === 0, used_but_undeclared.join(', '));
	check('公共块排在所有 require 之后', block_order_bad.length === 0, block_order_bad.join(', '));

	/* 架构护栏 2：三个视图里的公共块必须与 tools/common-block.js 同步 */
	let sync_ok = false;
	let sync_out = '';

	try {
		execFileSync(process.execPath, [ path.join(__dirname, 'sync-common.js'), '--check' ], { encoding: 'utf8' });
		sync_ok = true;
	} catch (e) {
		sync_out = String((e && e.stdout) || (e && e.message) || '').trim().split('\n').slice(-2).join(' | ');
	}

	check('视图里的公共块与单一来源同步', sync_ok, sync_out);

	/* 后端错误文案的翻译接线 */
	const marked = extractTranslateError(path.join(VIEW_DIR, 'overview.js'), function (s) { return '⟦' + s + '⟧'; });

	check('后端错误文案经过翻译', marked('Fan not found') === '⟦Fan not found⟧', marked('Fan not found'));
	check('退出码错误经过翻译', marked('Command exited with code 7') === '⟦Command exited with code 7⟧',
		marked('Command exited with code 7'));
	check('未知错误原样显示', marked('Something odd') === 'Something odd', marked('Something odd'));
}

function runSensorLineChecks() {
	check('概览页测温点实时读数行',
		els['fanxpert-status-sources'].textContent === 'Temperature sources (highest wins): CPU Temperature 45 °C · WiFi 52 °C',
		els['fanxpert-status-sources'].textContent);
}

function runSensorOptionChecks() {
	const option = formOptions.filter(function (o) { return o.name === 'sensors'; })[0];

	check('配置页提供测温点多选', !!option && option.type === form.MultiValue && option.tab === 'hardware',
		JSON.stringify({ name: option && option.name, tab: option && option.tab, multi: option && option.type === form.MultiValue }));
	check('自定义曲线不再重复提供 sensor 选项',
		!formOptions.some(function (o) { return o.name === 'sensor'; }),
		JSON.stringify(formOptions.map(function (o) { return o.name; })));
}

function runModeButtonChecks() {
	const active = [];

	['silent', 'standard', 'performance', 'full_speed', 'fixed'].forEach(function (mode) {
		const button = els['fanxpert-mode-' + mode];

		if (button && /is-active/.test(button.className))
			active.push(mode);
	});

	check('仅当前模式高亮', active.length === 1 && active[0] === 'standard', JSON.stringify(active));
	check('模式状态文案',
		els['fanxpert-mode-state'].textContent === 'Current mode: Standard', els['fanxpert-mode-state'].textContent);
}

function runModeClickChecks(node) {
	const button = findById(node, 'fanxpert-mode-silent');

	check('静音按钮可点击', !!(button && button.attrs.click));

	if (!button || !button.attrs.click)
		return Promise.resolve();

	notifications.length = 0;
	rpcCalls.length = 0;
	button.attrs.click({ preventDefault: function () {} });

	return new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () {
		const call = rpcCalls.filter(function (c) { return c.method === 'preset'; })[0];

		check('点击后调用 preset RPC', !!call && call.args[0] === 'silent', JSON.stringify(rpcCalls));
		check('切换成功给出提示', notifications.indexOf('info') >= 0, JSON.stringify(notifications));
	});
}

/* 期望值由 fanxpert.sh 的 calculate_bezier_curve() + pwm_to_percent() 实际输出得到 */
const CURVE_GOLDEN = [
	{ name: '标准曲线 35–75°C / 30–100%', params: { temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100 },
	  cases: [ [35, 29], [40, 34], [45, 42], [50, 52], [55, 64], [60, 74], [65, 85], [70, 93], [75, 100] ] },
	{ name: '静音曲线 40–70°C / 20–70%', params: { temp_min: 40, temp_max: 70, pwm_start: 20, pwm_end: 70 },
	  cases: [ [40, 20], [50, 33], [60, 53], [70, 69] ] },
	{ name: '全速平坦曲线 0–100°C / 100–100%', params: { temp_min: 0, temp_max: 100, pwm_start: 100, pwm_end: 100 },
	  cases: [ [0, 100], [25, 100], [50, 100], [75, 100], [100, 100] ] }
];

function runCurveMathChecks(helpers) {
	let mismatches = [];

	CURVE_GOLDEN.forEach(function (curve) {
		curve.cases.forEach(function (pair) {
			const actual = helpers.curvePercentAt(pair[0], curve.params, 255);

			if (actual !== pair[1])
				mismatches.push(curve.name + ' ' + pair[0] + '°C → ' + actual + '（期望 ' + pair[1] + '）');
		});
	});

	check('曲线数学与守护进程一致', mismatches.length === 0, mismatches.join('; '));

	const points = helpers.previewCurvePoints({ temp_min: 0, temp_max: 100, pwm_start: 100, pwm_end: 100 }, 255);

	check('预览采样点覆盖整段温度', points.length > 2 && points[0][0] === 0 && points[points.length - 1][0] === 100,
		JSON.stringify(points));

	const metrics = helpers.chartMetrics(900, 320);
	const range = { temp_min: 35, temp_max: 75, pwm_min: 0, pwm_max: 100 };
	const params = { curve_id: 'standard', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100 };
	const anchors = helpers.curveAnchors(metrics, range, params, 255);

	check('起止锚点落在配置的温度上',
		anchors.length === 2 &&
		Math.round(anchors[0].x) === Math.round(helpers.tempX(metrics, range, 35)) &&
		Math.round(anchors[1].x) === Math.round(helpers.tempX(metrics, range, 75)),
		JSON.stringify(anchors));

	check('锚点命中判定',
		helpers.hitTestAnchor(metrics, range, params, anchors[0].x, anchors[0].y, 14, 255) === 'start' &&
		helpers.hitTestAnchor(metrics, range, params, anchors[1].x, anchors[1].y, 14, 255) === 'end' &&
		helpers.hitTestAnchor(metrics, range, params, metrics.left + 5, metrics.top + 5, 14, 255) === null);

	/* 固定转速模式：单个把手，只改转速不改温度 */
	const fixedParams = { curve_id: 'fixed', type: 'fixed', temp_min: 0, temp_max: 100, pwm_start: 50, pwm_end: 50 };
	const fixedAnchors = helpers.curveAnchors(metrics, range, fixedParams, 255);
	const fixedClamped = helpers.clampCurveParams(fixedParams, 'fixed', 80, 30);

	check('固定模式只有一个把手', fixedAnchors.length === 1 && fixedAnchors[0].id === 'fixed',
		JSON.stringify(fixedAnchors));

	/* ── 阶段3 补充：命名 / 判定 / 状态映射 / 时间格式化 ───────────────── */
	check('曲线显示名：五个预设 + 自定义回退',
		helpers.curveDisplayName('silent') === 'Silent' &&
		helpers.curveDisplayName('standard') === 'Standard' &&
		helpers.curveDisplayName('performance') === 'Performance' &&
		helpers.curveDisplayName('full_speed') === 'Full Speed' &&
		helpers.curveDisplayName('fixed') === 'Fixed Speed' &&
		helpers.curveDisplayName('custom_3') === 'custom_3',
		[ 'silent', 'standard', 'performance', 'full_speed', 'fixed', 'custom_3' ]
			.map(function (n) { return helpers.curveDisplayName(n); }).join(','));

	check('预设曲线判定',
		helpers.isPresetCurve('silent') === true && helpers.isPresetCurve('fixed') === true &&
		helpers.isPresetCurve('custom_1') === false && helpers.isPresetCurve('') === false);

	check('曲线参数比较（拖拽去重用）',
		helpers.sameCurveParams({ curve_id: 'a', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100 },
			{ curve_id: 'a', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100 }) === true &&
		helpers.sameCurveParams({ curve_id: 'a', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100 },
			{ curve_id: 'a', temp_min: 35, temp_max: 75, pwm_start: 31, pwm_end: 100 }) === false &&
		helpers.sameCurveParams(null, {}) === false);

	check('服务运行状态判定',
		helpers.serviceRunning({ running: true }) === true &&
		helpers.serviceRunning({ running: false }) === false &&
		helpers.serviceRunning(null) === false);

	check('状态映射：data / state / 错误 / 缺失',
		helpers.stateFromStatus({ state: { data: { temp: 55 } } }).temp === 55 &&
		helpers.stateFromStatus({ state: { temp: 50 } }).temp === 50 &&
		helpers.stateFromStatus({ state: { error: 'x' } }) === null &&
		helpers.stateFromStatus(null) === null);

	check('运行时长格式化：秒/分/时/天/非法值',
		helpers.formatUptime(0) === '0s' &&
		helpers.formatUptime(59) === '59s' &&
		helpers.formatUptime(60) === '1m 0s' &&
		helpers.formatUptime(3600) === '1h 0m' &&
		helpers.formatUptime(86400) === '1d 0h' &&
		helpers.formatUptime(-1) === null &&
		helpers.formatUptime('abc') === null,
		[ 0, 59, 60, 3600, 86400, -1, 'abc' ].map(function (v) { return String(helpers.formatUptime(v)); }).join(' | '));

	check('深浅兜底调色板：无主题变量时返回有效色值',
		/^#[0-9a-f]{6}$/i.test(helpers.paletteColor('surface')) &&
		/^#[0-9a-f]{6}$/i.test(helpers.paletteColor('text')) &&
		helpers.paletteColor('accent') !== helpers.paletteColor('err'),
		helpers.paletteColor('surface') + '/' + helpers.paletteColor('text'));

	/* 曲线类型：前端镜像必须与守护进程逐位一致（daemon-check 里锁的是 PWM，这里锁百分比） */
	const linearParams = { curve_id: 'linear', type: 'linear', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100 };

	check('线性曲线：区间内外取值',
		helpers.curvePercentAt(35, linearParams, 255) === 29 &&
		helpers.curvePercentAt(45, linearParams, 255) === 46 &&
		helpers.curvePercentAt(55, linearParams, 255) === 64 &&
		helpers.curvePercentAt(75, linearParams, 255) === 100 &&
		helpers.curvePercentAt(10, linearParams, 255) === 29,
		[ 35, 45, 55, 75, 10 ].map(function (t) { return helpers.curvePercentAt(t, linearParams, 255); }).join(','));

	/* 递减曲线：验证 JS 的截断方式与 sh 一致（向零截断，而非向下取整） */
	const descParams = { curve_id: 'desc', type: 'linear', temp_min: 35, temp_max: 75, pwm_start: 100, pwm_end: 30 };

	check('线性（递减）：向零截断与守护进程一致',
		helpers.curvePercentAt(45, descParams, 255) === 82 &&
		helpers.curvePercentAt(75, descParams, 255) === 29,
		helpers.curvePercentAt(45, descParams, 255) + '/' + helpers.curvePercentAt(75, descParams, 255));

	const stepParams = { curve_id: 'step', type: 'step', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100 };

	check('阶梯曲线：档位取值与守护进程一致',
		helpers.curvePercentAt(40, stepParams, 255) === 43 &&
		helpers.curvePercentAt(60, stepParams, 255) === 85 &&
		helpers.curvePercentAt(75, stepParams, 255) === 100,
		[ 40, 60, 75 ].map(function (t) { return helpers.curvePercentAt(t, stepParams, 255); }).join(','));
	check('阶梯曲线：可配置档数（3 / 8 档）',
		helpers.curvePercentAt(40, { curve_id: 's3', type: 'step', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100, step_levels: 3 }, 255) === 52 &&
		helpers.curvePercentAt(55, { curve_id: 's3', type: 'step', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100, step_levels: 3 }, 255) === 75 &&
		helpers.curvePercentAt(40, { curve_id: 's8', type: 'step', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100, step_levels: 8 }, 255) === 46 &&
		helpers.curvePercentAt(55, { curve_id: 's8', type: 'step', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100, step_levels: 8 }, 255) === 72,
		'3档: ' + helpers.curvePercentAt(40, { type: 'step', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100, step_levels: 3 }, 255) +
		' 8档: ' + helpers.curvePercentAt(40, { type: 'step', temp_min: 35, temp_max: 75, pwm_start: 30, pwm_end: 100, step_levels: 8 }, 255));
	check('阶梯档数钳位与默认值',
		helpers.clampStepLevels(undefined) === 5 && helpers.clampStepLevels(1) === 2 &&
		helpers.clampStepLevels(999) === 20 && helpers.clampStepLevels('abc') === 5,
		[ undefined, 1, 999, 'abc' ].map(function (v) { return helpers.clampStepLevels(v); }).join(','));

	check('阶梯曲线：同一档内转速不变',
		helpers.curvePercentAt(36, stepParams, 255) === helpers.curvePercentAt(42, stepParams, 255) &&
		helpers.curvePercentAt(50, stepParams, 255) !== helpers.curvePercentAt(56, stepParams, 255),
		helpers.curvePercentAt(36, stepParams, 255) + '/' + helpers.curvePercentAt(42, stepParams, 255));
	check('固定转速：任意温度同一取值',
		helpers.curvePercentAt(0, fixedParams, 255) === helpers.curvePercentAt(100, fixedParams, 255));
	check('拖动把手同时设置起止转速、温度不变',
		fixedClamped.pwm_start === 30 && fixedClamped.pwm_end === 30 &&
		fixedClamped.temp_min === 0 && fixedClamped.temp_max === 100,
		JSON.stringify(fixedClamped));

	const clamped = [
		helpers.clampCurveParams(params, 'start', 10, 5),
		helpers.clampCurveParams(params, 'start', 90, 50),
		helpers.clampCurveParams(params, 'end', 90, 120),
		helpers.clampCurveParams(params, 'end', -20, -5)
	];

	check('拖拽下限：温度与转速被夹紧',
		clamped[0].temp_min === 10 && clamped[0].pwm_start === 5, JSON.stringify(clamped[0]));
	check('两端口温度至少相差 5°C',
		clamped[1].temp_min === 70 && clamped[2].temp_max === 90, JSON.stringify([ clamped[1], clamped[2] ]));
	check('转速上限 100%、下限 0%',
		clamped[2].pwm_end === 100 && clamped[3].pwm_end === 0, JSON.stringify([ clamped[2], clamped[3] ]));
}

function runRpmTableChecks() {
	const rows = rpmTableRows();

	check('参考表 11 行（0–100%，每 10% 一档）', rows.length === 11, JSON.stringify(rows));
	check('参考表自高到低排列', rows.length > 0 && rows[0][0] === '100 %' && rows[10][0] === '0 %', JSON.stringify(rows[0]));
	check('100% 档位读数', rows.length > 0 && rows[0][1] === '1800', JSON.stringify(rows[0]));
	check('30% 档位读数', rows[7] && rows[7][1] === '850', JSON.stringify(rows[7]));
	check('未采集档位显示占位符', rows[8] && rows[8][1] === '—', JSON.stringify(rows[8]));
	check('参考表说明可见', els['fanxpert-rpm-note'].style.display === '', els['fanxpert-rpm-note'].style.display);
}

function runNoRpmChecks() {
	check('无传感器时回落为百分比', els['fanxpert-status-speed'].textContent === 50, els['fanxpert-status-speed'].textContent);
	check('无传感器时单位为 %', els['fanxpert-status-speed-unit'].textContent === '%', els['fanxpert-status-speed-unit'].textContent);
	check('无传感器时副标题只有 PWM', els['fanxpert-status-pwm'].textContent === 'PWM 128', els['fanxpert-status-pwm'].textContent);
	check('参考表显示无数据提示',
		/No RPM data/.test(els['fanxpert-rpm-table'].textContent), els['fanxpert-rpm-table'].textContent);
	check('参考表说明隐藏', els['fanxpert-rpm-note'].style.display === 'none', els['fanxpert-rpm-note'].style.display);
	check('无测温点数据时隐藏读数行', els['fanxpert-status-sources'].style.display === 'none',
		els['fanxpert-status-sources'].style.display);
}

function runStoppedChecks() {
	check('长时间运行时长格式', els['fanxpert-status-uptime'].textContent === '1d 1h', els['fanxpert-status-uptime'].textContent);
	check('停止徽标', els['fanxpert-service-badge'].className === 'fanxpert-badge is-stopped', els['fanxpert-service-badge'].className);
	check('停止时校准按钮可用', els['fanxpert-start-calibration'].disabled === false);
	check('停止时隐藏门控提示', els['fanxpert-calibration-gate-note'].style.display === 'none');
}

function runErrorChecks() {
	check('错误徽标', els['fanxpert-service-badge'].className === 'fanxpert-badge is-error', els['fanxpert-service-badge'].className);
	check('错误提示文本', els['fanxpert-status-note'].textContent === 'fan not found', els['fanxpert-status-note'].textContent);
	check('错误提示样式', els['fanxpert-status-note'].className === 'fanxpert-note is-error', els['fanxpert-status-note'].className);
}

/* ============================================================
   4. HTML 预览
   ============================================================ */

const PREVIEW_SHELL = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<script>
/* 与 LuCI 主题一致：跟随浏览器/系统主题；?dark=1 / ?dark=0 仅用于生成截图时强制 */
(function () {
	var forced = /[?&]dark=([01])(&|$)/.exec(location.search);
	var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
	var apply = function (dark) {
		document.documentElement.setAttribute('data-darkmode', dark ? 'true' : 'false');



		/* 模拟真实页面里的 applyTheme()：按实际底色给页面根节打深浅标记 */
		document.querySelectorAll('.fanxpert-page').forEach(function (el) {
			el.classList.toggle('is-dark', dark);
			el.classList.toggle('is-light', !dark);
		});
	};

	if (forced) {
		apply(forced[1] === '1');
	} else if (media) {
		apply(media.matches);
		if (media.addEventListener) media.addEventListener('change', function () { apply(media.matches); });
	}
})();
</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FanXpert 页面排版预览</title>
<style>
/* ---- LuCI bootstrap 主题变量的近似值（仅用于离线预览） ---- */
:root {
	--background-color-high: #ffffff;
	--background-color-medium: hsl(0, 0%, 97.65%);
	--background-color-low: hsl(0, 0%, 96.08%);
	--text-color-highest: #000000;
	--text-color-high: hsl(0, 0%, 25.1%);
	--text-color-medium: hsl(0, 0%, 50.2%);
	--text-color-low: hsl(0, 0%, 74.9%);
	--border-color-high: hsl(0, 0%, 90%);
	--border-color-medium: hsl(0, 0%, 93%);
	--border-color-low: hsl(0, 0%, 96%);
	--primary-color-high: #1976d2;
	--success-color-high: rgb(0, 172, 89);
	--warn-color-high: #efbd0b;
	--error-color-high: rgb(246, 43, 18);
	--font-sans: Helvetica Neue, Helvetica, Arial, ui-sans-serif, system-ui, sans-serif;
	--font-mono: Monaco, Andale Mono, Courier New, ui-monospace, monospace;
}
:root[data-darkmode="false"] body { background: #f5f6f8; }
:root[data-darkmode="true"] body { background: #1e1e2d; }
:root[data-darkmode="true"] {
	--background-color-high: hsl(0, 0%, 13.33%);
	--background-color-medium: hsl(0, 0%, 15.68%);
	--background-color-low: hsl(0, 0%, 17.25%);
	--text-color-highest: #ffffff;
	--text-color-high: hsl(0, 0%, 74.9%);
	--text-color-medium: hsl(0, 0%, 49.8%);
	--text-color-low: hsl(0, 0%, 25.1%);
	--border-color-high: hsl(0, 0%, 23%);
	--border-color-medium: hsl(0, 0%, 19%);
	--border-color-low: hsl(0, 0%, 16%);
	--primary-color-high: #4da1c0;
	--success-color-high: rgb(0, 166, 108);
	--warn-color-high: #a69461;
	--error-color-high: rgb(209, 86, 83);
}
* { box-sizing: border-box; }
body {
	margin: 0;
	padding: 20px 24px 48px;
	background: var(--background-color-high);
	color: var(--text-color-high);
	font-family: var(--font-sans);
	font-size: 13px;
	line-height: 1.5;
}
.preview-banner {
	margin: -4px 0 20px;
	padding: 10px 14px;
	border: 1px solid var(--border-color-high);
	border-left: 4px solid var(--primary-color-high);
	border-radius: 6px;
	background: var(--background-color-medium);
	color: var(--text-color-medium);
	font-size: 12px;
}
.preview-banner b { color: var(--text-color-highest); }
.preview-hint { margin: 0 0 14px; color: var(--text-color-medium); font-size: 12px; }
/* ---- LuCI 常规元素的最小近似（字号/行高对齐 luci-theme-bootstrap） ---- */
h2 { font-size: 24px; line-height: 36px; font-weight: bold; color: var(--text-color-high); }
h3 { font-size: 18px; line-height: 36px; font-weight: bold; color: var(--text-color-high); }
.cbi-section { margin: 18px 0; }
.cbi-map-descr, .cbi-section-descr { margin: 2px 0 8px; color: var(--text-color-medium); font-size: 12px; line-height: 1.6; }
.cbi-section-node { min-width: 0; }
.cbi-input-select, input.cbi-input {
	padding: 4px 8px;
	border: 1px solid var(--border-color-high);
	border-radius: 4px;
	background: var(--background-color-high);
	color: var(--text-color-high);
	font: inherit;
}
.btn, .cbi-button {
	display: inline-block;
	padding: 5px 12px;
	border: 1px solid var(--border-color-high);
	border-radius: 4px;
	background: var(--background-color-medium);
	color: var(--text-color-high);
	font: inherit;
	cursor: pointer;
}
.cbi-button-action { border-color: var(--primary-color-high); color: var(--primary-color-high); }
.cbi-button-apply { background: var(--primary-color-high); border-color: var(--primary-color-high); color: #fff; }
.btn:disabled, .cbi-button:disabled { opacity: .55; cursor: not-allowed; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--border-color-low); text-align: left; font-size: 12px; }
th { color: var(--text-color-medium); font-weight: 600; }
</style>
<style>/* 主题 CSS（--theme-css 注入，模拟真实页面） */
__THEME_CSS__</style>
<style>__FANXPERT_CSS__</style>
</head>
<body>
<div class="preview-banner">__BANNER__</div>
__MARKUP__
<script>
/* 由预览生成器抽取的真实函数（绘图 + 参考表），用真实 DOM 承载 */
function _(text) { return text; }
function E(tag, attrs, children) {
	var el = document.createElement(tag);

	Object.keys(attrs || {}).forEach(function (key) {
		if (attrs[key] != null && attrs[key] !== false)
			el.setAttribute(key, attrs[key]);
	});

	(function append(kids) {
		if (kids == null || kids === false)
			return;
		if (Array.isArray(kids)) { kids.forEach(append); return; }
		el.appendChild(typeof kids === 'string' ? document.createTextNode(kids) : kids);
	})(children);

	return el;
}
function byId(id) { return document.getElementById(id); }
__CHART_FUNCTIONS__
var curveData = __CURVE_DATA__;
curveDataCache = curveData;
drawCurve(curveData);
renderRpmTable(curveData);
window.addEventListener('resize', function () { drawCurve(curveData); });
</script>
</body>
</html>
`;

function escapeHtml(text) {
	return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function serialize(node) {
	if (node == null || node === false)
		return '';
	if (typeof node === 'string' || typeof node === 'number')
		return escapeHtml(node);

	const attrs = Object.keys(node.attrs || {}).filter(function (key) {
		const value = node.attrs[key];
		return value != null && value !== false && key !== 'click' && key !== 'change' && key !== 'focus' && key !== 'blur';
	}).map(function (key) {
		const value = node.attrs[key];
		return ' ' + key + '="' + escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value) + '"';
	}).join('');

	const body = (node.children || []).map(serialize).join('');

	return '<' + node.tag + attrs + '>' + body + '</' + node.tag + '>';
}

/* 把桩数据写进预览标记（仅替换文本内容，保持真实节点结构） */
function applyPreviewValues(node) {
	walk(node, function (n) {
		if (!n.attrs || !n.attrs.id)
			return;

		const id = n.attrs.id;

		if (id === 'fanxpert-service-badge') {
			n.children = ['Service running'];
			n.attrs.class = 'fanxpert-badge is-running';
		} else if (id === 'fanxpert-calibration-gate-note') {
			n.attrs.style = null;
			n.children = ['Stop the service before calibration'];
		} else if (id === 'fanxpert-calibration-progress') {
			n.attrs.style = '';
		} else if (id === 'fanxpert-calibration-progress-bar') {
			n.attrs.style = 'width:40%';
		} else if (id === 'fanxpert-status-sources') {
			n.attrs.style = null;
			n.children = [previewText[id] || ''];
		} else if (id === 'fanxpert-mode-state') {
			n.children = [previewText[id] || ''];
		} else if (id === (previewFixed ? 'fanxpert-mode-fixed' : 'fanxpert-mode-standard')) {
			n.attrs.class = 'btn cbi-button fanxpert-mode is-active';
		} else if (id === 'fanxpert-calibration-result') {
			n.attrs.class = 'fanxpert-calibration-result success';
			n.attrs.style = '';
			n.children = [
				E('div', { 'class': 'result-title' }, '✓ Calibration complete: start threshold 28% (PWM: 71) [Measured]'),
				E('div', { 'class': 'result-sub' }, 'Verified with RPM feedback'),
				E('div', { 'class': 'result-detail' }, 'Stable RPM: 812')
			];
		} else if (previewText[id] !== undefined && n.children.length && typeof n.children[0] !== 'object') {
			n.children = [previewText[id]];
		} else if (previewText[id] !== undefined) {
			let replaced = false;
			walk(n, function (inner) {
				if (!replaced && inner.children && inner.children.length === 1 && typeof inner.children[0] !== 'object' && inner.children[0] === '--') {
					inner.children = [previewText[id]];
					replaced = true;
				}
			});
		}
	});
}

/* 从真实源码里抽取绘图函数，避免预览与实现脱节 */
function extractFunction(source, name) {
	const start = source.indexOf('function ' + name + '(');
	if (start < 0)
		throw new Error('未找到函数: ' + name);

	let depth = 0;
	for (let i = source.indexOf('{', start); i < source.length; i++) {
		if (source[i] === '{')
			depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0)
				return source.slice(start, i + 1);
		}
	}

	throw new Error('函数体不完整: ' + name);
}

function chartScript() {
	const source = fs.readFileSync(VIEW, 'utf8');
	const names = ['percentToPwm', 'pwmToPercent', 'bezierPercent', 'curvePercentAt', 'previewCurvePoints',
		'chartMetrics', 'pctY', 'tempX', 'curveAxisRange', 'anchorPercent', 'curveAnchors',
		'hitTestAnchor', 'clampCurveParams', 'themeColor', 'curveCanvasMetrics', 'curvePwmMax',
		'currentCurveParams', 'drawCurveAnchors', 'drawCurve', 'renderRpmTable'];

	/* 公共块整份注入（函数 + 常量都在），新增内容无需再手工登记 */
	const block = fs.readFileSync(path.join(__dirname, 'common-block.js'), 'utf8');
	const gap = /var MIN_TEMP_GAP = (\d+);/.exec(source);

	/* 预览里没有 uci / 视图状态，这里给出最小替身，让真实函数可以原样运行 */
	const shims = [
		block,
		'var MIN_TEMP_GAP = ' + (gap ? gap[1] : '5') + ';',
		'var curveDraft = null;',
		'var draggingAnchor = null;',
		'var curveDataCache = null;',
		'function getCurrentFanId() { return "cpu_fan"; }',
		'var uci = { get: function (pkg, section, option) {',
		'\tif (section === "cpu_fan" && option === "curve") return ' + JSON.stringify(previewCurve) + ';',
		'\tvar curves = {',
		'\t\tstandard: { temp_min: "35", temp_max: "75", pwm_start: "30", pwm_end: "100" },',
		'\t\tfixed: { type: "fixed", pwm_start: "50" }',
		'\t};',
		'\treturn curves[section] ? curves[section][option] : null;',
		'}, sections: function () { return []; } };'
	].join('\n');

	return shims + '\n\n' +
		names.map(function (name) { return extractFunction(source, name); }).join('\n\n');
}

function writePreview(node, options) {
	options = options || {};

	if (!options.logs)
		applyPreviewValues(node);

	const css = fs.readFileSync(CSS, 'utf8');
	const banner = noBanner ? '' : (options.banner || (
		'<b>FanXpert 页面排版预览</b>（静态）：使用真实视图代码渲染出的标记 + 真实 <code>fanxpert.css</code>，' +
		'曲线图由真实的 <code>drawCurve()</code> 绘制；桩数据：温度 45°C / 曲线 ' +
		(previewFixed ? 'Fixed Speed（固定转速）' : 'Standard') + '。' +
		'LuCI 主题样式（按钮、表单表格）为近似值，实际外观以路由器页面为准；' +
		'配色跟随你的浏览器/系统主题（与 LuCI 相同），可用 <code>?dark=1</code> / <code>?dark=0</code> 强制。'));
	const chart_script = options.chart_script !== undefined ? options.chart_script : chartScript();
	const curve_data = options.curve_data !== undefined ? options.curve_data
		: JSON.stringify(previewFixed ? fixedCurvePayload : curvePayload);
	const html = PREVIEW_SHELL
		.replace('__BANNER__', banner)
		.replace('__THEME_CSS__', themeCss)
		.replace('__FANXPERT_CSS__', css)
		.replace('__MARKUP__', serialize(node))
		.replace('__CHART_FUNCTIONS__', chart_script)
		.replace('__CURVE_DATA__', curve_data);

	fs.mkdirSync(path.dirname(htmlOut), { recursive: true });
	fs.writeFileSync(htmlOut, html);
	console.log('预览已生成: ' + path.relative(process.cwd(), htmlOut));
}

/* ============================================================
   4.5 日志页面
   ============================================================ */

const LOG_FIXTURE = [
	'Tue Sep 29 20:50:12 2026 daemon.notice FANXPERT: 配置已应用 - 风扇: CPU Fan',
	'Tue Sep 29 20:50:15 2026 daemon.err FANXPERT: 无法设置 PWM 值: 200',
	'Tue Sep 29 20:50:20 2026 daemon.debug FANXPERT: 状态报告 - 温度: 45°C'
];

let logPreviewNode = null;
let logPreviewList = [];
let logPreviewSummary = { count: '', level: '' };

function loadLogPreviewNode() {
	return logPreviewNode;
}

function runLogViewChecks() {
	resetElements();
	pollCallback = null;
	pollRemovals = 0;
	rpcState.logs = { ok: true, lines: LOG_FIXTURE.slice(), count: LOG_FIXTURE.length, log_level: 'notice' };

	/* 日志页的 render() 直接返回节点（主页面返回 Promise） */
	return Promise.resolve(loadView(LOG_VIEW).render(rpcState.logs)).then(function (node) {
		const list = els['fanxpert-log-list'];

		logPreviewNode = node;
		logPreviewList = list.childNodes.slice();
		logPreviewSummary = {
			count: els['fanxpert-log-count'].textContent,
			level: els['fanxpert-log-level-hint'].textContent
		};

		check('日志页：工具条齐全',
			!!findById(node, 'fanxpert-log-lines') && !!findById(node, 'fanxpert-log-filter') &&
			!!findById(node, 'fanxpert-log-auto') && !!list);

		check('日志页：渲染三行', list.childNodes.length === 3, String(list.childNodes.length));
		check('日志页：最新一条在最前',
			/状态报告/.test(cellText(list.childNodes[0])), cellText(list.childNodes[0]));
		check('日志页：错误行带 is-error 样式',
			/is-error/.test(list.childNodes[1].attrs.class || ''), String(list.childNodes[1].attrs.class));
		check('日志页：解析出级别与消息（不再含 syslog 前缀）',
			/配置已应用/.test(cellText(list.childNodes[2])) && !/daemon\./.test(cellText(list.childNodes[2])),
			cellText(list.childNodes[2]));
		check('日志页：回显日志级别',
			/notice/.test(els['fanxpert-log-level-hint'].textContent), els['fanxpert-log-level-hint'].textContent);

		/* 本地过滤 */
		const filter = findById(node, 'fanxpert-log-filter');
		filter.attrs.input({ target: { value: 'PWM' } });
		check('日志页：过滤只保留匹配行', list.childNodes.length === 1, String(list.childNodes.length));

		filter.attrs.input({ target: { value: '' } });
		check('日志页：清空过滤后恢复', list.childNodes.length === 3, String(list.childNodes.length));

		/* 关闭自动刷新 */
		const auto = findById(node, 'fanxpert-log-auto');
		auto.attrs.change({ target: { checked: false } });
		check('日志页：关闭自动刷新会移除轮询', pollRemovals >= 1, String(pollRemovals));

		/* 空状态 */
		rpcState.logs = { ok: true, lines: [], count: 0, log_level: 'debug' };

		return pollCallback().then(function () {
			check('日志页：空状态提示',
				list.childNodes.length === 1 && /fanxpert-log-empty/.test(list.childNodes[0].attrs.class || '') &&
				/debug/.test(cellText(list.childNodes[0])), cellText(list.childNodes[0]));
		});
	});
}

/* ============================================================
   4.2 配置页面
   ============================================================ */

function runConfigViewChecks() {
	resetElements();
	formOptions.length = 0;
	formMaps.length = 0;
	rpcCalls.length = 0;

	return Promise.resolve(loadView(CONFIG_VIEW).render()).then(function (node) {
		check('配置页不含实时面板',
			!findById(node, 'fanxpert-curve-canvas') && !findById(node, 'fanxpert-status-temp') &&
			!findById(node, 'fanxpert-service-badge'));

		runQuietGateChecks(true);
		runSensorOptionChecks();

		const curve_type = formOptions.filter(function (o) { return o.name === 'type'; })[0];
		const curve_type_values = curve_type ? curve_type.instance.values.map(function (v) { return v[0]; }) : [];

		check('曲线类型提供四种选择（贝塞尔在首位）',
			curve_type_values.join(',') === 'bezier,linear,step,fixed', JSON.stringify(curve_type_values));

		const levels = formOptions.filter(function (o) { return o.name === 'step_levels'; })[0];
		const level_values = levels ? levels.instance.values.map(function (v) { return v[0]; }) : [];

		check('阶梯档数提供多档可选',
			level_values.length >= 5 && level_values.indexOf('5') >= 0 && level_values.indexOf('8') >= 0,
			JSON.stringify(level_values));

		check('配置页包含表单', formMaps.length === 1, String(formMaps.length));
		check('表单提交钩子已挂载', !!(formMaps[0] && typeof formMaps[0].on_after_commit === 'function'));

		return Promise.resolve(formMaps[0].on_after_commit()).then(function () {
			check('提交后通知守护进程重载',
				rpcCalls.some(function (c) { return c.method === 'reload'; }),
				JSON.stringify(rpcCalls.map(function (c) { return c.method; })));
		});
	});
}

/* 日志页预览：把运行时填充的 DOM 桩内容搬回标记树 */
function writeLogPreview(node) {
	const listNode = findById(node, 'fanxpert-log-list');

	if (listNode)
		listNode.children = logPreviewList.slice();

	const summary = findById(node, 'fanxpert-log-summary');
	if (summary)
		summary.attrs.style = null;

	const countNode = findById(node, 'fanxpert-log-count');
	const levelNode = findById(node, 'fanxpert-log-level-hint');

	if (countNode)
		countNode.children = [ logPreviewSummary.count ];
	if (levelNode)
		levelNode.children = [ logPreviewSummary.level ];

	writePreview(node, {
		logs: true,
		banner: '<b>FanXpert 日志页面预览</b>（静态）：真实视图代码渲染出的标记 + 真实 <code>fanxpert.css</code>；' +
			'桩数据为三条示例日志（notice / err / debug）。' +
			'配色跟随你的浏览器/系统主题，可用 <code>?dark=1</code> / <code>?dark=0</code> 强制。',
		chart_script: 'function drawCurve() {}\nfunction renderRpmTable() {}',
		curve_data: '{}'
	});
}

/* ============================================================
   5. 运行
   ============================================================ */

/* 每个场景都重新加载视图模块并重置 DOM 桩，避免场景之间互相污染 */
function renderView(status, curve) {
	resetElements();
	formOptions.length = 0;
	pollCallback = null;
	rpcState.status = status;
	rpcState.curve = curve;
	rpcState.progress = { status: 'running', progress: 40, message: 'coarse' };

	/* 概览页的 render() 直接返回节点 */
	return Promise.resolve(loadView().render([{}, status, curve]));
}

renderView(statusPayload(3725, true, 900), curvePayload).then(function (node) {
	runChecks(node);
	if (htmlOut)
		writePreview(node);

	runSensorLineChecks();
	runI18nChecks();
	check('概览页不包含配置表单', formOptions.length === 0 && formMaps.length === 0,
		JSON.stringify({ options: formOptions.length, maps: formMaps.length }));
	runModeButtonChecks();
	runCurveMathChecks(loadCurveHelpers());
	runCurveDragChecks();

	return runModeClickChecks(node).then(pollCallback).then(function () {
		runLiveChecks();
		runRpmTableChecks();

		rpcState.status = statusPayload(90061, false, 1750);
		return pollCallback();
	}).then(function () {
		runStoppedChecks();

		rpcState.status = { ok: false, running: false, state: { error: 'fan not found' } };
		return pollCallback();
	}).then(function () {
		runErrorChecks();

		/* 无转速传感器的设备：转速回落为百分比，参考表给出提示 */
		const noRpmCurve = Object.assign({}, curvePayload, { rpm_table: [] });
		return renderView(statusPayload(3600, true, undefined, null), noRpmCurve);
	}).then(function () {
		return pollCallback();
	}).then(function () {
		runNoRpmChecks();

		return renderView(statusPayload(1200, true, 800), curvePayload);
	}).then(function () {
		return runConfigViewChecks();
	}).then(function () {
		/* 未校准的设备：配置页里两个开关应为只读 */
		uciValues.fanxpert.cpu_fan.pwm_min_start = '0';
		uciValues.fanxpert.cpu_fan.pwm_min_start_source = 'unknown';
		uciValues.fanxpert.cpu_fan.quiet_mode = '0';

		resetElements();
		formOptions.length = 0;
		formMaps.length = 0;

		return Promise.resolve(loadView(CONFIG_VIEW).render());
	}).then(function () {
		runQuietGateChecks(false);

		return runLogViewChecks();
	}).then(function () {
		if (htmlOut && previewView === 'logs')
			writeLogPreview(loadLogPreviewNode());
	});
}).catch(function (err) {
	console.log('THREW: ' + (err && err.stack || err));
	process.exit(1);
}).then(function () {
	if (failures.length) {
		console.log('FAIL (' + failures.length + ')');
		failures.forEach(function (f) { console.log('  ✗ ' + f); });
		process.exit(1);
	}

	console.log('PASS — ' + checkCount + ' 项检查通过（概览页、配置页、日志页、翻译覆盖、模式切换、曲线数学与拖拽编辑、实时刷新、RPM 参考表、无传感器回落、停止态、错误态）');
});
