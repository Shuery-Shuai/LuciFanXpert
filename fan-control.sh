#!/bin/sh

LOGGER="/usr/bin/logger"

# PWM 控制范围定义
PWM_MIN=0      # 最小 PWM 值
PWM_MAX=255    # 最大 PWM 值

# 温度和风扇速度控制点（可调整）
TEMP_MIN=35    # 最低温度阈值（°C）
TEMP_MAX=75    # 最高温度阈值（°C）
PWM_START=30   # 起始转速百分比
PWM_END=100    # 最高转速百分比

# 计算平滑曲线 PWM 值
# 使用三次贝塞尔曲线实现平滑过渡
# 参数：当前温度
calculate_curve_pwm() {
    calculate_curve_pwm_temp=$1
    calculate_curve_pwm_t=
    
    # 如果温度低于最低阈值，使用最低转速
    if [ "$calculate_curve_pwm_temp" -le "$TEMP_MIN" ]; then
        percent_to_pwm "$PWM_START"
        return
    fi
    
    # 如果温度高于最高阈值，使用最高转速
    if [ "$calculate_curve_pwm_temp" -ge "$TEMP_MAX" ]; then
        percent_to_pwm "$PWM_END"
        return
    fi
    
    # 计算温度在范围内的位置（0-1000）
    # 使用 1000 而不是 1 来提高精度
    calculate_curve_pwm_t=$(( (calculate_curve_pwm_temp - TEMP_MIN) * 1000 / (TEMP_MAX - TEMP_MIN) ))
    
    # 使用三次贝塞尔曲线公式计算
    # 控制点：(0,PWM_START), (0.25,PWM_START+10), (0.75,PWM_END-10), (1,PWM_END)
    calculate_curve_pwm_t2=$(( calculate_curve_pwm_t * calculate_curve_pwm_t / 1000 ))
    calculate_curve_pwm_t3=$(( calculate_curve_pwm_t2 * calculate_curve_pwm_t / 1000 ))
    calculate_curve_pwm_mt=$(( 1000 - calculate_curve_pwm_t ))
    calculate_curve_pwm_mt2=$(( calculate_curve_pwm_mt * calculate_curve_pwm_mt / 1000 ))
    calculate_curve_pwm_mt3=$(( calculate_curve_pwm_mt2 * calculate_curve_pwm_mt / 1000 ))
    
    # 计算曲线上的点
    calculate_curve_pwm_p1=$(( PWM_START * calculate_curve_pwm_mt3 ))
    calculate_curve_pwm_p2=$(( (PWM_START + 10) * 3 * calculate_curve_pwm_mt2 * calculate_curve_pwm_t / 1000 ))
    calculate_curve_pwm_p3=$(( (PWM_END - 10) * 3 * calculate_curve_pwm_mt * calculate_curve_pwm_t2 / 1000 ))
    calculate_curve_pwm_p4=$(( PWM_END * calculate_curve_pwm_t3 ))
    
    # 计算最终百分比并转换为 PWM 值
    calculate_curve_pwm_percent=$(( (calculate_curve_pwm_p1 + calculate_curve_pwm_p2 + calculate_curve_pwm_p3 + calculate_curve_pwm_p4) / 1000 ))
    percent_to_pwm "$calculate_curve_pwm_percent"
}

# 将百分比转换为 PWM 值
percent_to_pwm() {
    percent_to_pwm_percent=$1
    # 确保百分比在 0-100 范围内
    [ "$percent_to_pwm_percent" -lt 0 ] && percent_to_pwm_percent=0
    [ "$percent_to_pwm_percent" -gt 100 ] && percent_to_pwm_percent=100
    # 计算对应的 PWM 值
    echo $(( (PWM_MAX - PWM_MIN) * percent_to_pwm_percent / 100 + PWM_MIN ))
}

# 将 PWM 值转换为百分比
pwm_to_percent() {
    pwm_to_percent_pwm=$1
    # 确保 PWM 值在有效范围内
    [ "$pwm_to_percent_pwm" -lt "$PWM_MIN" ] && pwm_to_percent_pwm=$PWM_MIN
    [ "$pwm_to_percent_pwm" -gt "$PWM_MAX" ] && pwm_to_percent_pwm=$PWM_MAX
    # 计算百分比
    echo $(( (pwm_to_percent_pwm - PWM_MIN) * 100 / (PWM_MAX - PWM_MIN) ))
}

# 查找温度传感器和 PWM 控制器
find_hwmon_paths() {
    find_hwmon_paths_found_temp=0
    find_hwmon_paths_found_pwm=0
    
    for hwmon in /sys/class/hwmon/hwmon*; do
        # 检查是否为温度传感器
        if [ -r "$hwmon/temp1_input" ] && [ -r "$hwmon/name" ]; then
            find_hwmon_paths_name=$(cat "$hwmon/name")
            case "$find_hwmon_paths_name" in
                *cpu* | *thermal* | *coretemp* | *k10temp*)
                    TEMP_PATH="$hwmon/temp1"
                    find_hwmon_paths_found_temp=1
                    "$LOGGER" -t FanXpert "找到温度传感器：$TEMP_PATH (name: $find_hwmon_paths_name)"
                    ;;
            esac
        fi
        
        # 检查是否为 PWM 控制器
        if [ -w "$hwmon/pwm1" ] && [ -r "$hwmon/name" ]; then
            find_hwmon_paths_name=$(cat "$hwmon/name")
            case "$find_hwmon_paths_name" in
                *pwm* | *fan*)
                    PWM_PATH="$hwmon/pwm1"
                    find_hwmon_paths_found_pwm=1
                    "$LOGGER" -t FanXpert "找到风扇控制器：$PWM_PATH (name: $find_hwmon_paths_name)"
                    ;;
            esac
        fi
    done
    
    # 如果没有找到带名称的设备，使用任何可用的设备
    if [ "$find_hwmon_paths_found_temp" -eq 0 ]; then
        for hwmon in /sys/class/hwmon/hwmon*; do
            if [ -r "$hwmon/temp1_input" ]; then
                TEMP_PATH="$hwmon/temp1"
                find_hwmon_paths_found_temp=1
                "$LOGGER" -t FanXpert "找到备用温度传感器：$TEMP_PATH"
                break
            fi
        done
    fi
    
    if [ "$find_hwmon_paths_found_pwm" -eq 0 ]; then
        for hwmon in /sys/class/hwmon/hwmon*; do
            if [ -w "$hwmon/pwm1" ]; then
                PWM_PATH="$hwmon/pwm1"
                find_hwmon_paths_found_pwm=1
                "$LOGGER" -t FanXpert "找到备用风扇控制器：$PWM_PATH"
                break
            fi
        done
    fi
    
    # 验证是否找到所需设备
    if [ "$find_hwmon_paths_found_temp" -eq 0 ] || [ "$find_hwmon_paths_found_pwm" -eq 0 ]; then
        return 1
    fi
    return 0
}

log_path_status() {
    log_path_status_path=$1
    log_path_status_readable=no
    log_path_status_writable=no
    log_path_status_executable=no

    if [ ! -e "$log_path_status_path" ]; then
        "$LOGGER" -t FanXpert "路径状态：$log_path_status_path (不存在)"
        return
    fi

    [ -r "$log_path_status_path" ] && log_path_status_readable=yes
    [ -w "$log_path_status_path" ] && log_path_status_writable=yes
    [ -x "$log_path_status_path" ] && log_path_status_executable=yes

    "$LOGGER" -t FanXpert "路径状态：$log_path_status_path (readable=$log_path_status_readable, writable=$log_path_status_writable, executable=$log_path_status_executable)"
}

# 等待系统完全启动和设备就绪
sleep 5

# 查找所需的设备文件
if ! find_hwmon_paths; then
    "$LOGGER" -t FanXpert -p daemon.err "错误：无法找到必要的温度传感器或风扇控制器"
    exit 1
fi

# 检查文件是否存在和可访问
check_files() {
    check_files_waited=0
    while [ "$check_files_waited" -lt 30 ]; do
        # 详细检查每个文件的访问权限
        if [ ! -e "$PWM_PATH" ]; then
            "$LOGGER" -t FanXpert "PWM 文件不存在：$PWM_PATH"
            sleep 1
            check_files_waited=$((check_files_waited + 1))
            continue
        fi
        
        if [ ! -w "$PWM_PATH" ]; then
            "$LOGGER" -t FanXpert "PWM 文件不可写：$PWM_PATH"
            log_path_status "$PWM_PATH"
            sleep 1
            check_files_waited=$((check_files_waited + 1))
            continue
        fi
        
        if [ ! -e "${TEMP_PATH}_input" ]; then
            "$LOGGER" -t FanXpert "温度文件不存在：${TEMP_PATH}_input"
            sleep 1
            check_files_waited=$((check_files_waited + 1))
            continue
        fi
        
        if [ ! -r "${TEMP_PATH}_input" ]; then
            "$LOGGER" -t FanXpert "温度文件不可读：${TEMP_PATH}_input"
            log_path_status "${TEMP_PATH}_input"
            sleep 1
            check_files_waited=$((check_files_waited + 1))
            continue
        fi
        
        # 测试温度读取
        check_files_test_temp=$(cat "${TEMP_PATH}_input" 2>/dev/null)
        if [ -z "$check_files_test_temp" ]; then
            "$LOGGER" -t FanXpert "温度读取为空"
            sleep 1
            check_files_waited=$((check_files_waited + 1))
            continue
        fi
        
        if ! [ "$check_files_test_temp" -eq "$check_files_test_temp" ] 2>/dev/null; then
            "$LOGGER" -t FanXpert "温度值无效：$check_files_test_temp"
            sleep 1
            check_files_waited=$((check_files_waited + 1))
            continue
        fi
        
        if [ "$check_files_test_temp" -eq 0 ]; then
            "$LOGGER" -t FanXpert "温度读取为 0，等待有效值"
            sleep 1
            check_files_waited=$((check_files_waited + 1))
            continue
        fi
        
        # 所有检查都通过
        "$LOGGER" -t FanXpert "设备检查通过，温度：$check_files_test_temp"
        return 0
    done
    
    # 如果达到这里，说明超时了，输出详细的错误信息
    "$LOGGER" -t FanXpert -p daemon.err "错误：设备准备超时"
    "$LOGGER" -t FanXpert "PWM 文件状态："
    log_path_status "$PWM_PATH"
    "$LOGGER" -t FanXpert "温度文件状态："
    log_path_status "${TEMP_PATH}_input"
    return 1
}

if ! check_files; then
    exit 1
fi

# 确保控制模式为手动
echo 1 > "${PWM_PATH}_enable" 2>/dev/null

# 初始化变量（使用百分比设置）
initial_percent=$PWM_START
current_pwm=$(percent_to_pwm "$initial_percent")
target_pwm=$current_pwm
step_size=2          # 步进值使过渡更平滑
last_log_time=0      # 上次记录完整状态的时间
log_interval=300     # 完整状态日志间隔（秒）
last_temp_c=0        # 上次记录的温度
temp_threshold=2     # 温度变化阈值（摄氏度）

# 读取当前 PWM 值
if [ -r "$PWM_PATH" ]; then
    read_pwm=$(cat "$PWM_PATH" 2>/dev/null) || read_pwm=$current_pwm
    if [ "$read_pwm" -eq "$read_pwm" ] 2>/dev/null; then
        current_pwm=$read_pwm
        current_percent=$(pwm_to_percent "$current_pwm")
        "$LOGGER" -t FanXpert "读取当前风扇状态：PWM=$current_pwm (${current_percent}%)"
    fi
fi

# 初始化 PWM 值
if ! printf '%d' "$current_pwm" > "$PWM_PATH" 2>/dev/null; then
    "$LOGGER" -t FanXpert -p daemon.err "错误：无法设置初始 PWM 值"
    exit 1
fi

"$LOGGER" -t FanXpert "风扇控制启动成功（PWM 范围：$PWM_MIN-$PWM_MAX，温度范围：${TEMP_MIN}°C-${TEMP_MAX}°C）"

# 主控制循环
while true; do
    current_time=$(date +%s)
    
    # 读取温度
    temp=$(cat "${TEMP_PATH}_input" 2>/dev/null) || {
        "$LOGGER" -t FanXpert -p daemon.err "错误：无法读取温度"
        sleep 5
        continue
    }
    
    # 验证温度值
    if [ -z "$temp" ] || ! [ "$temp" -eq "$temp" ] 2>/dev/null; then
        "$LOGGER" -t FanXpert -p daemon.err "错误：温度值无效：$temp"
        sleep 5
        continue
    fi
    
    # 转换温度
    temp_c=$((temp/1000))
    
    # 根据温度计算目标 PWM 值（使用曲线）
    target_pwm=$(calculate_curve_pwm "$temp_c")
    target_percent=$(pwm_to_percent "$target_pwm")
    
    # 平滑过渡
    last_pwm=$current_pwm
    if [ "$current_pwm" -lt "$target_pwm" ]; then
        current_pwm=$((current_pwm + step_size))
        [ "$current_pwm" -gt "$target_pwm" ] && current_pwm=$target_pwm
    elif [ "$current_pwm" -gt "$target_pwm" ]; then
        current_pwm=$((current_pwm - step_size))
        [ "$current_pwm" -lt "$target_pwm" ] && current_pwm=$target_pwm
    fi
    
    # 确保 PWM 值在有效范围内
    [ "$current_pwm" -lt "$PWM_MIN" ] && current_pwm=$PWM_MIN
    [ "$current_pwm" -gt "$PWM_MAX" ] && current_pwm=$PWM_MAX
    
    # 日志输出策略
    temp_changed=0
    pwm_changed=0
    
    # 检查温度是否发生显著变化
    if [ $(( temp_c > last_temp_c ? temp_c - last_temp_c : last_temp_c - temp_c )) -ge "$temp_threshold" ]; then
        temp_changed=1
        last_temp_c=$temp_c
    fi
    
    # 检查 PWM 是否发生变化
    [ "$current_pwm" -ne "$last_pwm" ] && pwm_changed=1
    
    # 根据不同情况输出日志
    if [ "$pwm_changed" -eq 1 ]; then
        # PWM 值变化时输出简要日志
        current_percent=$(pwm_to_percent "$current_pwm")
        "$LOGGER" -t FanXpert "温度：${temp_c}°C, PWM：${current_pwm}(${current_percent}%)"
    elif [ "$temp_changed" -eq 1 ]; then
        # 温度显著变化但 PWM 未变时输出温度信息
        current_percent=$(pwm_to_percent "$current_pwm")
        "$LOGGER" -t FanXpert "温度更新：${temp_c}°C, 当前 PWM：${current_pwm}(${current_percent}%)"
    fi
    
    # 定期输出完整状态信息
    if [ $((current_time - last_log_time)) -ge "$log_interval" ]; then
        current_percent=$(pwm_to_percent "$current_pwm")
        "$LOGGER" -t FanXpert "状态报告 - 温度：${temp_c}°C, PWM：${current_pwm}(${current_percent}%), 目标：${target_pwm}(${target_percent}%)"
        last_log_time=$current_time
    fi
    
    # 写入 PWM 值
    if ! printf '%d' "$current_pwm" > "$PWM_PATH" 2>/dev/null; then
        "$LOGGER" -t FanXpert -p daemon.err "错误：无法设置 PWM 值：$current_pwm"
        sleep 5
        continue
    fi

    sleep 1
done
