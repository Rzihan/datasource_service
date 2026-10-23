-- 存量表加 label_map 列（新环境用 init.sql，无需执行本脚本）。
--
-- 用 DEFAULT (JSON_OBJECT()) 而不是 DEFAULT '{}'：
-- MySQL 8 的 JSON 列不允许直接写字符串字面量默认值，只能用表达式默认值，
-- 这样存量行会自动填 {}，不会出现 NULL 撞上 NOT NULL 的问题。
ALTER TABLE `datasource_config`
  ADD COLUMN `label_map` JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT '维度/指标的中文含义，key 对应 dim_map/mtx_map 的键，仅影响展示'
  AFTER `mtx_map`;

-- 可选：给已有的演示数据补上中文含义
-- UPDATE `datasource_config`
--   SET `label_map` = JSON_OBJECT('date', '日期', 'city', '城市', 'channel', '渠道',
--                                 'cost', '消耗', 'clicks', '点击数', 'uv', '去重用户数')
-- WHERE `datasource_key` = 'demo_order';
