package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"dataset_service/internal/config"
	"dataset_service/internal/handler"
	"dataset_service/internal/query"
	"dataset_service/internal/repo"
	"dataset_service/internal/router"
	"dataset_service/internal/service"

	"gorm.io/gorm"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	cfg, err := config.Load()
	if err != nil {
		slog.Error("load config failed", "error", err)
		os.Exit(1)
	}

	db, err := connectWithRetry(cfg, 10, 3*time.Second)
	if err != nil {
		slog.Error("connect mysql failed", "error", err)
		os.Exit(1)
	}

	if os.Getenv("DB_AUTO_MIGRATE") == "true" {
		if err := repo.AutoMigrate(db); err != nil {
			slog.Error("auto migrate failed", "error", err)
			os.Exit(1)
		}
	}

	// ClickHouse 引擎：连不上不致命，配置管理仍可用，只是查数功能不可用。
	chEngine, err := query.NewClickHouse(cfg.CH, cfg.Query.MaxResultRows)
	if err != nil {
		slog.Error("init clickhouse failed", "error", err)
		os.Exit(1)
	}
	defer chEngine.Close()
	pingCtx, pingCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer pingCancel()
	if err := chEngine.Ping(pingCtx); err != nil {
		slog.Warn("clickhouse is not reachable, query feature will fail until it recovers", "error", err)
	}

	dsHandler := handler.NewDatasetHandler(
		service.NewDatasetService(repo.NewDatasetRepo(db), cfg.MaxSQLBytes),
	)
	// 全局字段名称字典。它同时喂给两个地方：自己的 CRUD 接口，以及查询侧的命名合并。
	// 注入 DatasetRepo 是为了让一致性检查能读到数据集的 dim_map / mtx_map
	labelSvc := service.NewLabelService(repo.NewLabelRepo(db), repo.NewDatasetRepo(db), 0)
	labelHandler := handler.NewLabelHandler(labelSvc)
	queryHandler := query.NewHandler(query.NewService(
		repo.NewDatasetRepo(db), chEngine, labelSvc, cfg.Query,
		time.Duration(cfg.CH.QueryTimeoutSeconds)*time.Second,
	))
	// 大盘：与数据集平级的一等公民，一张大盘天然跨多个数据集
	dashboardHandler := handler.NewDashboardHandler(service.NewDashboardService(repo.NewDashboardRepo(db)))
	engine := router.New(router.Deps{
		Config: cfg, DB: db, DS: dsHandler, LH: labelHandler, QH: queryHandler, DH: dashboardHandler,
	})

	srv := &http.Server{
		Addr:              ":" + itoa(cfg.HTTPPort),
		Handler:           engine,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		slog.Info("server starting", "port", cfg.HTTPPort, "mode", cfg.GinMode)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server exited abnormally", "error", err)
			os.Exit(1)
		}
	}()

	// 优雅退出：先停止接收新请求，再等待存量请求处理完成。
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	slog.Info("shutdown signal received")

	ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownWait)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown failed", "error", err)
		_ = srv.Close()
	}
	if sqlDB, err := db.DB(); err == nil {
		_ = sqlDB.Close()
	}
	slog.Info("server stopped")
}

// connectWithRetry 容器启动时 MySQL 可能还没就绪，这里做退避重试而不是直接崩。
func connectWithRetry(cfg *config.Config, attempts int, interval time.Duration) (db *gorm.DB, err error) {
	for i := 1; i <= attempts; i++ {
		conn, e := repo.NewDB(cfg.DB, cfg.GinMode == "debug")
		if e == nil {
			if pe := repo.PingDB(conn, 3*time.Second); pe == nil {
				return conn, nil
			} else {
				e = pe
			}
			if sqlDB, _ := conn.DB(); sqlDB != nil {
				_ = sqlDB.Close()
			}
		}
		err = e
		slog.Warn("connect mysql failed, retrying", "attempt", i, "of", attempts, "error", e)
		time.Sleep(interval)
	}
	return nil, err
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	buf := [20]byte{}
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
