# LuciFanXpert

LuciFanXpert 是一个面向 OpenWrt / immortalwrt 的 LuCI 风扇控制应用。它通过 `hwmon` 读取温度传感器并写入 PWM 控制器，根据 UCI 中配置的温度-转速曲线动态调整风扇转速。

当前项目已经迁移到现代 OpenWrt / LuCI 技术栈：

- LuCI JavaScript view，不再使用旧 Lua Controller / CBI / `.htm` view。
- `rpcd` ucode 后端，通过 ubus 向前端暴露状态、曲线、校准和服务控制接口。
- `menu.d` JSON 菜单与 `rpcd/acl.d` 权限声明。
- procd 管理前台 daemon，`fanxpert.sh run` 由 init 脚本调用。
- UCI 配置，默认配置通过 `uci-defaults` 初始化，避免包升级覆盖用户配置。
- i18n 支持，包含 `po/templates` 与 `po/zh_Hans`。
- GitHub Actions 支持构建并发布 APK 与 IPK。

## 功能概览

- 基于温度的 PWM 风扇控制。
- 预设曲线：Silent、Standard、Performance。
- 多自定义曲线：可添加、删除、命名，并可在风扇控制模式中选择。
- 实时状态面板：温度、PWM 百分比、当前曲线、运行时间。
- Canvas 曲线图：显示曲线和当前工作点。
- 配置热重载：保存配置后运行中的 daemon 会重新应用曲线、PWM 路径、传感器路径和启动阈值。
- 风扇启动阈值校准：服务停止时可执行校准流程。
- 可配置日志级别，默认只记录生命周期、错误和校准等重要事件。
- 支持中文界面翻译。

## 目标环境

推荐环境：

- OpenWrt 24.10 / 25.12 或较新的 immortalwrt snapshot。
- 已安装 LuCI。
- 已安装 `rpcd` 与 `rpcd-mod-ucode`。
- 设备提供可读的 `hwmon` 温度输入，例如 `/sys/class/hwmon/hwmon0/temp1_input`。
- 设备提供可写的 PWM 控制器，例如 `/sys/class/hwmon/hwmon1/pwm1`。

默认配置以 `cpu_temp` 和 `cpu_fan` 为单设备模型。多风扇、多传感器的完整编排还不是当前版本目标。

## 项目结构

```text
.
├── .github/workflows/release.yml
├── deploy.sh
├── fan-control.sh
└── luci-app-fanxpert/
    ├── Makefile
    ├── LICENSE
    ├── htdocs/
    │   └── luci-static/resources/
    │       ├── view/fanxpert.js
    │       └── fanxpert/fanxpert.css
    ├── po/
    │   ├── templates/fanxpert.pot
    │   └── zh_Hans/fanxpert.po
    └── root/
        ├── etc/
        │   ├── init.d/fanxpert
        │   └── uci-defaults/80_fanxpert
        └── usr/
            ├── sbin/fanxpert.sh
            └── share/
                ├── luci/menu.d/luci-app-fanxpert.json
                └── rpcd/
                    ├── acl.d/luci-app-fanxpert.json
                    └── ucode/fanxpert
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

关键运行文件：

- LuCI view: `/www/luci-static/resources/view/fanxpert.js`
- CSS: `/www/luci-static/resources/fanxpert/fanxpert.css`
- rpcd ucode: `/usr/share/rpcd/ucode/fanxpert`
- ACL: `/usr/share/rpcd/acl.d/luci-app-fanxpert.json`
- Menu: `/usr/share/luci/menu.d/luci-app-fanxpert.json`
- Daemon: `/usr/sbin/fanxpert.sh`
- Init: `/etc/init.d/fanxpert`
- Config: `/etc/config/fanxpert`
- Runtime state: `/tmp/fanxpert.state`

## 安装

### 方式一：使用发布包

在 GitHub Releases 下载适合系统的包：

- OpenWrt 25.12+：优先使用 `.apk`
- OpenWrt 24.10 及旧 opkg 系统：使用 `.ipk`

安装示例：

```sh
# APK based systems
apk add --allow-untrusted /tmp/luci-app-fanxpert_*.apk

# OPKG based systems
opkg install /tmp/luci-app-fanxpert_*.ipk
```

安装后重启 LuCI 相关服务：

```sh
/etc/init.d/rpcd restart
rm -rf /tmp/luci-*
/etc/init.d/uhttpd reload 2>/dev/null || /etc/init.d/uhttpd restart
```

### 方式二：开发部署脚本

本仓库提供 `deploy.sh`，用于把当前工作区直接部署到路由器，适合开发和快速测试。

```sh
OPENWRT_HOST=192.168.1.1 ./deploy.sh
```

也可以显式指定 root 用户：

```sh
OPENWRT_HOST=root@192.168.1.1 ./deploy.sh
```

可选参数：

```sh
LOG_LINES=80 DEPLOY_DEBUG=1 OPENWRT_HOST=192.168.1.1 ./deploy.sh
```

部署脚本会：

- 复制 `root/` 到路由器根目录。
- 复制 `htdocs/` 到 `/www`。
- 保留已有 `/etc/config/fanxpert`。
- 如无配置，则执行 `/etc/uci-defaults/80_fanxpert` 初始化默认配置。
- 迁移旧自定义曲线，补齐 `label` 和 `sensor`。
- 删除旧 Lua LuCI 文件。
- 重启 `rpcd`，清理 LuCI 缓存，reload Web 服务。
- 如果 FanXpert 服务已启用，则重启服务。

## 启用服务

首次安装后，默认 `fanxpert.settings.enabled=0`。启用方式：

```sh
uci set fanxpert.settings.enabled='1'
uci commit fanxpert
/etc/init.d/fanxpert enable
/etc/init.d/fanxpert start
```

访问 LuCI：

```text
System -> FanXpert
```

## LuCI 界面说明

页面包含：

- Status panel：显示当前温度、风扇 PWM 百分比、曲线和运行时间。
- Curve canvas：显示温度-转速曲线和当前工作点。
- Service actions：刷新、启动、停止、重启服务。
- Calibration：服务停止时可启动校准；服务运行时按钮会禁用并提示先停止服务。
- Global Settings：启用状态和日志级别。
- Fan Devices：分为 Basic 与 Hardware。
  - Basic：启用、标签、控制曲线。
  - Hardware：启动阈值、永不停转、PWM 控制器路径。
- Preset Curves：Silent、Standard、Performance。
- Custom Curves：支持多个自定义曲线，每条曲线可命名、选择传感器并设置温度/PWM 范围。

状态轮询每 3 秒刷新一次，但不会每次重算曲线数据。曲线数据只在首次加载、手动刷新或保存配置后刷新。

## UCI 配置

默认配置由 `luci-app-fanxpert/root/etc/uci-defaults/80_fanxpert` 创建。运行系统中的实际配置文件是：

```text
/etc/config/fanxpert
```

示例：

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

### 关键字段

- `settings.enabled`: 是否允许 daemon 启动。
- `settings.log_level`: `err`、`warn`、`notice`、`info`、`debug`。
- `sensor.platform`: `auto` 或 `/sys/class/hwmon/hwmonX/tempY`。
- `fan.pwm_path`: `auto` 或 `/sys/class/hwmon/hwmonX/pwmY`。
- `fan.curve`: 当前风扇使用的 curve section id。
- `fan.pwm_min_start`: 风扇启动阈值百分比。
- `fan.never_stop`: 低负载时是否保持最低转速而不是停止。
- `curve.temp_min/temp_max`: 曲线温度范围。
- `curve.pwm_start/pwm_end`: 曲线 PWM 百分比范围。

## 命令行

```sh
# procd 使用的前台运行模式
/usr/sbin/fanxpert.sh run

# 服务控制
/etc/init.d/fanxpert start
/etc/init.d/fanxpert stop
/etc/init.d/fanxpert restart
/etc/init.d/fanxpert reload

# 查询状态
/usr/sbin/fanxpert.sh status
/usr/sbin/fanxpert.sh info

# 曲线数据
/usr/sbin/fanxpert.sh curve-data cpu_fan

# 配置热重载
/usr/sbin/fanxpert.sh reload

# 恢复预设曲线
/usr/sbin/fanxpert.sh reset-curve standard

# 校准
/usr/sbin/fanxpert.sh calibrate cpu_fan
/usr/sbin/fanxpert.sh calibrate-progress
```

## 校准说明

当前校准流程用于估算 `pwm_min_start`。它会停止服务后单独运行，逐步写入 PWM 并记录进度。

注意：

- 校准前需要停止 FanXpert 服务。
- 当前版本没有读取 `fan*_input` RPM/tach 反馈，因此不是严格的闭环 RPM 校准。
- 如果设备没有风扇转速反馈，建议把校准结果作为参考，并根据实际噪音和散热手动微调。

## 构建

### 在 OpenWrt SDK 中构建

把 `luci-app-fanxpert/` 放入 SDK 的 `package/` 目录：

```sh
cp -a luci-app-fanxpert /path/to/openwrt-sdk/package/luci-app-fanxpert
cd /path/to/openwrt-sdk
./scripts/feeds update -a
./scripts/feeds install -a
make defconfig
echo 'CONFIG_PACKAGE_luci-app-fanxpert=m' >> .config
make defconfig
make package/luci-app-fanxpert/compile V=s
```

产物位于：

```text
bin/packages/*/*/luci-app-fanxpert_*.ipk
bin/packages/*/*/luci-app-fanxpert_*.apk
```

实际格式取决于 SDK：

- OpenWrt 25.12+ 通常产出 APK。
- OpenWrt 24.10 及旧版通常产出 IPK。

### GitHub Actions 发布

工作流文件：

```text
.github/workflows/release.yml
```

行为：

- 手动触发：构建并上传 Actions artifact。
- 推送 `v*` tag：构建 APK 和 IPK，并发布到 GitHub Releases。

默认构建：

- APK: OpenWrt `25.12.4`
- IPK: OpenWrt `24.10.7`
- target: `x86/64`

发布：

```sh
git tag v1.0.0
git push origin v1.0.0
```

## 开发校验

本地常用静态检查：

```sh
node --check luci-app-fanxpert/htdocs/luci-static/resources/view/fanxpert.js
sh -n luci-app-fanxpert/root/usr/sbin/fanxpert.sh
sh -n luci-app-fanxpert/root/etc/init.d/fanxpert
sh -n luci-app-fanxpert/root/etc/uci-defaults/80_fanxpert
sh -n deploy.sh
msgfmt -c -o /tmp/fanxpert.zh_Hans.mo luci-app-fanxpert/po/zh_Hans/fanxpert.po
```

如果本机安装了 ShellCheck，也建议运行：

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

如果没有 `rpcd-mod-ucode`，需要安装：

```sh
# OPKG systems
opkg update
opkg install rpcd-mod-ucode

# APK systems
apk update
apk add rpcd-mod-ucode
```

### 服务无法启动

```sh
uci show fanxpert
/etc/init.d/fanxpert status
logread | grep 'FANXPERT:' | tail -50
/usr/sbin/fanxpert.sh status
/usr/sbin/fanxpert.sh info
```

确认已经启用：

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

检查运行状态：

```sh
/usr/sbin/fanxpert.sh info
/usr/sbin/fanxpert.sh curve-data cpu_fan
```

状态文件不存在时，多数是服务未运行或尚未完成第一次循环。

### 日志太多

默认 `log_level=info`。自动检测类日志已经降到 debug。需要进一步减少日志时：

```sh
uci set fanxpert.settings.log_level='notice'
uci commit fanxpert
/etc/init.d/fanxpert reload
```

需要调试时：

```sh
uci set fanxpert.settings.log_level='debug'
uci commit fanxpert
/etc/init.d/fanxpert reload
logread -f | grep 'FANXPERT:'
```

## 当前限制

- 当前只按 `cpu_fan` 作为主要风扇设备展示和控制。
- 校准流程不读取 RPM/tach 反馈，结果是 PWM 启动阈值估算。
- 曲线类型目前实现重点是 `bezier`，`linear` 会回退到默认 bezier。
- 曲线编辑是表单编辑，不支持拖拽曲线点。
- 自动硬件检测适合常见 `hwmon` 命名，复杂平台可能需要手动指定路径。

## 路线图

- 多风扇、多传感器完整支持。
- RPM/tach 闭环校准。
- 曲线拖拽编辑。
- 更细的页面级 tabs：Overview、Fan、Curves、Calibration。
- 更完整的 release target matrix。

## 许可证

Apache License 2.0。详见 [luci-app-fanxpert/LICENSE](./luci-app-fanxpert/LICENSE)。
