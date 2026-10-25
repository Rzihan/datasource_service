-- 存量表加 acl 列（新环境用 init.sql，无需执行本脚本）。
--
-- 同 label_map：JSON 列不接受字符串字面量默认值，必须用 DEFAULT (JSON_OBJECT()) 表达式，
-- 存量行会自动填 {}，不会撞上 NOT NULL。
ALTER TABLE `tb_dataset_config`
  ADD COLUMN `acl` JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT '访问控制，如 {"tenants":["t1"]}；tenants 缺省或为 [] 表示不限制'
  AFTER `label_map`;

-- 存量行的语义：{} 表示「不限制」，与升级前的行为一致（所有人都可见）。
--
-- 可选：把某个数据源改成只允许指定租户查看
-- UPDATE `tb_dataset_config`
--   SET `acl` = JSON_OBJECT('tenants', JSON_ARRAY('tencent', 'bytedance'))
-- WHERE `dataset_key` = 'demo_order';
