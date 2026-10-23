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
	DB           DBConfig      // 数据库配置
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
			User:        envString("DB_USER", "datasource"),
			Password:    os.Getenv("DB_PASSWORD"),
			Name:        envString("DB_NAME", "datasource_service"),
			Charset:     envString("DB_CHARSET", "utf8mb4"),
			MaxOpen:     envInt("DB_MAX_OPEN", 50),
			MaxIdle:     envInt("DB_MAX_IDLE", 10),
			MaxLifetime: time.Duration(envInt("DB_MAX_LIFETIME_SECONDS", 1800)) * time.Second,
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
	return cfg, nil
}

// DSN 组装 MySQL 连接串。
func (c DBConfig) DSN() string {
	return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=%s&parseTime=true&loc=Local&timeout=5s",
		c.User, c.Password, c.Host, c.Port, c.Name, c.Charset)
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
