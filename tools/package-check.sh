#!/bin/sh
# ============================================================================
# 打包自检：确保发布的包里没有「丢了执行位」这类致命缺陷
# ============================================================================
# 背景（真实事故）：v0.1.0_alpha2 发布包里 /etc/init.d/fanxpert 与
# /usr/sbin/fanxpert.sh 权限为 0644，导致安装脚本 default_postinst 执行
# `"$i" enable` / `"$i" start` 时报 Permission denied；更严重的是重启后
# 服务不会自启，风扇完全失去控制（用户侧表现为"装完就不控温了"）。
#
# 本脚本做两层断言：
#   1) 源仓库里这些文件的 git 模式必须是 100755（根因层）
#   2) 若提供 PKG_ARTIFACT=<.ipk|.apk>，解包后断言包内模式同样是 755（结果层）
#
# 用法：
#   sh tools/package-check.sh
#   PKG_ARTIFACT=dist/luci-app-fanxpert-*.ipk sh tools/package-check.sh
# ============================================================================

# shellcheck disable=SC3043

set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

FAILED=0
WARNED=0
CHECKS=0

pass() { CHECKS=$((CHECKS + 1)); printf '  PASS %s\n' "$1"; }
fail() { CHECKS=$((CHECKS + 1)); FAILED=$((FAILED + 1)); printf '  FAIL %s\n' "$1"; }

# 随包发布、必须可执行的文件（缺失/丢位 = 致命：重启后服务不自启）
EXEC_FILES="
luci-app-fanxpert/root/etc/init.d/fanxpert
luci-app-fanxpert/root/usr/sbin/fanxpert.sh
luci-app-fanxpert/root/etc/uci-defaults/80_fanxpert
"

# 开发机工具：同样要求可执行，但"未纳入 git 追踪"只算警告（不影响发布件）
TOOL_FILES="
tools/deploy-test.sh
tools/daemon-check.sh
tools/package-check.sh
tools/view-check.js
tools/sync-common.js
tools/po2lmo.py
"

echo "[1] 源仓库文件模式（git index）"
for f in $EXEC_FILES; do
    mode=$(git ls-files -s -- "$f" 2>/dev/null | awk '{print $1}' | head -1)

    if [ -z "$mode" ]; then
        fail "未纳入 git 追踪: $f"
    elif [ "$mode" = "100755" ]; then
        pass "$f (100755)"
    else
        fail "$f 的模式是 ${mode}，应为 100755（修复：git update-index --chmod=+x -- ${f}）"
    fi
done

# rpcd 模块由 rpcd 读取（不执行），只要求存在且可读
READ_FILES="
luci-app-fanxpert/root/usr/share/rpcd/ucode/fanxpert
luci-app-fanxpert/root/etc/config/fanxpert
"

# 工作区实际文件也必须可执行：deploy-test.sh 会按此位判断能否在设备上运行
echo "[1b] 开发工具的可执行位与追踪状态（缺失只警告，不进发布件）"
for f in $TOOL_FILES; do
    if [ ! -f "$f" ]; then
        fail "缺少开发工具: $f"
        continue
    fi

    if [ ! -x "$f" ]; then
        fail "$f 不可执行（chmod 755 $f）"
        continue
    fi

    if git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
        pass "$f 可执行且已纳入 git"
    else
        WARNED=$((WARNED + 1))
        printf '  WARN %s 可执行但未纳入 git 追踪（README 中记录了它，克隆后却不存在）\n' "$f"
    fi
done

echo "[2] 工作区文件的可执行位"
for f in $EXEC_FILES; do
    [ -f "$f" ] || continue

    if [ -x "$f" ]; then
        pass "$f 可执行"
    else
        fail "$f 在当前工作区不可执行（chmod 755 ${f}）"
    fi
done

echo "[2b] rpcd 模块与配置模板可读性"
for f in $READ_FILES; do
    if [ -r "$f" ]; then
        pass "$f 可读（$(git ls-files -s -- "$f" | awk '{print $1}' | head -1)）"
    else
        fail "$f 不存在或不可读"
    fi
done

echo "[3] 打包配置完整性"
CONFFILE="luci-app-fanxpert/root/etc/config/fanxpert"
if [ -f "$CONFFILE" ]; then
    pass "随包携带默认配置: $CONFFILE"
else
    fail "缺少 ${CONFFILE}（安装时 uci 读写会报 Entry not found）"
fi

if grep -q '^/etc/config/fanxpert$' luci-app-fanxpert/Makefile 2>/dev/null; then
    pass "Makefile 已声明 conffiles（升级保留用户配置）"
else
    fail "Makefile 的 Package/luci-app-fanxpert/conffiles 未声明 /etc/config/fanxpert"
fi

UCI_DEFAULTS=luci-app-fanxpert/root/etc/uci-defaults/80_fanxpert
heal_line=$(grep -n '^chmod 755 /etc/init.d/fanxpert' "$UCI_DEFAULTS" 2>/dev/null | cut -d: -f1)
exit_line=$(grep -n 'uci -q get fanxpert.settings >/dev/null 2>&1 && exit 0' "$UCI_DEFAULTS" 2>/dev/null | cut -d: -f1)

if [ -z "$heal_line" ]; then
    fail "uci-defaults 缺少可执行位自愈逻辑（坏包将无法自我修复）"
elif [ -z "$exit_line" ]; then
    pass "uci-defaults 含自愈逻辑（该脚本无提前退出）"
elif [ "$heal_line" -lt "$exit_line" ]; then
    pass "uci-defaults 自愈逻辑位于提前退出之前（升级场景也能修复）"
else
    fail "uci-defaults 的自愈逻辑在提前退出之后（升级时不会执行）"
fi

enable_line=$(grep -n '/etc/init.d/fanxpert enable' "$UCI_DEFAULTS" 2>/dev/null | cut -d: -f1)
if [ -z "$enable_line" ]; then
    fail "uci-defaults 未在安装时补开机自启（升级自坏包的用户重启后仍会失控）"
elif [ -n "$exit_line" ] && [ "$enable_line" -gt "$exit_line" ]; then
    fail "uci-defaults 的 enable 逻辑在提前退出之后（升级场景不会执行）"
elif [ "$enable_line" -gt "$heal_line" ]; then
    pass "uci-defaults 先补执行位再补开机自启，且都在提前退出之前"
else
    fail "启用逻辑必须在 chmod 之后（否则 init 脚本尚不可执行）"
fi

for j in luci-app-fanxpert/root/usr/share/luci/menu.d/luci-app-fanxpert.json \
         luci-app-fanxpert/root/usr/share/rpcd/acl.d/luci-app-fanxpert.json; do
    if python3 -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8'))" "$j" 2>/dev/null; then
        pass "JSON 合法: $(basename "$j")"
    else
        fail "JSON 解析失败: $j"
    fi
done

# ── 产物层断言（可选）───────────────────────────────────────────────────
if [ -n "${PKG_ARTIFACT:-}" ]; then
    echo "[4] 安装包内容与模式: $PKG_ARTIFACT"
    WORK=$(mktemp -d "${TMPDIR:-/tmp}/fanxpert-pkgcheck.XXXXXX") || exit 1
    trap 'rm -rf "$WORK"' EXIT INT TERM

    ok_extract=0
    case "$PKG_ARTIFACT" in
        *.ipk)
            # 现代 OpenWrt 的 .ipk 是「tar.gz 包着 control.tar.gz / data.tar.gz」；
            # 更早的 SDK 则产出 ar 归档。两种都试，任一成功即可。
            if tar -xzf "$PKG_ARTIFACT" -C "$WORK" 2>/dev/null && [ -f "$WORK/data.tar.gz" ]; then
                tar -xzf "$WORK/data.tar.gz" -C "$WORK" 2>/dev/null && ok_extract=1
            elif command -v ar >/dev/null 2>&1; then
                (cd "$WORK" && ar x "$(cd "$(dirname "$PKG_ARTIFACT")" && pwd)/$(basename "$PKG_ARTIFACT")" 2>/dev/null) &&
                    tar -xzf "$WORK/data.tar.gz" -C "$WORK" 2>/dev/null && ok_extract=1
            fi
            if [ "$ok_extract" -ne 1 ]; then
                fail "无法解包 .ipk（打包格式变化或缺少工具）——产物级校验不能静默跳过"
            fi
            ;;
        *.apk)
            # apk v3 使用 ADB 私有容器（内含裸 deflate 段，没有标准 tar 头），
            # 不借助 apk-tools 无法可靠解析。此处明确标注「未做产物级校验」，
            # 而不是打印 SKIP 后当作通过——apk 渠道的保障来自：
            #   1) 源文件模式断言（根因层，两个渠道共用同一份源码）
            #   2) ipk 渠道的产物级校验（同一套 luci.mk 安装规则）
            #   3) 真机安装验收（apk add 后确认 755 且服务自启）
            printf '  WARN apk v3 为 ADB 私有容器，未做产物级校验（依赖源文件断言 + ipk 产物断言 + 真机验收）\n'
            WARNED=$((WARNED + 1))
            rm -rf "$WORK"; trap - EXIT INT TERM
            ;;
    esac

    if [ "$ok_extract" -eq 1 ]; then
        for pair in "etc/init.d/fanxpert" "usr/sbin/fanxpert.sh" "etc/uci-defaults/80_fanxpert"; do
            target="$WORK/$pair"

            if [ ! -e "$target" ]; then
                fail "包内缺少 $pair"
            elif [ -x "$target" ]; then
                pass "包内可执行: $pair"
            else
                # shellcheck disable=SC2012  # 把单个已知路径的权限位打印给人看，不涉及通配匹配
                fail "包内 $pair 权限为 $(ls -ld "$target" | cut -c1-10)，必须为 755（否则重启后服务不自启）"
            fi
        done

        if [ -f "$WORK/etc/config/fanxpert" ]; then
            pass "包内携带默认配置 /etc/config/fanxpert"
        else
            fail "包内缺少默认配置 /etc/config/fanxpert"
        fi
    fi
else
    printf '\n[4] 产物层断言 SKIP（未提供 PKG_ARTIFACT=<.ipk|.apk>）\n'
fi

echo
if [ "$FAILED" -eq 0 ]; then
    if [ "$WARNED" -gt 0 ]; then
        printf 'PASS — 打包自检通过（%d 项），另有 %d 条警告（未纳入 git 的开发工具）\n' "$CHECKS" "$WARNED"
    else
        printf 'PASS — 打包自检全部通过（%d 项）\n' "$CHECKS"
    fi
    exit 0
fi

printf 'FAIL — 打包自检发现 %d 项问题（共 %d 项）\n' "$FAILED" "$CHECKS"
exit 1
