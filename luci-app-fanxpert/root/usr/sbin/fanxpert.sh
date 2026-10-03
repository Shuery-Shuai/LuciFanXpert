#!/bin/sh
# shellcheck disable=SC3043

# ============================================================
# FanXpert - Advanced FanXpert for OpenWrt/immortalwrt
# ============================================================

LOGGER="/usr/bin/logger"
PROGRAM_NAME="FANXPERT"

# 文件路径
STATE_FILE="/tmp/fanxpert.state"
PID_FILE="/tmp/run/fanxpert.pid"
RELOAD_FLAG="/tmp/fanxpert.reload_requested"
# 运行期观测到的「PWM 档位 → 最低转速」，每行: <fan_id> <档位百分比> <rpm>
RPM_MAP_FILE="/tmp/fanxpert.rpm_map"

# 重载状态跟踪（用于写入 state 文件）
LAST_RELOAD_TIME=0
LAST_RELOAD_STATUS="unknown"
LAST_RELOAD_ERROR=""

# 校准进度文件
CALIBRATE_PROGRESS_FILE="/tmp/fanxpert.calibrate.progress"

# PWM 控制范围
PWM_MIN=0
PWM_MAX=255

# 升速/降速时间默认值（秒 = 从最低转速到最高转速所需时间；0 = 不限制）
RAMP_UP_DEFAULT=30
RAMP_DOWN_DEFAULT=120

# 阶梯曲线的默认档数（每条曲线可用 step_levels 覆盖，范围 2-20）
STEP_LEVELS=5
STEP_LEVELS_MIN=2
STEP_LEVELS_MAX=20

# 极致静音的固定下调比例（%）：降低噪音，但不会低于校准得到的最低可用转速
QUIET_MODE_OFFSET=15

# 运行时全局变量
DAEMON_START_TIME=0
CONFIG_RELOAD_COUNT=0
ERROR_COUNT=0
ERROR_WINDOW_START=0
LAST_STATE_CONTENT=""
LAST_STATE_WRITE_TIME=0

# ============================================================
# LOGGING
# ============================================================

log_msg() {
    local level="$1"
    shift
    local message="$*"

    case "$level" in
        err|error)
            "$LOGGER" -t "$PROGRAM_NAME" -p daemon.err "$message"
            ;;
        warn|warning)
            "$LOGGER" -t "$PROGRAM_NAME" -p daemon.warn "$message"
            ;;
        notice)
            "$LOGGER" -t "$PROGRAM_NAME" -p daemon.notice "$message"
            ;;
        info)
            [ "$LOG_LEVEL" = "debug" ] || [ "$LOG_LEVEL" = "info" ] && \
                "$LOGGER" -t "$PROGRAM_NAME" -p daemon.info "$message"
            ;;
        debug)
            [ "$LOG_LEVEL" = "debug" ] && \
                "$LOGGER" -t "$PROGRAM_NAME" -p daemon.debug "$message"
            ;;
        *)
            # 未知级别兜底：宁可多记一条 notice，也不要静默丢弃日志
            "$LOGGER" -t "$PROGRAM_NAME" -p daemon.notice "$message"
            ;;
    esac
}

is_valid_id() {
    case "$1" in
        ""|*[!A-Za-z0-9_]*)
            return 1
            ;;
        *)
            return 0
            ;;
    esac
}

# 读取风扇转速（RPM）
# 参数: pwm_path (如 /sys/class/hwmon/hwmon0/pwm1)
# 返回: RPM 数值（整数），若无转速传感器或读取失败则输出空字符串
read_fan_rpm() {
    local pwm_path="$1"
    local fan_path
    # 将 /sys/class/hwmon/hwmonN/pwmX → /sys/class/hwmon/hwmonN/fanX_input
    fan_path="${pwm_path%pwm*}fan${pwm_path##*pwm}_input"
    if [ -r "$fan_path" ]; then
        local rpm
        rpm=$(tr -d ' ' < "$fan_path" 2>/dev/null)
        if [ -n "$rpm" ] && [ "$rpm" -eq "$rpm" ] 2>/dev/null; then
            echo "$rpm"
            return 0
        fi
    fi
    return 1
}

# 记录运行期观测到的「PWM 档位 → 最低转速」，按 10% 分档，供界面参考表使用。
# 参数: fan_id, percent, rpm
record_rpm_sample() {
    local fan_id="$1"
    local percent="$2"
    local rpm="$3"
    local bucket stored tmp

    case "$percent" in
        ''|*[!0-9]*) return 0 ;;
    esac
    case "$rpm" in
        ''|*[!0-9]*) return 0 ;;
    esac

    bucket=$(( (percent / 10) * 10 ))
    stored=$(sed -n "s/^${fan_id} ${bucket} //p" "$RPM_MAP_FILE" 2>/dev/null | head -n 1)

    # 已有更低的观测值就不再重写文件
    if [ -n "$stored" ] && [ "$rpm" -ge "$stored" ]; then
        return 0
    fi

    tmp="${RPM_MAP_FILE}.$$"
    if [ -f "$RPM_MAP_FILE" ]; then
        grep -v "^${fan_id} ${bucket} " "$RPM_MAP_FILE" > "$tmp" 2>/dev/null || : > "$tmp"
    else
        : > "$tmp"
    fi
    printf '%s %s %s\n' "$fan_id" "$bucket" "$rpm" >> "$tmp"
    mv "$tmp" "$RPM_MAP_FILE"

    return 0
}

# 输出某个风扇的「档位 → 最低转速」JSON 数组，例如 [[30,812],[50,1180]]
# 参数: fan_id
rpm_table_json() {
    local fan_id="$1" rows

    if [ -f "$RPM_MAP_FILE" ]; then
        rows=$(sort -k2,2n "$RPM_MAP_FILE" 2>/dev/null |
            awk -v fan="$fan_id" '$1 == fan { printf "%s[%d,%d]", (n++ ? "," : ""), $2, $3 }')
        if [ -n "$rows" ]; then
            printf '[%s]' "$rows"
            return 0
        fi
    fi

    printf '[]'

    return 0
}

# 写入重载状态到内存（下次写 state 文件时持久化）
write_reload_status() {
    local status="$1"   # success / failed
    local error="${2:-}"
    LAST_RELOAD_TIME=$(date +%s)
    LAST_RELOAD_STATUS="$status"
    LAST_RELOAD_ERROR="$error"
}

# 重置重载状态（在每次重载尝试之前调用）
reset_reload_status() {
    LAST_RELOAD_TIME=0
    LAST_RELOAD_STATUS="unknown"
    LAST_RELOAD_ERROR=""
}

json_escape() {
    printf '%s' "$1" | sed \
        -e 's/\\/\\\\/g' \
        -e 's/"/\\"/g' \
        -e 's/\t/\\t/g' \
        -e 's/\r/\\r/g' \
        -e ':a;N;$!ba;s/\n/\\n/g' \
        -e 's/[^[:print:]]/ /g'
}

# ============================================================
# CONFIGURATION MANAGEMENT
# ============================================================

load_uci_config() {
    # 读取全局设置
    LOG_LEVEL=$(uci -q get fanxpert.settings.log_level) || LOG_LEVEL="info"

    log_msg debug "开始加载 UCI 配置"
}

# ============================================================
# UCI CONFIGURATION SELF-HEALING
# ============================================================

# 确保 UCI 配置存在且结构完整（在守护进程启动时调用）
ensure_uci_config() {
    local need_commit=0

    # 0. 配置文件缺失时 uci set/commit 会报 "Entry not found" 且不写入任何内容，
    #    因此先把空配置文件建出来，让后续的自愈逻辑真正生效。
    [ -f /etc/config/fanxpert ] || touch /etc/config/fanxpert

    # 1. 检查全局 settings section
    if ! uci -q get fanxpert.settings >/dev/null 2>&1; then
        log_msg notice "UCI 配置缺失，正在创建默认配置..."
        uci -q batch <<'EOF'
set fanxpert.settings='global'
set fanxpert.settings.enabled='0'
set fanxpert.settings.log_level='info'

set fanxpert.silent='curve'
set fanxpert.silent.type='bezier'
set fanxpert.silent.sensor='cpu_temp'
set fanxpert.silent.temp_min='40'
set fanxpert.silent.temp_max='70'
set fanxpert.silent.pwm_start='20'
set fanxpert.silent.pwm_end='70'

set fanxpert.standard='curve'
set fanxpert.standard.type='bezier'
set fanxpert.standard.sensor='cpu_temp'
set fanxpert.standard.temp_min='35'
set fanxpert.standard.temp_max='75'
set fanxpert.standard.pwm_start='30'
set fanxpert.standard.pwm_end='100'

set fanxpert.performance='curve'
set fanxpert.performance.type='bezier'
set fanxpert.performance.sensor='cpu_temp'
set fanxpert.performance.temp_min='30'
set fanxpert.performance.temp_max='65'
set fanxpert.performance.pwm_start='40'
set fanxpert.performance.pwm_end='100'

set fanxpert.full_speed='curve'
set fanxpert.full_speed.type='bezier'
set fanxpert.full_speed.sensor='cpu_temp'
set fanxpert.full_speed.temp_min='0'
set fanxpert.full_speed.temp_max='100'
set fanxpert.full_speed.pwm_start='100'
set fanxpert.full_speed.pwm_end='100'

set fanxpert.fixed='curve'
set fanxpert.fixed.type='fixed'
set fanxpert.fixed.sensor='cpu_temp'
set fanxpert.fixed.pwm_start='50'

set fanxpert.cpu_temp='sensor'
set fanxpert.cpu_temp.type='hwmon'
set fanxpert.cpu_temp.platform='auto'
set fanxpert.cpu_temp.label='CPU Temperature'

set fanxpert.cpu_fan='fan'
set fanxpert.cpu_fan.enabled='1'
set fanxpert.cpu_fan.label='CPU Fan'
set fanxpert.cpu_fan.curve='standard'
set fanxpert.cpu_fan.pwm_path='auto'
set fanxpert.cpu_fan.pwm_min_start='0'
set fanxpert.cpu_fan.pwm_min_start_source='unknown'
set fanxpert.cpu_fan.pwm_min_start_timestamp='0'
set fanxpert.cpu_fan.never_stop='1'
add_list fanxpert.cpu_fan.sensors='cpu_temp'
set fanxpert.cpu_fan.quiet_mode='0'
set fanxpert.cpu_fan.auto_stop='0'
set fanxpert.cpu_fan.ramp_up_time='30'
set fanxpert.cpu_fan.ramp_down_time='120'

set fanxpert.custom_cpu_fan='curve'
set fanxpert.custom_cpu_fan.label='Custom CPU Fan'
set fanxpert.custom_cpu_fan.type='bezier'
set fanxpert.custom_cpu_fan.sensor='cpu_temp'
set fanxpert.custom_cpu_fan.temp_min='35'
set fanxpert.custom_cpu_fan.temp_max='75'
set fanxpert.custom_cpu_fan.pwm_start='30'
set fanxpert.custom_cpu_fan.pwm_end='100'
EOF
        need_commit=1
        log_msg notice "默认 UCI 配置已创建"
    fi

    # 2. 遍历所有 type='fan' 的 section，补齐缺失字段
    local fan_sections
    fan_sections=$(uci -q show fanxpert | grep -E '^fanxpert\.[^=]+=fan$' | cut -d. -f2 | cut -d= -f1)
    for section in $fan_sections; do
        local field_updated=0

        if ! uci -q get "fanxpert.${section}.pwm_min_start_source" >/dev/null 2>&1; then
            uci set "fanxpert.${section}.pwm_min_start_source=unknown"
            field_updated=1
        fi

        if ! uci -q get "fanxpert.${section}.pwm_min_start_timestamp" >/dev/null 2>&1; then
            uci set "fanxpert.${section}.pwm_min_start_timestamp=0"
            field_updated=1
        fi

        # 核心字段也要补齐：旧配置可能由更早的版本生成，缺 curve/pwm_path 等
        # 会让 LuCI 表单显示为空（守护进程有默认值，所以行为上看不出来）
        if ! uci -q get "fanxpert.${section}.enabled" >/dev/null 2>&1; then
            uci set "fanxpert.${section}.enabled=1"
            field_updated=1
        fi

        if ! uci -q get "fanxpert.${section}.label" >/dev/null 2>&1; then
            uci set "fanxpert.${section}.label=${section}"
            field_updated=1
        fi

        if ! uci -q get "fanxpert.${section}.curve" >/dev/null 2>&1; then
            uci set "fanxpert.${section}.curve=standard"
            field_updated=1
        fi

        if ! uci -q get "fanxpert.${section}.pwm_path" >/dev/null 2>&1; then
            uci set "fanxpert.${section}.pwm_path=auto"
            field_updated=1
        fi

        if ! uci -q get "fanxpert.${section}.pwm_min_start" >/dev/null 2>&1; then
            uci set "fanxpert.${section}.pwm_min_start=0"
            field_updated=1
        fi

        if ! uci -q get "fanxpert.${section}.never_stop" >/dev/null 2>&1; then
            uci set "fanxpert.${section}.never_stop=1"
            field_updated=1
        fi

        if ! uci -q get "fanxpert.${section}.sensors" >/dev/null 2>&1; then
            local legacy_curve legacy_sensor
            legacy_curve=$(uci -q get "fanxpert.${section}.curve") || legacy_curve="standard"
            legacy_sensor=$(uci -q get "fanxpert.${legacy_curve}.sensor") || legacy_sensor="cpu_temp"
            uci set "fanxpert.${section}.sensors=${legacy_sensor}"
            field_updated=1
        fi

        if ! uci -q get "fanxpert.${section}.quiet_mode" >/dev/null 2>&1; then
            uci set "fanxpert.${section}.quiet_mode=0"
            field_updated=1
        fi

        if ! uci -q get "fanxpert.${section}.auto_stop" >/dev/null 2>&1; then
            local legacy_never_stop
            legacy_never_stop=$(uci -q get "fanxpert.${section}.never_stop") || legacy_never_stop="1"
            if [ "$legacy_never_stop" = "1" ]; then
                uci set "fanxpert.${section}.auto_stop=0"
            else
                uci set "fanxpert.${section}.auto_stop=1"
            fi
            field_updated=1
        fi

        if ! uci -q get "fanxpert.${section}.ramp_up_time" >/dev/null 2>&1; then
            uci set "fanxpert.${section}.ramp_up_time=${RAMP_UP_DEFAULT}"
            field_updated=1
        fi

        if ! uci -q get "fanxpert.${section}.ramp_down_time" >/dev/null 2>&1; then
            uci set "fanxpert.${section}.ramp_down_time=${RAMP_DOWN_DEFAULT}"
            field_updated=1
        fi

        if [ "$field_updated" -eq 1 ]; then
            log_msg debug "补齐风扇 section ${section} 的元数据字段"
            need_commit=1
        fi
    done

    # 3. 检查预设曲线是否完整（四档模式：静音 / 标准 / 性能 / 全速）
    local preset
    for preset in silent standard performance full_speed fixed; do
        if ! uci -q get "fanxpert.${preset}" >/dev/null 2>&1; then
            case "$preset" in
                silent)
                    uci set fanxpert.silent='curve'
                    uci set fanxpert.silent.type='bezier'
                    uci set fanxpert.silent.sensor='cpu_temp'
                    uci set fanxpert.silent.temp_min='40'
                    uci set fanxpert.silent.temp_max='70'
                    uci set fanxpert.silent.pwm_start='20'
                    uci set fanxpert.silent.pwm_end='70'
                    ;;
                standard)
                    uci set fanxpert.standard='curve'
                    uci set fanxpert.standard.type='bezier'
                    uci set fanxpert.standard.sensor='cpu_temp'
                    uci set fanxpert.standard.temp_min='35'
                    uci set fanxpert.standard.temp_max='75'
                    uci set fanxpert.standard.pwm_start='30'
                    uci set fanxpert.standard.pwm_end='100'
                    ;;
                performance)
                    uci set fanxpert.performance='curve'
                    uci set fanxpert.performance.type='bezier'
                    uci set fanxpert.performance.sensor='cpu_temp'
                    uci set fanxpert.performance.temp_min='30'
                    uci set fanxpert.performance.temp_max='65'
                    uci set fanxpert.performance.pwm_start='40'
                    uci set fanxpert.performance.pwm_end='100'
                    ;;
                full_speed)
                    uci set fanxpert.full_speed='curve'
                    uci set fanxpert.full_speed.type='bezier'
                    uci set fanxpert.full_speed.sensor='cpu_temp'
                    uci set fanxpert.full_speed.temp_min='0'
                    uci set fanxpert.full_speed.temp_max='100'
                    uci set fanxpert.full_speed.pwm_start='100'
                    uci set fanxpert.full_speed.pwm_end='100'
                    ;;
                fixed)
                    uci set fanxpert.fixed='curve'
                    uci set fanxpert.fixed.type='fixed'
                    uci set fanxpert.fixed.sensor='cpu_temp'
                    uci set fanxpert.fixed.pwm_start='50'
                    ;;
                *)
                    log_msg warn "未知预设曲线，跳过: $preset"
                    continue
                    ;;
            esac
            need_commit=1
            log_msg notice "Restored missing preset curve: ${preset}"
        fi
    done

    # 4. 如果配置被创建或修改，提交 UCI
    if [ "$need_commit" -eq 1 ]; then
        uci commit fanxpert
        log_msg notice "UCI configuration updated"
    fi
}

load_sensor_config() {
    local sensor_id="$1"
    local type platform label

    type=$(uci -q get "fanxpert.$sensor_id.type") || return 1
    platform=$(uci -q get "fanxpert.$sensor_id.platform") || platform="auto"
    label=$(uci -q get "fanxpert.$sensor_id.label") || label="$sensor_id"

    if [ "$platform" = "auto" ]; then
        # 自动检测温度传感器
        platform=$(find_temp_sensor)
        if [ -z "$platform" ]; then
            log_msg err "无法为传感器 $sensor_id 自动检测温度传感器"
            return 1
        fi
        log_msg debug "传感器 $sensor_id 自动检测到: $platform"
    fi

    echo "$platform"
    return 0
}

detect_pwm_max() {
    local pwm_path="$1"
    local max_path="${pwm_path%pwm*}pwm${pwm_path##*pwm}_max"
    local max_value

    if [ -r "$max_path" ]; then
        max_value=$(tr -d ' ' < "$max_path" 2>/dev/null)
        if [ -n "$max_value" ] && [ "$max_value" -eq "$max_value" ] 2>/dev/null && [ "$max_value" -gt 0 ]; then
            PWM_MAX="$max_value"
            return 0
        fi
    fi

    return 1
}

load_curve_config() {
    local curve_id="$1"
    local type sensor temp_min temp_max pwm_start pwm_end step_levels

    type=$(uci -q get "fanxpert.$curve_id.type") || type="bezier"
    sensor=$(uci -q get "fanxpert.$curve_id.sensor") || return 1

    case "$type" in
        bezier)
            temp_min=$(uci -q get "fanxpert.$curve_id.temp_min") || temp_min=35
            temp_max=$(uci -q get "fanxpert.$curve_id.temp_max") || temp_max=75
            pwm_start=$(uci -q get "fanxpert.$curve_id.pwm_start") || pwm_start=30
            pwm_end=$(uci -q get "fanxpert.$curve_id.pwm_end") || pwm_end=100

            echo "$type|$sensor|$temp_min|$temp_max|$pwm_start|$pwm_end"
            ;;
        fixed)
            # 固定转速模式：只使用 pwm_start 作为目标转速，温度不参与计算
            pwm_start=$(uci -q get "fanxpert.$curve_id.pwm_start") || pwm_start=50

            echo "fixed|$sensor|0|100|$pwm_start|$pwm_start"
            ;;
        linear|step)
            # 线性 / 阶梯：与 bezier 使用同一组字段；阶梯另有第 7 个字段（档数）
            temp_min=$(uci -q get "fanxpert.$curve_id.temp_min") || temp_min=35
            temp_max=$(uci -q get "fanxpert.$curve_id.temp_max") || temp_max=75
            pwm_start=$(uci -q get "fanxpert.$curve_id.pwm_start") || pwm_start=30
            pwm_end=$(uci -q get "fanxpert.$curve_id.pwm_end") || pwm_end=100

            # 档数只对阶梯曲线有意义：仅 step 追加第 7 个字段
            if [ "$type" = "step" ]; then
                levels=$(uci -q get "fanxpert.$curve_id.step_levels") || levels="$STEP_LEVELS"
                levels=$(clamp_step_levels "$levels")

                echo "step|$sensor|$temp_min|$temp_max|$pwm_start|$pwm_end|$levels"
                return 0
            fi

            echo "$type|$sensor|$temp_min|$temp_max|$pwm_start|$pwm_end"
            ;;
        *)
            log_msg err "未知的曲线类型: $type"
            return 1
            ;;
    esac
    return 0
}

load_fan_config() {
    local fan_id="$1"
    local enabled label curve pwm_path pwm_min_start never_stop

    enabled=$(uci -q get "fanxpert.$fan_id.enabled") || enabled=1
    [ "$enabled" = "1" ] || return 1

    label=$(uci -q get "fanxpert.$fan_id.label") || label="$fan_id"
    curve=$(uci -q get "fanxpert.$fan_id.curve") || curve="standard"
    pwm_path=$(uci -q get "fanxpert.$fan_id.pwm_path") || pwm_path="auto"
    pwm_min_start=$(uci -q get "fanxpert.$fan_id.pwm_min_start") || pwm_min_start=0
    never_stop=$(uci -q get "fanxpert.$fan_id.never_stop") || never_stop=1

    if [ "$pwm_path" = "auto" ]; then
        # 自动检测 PWM 控制器
        pwm_path=$(find_pwm_controller)
        if [ -z "$pwm_path" ]; then
            log_msg err "无法为风扇 $fan_id 自动检测 PWM 控制器"
            return 1
        fi
        log_msg debug "风扇 $fan_id 自动检测到 PWM: $pwm_path"
    fi

    echo "$label|$curve|$pwm_path|$pwm_min_start|$never_stop"
    return 0
}

reload_config_from_uci() {
    log_msg notice "Configuration change detected, reloading UCI config"

    # 重新加载全局配置
    load_uci_config

    # 遍历所有风扇，重新加载配置
    # 这里简化处理，实际由 daemon_main_loop 重新初始化
    CONFIG_RELOAD_COUNT=$((CONFIG_RELOAD_COUNT + 1))

    log_msg notice "配置重载完成（第 $CONFIG_RELOAD_COUNT 次）"
}

reset_curve_to_default() {
    local curve_id="$1"

    case "$curve_id" in
        silent)
            uci set fanxpert.silent.temp_min='40'
            uci set fanxpert.silent.temp_max='70'
            uci set fanxpert.silent.pwm_start='20'
            uci set fanxpert.silent.pwm_end='70'
            ;;
        standard)
            uci set fanxpert.standard.temp_min='35'
            uci set fanxpert.standard.temp_max='75'
            uci set fanxpert.standard.pwm_start='30'
            uci set fanxpert.standard.pwm_end='100'
            ;;
        performance)
            uci set fanxpert.performance.temp_min='30'
            uci set fanxpert.performance.temp_max='65'
            uci set fanxpert.performance.pwm_start='40'
            uci set fanxpert.performance.pwm_end='100'
            ;;
        full_speed)
            uci set fanxpert.full_speed.temp_min='0'
            uci set fanxpert.full_speed.temp_max='100'
            uci set fanxpert.full_speed.pwm_start='100'
            uci set fanxpert.full_speed.pwm_end='100'
            ;;
        fixed)
            uci set fanxpert.fixed.type='fixed'
            uci set fanxpert.fixed.pwm_start='50'
            ;;
        *)
            log_msg err "无法恢复未知曲线: $curve_id"
            return 1
            ;;
    esac

    uci commit fanxpert
    log_msg notice "曲线 $curve_id 已恢复为默认值"
    return 0
}

# HARDWARE ABSTRACTION
# ============================================================

find_temp_sensor() {
    local found_temp=0
    local temp_path=""

    # 第一轮：优先匹配常见 CPU/热区关键词
    for hwmon in /sys/class/hwmon/hwmon*; do
        [ -d "$hwmon" ] || continue

        if [ -r "$hwmon/temp1_input" ] && [ -r "$hwmon/name" ]; then
            local name
            name=$(cat "$hwmon/name")
            case "$name" in
                *cpu*|*thermal*|*coretemp*|*k10temp*|*acpitz*|*pch*|*corsair*)
                    temp_path="$hwmon/temp1"
                    found_temp=1
                    log_msg debug "找到温度传感器: $temp_path (name: $name, 优先级匹配)"
                    break
                    ;;
            esac
        fi
    done

    # 第二轮：若未匹配到关键词，使用第一个可用的 temp1_input
    if [ "$found_temp" -eq 0 ]; then
        for hwmon in /sys/class/hwmon/hwmon*; do
            [ -d "$hwmon" ] || continue
            if [ -r "$hwmon/temp1_input" ]; then
                temp_path="$hwmon/temp1"
                found_temp=1
                local name
                name=$(cat "$hwmon/name" 2>/dev/null || echo "unknown")
                log_msg debug "找到备用温度传感器: $temp_path (name: $name)"
                break
            fi
        done
    fi

    if [ "$found_temp" -eq 1 ]; then
        echo "$temp_path"
        return 0
    fi
    return 1
}

find_pwm_controller() {
    local found_pwm=0
    local pwm_path=""

    # 第一轮：优先查找存在 pwm1_enable 且可写的设备
    for hwmon in /sys/class/hwmon/hwmon*; do
        [ -d "$hwmon" ] || continue

        if [ -w "$hwmon/pwm1_enable" ] && [ -w "$hwmon/pwm1" ]; then
            pwm_path="$hwmon/pwm1"
            found_pwm=1
            local name
            name=$(cat "$hwmon/name" 2>/dev/null || echo "unknown")
            log_msg debug "找到优先 PWM 控制器: $pwm_path (name: $name, 有 pwm_enable)"
            break
        fi
    done

    # 第二轮：若未找到带 enable 的，匹配关键词列表
    if [ "$found_pwm" -eq 0 ]; then
        for hwmon in /sys/class/hwmon/hwmon*; do
            [ -d "$hwmon" ] || continue

            if [ -w "$hwmon/pwm1" ] && [ -r "$hwmon/name" ]; then
                local name
                name=$(cat "$hwmon/name")
                case "$name" in
                    *pwm*|*fan*|*nct*|*it87*|*w837*|*w836*|*f718*|*nuvoton*)
                        pwm_path="$hwmon/pwm1"
                        found_pwm=1
                        log_msg debug "找到 PWM 控制器: $pwm_path (name: $name, 关键词匹配)"
                        break
                        ;;
                esac
            fi
        done
    fi

    # 第三轮：回退到第一个可用的 pwm1
    if [ "$found_pwm" -eq 0 ]; then
        for hwmon in /sys/class/hwmon/hwmon*; do
            [ -d "$hwmon" ] || continue

            if [ -w "$hwmon/pwm1" ]; then
                pwm_path="$hwmon/pwm1"
                found_pwm=1
                local name
                name=$(cat "$hwmon/name" 2>/dev/null || echo "unknown")
                log_msg debug "找到备用 PWM 控制器: $pwm_path (name: $name)"
                break
            fi
        done
    fi

    if [ "$found_pwm" -eq 1 ]; then
        echo "$pwm_path"
        return 0
    fi
    return 1
}

read_temperature() {
    local sensor_path="$1"
    local temp

    temp=$(cat "${sensor_path}_input" 2>/dev/null) || return 1

    # 验证温度值
    # shellcheck disable=SC2335  # 刻意的写法：依赖 -eq 对非数字报错返回非零来做类型校验，
    # 改成 [ -ne ] 会让非数字值“比较成功”而被放行，语义相反
    if [ -z "$temp" ] || ! [ "$temp" -eq "$temp" ] 2>/dev/null; then
        return 1
    fi

    # 转换为摄氏度
    echo "$((temp / 1000))"
    return 0
}

# 解析风扇的温度来源列表（最多 3 个，Fan Xpert 4 的“多测温点”）。
# 输出 "id:path" 形式，空格分隔；未配置 fan.sensors 时回落到曲线上的 sensor 字段。
load_sensor_paths() {
    local fan_id="$1"
    local ids id path out="" count=0
    local curve_id sensor_id

    # 调用方（reload_runtime_config / daemon_main_loop）会把 IFS 设成 '|' 用来切分
    # 配置字段，这里必须显式恢复按空格切分，否则 UCI 列表会被当成一个整体。
    local IFS=' '

    ids=$(uci -q get "fanxpert.$fan_id.sensors" 2>/dev/null) || ids=""

    if [ -z "$ids" ]; then
        curve_id=$(uci -q get "fanxpert.$fan_id.curve" 2>/dev/null) || curve_id="standard"
        sensor_id=$(uci -q get "fanxpert.$curve_id.sensor" 2>/dev/null) || sensor_id="cpu_temp"
        ids="$sensor_id"
    fi

    for id in $ids; do
        [ "$count" -ge 3 ] && break

        path=$(load_sensor_config "$id" 2>/dev/null) || continue
        [ -n "$path" ] || continue

        out="$out $id:$path"
        count=$((count + 1))
    done

    echo "${out# }"
    return 0
}

# 读取所有测温点并取最高温（与 Fan Xpert 4 一致）。
# 结果写入全局变量：TEMP_VALUE / TEMP_SOURCE_PATH / TEMP_SENSOR_JSON。
read_multi_temperature() {
    local pairs="$1"
    local pair id path value
    local hottest="" hottest_path="" json="" count=0

    local IFS=' '

    for pair in $pairs; do
        id="${pair%%:*}"
        path="${pair#*:}"
        [ -n "$path" ] || continue

        value=$(read_temperature "$path") || continue

        count=$((count + 1))
        json="$json${json:+,}[\"$(json_escape "$id")\",$value]"

        if [ -z "$hottest" ] || [ "$value" -gt "$hottest" ]; then
            hottest="$value"
            hottest_path="$path"
        fi
    done

    TEMP_VALUE="$hottest"
    TEMP_SOURCE_PATH="$hottest_path"
    TEMP_SENSOR_JSON="$json"

    [ -n "$hottest" ] || return 1
    return 0
}

# 多测温点版本的就绪检查：任一测温点可读 + PWM 可写即可
check_hardware_ready_multi() {
    local pairs="$1"
    local pwm_path="$2"
    local pair path value
    local waited=0

    local IFS=' '

    while [ "$waited" -lt 30 ]; do
        for pair in $pairs; do
            path="${pair#*:}"
            [ -n "$path" ] || continue

            value=$(read_temperature "$path") || continue
            [ "$value" -gt 0 ] || continue

            if [ ! -w "$pwm_path" ]; then
                log_msg debug "等待 PWM 控制器就绪: $pwm_path"
                sleep 1
                waited=$((waited + 1))
                continue 2
            fi

            log_msg notice "硬件就绪 - 最高温度: ${value}°C, PWM: $pwm_path"
            return 0
        done

        log_msg debug "等待测温点就绪"
        sleep 1
        waited=$((waited + 1))
    done

    log_msg err "硬件准备超时"
    return 1
}

set_pwm() {
    local pwm_path="$1"
    local pwm_value="$2"

    # 确保 PWM 值在有效范围内
    [ "$pwm_value" -lt "$PWM_MIN" ] && pwm_value=$PWM_MIN
    [ "$pwm_value" -gt "$PWM_MAX" ] && pwm_value=$PWM_MAX

    if ! printf '%d' "$pwm_value" > "$pwm_path" 2>/dev/null; then
        return 1
    fi

    return 0
}

enable_manual_control() {
    local pwm_path="$1"
    local pwm_enable_path="${pwm_path}_enable"

    if [ -w "$pwm_enable_path" ]; then
        echo 1 > "$pwm_enable_path" 2>/dev/null
        log_msg debug "启用手动 PWM 控制: $pwm_enable_path"
    fi
}

check_hardware_ready() {
    local sensor_path="$1"
    local pwm_path="$2"
    local waited=0

    while [ "$waited" -lt 30 ]; do
        # 检查传感器
        if [ ! -r "${sensor_path}_input" ]; then
            log_msg debug "等待传感器就绪: ${sensor_path}_input"
            sleep 1
            waited=$((waited + 1))
            continue
        fi

        # 测试温度读取
        local test_temp
        test_temp=$(cat "${sensor_path}_input" 2>/dev/null)
        # shellcheck disable=SC2335  # 同上：用 -eq 报错判定“非数字”
        if [ -z "$test_temp" ] || ! [ "$test_temp" -eq "$test_temp" ] 2>/dev/null || [ "$test_temp" -eq 0 ]; then
            log_msg debug "等待有效温度值: $test_temp"
            sleep 1
            waited=$((waited + 1))
            continue
        fi

        # 检查 PWM 控制器
        if [ ! -w "$pwm_path" ]; then
            log_msg debug "等待 PWM 控制器就绪: $pwm_path"
            sleep 1
            waited=$((waited + 1))
            continue
        fi

        # 所有检查通过
        log_msg notice "硬件就绪 - 温度: $((test_temp / 1000))°C, PWM: $pwm_path"
        return 0
    done

    log_msg err "硬件准备超时"
    return 1
}

reload_runtime_config() {
    local fan_id="$1"
    local fan_config curve_config new_fan_label new_curve_id new_pwm_path new_pwm_min_start new_never_stop
    local new_type new_sensor new_temp_min new_temp_max new_pwm_start new_pwm_end new_sensor_path new_sensor_paths

    fan_config=$(load_fan_config "$fan_id")
    if [ -z "$fan_config" ]; then
        log_msg err "配置重载失败: 无法加载风扇配置 $fan_id"
        return 1
    fi

    local IFS='|'
    read -r new_fan_label new_curve_id new_pwm_path new_pwm_min_start new_never_stop <<EOF
$fan_config
EOF

    curve_config=$(load_curve_config "$new_curve_id")
    if [ -z "$curve_config" ]; then
        log_msg err "配置重载失败: 无法加载曲线配置 $new_curve_id"
        return 1
    fi

    read -r new_type new_sensor new_temp_min new_temp_max new_pwm_start new_pwm_end <<EOF
$curve_config
EOF

    new_sensor_paths=$(load_sensor_paths "$fan_id")
    if [ -z "$new_sensor_paths" ]; then
        log_msg err "配置重载失败: 无法加载测温点配置（fan.sensors）"
        return 1
    fi

    new_sensor_path="${new_sensor_paths%% *}"
    new_sensor_path="${new_sensor_path#*:}"

    if ! check_hardware_ready_multi "$new_sensor_paths" "$new_pwm_path"; then
        log_msg err "配置重载失败: 硬件路径不可用"
        return 1
    fi

    fan_label=$new_fan_label
    curve_id=$new_curve_id
    pwm_path=$new_pwm_path
    pwm_min_start=$new_pwm_min_start
    never_stop=$new_never_stop
    type=$new_type
    sensor=$new_sensor
    temp_min=$new_temp_min
    temp_max=$new_temp_max
    pwm_start=$new_pwm_start
    pwm_end=$new_pwm_end
    sensor_path=$new_sensor_path
    sensor_paths=$new_sensor_paths

    local new_ramp_config
    new_ramp_config=$(load_ramp_config "$fan_id")
    ramp_up_time=${new_ramp_config%%|*}
    ramp_down_time=${new_ramp_config##*|}

    local new_quiet_config
    new_quiet_config=$(resolve_quiet_and_stop "$fan_id")
    quiet_mode=${new_quiet_config%%|*}
    allow_stop=${new_quiet_config##*|}

    enable_manual_control "$pwm_path"
    log_msg notice "配置已应用 - 风扇: $fan_label, 曲线: $curve_id, PWM: $pwm_path, 测温点: $sensor_paths, 升速: ${ramp_up_time}s, 降速: ${ramp_down_time}s, 极致静音: ${quiet_mode}, 自动停转: ${allow_stop}"
    return 0
}

# CURVE ALGORITHMS
# ============================================================

# 校准是否可作为「极致静音」的前置条件（Fan Xpert 4：必须先执行风扇校准）
has_valid_calibration() {
    local fan_id="$1"
    local min_start source

    min_start=$(uci -q get "fanxpert.$fan_id.pwm_min_start" 2>/dev/null) || min_start="0"
    source=$(uci -q get "fanxpert.$fan_id.pwm_min_start_source" 2>/dev/null) || source="unknown"

    case "$min_start" in ''|*[!0-9]*) return 1 ;; esac
    [ "$min_start" -gt 0 ] || return 1

    case "$source" in
        measured|estimated) return 0 ;;
        *) return 1 ;;
    esac
}

# 读取「自动停转」：优先新字段 auto_stop，缺失时由旧的 never_stop 派生
load_auto_stop() {
    local fan_id="$1"
    local value never

    value=$(uci -q get "fanxpert.$fan_id.auto_stop" 2>/dev/null) || value=""

    if [ -z "$value" ]; then
        never=$(uci -q get "fanxpert.$fan_id.never_stop" 2>/dev/null) || never="1"
        [ "$never" = "1" ] && { echo 0; return 0; }
        echo 1
        return 0
    fi

    case "$value" in
        1) echo 1 ;;
        *) echo 0 ;;
    esac
}

# 解析极致静音与自动停转，输出 "quiet|allow_stop"。
# 门槛（与 Fan Xpert 4 一致）：极致静音需要先完成校准；自动停转需要极致静音生效。
resolve_quiet_and_stop() {
    local fan_id="$1"
    local quiet auto_stop allow_stop

    quiet=$(uci -q get "fanxpert.$fan_id.quiet_mode" 2>/dev/null) || quiet="0"
    case "$quiet" in
        1) quiet=1 ;;
        *) quiet=0 ;;
    esac

    if [ "$quiet" = "1" ] && ! has_valid_calibration "$fan_id"; then
        log_msg warn "极致静音需要先完成风扇校准，已按关闭处理"
        quiet=0
    fi

    auto_stop=$(load_auto_stop "$fan_id")
    allow_stop=0

    if [ "$auto_stop" = "1" ]; then
        if [ "$quiet" = "1" ]; then
            allow_stop=1
        else
            log_msg warn "自动停转需要先开启极致静音（且完成校准），已忽略"
        fi
    fi

    echo "$quiet|$allow_stop"
}

# 应用最小启动阈值：
#   - 未启用自动停转：目标低于校准起点时抬到起点（保证风扇能转）
#   - 已启用自动停转：目标低于起点时输出 0，让风扇明确静止
apply_min_start_floor() {
    local target="$1"
    local min_start="$2"
    local allow_stop="$3"

    case "$target" in ''|*[!0-9]*) target=0 ;; esac
    case "$min_start" in ''|*[!0-9]*) min_start=0 ;; esac

    if [ "$min_start" -gt 0 ] && [ "$target" -gt 0 ] && [ "$target" -lt "$min_start" ]; then
        if [ "$allow_stop" = "1" ]; then
            echo 0
            return 0
        fi

        echo "$min_start"
        return 0
    fi

    echo "$target"
}

# 极致静音偏置：整体下调 QUIET_MODE_OFFSET%，quiet 不为 1 时原样返回
apply_quiet_bias() {
    local target_pwm="$1"
    local quiet="$2"

    case "$target_pwm" in ''|*[!0-9]*) target_pwm=0 ;; esac

    [ "$quiet" = "1" ] || { echo "$target_pwm"; return 0; }

    echo $(( target_pwm - target_pwm * QUIET_MODE_OFFSET / 100 ))
}

# 按升速/降速时间限制单个采样周期（1 秒）内的 PWM 变化量。
# 参数: 当前 PWM, 目标 PWM, 升速时间(秒), 降速时间(秒)
# 语义: 时间 = 从最低转速变到最高转速所需的秒数；0 = 不限制。
# 步长按当前 PWM_MAX 换算，因此不限制范围的硬件也能正确缩放。
ramp_limited_pwm() {
    local current="$1"
    local target="$2"
    local up_time="$3"
    local down_time="$4"
    local step span

    case "$up_time" in ''|*[!0-9]*) up_time=0 ;; esac
    case "$down_time" in ''|*[!0-9]*) down_time=0 ;; esac

    span=$(( PWM_MAX - PWM_MIN ))
    [ "$span" -lt 1 ] && span=1

    if [ "$target" -gt "$current" ]; then
        [ "$up_time" -eq 0 ] && { echo "$target"; return 0; }

        # 向上取整：实际用时不会超过设定值
        step=$(( (span + up_time - 1) / up_time ))
        [ "$step" -lt 1 ] && step=1

        [ $((current + step)) -ge "$target" ] && { echo "$target"; return 0; }
        echo $((current + step))
    elif [ "$target" -lt "$current" ]; then
        [ "$down_time" -eq 0 ] && { echo "$target"; return 0; }

        step=$(( (span + down_time - 1) / down_time ))
        [ "$step" -lt 1 ] && step=1

        [ $((current - step)) -le "$target" ] && { echo "$target"; return 0; }
        echo $((current - step))
    else
        echo "$current"
    fi

    return 0
}

# 读取风扇的升速/降速时间，输出 "up|down"
load_ramp_config() {
    local fan_id="$1"
    local up down

    up=$(uci -q get "fanxpert.$fan_id.ramp_up_time" 2>/dev/null) || up=""
    down=$(uci -q get "fanxpert.$fan_id.ramp_down_time" 2>/dev/null) || down=""

    case "$up" in ''|*[!0-9]*) up="$RAMP_UP_DEFAULT" ;; esac
    case "$down" in ''|*[!0-9]*) down="$RAMP_DOWN_DEFAULT" ;; esac

    echo "$up|$down"
}

percent_to_pwm() {
    local percent="$1"
    [ "$percent" -lt 0 ] && percent=0
    [ "$percent" -gt 100 ] && percent=100
    echo "$(( (PWM_MAX - PWM_MIN) * percent / 100 + PWM_MIN ))"
}

pwm_to_percent() {
    local pwm="$1"
    [ "$pwm" -lt "$PWM_MIN" ] && pwm=$PWM_MIN
    [ "$pwm" -gt "$PWM_MAX" ] && pwm=$PWM_MAX
    echo "$(( (pwm - PWM_MIN) * 100 / (PWM_MAX - PWM_MIN) ))"
}

# 阶梯档数钳位到 [STEP_LEVELS_MIN, STEP_LEVELS_MAX]，非法值回落默认
clamp_step_levels() {
    case "$1" in
        ''|*[!0-9]*) echo "$STEP_LEVELS"; return ;;
    esac

    if [ "$1" -lt "$STEP_LEVELS_MIN" ]; then
        echo "$STEP_LEVELS_MIN"
    elif [ "$1" -gt "$STEP_LEVELS_MAX" ]; then
        echo "$STEP_LEVELS_MAX"
    else
        echo "$1"
    fi
}

# 线性插值：两点之间按温度线性过渡（返回 PWM）
calculate_linear_curve() {
    local temp="$1"
    local temp_min="$2"
    local temp_max="$3"
    local pwm_start="$4"
    local pwm_end="$5"

    if [ "$temp" -le "$temp_min" ]; then
        percent_to_pwm "$pwm_start"
        return
    fi

    if [ "$temp" -ge "$temp_max" ]; then
        percent_to_pwm "$pwm_end"
        return
    fi

    local percent
    percent=$(( pwm_start + (pwm_end - pwm_start) * (temp - temp_min) / (temp_max - temp_min) ))
    percent_to_pwm "$percent"
}

# 阶梯曲线：温度区间等分为 STEP_LEVELS 档，逐档抬升（返回 PWM）
# 相比线性/贝塞尔，转速只在档位边界变化，避免在某个温度附近持续微调
calculate_step_curve() {
    local temp="$1"
    local temp_min="$2"
    local temp_max="$3"
    local pwm_start="$4"
    local pwm_end="$5"
    local levels="${6:-$STEP_LEVELS}"

    if [ "$temp" -le "$temp_min" ]; then
        percent_to_pwm "$pwm_start"
        return
    fi

    if [ "$temp" -ge "$temp_max" ]; then
        percent_to_pwm "$pwm_end"
        return
    fi

    levels=$(clamp_step_levels "$levels")

    local band percent
    band=$(( (temp - temp_min) * levels / (temp_max - temp_min) + 1 ))
    percent=$(( pwm_start + (pwm_end - pwm_start) * band / levels ))
    percent_to_pwm "$percent"
}

calculate_bezier_curve() {
    local temp="$1"
    local temp_min="$2"
    local temp_max="$3"
    local pwm_start="$4"
    local pwm_end="$5"
    local t

    # 如果温度低于最低阈值，使用最低转速
    if [ "$temp" -le "$temp_min" ]; then
        percent_to_pwm "$pwm_start"
        return
    fi

    # 如果温度高于最高阈值，使用最高转速
    if [ "$temp" -ge "$temp_max" ]; then
        percent_to_pwm "$pwm_end"
        return
    fi

    # 起止转速相同（例如全速档 100/100）时直接输出固定转速，
    # 否则贝塞尔控制点会在中段产生 97~100% 的塌陷。
    if [ "$pwm_start" -eq "$pwm_end" ]; then
        percent_to_pwm "$pwm_start"
        return
    fi

    # 计算温度在范围内的位置（0-1000）
    t=$(( (temp - temp_min) * 1000 / (temp_max - temp_min) ))

    # 使用三次贝塞尔曲线公式计算
    local t2 t3 mt mt2 mt3
    t2=$(( t * t / 1000 ))
    t3=$(( t2 * t / 1000 ))
    mt=$(( 1000 - t ))
    mt2=$(( mt * mt / 1000 ))
    mt3=$(( mt2 * mt / 1000 ))

    # 计算曲线上的点
    local p1 p2 p3 p4
    p1=$(( pwm_start * mt3 ))
    p2=$(( (pwm_start + 10) * 3 * mt2 * t / 1000 ))
    p3=$(( (pwm_end - 10) * 3 * mt * t2 / 1000 ))
    p4=$(( pwm_end * t3 ))

    # 计算最终百分比并转换为 PWM 值
    local percent
    percent=$(( (p1 + p2 + p3 + p4) / 1000 ))
    percent_to_pwm "$percent"
}

generate_curve_points() {
    local curve_config="$1"
    local IFS='|'
    local type sensor temp_min temp_max pwm_start pwm_end step_levels

    read -r type sensor temp_min temp_max pwm_start pwm_end step_levels <<EOF
$curve_config
EOF

    # 固定转速模式：输出一条水平线
    if [ "$type" = "fixed" ]; then
        local fixed_percent fixed_points
        fixed_percent=$(pwm_to_percent "$(percent_to_pwm "$pwm_start")")
        fixed_points="[[$temp_min,$fixed_percent],[$temp_max,$fixed_percent]]"

        echo "$fixed_points"
        return 0
    fi

    # 生成 20 个点用于绘图
    local step
    step=$(( (temp_max - temp_min) / 20 ))
    [ "$step" -lt 1 ] && step=1

    local points="["
    local first=1
    local temp="$temp_min"

    while [ "$temp" -le "$temp_max" ]; do
        local pwm
        local percent
        case "$type" in
            linear)
                pwm=$(calculate_linear_curve "$temp" "$temp_min" "$temp_max" "$pwm_start" "$pwm_end")
                ;;
            step)
                pwm=$(calculate_step_curve "$temp" "$temp_min" "$temp_max" "$pwm_start" "$pwm_end" "$step_levels")
                ;;
            *)
                pwm=$(calculate_bezier_curve "$temp" "$temp_min" "$temp_max" "$pwm_start" "$pwm_end")
                ;;
        esac
        percent=$(pwm_to_percent "$pwm")

        [ "$first" -eq 0 ] && points="${points},"
        points="${points}[$temp,$percent]"
        first=0

        temp=$((temp + step))
    done

    points="$points]"
    echo "$points"
}

# ERROR HANDLING
# ============================================================

check_error_threshold() {
    local current_time
    current_time=$(date +%s)

    # 重置错误计数器（如果已过 60 秒）
    if [ "$ERROR_WINDOW_START" -eq 0 ] || [ $((current_time - ERROR_WINDOW_START)) -ge 60 ]; then
        ERROR_WINDOW_START=$current_time
        ERROR_COUNT=0
    fi

    ERROR_COUNT=$((ERROR_COUNT + 1))

    # 如果 60 秒内失败 10 次，返回错误
    if [ "$ERROR_COUNT" -ge 10 ]; then
        log_msg err "60 秒内发生 $ERROR_COUNT 次错误，超过阈值"
        return 1
    fi

    return 0
}

# ============================================================
# STATE FILE MANAGEMENT
# ============================================================

write_state_file() {
    local fan_id="$1"
    local fan_label="$2"
    local temp="$3"
    local pwm="$4"
    local curve_id="$5"
    local sensor_path="$6"
    local pwm_path="$7"
    local sensors_json="${8:-[]}"
    local current_time

    local percent current_time uptime fan_label_json curve_id_json sensor_path_json
    local error_json payload rpm rpm_json
    case "$temp" in
        ''|*[!0-9]*) temp=0 ;;
    esac
    case "$pwm" in
        ''|*[!0-9]*) pwm=0 ;;
    esac
    case "$percent" in
        ''|*[!0-9]*) percent=0 ;;
    esac

    if [ -n "$LAST_RELOAD_ERROR" ]; then
        error_json="\"$(json_escape "$LAST_RELOAD_ERROR")\""
    else
        error_json="null"
    fi

    percent=$(pwm_to_percent "$pwm")
    current_time=$(date +%s)
    uptime=$((current_time - DAEMON_START_TIME))
    fan_label_json=$(json_escape "$fan_label")
    curve_id_json=$(json_escape "$curve_id")
    sensor_path_json=$(json_escape "$sensor_path")

    # 读取转速（无转速传感器时输出空，JSON 里写 null）
    rpm=""
    [ -n "$pwm_path" ] && rpm=$(read_fan_rpm "$pwm_path" 2>/dev/null || echo "")
    case "$rpm" in
        ''|*[!0-9]*) rpm="" ;;
    esac
    if [ -n "$rpm" ] && [ "$rpm" -gt 0 ]; then
        rpm_json="$rpm"
        record_rpm_sample "$fan_id" "$percent" "$rpm"
    else
        rpm_json="null"
    fi

    # 计算统计信息
    if [ ! -f "$STATE_FILE" ] || [ -z "${MAX_TEMP:-}" ]; then
        MAX_TEMP=$temp
        MAX_TEMP_TIME=$current_time
    elif [ "$temp" -gt "$MAX_TEMP" ]; then
        MAX_TEMP=$temp
        MAX_TEMP_TIME=$current_time
    fi

    # 生成 JSON 状态文件，并限制写入频率以降低闪存磨损
    payload=$(cat <<EOF
{
  "devices": {
    "$(json_escape "$fan_id")": {
      "label": "$fan_label_json",
      "temp": $temp,
      "pwm": $pwm,
      "percent": $percent,
      "rpm": $rpm_json,
      "curve": "$curve_id_json",
      "sensor_path": "$sensor_path_json",
      "sensors": $sensors_json
    }
  },
  "daemon": {
    "pid": $$,
    "uptime": $uptime,
    "last_update": $current_time,
    "config_reloads": $CONFIG_RELOAD_COUNT,
    "last_reload": {
      "attempt_time": $LAST_RELOAD_TIME,
      "status": "$LAST_RELOAD_STATUS",
      "error": $error_json
    }
  },
  "stats": {
    "max_temp": ${MAX_TEMP:-0},
    "max_temp_time": ${MAX_TEMP_TIME:-0}
  }
}
EOF
)

    if [ "$payload" != "$LAST_STATE_CONTENT" ] || [ $((current_time - LAST_STATE_WRITE_TIME)) -ge 3 ]; then
        printf '%s\n' "$payload" > "$STATE_FILE"
        LAST_STATE_CONTENT="$payload"
        LAST_STATE_WRITE_TIME=$current_time
    fi
}

# ============================================================
# DAEMON
# ============================================================

daemon_cleanup() {
    rm -f "$PID_FILE"
    log_msg notice "FanXpert 已停止"
}

daemon_main_loop() {
    log_msg notice "FanXpert 守护进程启动"

    # 确保 UCI 配置存在且结构完整
    ensure_uci_config

    # 确保 PID 文件目录存在
    mkdir -p /tmp/run

    # 记录启动时间
    DAEMON_START_TIME=$(date +%s)

    # 加载全局配置
    load_uci_config

    # 检查是否启用
    local enabled
    enabled=$(uci -q get fanxpert.settings.enabled)
    if [ "$enabled" != "1" ]; then
        log_msg err "FanXpert 未启用，请在配置中启用"
        exit 1
    fi

    # 写入 PID 文件。procd 负责进程生命周期，PID 文件供 CLI/RPC 状态查询使用。
    echo $$ > "$PID_FILE"
    trap 'daemon_cleanup' EXIT
    trap 'trap - EXIT; daemon_cleanup; exit 0' INT TERM

    # 清除旧的校准进度文件
    rm -f "$CALIBRATE_PROGRESS_FILE"

    # 等待系统完全启动
    sleep 5

    # 加载第一个启用的风扇配置
    local fan_id="cpu_fan"
    local fan_config
    fan_config=$(load_fan_config "$fan_id")
    if [ -z "$fan_config" ]; then
        log_msg err "无法加载风扇配置: $fan_id"
        exit 1
    fi

    # 注意：以下运行期参数必须是全局变量。reload_runtime_config() 在热重载时
    # 直接给同名变量赋值，若在此声明 local 会遮蔽全局变量，热重载将静默失效。
    local IFS='|'
    read -r fan_label curve_id pwm_path pwm_min_start never_stop <<EOF
$fan_config
EOF

    log_msg notice "风扇: $fan_label, 曲线: $curve_id, PWM: $pwm_path"

    # 加载曲线配置
    local curve_config
    curve_config=$(load_curve_config "$curve_id")
    if [ -z "$curve_config" ]; then
        log_msg err "无法加载曲线配置: $curve_id"
        exit 1
    fi

    read -r type sensor temp_min temp_max pwm_start pwm_end step_levels <<EOF
$curve_config
EOF

    # 加载测温点列表（最多 3 个，同为运行期全局变量，热重载会更新它）
    sensor_paths=$(load_sensor_paths "$fan_id")
    if [ -z "$sensor_paths" ]; then
        log_msg err "无法加载测温点配置: $fan_id.sensors"
        exit 1
    fi

    sensor_path="${sensor_paths%% *}"
    sensor_path="${sensor_path#*:}"

    log_msg notice "测温点: $sensor_paths（取最高温）, 曲线类型: $type"

    # 升速/降速时间（秒，0 = 不限制）
    local ramp_config
    ramp_config=$(load_ramp_config "$fan_id")
    ramp_up_time=${ramp_config%%|*}
    ramp_down_time=${ramp_config##*|}
    log_msg notice "升速/降速时间: ${ramp_up_time}s / ${ramp_down_time}s"

    # 极致静音 / 自动停转（以校准为前置条件）
    local quiet_config
    quiet_config=$(resolve_quiet_and_stop "$fan_id")
    quiet_mode=${quiet_config%%|*}
    allow_stop=${quiet_config##*|}
    log_msg notice "极致静音: ${quiet_mode}, 自动停转: ${allow_stop}"

    # 检查硬件就绪
    if ! check_hardware_ready_multi "$sensor_paths" "$pwm_path"; then
        log_msg err "硬件未就绪"
        exit 1
    fi

    # 启用手动控制
    enable_manual_control "$pwm_path"

    # 动态探测 PWM 最大值
    detect_pwm_max "$pwm_path" || true

    # 初始化 PWM 值
    local current_pwm
    current_pwm=$(percent_to_pwm "$pwm_start")
    local target_pwm="$current_pwm"
    local last_log_time=0
    local debug_log_interval=300

    if ! set_pwm "$pwm_path" "$current_pwm"; then
        log_msg err "无法设置初始 PWM 值"
        exit 1
    fi

    log_msg notice "初始化完成 - PWM: $current_pwm ($(pwm_to_percent "$current_pwm")%)"

    # 主控制循环
    while true; do
        local current_time
        current_time=$(date +%s)

        # 检查是否需要重载配置
        if [ -f "$RELOAD_FLAG" ]; then
            rm -f "$RELOAD_FLAG"
            # 重置状态，准备记录本次重载结果
            reset_reload_status
            reload_config_from_uci
            if ! reload_runtime_config "$fan_id"; then
                log_msg warn "保留当前运行配置 (重载失败)"
            fi
        fi

        # 读取温度
        # 多测温点：读取所有来源并取最高温
        local temp_c
        if ! read_multi_temperature "$sensor_paths"; then
            log_msg err "无法读取任何测温点"
            if ! check_error_threshold; then
                log_msg err "错误次数超过阈值，退出"
                exit 1
            fi
            sleep 5
            continue
        fi

        temp_c="$TEMP_VALUE"
        sensor_path="$TEMP_SOURCE_PATH"

        # 重置错误计数
        ERROR_COUNT=0

        # 计算目标 PWM：固定转速模式直接输出设定值，其余曲线按温度插值
        case "$type" in
            fixed)
                target_pwm=$(percent_to_pwm "$pwm_start")
                ;;
            linear)
                target_pwm=$(calculate_linear_curve "$temp_c" "$temp_min" "$temp_max" "$pwm_start" "$pwm_end")
                ;;
            step)
                target_pwm=$(calculate_step_curve "$temp_c" "$temp_min" "$temp_max" "$pwm_start" "$pwm_end" "$step_levels")
                ;;
            *)
                target_pwm=$(calculate_bezier_curve "$temp_c" "$temp_min" "$temp_max" "$pwm_start" "$pwm_end")
                ;;
        esac

        # pwm_min_start 在 UCI/UI 中以百分比保存，写入硬件前转换为原始 PWM。
        local min_start_pwm=0
        if [ "$pwm_min_start" -gt 0 ]; then
            min_start_pwm=$(percent_to_pwm "$pwm_min_start")
        fi

        # 极致静音：整体下调转速，但不低于校准得到的最低可用转速
        target_pwm=$(apply_quiet_bias "$target_pwm" "$quiet_mode")

        # 应用最小启动阈值（自动停转生效时允许降到 0）
        target_pwm=$(apply_min_start_floor "$target_pwm" "$min_start_pwm" "$allow_stop")

        # 平滑过渡：按升速/降速时间限制每秒的变化量（0 = 不限制）
        current_pwm=$(ramp_limited_pwm "$current_pwm" "$target_pwm" "$ramp_up_time" "$ramp_down_time")

        # 确保 PWM 值在有效范围内
        [ "$current_pwm" -lt "$PWM_MIN" ] && current_pwm=$PWM_MIN
        [ "$current_pwm" -gt "$PWM_MAX" ] && current_pwm=$PWM_MAX

        # 实时状态写入 state 文件；syslog 仅在 debug 模式下低频输出状态快照。
        if [ "$LOG_LEVEL" = "debug" ] && [ $((current_time - last_log_time)) -ge "$debug_log_interval" ]; then
            local current_percent target_percent
            current_percent=$(pwm_to_percent "$current_pwm")
            target_percent=$(pwm_to_percent "$target_pwm")
            log_msg debug "状态报告 - 温度: ${temp_c}°C, PWM: ${current_pwm} (${current_percent}%), 目标: ${target_pwm} (${target_percent}%)"
            last_log_time=$current_time
        fi

        # 写入状态文件
        write_state_file "$fan_id" "$fan_label" "$temp_c" "$current_pwm" "$curve_id" "$sensor_path" "$pwm_path" "[$TEMP_SENSOR_JSON]"

        # 写入 PWM 值
        if ! set_pwm "$pwm_path" "$current_pwm"; then
            log_msg err "无法设置 PWM 值: $current_pwm"
            if ! check_error_threshold; then
                log_msg err "错误次数超过阈值，退出"
                exit 1
            fi
            sleep 5
            continue
        fi

        sleep 1
    done
}

# COMMAND HANDLERS
# ============================================================

cmd_start() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "FanXpert 已在运行 (PID: $pid)"
            return 1
        fi
    fi

    daemon_main_loop
}

cmd_run() {
    rm -f "$PID_FILE"
    daemon_main_loop
}

cmd_stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "FanXpert 未运行"
        return 1
    fi

    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid"
        rm -f "$PID_FILE"
        log_msg notice "FanXpert 已停止"
        echo "FanXpert 已停止"
    else
        rm -f "$PID_FILE"
        echo "FanXpert 未运行（清理残留 PID 文件）"
    fi
}

cmd_restart() {
    cmd_stop
    sleep 2
    cmd_start
}

cmd_reload() {
    if [ ! -f "$PID_FILE" ]; then
        echo "FanXpert 未运行"
        return 1
    fi

    touch "$RELOAD_FLAG"
    log_msg notice "Configuration reload requested"
    echo "FanXpert configuration reload requested"
}

cmd_status() {
    local fan_id="${1:-}"

    if [ -n "$fan_id" ] && ! is_valid_id "$fan_id"; then
        echo '{"error":"Invalid fan id"}'
        return 1
    fi

    if [ ! -f "$PID_FILE" ]; then
        echo "Status: stopped"
        return 1
    fi

    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
        echo "Status: running"
        echo "PID: $pid"
        if [ -f "$STATE_FILE" ]; then
            local uptime
            # 状态文件是 "uptime": 123 这种带空格的格式，必须容忍空格，
            # 否则这里取不到值会让整个函数返回非 0，前端就会把运行中的服务判成已停止。
            uptime=$(sed -n 's/.*"uptime"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$STATE_FILE" | head -1)
            [ -n "$uptime" ] && echo "Uptime: ${uptime}s"
        fi

        return 0
    else
        echo "Status: stopped (stale PID file)"
        rm -f "$PID_FILE"
        return 1
    fi
}

# 读取系统日志里的 FANXPERT 行（优先 logread，其次 /var/log/messages）
read_fanxpert_log() {
    local lines="$1"
    local out=""

    if command -v logread >/dev/null 2>&1; then
        out=$(logread 2>/dev/null | grep -F "FANXPERT:" | tail -n "$lines")
    fi

    if [ -z "$out" ] && [ -f /var/log/messages ]; then
        out=$(grep -F "FANXPERT:" /var/log/messages 2>/dev/null | tail -n "$lines")
    fi

    printf '%s' "$out"
}

# 多行日志 → JSON 字符串数组
log_lines_json() {
    local raw="$1"
    local json="" line

    while IFS= read -r line; do
        [ -n "$line" ] || continue
        json="$json${json:+,}\"$(json_escape "$line")\""
    done <<EOF
$raw
EOF

    printf '%s' "$json"
}

# 输出最近日志（JSON），供 LuCI 日志页面使用
cmd_logs() {
    local lines="${1:-100}"
    local raw count

    case "$lines" in
        ''|*[!0-9]*) lines=100 ;;
    esac
    [ "$lines" -gt 0 ] || lines=100
    [ "$lines" -gt 1000 ] && lines=1000

    raw=$(read_fanxpert_log "$lines")

    if [ -z "$raw" ]; then
        printf '{"ok":true,"lines":[],"count":0,"log_level":"%s"}\n' "$(json_escape "${LOG_LEVEL:-info}")"
        return 0
    fi

    count=$(printf '%s\n' "$raw" | grep -c .)

    printf '{"ok":true,"lines":[%s],"count":%s,"log_level":"%s"}\n' \
        "$(log_lines_json "$raw")" "$count" "$(json_escape "${LOG_LEVEL:-info}")"

    return 0
}

cmd_info() {
    local fan_id="${1:-}"

    if [ -n "$fan_id" ] && ! is_valid_id "$fan_id"; then
        echo '{"error":"Invalid fan id"}'
        return 1
    fi

    if [ ! -f "$STATE_FILE" ]; then
        echo '{"error":"State file not found"}'
        return 1
    fi

    cat "$STATE_FILE"
}

cmd_curve_data() {
    local fan_id="${1:-cpu_fan}"

    if ! is_valid_id "$fan_id"; then
        echo '{"error":"Invalid fan id"}'
        return 1
    fi

    # 加载风扇配置
    local fan_config
    fan_config=$(load_fan_config "$fan_id")
    if [ -z "$fan_config" ]; then
        echo '{"error":"Fan not found"}'
        return 1
    fi

    local IFS='|'
    local fan_label curve_id pwm_path pwm_min_start never_stop
    read -r fan_label curve_id pwm_path pwm_min_start never_stop <<EOF
$fan_config
EOF

    # 加载曲线配置
    local curve_config
    curve_config=$(load_curve_config "$curve_id")
    if [ -z "$curve_config" ]; then
        echo '{"error":"Curve not found"}'
        return 1
    fi

    local type sensor temp_min temp_max pwm_start pwm_end step_levels
    read -r type sensor temp_min temp_max pwm_start pwm_end step_levels <<EOF
$curve_config
EOF

    # 生成曲线点
    local points
    points=$(generate_curve_points "$curve_config")

    # 读取当前状态
    local current_temp=0
    local current_percent=0
    if [ -f "$STATE_FILE" ]; then
        current_temp=$(sed -n 's/.*"temp"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$STATE_FILE" | head -1)
        current_percent=$(sed -n 's/.*"percent"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$STATE_FILE" | head -1)
    fi

    local range_temp_min="$temp_min"
    local range_temp_max="$temp_max"
    if [ -n "$current_temp" ] && [ "$current_temp" -gt 0 ]; then
        [ "$current_temp" -lt "$range_temp_min" ] && range_temp_min="$current_temp"
        [ "$current_temp" -gt "$range_temp_max" ] && range_temp_max="$current_temp"
    fi

    # 输出 JSON
    # shellcheck disable=SC2086
    cat <<EOF
{
  "curve_points": $points,
  "current": {
    "temp": ${current_temp:-0},
    "pwm_percent": ${current_percent:-0}
  },
  "range": {
    "temp_min": $range_temp_min,
    "temp_max": $range_temp_max,
    "pwm_min": 0,
    "pwm_max": 100
  },
  "pwm_max": ${PWM_MAX:-255},
  "rpm_table": $(rpm_table_json "$fan_id")
}
EOF
}

# 四档预设模式：一键套用到所有风扇（对应 Fan Xpert 4 的预设模式）
# 参数: mode = silent | standard | performance | full_speed
cmd_preset() {
    local mode="$1"
    local fan_sections fan_id applied="" applied_json

    case "$mode" in
        silent|standard|performance|full_speed|fixed) ;;
        *)
            printf '{"error":"Invalid preset mode"}\n'
            return 1
            ;;
    esac

    # 预设曲线可能因旧版本升级而缺失，先补齐再套用
    ensure_uci_config

    fan_sections=$(uci -q show fanxpert 2>/dev/null | sed -n 's/^fanxpert\.\([^.=]*\)=fan$/\1/p')

    if [ -z "$fan_sections" ]; then
        printf '{"error":"No fan section found"}\n'
        return 1
    fi

    for fan_id in $fan_sections; do
        uci set "fanxpert.${fan_id}.curve=${mode}"
        applied="${applied}${applied:+,}\"$(json_escape "$fan_id")\""
    done

    uci commit fanxpert
    applied_json="[$applied]"

    log_msg notice "预设模式已切换为 ${mode}（风扇: $(echo "$fan_sections" | tr '\n' ' ')）"

    # 运行中则通知守护进程立即应用，不必重启服务
    if [ -f "$PID_FILE" ]; then
        touch "$RELOAD_FLAG"
        log_msg notice "Configuration reload requested"
    fi

    printf '{"ok":true,"mode":"%s","fans":%s}\n' "$(json_escape "$mode")" "$applied_json"

    return 0
}

cmd_reset_curve() {
    local curve_id="$1"

    if [ -z "$curve_id" ]; then
        echo "用法: fanxpert reset-curve <curve_id>"
        return 1
    fi

    reset_curve_to_default "$curve_id"
    echo "曲线 $curve_id 已恢复为默认值"

    # 如果 daemon 正在运行，触发重载
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            cmd_reload
        fi
    fi
}

# ============================================================
# FAN CALIBRATION
# ============================================================

CALIBRATE_PROGRESS_FILE="/tmp/fanxpert.calibrate.progress"

restore_calibration_pwm() {
    local pwm_path="$1"
    local saved_pwm_file="/tmp/fanxpert.calibrate.saved_pwm"
    local saved_pwm=0

    if [ -f "$saved_pwm_file" ]; then
        saved_pwm=$(cat "$saved_pwm_file" 2>/dev/null || echo 0)
    fi

    echo "${saved_pwm:-0}" > "$pwm_path" 2>/dev/null || true
}

cmd_calibrate() {
    local fan_id="${1:-cpu_fan}"

    if ! is_valid_id "$fan_id"; then
        echo '{"error":"Invalid fan id"}'
        return 1
    fi

    # 检查服务状态
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo '{"error":"Service is running. Please stop it first."}'
            return 1
        fi
    fi

    # 加载风扇配置
    local fan_config
    fan_config=$(load_fan_config "$fan_id")
    if [ -z "$fan_config" ]; then
        echo '{"error":"Fan not found"}'
        return 1
    fi

    local IFS='|'
    local fan_label curve_id pwm_path pwm_min_start never_stop
    read -r fan_label curve_id pwm_path pwm_min_start never_stop <<EOF
$fan_config
EOF

    # 如果是 auto，检测 PWM 路径
    if [ "$pwm_path" = "auto" ]; then
        pwm_path=$(find_pwm_controller)
        if [ -z "$pwm_path" ]; then
            echo '{"error":"PWM controller not found"}'
            return 1
        fi
    fi

    log_msg notice "Starting calibration for fan $fan_id ($fan_label)"

    local saved_pwm=0
    if [ -r "$pwm_path" ]; then
        saved_pwm=$(cat "$pwm_path" 2>/dev/null || echo 0)
    fi
    echo "$saved_pwm" > "/tmp/fanxpert.calibrate.saved_pwm"

    # 初始化进度文件
    local safe_fan_id
    safe_fan_id=$(json_escape "$fan_id")

    cat > "$CALIBRATE_PROGRESS_FILE" <<EOF
{
  "status": "running",
  "progress": 0,
  "stage": "init",
  "message": "正在初始化...",
  "fan_id": "$safe_fan_id",
  "result": null
}
EOF

    # 异步执行校准。必须断开标准输入输出，否则 rpcd 的 popen 会等后台进程关闭管道。
    (calibrate_fan_async "$fan_id" "$pwm_path" >/dev/null 2>&1 </dev/null) &

    echo '{"status":"started","message":"Calibration started in background"}'
}

update_calibrate_progress() {
    local progress="$1"
    local stage="$2"
    local message="$3"
    local feedback_available="${4:-false}"
    local fallback="${5:-false}"
    local result="${6:-null}"
    local status="running"

    case "$stage" in
        completed)
            status="completed"
            ;;
        failed)
            status="failed"
            ;;
        *)
            # 其余阶段（started/coarse/fine 等）继续表示“进行中”
            status="running"
            ;;
    esac

    local safe_message
    safe_message=$(json_escape "$message")

    cat > "$CALIBRATE_PROGRESS_FILE" <<EOF
{
  "status": "$status",
  "progress": $progress,
  "stage": "$stage",
  "message": "$safe_message",
  "feedback_available": $feedback_available,
  "fallback": $fallback,
  "result": $result
}
EOF
}

calibrate_fan_async() {
    local fan_id="$1"
    local pwm_path="$2"
    local fan_input_path="${pwm_path%pwm*}fan${pwm_path##*pwm}_input"
    local has_feedback=0
    local feedback_available=false
    local final_pwm=0
    local final_percent=0
    local result_json="null"

    # 1. 检测转速传感器是否存在
    if [ -r "$fan_input_path" ]; then
        has_feedback=1
        feedback_available=true
        log_msg debug "校准: 检测到转速传感器 $fan_input_path"
    else
        log_msg warn "校准: 未检测到转速传感器，将使用估算模式"
    fi

    # 启用手动控制
    echo 1 > "${pwm_path}_enable" 2>/dev/null || true
    echo 0 > "$pwm_path"
    sleep 2

    local max_pwm="$PWM_MAX"
    [ -n "$max_pwm" ] || max_pwm=255

    # ============================================================
    # 分支 A：有转速反馈 → 真反馈检测
    # ============================================================
    if [ "$has_feedback" -eq 1 ]; then
        log_msg notice "校准: 开始真反馈检测 (步进 5% PWM)"
        update_calibrate_progress 5 "coarse" "粗测阶段: 步进 5%..." true false "null"

        local step=$((max_pwm * 5 / 100))
        [ "$step" -lt 1 ] && step=1
        local test_pwm=0
        local found_start=0
        local final_rpm=0

        while [ "$test_pwm" -le "$max_pwm" ]; do
            echo "$test_pwm" > "$pwm_path"

            # 等待风扇稳定：最多 5 秒，每秒重试读取 RPM
            local waited=0
            local rpm=0
            while [ "$waited" -lt 5 ]; do
                sleep 1
                waited=$((waited + 1))
                rpm=$(read_fan_rpm "$pwm_path" 2>/dev/null || echo "")
                if [ -n "$rpm" ] && [ "$rpm" -gt 0 ]; then
                    break
                fi
            done

            local progress=$((10 + test_pwm * 30 / max_pwm))
            [ "$progress" -gt 40 ] && progress=40
            update_calibrate_progress "$progress" "coarse" "粗测: PWM=$test_pwm, RPM=${rpm:-0}" true false "null"

            if [ -n "$rpm" ] && [ "$rpm" -gt 0 ]; then
                found_start=$test_pwm
                final_rpm=$rpm
                log_msg notice "校准: 粗测找到启动点 PWM=$test_pwm, RPM=$rpm"
                break
            fi

            test_pwm=$((test_pwm + step))
        done

        if [ "$found_start" -eq 0 ]; then
            update_calibrate_progress 100 "failed" "未检测到风扇转动（转速传感器无响应）" true false "null"
            restore_calibration_pwm "$pwm_path"
            log_msg err "Calibration failed: fan did not spin"
            return 1
        fi

        # 细测阶段：在粗测点前后 ±2 步范围，步进 1%
        update_calibrate_progress 45 "fine" "细测阶段: 精确定位..." true false "null"
        local range_start=$((found_start - step * 2))
        [ "$range_start" -lt 0 ] && range_start=0
        local range_end=$((found_start + step * 2))
        [ "$range_end" -gt "$max_pwm" ] && range_end=$max_pwm

        local fine_step=$((max_pwm / 100))
        [ "$fine_step" -lt 1 ] && fine_step=1
        local final_start=0

        test_pwm=$range_start
        echo 0 > "$pwm_path"
        sleep 2

        while [ "$test_pwm" -le "$range_end" ]; do
            echo "$test_pwm" > "$pwm_path"

            local waited=0
            local rpm=0
            while [ "$waited" -lt 5 ]; do
                sleep 1
                waited=$((waited + 1))
                rpm=$(read_fan_rpm "$pwm_path" 2>/dev/null || echo "")
                if [ -n "$rpm" ] && [ "$rpm" -gt 0 ]; then
                    break
                fi
            done

            local progress=$((45 + (test_pwm - range_start) * 40 / (range_end - range_start)))
            [ "$progress" -gt 85 ] && progress=85
            update_calibrate_progress "$progress" "fine" "细测: PWM=$test_pwm, RPM=${rpm:-0}" true false "null"

            if [ -n "$rpm" ] && [ "$rpm" -gt 0 ] && [ "$final_start" -eq 0 ]; then
                final_start=$test_pwm
                final_rpm=$rpm
                log_msg notice "校准: 细测最终启动点 PWM=$test_pwm, RPM=$rpm"
                break
            fi

            test_pwm=$((test_pwm + fine_step))
        done

        [ "$final_start" -eq 0 ] && final_start=$found_start
        final_pwm=$final_start
        final_percent=$((final_pwm * 100 / max_pwm))
        result_json="{\"pwm_value\":$final_pwm,\"percent\":$final_percent,\"rpm\":$final_rpm}"

        update_calibrate_progress 90 "saving" "保存结果..." true false "$result_json"
        sleep 1

        uci set "fanxpert.${fan_id}.pwm_min_start=$final_percent"
        uci set "fanxpert.${fan_id}.pwm_min_start_source=measured"
        uci set "fanxpert.${fan_id}.pwm_min_start_timestamp=$(date +%s)"
        uci commit fanxpert

        log_msg notice "风扇 $fan_id 校准完成: 启动阈值 = ${final_percent}% (PWM=$final_pwm, RPM=$final_rpm) [实测]"
        update_calibrate_progress 100 "completed" "校准完成！" true false "$result_json"

        restore_calibration_pwm "$pwm_path"
        return 0
    fi

    # ============================================================
    # 分支 B：无转速反馈 → 估算回退
    # ============================================================
    log_msg warn "校准: 无转速反馈，使用估算模式 (硬编码阈值)"
    update_calibrate_progress 5 "coarse" "估算模式: 无转速传感器" false true "null"
    sleep 1

    local step=$((max_pwm / 10))
    local test_pwm=0
    local found_start=0

    # 先设置为 0 确保风扇停止
    echo 0 > "$pwm_path"
    sleep 3

    while [ "$test_pwm" -le "$max_pwm" ]; do
        echo "$test_pwm" > "$pwm_path"
        sleep 2

        # 硬编码阈值 25% PWM
        if [ "$test_pwm" -ge 25 ]; then
            found_start=$test_pwm
            break
        fi

        test_pwm=$((test_pwm + step))
        local progress=$((10 + test_pwm * 30 / max_pwm))
        update_calibrate_progress "$progress" "coarse" "估算: PWM=$test_pwm" false true "null"
    done

    if [ "$found_start" -eq 0 ]; then
        update_calibrate_progress 100 "failed" "估算失败: 未找到启动点" false true "null"
        restore_calibration_pwm "$pwm_path"
        return 1
    fi

    update_calibrate_progress 45 "fine" "细测阶段: 精确定位..." false true "null"
    sleep 1

    local range_start
    range_start=$((found_start - step))
    [ "$range_start" -lt 0 ] && range_start=0
    local range_end
    range_end=$((found_start + step))
    [ "$range_end" -gt "$max_pwm" ] && range_end=$max_pwm

    local fine_step
    fine_step=$((max_pwm / 100))
    [ "$fine_step" -lt 1 ] && fine_step=1
    local final_start=0

    test_pwm=$range_start
    echo 0 > "$pwm_path"
    sleep 2

    while [ "$test_pwm" -le "$range_end" ]; do
        echo "$test_pwm" > "$pwm_path"
        sleep 2

        if [ "$test_pwm" -ge 20 ] && [ "$final_start" -eq 0 ]; then
            final_start=$test_pwm
            break
        fi

        test_pwm=$((test_pwm + fine_step))
        local progress=$((45 + (test_pwm - range_start) * 40 / (range_end - range_start)))
        update_calibrate_progress "$progress" "fine" "细测: PWM=$test_pwm" false true "null"
    done

    [ "$final_start" -eq 0 ] && final_start=$found_start

    final_pwm=$final_start
    final_percent=$((final_pwm * 100 / max_pwm))
    result_json="{\"pwm_value\":$final_pwm,\"percent\":$final_percent,\"estimated\":true}"

    update_calibrate_progress 90 "saving" "保存估算结果..." false true "$result_json"

    uci set "fanxpert.${fan_id}.pwm_min_start=$final_percent"
    uci set "fanxpert.${fan_id}.pwm_min_start_source=estimated"
    uci set "fanxpert.${fan_id}.pwm_min_start_timestamp=$(date +%s)"
    uci commit fanxpert

    log_msg notice "Fan $fan_id calibration completed: start threshold = ${final_percent}% (PWM=$final_pwm) [estimated]"
    update_calibrate_progress 100 "completed" "校准完成（估算）" false true "$result_json"
    restore_calibration_pwm "$pwm_path"
    return 0
}

cmd_calibrate_progress() {
    if [ ! -f "$CALIBRATE_PROGRESS_FILE" ]; then
        echo '{"error":"No calibration in progress"}'
        return 1
    fi

    cat "$CALIBRATE_PROGRESS_FILE"
}

show_usage() {
    cat <<EOF
FanXpert - 高级风扇控制

用法: fanxpert <command> [参数]

命令:
  run                  前台运行守护进程（由 procd 使用）
  start                启动后台监控进程
  stop                 停止监控进程
  restart              重启监控进程
  reload               重新加载配置（不重启进程）
  status               显示运行状态
  info [fan]           显示实时数据（JSON 格式，可指定风扇）
  logs [lines]         显示最近日志（JSON 格式，默认 100 行）
  curve-data [fan]     显示曲线数据（JSON 格式）
  preset <mode>        套用预设模式到所有风扇（silent|standard|performance|full_speed）
  reset-curve <id>     恢复曲线为默认值
  calibrate [fan]      校准风扇启动阈值
  calibrate-progress   查看校准进度

示例:
  fanxpert start
  fanxpert info
  fanxpert logs 200
  fanxpert preset silent
  fanxpert reset-curve standard
  fanxpert curve-data cpu_fan
  fanxpert calibrate cpu_fan
EOF
}

# ============================================================
# COMMAND DISPATCHER
# ============================================================

# 加载 UCI 配置（用于子命令）
load_uci_config

case "$1" in
    run)
        cmd_run
        ;;
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_restart
        ;;
    reload)
        cmd_reload
        ;;
    status)
        cmd_status "$2"
        ;;
    info)
        cmd_info "$2"
        ;;
    logs)
        cmd_logs "$2"
        ;;
    curve-data)
        cmd_curve_data "$2"
        ;;
    reset-curve)
        cmd_reset_curve "$2"
        ;;
    preset)
        cmd_preset "$2"
        ;;
    calibrate)
        cmd_calibrate "$2"
        ;;
    calibrate-progress)
        cmd_calibrate_progress
        ;;
    -h|--help|help)
        show_usage
        ;;
    *)
        echo "未知命令: $1"
        echo "使用 'fanxpert help' 查看帮助"
        exit 1
        ;;
esac
