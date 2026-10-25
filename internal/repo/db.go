package repo

import (
	"errors"
	"fmt"
	"log/slog"
	"time"

	"dataset_service/internal/config"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// NewDB 建立数据库连接并配置连接池。连接池上限是硬底线，防止慢查询把连接打满拖垮实例。
func NewDB(cfg config.DBConfig, verbose bool) (*gorm.DB, error) {
	level := logger.Warn
	if verbose {
		level = logger.Info
	}
	db, err := gorm.Open(mysql.Open(cfg.DSN()), &gorm.Config{
		Logger:                                   logger.Default.LogMode(level),
		PrepareStmt:                              true,
		TranslateError:                           true,
		DisableForeignKeyConstraintWhenMigrating: true,
	})
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("get underlying sql.DB: %w", err)
	}
	sqlDB.SetMaxOpenConns(cfg.MaxOpen)
	sqlDB.SetMaxIdleConns(cfg.MaxIdle)
	sqlDB.SetConnMaxLifetime(cfg.MaxLifetime)
	sqlDB.SetConnMaxIdleTime(10 * time.Minute)

	return db, nil
}

// PingDB 用于就绪探针，带超时避免探针把 goroutine 挂住。
func PingDB(db *gorm.DB, timeout time.Duration) error {
	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- sqlDB.Ping() }()
	select {
	case err := <-done:
		return err
	case <-time.After(timeout):
		return errors.New("ping db timeout")
	}
}

// AutoMigrate 建表。生产环境建议关闭（用 deploy/mysql/init.sql），
// 仅在 DB_AUTO_MIGRATE=true 时调用，方便本地一键起。
func AutoMigrate(db *gorm.DB) error {
	if err := db.Set("gorm:table_options", "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci").
		AutoMigrate(&DatasetConfigModel{}, &GlobalLabelModel{}); err != nil {
		return fmt.Errorf("auto migrate: %w", err)
	}
	slog.Info("auto migrate finished", "tables", "tb_dataset_config, tb_global_label")
	return nil
}
