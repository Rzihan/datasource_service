package config

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"dataset_service/internal/auth"
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
	Auth         AuthConfig    // 登录与授权
	ShutdownWait time.Duration // 优雅退出最长等待时间
}

// AuthConfig 登录与授权配置。默认 off（不鉴权），与改造前行为一致。
//
// 平台侧重点是数据分析，真实环境的身份由企业 IdP 下发 JWT，
// 所以这里只有「验签 + claims 映射」，没有用户表、没有密码、没有会话。
type AuthConfig struct {
	Mode             string // off / dev / jwt
	Secret           string
	PublicKeyPEM     string
	Issuer           string
	Audience         string
	TTL              time.Duration // 仅 dev 签发时使用
	ClaimUser        string
	ClaimTenants     string
	ClaimVisibleUser string
	ClaimRoles       string
	EditorRoles      []string
	DevIdentities    []auth.Identity
	SSOURL           string
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
		Auth: AuthConfig{
			Mode:             strings.ToLower(envString("AUTH_MODE", auth.ModeOff)),
			Secret:           os.Getenv("AUTH_JWT_SECRET"),
			PublicKeyPEM:     os.Getenv("AUTH_JWT_PUBLIC_KEY"),
			Issuer:           os.Getenv("AUTH_JWT_ISSUER"),
			Audience:         os.Getenv("AUTH_JWT_AUDIENCE"),
			TTL:              time.Duration(envInt("AUTH_TOKEN_TTL_SECONDS", 8*3600)) * time.Second,
			ClaimUser:        envString("AUTH_CLAIM_USER", "sub"),
			ClaimTenants:     envString("AUTH_CLAIM_TENANTS", "tenants"),
			ClaimVisibleUser: envString("AUTH_CLAIM_VISIBLE_USERS", "visible_users"),
			ClaimRoles:       envString("AUTH_CLAIM_ROLES", "roles"),
			EditorRoles:      envList("AUTH_EDITOR_ROLES", []string{"editor", "admin"}),
			DevIdentities:    loadDevIdentities(os.Getenv("AUTH_DEV_IDENTITIES")),
			SSOURL:           os.Getenv("AUTH_SSO_URL"),
		},
	}

	if cfg.Auth.Mode != auth.ModeOff && cfg.Auth.Mode != auth.ModeDev && cfg.Auth.Mode != auth.ModeJWT {
		return nil, fmt.Errorf("invalid AUTH_MODE: %s (want off/dev/jwt)", cfg.Auth.Mode)
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

// VerifierConfig 转成 auth 包需要的配置，避免 main 里再抄一遍字段。
func (c AuthConfig) VerifierConfig() auth.Config {
	return auth.Config{
		Mode:              c.Mode,
		Secret:            c.Secret,
		PublicKeyPEM:      c.PublicKeyPEM,
		Issuer:            c.Issuer,
		Audience:          c.Audience,
		TTL:               c.TTL,
		ClaimUser:         c.ClaimUser,
		ClaimTenants:      c.ClaimTenants,
		ClaimVisibleUsers: c.ClaimVisibleUser,
		ClaimRoles:        c.ClaimRoles,
		EditorRoles:       c.EditorRoles,
		DevIdentities:     c.DevIdentities,
		SSOURL:            c.SSOURL,
	}
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

// envList 解析逗号分隔的环境变量，空值时用默认值。
func envList(key string, def []string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return def
	}
	return out
}

// loadDevIdentities 解析 dev 模式的预置身份，形如：
//
//	[{"user":"alice","tenants":["采集组"],"roles":["editor"]}]
//
// 没配就留空，由 auth.New 填默认值；配错了不能让服务起不来，
// 但必须大声说出来，否则「登录页是空的」会变成一个很难查的问题。
func loadDevIdentities(raw string) []auth.Identity {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var out []auth.Identity
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		slog.Warn("AUTH_DEV_IDENTITIES is not valid JSON, falling back to built-in identities", "error", err)
		return nil
	}
	kept := make([]auth.Identity, 0, len(out))
	for _, id := range out {
		if strings.TrimSpace(id.User) == "" {
			slog.Warn("AUTH_DEV_IDENTITIES entry without user, skipped")
			continue
		}
		kept = append(kept, id)
	}
	return kept
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
