#
# Copyright (C) 2026 Shuery-Shuai
# Licensed under Apache License 2.0
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-fanxpert
PKG_VERSION:=0.1.0_alpha3
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=Shuery-Shuai

LUCI_TITLE:=LuCI Support for FanXpert
LUCI_DEPENDS:=+luci-base +rpcd +rpcd-mod-ucode
LUCI_PKGARCH:=all

# 默认配置随包安装，并声明为配置文件：升级时保留用户改动
define Package/luci-app-fanxpert/conffiles
/etc/config/fanxpert
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
