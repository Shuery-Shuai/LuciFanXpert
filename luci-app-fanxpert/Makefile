#
# Copyright (C) 2026 FanXpert
# Licensed under Apache License 2.0
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-fanxpert
PKG_VERSION:=0.1.0-alpha1
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=Shuery-Shuai

LUCI_TITLE:=LuCI Support for FanXpert
LUCI_DEPENDS:=+luci-base +rpcd +rpcd-mod-ucode
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
