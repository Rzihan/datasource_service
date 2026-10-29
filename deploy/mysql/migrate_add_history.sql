-- 新增数据集配置变更历史（存量环境升级用，新环境走 init.sql，无需执行本脚本）。
--
-- 之前改配置没有任何留痕：改坏了只能凭记忆重填，mid_sql 尤其容易改丢。
-- 现在每次 create / update / delete 都会存一份快照，可一键回滚。
--
-- 两张说明：
--  1. 历史表不参与软删。历史是事实记录，删掉一条历史等于抹掉一次变更，
--     这跟「删掉配置」不是一回事，所以这里没有 deleted_at。
--  2. 存量配置不会产生历史——脚本执行前的那些变更已经无从追溯了。
--     从这次升级之后开始记录。

USE `dataset_service`;

CREATE TABLE IF NOT EXISTS `tb_dataset_config_history` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `dataset_key` VARCHAR(64)  NOT NULL COMMENT '数据集业务主键',
  `version`     INT          NOT NULL DEFAULT 0 COMMENT '快照对应的配置版本号',
  `action`      VARCHAR(16)  NOT NULL COMMENT 'create / update / delete / rollback',
  `operator`    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '操作人',
  `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `snapshot`    JSON         NOT NULL COMMENT '配置快照',
  PRIMARY KEY (`id`),
  KEY `idx_dataset_key` (`dataset_key`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='数据集配置变更历史表';

-- 校验：SELECT dataset_key, version, action, operator FROM tb_dataset_config_history ORDER BY id DESC LIMIT 20;
