-- 存量表加 meta 列（新环境用 init.sql，无需执行本脚本）。
--
-- 背景：数据集交出去之后，用户最常问的不是「怎么查」，而是三个问题：
--   这个数是什么口径？多久更新一次？出问题找谁？
-- 这些信息之前只能靠人嘴传。放进 dim_map / mtx_map 又会把「能不能查」
-- 和「敢不敢用」搅在一起——补一句说明不该动 SQL 配置。
--
-- 结构刻意用一个大 JSON 而不是拆成多列：
--   description / owner / update_freq / tags / field_notes / examples
-- 以后再加字段（比如数据质量分）不用再迁表。

USE `dataset_service`;

ALTER TABLE `tb_dataset_config`
  ADD COLUMN `meta` JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT '数据集说明书：描述/负责人/更新频率/字段口径/预置分析，不参与 SQL 生成'
  AFTER `acl`;

-- 校验
-- SELECT dataset_key, JSON_EXTRACT(meta, '$.owner') AS owner FROM tb_dataset_config WHERE deleted_at = 0;
