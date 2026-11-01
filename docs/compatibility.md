# 宿主兼容与版本维护

0.2.0-preview.32 是公开 preview.31 的兼容修复。支持精确验证的 Harness 0.2.1-rc.2、rc.3、rc.4、rc.5；不使用版本豁免。个人账号、微信送达及家庭权限仍需按实际连接分别验收。

`compatibility.json` 是版本清单；`node scripts/compatibility.mjs --latest` 检查官方 npm latest，出现未验证版本或声明偏离即失败，不自动扩大范围或安装。官方 alpha 独立通道不等于当前公开支持。Actions 工作流集成尚受仓库 workflow 权限阻挡，当前用独立工程跟进与发布前人工核验，不宣称服务器定时门禁已启用。
