-- 初始化脚本：容器首次启动时由 /docker-entrypoint-initdb.d 自动执行。
CREATE DATABASE IF NOT EXISTS `datasource_service`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE `datasource_service`;

CREATE TABLE IF NOT EXISTS `datasource_config` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增主键，仅内部使用',
  `datasource_key`  VARCHAR(64)   NOT NULL COMMENT '业务主键，全局唯一，小写',
  `datasource_name` VARCHAR(128)  NOT NULL COMMENT '展示名',
  `mid_sql`         MEDIUMTEXT    NOT NULL COMMENT '中间层 SQL，纯文本存储，不做语法校验',
  `dim_map`         JSON          NOT NULL COMMENT '维度映射 map[string]string',
  `mtx_map`         JSON          NOT NULL COMMENT '指标映射 map[string]string',
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
  UNIQUE KEY `uk_datasource_key` (`datasource_key`, `deleted_at`),
  KEY `idx_updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='datasource 配置表';

-- 说明：dim_map / mtx_map 用 JSON 而非 TEXT。
-- MySQL 的 JSON 类型会在写入时校验语法并转成二进制存储，
-- 代价几乎为零，却能把非法 JSON 挡在数据库之外。
-- 业务结构（map[string]string）由 Go 侧类型系统保证：非字符串值在反序列化时会被拒绝。
