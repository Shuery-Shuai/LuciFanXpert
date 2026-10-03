#!/bin/sh
# shellcheck disable=SC2034,SC2154  # 运行期变量由被 source 的 fanxpert.sh 赋值/读取
# ============================================================================
# FanXpert 守护进程自检（RPM / 参考表 / 状态 JSON / 预设模式 / 斜率限制 / 热重载 / 多测温点 / 极致静音 / 固定转速 / 日志）
# ----------------------------------------------------------------------------
# 直接 source fanxpert.sh（以 help 为参数，脚本尾部只打印用法），再用假 sysfs
# 验证转速读取、档位最低转速采样、参考表 JSON 与状态文件内容。
#
# 用法：sh tools/daemon-check.sh
#
# 说明：json_escape 里的 `sed -e ':a;N;$!ba;s/\n/\\n/g'` 是 BusyBox/GNU sed
# 写法，macOS 自带 BSD sed 会打印告警（不影响结果），因此脚本里对相关调用做了
# 标准错误重定向。
# ============================================================================
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
SCRIPT="$ROOT/luci-app-fanxpert/root/usr/sbin/fanxpert.sh"
WORK="${TMPDIR:-/tmp}/fanxpert-daemon-check.$$"

fail=0

# shellcheck disable=SC2329  # 由下一行的 trap 在退出时调用，静态分析看不到这层引用
cleanup() {
	rm -rf "$WORK"
}
trap cleanup EXIT

expect() {
	if [ "$2" = "$3" ]; then
		printf '  PASS %s\n' "$1"
	else
		printf '  FAIL %s → 期望 [%s] 实际 [%s]\n' "$1" "$2" "$3"
		fail=$((fail + 1))
	fi
}

check_json() { # 名称 文件 取值路径（点分） 期望的 JSON 片段
	if python3 - "$2" "$3" "$4" <<'PY' >/dev/null 2>&1
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))
for key in sys.argv[2].split('.'):
	doc = doc[key]
sys.exit(0 if doc == json.loads(sys.argv[3]) else 1)
PY
	then
		printf '  PASS %s\n' "$1"
	else
		printf '  FAIL %s（JSON 校验未通过）\n' "$1"
		fail=$((fail + 1))
	fi
}

rpm_field() { # 从状态文件里取出 "rpm": 后面的值
	grep -o '"rpm": [a-z0-9]*' "$1" | awk '{ print $2 }'
}

mkdir -p "$WORK/hwmon0" || exit 1

printf '900\n' > "$WORK/hwmon0/fan1_input"
printf '128\n' > "$WORK/hwmon0/pwm1"
PWM_PATH="$WORK/hwmon0/pwm1"

# 以 help 作为参数 source：脚本尾部只执行 show_usage
set -- help
# shellcheck disable=SC1090
. "$SCRIPT" >/dev/null 2>&1

# source 之后再覆盖路径与运行期变量（脚本顶部会重置这些常量）
RPM_MAP_FILE="$WORK/rpm_map"
STATE_FILE="$WORK/state.json"
DAEMON_START_TIME=$(($(date +%s) - 3725))
LAST_STATE_CONTENT=""
LAST_STATE_WRITE_TIME=0
MAX_TEMP=61
MAX_TEMP_TIME=$(date +%s)
rm -f "$RPM_MAP_FILE" "$STATE_FILE"

echo "[1] 转速读取"
expect "read_fan_rpm 读到 900" "900" "$(read_fan_rpm "$PWM_PATH")"

echo "[2] 档位采样（每 10% 一档，保留最低值）"
record_rpm_sample cpu_fan 32 900
record_rpm_sample cpu_fan 32 1200
record_rpm_sample cpu_fan 32 850
record_rpm_sample cpu_fan 50 1180
record_rpm_sample other_fan 50 500
expect "同档位保留最低值" "cpu_fan 30 850" "$(grep '^cpu_fan 30 ' "$RPM_MAP_FILE")"
expect "按 10% 取整档位" "cpu_fan 50 1180" "$(grep '^cpu_fan 50 ' "$RPM_MAP_FILE")"
expect "多风扇互不干扰" "other_fan 50 500" "$(grep '^other_fan ' "$RPM_MAP_FILE")"

echo "[3] 参考表 JSON"
expect "按键位升序输出" "[[30,850],[50,1180]]" "$(rpm_table_json cpu_fan)"
expect "无数据风扇输出空表" "[]" "$(rpm_table_json no_such_fan)"
printf 'cpu_fan 50 1180\ncpu_fan 30 850\n' > "$RPM_MAP_FILE"
expect "乱序写入后仍排序输出" "[[30,850],[50,1180]]" "$(rpm_table_json cpu_fan)"

echo "[4] 状态 JSON"
write_state_file cpu_fan "CPU Fan" 45 128 standard /sys/fake/temp1_input "$PWM_PATH" 2>/dev/null
check_json "含实时 rpm / percent / temp" "$STATE_FILE" devices.cpu_fan \
	'{"label":"CPU Fan","temp":45,"pwm":128,"percent":50,"rpm":900,"curve":"standard","sensor_path":"/sys/fake/temp1_input","sensors":[]}'

echo "[5] 无转速传感器"
rm -f "$WORK/hwmon0/fan1_input"
rm -f "$STATE_FILE"
LAST_STATE_CONTENT=""
samples_before=$(grep -c . "$RPM_MAP_FILE" 2>/dev/null || echo 0)
write_state_file cpu_fan "CPU Fan" 45 128 standard /sys/fake/temp1_input "$PWM_PATH" 2>/dev/null
samples_after=$(grep -c . "$RPM_MAP_FILE" 2>/dev/null || echo 0)
expect "rpm 为 null 而不是 0" "null" "$(rpm_field "$STATE_FILE")"
expect "不再新增采样" "$samples_before" "$samples_after"

echo "[6] 缺省 pwm_path 不报错"
rm -f "$STATE_FILE"
LAST_STATE_CONTENT=""
write_state_file cpu_fan "CPU Fan" 45 128 standard /sys/fake/temp1_input "" 2>/dev/null
expect "rpm 仍为 null" "null" "$(rpm_field "$STATE_FILE")"

echo "[7] 预设模式切换（四档，一键套用到所有风扇）"
# 假 uci：记录调用，并让 ensure_uci_config 认为配置已完整
mkdir -p "$WORK/bin"
UCI_LOG="$WORK/uci.log"
export UCI_LOG
cat > "$WORK/bin/uci" <<'FAKE'
#!/bin/sh
echo "uci $*" >> "$UCI_LOG"

cmd="$1"
[ "$cmd" = "-q" ] && { cmd="$2"; shift; }
shift

case "$cmd" in
	get)
		case "$1" in
			fanxpert.settings) echo global ;;
			*.pwm_min_start_timestamp) echo 0 ;;
			*.ramp_up_time) [ -n "${FAKE_RAMP_UP:-}" ] || exit 1; echo "$FAKE_RAMP_UP" ;;
			*.ramp_down_time) [ -n "${FAKE_RAMP_DOWN:-}" ] || exit 1; echo "$FAKE_RAMP_DOWN" ;;
			fanxpert.cpu_fan.enabled) echo 1 ;;
			fanxpert.cpu_fan.label) echo "CPU Fan" ;;
			fanxpert.cpu_fan.curve) echo standard ;;
			fanxpert.cpu_fan.pwm_path) echo "$FAKE_PWM_PATH" ;;
			fanxpert.cpu_fan.pwm_min_start) echo "${FAKE_MIN_START:-0}" ;;
			fanxpert.cpu_fan.never_stop) echo "${FAKE_NEVER_STOP:-1}" ;;
			fanxpert.cpu_fan.quiet_mode) echo "${FAKE_QUIET:-0}" ;;
			fanxpert.cpu_fan.auto_stop) [ -n "${FAKE_AUTO_STOP:-}" ] || exit 1; echo "$FAKE_AUTO_STOP" ;;
			fanxpert.cpu_fan.pwm_min_start_source) echo "${FAKE_MIN_SOURCE:-unknown}" ;;
			fanxpert.cpu_fan.sensors) [ -n "${FAKE_SENSORS:-}" ] || exit 1; echo "$FAKE_SENSORS" ;;
			fanxpert.standard.type) echo bezier ;;
			fanxpert.standard.sensor) echo cpu_temp ;;
			fanxpert.fixed.type) echo fixed ;;
			fanxpert.fixed.sensor) echo cpu_temp ;;
			fanxpert.fixed.pwm_start) echo 50 ;;
			fanxpert.linear.type) echo linear ;;
			fanxpert.linear.sensor) echo cpu_temp ;;
			fanxpert.linear.temp_min) echo 35 ;;
			fanxpert.linear.temp_max) echo 75 ;;
			fanxpert.linear.pwm_start) echo 30 ;;
			fanxpert.linear.pwm_end) echo 100 ;;
			fanxpert.step.type) echo step ;;
			fanxpert.step.sensor) echo cpu_temp ;;
			fanxpert.step.temp_min) echo 35 ;;
			fanxpert.step.temp_max) echo 75 ;;
			fanxpert.step.pwm_start) echo 30 ;;
			fanxpert.step.pwm_end) echo 100 ;;
			fanxpert.standard.temp_min) echo 36 ;;
			fanxpert.standard.temp_max) echo 76 ;;
			fanxpert.standard.pwm_start) echo 31 ;;
			fanxpert.standard.pwm_end) echo 99 ;;
			fanxpert.standard.sensor) echo cpu_temp ;;
			fanxpert.cpu_temp.label) echo "CPU Temperature" ;;
			fanxpert.*.label) echo "Sensor" ;;
			fanxpert.*.type) echo hwmon ;;
			fanxpert.*.platform) echo "$FAKE_SENSOR_PATH" ;;
			*) exit 1 ;;
		esac
		;;
	show) printf 'fanxpert.cpu_fan=fan\nfanxpert.case_fan=fan\n' ;;
	batch) cat >/dev/null ;;
	*) : ;;
esac

exit 0
FAKE
chmod +x "$WORK/bin/uci"

PATH="$WORK/bin:$PATH"
RELOAD_FLAG="$WORK/reload_requested"
PID_FILE="$WORK/fanxpert.pid"
FAKE_RAMP_UP=30
FAKE_RAMP_DOWN=120
export FAKE_RAMP_UP FAKE_RAMP_DOWN
: > "$UCI_LOG"
: > "$PID_FILE"

result=$(cmd_preset silent 2>/dev/null)
expect "四档模式套用到所有风扇" '{"ok":true,"mode":"silent","fans":["cpu_fan","case_fan"]}' "$result"
expect "写入每个风扇的曲线" "2" "$(grep -c 'set fanxpert\..*\.curve=silent' "$UCI_LOG")"
expect "提交 UCI" "yes" "$([ "$(grep -c '^uci commit fanxpert$' "$UCI_LOG")" -ge 1 ] && echo yes || echo no)"
expect "缺失的预设曲线会被补齐" "yes" "$([ "$(grep -c 'set fanxpert.full_speed=' "$UCI_LOG")" -ge 1 ] && echo yes || echo no)"
expect "通知守护进程重载" "yes" "$([ -f "$RELOAD_FLAG" ] && echo yes || echo no)"

result=$(cmd_preset full_speed 2>/dev/null)
expect "全速模式可用" '{"ok":true,"mode":"full_speed","fans":["cpu_fan","case_fan"]}' "$result"

result=$(cmd_preset bogus 2>/dev/null)
expect "非法模式被拒绝" '{"error":"Invalid preset mode"}' "$result"

# 核心字段缺失时同样由 ensure_uci_config 补齐（case_fan 在假 uci 里没有任何字段）
: > "$UCI_LOG"
cmd_preset silent >/dev/null 2>&1
# label 由假 uci 的通配规则提供，这里只断言其余核心字段
for k in enabled curve pwm_path pwm_min_start never_stop; do
	expect "补齐 case_fan.$k" "yes" "$([ "$(grep -c "set fanxpert.case_fan.$k=" "$UCI_LOG")" -ge 1 ] && echo yes || echo no)"
done

# 升/降速字段缺失时由 ensure_uci_config 补齐
FAKE_RAMP_UP=""
FAKE_RAMP_DOWN=""
: > "$UCI_LOG"
cmd_preset silent >/dev/null 2>&1
expect "缺失的升/降速字段会被补齐" "4" "$(grep -c 'set fanxpert\..*\.ramp_.*_time=' "$UCI_LOG")"
FAKE_RAMP_UP=30
FAKE_RAMP_DOWN=120

echo "[8] 全速预设的曲线输出"
full_ok=1
for t in 0 20 40 60 80 100; do
	pwm=$(calculate_bezier_curve "$t" 0 100 100 100)
	if [ "$pwm" -lt 255 ]; then
		full_ok=0
		printf '    t=%s → %s\n' "$t" "$pwm"
	fi
done
expect "全速档在 0–100°C 都是满速" "1" "$full_ok"
expect "静音档在低温时不会满速" "51" "$(calculate_bezier_curve 40 40 70 20 70)"

echo "[9] 升速/降速时间（斜率限制）"
expect "0 = 不限制，立即到达目标" "255" "$(ramp_limited_pwm 0 255 0 0)"
expect "升速 30s：单步 ceil(255/30)=9" "9" "$(ramp_limited_pwm 0 255 30 0)"
expect "降速 120s：单步 ceil(255/120)=3" "252" "$(ramp_limited_pwm 255 0 0 120)"
expect "升速接近目标时精确停在目标" "120" "$(ramp_limited_pwm 115 120 30 0)"
expect "降速不越过目标" "101" "$(ramp_limited_pwm 104 100 0 120)"
expect "降速接近目标时精确停在目标" "100" "$(ramp_limited_pwm 102 100 0 120)"
expect "目标等于当前时保持不变" "77" "$(ramp_limited_pwm 77 77 30 120)"
PWM_MAX=100
expect "非 255 硬件按 span 缩放" "4" "$(ramp_limited_pwm 0 100 30 0)"
PWM_MAX=255

echo "[10] 配置热重载（曲线参数 + 升/降速时间）"
printf '45000\n' > "$WORK/hwmon0/temp1_input"
FAKE_SENSOR_PATH="$WORK/hwmon0/temp1"
FAKE_PWM_PATH="$WORK/hwmon0/pwm1"
FAKE_RAMP_UP=60
FAKE_RAMP_DOWN=240
export FAKE_SENSOR_PATH FAKE_PWM_PATH FAKE_RAMP_UP FAKE_RAMP_DOWN

expect "重载后曲线参数生效" "36|76|31|99" "$(reload_runtime_config cpu_fan >/dev/null 2>&1; echo "$temp_min|$temp_max|$pwm_start|$pwm_end")"
expect "重载后升速时间生效" "60" "$(reload_runtime_config cpu_fan >/dev/null 2>&1; echo "$ramp_up_time")"
expect "重载后降速时间生效" "240" "$(reload_runtime_config cpu_fan >/dev/null 2>&1; echo "$ramp_down_time")"

FAKE_RAMP_UP=""
FAKE_RAMP_DOWN=""
expect "uci 缺字段时回落到默认值" "30|120" "$(load_ramp_config cpu_fan)"

echo "[11] 多测温点（最多 3 个，取最高温）"
mkdir -p "$WORK/sensors"
printf '45000\n' > "$WORK/sensors/cpu_input"
printf '52000\n' > "$WORK/sensors/wifi_input"
printf '38000\n' > "$WORK/sensors/board_input"

expect "取最高温" "52" "$(read_multi_temperature "cpu_temp:$WORK/sensors/cpu wifi_temp:$WORK/sensors/wifi board_temp:$WORK/sensors/board"; echo "$TEMP_VALUE")"
expect "记录最高温来源路径" "$WORK/sensors/wifi" "$(read_multi_temperature "cpu_temp:$WORK/sensors/cpu wifi_temp:$WORK/sensors/wifi"; echo "$TEMP_SOURCE_PATH")"
expect "输出各测温点读数" '["cpu_temp",45],["wifi_temp",52]' "$(read_multi_temperature "cpu_temp:$WORK/sensors/cpu wifi_temp:$WORK/sensors/wifi"; echo "$TEMP_SENSOR_JSON")"
expect "缺失的测温点被跳过" "45" "$(read_multi_temperature "missing:$WORK/sensors/none cpu_temp:$WORK/sensors/cpu"; echo "$TEMP_VALUE")"
read_multi_temperature "missing:$WORK/sensors/none" >/dev/null 2>&1
expect "全部不可读时返回失败" "1" "$?"

printf '98000\n' > "$WORK/sensors/hot_input"
FAKE_SENSOR_PATH="$WORK/sensors/cpu"
export FAKE_SENSOR_PATH

FAKE_SENSORS="cpu_temp wifi_temp"
export FAKE_SENSORS
expect "按 fan.sensors 解析多个测温点" "cpu_temp:$WORK/sensors/cpu wifi_temp:$WORK/sensors/cpu" "$(load_sensor_paths cpu_fan)"

FAKE_SENSORS="cpu_temp wifi_temp board_temp hot"
export FAKE_SENSORS
expect "超过 3 个时最多解析 3 个" "3" "$(load_sensor_paths cpu_fan | wc -w | tr -d ' ')"

FAKE_SENSORS=""
export FAKE_SENSORS
expect "未配置 sensors 时回落到曲线字段" "cpu_temp:$WORK/sensors/cpu" "$(load_sensor_paths cpu_fan)"

# 回归：调用方把 IFS 设成 '|' 时（reload_runtime_config 就是这么干的），
# UCI 列表仍然必须按空格切分，否则多测温点配置会静默重载失败。
FAKE_SENSORS="cpu_temp wifi_temp"
export FAKE_SENSORS
expect "调用方 IFS='|' 时仍能解析多个测温点" "cpu_temp:$WORK/sensors/cpu wifi_temp:$WORK/sensors/cpu" \
	"$(IFS='|'; load_sensor_paths cpu_fan)"
expect "调用方 IFS='|' 时取最高温仍正确" "52" \
	"$(IFS='|'; read_multi_temperature "cpu_temp:$WORK/sensors/cpu wifi_temp:$WORK/sensors/wifi"; echo "$TEMP_VALUE")"

write_state_file cpu_fan "CPU Fan" 52 200 standard "$WORK/sensors/wifi" "$PWM_PATH" '[["cpu_temp",45],["wifi_temp",52]]' 2>/dev/null
check_json "状态文件写入测温点数组" "$STATE_FILE" devices.cpu_fan.sensors '[["cpu_temp",45],["wifi_temp",52]]'

echo "[12] 极致静音 / 自动停转（校准前置）"
export FAKE_QUIET FAKE_AUTO_STOP FAKE_MIN_START FAKE_MIN_SOURCE FAKE_NEVER_STOP

FAKE_QUIET=1
FAKE_AUTO_STOP=0
FAKE_MIN_START=0
FAKE_MIN_SOURCE=unknown
expect "未校准时极致静音不生效" "0|0" "$(resolve_quiet_and_stop cpu_fan 2>/dev/null)"

FAKE_MIN_START=25
FAKE_MIN_SOURCE=measured
expect "校准后极致静音生效" "1|0" "$(resolve_quiet_and_stop cpu_fan 2>/dev/null)"

FAKE_QUIET=0
FAKE_AUTO_STOP=1
expect "自动停转需要极致静音" "0|0" "$(resolve_quiet_and_stop cpu_fan 2>/dev/null)"

FAKE_QUIET=1
FAKE_AUTO_STOP=1
expect "极致静音 + 自动停转同时生效" "1|1" "$(resolve_quiet_and_stop cpu_fan 2>/dev/null)"

FAKE_MIN_SOURCE=estimated
FAKE_QUIET=1
FAKE_AUTO_STOP=0
expect "估算校准同样满足前置" "1|0" "$(resolve_quiet_and_stop cpu_fan 2>/dev/null)"

FAKE_MIN_SOURCE=unknown
has_valid_calibration cpu_fan 2>/dev/null
expect "来源不是实测/估算时视为未校准" "1" "$?"

FAKE_MIN_START=30
FAKE_MIN_SOURCE=measured
FAKE_AUTO_STOP=""
FAKE_NEVER_STOP=0
expect "auto_stop 缺失时由 never_stop 派生" "1" "$(load_auto_stop cpu_fan 2>/dev/null)"
FAKE_NEVER_STOP=1
expect "never_stop=1 派生为不停转" "0" "$(load_auto_stop cpu_fan 2>/dev/null)"

expect "极致静音下调 15%" "170" "$(apply_quiet_bias 200 1)"
expect "关闭极致静音时不做调整" "200" "$(apply_quiet_bias 200 0)"
expect "极低转速下取整不会变成负数" "3" "$(apply_quiet_bias 3 1)"
expect "转速为 1% 时仍不为负" "1" "$(apply_quiet_bias 1 1)"

echo "[13] 固定转速模式"
expect "fixed 曲线解析为固定类型" "fixed|cpu_temp|0|100|50|50" "$(load_curve_config fixed 2>/dev/null)"
expect "fixed 曲线输出水平线（百分比经 PWM 往返取整）" "[[0,49],[100,49]]" "$(generate_curve_points "$(load_curve_config fixed 2>/dev/null)" 2>/dev/null)"

FAKE_SENSORS="cpu_temp"
export FAKE_SENSORS
result=$(cmd_preset fixed 2>/dev/null)
expect "固定模式可一键套用" '{"ok":true,"mode":"fixed","fans":["cpu_fan","case_fan"]}' "$result"

expect "目标高于起点时不受影响" "200" "$(apply_min_start_floor 200 63 0)"
expect "目标低于起点且不允许停转：抬到起点" "63" "$(apply_min_start_floor 22 63 0)"
expect "目标低于起点且允许停转：输出 0（风扇静止）" "0" "$(apply_min_start_floor 22 63 1)"
expect "未校准时不做任何调整" "22" "$(apply_min_start_floor 22 0 0)"
expect "目标为 0 时保持 0" "0" "$(apply_min_start_floor 0 63 0)"

echo "[16] 曲线类型（贝塞尔 / 线性 / 阶梯 / 固定转速）"
expect "线性：区间下限" "76" "$(calculate_linear_curve 35 35 75 30 100)"
expect "线性：四分之一处" "119" "$(calculate_linear_curve 45 35 75 30 100)"
expect "线性：中点" "165" "$(calculate_linear_curve 55 35 75 30 100)"
expect "线性：区间上限" "255" "$(calculate_linear_curve 75 35 75 30 100)"
expect "线性：低于区间取下限" "76" "$(calculate_linear_curve 20 35 75 30 100)"
expect "线性（递减 100→30）：向零截断" "211" "$(calculate_linear_curve 45 35 75 100 30)"
expect "线性（递减）：区间上限" "76" "$(calculate_linear_curve 75 35 75 100 30)"
expect "阶梯：第一档" "112" "$(calculate_step_curve 40 35 75 30 100)"
expect "阶梯：第四档" "219" "$(calculate_step_curve 60 35 75 30 100)"
expect "阶梯：区间上限" "255" "$(calculate_step_curve 75 35 75 30 100)"
expect "阶梯：同一档内取值不变" "yes" "$([ "$(calculate_step_curve 36 35 75 30 100)" = "$(calculate_step_curve 42 35 75 30 100)" ] && echo yes || echo no)"
expect "阶梯：单调不降" "yes" "$([ "$(calculate_step_curve 40 35 75 30 100)" -lt "$(calculate_step_curve 60 35 75 30 100)" ] && echo yes || echo no)"

step_pts=$(generate_curve_points "$(load_curve_config step)")
lin_pts=$(generate_curve_points "$(load_curve_config linear)")
expect "阶梯曲线采样后只有 6 个档位值" "6" "$(printf '%s' "$step_pts" | grep -o ',[0-9]*\]' | sort -u | wc -l | tr -d ' ')"
expect "线性曲线采样后档位远多于 6 个" "yes" "$([ "$(printf '%s' "$lin_pts" | grep -o ',[0-9]*\]' | sort -u | wc -l | tr -d ' ')" -gt 6 ] && echo yes || echo no)"
expect "linear 曲线解析" "linear|cpu_temp|35|75|30|100" "$(load_curve_config linear)"
expect "step 曲线解析（含档数字段，缺省 5）" "step|cpu_temp|35|75|30|100|5" "$(load_curve_config step)"
expect "阶梯 3 档：第一档" "135" "$(calculate_step_curve 40 35 75 30 100 3)"
expect "阶梯 3 档：第二档" "193" "$(calculate_step_curve 55 35 75 30 100 3)"
expect "阶梯 8 档：第一档" "119" "$(calculate_step_curve 40 35 75 30 100 8)"
expect "阶梯 8 档：第五档" "186" "$(calculate_step_curve 55 35 75 30 100 8)"
expect "阶梯档数钳位：低于下限取 2" "165" "$(calculate_step_curve 40 35 75 30 100 1)"
expect "阶梯档数钳位：高于上限取 20" "102" "$(calculate_step_curve 40 35 75 30 100 999)"
expect "阶梯档数非法值回落默认" "112" "$(calculate_step_curve 40 35 75 30 100 abc)"

echo "[14] cmd_status（运行中时的输出与退出码）"
# 用当前测试 shell 的 PID 伪造一个“活着”的守护进程
PID_FILE="$WORK/fanxpert.pid"
echo $$ > "$PID_FILE"
cat > "$STATE_FILE" <<'JSON'
{
  "devices": {
    "cpu_fan": { "temp": 55, "pwm": 120, "percent": 47 }
  },
  "daemon": {
    "uptime": 1234
  }
}
JSON
status_out=$(cmd_status 2>/dev/null)
expect "运行中时返回 0（前端据此判断服务状态）" "0" "$?"
expect "输出 Status: running" "yes" "$(printf '%s' "$status_out" | grep -q 'Status: running' && echo yes || echo no)"
expect "解析带空格的 uptime" "yes" "$(printf '%s' "$status_out" | grep -q 'Uptime: 1234s' && echo yes || echo no)"

echo "[15] 日志读取（fanxpert.sh logs）"
cat > "$WORK/bin/logread" <<'FAKE'
#!/bin/sh
[ -n "${FAKE_LOGROW:-}" ] || exit 0
printf '%s\n' "$FAKE_LOGROW"
FAKE
chmod +x "$WORK/bin/logread"

FAKE_LOGROW='Tue Sep 29 20:50:12 2026 daemon.notice FANXPERT: 配置已应用 - 风扇: CPU Fan
Tue Sep 29 20:50:15 2026 daemon.err FANXPERT: 无法设置 PWM 值: 200
Tue Sep 29 20:50:20 2026 daemon.debug FANXPERT: 状态报告 - 温度: 45°C'
export FAKE_LOGROW

LOG_LEVEL=notice
result=$(cmd_logs 50 2>/dev/null)
expect "日志按时间顺序返回" "3" "$(printf '%s' "$result" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['lines']))" 2>/dev/null)"
expect "返回日志级别" "notice" "$(printf '%s' "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['log_level'])" 2>/dev/null)"
expect "行数上限校验（非数字回落默认值）" "3" "$(cmd_logs abc 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin)['lines']))" 2>/dev/null)"
expect "按行数截断（只取最后 2 行）" "2" "$(cmd_logs 2 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin)['lines']))" 2>/dev/null)"

FAKE_LOGROW=""
export FAKE_LOGROW
LOG_LEVEL=debug
expect "无日志时返回空数组（并回显日志级别）" '{"ok":true,"lines":[],"count":0,"log_level":"debug"}' "$(cmd_logs 100 2>/dev/null)"

echo "[17] 输入校验 / 换算 / 命令层（阶段3 补充）"
expect "合法 id: cpu_fan" "0" "$(is_valid_id cpu_fan; echo $?)"
expect "合法 id: a1_b2" "0" "$(is_valid_id a1_b2; echo $?)"
for bad in "" "../etc" "a b" "a-b" "a/b"; do
	expect "非法 id 被拒: [${bad:-空}]" "1" "$(is_valid_id "$bad"; echo $?)"
done

expect "percent 0 → PWM 0" "0" "$(percent_to_pwm 0)"
expect "percent 50 → PWM 127（截断）" "127" "$(percent_to_pwm 50)"
expect "percent 100 → PWM 255" "255" "$(percent_to_pwm 100)"
expect "percent 负数钳位到 0" "0" "$(percent_to_pwm -5)"
expect "percent 超范围钳位到 100" "255" "$(percent_to_pwm 150)"

expect "PWM 0 → 0%" "0" "$(pwm_to_percent 0)"
expect "PWM 127 → 49%（截断）" "49" "$(pwm_to_percent 127)"
expect "PWM 255 → 100%" "100" "$(pwm_to_percent 255)"
expect "PWM 超范围钳位到 100%" "100" "$(pwm_to_percent 300)"

PWM_BAK="$PWM_MAX"
: > "$WORK/pwm1"
printf '1023\n' > "$WORK/pwm1_max"
detect_pwm_max "$WORK/pwm1" >/dev/null 2>&1
expect "detect_pwm_max 采用硬件声明上限" "1023" "$PWM_MAX"
PWM_MAX=255
printf 'abc\n' > "$WORK/pwm1_max"
expect "非法 pwm1_max 返回失败" "1" "$(detect_pwm_max "$WORK/pwm1" >/dev/null 2>&1; echo $?)"
expect "非法 pwm1_max 时 PWM_MAX 不被改写" "255" "$PWM_MAX"
rm -f "$WORK/pwm1_max"
expect "缺少 pwm1_max 文件返回失败" "1" "$(detect_pwm_max "$WORK/pwm1" >/dev/null 2>&1; echo $?)"
PWM_MAX="$PWM_BAK"

rm -f "$STATE_FILE"
expect "cmd_info 非法 fan id 被拒" "1" "$(cmd_info '../x' 2>/dev/null | grep -c 'Invalid fan id')"
expect "cmd_info 缺状态文件时给出提示" "1" "$(cmd_info cpu_fan 2>/dev/null | grep -c 'State file not found')"
printf '{"devices":{"cpu_fan":{"temp":55}}}' > "$STATE_FILE"
expect "cmd_info 有状态文件时原样输出" "1" "$(cmd_info cpu_fan 2>/dev/null | grep -c '"temp":55')"

rm -f "$PID_FILE" "$RELOAD_FLAG"
expect "cmd_reload 未运行时提示" "1" "$(cmd_reload 2>/dev/null | grep -c '未运行')"
echo $$ > "$PID_FILE"
cmd_reload >/dev/null 2>&1
expect "cmd_reload 运行时创建重载标志" "yes" "$([ -f "$RELOAD_FLAG" ] && echo yes || echo no)"
rm -f "$PID_FILE" "$RELOAD_FLAG"

: > "$UCI_LOG"
cmd_reset_curve silent >/dev/null 2>&1
expect "cmd_reset_curve 写回预设默认值" "1" "$(grep -c 'set fanxpert.silent.pwm_start=20' "$UCI_LOG")"
expect "cmd_reset_curve 缺参数时提示用法" "1" "$(cmd_reset_curve "" 2>/dev/null | grep -c '用法')"

echo
if [ "$fail" -eq 0 ]; then
	echo "PASS — 转速采样、参考表、状态 JSON、预设模式、斜率限制、热重载、多测温点、极致静音、固定转速与日志读取全部符合预期"
else
	echo "FAIL ($fail)"
fi

exit "$fail"
