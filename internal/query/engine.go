package query

import (
	"context"
	"fmt"
	"reflect"
	"time"

	"datasource_service/internal/config"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// Engine 查询执行引擎抽象。目前只有 ClickHouse 实现，
// 隔离出来是为了将来换引擎或加 Mock 测试时不用动上层。
type Engine interface {
	Query(ctx context.Context, sqlText string, params []Param) (*ExecuteResult, error)
	Ping(ctx context.Context) error
	Close() error
}

// ClickHouse 引擎，native 协议直连。必须使用只读账号。
type ClickHouse struct {
	conn    driver.Conn
	maxRows int
}

// NewClickHouse 建立连接。连接池上限与超时都在这里定死。
func NewClickHouse(cfg config.CHConfig, maxRows int) (*ClickHouse, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr:            []string{cfg.Addr()},
		Auth:            clickhouse.Auth{Database: cfg.DB, Username: cfg.User, Password: cfg.Password},
		DialTimeout:     5 * time.Second,
		MaxOpenConns:    cfg.MaxOpen,
		MaxIdleConns:    cfg.MaxIdle,
		ConnMaxLifetime: cfg.MaxLifetime,
		Settings: clickhouse.Settings{
			// context 取消不一定能立刻杀掉 CH 端的查询，所以服务端也要有超时
			"max_execution_time": cfg.QueryTimeoutSeconds,
			// 结果集过大时先在这里挡一道
			"max_result_rows": maxRows,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("open clickhouse: %w", err)
	}
	return &ClickHouse{conn: conn, maxRows: maxRows}, nil
}

// Query 执行查询并读取结果。读取超过 maxRows 就停止并标记截断，
// 避免一次把超大结果集全读进内存。
func (c *ClickHouse) Query(ctx context.Context, sqlText string, params []Param) (*ExecuteResult, error) {
	args := make([]any, 0, len(params))
	for _, p := range params {
		args = append(args, clickhouse.Named(p.Name, p.Value))
	}

	rows, err := c.conn.Query(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	names := rows.Columns()
	types := rows.ColumnTypes()
	columns := make([]Column, len(names))
	for i := range names {
		columns[i] = Column{Name: names[i], Type: types[i].DatabaseTypeName()}
	}

	res := &ExecuteResult{Columns: columns, Rows: make([][]any, 0)}
	for rows.Next() {
		if res.RowCount >= c.maxRows {
			res.Truncated = true
			break
		}
		targets := make([]any, len(names))
		ptrs := make([]any, len(names))
		for i := range targets {
			ptrs[i] = &targets[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, fmt.Errorf("scan row: %w", err)
		}
		for i := range targets {
			targets[i] = normalizeValue(targets[i])
		}
		res.Rows = append(res.Rows, targets)
		res.RowCount++
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return res, nil
}

// Ping 用于就绪探针。
func (c *ClickHouse) Ping(ctx context.Context) error {
	return c.conn.Ping(ctx)
}

// Close 关闭连接。
func (c *ClickHouse) Close() error {
	return c.conn.Close()
}

// normalizeValue 把驱动返回的原始值转成 JSON 友好的类型。
//
// 最关键的一条：ClickHouse 的 Decimal 会以结构体形式返回，
// 直接落到 float64 会丢精度（金额场景是致命的），所以一律转成字符串。
func normalizeValue(v any) any {
	if v == nil {
		return nil
	}
	switch x := v.(type) {
	case time.Time:
		return x.Format(time.RFC3339)
	case []byte:
		return string(x)
	}
	rv := reflect.ValueOf(v)
	if rv.Kind() == reflect.Struct {
		if s, ok := v.(interface{ String() string }); ok {
			return s.String()
		}
	}
	return v
}
