'use strict';
'require view';
'require form';
'require rpc';
'require poll';
'require ui';
'require uci';

var FAN_ID = 'cpu_fan';

var callStatus = rpc.declare({ object: 'fanxpert', method: 'status', expect: { '': {} } });
var callCurveData = rpc.declare({ object: 'fanxpert', method: 'curve_data', params: [ 'fan' ], expect: { '': {} } });
var callCalibrate = rpc.declare({ object: 'fanxpert', method: 'calibrate', params: [ 'fan' ], expect: { '': {} } });
var callCalibrateProgress = rpc.declare({ object: 'fanxpert', method: 'calibrate_progress', expect: { '': {} } });
var callStart = rpc.declare({ object: 'fanxpert', method: 'start', expect: { '': {} } });
var callStop = rpc.declare({ object: 'fanxpert', method: 'stop', expect: { '': {} } });
var callRestart = rpc.declare({ object: 'fanxpert', method: 'restart', expect: { '': {} } });
var callReload = rpc.declare({ object: 'fanxpert', method: 'reload', expect: { '': {} } });
var calibrationSession = false;
var curveDataCache = null;
var PRESET_CURVES = [ 'silent', 'standard', 'performance' ];

function byId(id) {
	return document.getElementById(id);
}

function setText(id, value) {
	var el = byId(id);
	if (el)
		el.textContent = value == null || value === '' ? '--' : value;
}

function setNote(id, value) {
	var el = byId(id);
	if (!el)
		return;

	el.textContent = value || '';
	el.style.display = value ? '' : 'none';
}

function stateFromStatus(status) {
	return status && status.state && !status.state.error ? status.state : null;
}

function currentDevice(status) {
	var state = stateFromStatus(status);
	return state && state.devices ? state.devices[FAN_ID] : null;
}

function serviceRunning(status) {
	return !!(status && status.running);
}

function isPresetCurve(section_id) {
	return PRESET_CURVES.indexOf(section_id) >= 0;
}

function sectionName(section) {
	return section ? section['.name'] || section.name : null;
}

function curveDisplayName(section_id) {
	switch (section_id) {
	case 'silent':
		return _('Silent');
	case 'standard':
		return _('Standard');
	case 'performance':
		return _('Performance');
	default:
		return section_id;
	}
}

function customCurveDisplayName(section_id) {
	return uci.get('fanxpert', section_id, 'label') || section_id;
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

function updateStatus(status) {
	var device = currentDevice(status);
	var state = stateFromStatus(status);

	setText('fanxpert-status-temp', device ? device.temp : 'N/A');
	setText('fanxpert-status-speed', device ? device.percent : 'N/A');
	setText('fanxpert-status-curve', device ? device.curve : _('Service not running'));
	setText('fanxpert-status-uptime', state && state.daemon ? state.daemon.uptime : 'N/A');
	setNote('fanxpert-status-note', status && status.state && status.state.error ? status.state.error : '');

	var calibrateButton = byId('fanxpert-start-calibration');
	if (calibrateButton)
		calibrateButton.disabled = serviceRunning(status);
	setNote('fanxpert-calibration-gate-note', serviceRunning(status) ? _('Stop service before calibration') : '');
}

function metric(label, id, unit) {
	return E('div', { 'class': 'fanxpert-metric' }, [
		E('span', { 'class': 'fanxpert-metric-label' }, label),
		E('span', { 'class': 'fanxpert-metric-value' }, [
			E('span', { 'id': id }, '--'),
			unit ? E('span', { 'class': 'fanxpert-metric-unit' }, unit) : ''
		])
	]);
}

function renderStatusPanel() {
	return E('div', { 'class': 'fanxpert-panel' }, [
		E('div', { 'class': 'fanxpert-status-grid' }, [
			metric(_('Temperature'), 'fanxpert-status-temp', '°C'),
			metric(_('Fan Speed'), 'fanxpert-status-speed', '%'),
			metric(_('Curve Mode'), 'fanxpert-status-curve', ''),
			metric(_('Uptime'), 'fanxpert-status-uptime', 's')
		]),
		E('div', { 'class': 'fanxpert-inline-actions' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': function(ev) {
					ev.preventDefault();
					refreshAllData();
				}
			}, _('Refresh Status')),
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': function(ev) {
					ev.preventDefault();
					callStart().then(refreshLiveData).catch(function(err) {
						ui.addNotification(null, E('p', err.message || String(err)), 'danger');
					});
				}
			}, _('Start Service')),
			E('button', {
				'class': 'btn cbi-button cbi-button-reset',
				'click': function(ev) {
					ev.preventDefault();
					callStop().then(refreshLiveData).catch(function(err) {
						ui.addNotification(null, E('p', err.message || String(err)), 'danger');
					});
				}
			}, _('Stop Service')),
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': function(ev) {
					ev.preventDefault();
					callRestart().then(refreshLiveData).catch(function(err) {
						ui.addNotification(null, E('p', err.message || String(err)), 'danger');
					});
				}
			}, _('Restart Service')),
			E('span', { 'id': 'fanxpert-status-note', 'class': 'fanxpert-status-note', 'style': 'display:none' })
		])
	]);
}

function clampNumber(value, min, max, fallback) {
	if (!isFinite(value) || value <= 0)
		value = fallback;

	return Math.min(Math.max(value, min), max);
}

function pctY(metrics, percent) {
	var top = 20, bottom = 42;
	var h = metrics.height - top - bottom;
	return metrics.height - bottom - (percent / 100) * h;
}

function tempX(metrics, range, temp) {
	var left = 60, right = 30;
	var w = metrics.width - left - right;
	var span = Math.max(1, range.temp_max - range.temp_min);
	return left + ((temp - range.temp_min) / span) * w;
}

function drawCurve(data) {
	var canvas = byId('fanxpert-curve-canvas');
	if (!canvas || !data || !data.curve_points || !data.range)
		return;

	var dpr = window.devicePixelRatio || 1;
	var rect = canvas.getBoundingClientRect();
	var metrics = {
		width: clampNumber(rect.width, 280, 620, 520),
		height: clampNumber(rect.height, 220, 360, 320)
	};

	canvas.width = Math.round(metrics.width * dpr);
	canvas.height = Math.round(metrics.height * dpr);

	var ctx = canvas.getContext('2d');
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, metrics.width, metrics.height);

	var left = 60, right = 30, top = 20, bottom = 42;
	var width = metrics.width, height = metrics.height;
	var range = data.range;

	ctx.strokeStyle = '#d7dde5';
	ctx.lineWidth = 1;
	ctx.setLineDash([2, 2]);
	for (var p = 0; p <= 100; p += 20) {
		var y = pctY(metrics, p);
		ctx.beginPath();
		ctx.moveTo(left, y);
		ctx.lineTo(width - right, y);
		ctx.stroke();
	}
	ctx.setLineDash([]);

	ctx.strokeStyle = '#667085';
	ctx.lineWidth = 1.5;
	ctx.beginPath();
	ctx.moveTo(left, top);
	ctx.lineTo(left, height - bottom);
	ctx.lineTo(width - right, height - bottom);
	ctx.stroke();

	ctx.fillStyle = '#475467';
	ctx.font = '12px sans-serif';
	ctx.textAlign = 'right';
	ctx.textBaseline = 'middle';
	for (var q = 0; q <= 100; q += 20)
		ctx.fillText(q + '%', left - 8, pctY(metrics, q));

	ctx.textAlign = 'center';
	ctx.textBaseline = 'alphabetic';
	var step = Math.max(5, Math.ceil((range.temp_max - range.temp_min) / 5 / 5) * 5);
	for (var t = range.temp_min; t <= range.temp_max; t += step)
		ctx.fillText(t + '°C', tempX(metrics, range, t), height - 18);

	var points = data.curve_points;
	ctx.strokeStyle = '#1e88e5';
	ctx.lineWidth = 2.5;
	ctx.beginPath();
	for (var i = 0; i < points.length; i++) {
		var x = tempX(metrics, range, points[i][0]);
		var y2 = pctY(metrics, points[i][1]);
		if (i === 0)
			ctx.moveTo(x, y2);
		else
			ctx.lineTo(x, y2);
	}
	ctx.stroke();

	var current = data.current;
	if (!current || !current.temp)
		return;

	var cx = tempX(metrics, range, current.temp);
	var cy = pctY(metrics, current.pwm_percent);

	ctx.strokeStyle = '#98a2b3';
	ctx.setLineDash([5, 5]);
	ctx.beginPath();
	ctx.moveTo(cx, cy);
	ctx.lineTo(cx, height - bottom);
	ctx.moveTo(cx, cy);
	ctx.lineTo(left, cy);
	ctx.stroke();
	ctx.setLineDash([]);

	ctx.fillStyle = '#e53935';
	ctx.beginPath();
	ctx.arc(cx, cy, 6, 0, Math.PI * 2);
	ctx.fill();

	var label = current.temp + '°C, ' + current.pwm_percent + '%';
	ctx.font = '12px sans-serif';
	var labelW = ctx.measureText(label).width + 12;
	var labelH = 22;
	var labelX = Math.min(Math.max(cx + 12, left + 8), width - right - labelW - 8);
	var labelY = Math.min(Math.max(cy - labelH - 8, top + 8), height - bottom - labelH - 8);

	ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
	ctx.fillRect(labelX, labelY, labelW, labelH);
	ctx.strokeStyle = '#e53935';
	ctx.strokeRect(labelX, labelY, labelW, labelH);
	ctx.fillStyle = '#202833';
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	ctx.fillText(label, labelX + 6, labelY + labelH / 2);
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

	if (curveDataCache.range) {
		if (temp < curveDataCache.range.temp_min)
			curveDataCache.range.temp_min = temp;
		if (temp > curveDataCache.range.temp_max)
			curveDataCache.range.temp_max = temp;
	}

	drawCurve(curveDataCache);
}

function renderCurvePanel() {
	return E('div', { 'class': 'fanxpert-panel fanxpert-curve-panel' }, [
		E('canvas', {
			'id': 'fanxpert-curve-canvas',
			'class': 'fanxpert-canvas',
			'width': '520',
			'height': '320'
		}),
		E('div', { 'class': 'fanxpert-inline-actions' }, [
			E('button', {
				'id': 'fanxpert-start-calibration',
				'class': 'btn cbi-button cbi-button-action',
				'click': function(ev) {
					ev.preventDefault();
					callCalibrate(FAN_ID).then(function(res) {
						ui.addNotification(null, E('p', res.error || res.message || _('Calibration started')), res.error ? 'danger' : 'info');
						if (!res.error) {
							calibrationSession = true;
							setNote('fanxpert-calibration-note', _('Calibration started') + ' (0%)');
							refreshAllData();
						}
					}).catch(function(err) {
						ui.addNotification(null, E('p', err.message || String(err)), 'danger');
					});
				}
			}, _('Start Calibration')),
			E('span', { 'id': 'fanxpert-calibration-gate-note', 'class': 'fanxpert-status-note', 'style': 'display:none' }),
			E('span', { 'id': 'fanxpert-calibration-note', 'class': 'fanxpert-status-note', 'style': 'display:none' })
		])
	]);
}

function refreshLiveData() {
	return Promise.all([
		callStatus().catch(function(err) { return { state: { error: err.message || String(err) } }; }),
		callCalibrateProgress().catch(function() { return null; })
	]).then(function(data) {
		updateStatus(data[0]);
		updateCurveCurrentFromStatus(data[0]);
		if (data[1] && !data[1].error) {
			if (data[1].status === 'running')
				calibrationSession = true;
			if (!calibrationSession && data[1].status !== 'running') {
				setNote('fanxpert-calibration-note', '');
				return;
			}

			var note = data[1].message || data[1].stage || '';
			if (data[1].progress != null)
				note = note ? note + ' (' + data[1].progress + '%)' : data[1].progress + '%';
			setNote('fanxpert-calibration-note', note);
		}
	});
}

function refreshCurveData() {
	return callCurveData(FAN_ID).then(function(data) {
		if (!data.error) {
			curveDataCache = data;
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

function addCurveOptions(section) {
	var o;
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
	var o = section.option(form.Value, 'label', _('Name'));
	o.placeholder = _('Custom Curve');

	o = section.option(form.ListValue, 'sensor', _('Sensor'));
	o.value('cpu_temp', _('CPU Temperature'));
	o.default = 'cpu_temp';
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('fanxpert'),
			callStatus().catch(function(err) { return { state: { error: err.message || String(err) } }; }),
			callCurveData(FAN_ID).catch(function(err) { return { error: err.message || String(err) }; })
		]);
	},

	render: function(data) {
		var m, s, o;

		m = new form.Map('fanxpert');
		m.on_after_commit = function() {
			return callReload().catch(function() {}).then(refreshAllData);
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

		o = s.taboption('hardware', form.Flag, 'never_stop', _('Never Stop'));
		o.rmempty = false;
		o.default = '1';
		o.description = _('Keep fan running at minimum speed instead of stopping');

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
			var node = E('div', {}, [
				E('link', { 'rel': 'stylesheet', 'href': L.resource('fanxpert/fanxpert.css') + '?v=20260605-modern4' }),
				E('h2', {}, _('FanXpert')),
				E('p', { 'class': 'fanxpert-page-description' }, _('Advanced fan speed control based on temperature sensors')),
				renderStatusPanel(),
				renderCurvePanel(),
				formNode
			]);

			window.setTimeout(function() {
				updateStatus(data[1]);
				if (!data[2].error) {
					curveDataCache = data[2];
					drawCurve(data[2]);
				}
				poll.add(refreshLiveData, 3);
			}, 0);

			return node;
		});
	}
});
