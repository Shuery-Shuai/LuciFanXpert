# LuciFanXpert

LuciFanXpert 是一个面向 OpenWrt / immortalwrt 的 LuCI 风扇控制应用。它通过 `hwmon` 读取温度传感器并写入 PWM 控制器，根据 UCI 中配置的温度-转速曲线动态调整风扇转速。

当前项目已全面迁移至现代 OpenWrt / LuCI 技术栈：

- LuCI JavaScript view，不再依赖旧 Lua Controller / CBI / `.htm` view。
- `rpcd` ucode 后端，通过 ubus 向前端暴露状态、曲线数据、校准进度和服务控制接口。
- `menu.d` JSON 菜单与 `rpcd/acl.d` 权限声明。
- procd 管理前台守护进程，由 init 脚本调用 `fanxpert.sh run`。
- UCI 配置，通过 `uci-defaults` 在首次安装时初始化默认值，避免包升级覆盖用户配置。
- i18n 国际化支持，包含 `po/templates` 与 `po/zh_Hans` 中文翻译。
- GitHub Actions 工作流支持构建 APK 与 IPK 并发布 Release。

## 功能概览

- 基于温度的 PWM 风扇控制。
- 三条预设曲线：Silent、Standard、Performance（可重置为默认值）。
- 支持多条自定义曲线：可添加、删除、命名，并可在风扇控制模式中选用。
- 实时状态面板：当前温度、PWM 百分比、运行曲线、服务运行时间。
- Canvas 曲线图：绘制温度‑PWM 曲线并标记实时工作点。
- 配置热重载：保存设置后运行中的守护进程会自动重新应用新曲线、PWM 路径、传感器路径和启动阈值，无需重启服务。
- 风扇启动阈值校准：服务停止时可执行自动校准，支持有 / 无转速反馈的硬件。
- 可配置日志级别（err、warn、notice、info、debug），默认仅记录关键事件，减少日志噪声。
- 完整的中文界面翻译。
- 状态文件写入频率自适应（仅变化时或最少间隔写入），降低闪存磨损。
- 动态探测 PWM 最大值，适配非 255 范围的硬件。
- 服务异常退出后快速自动恢复（procd respawn 间隔优化为 60 秒）。

## 目标环境

推荐环境：

- OpenWrt 24.10 / 25.12 或较新的 immortalwrt snapshot。
- 已安装 LuCI。
- 已安装 `rpcd` 与 `rpcd-mod-ucode`。
- 设备提供可读的 `hwmon` 温度输入（如 `/sys/class/hwmon/hwmon0/temp1_input`）。
- 设备提供可写的 PWM 控制器（如 `/sys/class/hwmon/hwmon1/pwm1`）。

默认配置以 `cpu_temp` 传感器和 `cpu_fan` 为单设备模型。多风扇、多传感器完整编排尚在规划中。

## 项目结构

```text
.
├── deploy.sh
└── luci-app-fanxpert
    ├── Makefile
    ├── htdocs
    │   └── luci-static
    │       └── resources
    │           ├── fanxpert
    │           │   └── fanxpert.css
    │           └── view
    │               └── fanxpert.js
    ├── po
    │   ├── templates
    │   │   └── fanxpert.pot
    │   └── zh_Hans
    │       └── fanxpert.po
    └── root
        ├── etc
        │   ├── init.d
        │   │   └── fanxpert
        │   └── uci-defaults
        │       └── 80_fanxpert
        └── usr
            ├── sbin
            │   └── fanxpert.sh
            └── share
                ├── luci
                │   └── menu.d
                │       └── luci-app-fanxpert.json
                └── rpcd
                    ├── acl.d
                    │   └── luci-app-fanxpert.json
                    └── ucode
                        └── fanxpert
```

## 架构

```text
Browser / LuCI
  fanxpert.js
  form.Map + Canvas + rpc.declare()
        |
        | ubus / rpcd ACL
        v
rpcd ucode plugin
  /usr/share/rpcd/ucode/fanxpert
        |
        | shell commands
        v
fanxpert.sh
  UCI + hwmon + PWM + state file
        |
        v
/sys/class/hwmon/*
```

关键运行时文件：

- LuCI view: `/www/luci-static/resources/view/fanxpert.js`
- CSS: `/www/luci-static/resources/fanxpert/fanxpert.css`
- rpcd ucode: `/usr/share/rpcd/ucode/fanxpert`
- ACL: `/usr/share/rpcd/acl.d/luci-app-fanxpert.json`
- Menu: `/usr/share/luci/menu.d/luci-app-fanxpert.json`
- 守护进程: `/usr/sbin/fanxpert.sh`
- Init 脚本: `/etc/init.d/fanxpert`
- UCI 配置: `/etc/config/fanxpert`
- 运行时状态: `/tmp/fanxpert.state`
- 校准进度文件: `/tmp/fanxpert.calibrate.progress`

## 安装

### 方式一：使用发布包

在 GitHub Releases 下载适合你系统的包：

- OpenWrt 25.12+：优先使用 `.apk`
- OpenWrt 24.10 及旧 opkg 系统：使用 `.ipk`

安装示例：

```sh
# APK 系统
apk add --allow-untrusted /tmp/luci-app-fanxpert_*.apk

# OPKG 系统
opkg install /tmp/luci-app-fanxpert_*.ipk
```

安装后重启相关服务：

```sh
/etc/init.d/rpcd restart
rm -rf /tmp/luci-*
/etc/init.d/uhttpd reload 2>/dev/null || /etc/init.d/uhttpd restart
```

### 方式二：开发部署脚本

仓库提供 `deploy.sh`，可将当前工作区直接部署到路由器，适合开发与快速测试。

```sh
OPENWRT_HOST=192.168.1.1 ./deploy.sh
# 或指定 root 用户
OPENWRT_HOST=root@192.168.1.1 ./deploy.sh
```

可选环境变量：

```sh
LOG_LINES=80 DEPLOY_DEBUG=1 OPENWRT_HOST=192.168.1.1 ./deploy.sh
```

部署脚本会：

- 复制 `root/` 到路由器 `/`
- 复制 `htdocs/` 到 `/www`
- 保留已有 `/etc/config/fanxpert`（不覆盖）
- 若无配置则执行 `/etc/uci-defaults/80_fanxpert` 初始化默认设置
- 迁移旧自定义曲线，补齐 `label` 和 `sensor` 字段
- 删除残留的旧 Lua LuCI 文件
- 重启 `rpcd`，清理 LuCI 缓存，重载 Web 服务
- 若 FanXpert 服务已启用，则重启服务

> ⚠️ 部署脚本会直接覆盖系统文件，仅适用于开发环境。生产环境建议通过 IPK/APK 安装。

## 启用服务

首次安装后，服务默认未启用（`fanxpert.settings.enabled=0`）。启用方法：

```sh
uci set fanxpert.settings.enabled='1'
uci commit fanxpert
/etc/init.d/fanxpert enable
/etc/init.d/fanxpert start
```

然后在浏览器访问 LuCI：

```text
System → FanXpert
```

## LuCI 界面说明

页面包含以下几个区域：

- **状态面板**：显示实时温度（°C）、风扇转速百分比、当前曲线名称、服务运行时长。
- **曲线图**：Canvas 绘制的温度‑PWM 曲线，红色圆点标记当前工作点。
- **服务操作按钮**：刷新状态、启动/停止/重启服务。
- **校准按钮**：服务停止时可启动；服务运行时按钮禁用并提示“请先停止服务”。
- **全局设置**：启用开关、日志级别。
- **风扇设备设置**：
  - Basic 选项卡：启用状态、设备标签、控制曲线选择。
  - Hardware 选项卡：风扇启动阈值（百分比）、永不停转开关、PWM 控制器路径（默认 auto）。
- **预设曲线**：Silent、Standard、Performance，仅可查看和修改参数，不可删除。
- **自定义曲线**：可添加多条，每条可命名、选择传感器并设置温度/PWM 范围。自定义曲线可被风扇选为控制曲线。

状态数据每 3 秒轮询刷新一次，曲线数据仅在首次加载、手动刷新或保存配置后重新计算。

## UCI 配置

默认配置由 `luci-app-fanxpert/root/etc/uci-defaults/80_fanxpert` 在首次安装时生成。运行时实际配置文件为 `/etc/config/fanxpert`。

示例配置：

```uci
config global 'settings'
  option enabled '1'
  option log_level 'info'

config sensor 'cpu_temp'
  option type 'hwmon'
  option platform 'auto'
  option label 'CPU Temperature'

config curve 'standard'
  option type 'bezier'
  option sensor 'cpu_temp'
  option temp_min '35'
  option temp_max '75'
  option pwm_start '30'
  option pwm_end '100'

config fan 'cpu_fan'
  option enabled '1'
  option label 'CPU Fan'
  option curve 'standard'
  option pwm_path 'auto'
  option pwm_min_start '0'
  option never_stop '1'

config curve 'custom_cpu_fan'
  option label 'Custom CPU Fan'
  option type 'bezier'
  option sensor 'cpu_temp'
  option temp_min '35'
  option temp_max '75'
  option pwm_start '30'
  option pwm_end '100'
```

### 关键字段说明

- `settings.enabled`：是否允许守护进程启动（`0` 或 `1`）。
- `settings.log_level`：日志等级，可选 `err`、`warn`、`notice`、`info`、`debug`。
- `sensor.platform`：传感器硬件路径。`auto` 为自动检测，也可指定如 `/sys/class/hwmon/hwmon0/temp1`。
- `fan.pwm_path`：PWM 控制器路径。`auto` 为自动检测，也可指定如 `/sys/class/hwmon/hwmon1/pwm1`。
- `fan.curve`：当前风扇绑定的曲线 section ID。
- `fan.pwm_min_start`：风扇启动最低 PWM 百分比（通过校准获得或手动设置）。
- `fan.never_stop`：`1` 时低负载保持最低转速，`0` 时允许停止。
- `curve.temp_min` / `curve.temp_max`：曲线温度范围（°C）。
- `curve.pwm_start` / `curve.pwm_end`：曲线 PWM 百分比范围。

## 命令行

守护进程与辅助命令均通过 `fanxpert.sh` 提供：

```sh
# 前台运行（供 procd 使用）
/usr/sbin/fanxpert.sh run

# 服务控制
/etc/init.d/fanxpert start
/etc/init.d/fanxpert stop
/etc/init.d/fanxpert restart
/etc/init.d/fanxpert reload

# 状态查询
/usr/sbin/fanxpert.sh status
/usr/sbin/fanxpert.sh info            # JSON 格式

# 获取曲线数据及当前工作点
/usr/sbin/fanxpert.sh curve-data cpu_fan

# 配置热重载（通知运行中的守护进程）
/usr/sbin/fanxpert.sh reload

# 恢复预设曲线为默认值
/usr/sbin/fanxpert.sh reset-curve standard

# 校准风扇启动阈值
/usr/sbin/fanxpert.sh calibrate cpu_fan
/usr/sbin/fanxpert.sh calibrate-progress   # 查看校准进度
```

## 校准说明

校准用于自动测定风扇开始稳定转动的最低 PWM 百分比（`pwm_min_start`），并写入 UCI 配置。

**校准方式：**

- **有转速反馈**（检测到 `fan*_input`）：逐步增加 PWM，检测 RPM 变化，精确定位启动点。结果标记为 `measured`。
- **无转速反馈**：使用保守的估算法，在 25% PWM 附近寻找启动点。结果标记为 `estimated`。

**使用须知：**

- 校准前 **必须停止 FanXpert 服务**（页面按钮或 `/etc/init.d/fanxpert stop`）。
- 校准时会暂时将风扇设为 0，然后逐渐增加 PWM，完成后会自动恢复校准前的 PWM 值。
- 校准进度可通过 LuCI 页面实时查看，校准结果会显示在结果卡片中。
- 如果没有转速传感器，校准结果为估算值，建议结合实际噪声和散热情况手动微调。
- 服务启动时会自动清除上次的校准进度文件，避免页面残留过时信息。

## 构建

### 在 OpenWrt SDK 中构建

将 `luci-app-fanxpert/` 放入 SDK 的 `package/` 目录：

```sh
cp -a luci-app-fanxpert /path/to/openwrt-sdk/package/
cd /path/to/openwrt-sdk
./scripts/feeds update -a
./scripts/feeds install -a
make defconfig
echo 'CONFIG_PACKAGE_luci-app-fanxpert=m' >> .config
make defconfig
make package/luci-app-fanxpert/compile V=s
```

生成的包位于 `bin/packages/*/base/` 或类似路径，格式取决于 SDK：

- OpenWrt 25.12+ 通常生成 `.apk`
- OpenWrt 24.10 及旧版生成 `.ipk`

### GitHub Actions 发布

工作流定义在 `.github/workflows/release.yml`。

- 手动触发：构建并上传工件，不自动发布。
- 推送 `v*` 标签：自动构建 APK 与 IPK，并发布到 GitHub Releases。

默认构建目标：

- APK：OpenWrt `25.12.4`，架构 `x86/64`
- IPK：OpenWrt `24.10.7`，架构 `x86/64`

发布示例：

```sh
git tag v1.0.0
git push origin v1.0.0
```

## 开发校验

本地静态检查：

```sh
node --check luci-app-fanxpert/htdocs/luci-static/resources/view/fanxpert.js
sh -n luci-app-fanxpert/root/usr/sbin/fanxpert.sh
sh -n luci-app-fanxpert/root/etc/init.d/fanxpert
sh -n luci-app-fanxpert/root/etc/uci-defaults/80_fanxpert
sh -n deploy.sh
msgfmt -c -o /tmp/fanxpert.zh_Hans.mo luci-app-fanxpert/po/zh_Hans/fanxpert.po
```

如果安装了 ShellCheck，建议运行：

```sh
shellcheck luci-app-fanxpert/root/usr/sbin/fanxpert.sh deploy.sh
```

## 故障排查

### LuCI 菜单不显示

```sh
ls -l /usr/share/luci/menu.d/luci-app-fanxpert.json
ls -l /www/luci-static/resources/view/fanxpert.js
rm -rf /tmp/luci-*
/etc/init.d/rpcd restart
/etc/init.d/uhttpd reload 2>/dev/null || /etc/init.d/uhttpd restart
```

### ubus 对象不存在

```sh
ls -l /usr/share/rpcd/ucode/fanxpert
ls -l /usr/share/rpcd/acl.d/luci-app-fanxpert.json
/etc/init.d/rpcd restart
ubus list | grep fanxpert
```

如果缺少 `rpcd-mod-ucode`，请安装：

```sh
# OPKG 系统
opkg update && opkg install rpcd-mod-ucode

# APK 系统
apk update && apk add rpcd-mod-ucode
```

### 服务无法启动

```sh
uci show fanxpert
/etc/init.d/fanxpert status
logread | grep 'FANXPERT:' | tail -50
/usr/sbin/fanxpert.sh status
/usr/sbin/fanxpert.sh info
```

确认已启用：

```sh
uci get fanxpert.settings.enabled
```

### 找不到温度或 PWM 设备

```sh
find /sys/class/hwmon -maxdepth 2 -type f -name 'name' -print -exec cat {} \;
find /sys/class/hwmon -maxdepth 2 -type f -name 'temp*_input' -print
find /sys/class/hwmon -maxdepth 2 -type f -name 'pwm*' -print
```

手动指定路径：

```sh
uci set fanxpert.cpu_temp.platform='/sys/class/hwmon/hwmon0/temp1'
uci set fanxpert.cpu_fan.pwm_path='/sys/class/hwmon/hwmon1/pwm1'
uci commit fanxpert
/etc/init.d/fanxpert reload
```

### 曲线图没有当前点

检查服务是否运行且生成了状态文件：

```sh
/usr/sbin/fanxpert.sh info
/usr/sbin/fanxpert.sh curve-data cpu_fan
```

如果 `/tmp/fanxpert.state` 不存在，请确认守护进程已启动并完成一次完整循环。

### 日志过多或过少

调整日志级别（更改后即时生效，无需重启）：

```sh
# 减少日志（仅记录错误、警告和重要通知）
uci set fanxpert.settings.log_level='notice'
uci commit fanxpert
/etc/init.d/fanxpert reload

# 详细调试
uci set fanxpert.settings.log_level='debug'
uci commit fanxpert
/etc/init.d/fanxpert reload
logread -f | grep 'FANXPERT:'
```

## 当前限制

- 当前仅展示和控制 `cpu_fan` 单一风扇。虽然内部架构已为多风扇预留扩展点，但前端和主循环尚未实现完整的设备切换。
- 校准在没有 RPM 反馈时采用保守估算，精度有限。
- 曲线类型目前仅完整实现 `bezier`；`linear` 会回退为默认贝塞尔曲线。
- 曲线编辑为表单方式，不支持拖拽。
- 自动硬件检测适用于常见 `hwmon` 命名，部分非标准平台仍需手动指定路径。

## 路线图

- 多风扇、多传感器完整编排与控制。
- 基于 RPM 反馈的闭环精确校准。
- 曲线拖拽编辑。
- 更细粒度的页面选项卡（总览、风扇、曲线、校准）。
- 扩展自动化构建目标矩阵，覆盖更多 OpenWrt 版本与架构。

## 许可证

本项目采用 Apache License 2.0。详见 [luci-app-fanxpert/LICENSE](./luci-app-fanxpert/LICENSE)。
