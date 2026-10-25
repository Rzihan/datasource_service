package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config 是服务的完整运行配置，全部由环境变量驱动，便于容器化部署。
type Config struct {
	HTTPPort     int           // 监听端口
	GinMode      string        // debug / release
	StaticDir    string        // 非空时用磁盘目录提供前端静态资源（开发态），否则使用 go:embed
	MaxSQLBytes  int           // mid_sql 软上限，防止恶意/误操作把存储撑爆
	RequestIDHdr string        // 请求 ID 响应头与读取头
	DB           DBConfig      // MySQL 配置（存 dataset 配置）
	CH           CHConfig      // ClickHouse 配置（跑查询）
	Query        QueryConfig   // 查询执行限制
	ShutdownWait time.Duration // 优雅退出最长等待时间
}

// DBConfig 数据库连接与连接池参数。
type DBConfig struct {
	Host        string
	Port        int
	User        string
	Password    string
	Name        string
	Charset     string
	MaxOpen     int           // 最大打开连接数，防连接打满
	MaxIdle     int           // 最大空闲连接数
	MaxLifetime time.Duration // 连接最大复用时长
}

// CHConfig ClickHouse 连接配置。必须是只读账号。
type CHConfig struct {
	Host        string
	Port        int
	User        string
	Password    string
	DB          string
	MaxOpen     int
	MaxIdle     int
	MaxLifetime time.Duration
	// QueryTimeoutSeconds 同时作用于 context 超时与 ClickHouse 的 max_execution_time。
	// 只靠 context 取消，CH 端的查询不一定立刻终止，所以要双管齐下。
	QueryTimeoutSeconds int
}

// QueryConfig 查询执行的三道防线：行数、并发、超时。
type QueryConfig struct {
	MaxResultRows  int // 单次结果硬顶，超出截断并标记 truncated
	DefaultLimit   int // 用户未指定时的默认行数
	MaxConcurrency int // 同时执行的查询数上限，防止几个人把 CH 点爆
	DimValueLimit  int // 维度候选值（distinct）上限
}

// Load 从环境变量加载配置，缺失项使用默认值。
func Load() (*Config, error) {
	cfg := &Config{
		HTTPPort:     envInt("HTTP_PORT", 8080),
		GinMode:      envString("GIN_MODE", "release"),
		StaticDir:    os.Getenv("STATIC_DIR"),
		MaxSQLBytes:  envInt("MAX_SQL_BYTES", 1<<20), // 1 MiB
		RequestIDHdr: envString("REQUEST_ID_HEADER", "X-Request-Id"),
		ShutdownWait: time.Duration(envInt("SHUTDOWN_WAIT_SECONDS", 15)) * time.Second,
		DB: DBConfig{
			Host:        envString("DB_HOST", "mysql"),
			Port:        envInt("DB_PORT", 3306),
			User:        envString("DB_USER", "dataset"),
			Password:    os.Getenv("DB_PASSWORD"),
			Name:        envString("DB_NAME", "dataset_service"),
			Charset:     envString("DB_CHARSET", "utf8mb4"),
			MaxOpen:     envInt("DB_MAX_OPEN", 50),
			MaxIdle:     envInt("DB_MAX_IDLE", 10),
			MaxLifetime: time.Duration(envInt("DB_MAX_LIFETIME_SECONDS", 1800)) * time.Second,
		},
		CH: CHConfig{
			Host:                envString("CH_HOST", "clickhouse"),
			Port:                envInt("CH_PORT", 9000),
			User:                envString("CH_USER", "default"),
			Password:            os.Getenv("CH_PASSWORD"),
			DB:                  envString("CH_DB", "default"),
			MaxOpen:             envInt("CH_MAX_OPEN", 20),
			MaxIdle:             envInt("CH_MAX_IDLE", 5),
			MaxLifetime:         time.Duration(envInt("CH_MAX_LIFETIME_SECONDS", 1800)) * time.Second,
			QueryTimeoutSeconds: envInt("QUERY_TIMEOUT_SECONDS", 30),
		},
		Query: QueryConfig{
			MaxResultRows:  envInt("QUERY_MAX_ROWS", 10000),
			DefaultLimit:   envInt("QUERY_DEFAULT_LIMIT", 1000),
			MaxConcurrency: envInt("QUERY_MAX_CONCURRENCY", 8),
			DimValueLimit:  envInt("QUERY_DIM_VALUE_LIMIT", 1000),
		},
	}

	if cfg.HTTPPort <= 0 || cfg.HTTPPort > 65535 {
		return nil, fmt.Errorf("invalid HTTP_PORT: %d", cfg.HTTPPort)
	}
	if cfg.MaxSQLBytes <= 0 {
		return nil, fmt.Errorf("invalid MAX_SQL_BYTES: %d", cfg.MaxSQLBytes)
	}
	if cfg.DB.Host == "" || cfg.DB.Name == "" {
		return nil, fmt.Errorf("DB_HOST and DB_NAME are required")
	}
	if cfg.CH.QueryTimeoutSeconds <= 0 {
		cfg.CH.QueryTimeoutSeconds = 30
	}
	if cfg.Query.MaxResultRows <= 0 {
		cfg.Query.MaxResultRows = 10000
	}
	if cfg.Query.MaxConcurrency <= 0 {
		cfg.Query.MaxConcurrency = 8
	}
	if cfg.Query.DimValueLimit <= 0 {
		cfg.Query.DimValueLimit = 1000
	}
	return cfg, nil
}

// DSN 组装 MySQL 连接串。
func (c DBConfig) DSN() string {
	return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=%s&parseTime=true&loc=Local&timeout=5s",
		c.User, c.Password, c.Host, c.Port, c.Name, c.Charset)
}

// Addr 组装 ClickHouse 地址（native 协议）。
func (c CHConfig) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

func envString(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
