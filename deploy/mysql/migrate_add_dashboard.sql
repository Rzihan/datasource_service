-- 大盘（一屏多面板）。新环境由 init.sql 建表，存量环境执行本脚本。
--
-- panels / filters 用 JSON 列：
-- 面板是「一次查询 + 怎么呈现」的组合，形态会随需求长字段（今天加 metric，
-- 明天加 follow），单独拆一张 tb_dashboard_panel 会让「改一个面板的标题」
-- 变成一次跨表事务，收益远小于成本。
CREATE TABLE IF NOT EXISTS `tb_dashboard` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `dashboard_key` VARCHAR(64)  NOT NULL COMMENT '大盘唯一标识，进 URL，只允许小写字母数字短横线',
  `title`         VARCHAR(128) NOT NULL COMMENT '展示名，会挂在菜单上',
  `module`        VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '所属模块，决定菜单挂在哪一组下',
  `descr`         VARCHAR(512) NOT NULL DEFAULT '' COMMENT '这一屏在说什么',
  `owner`         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '负责人',
  `legacy`        VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '替代的旧页面标识，用于迁移对照',
  `status`        VARCHAR(16)  NOT NULL DEFAULT 'parallel' COMMENT '迁移状态：parallel/default/replaced，与入口共用一套',
  `panels`        JSON         NOT NULL COMMENT '面板列表：dataset + query + view + span + height',
  `filters`       JSON         NOT NULL COMMENT '大盘级筛选器声明',
  `version`       INT          NOT NULL DEFAULT 0 COMMENT '乐观锁版本号',
  `created_by`    VARCHAR(64)  NOT NULL DEFAULT '',
  `updated_by`    VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `deleted_at`    BIGINT       NOT NULL DEFAULT 0 COMMENT '软删毫秒时间戳，0 表示未删除',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dashboard_key_deleted` (`dashboard_key`, `deleted_at`),
  KEY `idx_dashboard_updated` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='仪表盘大盘';

-- 存量表补迁移状态列（v33 起大盘也参与迁移状态机）
ALTER TABLE `tb_dashboard`
  ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'parallel' COMMENT '迁移状态：parallel/default/replaced，与入口共用一套'
  AFTER `legacy`;
