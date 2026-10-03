#!/usr/bin/env python3
"""
PO → LMO 转换器（LuCI 的翻译文件格式）
=============================================================================
LuCI 不读 GNU 的 .mo，而是自己的 .lmo 格式（见 luci-base 的 src/po2lmo.c 与
src/lib/lmo.c）。这个脚本用纯 Python 复刻同样的输出，方便在开发机上编译翻
译并随 tools/deploy-test.sh 一起部署，无需 OpenWrt SDK 或 po2lmo 二进制。

格式（uint32 为网络字节序/大端，字符串按 4 字节对齐补零）：
    [翻译值 1][翻译值 2]...[索引项 1..n][uint32 索引偏移]
    索引项 = key_id(4) + val_id(4) + offset(4) + length(4)，按 key_id 升序
    key_id = sfh_hash(msgid)，val_id = 复数序号 + 1（普通条目为 1）
    PO 头部的 "Plural-Forms:" 行额外写成一条 key_id = val_id = 0 的条目

用法：
    python3 tools/po2lmo.py input.po output.lmo
=============================================================================
"""

import struct
import sys


def sfh_hash(data: bytes, init: int) -> int:
    """与 luci-base src/lib/lmo.c 的 sfh_hash() 完全一致"""
    length = len(data)

    if length <= 0:
        return 0

    def get16(offset):
        return data[offset] | (data[offset + 1] << 8)

    def signed(byte):
        return byte - 256 if byte >= 128 else byte

    h = init & 0xFFFFFFFF
    rem = length & 3
    blocks = length >> 2
    pos = 0

    for _ in range(blocks):
        h = (h + get16(pos)) & 0xFFFFFFFF
        tmp = ((get16(pos + 2) << 11) ^ h) & 0xFFFFFFFF
        h = ((h << 16) ^ tmp) & 0xFFFFFFFF
        pos += 4
        h = (h + (h >> 11)) & 0xFFFFFFFF

    if rem == 3:
        h = (h + get16(pos)) & 0xFFFFFFFF
        h ^= (h << 16) & 0xFFFFFFFF
        h ^= (signed(data[pos + 2]) << 18) & 0xFFFFFFFF
        h = (h + (h >> 11)) & 0xFFFFFFFF
    elif rem == 2:
        h = (h + get16(pos)) & 0xFFFFFFFF
        h ^= (h << 11) & 0xFFFFFFFF
        h = (h + (h >> 17)) & 0xFFFFFFFF
    elif rem == 1:
        h = (h + signed(data[pos])) & 0xFFFFFFFF
        h ^= (h << 10) & 0xFFFFFFFF
        h = (h + (h >> 1)) & 0xFFFFFFFF

    h ^= (h << 3) & 0xFFFFFFFF
    h = (h + (h >> 5)) & 0xFFFFFFFF
    h ^= (h << 4) & 0xFFFFFFFF
    h = (h + (h >> 17)) & 0xFFFFFFFF
    h ^= (h << 25) & 0xFFFFFFFF
    h = (h + (h >> 6)) & 0xFFFFFFFF

    return h


def extract_string(line: str) -> str:
    """取出 po 行里引号内的内容：只反转义 \\" 与 \\\\，其它反斜杠序列原样保留"""
    if line.startswith('#'):
        return ''

    start = line.find('"')
    if start < 0:
        return ''

    out = []
    esc = False

    for ch in line[start + 1:]:
        if esc:
            if ch in ('"', '\\'):
                out.append(ch)
            else:
                out.append('\\')
                out.append(ch)
            esc = False
        elif ch == '\\':
            esc = True
        elif ch == '"':
            break
        else:
            out.append(ch)

    return ''.join(out)


def parse_po(path):
    """返回 [(key, value, plural_index)]，顺序与文件一致"""
    entries = []
    ctxt = None
    msgid = None
    plural_id = None
    values = {}
    plural_num = 0

    def flush():
        nonlocal ctxt, msgid, plural_id, values, plural_num

        if msgid is None:
            values = {}
            plural_num = 0
            return

        if msgid == '':
            # 头部：写入 Plural-Forms 行
            header = values.get(0, '')
            for field in header.replace('\\n', '\n').split('\n'):
                if field.lower().startswith('plural-forms: '):
                    entries.append((None, field[len('plural-forms: '):], 0))
                    break
        else:
            for idx, val in sorted(values.items()):
                if not val:
                    continue

                key = msgid
                if ctxt and plural_id:
                    key = '%s\1%s\2%d' % (ctxt, msgid, idx)
                elif ctxt:
                    key = '%s\1%s' % (ctxt, msgid)
                elif plural_id:
                    key = '%s\2%d' % (msgid, idx)

                entries.append((key, val, idx + 1))

        ctxt = None
        msgid = None
        plural_id = None
        values = {}
        plural_num = 0

    with open(path, encoding='utf-8') as fh:
        for raw in fh:
            line = raw.rstrip('\n')

            if line.startswith('msgctxt "'):
                flush()
                ctxt = ''
                target = 'ctxt'
            elif line.startswith('msgid_plural "'):
                plural_id = ''
                target = 'plural'
            elif line.startswith('msgid "'):
                flush()
                msgid = ''
                target = 'id'
            elif line.startswith('msgstr['):
                plural_num = int(line[7:line.index(']')])
                values[plural_num] = ''
                target = 'value'
            elif line.startswith('msgstr "'):
                plural_num = 0
                values[0] = ''
                target = 'value'
            elif line.startswith('"'):
                target = target  # 续行，写入当前目标
            else:
                continue

            text = extract_string(line)

            if target == 'ctxt':
                ctxt = (ctxt or '') + text
            elif target == 'plural':
                plural_id = (plural_id or '') + text
            elif target == 'id':
                msgid = (msgid or '') + text
            elif target == 'value':
                values[plural_num] = values.get(plural_num, '') + text

    flush()

    return entries


def build_lmo(entries):
    data = bytearray()
    index = []
    offset = 0

    for key, value, val_id in entries:
        raw = value.encode('utf-8')

        if key is None:
            key_id = 0
            val_id = 0
        else:
            key_raw = key.encode('utf-8')
            key_id = sfh_hash(key_raw, len(key_raw))
            val_id_hash = sfh_hash(raw, len(raw))

            if key_id == val_id_hash:
                continue

        index.append((key_id, val_id, offset, len(raw)))
        data += raw
        pad = (4 - (len(raw) % 4)) % 4
        data += b'\0' * pad
        offset += len(raw) + pad

    if not data:
        return b''

    out = bytearray(data)

    # 索引在前、总长度在后；所有 uint32 都是网络字节序（与 po2lmo 的 htonl 一致）
    for key_id, val_id, off, length in sorted(index, key=lambda e: e[0]):
        out += struct.pack('>IIII', key_id, val_id, off, length)

    out += struct.pack('>I', offset)

    return bytes(out)


def main():
    if len(sys.argv) != 3:
        print('用法: %s input.po output.lmo' % sys.argv[0], file=sys.stderr)
        return 1

    lmo = build_lmo(parse_po(sys.argv[1]))

    if not lmo:
        print('没有可写入的翻译条目', file=sys.stderr)
        return 1

    with open(sys.argv[2], 'wb') as fh:
        fh.write(lmo)

    return 0


if __name__ == '__main__':
    sys.exit(main())
