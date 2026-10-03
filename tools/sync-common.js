#!/usr/bin/env node
/*
 * 把 tools/common-block.js（公共代码的单一来源）注入到各视图的标记之间。
 *
 * 之所以在构建期注入而不是做成 LuCI 模块：官方模板（luci-app-example）的视图
 * 都是自包含的，跨文件模块一旦在加载器或中间层出问题会导致整页加载失败。
 *
 *   node tools/sync-common.js           写入
 *   node tools/sync-common.js --check   只校验（用于测试）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BLOCK_FILE = path.join(__dirname, 'common-block.js');
const VIEW_DIR = path.join(ROOT, 'luci-app-fanxpert/htdocs/luci-static/resources/view/fanxpert');

const VIEWS = [ 'overview.js', 'config.js', 'logs.js' ];

const BEGIN = '/* ==== BEGIN FanXpert 公共块（由 tools/sync-common.js 生成，勿手改） ==== */';
const END = '/* ==== END FanXpert 公共块 ==== */';

const block = fs.readFileSync(BLOCK_FILE, 'utf8').trimEnd();

/* 防呆：单一来源被清空/截断时直接报错，别把空块同步进三个视图 */
if (block.length < 500 || !/function\s+byId/.test(block)) {
	console.error('tools/common-block.js 内容异常（长度 ' + block.length + '，缺少 byId），已中止');
	process.exit(1);
}
const want = `${BEGIN}\n${block}\n${END}`;

const check = process.argv.includes('--check');
let failures = 0;

for (const name of VIEWS) {
	const file = path.join(VIEW_DIR, name);
	let source = fs.readFileSync(file, 'utf8');

	const begin = source.indexOf(BEGIN);
	const end = source.indexOf(END);

	if (begin < 0 || end < 0) {
		console.error(`${name}: 找不到公共块标记`);
		failures++;
		continue;
	}

	/* 不变量：公共块必须排在所有 'require ...' 之后。
	 * luci.js 的依赖扫描器遇到第一个非 require 字符串就停止扫描，
	 * 块若插在 require 中间，后面的依赖不会被注入（曾因此报 uci is not defined）。 */
	const lines = source.split('\n');
	const block_line = lines.findIndex(l => l.includes(BEGIN));
	const last_require = lines.reduce((acc, l, i) =>
		/^'require [^']+';$/.test(l.trim()) ? i : acc, -1);

	if (last_require > block_line) {
		if (check) {
			console.error(`${name}: 公共块排在 'require' 之前（第 ${block_line + 1} 行 vs 第 ${last_require + 1} 行），后面的依赖不会被注入`);
			failures++;
			continue;
		}

		/* 写入模式下先把块搬到最后一条 require 之后 */
		const without = lines.slice(0, block_line).concat(lines.slice(lines.findIndex(l => l.includes(END)) + 1));
		const reqs = without.reduce((acc, l, i) => (/^'require [^']+';$/.test(l.trim()) ? i : acc), -1);
		source = without.slice(0, reqs + 1)
			.concat([ '' ], want.split('\n'), without.slice(reqs + 1)).join('\n');

		const b = source.indexOf(BEGIN);
		const e = source.indexOf(END);
		console.log(`${name}: 公共块已挪到 require 之后`);
		fs.writeFileSync(file, source.slice(0, b) + want + source.slice(e + END.length));
		continue;
	}

	const current = source.slice(begin, end + END.length);

	if (current === want) {
		if (!check)
			console.log(`${name}: 已是最新`);
		continue;
	}

	if (check) {
		console.error(`${name}: 公共块与 tools/common-block.js 不一致（请运行 node tools/sync-common.js）`);
		failures++;
		continue;
	}

	fs.writeFileSync(file, source.slice(0, begin) + want + source.slice(end + END.length));
	console.log(`${name}: 已更新公共块`);
}

process.exit(check && failures ? 1 : 0);
