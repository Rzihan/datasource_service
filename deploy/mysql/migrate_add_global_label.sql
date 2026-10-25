-- 新增全局字段名称定义（存量环境升级用，新环境走 init.sql，无需执行本脚本）。
--
-- 背景：label_map 原本每个数据集各配一份、互不相干，同一个 city 要在每个数据集里
-- 重复写一遍「城市」。现在抽一层全局字典，数据集侧的 label_map 退化为「覆盖层」：
--
--   最终展示名 = 数据集 label_map[k]  →  全局 tb_global_label[k]  →  字段名 k
--                （优先级高）                                        （优先级低）
--
-- 三态语义（很重要）：
--   label_map 里没有这个 key        = 继承全局
--   label_map[k] = "非空"           = 覆盖，只作用于当前数据集
--   label_map[k] = ""（显式空串）   = 明确「不使用中文名」，退回显示字段名
--                                    即使全局有定义也不继承

USE `dataset_service`;

CREATE TABLE IF NOT EXISTS `tb_global_label` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增主键，仅内部使用',
  `field_key`   VARCHAR(64)  NOT NULL COMMENT '字段名，对应数据集 dim_map / mtx_map 的键，小写',
  `label`       VARCHAR(128) NOT NULL COMMENT '中文名',
  `status`      TINYINT      NOT NULL DEFAULT 1 COMMENT '1 启用 0 停用；停用等同于不存在',
  `version`     INT          NOT NULL DEFAULT 0 COMMENT '乐观锁版本号',
  `created_by`  VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '创建人',
  `updated_by`  VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '更新人',
  `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `deleted_at`  BIGINT       NOT NULL DEFAULT 0 COMMENT '0 未删除，非 0 为删除时刻毫秒时间戳',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_field_key` (`field_key`, `deleted_at`),
  KEY `idx_updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='全局字段名称定义表';

-- 从存量数据集中提取公共字段。
-- 提取依据：多个数据集都引用了该字段名，且已配置的中文名一致（无同名异义）。
--   city=城市、cost=消耗   两个数据集都配了且一致
--   channel=渠道、date=日期、uv=去重用户数
--     两个数据集都有该字段，但只有 demo_order 配了中文名；提全局后 demo_tmpl 也会显示中文名
-- 用 INSERT IGNORE：重复执行不会覆盖之后人工改过的定义。
INSERT IGNORE INTO `tb_global_label` (`field_key`, `label`, `created_by`, `updated_by`) VALUES
  ('city',    '城市',     'migrate', 'migrate'),
  ('cost',    '消耗',     'migrate', 'migrate'),
  ('channel', '渠道',     'migrate', 'migrate'),
  ('date',    '日期',     'migrate', 'migrate'),
  ('uv',      '去重用户数', 'migrate', 'migrate');

-- 把上面这些 key 从各数据集的 label_map 里摘掉，交回全局字典统一提供。
-- 不摘的话覆盖层会永远压着全局，改全局看不出效果，等于白做。
-- 每条都带 JSON_CONTAINS_PATH 判断：只删确实存在的 key，重复执行安全。
UPDATE `tb_dataset_config` SET `label_map` = JSON_REMOVE(`label_map`, '$.city')
  WHERE `deleted_at` = 0 AND JSON_CONTAINS_PATH(`label_map`, 'one', '$.city');
UPDATE `tb_dataset_config` SET `label_map` = JSON_REMOVE(`label_map`, '$.cost')
  WHERE `deleted_at` = 0 AND JSON_CONTAINS_PATH(`label_map`, 'one', '$.cost');
UPDATE `tb_dataset_config` SET `label_map` = JSON_REMOVE(`label_map`, '$.channel')
  WHERE `deleted_at` = 0 AND JSON_CONTAINS_PATH(`label_map`, 'one', '$.channel');
UPDATE `tb_dataset_config` SET `label_map` = JSON_REMOVE(`label_map`, '$.date')
  WHERE `deleted_at` = 0 AND JSON_CONTAINS_PATH(`label_map`, 'one', '$.date');
UPDATE `tb_dataset_config` SET `label_map` = JSON_REMOVE(`label_map`, '$.uv')
  WHERE `deleted_at` = 0 AND JSON_CONTAINS_PATH(`label_map`, 'one', '$.uv');

-- 校验：应该只剩各数据集独有的字段（city_name / city_tier / clicks）
-- SELECT dataset_key, label_map FROM tb_dataset_config WHERE deleted_at = 0;
-- SELECT field_key, label FROM tb_global_label WHERE deleted_at = 0;
