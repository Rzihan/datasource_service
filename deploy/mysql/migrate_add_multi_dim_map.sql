-- 存量表加 multi_dim_map 列（新环境用 init.sql，无需执行本脚本）。
--
-- 背景：多值维度（一个人属于多个公司、一个订单打了多个标签）这类字段
-- 放进 GROUP BY 会按取值拆成多行，而业务要看的是「一行里展示他属于哪几个」。
-- 之前数据模型里只有 dim_map（进 GROUP BY）和 mtx_map（聚合）两种，
-- 这类字段无处安放，只能塞进 mtx_map 当指标——它是维度，只是恰好需要聚合，
-- 语义是错的。现在给它独立的一列。
--
-- 默认值同样用 JSON_OBJECT() 而不是 '{}'：MySQL 8 的 JSON 列不接受字符串字面量默认值，
-- 表达式默认值能让存量行自动填 {}，不会撞上 NOT NULL。

USE `dataset_service`;

ALTER TABLE `tb_dataset_config`
  ADD COLUMN `multi_dim_map` JSON NOT NULL DEFAULT (JSON_OBJECT()) COMMENT '多值维度映射 map[string]string，value 产出数组，收拢展示且不进 GROUP BY'
  AFTER `dim_map`;

-- 校验：SELECT dataset_key, dim_map, multi_dim_map, mtx_map FROM tb_dataset_config WHERE deleted_at = 0;
-- 存量配置不会自动迁移——哪些字段算多值维度是业务判断，机器猜不出来。
-- 可以把「疑似多值」的字段先扫出来人工确认：
--   SELECT dataset_key, jt.`key`, jt.`value`
--   FROM tb_dataset_config, JSON_TABLE(mtx_map, '$.*' COLUMNS (`key` VARCHAR(64) PATH '$')) AS jt
--   WHERE deleted_at = 0
--     AND (jt.`value` LIKE '%arrayJoin%' OR jt.`value` LIKE '%groupUniqArray%' OR jt.`value` LIKE '%groupArray%');
