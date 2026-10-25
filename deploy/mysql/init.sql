-- 初始化脚本：容器首次启动时由 /docker-entrypoint-initdb.d 自动执行。
CREATE DATABASE IF NOT EXISTS `dataset_service`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE `dataset_service`;

CREATE TABLE IF NOT EXISTS `tb_dataset_config` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增主键，仅内部使用',
  `dataset_key`  VARCHAR(64)   NOT NULL COMMENT '业务主键，全局唯一，小写',
  `dataset_name` VARCHAR(128)  NOT NULL COMMENT '展示名',
  `mid_sql`         MEDIUMTEXT    NOT NULL COMMENT '中间层 SQL，纯文本存储，不做语法校验',
  `dim_map`         JSON          NOT NULL COMMENT '维度映射 map[string]string',
  `mtx_map`         JSON          NOT NULL COMMENT '指标映射 map[string]string',
  `label_map`       JSON          NOT NULL DEFAULT (JSON_OBJECT()) COMMENT '维度/指标的中文含义，key 对应 dim_map/mtx_map 的键，仅影响展示',
  `acl`             JSON          NOT NULL DEFAULT (JSON_OBJECT()) COMMENT '访问控制，如 {"tenants":["t1"]}；tenants 缺省或为 [] 表示不限制',
  `status`          TINYINT       NOT NULL DEFAULT 1 COMMENT '1 启用 0 停用',
  `version`         INT           NOT NULL DEFAULT 0 COMMENT '乐观锁版本号',
  `created_by`      VARCHAR(64)   NOT NULL DEFAULT '' COMMENT '创建人',
  `updated_by`      VARCHAR(64)   NOT NULL DEFAULT '' COMMENT '更新人',
  `created_at`      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `deleted_at`      BIGINT        NOT NULL DEFAULT 0 COMMENT '0 未删除，非 0 为删除时刻毫秒时间戳',
  PRIMARY KEY (`id`),
  -- 联合唯一键是刻意设计：deleted_at 参与唯一约束后，
  -- 同一 key 被删除再重建不会撞车；同时保证存活记录里 key 唯一。
  UNIQUE KEY `uk_dataset_key` (`dataset_key`, `deleted_at`),
  KEY `idx_updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='数据集配置表';

-- 说明：dim_map / mtx_map 用 JSON 而非 TEXT。
-- MySQL 的 JSON 类型会在写入时校验语法并转成二进制存储，
-- 代价几乎为零，却能把非法 JSON 挡在数据库之外。
-- 业务结构（map[string]string）由 Go 侧类型系统保证：非字符串值在反序列化时会被拒绝。
--
-- acl 同样用 JSON，且刻意用对象而不是数组：后续要加 users / roles / 读写分离等维度时
-- 往对象里加字段即可，不必改表结构、不必迁存量数据。
-- 注意默认值用 JSON_OBJECT()（即 {}）而不是 {"tenants":null}：
-- null 会被 JSON 函数当成「有一个元素」，把「不限制」误判成「受限」。

-- 全局字段名称定义：一份「字段名 → 中文名」的字典，对所有数据集生效。
-- 数据集自己的 label_map 变成覆盖层，优先级高于这里；两边都没有就显示字段名本身。
-- 结构刻意与 tb_dataset_config 同款（软删 + 乐观锁），省一套心智负担。
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

-- 从存量数据集里提取出来的公共字段（提取依据：多个数据集都有该字段且中文名一致）。
-- 这些 key 已同步从各数据集的 label_map 中移除，改由全局字典统一提供。
INSERT INTO `tb_global_label` (`field_key`, `label`, `created_by`, `updated_by`) VALUES
  ('city',    '城市',     'migrate', 'migrate'),
  ('cost',    '消耗',     'migrate', 'migrate'),
  ('channel', '渠道',     'migrate', 'migrate'),
  ('date',    '日期',     'migrate', 'migrate'),
  ('uv',      '去重用户数', 'migrate', 'migrate');
