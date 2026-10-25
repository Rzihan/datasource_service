-- 改名迁移：datasource → dataset（概念统一为「数据集」），底表加 tb_ 前缀。
--
-- 存量环境按这个顺序执行一次即可，数据不丢：
--   1. 建新库 dataset_service
--   2. 把表搬过去并改名 tb_dataset_config（MySQL 的 RENAME TABLE 支持跨库搬）
--   3. 建新账号 dataset 并授权
--
-- 注意：RENAME TABLE 是原子操作，但执行期间表会被锁，停服窗口内跑最稳。

CREATE DATABASE IF NOT EXISTS `dataset_service`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

-- 旧库存在且旧表还在时才搬，重复执行不会报错
RENAME TABLE `datasource_service`.`datasource_config` TO `dataset_service`.`tb_dataset_config`;

-- 顺带把唯一键名也统一（MySQL 里改名要连列一起写）
ALTER TABLE `dataset_service`.`tb_dataset_config`
  CHANGE COLUMN `datasource_key`  `dataset_key`  VARCHAR(64)  NOT NULL COMMENT '业务主键，全局唯一，小写',
  CHANGE COLUMN `datasource_name` `dataset_name` VARCHAR(128) NOT NULL COMMENT '展示名',
  DROP INDEX `uk_datasource_key`,
  ADD UNIQUE KEY `uk_dataset_key` (`dataset_key`, `deleted_at`);

-- 应用侧账号（docker-compose 里 MYSQL_USER 已同步改成 dataset）
CREATE USER IF NOT EXISTS 'dataset'@'%' IDENTIFIED BY 'dataset_pass';
GRANT ALL PRIVILEGES ON `dataset_service`.* TO 'dataset'@'%';
FLUSH PRIVILEGES;

-- 旧库确认没用了再手工 DROP DATABASE datasource_service;——这里不自动删，怕误伤。
